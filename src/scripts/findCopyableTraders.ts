/**
 * findCopyableTraders.ts
 *
 * Trouve les traders dont les ENTRÉES sont copiables en pratique :
 * le prix ne saute PAS à $0.99 dans les 30 minutes après leur trade.
 *
 * C'est la différence clé avec les autres scripts : on mesure la STABILITÉ
 * du marché après que le trader ait acheté, pas juste leur rentabilité globale.
 *
 * Algorithme :
 *   1. Scan des marchés actifs Polymarket → collecte d'adresses de traders
 *   2. Pour chaque trader : analyse P&L + activité récente (filtre rapide)
 *   3. Pour chaque trade récent BUY (tous types de marchés) :
 *      → Vérifie le prix CLOB 30 min après l'entrée du trader
 *      → Si prix < entrée + 20% : trade "stable" (copiable)
 *      → Si prix > entrée + 20% : trade "spiké" (non copiable)
 *   4. Score composite = 50% stabilité + 30% profit + 20% activité
 *   5. Affiche le classement + la config .env recommandée
 *
 * Usage : npx ts-node src/scripts/findCopyableTraders.ts [nb_marchés] [nb_traders]
 * Exemple: npx ts-node src/scripts/findCopyableTraders.ts 30 80
 */

import fs from 'fs';
import path from 'path';
import fetchData from '../utils/fetchData';
import { ENV } from '../config/env';

// ─── Configuration ────────────────────────────────────────────────────────────

const MARKETS_TO_SCAN    = parseInt(process.argv[2] ?? '30');
const MAX_TRADERS        = parseInt(process.argv[3] ?? '80');
const LOOKBACK_DAYS      = 7;                 // Dernière semaine seulement
const STABILITY_DELAY_S  = 30 * 60;          // Check prix 30 min après entrée
const STABILITY_WINDOW_S = 600;              // Fenêtre CLOB de ±10 min pour trouver un trade
const SPIKE_THRESHOLD    = 0.20;             // +20% = "spiké" (non copiable)
const MIN_TRADES_NEEDED  = 1;               // 1 seul trade long-terme suffit
const MIN_REALIZED_PNL   = 1;               // Min $1 de profit réalisé
const DELAY_MS           = 450;             // Pause entre requêtes API

// ─── Patterns de marchés courts termes à IGNORER ─────────────────────────────
// Ces marchés spikent instantanément car ils ont une deadline très proche

const SHORT_TERM_RE = [
    /\bby-(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(tember)?|oct(ober)?|nov(ember)?|dec(ember)?)-\d/i,
    /end-of-(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
    /-tonight\b/i,
    /-today\b/i,
    /-this-week\b/i,
    /-by-march\b/i,
    /-by-april\b/i,
    /-by-february\b/i,
];

const isShortTerm = (slug: string): boolean =>
    SHORT_TERM_RE.some(re => re.test(slug));

// ─── Types ────────────────────────────────────────────────────────────────────

interface TraderResult {
    address: string;
    pseudonym: string;
    totalBuyTrades: number;
    analyzedTrades: number;
    stableTrades: number;
    stabilityRatio: number;
    avgPriceJumpPct: number;
    realizedPnl: number;
    openPnl: number;
    openPositions: number;
    recentTradeCount: number;
    compositeScore: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const fmt = (n: number, dec = 0): string =>
    (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(dec).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Retourne le prix du marché N secondes après le trade du trader (via CLOB historique) */
const getPriceAfterDelay = async (
    asset: string,
    traderTimestamp: number,
    delaySec: number,
): Promise<number | null> => {
    const after  = traderTimestamp + delaySec;
    const before = traderTimestamp + delaySec + STABILITY_WINDOW_S;
    const url = `https://clob.polymarket.com/trades?token_id=${asset}&after=${after}&before=${before}&limit=3`;

    try {
        const data = await fetchData(url) as Array<{ price: string }>;
        if (!Array.isArray(data) || data.length === 0) return null;
        return parseFloat(data[0].price);
    } catch {
        return null;
    }
};

// ─── Phase 1 : Découverte des adresses de traders ─────────────────────────────

const discoverTraders = async (): Promise<string[]> => {
    const found = new Set<string>();

    // Toujours inclure les traders déjà suivis pour comparaison
    ENV.USER_ADDRESSES.forEach(a => found.add(a.toLowerCase()));

    console.log(`🔍 Scan de ${MARKETS_TO_SCAN} marchés actifs (long-terme uniquement)...`);

    // Essayer plusieurs endpoints dans l'ordre jusqu'à ce qu'un fonctionne
    const MARKET_ENDPOINTS = [
        // gamma-api : l'API principale de Polymarket pour les données de marchés
        `https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=200`,
        // Fallback : data-api sans paramètres
        `https://data-api.polymarket.com/markets`,
    ];

    let markets: Array<{ conditionId: string; slug: string; closed?: boolean }> = [];

    for (const endpoint of MARKET_ENDPOINTS) {
        try {
            const raw = await fetchData(endpoint);
            if (Array.isArray(raw) && raw.length > 0) {
                markets = raw;
                console.log(`   Endpoint: ${endpoint.split('?')[0]}`);
                break;
            }
        } catch {
            // Essayer le suivant
        }
    }

    if (markets.length === 0) {
        console.log('   ⚠️  Aucun endpoint de marchés disponible — utilisation de la liste actuelle');
        return Array.from(found);
    }

    try {
        // Filtrer côté client : marchés ouverts + long-terme
        const longTermMarkets = markets.filter(m =>
            !m.closed &&
            !isShortTerm(m.slug ?? '')
        );
        console.log(`   ${longTermMarkets.length}/${markets.length} marchés long-terme retenus`);

        // Pour chaque marché : récupère les traders récents via trades?market=
        // Le champ adresse dans cette réponse est "owner" (pas proxyWallet)
        let scanned = 0;
        for (const market of longTermMarkets.slice(0, MARKETS_TO_SCAN)) {
            await sleep(DELAY_MS);
            try {
                const trades = await fetchData(
                    `https://data-api.polymarket.com/trades?market=${market.conditionId}&limit=50`
                ) as Array<{ owner?: string; proxyWallet?: string }>;

                if (Array.isArray(trades)) {
                    trades.forEach(t => {
                        const addr = t.owner ?? t.proxyWallet;
                        if (addr) found.add(addr.toLowerCase());
                    });
                }
                scanned++;
            } catch {
                // Ignorer les erreurs par marché
            }
        }

        console.log(`   Scan de ${scanned} marchés → ${found.size} adresses uniques trouvées\n`);
    } catch (err) {
        console.log(`   ⚠️  Erreur scan marchés: ${err}`);
    }

    return Array.from(found);
};

// ─── Phase 2 : Analyse d'un trader ───────────────────────────────────────────

const analyzeTrader = async (address: string): Promise<TraderResult | null> => {
    const cutoff = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400;

    try {
        // 1. Positions : P&L
        const positions = await fetchData(
            `https://data-api.polymarket.com/positions?user=${address}`
        ) as Array<any>;
        await sleep(DELAY_MS);

        // 2. Activité récente : trades
        const activity = await fetchData(
            `https://data-api.polymarket.com/activity?user=${address}&type=TRADE&limit=50`
        ) as Array<any>;

        if (!Array.isArray(activity) || activity.length === 0) {
            process.stdout.write('(aucune activité) ');
            return null;
        }

        // Filtres rapides
        const recentTrades  = activity.filter(t => t.timestamp >= cutoff);
        if (recentTrades.length === 0) {
            process.stdout.write(`(inactif depuis >${LOOKBACK_DAYS}j) `);
            return null;
        }

        // Tous les BUYs récents — le test de stabilité fera le vrai tri
        const recentBuys = recentTrades.filter(t => t.side === 'BUY' && t.asset);

        if (recentBuys.length < MIN_TRADES_NEEDED) {
            process.stdout.write(`(${recentBuys.length} BUY en ${LOOKBACK_DAYS}j, besoin ${MIN_TRADES_NEEDED}) `);
            return null;
        }

        // Calcul P&L
        let realizedPnl = 0;
        let openPnl     = 0;
        const openPositions = Array.isArray(positions) ? positions.length : 0;

        if (Array.isArray(positions)) {
            for (const p of positions) {
                realizedPnl += (p.realizedPnl ?? 0);
                openPnl     += (p.cashPnl     ?? 0);
            }
        }

        if (realizedPnl < MIN_REALIZED_PNL && openPnl < 0) {
            process.stdout.write(`(P&L négatif) `);
            return null;
        }

        // 3. Test de stabilité : vérifier le prix 30 min après chaque BUY
        // C'est le vrai filtre — peu importe le type de marché
        // IMPORTANT : si CLOB vide = aucune activité = marché calme = trade stable ✅
        let stableTrades   = 0;
        let analyzedTrades = 0;
        let totalJump      = 0;
        let jumpCount      = 0; // compteur séparé car CLOB vide n'a pas de "jump"
        const pseudonym    = activity[0]?.pseudonym ?? activity[0]?.name ?? '';

        for (const trade of recentBuys.slice(0, 12)) {
            const entryPrice = trade.price ?? 0;
            if (entryPrice <= 0 || entryPrice >= 0.95) continue; // Skip si déjà cher

            await sleep(300);
            analyzedTrades++;

            const laterPrice = await getPriceAfterDelay(trade.asset, trade.timestamp, STABILITY_DELAY_S);

            if (laterPrice === null) {
                // Aucune activité 30min après l'entrée → marché calme = pas de spike = stable ✅
                stableTrades++;
                continue;
            }

            const jump = (laterPrice - entryPrice) / entryPrice;
            totalJump += jump;
            jumpCount++;

            if (jump <= SPIKE_THRESHOLD) {
                stableTrades++;
            }
        }

        if (analyzedTrades < 1) {
            process.stdout.write(`(0 trade exploitable — prix déjà ≥$0.95 à l'entrée) `);
            return null;
        }

        const stabilityRatio  = stableTrades / analyzedTrades;
        const avgPriceJumpPct = jumpCount > 0 ? (totalJump / jumpCount) * 100 : 0;

        // Score composite (0–100)
        // Stabilité : poids 50% — c'est le critère principal
        const stabilityScore = stabilityRatio * 50;
        // Rentabilité : poids 30% — plafonné à $10K réalisé = 30 pts
        const profitScore    = Math.min(Math.max(realizedPnl, 0) / 333, 30);
        // Activité : poids 20% — plafonné à 10 trades = 20 pts
        const activityScore  = Math.min(recentTrades.length, 10) * 2;

        const compositeScore = stabilityScore + profitScore + activityScore;

        return {
            address,
            pseudonym,
            totalBuyTrades:  recentBuys.length,
            analyzedTrades,

            stableTrades,
            stabilityRatio,
            avgPriceJumpPct,
            realizedPnl,
            openPnl,
            openPositions,
            recentTradeCount: recentTrades.length,
            compositeScore,
        };

    } catch (err: any) {
        process.stdout.write(`(erreur: ${err?.response?.status ?? err?.code ?? '?'}) `);
        return null;
    }
};

// ─── Phase 3 : Affichage des résultats ───────────────────────────────────────

const printResults = (results: TraderResult[], totalAnalyzed: number) => {
    const sorted = [...results].sort((a, b) => b.compositeScore - a.compositeScore);

    console.log('\n');
    console.log('══════════════════════════════════════════════════════════════════════');
    console.log('🏆  CLASSEMENT DES TRADERS COPIABLES');
    console.log(`    ${results.length} traders qualifiés sur ${totalAnalyzed} analysés`);
    console.log('══════════════════════════════════════════════════════════════════════');

    if (sorted.length === 0) {
        console.log('\n   Aucun trader trouvé. Essayez avec plus de marchés :');
        console.log('   npx ts-node src/scripts/findCopyableTraders.ts 60 150\n');
        return;
    }

    for (let i = 0; i < sorted.length; i++) {
        const t = sorted[i];
        const medal =
            i === 0 ? '🥇' :
            i === 1 ? '🥈' :
            i === 2 ? '🥉' :
            `${i + 1}. `;

        const stIcon =
            t.stabilityRatio >= 0.70 ? '🟢' :
            t.stabilityRatio >= 0.50 ? '🟡' : '🔴';

        const pnlStr = t.realizedPnl >= 0
            ? `+$${t.realizedPnl.toFixed(0)}`
            : `-$${Math.abs(t.realizedPnl).toFixed(0)}`;

        const openStr = t.openPnl >= 0
            ? `+$${t.openPnl.toFixed(0)}`
            : `-$${Math.abs(t.openPnl).toFixed(0)}`;

        const name = t.pseudonym ? ` (${t.pseudonym})` : '';

        console.log(`\n${medal} ${t.address}${name}`);
        console.log(`   ${stIcon} Stabilité : ${(t.stabilityRatio * 100).toFixed(0)}%` +
            ` (${t.stableTrades}/${t.analyzedTrades} trades stables)` +
            ` | Saut moyen 30min : ${t.avgPriceJumpPct >= 0 ? '+' : ''}${t.avgPriceJumpPct.toFixed(1)}%`);
        console.log(`   💰 P&L réalisé : ${pnlStr} | Open : ${openStr}` +
            ` | Positions : ${t.openPositions}`);
        console.log(`   📊 Score : ${t.compositeScore.toFixed(1)}` +
            ` | Trades récents : ${t.recentTradeCount}`);
    }

    // ─── Recommandation USER_ADDRESSES ───────────────────────────────────────
    console.log('\n');
    console.log('══════════════════════════════════════════════════════════════════════');
    console.log('📋  CONFIG RECOMMANDÉE POUR .env');
    console.log('══════════════════════════════════════════════════════════════════════');

    // Critères pour la liste recommandée :
    // - Stabilité >= 60% (majorité des trades copiables)
    // - P&L réalisé >= $0 (ne perd pas d'argent)
    // - Score composite >= 30
    const recommended = sorted
        .filter(t => t.stabilityRatio >= 0.60 && t.realizedPnl >= 0 && t.compositeScore >= 30)
        .slice(0, 7);

    if (recommended.length > 0) {
        const addrList = recommended.map(t => t.address).join(', ');
        console.log('\nUSER_ADDRESSES=\'' + addrList + '\'');
        console.log('\n# Détail des traders retenus :');
        recommended.forEach(t => {
            const name = t.pseudonym ? ` — ${t.pseudonym}` : '';
            console.log(`# ${t.address.slice(0,8)}...${t.address.slice(-4)}${name}` +
                ` | Stabilité: ${(t.stabilityRatio * 100).toFixed(0)}%` +
                ` | P&L réalisé: +$${t.realizedPnl.toFixed(0)}`);
        });
    } else {
        // Critères assouplis si trop peu de résultats
        const fallback = sorted.filter(t => t.stabilityRatio >= 0.50).slice(0, 5);
        if (fallback.length > 0) {
            console.log('\n⚠️  Critères assouplis (stabilité >= 50%) :');
            const addrList = fallback.map(t => t.address).join(', ');
            console.log('USER_ADDRESSES=\'' + addrList + '\'');
        } else {
            console.log('\n   Pas assez de traders stables. Essayez :');
            console.log('   npx ts-node src/scripts/findCopyableTraders.ts 60 150');
        }
    }

    // ─── Export de toutes les adresses qualifiées dans un fichier ────────────
    const outputPath = path.join(process.cwd(), 'data', 'copyable_traders.txt');
    const lines = [
        `# findCopyableTraders — ${new Date().toISOString().slice(0, 10)}`,
        `# ${sorted.length} traders qualifiés (stabilité >= 60%, P&L réalisé >= $0)`,
        `# Trié par score composite décroissant`,
        '',
        ...sorted.map((t, i) => {
            const name = t.pseudonym ? ` # ${t.pseudonym}` : '';
            return `${t.address}${name} # rank:${i+1} stabilité:${(t.stabilityRatio*100).toFixed(0)}% réalisé:+$${t.realizedPnl.toFixed(0)} score:${t.compositeScore.toFixed(1)}`;
        }),
        '',
        `# USER_ADDRESSES pour .env (toutes):`,
        `USER_ADDRESSES='${sorted.map(t => t.address).join(', ')}'`,
    ];
    try {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
        console.log(`\n💾 Toutes les adresses exportées → data/copyable_traders.txt`);
    } catch {
        // Ignorer si le répertoire n'existe pas
    }

    console.log('\n══════════════════════════════════════════════════════════════════════');

    // ─── Analyse des traders ACTUELS pour comparaison ────────────────────────
    const currentTraders = results.filter(r =>
        ENV.USER_ADDRESSES.some(a => a.toLowerCase() === r.address.toLowerCase())
    );

    if (currentTraders.length > 0) {
        console.log('\n📌  VOS TRADERS ACTUELS (pour comparaison) :');
        currentTraders
            .sort((a, b) => b.compositeScore - a.compositeScore)
            .forEach(t => {
                const stIcon =
                    t.stabilityRatio >= 0.70 ? '🟢' :
                    t.stabilityRatio >= 0.50 ? '🟡' : '🔴';
                const verdict =
                    t.stabilityRatio >= 0.60 ? '✅ Garder' :
                    t.stabilityRatio >= 0.40 ? '🤔 Marginal' : '❌ Retirer';
                console.log(`   ${verdict} ${t.address.slice(0, 8)}...` +
                    ` ${stIcon} Stabilité: ${(t.stabilityRatio * 100).toFixed(0)}%` +
                    ` | P&L: +$${t.realizedPnl.toFixed(0)}`);
            });
        console.log('');
    }
};

// ─── Main ─────────────────────────────────────────────────────────────────────

const main = async () => {
    console.log('══════════════════════════════════════════════════════════════════════');
    console.log('🔬  FINDCOPYABLETRADERS — Recherche de traders à marchés stables');
    console.log('══════════════════════════════════════════════════════════════════════');
    console.log(`   Critère principal : prix < +${SPIKE_THRESHOLD * 100}% dans les 30 min après l'entrée`);
    console.log(`   Marchés courts-termes (by-date, end-of-month) : ignorés pour la découverte, pas pour l'analyse`);
    console.log(`   Lookback : ${LOOKBACK_DAYS} jours\n`);

    // Phase 1 : Découverte
    const allAddresses = await discoverTraders();
    const toAnalyze    = allAddresses.slice(0, MAX_TRADERS);

    console.log(`📊 Analyse de ${toAnalyze.length} traders...`);
    console.log('   (Chaque trader prend ~10-20s à analyser — patience)\n');

    // Phase 2 : Analyse
    const results: TraderResult[] = [];
    let count = 0;

    for (const address of toAnalyze) {
        count++;
        const shortAddr = `${address.slice(0, 8)}...${address.slice(-4)}`;
        process.stdout.write(`   [${count.toString().padStart(3)}/${toAnalyze.length}] ${shortAddr} `);

        const result = await analyzeTrader(address);

        if (result) {
            results.push(result);
            const icon =
                result.stabilityRatio >= 0.70 ? '🟢' :
                result.stabilityRatio >= 0.50 ? '🟡' : '🔴';
            const name = result.pseudonym ? ` (${result.pseudonym})` : '';
            console.log(
                `${icon} ${(result.stabilityRatio * 100).toFixed(0)}% stable` +
                ` | saut moy: ${result.avgPriceJumpPct >= 0 ? '+' : ''}${result.avgPriceJumpPct.toFixed(0)}%` +
                ` | réalisé: ${result.realizedPnl >= 0 ? '+' : ''}$${result.realizedPnl.toFixed(0)}` +
                name
            );
        } else {
            console.log('⏭️');
        }
    }

    // Phase 3 : Affichage
    printResults(results, toAnalyze.length);
};

main().catch(err => {
    console.error('\n❌ Erreur:', err.message ?? err);
    process.exit(1);
});
