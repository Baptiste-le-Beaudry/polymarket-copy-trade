/**
 * Position Dip Follower
 *
 * Scans traders' current open positions périodiquement.
 * Si un trader détient une position sur un marché actif ET que le prix actuel
 * est en dessous de son prix moyen d'achat (dip), le bot achète au prix actuel.
 *
 * La revente est automatiquement gérée par tradeExecutor existant :
 * quand le trader vend, le bot copie la vente car il détient la position.
 *
 * Configuration (.env) :
 *   DIP_FOLLOW_ENABLED='false'           — activer la fonctionnalité
 *   DIP_FOLLOW_MIN_DIP_PERCENT='5.0'     — dip minimum pour déclencher (%)
 *   DIP_FOLLOW_MAX_POSITION_DAYS='30'    — ancienneté max de la position du trader (jours)
 *   DIP_FOLLOW_INTERVAL_MINUTES='15'     — fréquence du scan (minutes)
 *   DIP_FOLLOW_MIN_CURRENT_PRICE='0.05'  — prix minimum du marché (évite les résidus)
 *   DIP_FOLLOW_MAX_CURRENT_PRICE='0.90'  — prix maximum du marché (évite les quasi-résolus)
 */

import { ClobClient, AssetType, Side } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import Logger from '../utils/logger';
import fetchData from '../utils/fetchData';
import { getSimulationTracker } from '../utils/simulationBalance';
import { getPositionTracker } from '../utils/positionTracker';
import { executeSimulatedTrade } from '../utils/simulationExecutor';
import { isTradeAllowed } from '../utils/logAnalyzer';
import { calculateOrderSize } from '../config/copyStrategy';
import getMyBalance from '../utils/getMyBalance';

// ─── Configuration (depuis .env) ─────────────────────────────────────────────

const DIP_FOLLOW_ENABLED          = process.env.DIP_FOLLOW_ENABLED === 'true';
const DIP_FOLLOW_MIN_DIP_PERCENT  = parseFloat(process.env.DIP_FOLLOW_MIN_DIP_PERCENT  || '5.0');
const DIP_FOLLOW_MAX_POSITION_DAYS = parseFloat(process.env.DIP_FOLLOW_MAX_POSITION_DAYS || '30.0');
const DIP_FOLLOW_MIN_CURRENT_PRICE = parseFloat(process.env.DIP_FOLLOW_MIN_CURRENT_PRICE || '0.05');
const DIP_FOLLOW_MAX_CURRENT_PRICE = parseFloat(process.env.DIP_FOLLOW_MAX_CURRENT_PRICE || '0.90');

export const DIP_FOLLOW_INTERVAL_MINUTES = parseFloat(process.env.DIP_FOLLOW_INTERVAL_MINUTES || '15.0');

// ─── État interne (session) ───────────────────────────────────────────────────

// Positions déjà achetées via dip follower cette session → évite les doublons
const dipFollowBought = new Set<string>(); // clé: `${conditionId}:${asset}`

// Première fois qu'on voit cette position pour estimer l'âge si l'API est muette
const positionFirstSeen = new Map<string, number>(); // clé: `${traderAddress}:${conditionId}`

// ─── Types ───────────────────────────────────────────────────────────────────

interface TraderPosition {
    asset: string;
    conditionId: string;
    title: string;
    outcome: string;
    size: number;
    avgPrice: number;
    curPrice: number;
    redeemable: boolean;
    endDate?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Vérifie si le bot détient déjà cette position (simulation ou réel).
 */
function botAlreadyHolds(conditionId: string, asset: string): boolean {
    // Vérification via positionTracker (commun DRY_RUN + réel)
    const tracker = getPositionTracker();
    if (tracker.getAllPositions().some(p => p.conditionId === conditionId)) return true;

    // Vérification supplémentaire via simulationTracker
    if (ENV.DRY_RUN) {
        const sim = getSimulationTracker();
        if (sim.getPosition(asset) !== null) return true;
    }

    return false;
}

/**
 * Interroge le carnet d'ordres pour confirmer que le marché est actif
 * et obtenir le prix live (mid bid/ask).
 * Retourne null si le marché est résolu ou illiquide.
 */
async function getLiveMarketPrice(asset: string): Promise<number | null> {
    try {
        const book = await fetchData(
            `https://clob.polymarket.com/book?token_id=${asset}`
        ) as { bids: Array<{ price: string; size: string }>; asks: Array<{ price: string; size: string }> };

        if (!book?.bids?.length || !book?.asks?.length) return null;

        const bid = parseFloat(book.bids[0].price);
        const ask = parseFloat(book.asks[0].price);

        if (!isFinite(bid) || !isFinite(ask) || bid <= 0 || ask <= 0) return null;

        // Marché pratiquement résolu ou résidu
        if (bid < DIP_FOLLOW_MIN_CURRENT_PRICE || ask > DIP_FOLLOW_MAX_CURRENT_PRICE) return null;

        return (bid + ask) / 2;
    } catch {
        return null;
    }
}

/**
 * Estime l'ancienneté (en jours) de la position du trader.
 * Cherche dans l'API d'activité Polymarket le premier BUY sur ce conditionId.
 * Si introuvable → utilise le premier-vu local.
 * Retourne null si impossible à déterminer.
 */
async function getPositionAgeDays(traderAddress: string, conditionId: string): Promise<number | null> {
    const firstSeenKey = `${traderAddress}:${conditionId}`;

    try {
        // Essayer via l'API Polymarket activity
        const activities = await fetchData(
            `https://data-api.polymarket.com/activity?user=${traderAddress}&type=TRADE`
        ) as Array<{ conditionId: string; side: string; timestamp: number }>;

        if (Array.isArray(activities)) {
            const buys = activities
                .filter(a => a.conditionId === conditionId && a.side === 'BUY')
                .sort((a, b) => a.timestamp - b.timestamp);

            if (buys.length > 0) {
                return (Date.now() / 1000 - buys[0].timestamp) / (60 * 60 * 24);
            }
        }
    } catch {
        // Silencieux — on utilise le fallback
    }

    // Fallback : première détection locale
    const firstSeen = positionFirstSeen.get(firstSeenKey);
    if (firstSeen) {
        return (Date.now() - firstSeen) / (1000 * 60 * 60 * 24);
    }

    return null; // Inconnu — on laisse passer
}

/**
 * Exécute l'achat dip en simulation (DRY_RUN) ou en réel.
 */
async function executeDipBuy(
    clobClient: ClobClient,
    pos: TraderPosition,
    traderAddress: string,
    livePrice: number
): Promise<boolean> {
    const traderShort = `${traderAddress.slice(0, 6)}...${traderAddress.slice(-4)}`;

    if (ENV.DRY_RUN) {
        const simTracker = getSimulationTracker();
        const virtualBalance = simTracker.getBalance();

        const orderCalc = calculateOrderSize(
            ENV.COPY_STRATEGY_CONFIG,
            pos.avgPrice * pos.size, // taille de référence = investissement initial du trader
            virtualBalance,
            0
        );

        Logger.info(`   📊 Ordre dip: ${orderCalc.reasoning}`);

        if (orderCalc.finalAmount <= 0) {
            Logger.warning(`   ⚠️ [DIP] Montant insuffisant — solde virtuel: $${virtualBalance.toFixed(2)}`);
            return false;
        }

        let result;
        try {
            result = await executeSimulatedTrade(
                pos.asset,
                'BUY',
                orderCalc.finalAmount,
                livePrice,
                traderAddress
            );
        } catch (err) {
            Logger.error(`   ❌ [DIP] Simulation échouée: ${(err as Error).message}`);
            return false;
        }

        if (!result.success) {
            Logger.error(`   ❌ [DIP] Achat simulé refusé: ${result.reason}`);
            return false;
        }

        // Enregistrer dans positionTracker pour que tradeExecutor puisse suivre les SELLs
        const tracker = getPositionTracker();
        const tokensBought = result.tokensTraded ?? (orderCalc.finalAmount / livePrice);
        const execPrice = result.avgPrice ?? livePrice;

        tracker.trackBuy(
            pos.asset,
            pos.conditionId,
            pos.title || 'Unknown Market',
            pos.outcome || 'Unknown',
            tokensBought,
            execPrice,
            orderCalc.finalAmount,
            traderAddress
        );

        const dipPct = ((pos.avgPrice - livePrice) / pos.avgPrice * 100).toFixed(1);
        Logger.success(
            `   ✅ [DIP SIMULATION] BUY: $${orderCalc.finalAmount.toFixed(2)}` +
            ` → ${tokensBought.toFixed(2)} tokens @ $${execPrice.toFixed(4)}` +
            ` (dip -${dipPct}% vs avg trader $${pos.avgPrice.toFixed(4)})`
        );
        return true;
    }

    // ─── Mode réel ────────────────────────────────────────────────────────────
    try {
        const balance = await getMyBalance(ENV.PROXY_WALLET);

        const orderCalc = calculateOrderSize(
            ENV.COPY_STRATEGY_CONFIG,
            pos.avgPrice * pos.size,
            balance,
            0
        );

        Logger.info(`   📊 Ordre dip: ${orderCalc.reasoning}`);

        if (orderCalc.finalAmount <= 0) {
            Logger.warning(`   ⚠️ [DIP] Montant insuffisant — solde: $${balance.toFixed(2)}`);
            return false;
        }

        // Sync allowances avant de trader
        await clobClient.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        await new Promise(r => setTimeout(r, 300));

        const tokensToBuy = orderCalc.finalAmount / livePrice;

        const signedOrder = await clobClient.createOrder({
            tokenID: pos.asset,
            size: tokensToBuy,
            price: livePrice,
            side: Side.BUY,
            feeRateBps: 0,
        });

        const result = await clobClient.postOrder(signedOrder);

        if (result.success) {
            const tracker = getPositionTracker();
            tracker.trackBuy(
                pos.asset,
                pos.conditionId,
                pos.title || 'Unknown Market',
                pos.outcome || 'Unknown',
                tokensToBuy,
                livePrice,
                orderCalc.finalAmount,
                traderAddress
            );

            const dipPct = ((pos.avgPrice - livePrice) / pos.avgPrice * 100).toFixed(1);
            Logger.success(
                `   ✅ [DIP RÉEL] BUY: ${tokensToBuy.toFixed(2)} tokens @ $${livePrice.toFixed(4)}` +
                ` (dip -${dipPct}% vs avg trader $${pos.avgPrice.toFixed(4)})`
            );
            return true;
        } else {
            Logger.error(`   ❌ [DIP] Ordre rejeté: ${result.errorMsg || 'Erreur inconnue'}`);
            return false;
        }
    } catch (error) {
        Logger.error(`   ❌ [DIP] Erreur exécution: ${(error as Error).message}`);
        return false;
    }
}

// ─── Fonction principale ──────────────────────────────────────────────────────

/**
 * Scanne les positions ouvertes de tous les traders surveillés.
 * Pour chaque position en dip (prix actuel < prix d'achat du trader),
 * sur un marché actif, non résolu et pas trop ancien → achète.
 *
 * Appelé périodiquement depuis index.ts.
 */
export async function scanForDipOpportunities(clobClient: ClobClient): Promise<void> {
    if (!DIP_FOLLOW_ENABLED) return;

    if (!isTradeAllowed()) {
        Logger.warning('🚨 [DIP FOLLOWER] Circuit breaker actif — scan annulé');
        return;
    }

    Logger.separator();
    Logger.info(
        `📉 DIP FOLLOWER: Scan de ${ENV.USER_ADDRESSES.length} traders ` +
        `(dip min: -${DIP_FOLLOW_MIN_DIP_PERCENT}%, max ${DIP_FOLLOW_MAX_POSITION_DAYS}j)...`
    );

    let totalOpportunities = 0;
    let totalBought = 0;

    for (const traderAddress of ENV.USER_ADDRESSES) {
        let positions: TraderPosition[];

        try {
            const raw = await fetchData(
                `https://data-api.polymarket.com/positions?user=${traderAddress}`
            );
            if (!Array.isArray(raw)) continue;
            positions = raw as TraderPosition[];
        } catch (error) {
            Logger.error(`[DIP] Erreur fetch positions ${traderAddress.slice(0, 10)}: ${(error as Error).message}`);
            continue;
        }

        for (const pos of positions) {
            const key = `${pos.conditionId}:${pos.asset}`;
            const firstSeenKey = `${traderAddress}:${pos.conditionId}`;

            // Mettre à jour le premier-vu pour l'estimation de l'âge
            if (!positionFirstSeen.has(firstSeenKey)) {
                positionFirstSeen.set(firstSeenKey, Date.now());
            }

            // ── Filtres rapides (sans API) ──

            // Marché résolu
            if (pos.redeemable) continue;

            // Position résiduelle (< 1 token = trace d'un trade clôturé)
            if (pos.size < 1.0) continue;

            // Déjà acheté cette session
            if (dipFollowBought.has(key)) continue;

            // Bot détient déjà cette position
            if (botAlreadyHolds(pos.conditionId, pos.asset)) continue;

            // Prix de référence invalides
            if (!pos.avgPrice || pos.avgPrice <= 0) continue;
            if (!pos.curPrice || pos.curPrice <= 0) continue;

            // Prix courant API hors plage acceptable
            if (pos.curPrice < DIP_FOLLOW_MIN_CURRENT_PRICE) continue;
            if (pos.curPrice > DIP_FOLLOW_MAX_CURRENT_PRICE) continue;

            // Dip insuffisant (sur prix API — sera reconfirmé sur prix live)
            const apiDipPct = ((pos.avgPrice - pos.curPrice) / pos.avgPrice) * 100;
            if (apiDipPct < DIP_FOLLOW_MIN_DIP_PERCENT) continue;

            // ── Vérification de l'âge (appel API) ──

            const ageDays = await getPositionAgeDays(traderAddress, pos.conditionId);
            if (ageDays !== null && ageDays > DIP_FOLLOW_MAX_POSITION_DAYS) {
                Logger.info(
                    `   ⏭ [DIP] Trop ancienne (${ageDays.toFixed(0)}j > ${DIP_FOLLOW_MAX_POSITION_DAYS}j): ` +
                    `${(pos.title || pos.conditionId).slice(0, 50)}`
                );
                continue;
            }

            // ── Confirmation du prix live via order book ──

            const livePrice = await getLiveMarketPrice(pos.asset);
            if (livePrice === null) continue; // Marché résolu, résidu ou illiquide

            // Re-vérifier le dip avec le prix live
            const liveDipPct = ((pos.avgPrice - livePrice) / pos.avgPrice) * 100;
            if (liveDipPct < DIP_FOLLOW_MIN_DIP_PERCENT) continue;

            // ── Opportunité validée ──

            totalOpportunities++;
            const traderShort = `${traderAddress.slice(0, 6)}...${traderAddress.slice(-4)}`;
            const ageStr = ageDays !== null ? `${ageDays.toFixed(0)}j` : '?j';

            Logger.info(`   📉 ${(pos.title || pos.conditionId).slice(0, 55)}`);
            Logger.info(
                `      Trader ${traderShort} | Avg: $${pos.avgPrice.toFixed(4)}` +
                ` → Live: $${livePrice.toFixed(4)} | Dip: -${liveDipPct.toFixed(1)}%` +
                ` | ${pos.size.toFixed(0)} tokens | Age: ${ageStr} | Outcome: ${pos.outcome}`
            );

            // Marquer immédiatement pour éviter doublons en cas d'erreur
            dipFollowBought.add(key);

            const success = await executeDipBuy(clobClient, pos, traderAddress, livePrice);
            if (success) totalBought++;
        }
    }

    if (totalOpportunities === 0) {
        Logger.info('📉 DIP FOLLOWER: Aucune opportunité de dip trouvée ce cycle');
    } else {
        Logger.info(`📉 DIP FOLLOWER: ${totalOpportunities} opportunité(s) → ${totalBought} achat(s) effectué(s)`);
    }
    Logger.separator();
}
