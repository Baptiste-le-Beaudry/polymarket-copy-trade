/**
 * Live position comparison: Bot vs Traders
 * Tracks shared positions in real-time and ranks traders by actual P&L performance
 */

import { ENV } from '../config/env';
import Logger from './logger';
import { getPositionTracker } from './positionTracker';
import { getSimulationTracker } from './simulationBalance';
import fetchData from './fetchData';

interface TraderPosition {
    asset: string;
    conditionId: string;
    title: string;
    outcome: string;
    size: number;
    avgPrice: number;
    curPrice: number;
    currentValue: number;
    initialValue: number;
    cashPnl: number;
    percentPnl: number;
    realizedPnl: number;
    redeemable: boolean;
    endDate?: string;
}

interface PositionMatch {
    conditionId: string;
    market: string;
    outcome: string;

    // Trader data
    traderAddress: string;
    traderEntryPrice: number;
    traderCurrentPrice: number;
    traderPnlPercent: number;
    traderPnlUSD: number;
    traderSize: number;

    // Bot data (may differ due to slippage)
    botEntryPrice: number;
    botCurrentPrice: number;
    botPnlPercent: number;
    botPnlUSD: number;
    botSize: number;

    // Gap analysis
    entryPriceDiff: number;   // % difference at entry (bot paid more)
    pnlGap: number;           // % points bot is behind trader
    isOpen: boolean;
    priceSource: 'orderbook' | 'api'; // where the current price came from
}

interface TraderRanking {
    address: string;
    shortAddress: string;

    // Volume & activity
    totalTrades: number;
    positionsTotal: number;
    positionsOpen: number;

    // P&L performance (from API)
    unrealizedPnlUSD: number;
    unrealizedPnlPercent: number;
    realizedPnlUSD: number;
    totalPnlUSD: number;

    // Win rate (from local tracking)
    wins: number;          // positions with pnl > 0
    losses: number;        // positions with pnl < 0
    winRate: number;       // wins / (wins + losses)

    // Shared positions with bot
    sharedPositions: number;
    avgEntryPriceGap: number; // avg % bot paid more
    avgPnlGap: number;        // avg % bot behind trader

    // Score (composite)
    score: number;
}

// Fetch trader positions from Polymarket API
async function fetchTraderPositions(address: string): Promise<TraderPosition[]> {
    try {
        const url = `https://data-api.polymarket.com/positions?user=${address}`;
        const data = await fetchData(url);
        if (!Array.isArray(data)) return [];
        return data.map((p: any) => ({
            asset: p.asset,
            conditionId: p.conditionId,
            title: p.title || p.market || 'Unknown',
            outcome: p.outcome || '',
            size: p.size || 0,
            avgPrice: p.avgPrice || 0,
            curPrice: p.curPrice || p.currentPrice || 0,
            currentValue: p.currentValue || 0,
            initialValue: p.initialValue || 0,
            cashPnl: p.cashPnl || 0,
            percentPnl: p.percentPnl || 0,
            realizedPnl: p.realizedPnl || 0,
            redeemable: p.redeemable || false,
            endDate: p.endDate,
        }));
    } catch {
        return [];
    }
}

// Fetch real-time midpoint price from CLOB order book for a token
// Returns null if the market is resolved (no bids/asks) or API fails
async function fetchRealTimePrice(asset: string): Promise<number | null> {
    try {
        const data = await fetchData(
            `https://clob.polymarket.com/book?token_id=${asset}`
        ) as { bids: Array<{ price: string }>; asks: Array<{ price: string }> };
        if (data?.bids?.[0] && data?.asks?.[0]) {
            const bid = parseFloat(data.bids[0].price);
            const ask = parseFloat(data.asks[0].price);
            if (bid > 0 && ask > 0 && isFinite(bid) && isFinite(ask)) {
                return (bid + ask) / 2;
            }
        }
        // No active order book → market likely resolved
        return null;
    } catch {
        return null;
    }
}

// Compare bot positions vs a specific trader, enriched with real-time order book prices
async function comparePositions(
    traderAddress: string,
    traderPositions: TraderPosition[],
    isDryRun: boolean
): Promise<PositionMatch[]> {
    const matches: PositionMatch[] = [];
    const positionTracker = getPositionTracker();
    const botPositions = positionTracker.getAllPositions();

    // Collect all assets that need a real-time price fetch (shared positions only)
    const sharedPairs: Array<{ traderPos: TraderPosition; botPos: ReturnType<typeof positionTracker.getAllPositions>[0] }> = [];
    for (const traderPos of traderPositions) {
        const botPos = botPositions.find(p => p.conditionId === traderPos.conditionId);
        if (botPos) sharedPairs.push({ traderPos, botPos });
    }

    // Fetch real-time order book prices for all shared positions in parallel
    const realTimePrices = await Promise.all(
        sharedPairs.map(({ traderPos }) => fetchRealTimePrice(traderPos.asset))
    );

    for (let i = 0; i < sharedPairs.length; i++) {
        const { traderPos, botPos } = sharedPairs[i];
        const realTimePrice = realTimePrices[i]; // null if market resolved

        // Get bot entry price (weighted average of all BUY trades)
        const botBuys = botPos.trades.filter(t => t.side === 'BUY');
        if (botBuys.length === 0) continue;
        const botEntryPrice = botBuys.reduce((sum, t) => sum + t.price * t.size, 0) /
                               botBuys.reduce((sum, t) => sum + t.size, 0);

        // Priority: real-time order book > API curPrice > entry price
        const currentPrice = realTimePrice ?? traderPos.curPrice ?? traderPos.avgPrice;
        const priceSource = realTimePrice !== null ? 'orderbook' : 'api';

        // Trader P&L (real-time if available, else Polymarket reported)
        const traderPnlPercent = traderPos.avgPrice > 0
            ? realTimePrice !== null
                ? ((currentPrice - traderPos.avgPrice) / traderPos.avgPrice) * 100
                : traderPos.percentPnl
            : traderPos.percentPnl;
        const traderPnlUSD = realTimePrice !== null
            ? traderPos.size * (currentPrice - traderPos.avgPrice)
            : traderPos.cashPnl;

        // Bot P&L using real-time price
        const botPnlPercent = botEntryPrice > 0
            ? ((currentPrice - botEntryPrice) / botEntryPrice) * 100
            : 0;
        const botSize = isDryRun
            ? (getSimulationTracker().getPosition(traderPos.asset)?.size || botPos.currentSize || botPos.initialSize)
            : (botPos.currentSize || botPos.initialSize);
        const botPnlUSD = botSize * (currentPrice - botEntryPrice);

        const entryPriceDiff = traderPos.avgPrice > 0
            ? ((botEntryPrice - traderPos.avgPrice) / traderPos.avgPrice) * 100
            : 0;

        matches.push({
            conditionId: traderPos.conditionId,
            market: traderPos.title,
            outcome: traderPos.outcome,
            traderAddress,
            traderEntryPrice: traderPos.avgPrice,
            traderCurrentPrice: currentPrice,
            traderPnlPercent,
            traderPnlUSD,
            traderSize: traderPos.size,
            botEntryPrice,
            botCurrentPrice: currentPrice,
            botPnlPercent,
            botPnlUSD,
            botSize,
            entryPriceDiff,
            pnlGap: botPnlPercent - traderPnlPercent,
            isOpen: !traderPos.redeemable && traderPos.size > 0.01,
            priceSource,
        } as PositionMatch & { priceSource: string });
    }

    return matches;
}

// Rank all traders by composite score
function rankTraders(
    traderData: { address: string; positions: TraderPosition[]; matches: PositionMatch[] }[]
): TraderRanking[] {
    const positionTracker = getPositionTracker();
    const traderStats = positionTracker.getTraderStats();

    const rankings: TraderRanking[] = traderData.map(({ address, positions, matches }) => {
        const stats = traderStats.find(s => s.trader.toLowerCase() === address.toLowerCase());

        const openPositions = positions.filter(p => !p.redeemable && p.size > 0.01);
        const closedPositions = positions.filter(p => p.redeemable || p.size < 0.01);

        // Calculate win/loss from position tracker history
        const history = positionTracker.getTradeHistory();
        const traderTrades = history.trades.filter(t => t.conditionId); // all closed trades
        let wins = 0;
        let losses = 0;

        // Count wins/losses per closed conditionId for this trader
        const closedConditionIds = new Set(closedPositions.map(p => p.conditionId));
        for (const condId of closedConditionIds) {
            const posHistory = traderTrades.filter(t => t.conditionId === condId);
            if (posHistory.length > 0) {
                const lastSell = posHistory[posHistory.length - 1];
                if (lastSell.pnl !== undefined) {
                    if (lastSell.pnl > 0) wins++;
                    else losses++;
                }
            }
        }

        const winRate = (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0;

        // Aggregate P&L from API data
        const unrealizedPnlUSD = openPositions.reduce((sum, p) => sum + p.cashPnl, 0);
        const unrealizedPnlPercent = openPositions.length > 0
            ? openPositions.reduce((sum, p) => sum + p.percentPnl, 0) / openPositions.length
            : 0;
        const realizedPnlUSD = positions.reduce((sum, p) => sum + p.realizedPnl, 0);
        const totalPnlUSD = unrealizedPnlUSD + realizedPnlUSD;

        // Shared position analysis
        const avgEntryPriceGap = matches.length > 0
            ? matches.reduce((sum, m) => sum + m.entryPriceDiff, 0) / matches.length
            : 0;
        const avgPnlGap = matches.length > 0
            ? matches.reduce((sum, m) => sum + m.pnlGap, 0) / matches.length
            : 0;

        // Composite score:
        // + unrealized P&L (weighted)
        // + realized P&L
        // + win rate bonus
        // - entry price gap penalty (bot pays more = worse)
        const score =
            unrealizedPnlPercent * 2 +
            (realizedPnlUSD > 0 ? Math.log(realizedPnlUSD + 1) * 10 : realizedPnlUSD) +
            winRate * 0.5 -
            Math.abs(avgEntryPriceGap) * 3;  // Penalize traders who cause high slippage

        return {
            address,
            shortAddress: `${address.substring(0, 6)}...${address.substring(address.length - 4)}`,
            totalTrades: stats?.totalTrades || 0,
            positionsTotal: positions.length,
            positionsOpen: openPositions.length,
            unrealizedPnlUSD,
            unrealizedPnlPercent,
            realizedPnlUSD,
            totalPnlUSD,
            wins,
            losses,
            winRate,
            sharedPositions: matches.length,
            avgEntryPriceGap,
            avgPnlGap,
            score,
        };
    });

    return rankings.sort((a, b) => b.score - a.score);
}

// Main function called periodically from index.ts
export async function displayLiveComparison(): Promise<void> {
    try {
        const isDryRun = ENV.DRY_RUN;

        // Fetch trader data from API and enrich with real-time order book prices
        const traderData: { address: string; positions: TraderPosition[]; matches: PositionMatch[] }[] = [];

        for (const address of ENV.USER_ADDRESSES) {
            const positions = await fetchTraderPositions(address);
            const matches = await comparePositions(address, positions, isDryRun);
            traderData.push({ address, positions, matches });
        }

        const allMatches = traderData.flatMap(d => d.matches);
        const rankings = rankTraders(traderData);

        Logger.separator();
        Logger.info('📊 LIVE POSITION COMPARISON — BOT vs TRADERS');
        Logger.separator();

        // ─── SHARED POSITIONS TABLE ───
        if (allMatches.length === 0) {
            Logger.info('ℹ️  No shared positions found yet.');
        } else {
            const openMatches = allMatches.filter(m => m.isOpen);
            Logger.info(`🔄 Shared open positions: ${openMatches.length}`);
            Logger.info('');

            for (const m of openMatches.slice(0, 10)) {
                const marketShort = m.market.length > 42 ? m.market.substring(0, 42) + '…' : m.market;
                const traderPnlStr = `${m.traderPnlPercent >= 0 ? '+' : ''}${m.traderPnlPercent.toFixed(1)}%`;
                const traderUsdStr = `${m.traderPnlUSD >= 0 ? '+' : ''}$${m.traderPnlUSD.toFixed(2)}`;
                const botPnlStr = `${m.botPnlPercent >= 0 ? '+' : ''}${m.botPnlPercent.toFixed(1)}%`;
                const botUsdStr = `${m.botPnlUSD >= 0 ? '+' : ''}$${m.botPnlUSD.toFixed(2)}`;
                const gapStr = `${m.pnlGap >= 0 ? '+' : ''}${m.pnlGap.toFixed(1)}%`;
                const gapIcon = m.pnlGap >= -1 ? '✅' : m.pnlGap >= -5 ? '⚠️' : '❌';
                const priceIcon = m.priceSource === 'orderbook' ? '📡' : '🕒';
                const priceLabel = m.priceSource === 'orderbook' ? 'live' : 'API';

                Logger.info(`  ${gapIcon} ${marketShort} [${m.outcome}]`);
                Logger.info(
                    `     ${priceIcon} Prix actuel: $${m.traderCurrentPrice.toFixed(4)} (${priceLabel}) | ` +
                    `Trader entry: $${m.traderEntryPrice.toFixed(4)} | ` +
                    `Bot entry: $${m.botEntryPrice.toFixed(4)} ` +
                    `(${m.entryPriceDiff >= 0 ? '+' : ''}${m.entryPriceDiff.toFixed(1)}%)`
                );
                Logger.info(
                    `     Trader P&L: ${traderPnlStr} (${traderUsdStr}) | ` +
                    `Bot P&L: ${botPnlStr} (${botUsdStr}) | ` +
                    `Écart: ${gapStr} ${m.pnlGap < 0 ? '(bot en retard)' : '(bot en avance!)'}`
                );
            }
        }

        Logger.separator();

        // ─── TRADER RANKINGS ───
        Logger.info('🏆 TRADER RANKING (by composite score)');
        Logger.separator();

        const medals = ['🥇', '🥈', '🥉', '4️⃣ ', '5️⃣ '];

        for (let i = 0; i < rankings.length; i++) {
            const r = rankings[i];
            const medal = medals[i] || `${i + 1}.  `;
            const winRateStr = r.wins + r.losses > 0
                ? `${r.winRate.toFixed(0)}% win (${r.wins}W/${r.losses}L)`
                : 'no data';
            const pnlStr = `${r.unrealizedPnlUSD >= 0 ? '+' : ''}$${r.unrealizedPnlUSD.toFixed(0)} open / ${r.realizedPnlUSD >= 0 ? '+' : ''}$${r.realizedPnlUSD.toFixed(0)} realized`;
            const gapStr = r.sharedPositions > 0
                ? `${r.avgEntryPriceGap >= 0 ? '+' : ''}${r.avgEntryPriceGap.toFixed(1)}% entry gap (bot)`
                : 'no shared positions';

            Logger.info(`${medal} ${r.shortAddress}`);
            Logger.info(`     Score: ${r.score.toFixed(1)} | P&L: ${pnlStr}`);
            Logger.info(`     Positions: ${r.positionsOpen} open / ${r.positionsTotal} total | ${winRateStr}`);
            Logger.info(`     Trades copied: ${r.totalTrades} | Shared: ${r.sharedPositions} | ${gapStr}`);
            Logger.info('');
        }

        // ─── RECOMMENDATION ───
        if (rankings.length > 1) {
            const best = rankings[0];
            const worst = rankings[rankings.length - 1];
            Logger.info('💡 RECOMMENDATION:');
            Logger.info(`   Best trader to copy: ${best.shortAddress} (score: ${best.score.toFixed(1)})`);
            if (best.avgEntryPriceGap > 3) {
                Logger.warning(`   ⚠️  But: avg entry gap is ${best.avgEntryPriceGap.toFixed(1)}% — you pay ${best.avgEntryPriceGap.toFixed(1)}% more than them on entry`);
            }
            if (worst.score < 0) {
                Logger.warning(`   ❌ Consider removing: ${worst.shortAddress} (score: ${worst.score.toFixed(1)}, losing money)`);
            }
        }

        Logger.separator();

    } catch (error) {
        Logger.error(`[LiveComparison] Error: ${error instanceof Error ? error.message : String(error)}`);
    }
}
