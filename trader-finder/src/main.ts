/**
 * main.ts — Polymarket Trader Finder
 *
 * Trouve les traders "positionnels" sur Polymarket : ceux dont les trades
 * peuvent être copiés avec un délai de 5-30 secondes.
 *
 * ALGORITHME :
 *   1. Scan de N marchés actifs long-terme → collecte d'adresses de traders
 *   2. Pour chaque trader :
 *      a. Fetch ses 100 derniers trades (30 jours)
 *      b. Filtre rapide : prix d'achat moyen > $0.70 → news trader → skip
 *      c. Pour chaque BUY : vérifie quand le marché s'est résolu (gamma API)
 *      d. Calcule : avg_buy_price, % résolutions rapides, P&L, diversification
 *   3. Analyse OpenAI (gpt-4o-mini) pour chaque trader qualifié
 *   4. Exporte les résultats dans output/results.txt
 *
 * USAGE :
 *   npm run find                    # 40 marchés, 60 traders (défaut)
 *   npm run find -- 60 100          # 60 marchés, 100 traders
 *   ts-node src/main.ts 40 60       # Direct
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import {
    classifyWithOpenAI,
    heuristicClassify,
    TraderProfile,
    OpenAIVerdict,
} from './openaiClassify';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// ─── Configuration ────────────────────────────────────────────────────────────

const OPENAI_KEY         = process.env.OPENAI_API_KEY ?? '';
const MARKETS_TO_SCAN    = parseInt(process.argv[2] ?? process.env.MARKETS_TO_SCAN ?? '40');
const MAX_TRADERS        = parseInt(process.argv[3] ?? process.env.MAX_TRADERS ?? '60');
const LOOKBACK_DAYS      = parseInt(process.env.LOOKBACK_DAYS ?? '30');
const MAX_AVG_BUY_PRICE  = parseFloat(process.env.MAX_AVG_BUY_PRICE ?? '0.70');
const FAST_RESOLVE_HOURS = 2;   // résolution < 2h après achat = probablement news trading
const MIN_BUYS           = 3;   // minimum de BUY récents pour être analysé
const DELAY_MS           = 350; // pause entre requêtes API (rate limit)

const USE_AI = OPENAI_KEY.startsWith('sk-') || OPENAI_KEY.startsWith('sk-proj-');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

const get = async <T>(url: string, timeoutMs = 15000): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': 'polymarket-trader-finder/1.0' },
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<T>;
    } finally {
        clearTimeout(timer);
    }
};

// Marchés courts-termes à ignorer lors de la découverte (spikent instantanément)
const SHORT_TERM_RE = [
    /\bby-(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
    /end-of-(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
    /-tonight\b/i,
    /-today\b/i,
    /-this-week\b/i,
];
const isShortTerm = (slug: string): boolean => SHORT_TERM_RE.some(r => r.test(slug));

// ─── Types internes ───────────────────────────────────────────────────────────

interface RawTrade {
    asset?: string;
    price?: number;
    size?: number;
    side?: string;
    timestamp?: number;
    market?: string;
    outcome?: string;
    pseudonym?: string;
    name?: string;
}

interface RawPosition {
    realizedPnl?: number;
    cashPnl?: number;
}

interface GammaMarket {
    resolved?: boolean;
    resolutionDateTime?: string;
    endDateIso?: string;
    slug?: string;
}

// ─── Phase 1 : Découverte des traders ────────────────────────────────────────

const discoverTraders = async (): Promise<string[]> => {
    const found = new Set<string>();

    console.log(`\n🔍 Scan de ${MARKETS_TO_SCAN} marchés actifs long-terme...`);

    try {
        // Gamma API : liste des marchés actifs
        const markets = await get<Array<{ conditionId: string; slug?: string; closed?: boolean }>>(
            'https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=200'
        );

        // Filtrer les marchés courts-termes
        const longTerm = markets.filter(m => !m.closed && !isShortTerm(m.slug ?? ''));
        console.log(`   ${longTerm.length} marchés long-terme retenus sur ${markets.length} actifs`);

        let scanned = 0;
        for (const market of longTerm.slice(0, MARKETS_TO_SCAN)) {
            await sleep(DELAY_MS);
            try {
                const trades = await get<Array<{ owner?: string; proxyWallet?: string }>>(
                    `https://data-api.polymarket.com/trades?market=${market.conditionId}&limit=50`
                );
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

        console.log(`   ${scanned} marchés scannés → ${found.size} adresses uniques trouvées\n`);

    } catch (err: any) {
        console.log(`   ⚠️  Erreur lors du scan: ${err.message ?? err}\n`);
    }

    return [...found];
};

// ─── Phase 2 : Analyse d'un trader ───────────────────────────────────────────

const analyzeTrader = async (address: string): Promise<TraderProfile | null> => {
    const cutoff = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400;
    const marketCache = new Map<string, GammaMarket | null>();

    try {
        // Fetch activité récente
        const activity = await get<RawTrade[]>(
            `https://data-api.polymarket.com/activity?user=${address}&type=TRADE&limit=100`
        );
        await sleep(DELAY_MS);

        if (!Array.isArray(activity) || activity.length === 0) return null;

        // Filtrer sur la période
        const recentTrades = activity.filter(t => (t.timestamp ?? 0) >= cutoff);
        if (recentTrades.length === 0) return null;

        const buys = recentTrades.filter(t => t.side === 'BUY' && t.asset && (t.price ?? 0) > 0);
        if (buys.length < MIN_BUYS) return null;

        // ── Filtre rapide : prix moyen ──────────────────────────────────────
        const avgBuyPrice = buys.reduce((s, t) => s + (t.price ?? 0), 0) / buys.length;
        if (avgBuyPrice > MAX_AVG_BUY_PRICE) {
            process.stdout.write(`(avg buy $${avgBuyPrice.toFixed(2)} > $${MAX_AVG_BUY_PRICE}) `);
            return null;
        }

        const pctBuysUnder070 = buys.filter(t => (t.price ?? 0) < 0.70).length / buys.length;

        // ── Analyse vitesse de résolution pour les N derniers BUYs ──────────
        let fastCount    = 0;
        let resolvedCount = 0;
        let totalResolutionHours = 0;

        const analyzedBuys: TraderProfile['recentBuys'] = [];

        for (const buy of buys.slice(0, 15)) {
            const asset = buy.asset!;

            // Cache par asset pour éviter les appels dupliqués
            let marketInfo = marketCache.get(asset);
            if (marketInfo === undefined) {
                await sleep(200);
                try {
                    const data = await get<GammaMarket[]>(
                        `https://gamma-api.polymarket.com/markets?clob_token_ids=${asset}`
                    );
                    marketInfo = data?.[0] ?? null;
                } catch {
                    marketInfo = null;
                }
                marketCache.set(asset, marketInfo);
            }

            let hoursToResolution: number | null = null;

            if (marketInfo?.resolved && marketInfo?.resolutionDateTime) {
                const resolvedTs = Math.floor(new Date(marketInfo.resolutionDateTime).getTime() / 1000);
                const hours = (resolvedTs - (buy.timestamp ?? 0)) / 3600;
                // Ignorer si résolution AVANT l'achat (données incohérentes)
                if (hours >= 0) {
                    hoursToResolution = hours;
                    resolvedCount++;
                    totalResolutionHours += hours;
                    if (hours < FAST_RESOLVE_HOURS) fastCount++;
                }
            }

            analyzedBuys.push({
                price: buy.price ?? 0,
                market: buy.market ?? asset.slice(0, 12) + '...',
                timestamp: buy.timestamp ?? 0,
                hoursToResolution,
            });
        }

        const pctFastResolution = analyzedBuys.length > 0 ? fastCount / analyzedBuys.length : 0;
        const avgHoursToResolution = resolvedCount > 0 ? totalResolutionHours / resolvedCount : 999;

        // ── P&L ──────────────────────────────────────────────────────────────
        await sleep(DELAY_MS);
        let realizedPnl = 0;
        let openPnl = 0;

        try {
            const positions = await get<RawPosition[]>(
                `https://data-api.polymarket.com/positions?user=${address}`
            );
            if (Array.isArray(positions)) {
                positions.forEach(p => {
                    realizedPnl += p.realizedPnl ?? 0;
                    openPnl += p.cashPnl ?? 0;
                });
            }
        } catch {
            // Ignorer si positions indisponibles
        }

        const pseudonym = activity[0]?.pseudonym ?? activity[0]?.name ?? '';

        return {
            address,
            pseudonym,
            avgBuyPrice,
            pctBuysUnder070,
            pctFastResolution,
            avgHoursToResolution,
            uniqueMarkets: new Set(buys.map(t => t.market ?? t.asset)).size,
            tradeCount: recentTrades.length,
            realizedPnl,
            openPnl,
            recentBuys: analyzedBuys,
        };

    } catch (err: any) {
        process.stdout.write(`(err: ${err?.message?.slice?.(0, 30) ?? '?'}) `);
        return null;
    }
};

// ─── Phase 3 : Score de copiabilité ──────────────────────────────────────────

const computeCopyScore = (profile: TraderProfile, verdict: OpenAIVerdict): number => {
    // Composantes :
    // - 40% : prix d'achat moyen (0.05 = max, 0.70 = 0)
    const priceScore = Math.max(0, (MAX_AVG_BUY_PRICE - profile.avgBuyPrice) / MAX_AVG_BUY_PRICE) * 40;

    // - 25% : % achats sous $0.70
    const pctScore = profile.pctBuysUnder070 * 25;

    // - 20% : inverse du % de résolutions rapides (100% rapide = 0 pts)
    const speedScore = (1 - profile.pctFastResolution) * 20;

    // - 10% : P&L réalisé positif (plafonné à $5K = 10 pts)
    const pnlScore = Math.min(Math.max(profile.realizedPnl, 0) / 500, 10);

    // - 5% : confiance OpenAI (0-10 → 0-5 pts)
    const aiScore = (verdict.confidence / 10) * 5;

    return priceScore + pctScore + speedScore + pnlScore + aiScore;
};

// ─── Phase 4 : Affichage et export ───────────────────────────────────────────

interface FinalResult {
    profile: TraderProfile;
    verdict: OpenAIVerdict;
    copyScore: number;
}

const printAndExport = (results: FinalResult[], totalAnalyzed: number): void => {
    const sorted = [...results].sort((a, b) => b.copyScore - a.copyScore);

    const sep = '══════════════════════════════════════════════════════════════════════';
    console.log('\n\n' + sep);
    console.log('🏆  RÉSULTATS — TRADERS POSITIONNELS COPIABLES');
    console.log(`    ${results.length} traders qualifiés sur ${totalAnalyzed} analysés`);
    console.log(sep);

    if (sorted.length === 0) {
        console.log('\n   Aucun trader trouvé. Essayez avec plus de marchés :');
        console.log('   npm run find -- 80 120\n');
        return;
    }

    const lines: string[] = [
        `# Polymarket Trader Finder — ${new Date().toISOString().slice(0, 10)}`,
        `# ${results.length} traders copiables sur ${totalAnalyzed} analysés`,
        `# Filtre : avg_buy_price < $${MAX_AVG_BUY_PRICE} | Lookback: ${LOOKBACK_DAYS} jours`,
        `# Trié par score de copiabilité décroissant`,
        '',
    ];

    for (let i = 0; i < sorted.length; i++) {
        const { profile: p, verdict: v, copyScore } = sorted[i];

        const medal =
            i === 0 ? '🥇' :
            i === 1 ? '🥈' :
            i === 2 ? '🥉' :
            `${i + 1}. `;

        const classIcon =
            v.classification === 'POSITIONAL' ? '🟢 POSITIONNEL' :
            v.classification === 'NEWS_TRADER' ? '🔴 NEWS TRADER' :
            '🟡 MIXTE';

        const copyIcon = v.copyable ? '✅ COPIABLE' : '❌ NON COPIABLE';
        const name = p.pseudonym ? ` (${p.pseudonym})` : '';

        const pnlStr = p.realizedPnl >= 0
            ? `+$${p.realizedPnl.toFixed(0)}`
            : `-$${Math.abs(p.realizedPnl).toFixed(0)}`;

        console.log(`\n${medal} ${p.address}${name}`);
        console.log(`   ${classIcon} | ${copyIcon} | Score: ${copyScore.toFixed(1)}/100`);
        console.log(`   💵 Prix moy: $${p.avgBuyPrice.toFixed(3)} | ` +
            `${(p.pctBuysUnder070 * 100).toFixed(0)}% sous $0.70 | ` +
            `${(p.pctFastResolution * 100).toFixed(0)}% résolus <2h`);
        console.log(`   💰 P&L réalisé: ${pnlStr} | Open: $${p.openPnl.toFixed(0)} | ` +
            `${p.tradeCount} trades | ${p.uniqueMarkets} marchés`);
        console.log(`   🤖 IA (confiance ${v.confidence}/10): ${v.reasoning}`);

        lines.push(`─── #${i + 1} ${p.address}${name}`);
        lines.push(`    Classification : ${v.classification} | Copiable: ${v.copyable} | Score: ${copyScore.toFixed(1)}`);
        lines.push(`    Prix moy: $${p.avgBuyPrice.toFixed(3)} | % <$0.70: ${(p.pctBuysUnder070 * 100).toFixed(0)}% | % résolutions rapides: ${(p.pctFastResolution * 100).toFixed(0)}%`);
        lines.push(`    P&L réalisé: ${pnlStr} | Open: $${p.openPnl.toFixed(0)} | Trades: ${p.tradeCount} | Marchés: ${p.uniqueMarkets}`);
        lines.push(`    IA: ${v.reasoning}`);
        lines.push('');
    }

    // Config .env recommandée (traders copiables seulement)
    const copiable = sorted.filter(r => r.verdict.copyable && r.copyScore >= 40);

    console.log('\n\n' + sep);
    console.log('📋  CONFIG .env RECOMMANDÉE');
    console.log(sep);

    if (copiable.length > 0) {
        const addrList = copiable.map(r => r.profile.address).join(', ');
        console.log(`\nUSER_ADDRESSES='${addrList}'\n`);
        copiable.forEach((r, i) => {
            const name = r.profile.pseudonym ? ` — ${r.profile.pseudonym}` : '';
            console.log(`# ${i + 1}. ${r.profile.address.slice(0, 8)}...${r.profile.address.slice(-4)}${name}`);
            console.log(`#    Score: ${r.copyScore.toFixed(1)} | Prix moy: $${r.profile.avgBuyPrice.toFixed(3)} | P&L: ${r.profile.realizedPnl >= 0 ? '+' : ''}$${r.profile.realizedPnl.toFixed(0)}`);
        });

        lines.push('');
        lines.push('══════════════════════════════════════════════════════════');
        lines.push('CONFIG .env RECOMMANDÉE (traders copiables, score >= 40)');
        lines.push('══════════════════════════════════════════════════════════');
        lines.push('');
        lines.push(`USER_ADDRESSES='${addrList}'`);
    } else {
        console.log('\n   Aucun trader avec score >= 40. Essayez avec plus de marchés.');
        lines.push('Aucun trader avec score >= 40.');
    }

    console.log('\n' + sep + '\n');

    // Export fichier
    const outputDir = path.resolve(__dirname, '..', 'output');
    const outputFile = path.join(outputDir, 'results.txt');

    try {
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(outputFile, lines.join('\n'), 'utf8');
        console.log(`💾 Résultats exportés → output/results.txt\n`);
    } catch (err: any) {
        console.log(`⚠️  Impossible d'écrire le fichier: ${err.message}`);
    }
};

// ─── Main ─────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
    const sep = '══════════════════════════════════════════════════════════════════════';
    console.log(sep);
    console.log('🔬  POLYMARKET TRADER FINDER — Recherche de traders positionnels');
    console.log(sep);
    console.log(`   Filtre principal  : prix d'achat moyen < $${MAX_AVG_BUY_PRICE} (exclut news traders)`);
    console.log(`   Résolution rapide : marché résolu en < ${FAST_RESOLVE_HOURS}h après l'achat = signal news`);
    console.log(`   Lookback          : ${LOOKBACK_DAYS} jours`);
    console.log(`   Analyse IA        : ${USE_AI ? '✅ OpenAI gpt-4o-mini activé' : '⚠️  Pas de clé OpenAI — fallback heuristique'}`);
    console.log(`   Marchés à scanner : ${MARKETS_TO_SCAN}`);
    console.log(`   Traders max       : ${MAX_TRADERS}`);

    if (!USE_AI) {
        console.log('\n   💡 Pour activer l\'analyse IA : cp .env.example .env puis ajouter OPENAI_API_KEY');
    }

    // ── Phase 1 : Découverte ─────────────────────────────────────────────────
    const addresses = await discoverTraders();
    const toAnalyze = addresses.slice(0, MAX_TRADERS);

    if (toAnalyze.length === 0) {
        console.log('❌ Aucune adresse découverte. Vérifiez votre connexion.');
        process.exit(1);
    }

    console.log(`\n📊 Analyse de ${toAnalyze.length} traders...`);
    console.log('   (Chaque trader prend ~8-15s — patience)\n');

    // ── Phase 2 : Analyse + Classification ───────────────────────────────────
    const results: FinalResult[] = [];
    let count = 0;
    let skipped = 0;
    let aiCallCount = 0;

    for (const address of toAnalyze) {
        count++;
        const shortAddr = `${address.slice(0, 8)}...${address.slice(-4)}`;
        process.stdout.write(`   [${count.toString().padStart(3)}/${toAnalyze.length}] ${shortAddr} `);

        const profile = await analyzeTrader(address);

        if (!profile) {
            skipped++;
            console.log('⏭️');
            continue;
        }

        // Analyse IA (ou heuristique)
        let verdict: OpenAIVerdict;
        if (USE_AI) {
            process.stdout.write('🤖 ');
            verdict = await classifyWithOpenAI(profile);
            aiCallCount++;
            await sleep(500); // Respecter le rate limit OpenAI
        } else {
            verdict = heuristicClassify(profile);
        }

        const copyScore = computeCopyScore(profile, verdict);

        const classIcon =
            verdict.classification === 'POSITIONAL' ? '🟢' :
            verdict.classification === 'NEWS_TRADER' ? '🔴' : '🟡';

        const name = profile.pseudonym ? ` (${profile.pseudonym})` : '';
        console.log(
            `${classIcon} ${verdict.classification.padEnd(11)} | ` +
            `score:${copyScore.toFixed(0).padStart(3)} | ` +
            `prix:$${profile.avgBuyPrice.toFixed(2)} | ` +
            `résol rapide:${(profile.pctFastResolution * 100).toFixed(0)}% | ` +
            `P&L:$${profile.realizedPnl.toFixed(0)}` +
            name
        );

        results.push({ profile, verdict, copyScore });
    }

    // ── Phase 3 : Résultats ───────────────────────────────────────────────────
    console.log(`\n📈 Résumé du scan :`);
    console.log(`   Traders analysés  : ${count}`);
    console.log(`   Filtrés (skip)    : ${skipped}`);
    console.log(`   Qualifiés         : ${results.length}`);
    if (USE_AI) console.log(`   Appels OpenAI     : ${aiCallCount}`);

    printAndExport(results, count);
};

main().catch(err => {
    console.error('\n❌ Erreur fatale:', err.message ?? err);
    process.exit(1);
});
