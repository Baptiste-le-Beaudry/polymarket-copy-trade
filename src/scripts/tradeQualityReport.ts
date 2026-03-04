/**
 * Trade Quality Report
 *
 * Analyses 3 key metrics that explain why the bot may lose money in real trading:
 *
 *  1. COPY DELAY      — seconds between trader execution and bot execution
 *                       (if >60s the price has likely moved against us)
 *  2. SPREAD / SLIPPAGE — recorded in real-time logs; this report shows
 *                       what % of trades were skipped for high slippage
 *  3. CONCENTRATION   — % of copied trades from each trader
 *                       (high concentration = correlated risk)
 *
 * Run: npm run quality-report
 */

import mongoose from 'mongoose';
import { ENV } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';

const USER_ADDRESSES = ENV.USER_ADDRESSES;

const MONGO_URI = ENV.MONGO_URI;

interface TraderStats {
    address: string;
    totalExecuted: number;  // BUY trades actually executed
    totalSkipped: number;   // BUY trades skipped (bot: true, botExcutedTime: 999 or 0 → bot: true)
    delays: number[];       // delay in seconds per trade
    totalVolumeUSD: number;
}

async function main() {
    await mongoose.connect(MONGO_URI);

    const line = '─'.repeat(62);

    console.log('\n' + '═'.repeat(62));
    console.log('  TRADE QUALITY REPORT');
    console.log('  Métriques clés pour comprendre les pertes potentielles');
    console.log('═'.repeat(62));

    const stats: TraderStats[] = [];
    let grandTotalExecuted = 0;

    for (const address of USER_ADDRESSES) {
        const model = getUserActivityModel(address);

        // All BUY trades that were truly executed (botExcutedTime > 0, not the 999 "historical" mark)
        const executed = await model.find({
            type: 'TRADE',
            side: 'BUY',
            botExcutedTime: { $gt: 0, $lt: 900 },
        }).exec();

        // Skipped BUY trades (marked bot:true but botExcutedTime = 999 = historical OR 0 with bot:true)
        const skipped = await model.countDocuments({
            type: 'TRADE',
            side: 'BUY',
            bot: true,
            $or: [{ botExcutedTime: 999 }, { botExcutedTime: 0 }],
        });

        const delays: number[] = [];
        let totalVolumeUSD = 0;

        for (const trade of executed) {
            if (trade.usdcSize) totalVolumeUSD += trade.usdcSize;

            if (trade.timestamp) {
                let executedAtMs: number;
                const t = trade as any;

                if (typeof t.executedAt === 'number' && t.executedAt > 0) {
                    // New field added in Feb 2026
                    executedAtMs = t.executedAt;
                } else {
                    // Fallback: ObjectId creation timestamp (≈ when bot first detected the trade)
                    executedAtMs = (trade._id as mongoose.Types.ObjectId).getTimestamp().getTime();
                }

                const delayMs = executedAtMs - trade.timestamp * 1000;
                // Only accept plausible delays: 0s – 2h
                if (delayMs >= 0 && delayMs < 2 * 3600 * 1000) {
                    delays.push(delayMs / 1000);
                }
            }
        }

        stats.push({
            address,
            totalExecuted: executed.length,
            totalSkipped: skipped,
            delays,
            totalVolumeUSD,
        });

        grandTotalExecuted += executed.length;
    }

    // ── 1. COPY DELAY ──────────────────────────────────────────────
    console.log('\n⏱  COPY DELAY  (temps entre trade du trader → exécution bot)');
    console.log(line);
    console.log('  ⚡ <30s  excellent   |  ⏱ 30-90s  ok   |  🐌 >90s  dangereux');
    console.log(line);

    const allDelays: number[] = [];

    for (const s of [...stats].sort((a, b) => b.totalExecuted - a.totalExecuted)) {
        const short = `${s.address.slice(0, 6)}…${s.address.slice(-4)}`;

        if (s.totalExecuted === 0) {
            console.log(`  ${short}  →  0 trades exécutés`);
            continue;
        }

        if (s.delays.length === 0) {
            console.log(`  ${short}  →  ${s.totalExecuted} trades | délai non disponible (ancien format)`);
            continue;
        }

        const avg = s.delays.reduce((a, b) => a + b, 0) / s.delays.length;
        const max = Math.max(...s.delays);
        const min = Math.min(...s.delays);
        const over60 = s.delays.filter(d => d > 60).length;

        const fmtSec = (n: number) => n < 60 ? `${n.toFixed(0)}s` : `${Math.floor(n / 60)}m${Math.round(n % 60).toString().padStart(2, '0')}s`;
        const emoji = avg < 30 ? '⚡' : avg < 90 ? '⏱' : '🐌';

        allDelays.push(...s.delays);

        console.log(
            `  ${emoji} ${short}  |  ${s.totalExecuted} trades exécutés` +
            `  |  avg: ${fmtSec(avg)}  |  max: ${fmtSec(max)}  |  min: ${fmtSec(min)}` +
            `  |  >${60}s: ${over60}/${s.delays.length}`
        );
    }

    if (allDelays.length > 0) {
        const avg = allDelays.reduce((a, b) => a + b, 0) / allDelays.length;
        const over60 = allDelays.filter(d => d > 60).length;
        const pctOver60 = (over60 / allDelays.length * 100).toFixed(0);
        const fmtSec = (n: number) => n < 60 ? `${n.toFixed(0)}s` : `${Math.floor(n / 60)}m${Math.round(n % 60).toString().padStart(2, '0')}s`;
        console.log(`\n  ► Moyenne globale: ${fmtSec(avg)}  |  ${over60}/${allDelays.length} (${pctOver60}%) avaient délai >60s`);
    } else {
        console.log('\n  ℹ️  Pas encore de données de délai. Redémarre le bot pour commencer la collecte.');
    }

    // ── 2. CONCENTRATION ───────────────────────────────────────────
    console.log('\n\n📊  CONCENTRATION  (% des trades copiés par trader)');
    console.log(line);

    const sortedByCount = [...stats].sort((a, b) => b.totalExecuted - a.totalExecuted);

    for (const s of sortedByCount) {
        const short = `${s.address.slice(0, 6)}…${s.address.slice(-4)}`;
        const pct = grandTotalExecuted > 0 ? (s.totalExecuted / grandTotalExecuted * 100) : 0;
        const barFilled = Math.round(pct / 5);
        const bar = '█'.repeat(barFilled) + '░'.repeat(Math.max(0, 20 - barFilled));
        const vol = s.totalVolumeUSD > 0 ? `  vol: $${s.totalVolumeUSD.toFixed(0)}` : '';
        const skippedStr = s.totalSkipped > 0 ? `  (${s.totalSkipped} skippés)` : '';
        console.log(
            `  ${short}  ${s.totalExecuted.toString().padStart(3)} trades  (${pct.toFixed(0).padStart(3)}%)  ${bar}${vol}${skippedStr}`
        );
    }

    if (grandTotalExecuted > 0) {
        const maxConc = Math.max(...stats.map(s => s.totalExecuted));
        const maxPct = (maxConc / grandTotalExecuted) * 100;
        if (maxPct > 40) {
            console.log(`\n  ⚠️  RISQUE: Un trader représente ${maxPct.toFixed(0)}% de tous les trades copiés.`);
            console.log('     Si ce trader se trompe → perte concentrée. Diversifier.');
        } else {
            console.log(`\n  ✅ Concentration acceptable (max ${maxPct.toFixed(0)}% par trader).`);
        }
    }

    // ── 3. SPREAD / SLIPPAGE ───────────────────────────────────────
    console.log('\n\n💰  SPREAD / SLIPPAGE');
    console.log(line);
    console.log('  Le slippage (écart trader price → ask actuel) est loggué en temps réel.');
    console.log('  Cherche dans les logs :');
    console.log('    ✅ Spread: +0.XX%  →  bon (proche du prix du trader)');
    console.log('    ⚠️  Spread: +1-3%  →  attention (prix déjà bougé)');
    console.log('    🔴 Spread: >3%     →  dangereux (copie trop tard)');
    console.log('');
    console.log('  Paramètre actuel: MAX_SLIPPAGE_PERCENT = ' + process.env.MAX_SLIPPAGE_PERCENT + '%');
    console.log('  Si beaucoup de trades skippés pour slippage → réduire FETCH_INTERVAL.');

    // ── 4. RECOMMENDATIONS ────────────────────────────────────────
    console.log('\n\n🎯  RECOMMANDATIONS');
    console.log(line);

    const fetchInterval = ENV.FETCH_INTERVAL;
    const hasDelayData = allDelays.length > 0;
    const avgDelay = hasDelayData ? allDelays.reduce((a, b) => a + b, 0) / allDelays.length : 0;

    if (hasDelayData) {
        if (avgDelay > 90) {
            console.log(`  🐌 Délai moyen ${avgDelay.toFixed(0)}s est ÉLEVÉ. FETCH_INTERVAL actuel: ${fetchInterval}min.`);
            console.log('     → Change FETCH_INTERVAL=\'0.5\' pour poller toutes les 30s.');
        } else if (avgDelay > 45) {
            console.log(`  ⏱  Délai moyen ${avgDelay.toFixed(0)}s. Envisage FETCH_INTERVAL=\'0.5\' (30s).`);
        } else {
            console.log(`  ✅ Délai moyen ${avgDelay.toFixed(0)}s — satisfaisant.`);
        }
    }

    const maxConc = stats.length > 0 ? Math.max(...stats.map(s => s.totalExecuted)) : 0;
    const maxConcPct = grandTotalExecuted > 0 ? (maxConc / grandTotalExecuted * 100) : 0;
    if (maxConcPct > 40) {
        console.log(`  📊 Concentration élevée (${maxConcPct.toFixed(0)}%). Ajouter d'autres traders ou limiter par trader.`);
    }

    if (grandTotalExecuted === 0) {
        console.log('  ℹ️  Aucun trade exécuté pour l\'instant. Lance le bot en DRY_RUN pour collecter des données.');
    }

    const totalSkippedAll = stats.reduce((sum, s) => sum + s.totalSkipped, 0);
    if (totalSkippedAll > grandTotalExecuted * 0.5 && grandTotalExecuted > 0) {
        console.log(`  ⚠️  ${totalSkippedAll} trades skippés pour ${grandTotalExecuted} exécutés.`);
        console.log('     Beaucoup de filtres actifs — vérifier MAX_BUY_PRICE, MIN_GAIN_POTENTIAL_PERCENT, MAX_SLIPPAGE_PERCENT.');
    }

    console.log('\n' + '═'.repeat(62) + '\n');

    await mongoose.disconnect();
}

main().catch((err) => {
    console.error('Error:', err);
    process.exit(1);
});
