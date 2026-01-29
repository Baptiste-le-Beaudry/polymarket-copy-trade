/**
 * Trader filtering utilities
 * Filters traders based on performance metrics
 */

import { ENV } from '../config/env';
import Logger from './logger';

export interface TraderStats {
    address: string;
    winRate: number;
    avgPositionSize: number;
    totalTrades: number;
    totalVolume: number;
    profitLoss: number;
}

export interface MarketStats {
    marketId: string;
    dailyVolume: number;
    liquidity: number;
    activePlayers: number;
}

/**
 * Check if trader meets minimum performance criteria
 */
export function isTraderQualified(stats: TraderStats): { qualified: boolean; reason?: string } {
    // Check win rate
    if (ENV.MIN_TRADER_WIN_RATE > 0 && stats.winRate < ENV.MIN_TRADER_WIN_RATE) {
        return {
            qualified: false,
            reason: `Win rate ${(stats.winRate * 100).toFixed(1)}% < minimum ${(ENV.MIN_TRADER_WIN_RATE * 100).toFixed(1)}%`,
        };
    }

    // Check average position size
    if (ENV.MIN_TRADER_AVG_POSITION_SIZE > 0 && stats.avgPositionSize < ENV.MIN_TRADER_AVG_POSITION_SIZE) {
        return {
            qualified: false,
            reason: `Avg position $${stats.avgPositionSize.toFixed(2)} < minimum $${ENV.MIN_TRADER_AVG_POSITION_SIZE.toFixed(2)}`,
        };
    }

    // Require minimum number of trades for statistical significance
    if (stats.totalTrades < 10) {
        return {
            qualified: false,
            reason: `Only ${stats.totalTrades} trades (need at least 10 for reliability)`,
        };
    }

    return { qualified: true };
}

/**
 * Check if market meets minimum criteria
 */
export function isMarketQualified(stats: MarketStats): { qualified: boolean; reason?: string } {
    // Check daily volume
    if (ENV.MIN_MARKET_DAILY_VOLUME > 0 && stats.dailyVolume < ENV.MIN_MARKET_DAILY_VOLUME) {
        return {
            qualified: false,
            reason: `Daily volume $${stats.dailyVolume.toFixed(0)} < minimum $${ENV.MIN_MARKET_DAILY_VOLUME.toFixed(0)}`,
        };
    }

    return { qualified: true };
}

/**
 * Calculate trader statistics from positions history
 */
export function calculateTraderStats(positions: any[]): TraderStats {
    if (!positions || positions.length === 0) {
        return {
            address: '',
            winRate: 0,
            avgPositionSize: 0,
            totalTrades: 0,
            totalVolume: 0,
            profitLoss: 0,
        };
    }

    const address = positions[0]?.userAddress || '';
    let totalPositionSize = 0;
    let totalVolume = 0;
    let profitLoss = 0;
    let closedPositions = 0;
    let winningPositions = 0;

    for (const pos of positions) {
        const posSize = Math.abs(pos.initialValue || 0);
        totalPositionSize += posSize;
        totalVolume += posSize;

        // Check if position is closed (has final PnL)
        if (pos.outcomeIndex !== undefined && pos.pnl !== undefined) {
            closedPositions++;
            profitLoss += pos.pnl;
            if (pos.pnl > 0) {
                winningPositions++;
            }
        }
    }

    const winRate = closedPositions > 0 ? winningPositions / closedPositions : 0;
    const avgPositionSize = positions.length > 0 ? totalPositionSize / positions.length : 0;

    return {
        address,
        winRate,
        avgPositionSize,
        totalTrades: positions.length,
        totalVolume,
        profitLoss,
    };
}

/**
 * Filter trade based on trader performance and market criteria
 * Returns true if trade should be copied, false if it should be skipped
 */
export async function shouldCopyTrade(
    traderAddress: string,
    traderPositions: any[],
    marketId: string,
    marketStats?: MarketStats
): Promise<{ shouldCopy: boolean; reason?: string }> {
    // Calculate trader stats
    const traderStats = calculateTraderStats(traderPositions);
    traderStats.address = traderAddress;

    // Check trader qualification
    const traderCheck = isTraderQualified(traderStats);
    if (!traderCheck.qualified) {
        Logger.warning(`⛔ Trader ${traderAddress.substring(0, 10)}... rejected: ${traderCheck.reason}`);
        return { shouldCopy: false, reason: `Trader: ${traderCheck.reason}` };
    }

    // Check market qualification if stats provided
    if (marketStats) {
        const marketCheck = isMarketQualified(marketStats);
        if (!marketCheck.qualified) {
            Logger.warning(`⛔ Market ${marketId.substring(0, 10)}... rejected: ${marketCheck.reason}`);
            return { shouldCopy: false, reason: `Market: ${marketCheck.reason}` };
        }
    }

    return { shouldCopy: true };
}

export default {
    isTraderQualified,
    isMarketQualified,
    calculateTraderStats,
    shouldCopyTrade,
};
