import { ClobClient } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';
import getMyBalance from '../utils/getMyBalance';
import postOrder from '../utils/postOrder';
import Logger from '../utils/logger';
import { getTraderCooldownManager } from '../utils/traderCooldown';
import { shouldCopyTrade } from '../utils/traderFilter';
import { getSimulationTracker } from '../utils/simulationBalance';

const USER_ADDRESSES = ENV.USER_ADDRESSES;
const RETRY_LIMIT = ENV.RETRY_LIMIT;
const PROXY_WALLET = ENV.PROXY_WALLET;
const TOO_OLD_TIMESTAMP_HOURS = ENV.TOO_OLD_TIMESTAMP;
const TRADE_AGGREGATION_ENABLED = ENV.TRADE_AGGREGATION_ENABLED;
const TRADE_AGGREGATION_WINDOW_SECONDS = ENV.TRADE_AGGREGATION_WINDOW_SECONDS;
const TRADE_AGGREGATION_MIN_TOTAL_USD = 1.0; // Polymarket minimum
const TRADER_COOLDOWN_ENABLED = ENV.TRADER_COOLDOWN_ENABLED;
const TRADER_COOLDOWN_SECONDS = ENV.TRADER_COOLDOWN_SECONDS;

// Initialize trader cooldown manager if enabled
const traderCooldown = TRADER_COOLDOWN_ENABLED 
    ? getTraderCooldownManager(TRADER_COOLDOWN_SECONDS)
    : null;

// Create activity models for each user
const userActivityModels = USER_ADDRESSES.map((address) => ({
    address,
    model: getUserActivityModel(address),
}));

interface TradeWithUser extends UserActivityInterface {
    userAddress: string;
}

interface AggregatedTrade {
    userAddress: string;
    conditionId: string;
    asset: string;
    side: string;
    slug?: string;
    eventSlug?: string;
    trades: TradeWithUser[];
    totalUsdcSize: number;
    averagePrice: number;
    firstTradeTime: number;
    lastTradeTime: number;
}

// Buffer for aggregating trades
const tradeAggregationBuffer: Map<string, AggregatedTrade> = new Map();

// Position cache to avoid duplicate API requests
interface PositionCache {
    positions: UserPositionInterface[];
    timestamp: number;
}
const positionCache: Map<string, PositionCache> = new Map();
const POSITION_CACHE_TTL_MS = 30000; // 30 seconds

// Mutex to prevent race condition on position count check
let positionCheckLock = false;
const acquirePositionLock = async (): Promise<void> => {
    while (positionCheckLock) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    positionCheckLock = true;
};
const releasePositionLock = (): void => {
    positionCheckLock = false;
};

/**
 * Get trader positions with caching
 */
const getCachedPositions = async (userAddress: string): Promise<UserPositionInterface[]> => {
    const now = Date.now();
    const cached = positionCache.get(userAddress);
    
    // Return cached if still valid
    if (cached && (now - cached.timestamp) < POSITION_CACHE_TTL_MS) {
        return cached.positions;
    }
    
    // Clean old cache entries (keep cache size manageable)
    if (positionCache.size > 100) {
        const entriesToDelete: string[] = [];
        for (const [key, value] of positionCache.entries()) {
            if (now - value.timestamp > POSITION_CACHE_TTL_MS) {
                entriesToDelete.push(key);
            }
        }
        entriesToDelete.forEach(key => positionCache.delete(key));
    }
    
    // Fetch fresh data
    const positions: UserPositionInterface[] = await fetchData(
        `https://data-api.polymarket.com/positions?user=${userAddress}`
    );
    
    // Update cache
    positionCache.set(userAddress, {
        positions,
        timestamp: now,
    });
    
    return positions;
};

const readTempTrades = async (): Promise<TradeWithUser[]> => {
    const allTrades: TradeWithUser[] = [];

    for (const { address, model } of userActivityModels) {
        // Only get trades that haven't been processed yet (bot: false AND botExcutedTime: 0)
        // This prevents processing the same trade multiple times
        const trades = await model
            .find({
                $and: [{ type: 'TRADE' }, { bot: false }, { botExcutedTime: 0 }],
            })
            .exec();

        const tradesWithUser = trades.map((trade) => ({
            ...(trade.toObject() as UserActivityInterface),
            userAddress: address,
        }));

        allTrades.push(...tradesWithUser);
    }

    return allTrades;
};

/**
 * Generate a unique key for trade aggregation based on user, market, side
 */
const getAggregationKey = (trade: TradeWithUser): string => {
    return `${trade.userAddress}:${trade.conditionId}:${trade.asset}:${trade.side}`;
};

/**
 * Add trade to aggregation buffer or update existing aggregation
 */
const addToAggregationBuffer = (trade: TradeWithUser): void => {
    const key = getAggregationKey(trade);
    const existing = tradeAggregationBuffer.get(key);
    const now = Date.now();

    if (existing) {
        // Update existing aggregation
        existing.trades.push(trade);
        existing.totalUsdcSize += trade.usdcSize;
        // Recalculate weighted average price
        const totalValue = existing.trades.reduce((sum, t) => sum + t.usdcSize * t.price, 0);
        existing.averagePrice = totalValue / existing.totalUsdcSize;
        existing.lastTradeTime = now;
    } else {
        // Create new aggregation
        tradeAggregationBuffer.set(key, {
            userAddress: trade.userAddress,
            conditionId: trade.conditionId,
            asset: trade.asset,
            side: trade.side || 'BUY',
            slug: trade.slug,
            eventSlug: trade.eventSlug,
            trades: [trade],
            totalUsdcSize: trade.usdcSize,
            averagePrice: trade.price,
            firstTradeTime: now,
            lastTradeTime: now,
        });
    }
};

/**
 * Check buffer and return ready aggregated trades
 * Trades are ready if:
 * 1. Total size >= minimum AND
 * 2. Time window has passed since first trade
 */
const getReadyAggregatedTrades = (): AggregatedTrade[] => {
    const ready: AggregatedTrade[] = [];
    const now = Date.now();
    const windowMs = TRADE_AGGREGATION_WINDOW_SECONDS * 1000;

    for (const [key, agg] of tradeAggregationBuffer.entries()) {
        const timeElapsed = now - agg.firstTradeTime;

        // Check if aggregation is ready
        if (timeElapsed >= windowMs) {
            if (agg.totalUsdcSize >= TRADE_AGGREGATION_MIN_TOTAL_USD) {
                // Aggregation meets minimum and window passed - ready to execute
                ready.push(agg);
            } else {
                // Window passed but total too small - mark individual trades as skipped
                Logger.info(
                    `Trade aggregation for ${agg.userAddress} on ${agg.slug || agg.asset}: $${agg.totalUsdcSize.toFixed(2)} total from ${agg.trades.length} trades below minimum ($${TRADE_AGGREGATION_MIN_TOTAL_USD}) - skipping`
                );

                // Mark all trades in this aggregation as processed (bot: true)
                for (const trade of agg.trades) {
                    const UserActivity = getUserActivityModel(trade.userAddress);
                    UserActivity.updateOne({ _id: trade._id }, { bot: true }).exec();
                }
            }
            // Remove from buffer either way
            tradeAggregationBuffer.delete(key);
        }
    }

    return ready;
};

const doTrading = async (clobClient: ClobClient, trades: TradeWithUser[]) => {
    let skippedSellCount = 0;
    for (const trade of trades) {
        // Reject trades that are too old (secondary protection — primary is in tradeMonitor)
        // trade.timestamp is Unix seconds; TOO_OLD_TIMESTAMP_HOURS is in hours
        const cutoffTimestamp = Math.floor(Date.now() / 1000) - TOO_OLD_TIMESTAMP_HOURS * 3600;
        if (trade.timestamp < cutoffTimestamp) {
            const ageHours = ((Date.now() / 1000 - trade.timestamp) / 3600).toFixed(1);
            Logger.warning(
                `⛔ Skipping stale trade (${ageHours}h old, limit: ${TOO_OLD_TIMESTAMP_HOURS}h): ${trade.title || trade.slug || trade.asset.substring(0, 12)}...`
            );
            const UserActivity = getUserActivityModel(trade.userAddress);
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            Logger.separator();
            continue;
        }

        // Filtre précoce DRY_RUN : ignorer les SELL sans position virtuelle
        // Évite le flood de logs quand un trader liquide des positions que le bot n'a jamais copiées
        if (trade.side === 'SELL' && ENV.DRY_RUN) {
            const simTracker = getSimulationTracker();
            if (!simTracker.getPosition(trade.asset)) {
                const UserActivity = getUserActivityModel(trade.userAddress);
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                skippedSellCount++;
                continue;
            }
        }

        // Check trader cooldown if enabled (per trader per market) — BUY only
        // SELL trades always bypass cooldown: if a trader exits a position, we follow immediately
        if (TRADER_COOLDOWN_ENABLED && traderCooldown && trade.side === 'BUY') {
            if (!traderCooldown.shouldCopyTrade(trade.userAddress, trade.conditionId)) {
                // Trader in cooldown for THIS MARKET - skip this BUY
                const UserActivity = getUserActivityModel(trade.userAddress);
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                Logger.separator();
                continue;
            }
        }

        // Fetch trader positions for filtering (with cache)
        const user_positions: UserPositionInterface[] = await getCachedPositions(trade.userAddress);

        // Check if market is still active (not resolved/closed)
        const userPosition = user_positions.find(
            (p: UserPositionInterface) => p.conditionId === trade.conditionId
        );
        
        if (userPosition && userPosition.redeemable) {
            Logger.warning(
                `⛔ Skipping trade - Market already resolved: ${trade.title || trade.slug || trade.asset.substring(0, 12)}...`
            );
            const UserActivity = getUserActivityModel(trade.userAddress);
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            Logger.separator();
            continue;
        }

        // CRITICAL: For BUY trades, verify trader STILL HOLDS this position
        // This prevents copying historical BUY trades where the trader has already exited
        if (trade.side === 'BUY') {
            const traderHasPosition = user_positions.some(
                (p: UserPositionInterface) =>
                    p.conditionId === trade.conditionId &&
                    p.asset === trade.asset &&
                    p.size > 0
            );

            if (!traderHasPosition) {
                Logger.warning(
                    `⛔ Skipping BUY - Trader no longer holds this position (likely already sold): ${trade.title || trade.slug || trade.asset.substring(0, 12)}...`
                );
                Logger.warning(
                    `   This prevents copying historical trades where trader bought low and already sold high`
                );
                const UserActivity = getUserActivityModel(trade.userAddress);
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                Logger.separator();
                continue;
            }

            // Log trader's current position size for transparency
            const traderPos = user_positions.find(
                (p: UserPositionInterface) => p.conditionId === trade.conditionId && p.asset === trade.asset
            );
            if (traderPos) {
                Logger.info(
                    `✅ Verified: Trader holds ${traderPos.size.toFixed(2)} tokens @ $${traderPos.avgPrice.toFixed(4)} avg (current value: $${(traderPos.currentValue || 0).toFixed(2)})`
                );
            }
        }
        
        // Check if trader and market meet filtering criteria
        if (ENV.MIN_TRADER_WIN_RATE > 0 || ENV.MIN_TRADER_AVG_POSITION_SIZE > 0) {
            const filterResult = await shouldCopyTrade(
                trade.userAddress,
                user_positions,
                trade.asset
            );

            if (!filterResult.shouldCopy) {
                Logger.warning(
                    `⛔ Skipping trade from ${trade.userAddress.substring(0, 10)}... - ${filterResult.reason}`
                );
                const UserActivity = getUserActivityModel(trade.userAddress);
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                Logger.separator();
                continue;
            }
        }

        // Log copy delay: how long since the trader made this trade
        const nowSec = Math.floor(Date.now() / 1000);
        const delaySec = nowSec - trade.timestamp;
        const delayStr = delaySec < 60
            ? `${delaySec}s`
            : `${Math.floor(delaySec / 60)}m${(delaySec % 60).toString().padStart(2, '0')}s`;
        const delayEmoji = delaySec < 30 ? '⚡' : delaySec < 90 ? '⏱' : '🐌';
        const traderTime = new Date(trade.timestamp * 1000).toLocaleTimeString();
        Logger.info(`${delayEmoji} Copy delay: ${delayStr} (trader executed at ${traderTime})`);

        // Mark trade as being processed immediately to prevent duplicate processing
        // Save executedAt (Unix ms) for quality report analysis
        const UserActivity = getUserActivityModel(trade.userAddress);
        await UserActivity.updateOne({ _id: trade._id }, { $set: { botExcutedTime: 1, executedAt: Date.now() } });

        Logger.trade(trade.userAddress, trade.side || 'UNKNOWN', {
            asset: trade.asset,
            side: trade.side,
            amount: trade.usdcSize,
            price: trade.price,
            slug: trade.slug,
            eventSlug: trade.eventSlug,
            transactionHash: trade.transactionHash,
        });

        const my_positions: UserPositionInterface[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`
        );
        
        const my_position = my_positions.find(
            (position: UserPositionInterface) => position.conditionId === trade.conditionId
        );
        const user_position = user_positions.find(
            (position: UserPositionInterface) => position.conditionId === trade.conditionId
        );

        // Get USDC balance
        const my_balance = await getMyBalance(PROXY_WALLET);

        // Calculate trader's total portfolio value from positions
        const user_balance = user_positions.reduce((total, pos) => {
            return total + (pos.currentValue || 0);
        }, 0);

        Logger.balance(my_balance, user_balance, trade.userAddress);

        // Execute the trade
        await postOrder(
            clobClient,
            trade.side === 'BUY' ? 'buy' : 'sell',
            my_position,
            user_position,
            trade,
            my_balance,
            user_balance,
            trade.userAddress
        );

        // 1s après l'achat du trader : affiche le prix actuel du marché
        if (trade.side === 'BUY') {
            await new Promise(resolve => setTimeout(resolve, 1000));
            try {
                const bookData = await fetchData(
                    `https://clob.polymarket.com/book?token_id=${trade.asset}`
                ) as { bids: Array<{ price: string }>; asks: Array<{ price: string }> };
                if (bookData?.bids?.[0] && bookData?.asks?.[0]) {
                    const bid = parseFloat(bookData.bids[0].price);
                    const ask = parseFloat(bookData.asks[0].price);
                    const mid = (bid + ask) / 2;
                    const diff = mid - trade.price;
                    const pct = ((diff / trade.price) * 100).toFixed(1);
                    const arrow = diff >= 0 ? '📈' : '📉';
                    const sign = diff >= 0 ? '+' : '';
                    Logger.info(
                        `${arrow} Prix 1s après achat: bid $${bid.toFixed(4)} / ask $${ask.toFixed(4)} (mid $${mid.toFixed(4)}, ${sign}${pct}% vs trader $${trade.price.toFixed(4)})`
                    );
                }
            } catch {
                // Non-bloquant — info supplémentaire seulement
            }
        }

        Logger.separator();
    }

    if (skippedSellCount > 0) {
        Logger.info(`⏭ ${skippedSellCount} SELL ignoré(s) — pas de position virtuelle (trader liquide des positions non copiées)`);
    }
};

/**
 * Execute aggregated trades
 */
const doAggregatedTrading = async (clobClient: ClobClient, aggregatedTrades: AggregatedTrade[]) => {
    for (const agg of aggregatedTrades) {
        Logger.header(`📊 AGGREGATED TRADE (${agg.trades.length} trades combined)`);
        Logger.info(`Market: ${agg.slug || agg.asset}`);
        Logger.info(`Side: ${agg.side}`);
        Logger.info(`Total volume: $${agg.totalUsdcSize.toFixed(2)}`);
        Logger.info(`Average price: $${agg.averagePrice.toFixed(4)}`);

        // Fetch trader positions for filtering (with cache)
        const user_positions: UserPositionInterface[] = await getCachedPositions(agg.userAddress);

        // Check if market is still active (not resolved/closed)
        const userPosition = user_positions.find(
            (p: UserPositionInterface) => p.conditionId === agg.conditionId
        );
        
        if (userPosition && userPosition.redeemable) {
            Logger.warning(
                `⛔ Skipping aggregated trade - Market already resolved: ${agg.slug || agg.asset.substring(0, 12)}...`
            );
            for (const trade of agg.trades) {
                const UserActivity = getUserActivityModel(trade.userAddress);
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            }
            Logger.separator();
            continue;
        }

        // Check if trader and market meet filtering criteria
        if (ENV.MIN_TRADER_WIN_RATE > 0 || ENV.MIN_TRADER_AVG_POSITION_SIZE > 0) {
            const filterResult = await shouldCopyTrade(
                agg.userAddress,
                user_positions,
                agg.asset
            );

            if (!filterResult.shouldCopy) {
                Logger.warning(
                    `⛔ Skipping aggregated trade from ${agg.userAddress.substring(0, 10)}... - ${filterResult.reason}`
                );
                // Mark all trades as processed
                for (const trade of agg.trades) {
                    const UserActivity = getUserActivityModel(trade.userAddress);
                    await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                }
                Logger.separator();
                continue;
            }
        }

        // Mark all individual trades as being processed
        for (const trade of agg.trades) {
            const UserActivity = getUserActivityModel(trade.userAddress);
            await UserActivity.updateOne({ _id: trade._id }, { $set: { botExcutedTime: 1 } });
        }

        const my_positions: UserPositionInterface[] = await getCachedPositions(PROXY_WALLET);
        const my_position = my_positions.find(
            (position: UserPositionInterface) => position.conditionId === agg.conditionId
        );
        const user_position = user_positions.find(
            (position: UserPositionInterface) => position.conditionId === agg.conditionId
        );

        // Get USDC balance
        const my_balance = await getMyBalance(PROXY_WALLET);

        // Calculate trader's total portfolio value from positions
        const user_balance = user_positions.reduce((total, pos) => {
            return total + (pos.currentValue || 0);
        }, 0);

        Logger.balance(my_balance, user_balance, agg.userAddress);

        // Create a synthetic trade object for postOrder using aggregated values
        const syntheticTrade: UserActivityInterface = {
            ...agg.trades[0], // Use first trade as template
            usdcSize: agg.totalUsdcSize,
            price: agg.averagePrice,
            side: agg.side as 'BUY' | 'SELL',
        };

        // Execute the aggregated trade
        await postOrder(
            clobClient,
            agg.side === 'BUY' ? 'buy' : 'sell',
            my_position,
            user_position,
            syntheticTrade,
            my_balance,
            user_balance,
            agg.userAddress
        );

        Logger.separator();
    }
};

// Track if executor should continue running
let isRunning = true;

/**
 * Stop the trade executor gracefully
 */
export const stopTradeExecutor = () => {
    isRunning = false;
    Logger.info('Trade executor shutdown requested...');
};

const tradeExecutor = async (clobClient: ClobClient) => {
    Logger.success(`Trade executor ready for ${USER_ADDRESSES.length} trader(s)`);
    if (TRADE_AGGREGATION_ENABLED) {
        Logger.info(
            `Trade aggregation enabled: ${TRADE_AGGREGATION_WINDOW_SECONDS}s window, $${TRADE_AGGREGATION_MIN_TOTAL_USD} minimum`
        );
    }

    let lastCheck = Date.now();
    let lastTradeCount = 0; // Track number of trades seen to detect new ones
    
    while (isRunning) {
        const trades = await readTempTrades();

        if (TRADE_AGGREGATION_ENABLED) {
            // Only log if we have NEW trades (not same ones as last loop)
            const hasNewTrades = trades.length > 0 && trades.length !== lastTradeCount;
            lastTradeCount = trades.length;
            
            // Process with aggregation logic
            if (hasNewTrades) {
                Logger.clearLine();
                Logger.info(
                    `📥 ${trades.length} new trade${trades.length > 1 ? 's' : ''} detected`
                );

                // Group trades by market for compact logging
                const tradesByMarket = new Map<string, { count: number; totalValue: number; side: string }>();
                let immediateTradesCount = 0;

                // Add trades to aggregation buffer
                for (const trade of trades) {
                    // Only aggregate BUY trades below minimum threshold
                    if (trade.side === 'BUY' && trade.usdcSize < TRADE_AGGREGATION_MIN_TOTAL_USD) {
                        const marketKey = trade.slug || trade.asset.substring(0, 12);
                        const existing = tradesByMarket.get(marketKey);
                        if (existing) {
                            existing.count++;
                            existing.totalValue += trade.usdcSize;
                        } else {
                            tradesByMarket.set(marketKey, {
                                count: 1,
                                totalValue: trade.usdcSize,
                                side: trade.side || 'BUY',
                            });
                        }
                        addToAggregationBuffer(trade);
                    } else {
                        // Execute large trades immediately (not aggregated)
                        immediateTradesCount++;
                        Logger.clearLine();
                        Logger.header(`⚡ IMMEDIATE TRADE (above threshold)`);
                        await doTrading(clobClient, [trade]);
                    }
                }

                // Display aggregated logs (one line per market)
                if (tradesByMarket.size > 0) {
                    for (const [market, stats] of tradesByMarket.entries()) {
                        Logger.info(
                            `📊 ${stats.count}x ${stats.side} ($${stats.totalValue.toFixed(2)} total) → ${market}`
                        );
                    }
                }

                lastCheck = Date.now();
            }

            // Check for ready aggregated trades
            const readyAggregations = getReadyAggregatedTrades();
            if (readyAggregations.length > 0) {
                Logger.clearLine();
                Logger.header(
                    `⚡ ${readyAggregations.length} AGGREGATED TRADE${readyAggregations.length > 1 ? 'S' : ''} READY`
                );
                await doAggregatedTrading(clobClient, readyAggregations);
                lastCheck = Date.now();
            }

            // Update waiting message
            if (trades.length === 0 && readyAggregations.length === 0) {
                if (Date.now() - lastCheck > 2000) {
                    const bufferedCount = tradeAggregationBuffer.size;
                    if (bufferedCount > 0) {
                        Logger.waiting(
                            USER_ADDRESSES.length,
                            `${bufferedCount} trade group(s) pending`
                        );
                    } else {
                        Logger.waiting(USER_ADDRESSES.length);
                    }
                    lastCheck = Date.now();
                }
            }
        } else {
            // Original non-aggregation logic
            if (trades.length > 0) {
                Logger.clearLine();
                Logger.header(
                    `⚡ ${trades.length} NEW TRADE${trades.length > 1 ? 'S' : ''} TO COPY`
                );
                await doTrading(clobClient, trades);
                lastCheck = Date.now();
            } else {
                // Update waiting message every 2s (moins de bruit dans le terminal)
                if (Date.now() - lastCheck > 2000) {
                    Logger.waiting(USER_ADDRESSES.length);
                    lastCheck = Date.now();
                }
            }
        }

        if (!isRunning) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
    }

    Logger.info('Trade executor stopped');
};

export default tradeExecutor;
