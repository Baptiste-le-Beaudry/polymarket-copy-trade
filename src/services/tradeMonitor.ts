import { ENV } from '../config/env';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';

const USER_ADDRESSES = ENV.USER_ADDRESSES;
const TOO_OLD_TIMESTAMP = ENV.TOO_OLD_TIMESTAMP;
const FETCH_INTERVAL = ENV.FETCH_INTERVAL;

if (!USER_ADDRESSES || USER_ADDRESSES.length === 0) {
    throw new Error('USER_ADDRESSES is not defined or empty');
}

// Create activity and position models for each user
const userModels = USER_ADDRESSES.map((address) => ({
    address,
    UserActivity: getUserActivityModel(address),
    UserPosition: getUserPositionModel(address),
}));

const init = async () => {
    const counts: number[] = [];
    for (const { address, UserActivity } of userModels) {
        const count = await UserActivity.countDocuments();
        counts.push(count);
    }
    Logger.clearLine();
    Logger.dbConnection(USER_ADDRESSES, counts);

    // Show your own positions first
    try {
        const myPositionsUrl = `https://data-api.polymarket.com/positions?user=${ENV.PROXY_WALLET}`;
        const myPositions = await fetchData(myPositionsUrl);

        // Get current USDC balance
        const getMyBalance = (await import('../utils/getMyBalance')).default;
        const currentBalance = await getMyBalance(ENV.PROXY_WALLET);

        if (Array.isArray(myPositions) && myPositions.length > 0) {
            // Calculate your overall profitability and initial investment
            let totalValue = 0;
            let initialValue = 0;
            let weightedPnl = 0;
            myPositions.forEach((pos: any) => {
                const value = pos.currentValue || 0;
                const initial = pos.initialValue || 0;
                const pnl = pos.percentPnl || 0;
                totalValue += value;
                initialValue += initial;
                weightedPnl += value * pnl;
            });
            const myOverallPnl = totalValue > 0 ? weightedPnl / totalValue : 0;

            // Get top 5 positions by profitability (PnL)
            const myTopPositions = myPositions
                .sort((a: any, b: any) => (b.percentPnl || 0) - (a.percentPnl || 0))
                .slice(0, 5);

            Logger.clearLine();
            Logger.myPositions(
                ENV.PROXY_WALLET,
                myPositions.length,
                myTopPositions,
                myOverallPnl,
                totalValue,
                initialValue,
                currentBalance
            );
        } else {
            Logger.clearLine();
            Logger.myPositions(ENV.PROXY_WALLET, 0, [], 0, 0, 0, currentBalance);
        }
    } catch (error) {
        Logger.error(`Failed to fetch your positions: ${error}`);
    }

    // Show current positions count with details for traders you're copying
    const positionCounts: number[] = [];
    const positionDetails: any[][] = [];
    const profitabilities: number[] = [];
    for (const { address, UserPosition } of userModels) {
        const positions = await UserPosition.find().exec();
        positionCounts.push(positions.length);

        // Calculate overall profitability (weighted average by current value)
        let totalValue = 0;
        let weightedPnl = 0;
        positions.forEach((pos) => {
            const value = pos.currentValue || 0;
            const pnl = pos.percentPnl || 0;
            totalValue += value;
            weightedPnl += value * pnl;
        });
        const overallPnl = totalValue > 0 ? weightedPnl / totalValue : 0;
        profitabilities.push(overallPnl);

        // Get top 3 positions by profitability (PnL)
        const topPositions = positions
            .sort((a, b) => (b.percentPnl || 0) - (a.percentPnl || 0))
            .slice(0, 3)
            .map((p) => p.toObject());
        positionDetails.push(topPositions);
    }
    Logger.clearLine();
    Logger.tradersPositions(USER_ADDRESSES, positionCounts, positionDetails, profitabilities);
};

const fetchTradeData = async () => {
    for (const { address, UserActivity, UserPosition } of userModels) {
        try {
            // Fetch trade activities from Polymarket API
            const apiUrl = `https://data-api.polymarket.com/activity?user=${address}&type=TRADE`;
            const activities = await fetchData(apiUrl);

            if (!Array.isArray(activities) || activities.length === 0) {
                continue;
            }

            // Process each activity
            for (const activity of activities) {
                // Skip if too old (but not on first run - we want to mark all historical trades)
                if (!isFirstRun && activity.timestamp < TOO_OLD_TIMESTAMP) {
                    continue;
                }

                // Check if this trade already exists in database
                const existingActivity = await UserActivity.findOne({
                    transactionHash: activity.transactionHash,
                }).exec();

                if (existingActivity) {
                    continue; // Already processed this trade
                }

                // Save new trade to database
                const newActivity = new UserActivity({
                    proxyWallet: activity.proxyWallet,
                    timestamp: activity.timestamp,
                    conditionId: activity.conditionId,
                    type: activity.type,
                    size: activity.size,
                    usdcSize: activity.usdcSize,
                    transactionHash: activity.transactionHash,
                    price: activity.price,
                    asset: activity.asset,
                    side: activity.side,
                    outcomeIndex: activity.outcomeIndex,
                    title: activity.title,
                    slug: activity.slug,
                    icon: activity.icon,
                    eventSlug: activity.eventSlug,
                    outcome: activity.outcome,
                    name: activity.name,
                    pseudonym: activity.pseudonym,
                    bio: activity.bio,
                    profileImage: activity.profileImage,
                    profileImageOptimized: activity.profileImageOptimized,
                    bot: false,
                    botExcutedTime: 0,
                });

                await newActivity.save();
                Logger.info(`New trade detected for ${address.slice(0, 6)}...${address.slice(-4)}`);
            }

            // Also fetch and update positions
            const positionsUrl = `https://data-api.polymarket.com/positions?user=${address}`;
            const positions = await fetchData(positionsUrl);

            if (Array.isArray(positions) && positions.length > 0) {
                for (const position of positions) {
                    // Update or create position
                    await UserPosition.findOneAndUpdate(
                        { asset: position.asset, conditionId: position.conditionId },
                        {
                            proxyWallet: position.proxyWallet,
                            asset: position.asset,
                            conditionId: position.conditionId,
                            size: position.size,
                            avgPrice: position.avgPrice,
                            initialValue: position.initialValue,
                            currentValue: position.currentValue,
                            cashPnl: position.cashPnl,
                            percentPnl: position.percentPnl,
                            totalBought: position.totalBought,
                            realizedPnl: position.realizedPnl,
                            percentRealizedPnl: position.percentRealizedPnl,
                            curPrice: position.curPrice,
                            redeemable: position.redeemable,
                            mergeable: position.mergeable,
                            title: position.title,
                            slug: position.slug,
                            icon: position.icon,
                            eventSlug: position.eventSlug,
                            outcome: position.outcome,
                            outcomeIndex: position.outcomeIndex,
                            oppositeOutcome: position.oppositeOutcome,
                            oppositeAsset: position.oppositeAsset,
                            endDate: position.endDate,
                            negativeRisk: position.negativeRisk,
                        },
                        { upsert: true }
                    );
                }
            }
        } catch (error) {
            Logger.error(
                `Error fetching data for ${address.slice(0, 6)}...${address.slice(-4)}: ${error}`
            );
        }
    }
};

// Track if this is the first run
let isFirstRun = true;
// Track if monitor should continue running
let isRunning = true;
// Track last stale position check time
let lastStaleCheckTime = 0;
// Track last small position check time
let lastSmallPositionCheckTime = 0;

/**
 * Check and auto-sell positions with < 1 token
 */
const checkAndSellSmallPositions = async () => {
    const now = Date.now();
    const checkInterval = 60 * 60 * 1000; // Check every hour

    // Check if it's time to run the check
    if (now - lastSmallPositionCheckTime < checkInterval) {
        return;
    }

    lastSmallPositionCheckTime = now;

    try {
        // Get current positions from Polymarket
        const myPositionsUrl = `https://data-api.polymarket.com/positions?user=${ENV.PROXY_WALLET}`;
        const myPositions = await fetchData(myPositionsUrl);

        if (!Array.isArray(myPositions)) {
            return;
        }

        // Find positions with < 1 token
        const smallPositions = myPositions.filter((p: any) => p.size > 0 && p.size < 1.0);

        if (smallPositions.length === 0) {
            return;
        }

        Logger.warning(`⚠️  Found ${smallPositions.length} position(s) with < 1 token`);
        Logger.info('🔄 Auto-selling small positions...');

        // Skip in DRY_RUN mode
        if (ENV.DRY_RUN) {
            Logger.info('🧪 DRY_RUN mode: Would sell small positions in production');
            for (const pos of smallPositions) {
                Logger.info(`  • ${pos.title || pos.slug || pos.asset.substring(0, 12)}... | ${pos.size.toFixed(4)} tokens`);
            }
            return;
        }

        const createClobClient = (await import('../utils/createClobClient')).default;
        const clobClient = await createClobClient();
        const { Side } = await import('@polymarket/clob-client');
        const { getPositionTracker } = await import('../utils/positionTracker');
        const tracker = getPositionTracker();

        let soldCount = 0;
        let errorCount = 0;

        for (const smallPos of smallPositions) {
            try {
                // Get order book
                const orderBook = await clobClient.getOrderBook(smallPos.asset);
                if (!orderBook.bids || orderBook.bids.length === 0) {
                    Logger.warning(`No bids for ${smallPos.title || smallPos.asset.substring(0, 12)}... - skipping`);
                    errorCount++;
                    continue;
                }

                const maxPriceBid = orderBook.bids.reduce((max, bid) => {
                    return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
                }, orderBook.bids[0]);

                const sellAmount = Math.min(smallPos.size, parseFloat(maxPriceBid.size));

                const signedOrder = await clobClient.createOrder({
                    tokenID: smallPos.asset,
                    size: sellAmount,
                    price: parseFloat(maxPriceBid.price),
                    side: Side.SELL,
                    feeRateBps: 0,
                });

                const result = await clobClient.postOrder(signedOrder);

                if (result.success) {
                    Logger.success(`✅ Auto-sold small position: ${smallPos.title || smallPos.slug} (${sellAmount.toFixed(4)} tokens @ $${maxPriceBid.price})`);
                    tracker.trackSell(smallPos.conditionId, sellAmount, parseFloat(maxPriceBid.price), sellAmount * parseFloat(maxPriceBid.price));
                    soldCount++;
                } else {
                    Logger.error(`Failed to sell ${smallPos.title || smallPos.slug}`);
                    errorCount++;
                }

                // Wait between sells
                await new Promise(resolve => setTimeout(resolve, 1000));

            } catch (error) {
                Logger.error(`Error selling small position ${smallPos.title || smallPos.asset}: ${error}`);
                errorCount++;
            }
        }

        if (soldCount > 0 || errorCount > 0) {
            Logger.info(`📊 Small position cleanup: ${soldCount} sold, ${errorCount} errors`);
        }

    } catch (error) {
        Logger.error(`Error in small position check: ${error}`);
    }
};

/**
 * Check and auto-sell stale positions if enabled
 */
const checkAndSellStalePositions = async () => {
    const AUTO_SELL_DAYS = ENV.AUTO_SELL_STALE_POSITIONS_DAYS;
    
    if (!AUTO_SELL_DAYS) {
        return; // Feature disabled
    }

    const now = Date.now();
    const checkIntervalHours = ENV.STALE_POSITION_CHECK_INTERVAL_HOURS || 24;
    const checkInterval = checkIntervalHours * 60 * 60 * 1000;
    const timeSinceLastCheck = now - lastStaleCheckTime;

    // Check if it's time to run the check
    if (timeSinceLastCheck < checkInterval) {
        return;
    }

    Logger.info(`🔄 Running stale position check (interval: ${checkIntervalHours}h, looking for positions > ${AUTO_SELL_DAYS} day(s) old)...`);
    lastStaleCheckTime = now;

    try {
        // Handle simulation mode differently
        if (ENV.DRY_RUN) {
            const { getSimulationTracker } = await import('../utils/simulationBalance');
            const simTracker = getSimulationTracker();
            const allPositions = simTracker.getAllPositions();
            
            Logger.info(`📊 [SIMULATION] Checking ${allPositions.length} positions for stale (> ${AUTO_SELL_DAYS} day(s))...`);
            
            // Debug: show position ages
            for (const pos of allPositions) {
                if (!pos.openedAt) {
                    Logger.warning(`   Position ${pos.asset.slice(0, 8)}...: ⚠️ NO TIMESTAMP - marking as stale`);
                } else {
                    const ageMs = Date.now() - pos.openedAt;
                    const ageHours = (ageMs / (1000 * 60 * 60)).toFixed(1);
                    const ageDays = (ageMs / (1000 * 60 * 60 * 24)).toFixed(2);
                    Logger.info(`   Position ${pos.asset.slice(0, 8)}...: age=${ageHours}h (${ageDays}d), stale=${parseFloat(ageDays) >= AUTO_SELL_DAYS}`);
                }
            }
            
            const stalePositions = simTracker.getOldPositions(AUTO_SELL_DAYS);

            if (stalePositions.length === 0) {
                Logger.info(`✅ [SIMULATION] No stale positions found (older than ${AUTO_SELL_DAYS} day(s))`);
                return;
            }

            Logger.warning(`⚠️  [SIMULATION] Found ${stalePositions.length} stale positions (older than ${AUTO_SELL_DAYS} day(s))`);
            Logger.info('🔄 [SIMULATION] Auto-selling stale positions...');

            let soldCount = 0;
            for (const stalePos of stalePositions) {
                // In simulation, just remove the stale position
                Logger.info(`📉 [SIMULATION] Selling stale position: ${stalePos.market || stalePos.asset} (${stalePos.size?.toFixed(2) || '0'} tokens)`);
                simTracker.sellPosition(stalePos.asset, stalePos.size || 0, stalePos.avgPrice || 0);
                soldCount++;
            }

            if (soldCount > 0) {
                Logger.success(`✅ [SIMULATION] Auto-sold ${soldCount} stale positions`);
            }
            return;
        }

        // Real trading mode
        const { getPositionTracker } = await import('../utils/positionTracker');
        const tracker = getPositionTracker();
        const stalePositions = tracker.getOldPositions(AUTO_SELL_DAYS);

        if (stalePositions.length === 0) {
            Logger.info(`✅ No stale positions found (older than ${AUTO_SELL_DAYS} days)`);
            return;
        }

        Logger.warning(`⚠️  Found ${stalePositions.length} stale positions (older than ${AUTO_SELL_DAYS} days)`);
        Logger.info('🔄 Auto-selling stale positions...');

        // Get current positions from Polymarket
        const myPositionsUrl = `https://data-api.polymarket.com/positions?user=${ENV.PROXY_WALLET}`;
        const myPositions = await fetchData(myPositionsUrl);

        if (!Array.isArray(myPositions)) {
            Logger.error('Failed to fetch positions for stale check');
            return;
        }

        const createClobClient = (await import('../utils/createClobClient')).default;
        const clobClient = await createClobClient();
        const { Side } = await import('@polymarket/clob-client');

        let soldCount = 0;
        let errorCount = 0;

        for (const stalePos of stalePositions) {
            // Find matching real position
            const realPos = myPositions.find((p: any) => p.conditionId === stalePos.conditionId);
            
            if (!realPos || realPos.size < 1.0) {
                // Position too small or doesn't exist, just remove from tracker
                tracker.removePosition(stalePos.conditionId);
                continue;
            }

            try {
                // Get order book
                const orderBook = await clobClient.getOrderBook(stalePos.asset);
                if (!orderBook.bids || orderBook.bids.length === 0) {
                    Logger.warning(`No bids for ${stalePos.market} - skipping`);
                    continue;
                }

                const maxPriceBid = orderBook.bids.reduce((max, bid) => {
                    return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
                }, orderBook.bids[0]);

                const sellAmount = Math.min(realPos.size, parseFloat(maxPriceBid.size));

                const signedOrder = await clobClient.createOrder({
                    tokenID: stalePos.asset,
                    size: sellAmount,
                    price: parseFloat(maxPriceBid.price),
                    side: Side.SELL,
                    feeRateBps: 0,
                });

                const result = await clobClient.postOrder(signedOrder);

                if (result.success) {
                    Logger.success(`✅ Auto-sold stale position: ${stalePos.market} (${sellAmount.toFixed(2)} tokens)`);
                    tracker.trackSell(stalePos.conditionId, sellAmount, parseFloat(maxPriceBid.price), sellAmount * parseFloat(maxPriceBid.price));
                    soldCount++;
                } else {
                    Logger.error(`Failed to sell ${stalePos.market}`);
                    errorCount++;
                }

                // Wait between sells
                await new Promise(resolve => setTimeout(resolve, 1000));

            } catch (error) {
                Logger.error(`Error selling stale position ${stalePos.market}: ${error}`);
                errorCount++;
            }
        }

        if (soldCount > 0 || errorCount > 0) {
            Logger.info(`📊 Stale position cleanup: ${soldCount} sold, ${errorCount} errors`);
        }

    } catch (error) {
        Logger.error(`Error in stale position check: ${error}`);
    }
};

/**
 * Stop the trade monitor gracefully
 */
export const stopTradeMonitor = () => {
    isRunning = false;
    Logger.info('Trade monitor shutdown requested...');
};

const tradeMonitor = async () => {
    await init();
    Logger.success(`Monitoring ${USER_ADDRESSES.length} trader(s) every ${FETCH_INTERVAL}s`);
    Logger.separator();

    // On first run, mark all existing historical trades as already processed
    if (isFirstRun) {
        Logger.info('First run: marking all historical trades as processed...');
        for (const { address, UserActivity } of userModels) {
            const count = await UserActivity.updateMany(
                { bot: false },
                { $set: { bot: true, botExcutedTime: 999 } }
            );
            if (count.modifiedCount > 0) {
                Logger.info(
                    `Marked ${count.modifiedCount} historical trades as processed for ${address.slice(0, 6)}...${address.slice(-4)}`
                );
            }
        }
        isFirstRun = false;
        Logger.success('\nHistorical trades processed. Now monitoring for new trades only.');
        Logger.separator();
    }

    while (isRunning) {
        await fetchTradeData();
        
        // Check for stale positions if enabled
        await checkAndSellStalePositions();
        
        // Check for small positions (< 1 token) and auto-sell
        await checkAndSellSmallPositions();
        
        if (!isRunning) break;
        await new Promise((resolve) => setTimeout(resolve, FETCH_INTERVAL * 1000));
    }

    Logger.info('Trade monitor stopped');
};

export default tradeMonitor;
