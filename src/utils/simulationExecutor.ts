/**
 * Simulation executor that orchestrates order book simulation
 * Integrates orderBookSimulator with simulation balance tracking
 */

import { SimulationMode, PartialFillStrategy, getSimulationConfig } from '../config/simulationConfig';
import { simulateOrderBookFill } from './orderBookSimulator';
import { getOrderBookCache } from './orderBookCache';
import { getSimulationTracker } from './simulationBalance';
import Logger from './logger';
import createClobClient from './createClobClient';
import fetchData from './fetchData';
import { ENV } from '../config/env';
import * as fs from 'fs';
import * as path from 'path';

const LIMIT_ORDERS_FILE = path.join(process.cwd(), 'data', 'pending_limit_orders.json');

function saveLimitOrders(): void {
    try {
        fs.writeFileSync(LIMIT_ORDERS_FILE, JSON.stringify(pendingLimitOrders, null, 2), 'utf8');
    } catch { /* silently fail */ }
}

function loadLimitOrders(): PendingLimitOrder[] {
    try {
        if (!fs.existsSync(LIMIT_ORDERS_FILE)) return [];
        const raw = fs.readFileSync(LIMIT_ORDERS_FILE, 'utf8');
        const orders: PendingLimitOrder[] = JSON.parse(raw);
        const now = Date.now();
        // Filtrer les ordres expirés au chargement
        const valid = orders.filter(o => now - o.queuedAt < LIMIT_ORDER_TIMEOUT_MS);
        if (valid.length < orders.length) {
            Logger.info(`⏰ ${orders.length - valid.length} limit order(s) expirés supprimés au démarrage`);
        }
        if (valid.length > 0) {
            Logger.info(`📂 ${valid.length} limit order(s) restaurés depuis le fichier (survie au redémarrage)`);
        }
        return valid;
    } catch {
        return [];
    }
}

// Cache des statuts marché résolu — évite de re-fetcher gamma-api à chaque trade
const resolvedMarketCache = new Map<string, { resolved: boolean; checkedAt: number }>();
const RESOLVED_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Vérifie via gamma-api si le marché d'un token est résolu/fermé.
 * Un spread extrême (bid≈0.001, ask≈0.999) peut indiquer soit :
 * - marché résolu (winner connu) → refuser le trade
 * - marché actif illiquide après achat whale → simuler le limit order
 */
async function isMarketResolved(tokenId: string): Promise<boolean> {
    const cached = resolvedMarketCache.get(tokenId);
    if (cached && Date.now() - cached.checkedAt < RESOLVED_CACHE_TTL_MS) {
        return cached.resolved;
    }
    try {
        const markets = await fetchData(
            `https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}`
        ) as Array<{ active?: boolean; closed?: boolean; resolvedBy?: string }>;

        if (!Array.isArray(markets) || markets.length === 0) {
            // Token introuvable dans gamma → considéré résolu/invalide
            resolvedMarketCache.set(tokenId, { resolved: true, checkedAt: Date.now() });
            return true;
        }
        const market = markets[0];
        const resolved = market.closed === true || market.active === false;
        resolvedMarketCache.set(tokenId, { resolved, checkedAt: Date.now() });
        return resolved;
    } catch {
        // En cas d'erreur réseau, on laisse passer (bénéfice du doute)
        return false;
    }
}

// ─── LIMIT ORDER WATCHER ────────────────────────────────────────────────────────
// Quand le book est vide après un achat whale, on surveille le retour des market
// makers et on exécute quand l'ask redescend au prix du trader (± tolérance).

const LIMIT_ORDER_CHECK_INTERVAL_MS  = 5 * 60 * 1000;  // vérifier toutes les 5min (longue attente)
const LIMIT_ORDER_TIMEOUT_MS         = 3 * 24 * 60 * 60 * 1000; // abandonner après 3 jours
const LIMIT_ORDER_PRICE_TOLERANCE    = 0.50;   // accepter jusqu'à +50% au-dessus du prix trader

interface PendingLimitOrder {
    asset:       string;
    amountUsd:   number;
    traderPrice: number;
    limitPrice:  number; // traderPrice * (1 + TOLERANCE)
    queuedAt:    number;
    // Métadonnées pour tracker la position quand l'ordre se remplit
    conditionId?: string;
    title?:       string;
    outcome?:     string;
    userAddress?: string;
    eventSlug?:   string;
}

const pendingLimitOrders: PendingLimitOrder[] = loadLimitOrders();
let limitOrderWatcherRunning = false;
let limitOrderWatcherStopped = false;

export function stopLimitOrderWatcher(): void {
    limitOrderWatcherStopped = true;
    pendingLimitOrders.length = 0;
    saveLimitOrders();
}

export function getPendingLimitOrdersCount(): number {
    return pendingLimitOrders.length;
}

// Démarrer le watcher automatiquement si des ordres ont été restaurés depuis le fichier
if (pendingLimitOrders.length > 0) {
    // Démarrage différé de 5s pour laisser le bot s'initialiser complètement
    setTimeout(() => startLimitOrderWatcher(), 5000);
}

async function startLimitOrderWatcher(): Promise<void> {
    if (limitOrderWatcherRunning) return;
    limitOrderWatcherRunning = true;

    const run = async () => {
        while (pendingLimitOrders.length > 0 && !limitOrderWatcherStopped) {
            const now = Date.now();
            const toProcess = [...pendingLimitOrders];

            for (const order of toProcess) {
                const idx = pendingLimitOrders.indexOf(order);
                if (idx === -1) continue;

                // Timeout
                if (now - order.queuedAt > LIMIT_ORDER_TIMEOUT_MS) {
                    pendingLimitOrders.splice(idx, 1);
                    saveLimitOrders();
                    Logger.warning(
                        `⏰ LIMIT ORDER expiré après 3 jours — ` +
                        `${order.asset.substring(0, 12)}... @ $${order.traderPrice.toFixed(4)}`
                    );
                    continue;
                }

                // Vérifier le book actuel
                try {
                    const data = await fetchData(
                        `https://clob.polymarket.com/book?token_id=${order.asset}`
                    ) as { bids: Array<{ price: string }>; asks: Array<{ price: string }> };

                    if (!data?.asks?.[0]) continue;
                    const currentAsk = parseFloat(data.asks[0].price);

                    // Market makers revenus ? ask ≤ limitPrice ET ask < MAX_BUY_PRICE (jamais acheter à $0.99+)
                    if (currentAsk <= order.limitPrice && currentAsk < ENV.MAX_BUY_PRICE) {
                        pendingLimitOrders.splice(idx, 1);
                        saveLimitOrders();
                        const simTracker = getSimulationTracker();
                        const execPrice = currentAsk;
                        const tokens = order.amountUsd / execPrice;
                        const waitSec = ((Date.now() - order.queuedAt) / 1000).toFixed(0);

                        Logger.separator();
                        Logger.success(
                            `✅ LIMIT ORDER rempli après ${waitSec}s — ` +
                            `${order.asset.substring(0, 12)}... @ $${execPrice.toFixed(4)} ` +
                            `(trader: $${order.traderPrice.toFixed(4)}, slippage: +${(((execPrice - order.traderPrice) / order.traderPrice) * 100).toFixed(1)}%)`
                        );

                        const fakeFill = {
                            totalCost:    order.amountUsd,
                            tokensFilled: tokens,
                            avgPrice:     execPrice,
                            fullyFilled:  true,
                            levelsUsed:   [{ price: execPrice, size: tokens }],
                        };
                        if (typeof simTracker.buyWithOrderBook === 'function') {
                            await simTracker.buyWithOrderBook(order.asset, order.amountUsd, execPrice, fakeFill);
                        } else {
                            await simTracker.buy(order.asset, order.amountUsd, execPrice);
                        }

                        // Tracker la position maintenant qu'elle est réellement ouverte
                        try {
                            const { getPositionTracker } = require('./positionTracker');
                            const tracker = getPositionTracker();
                            tracker.trackBuy(
                                order.asset,
                                order.conditionId || order.asset,
                                order.title || 'Unknown Market',
                                order.outcome || 'Unknown',
                                tokens,
                                execPrice,
                                order.amountUsd,
                                order.userAddress || '',
                                order.eventSlug
                            );
                        } catch { /* ignore */ }
                        Logger.separator();
                    }
                } catch {
                    // Erreur réseau temporaire — on réessaiera au prochain cycle
                }
            }

            await new Promise(resolve => setTimeout(resolve, LIMIT_ORDER_CHECK_INTERVAL_MS));
        }

        limitOrderWatcherRunning = false;
    };

    run().catch(err => {
        limitOrderWatcherRunning = false;
        Logger.warning(`[LimitOrderWatcher] Erreur: ${err.message}`);
    });
}

// Cache du clobClient pour éviter de recréer la connexion (et le wallet type check 5s) à chaque trade
let _cachedClobClient: Awaited<ReturnType<typeof createClobClient>> | null = null;

export interface SimulatedTradeResult {
    success: boolean;
    executed: boolean;
    tokensTraded?: number;
    avgPrice?: number;
    slippage?: number;
    partialFill?: boolean;
    levelsUsed?: number;
    reason?: string;
}

/**
 * Execute a simulated trade using order book simulation or simple mode
 */
export async function executeSimulatedTrade(
    asset: string,
    side: 'BUY' | 'SELL',
    amount: number, // USD for BUY, tokens for SELL
    traderPrice: number,
    userAddress: string,
    tradeMeta?: { conditionId?: string; title?: string; outcome?: string; eventSlug?: string }
): Promise<SimulatedTradeResult> {
    const config = getSimulationConfig();
    const simTracker = getSimulationTracker();

    // SIMPLE mode: Use current implementation (fallback)
    if (config.mode === SimulationMode.SIMPLE) {
        return executeSimpleMode(asset, side, amount, traderPrice, simTracker);
    }

    // REALISTIC or HYBRID mode: Try order book simulation
    try {
        const result = await executeOrderBookMode(asset, side, amount, traderPrice, config, simTracker, userAddress, tradeMeta);
        return result;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        Logger.error(`[SIMULATION] Order book simulation failed: ${errorMessage}`);

        // HYBRID mode: Fallback to SIMPLE
        if (config.mode === SimulationMode.HYBRID) {
            Logger.warning('[SIMULATION] Falling back to SIMPLE mode due to error');
            return executeSimpleMode(asset, side, amount, traderPrice, simTracker);
        }

        // REALISTIC mode: Fail the trade
        return {
            success: false,
            executed: false,
            reason: `Order book simulation failed: ${errorMessage}`
        };
    }
}

/**
 * Execute trade in SIMPLE mode (current implementation)
 */
async function executeSimpleMode(
    asset: string,
    side: 'BUY' | 'SELL',
    amount: number,
    traderPrice: number,
    simTracker: any
): Promise<SimulatedTradeResult> {
    try {
        if (side === 'BUY') {
            await simTracker.buy(asset, amount, traderPrice);
            const tokens = amount / traderPrice;
            return {
                success: true,
                executed: true,
                tokensTraded: tokens,
                avgPrice: traderPrice,
                slippage: 0.5, // Fixed 0.5% slippage in simple mode
                partialFill: false
            };
        } else {
            await simTracker.sell(asset, amount, traderPrice);
            return {
                success: true,
                executed: true,
                tokensTraded: amount,
                avgPrice: traderPrice,
                slippage: 0,
                partialFill: false
            };
        }
    } catch (error) {
        return {
            success: false,
            executed: false,
            reason: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * Execute trade using order book simulation
 */
async function executeOrderBookMode(
    asset: string,
    side: 'BUY' | 'SELL',
    amount: number,
    traderPrice: number,
    config: any,
    simTracker: any,
    userAddress?: string,
    tradeMeta?: { conditionId?: string; title?: string; outcome?: string; eventSlug?: string }
): Promise<SimulatedTradeResult> {
    const cache = getOrderBookCache();

    // Initialisation du client CLOB (mis en cache après le 1er appel — évite le wallet check 5s à chaque trade)
    const tClientStart = Date.now();
    if (!_cachedClobClient) {
        _cachedClobClient = await createClobClient();
        Logger.info(`⏱ createClobClient : ${((Date.now() - tClientStart) / 1000).toFixed(1)}s (premier appel)`);
    }
    const clobClient = _cachedClobClient;
    const tClientEnd = Date.now();

    // ============================================================
    // REALISTIC COPY DELAY: Simulate the lag between trader and bot
    // ============================================================
    if (ENV.SIMULATION_COPY_DELAY_ENABLED) {
        const minDelay = ENV.SIMULATION_COPY_DELAY_MIN;
        const maxDelay = ENV.SIMULATION_COPY_DELAY_MAX;
        const copyDelaySeconds = Math.random() * (maxDelay - minDelay) + minDelay;

        Logger.info(`⏱️ [SIMULATION] Simulating copy delay: ${copyDelaySeconds.toFixed(1)}s`);

        // Simulate the delay (bot is waiting while trader executed already)
        await new Promise(resolve => setTimeout(resolve, copyDelaySeconds * 1000));
    }

    // ============================================================
    // FETCH CURRENT ORDER BOOK (not cached — must reflect real-time market)
    // ============================================================
    // CRITICAL: After the delay, fetch the CURRENT order book to see actual market state
    const tFetchStart = Date.now();
    const orderBook = await clobClient.getOrderBook(asset);
    const tFetchEnd = Date.now();

    // Check if order book has liquidity
    if (side === 'BUY' && (!orderBook.asks || orderBook.asks.length === 0)) {
        Logger.warning('[SIMULATION] No asks available — market has no sell orders');
        return {
            success: false,
            executed: false,
            reason: 'No liquidity (no asks)'
        };
    }
    if (side === 'SELL' && (!orderBook.bids || orderBook.bids.length === 0)) {
        Logger.warning('[SIMULATION] No bids available — market has no buy orders');
        return {
            success: false,
            executed: false,
            reason: 'No liquidity (no bids)'
        };
    }

    // Get current best price (what the bot would actually get NOW)
    const currentBestPrice = side === 'BUY'
        ? parseFloat(orderBook.asks[0].price)
        : parseFloat(orderBook.bids[0].price);

    // ─── MARCHÉ ILLIQUIDE SELL : SIMULATION LIMIT ORDER ──────────────────────────
    // Après qu'un whale vend dans un marché peu liquide, toutes les bids sont
    // consommées → bid tombe à $0.001 (spread extrême bid=0.001 ask=0.999).
    // En réalité, le bot placerait un ordre LIMITE SELL au prix du trader.
    // Condition : bid < 50% du prix de vente du trader (slippage > 50%).
    if (
        side === 'SELL' &&
        traderPrice > 0 &&
        currentBestPrice / traderPrice < 0.5
    ) {
        const tokensToFill = amount;
        Logger.info(
            `📊 [SIMULATION] Marché illiquide SELL (bid $${currentBestPrice.toFixed(4)}) → ` +
            `simulation LIMIT ORDER @ $${traderPrice.toFixed(4)} (${tokensToFill.toFixed(2)} tokens)`
        );
        try {
            const fakeFill = {
                tokensFilled: tokensToFill,
                avgPrice:     traderPrice,
                fullyFilled:  true,
                levelsUsed:   [{ price: traderPrice, size: tokensToFill }],
            };
            if (typeof simTracker.sellWithOrderBook === 'function') {
                await simTracker.sellWithOrderBook(asset, tokensToFill, traderPrice, fakeFill);
            } else {
                await simTracker.sell(asset, tokensToFill, traderPrice);
            }
        } catch (e) {
            return { success: false, executed: false, reason: e instanceof Error ? e.message : String(e) };
        }
        return {
            success:      true,
            executed:     true,
            tokensTraded: tokensToFill,
            avgPrice:     traderPrice,
            slippage:     0,
            partialFill:  false,
            levelsUsed:   1,
        };
    }

    // ─── MARCHÉ ILLIQUIDE BUY : SIMULATION LIMIT ORDER ────────────────────────────
    // Après qu'un whale achète dans un marché peu liquide, toutes les asks bon
    // marché sont consommées → ask saute à $0.99 (spread extrême bid=0.01 ask=0.99).
    // En réalité, le bot placerait un ordre LIMITE au prix du trader et obtiendrait
    // un remplissage quand les teneurs de marché reviennent (~quelques secondes).
    // Condition : ask ≥ MAX_BUY_PRICE ET ask > 2× prix du trader ET prix trader OK.
    //
    // EXCEPTION : si spread extrême ET marché résolu/fermé selon gamma-api
    // → personne ne remplira ce limit order → refus immédiat.
    // Si spread extrême mais marché actif (whale a vidé le book) → simuler le limit order.
    const currentBestBid = orderBook.bids?.[0] ? parseFloat(orderBook.bids[0].price) : 0;
    const hasExtremeSpread = currentBestBid < 0.05 && currentBestPrice > 0.95;
    if (
        side === 'BUY' &&
        currentBestPrice >= ENV.MAX_BUY_PRICE &&
        traderPrice < ENV.MAX_BUY_PRICE
    ) {
        if (hasExtremeSpread) {
            const resolved = await isMarketResolved(asset);
            if (resolved) {
                return {
                    success: false,
                    executed: false,
                    reason: `Marché résolu/fermé (gamma-api confirmé) — limit order impossible`
                };
            }
            // Marché actif illiquide — le whale a vidé le book
            // → enregistrer un limit order et surveiller le retour des market makers
            if (pendingLimitOrders.some(o => o.asset === asset)) {
                return { success: true, executed: false, reason: 'Limit order déjà en attente pour cet asset' };
            }
            // Plafonner limitPrice à MAX_BUY_PRICE - 0.01 pour ne jamais acheter à $0.99+
            const limitPrice = Math.min(traderPrice * (1 + LIMIT_ORDER_PRICE_TOLERANCE), ENV.MAX_BUY_PRICE - 0.01);
            if (limitPrice <= traderPrice) {
                return { success: false, executed: false, reason: `Prix trader $${traderPrice.toFixed(4)} trop proche de MAX_BUY_PRICE — limit order inutile` };
            }
            pendingLimitOrders.push({ asset, amountUsd: amount, traderPrice, limitPrice, queuedAt: Date.now(), userAddress, ...tradeMeta });
            saveLimitOrders();
            startLimitOrderWatcher();
            Logger.info(
                `⏳ LIMIT ORDER en attente — book vide, surveillance toutes les 5min (max 3 jours) @ $${traderPrice.toFixed(4)}–$${limitPrice.toFixed(4)} [${pendingLimitOrders.length} en attente]`
            );
            return { success: true, executed: false, reason: 'Limit order en attente — market makers attendus' };
        }
        // Spread non-extrême mais ask >= MAX_BUY_PRICE → vérifier gamma-api avant de queuer
        const resolved2 = await isMarketResolved(asset);
        if (resolved2) {
            return {
                success: false,
                executed: false,
                reason: `Marché résolu/fermé (gamma-api confirmé) — limit order impossible`
            };
        }
        if (pendingLimitOrders.some(o => o.asset === asset)) {
            return { success: true, executed: false, reason: 'Limit order déjà en attente pour cet asset' };
        }
        // Plafonner limitPrice à MAX_BUY_PRICE - 0.01 pour ne jamais acheter à $0.99+
        const limitPrice2 = Math.min(traderPrice * (1 + LIMIT_ORDER_PRICE_TOLERANCE), ENV.MAX_BUY_PRICE - 0.01);
        if (limitPrice2 <= traderPrice) {
            return { success: false, executed: false, reason: `Prix trader $${traderPrice.toFixed(4)} trop proche de MAX_BUY_PRICE — limit order inutile` };
        }
        pendingLimitOrders.push({ asset, amountUsd: amount, traderPrice, limitPrice: limitPrice2, queuedAt: Date.now(), userAddress, ...tradeMeta });
        saveLimitOrders();
        startLimitOrderWatcher();
        Logger.info(
            `⏳ LIMIT ORDER en attente — ask trop élevé ($${currentBestPrice.toFixed(4)}), surveillance toutes les 5min (max 3 jours) @ $${traderPrice.toFixed(4)}–$${limitPrice2.toFixed(4)} [${pendingLimitOrders.length} en attente]`
        );
        return { success: true, executed: false, reason: 'Limit order en attente — ask trop élevé' };
    }

    // Calculate price movement since trader executed
    const priceMovement = ((currentBestPrice - traderPrice) / traderPrice) * 100;

    Logger.info(
        `📊 [SIMULATION] Price movement: ${priceMovement >= 0 ? '+' : ''}${priceMovement.toFixed(2)}% ` +
        `(trader: $${traderPrice.toFixed(4)} → current: $${currentBestPrice.toFixed(4)})`
    );

    // Calculate tokens to fill based on side
    const tokensToFill = side === 'BUY' ? amount / traderPrice : amount;

    // Simulate order book fill
    const tSimStart = Date.now();
    const fillResult = await simulateOrderBookFill(asset, side, tokensToFill);
    const tSimEnd = Date.now();

    // Résumé timing — aide à diagnostiquer les ordres lents
    {
        const clientMs = _cachedClobClient ? (tClientEnd - tClientStart) : (tClientEnd - tClientStart);
        const fetchMs = tFetchEnd - tFetchStart;
        const simMs = tSimEnd - tSimStart;
        const totalMs = tSimEnd - tClientStart;
        Logger.info(
            `⏱ Timing simulation : client=${(clientMs/1000).toFixed(1)}s | orderBook=${(fetchMs/1000).toFixed(1)}s | fill=${(simMs/1000).toFixed(1)}s | total=${(totalMs/1000).toFixed(1)}s`
        );
    }

    if (!fillResult.fullyFilled) {
        Logger.warning(
            `[SIMULATION] Partial fill: ${fillResult.tokensFilled.toFixed(2)}/${tokensToFill.toFixed(2)} tokens ` +
            `(${((fillResult.tokensFilled / tokensToFill) * 100).toFixed(1)}%)`
        );
    }

    // Calculate slippage (current best price vs actual execution price)
    const slippage = fillResult.avgPrice > 0
        ? ((fillResult.avgPrice - currentBestPrice) / currentBestPrice) * 100
        : 0;

    // Check if slippage exceeds maximum
    if (Math.abs(slippage) > config.maxSlippagePercent) {
        Logger.warning(
            `[SIMULATION] High slippage detected: ${slippage.toFixed(2)}% ` +
            `(max: ${config.maxSlippagePercent}%)`
        );
    }

    // Handle partial fills based on strategy
    if (!fillResult.fullyFilled) {
        if (config.partialFillStrategy === PartialFillStrategy.ABORT) {
            Logger.warning('[SIMULATION] Trade aborted due to insufficient liquidity (ABORT strategy)');
            return {
                success: false,
                executed: false,
                reason: 'Insufficient liquidity - trade aborted',
                partialFill: true
            };
        }

        // WARN or PARTIAL strategy: accept the partial fill
        Logger.warning(
            `[SIMULATION] Accepting partial fill (${config.partialFillStrategy} strategy)`
        );
    }

    // Log order book details
    if (fillResult.levelsUsed.length > 1) {
        Logger.info('[SIMULATION] Order book fill details:');
        fillResult.levelsUsed.forEach((level, index) => {
            Logger.info(
                `  L${index + 1}: ${level.size.toFixed(2)} tokens @ $${level.price.toFixed(4)} = $${(level.size * level.price).toFixed(2)}`
            );
        });
        Logger.info(
            `  Total: ${fillResult.tokensFilled.toFixed(2)} tokens @ $${fillResult.avgPrice.toFixed(4)} avg`
        );
    }

    // ============================================================
    // PRICE ACCEPTANCE CHECK — BEFORE committing to simTracker
    // Deux protections cumulées :
    //
    // 1. MAX_BUY_PRICE : vérifie le prix d'exécution réel (ask)
    //    → bloque les marchés quasi-résolus (ex: ask $0.98 → gain max 2%)
    //
    // 2. SLIPPAGE COPIE : vérifie l'écart entre le prix du trader et le ask actuel
    //    → bloque les marchés illiquides OU les trades trop vieux
    //    (ex: trader paye $0.04, ask actuel $0.99 → slippage 2475% → skip)
    //    Note: MAX_SLIPPAGE_PERCENT (env) = 5% par défaut est souvent trop strict
    //          on utilise SIMULATION_MAX_SLIPPAGE_PERCENT pour plus de flexibilité
    // ============================================================
    if (side === 'BUY') {
        const maxBuyPrice = ENV.MAX_BUY_PRICE;
        const minGainPercent = ENV.MIN_GAIN_POTENTIAL_PERCENT;
        const maxCopySlippage = ENV.SIMULATION_MAX_SLIPPAGE_PERCENT;
        const execPrice = fillResult.avgPrice;

        if (execPrice >= maxBuyPrice) {
            return {
                success: false,
                executed: false,
                reason: `Prix trop élevé: $${execPrice.toFixed(4)} ≥ MAX_BUY_PRICE $${maxBuyPrice.toFixed(4)} (gain max = ${((1 - execPrice) / execPrice * 100).toFixed(2)}%)`
            };
        }
        const gainPotential = (1 - execPrice) / execPrice * 100;
        if (gainPotential < minGainPercent) {
            return {
                success: false,
                executed: false,
                reason: `Gain potentiel insuffisant: ${gainPotential.toFixed(2)}% < ${minGainPercent}% min (prix: $${execPrice.toFixed(4)})`
            };
        }

        // Slippage copie : si le marché a bougé trop loin depuis l'achat du trader
        const copySlippage = ((execPrice - traderPrice) / traderPrice) * 100;
        if (copySlippage > maxCopySlippage) {
            return {
                success: false,
                executed: false,
                reason: `Slippage copie trop élevé: ${copySlippage.toFixed(1)}% > ${maxCopySlippage}% max (trader: $${traderPrice.toFixed(4)} → actuel: $${execPrice.toFixed(4)})`
            };
        }
    }

    // Execute the simulated trade
    try {
        if (side === 'BUY') {
            // Use buyWithOrderBook if available, otherwise fall back to regular buy
            if (typeof simTracker.buyWithOrderBook === 'function') {
                await simTracker.buyWithOrderBook(asset, amount, traderPrice, fillResult);
            } else {
                // Fallback: use avgPrice from order book simulation
                const actualUsdAmount = fillResult.tokensFilled * fillResult.avgPrice;
                await simTracker.buy(asset, actualUsdAmount, fillResult.avgPrice);
            }
        } else {
            // Use sellWithOrderBook if available, otherwise fall back to regular sell
            if (typeof simTracker.sellWithOrderBook === 'function') {
                await simTracker.sellWithOrderBook(asset, fillResult.tokensFilled, traderPrice, fillResult);
            } else {
                // Fallback: use avgPrice from order book simulation
                await simTracker.sell(asset, fillResult.tokensFilled, fillResult.avgPrice);
            }
        }

        return {
            success: true,
            executed: true,
            tokensTraded: fillResult.tokensFilled,
            avgPrice: fillResult.avgPrice,
            slippage,
            partialFill: !fillResult.fullyFilled,
            levelsUsed: fillResult.levelsUsed.length
        };
    } catch (error) {
        return {
            success: false,
            executed: false,
            reason: error instanceof Error ? error.message : String(error)
        };
    }
}
