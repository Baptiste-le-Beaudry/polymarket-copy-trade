/**
 * checkPriceDelay.ts
 * Analyse le prix du marché X secondes après qu'un trader ait placé une position.
 * Permet de quantifier le "late entry problem" : à quel point le marché a-t-il bougé
 * avant que notre bot puisse copier le trade ?
 *
 * Usage : npx ts-node src/scripts/checkPriceDelay.ts [secondes] [nb_trades]
 * Exemple : npx ts-node src/scripts/checkPriceDelay.ts 10 20
 */

import mongoose from 'mongoose';
import { ENV } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';

const DELAY_SECONDS = parseInt(process.argv[2] ?? '10', 10);
const TRADES_PER_TRADER = parseInt(process.argv[3] ?? '20', 10);

interface ClobTrade {
    price: string;
    size: string;
    side: string;
    match_time: string; // ISO string
}

interface TradeEntry {
    trader: string;
    asset: string;
    slug: string;
    traderPrice: number;
    timestamp: number; // epoch seconds
    usdcSize: number;
}

interface DelayResult {
    trader: string;
    asset: string;
    slug: string;
    traderPrice: number;
    priceAfterDelay: number | null;
    priceMovePercent: number | null;
    tradeCountInWindow: number;
    wouldBeBlocked: boolean;
    usdcSize: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Récupère les trades réels sur un token dans une fenêtre temporelle.
 * Utilise le CLOB Polymarket : /trades?token_id=X&after=T1&before=T2
 */
const getPriceAfterDelay = async (
    asset: string,
    traderTimestamp: number, // epoch seconds
    delaySeconds: number
): Promise<{ price: number | null; tradeCount: number }> => {
    const afterTs = traderTimestamp + delaySeconds;
    const beforeTs = traderTimestamp + delaySeconds + 60; // fenêtre de 60s pour chercher des trades

    // Le CLOB accepte des timestamps en secondes
    const url = `https://clob.polymarket.com/trades?token_id=${asset}&after=${afterTs}&before=${beforeTs}&limit=5`;

    try {
        const data = await fetchData(url);
        const trades = Array.isArray(data) ? (data as ClobTrade[]) : [];

        if (trades.length === 0) {
            return { price: null, tradeCount: 0 };
        }

        // Prendre le prix du premier trade exécuté dans la fenêtre
        const firstPrice = parseFloat(trades[0].price);
        return { price: firstPrice, tradeCount: trades.length };
    } catch {
        return { price: null, tradeCount: 0 };
    }
};

const analyzeTrader = async (traderAddress: string): Promise<DelayResult[]> => {
    const UserActivity = getUserActivityModel(traderAddress);

    // Récupérer les derniers BUY trades
    const recentCutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 3600; // 7 derniers jours
    const trades = await UserActivity.find({
        side: 'BUY',
        timestamp: { $gte: recentCutoff },
        asset: { $exists: true, $ne: null },
    })
        .sort({ timestamp: -1 })
        .limit(TRADES_PER_TRADER)
        .lean();

    if (trades.length === 0) {
        return [];
    }

    const results: DelayResult[] = [];

    for (const trade of trades) {
        const traderPrice = trade.price ?? 0;
        const asset = trade.asset ?? '';
        const slug = trade.slug ?? trade.eventSlug ?? asset.slice(0, 12) + '...';
        const timestamp = trade.timestamp ?? 0;

        if (!asset || !timestamp || !traderPrice) continue;

        // Petite pause pour ne pas spammer l'API
        await sleep(300);

        const { price: delayedPrice, tradeCount } = await getPriceAfterDelay(
            asset,
            timestamp,
            DELAY_SECONDS
        );

        const priceMovePercent =
            delayedPrice !== null && traderPrice > 0
                ? ((delayedPrice - traderPrice) / traderPrice) * 100
                : null;

        const wouldBeBlocked =
            delayedPrice !== null && delayedPrice >= ENV.MAX_BUY_PRICE;

        results.push({
            trader: traderAddress.slice(0, 6) + '...' + traderAddress.slice(-4),
            asset,
            slug: slug.slice(0, 45),
            traderPrice,
            priceAfterDelay: delayedPrice,
            priceMovePercent,
            tradeCountInWindow: tradeCount,
            wouldBeBlocked,
            usdcSize: trade.usdcSize ?? 0,
        });
    }

    return results;
};

const printResults = (allResults: DelayResult[]) => {
    if (allResults.length === 0) {
        console.log('Aucun trade trouvé dans les 7 derniers jours.');
        return;
    }

    const withData = allResults.filter((r) => r.priceAfterDelay !== null);
    const noData = allResults.filter((r) => r.priceAfterDelay === null);
    const blocked = withData.filter((r) => r.wouldBeBlocked);
    const copyable = withData.filter((r) => !r.wouldBeBlocked);

    const avgMove =
        withData.length > 0
            ? withData.reduce((s, r) => s + (r.priceMovePercent ?? 0), 0) / withData.length
            : 0;

    console.log('');
    console.log('════════════════════════════════════════════════════════════════');
    console.log(`📊 ANALYSE : Prix ${DELAY_SECONDS}s après l'entrée du trader`);
    console.log('════════════════════════════════════════════════════════════════');
    console.log(`Trades analysés    : ${allResults.length}`);
    console.log(`Avec données CLOB  : ${withData.length} | Sans données : ${noData.length}`);
    console.log(`Copiables (< MAX_BUY_PRICE $${ENV.MAX_BUY_PRICE}): ${copyable.length} (${withData.length > 0 ? ((copyable.length / withData.length) * 100).toFixed(0) : 0}%)`);
    console.log(`Bloqués par filtre prix : ${blocked.length} (${withData.length > 0 ? ((blocked.length / withData.length) * 100).toFixed(0) : 0}%)`);
    console.log(`Mouvement moyen ${DELAY_SECONDS}s : ${avgMove >= 0 ? '+' : ''}${avgMove.toFixed(1)}%`);
    console.log('════════════════════════════════════════════════════════════════');

    // Détail par trader
    const traders = [...new Set(allResults.map((r) => r.trader))];
    for (const trader of traders) {
        const traderResults = withData.filter((r) => r.trader === trader);
        if (traderResults.length === 0) continue;

        const traderBlocked = traderResults.filter((r) => r.wouldBeBlocked).length;
        const traderAvgMove =
            traderResults.reduce((s, r) => s + (r.priceMovePercent ?? 0), 0) /
            traderResults.length;

        console.log(`\n👤 ${trader}`);
        console.log(`   Trades analysés : ${traderResults.length} | Bloqués : ${traderBlocked}`);
        console.log(`   Mouvement moyen : ${traderAvgMove >= 0 ? '+' : ''}${traderAvgMove.toFixed(1)}%`);
        console.log('');

        // Top 5 trades les plus révélateurs
        const sorted = [...traderResults].sort(
            (a, b) => Math.abs(b.priceMovePercent ?? 0) - Math.abs(a.priceMovePercent ?? 0)
        );
        for (const r of sorted.slice(0, 5)) {
            const arrow = (r.priceMovePercent ?? 0) > 0 ? '📈' : (r.priceMovePercent ?? 0) < 0 ? '📉' : '➡️';
            const blocked = r.wouldBeBlocked ? ' ❌ BLOQUÉ' : ' ✅ copiable';
            const move = r.priceMovePercent !== null ? `${r.priceMovePercent >= 0 ? '+' : ''}${r.priceMovePercent.toFixed(1)}%` : 'N/A';
            console.log(
                `   ${arrow} $${r.traderPrice.toFixed(3)} → $${(r.priceAfterDelay ?? 0).toFixed(3)} (${move}) | ${r.slug}${blocked}`
            );
        }
    }

    console.log('');
    console.log('════════════════════════════════════════════════════════════════');
    console.log('📋 CONCLUSION');
    console.log('════════════════════════════════════════════════════════════════');
    if (withData.length > 0) {
        const blockRate = (blocked.length / withData.length) * 100;
        if (blockRate > 70) {
            console.log(`⚠️  ${blockRate.toFixed(0)}% des trades sont bloqués ${DELAY_SECONDS}s après → trades trop rapides ou marchés in-play`);
        } else if (blockRate > 40) {
            console.log(`🟡 ${blockRate.toFixed(0)}% des trades bloqués → certains marchés bougent vite`);
        } else {
            console.log(`✅ Seulement ${blockRate.toFixed(0)}% bloqués → ces traders sont copiables`);
        }
        console.log(`   MAX_BUY_PRICE actuel : $${ENV.MAX_BUY_PRICE}`);
        console.log(`   Mouvement moyen en ${DELAY_SECONDS}s : +${avgMove.toFixed(1)}%`);
    }
    console.log('════════════════════════════════════════════════════════════════');
};

const main = async () => {
    console.log(`🔍 Analyse du prix ${DELAY_SECONDS}s après l'entrée du trader`);
    console.log(`   Traders suivis : ${ENV.USER_ADDRESSES.join(', ')}`);
    console.log(`   Trades par trader : ${TRADES_PER_TRADER}`);
    console.log('   Connexion MongoDB...');

    await mongoose.connect(ENV.MONGO_URI);
    console.log('   ✅ Connecté\n');

    const allResults: DelayResult[] = [];

    for (const traderAddress of ENV.USER_ADDRESSES) {
        process.stdout.write(`   Analyse de ${traderAddress.slice(0, 8)}... `);
        const results = await analyzeTrader(traderAddress);
        allResults.push(...results);
        console.log(`${results.length} trades`);
    }

    await mongoose.disconnect();

    printResults(allResults);
};

main().catch((err) => {
    console.error('Erreur :', err);
    process.exit(1);
});
