import { ENV } from '../config/env';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';
import { AssetType, Side, OrderType } from '@polymarket/clob-client';

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

/**
 * Traite les données d'un seul trader (activités + positions).
 * Appelé en parallèle pour accélérer le cycle de fetch.
 */
const processOneTrader = async (
    address: string,
    UserActivity: ReturnType<typeof getUserActivityModel>,
    UserPosition: ReturnType<typeof getUserPositionModel>
): Promise<void> => {
    // Fetch trade activities from Polymarket API
    const apiUrl = `https://data-api.polymarket.com/activity?user=${address}&type=TRADE`;
    const activities = await fetchData(apiUrl);

    if (Array.isArray(activities) && activities.length > 0) {
        // Process each activity
        for (const activity of activities) {
            // Skip if too old (but not on first run - we want to mark all historical trades)
            // TOO_OLD_TIMESTAMP is in hours; activity.timestamp is Unix seconds
            const cutoffTimestamp = Math.floor(Date.now() / 1000) - TOO_OLD_TIMESTAMP * 3600;
            if (!isFirstRun && activity.timestamp < cutoffTimestamp) {
                continue;
            }

            // Check if this trade already exists in database
            const existingActivity = await UserActivity.findOne({
                transactionHash: activity.transactionHash,
            }).exec();

            if (existingActivity) {
                continue; // Already processed this trade
            }

            // Save new trade to database.
            // During first run: mark immediately as processed (bot: true) to avoid
            // the race condition where tradeExecutor picks them up before updateMany runs.
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
                bot: isFirstRun,             // true during init = already processed
                botExcutedTime: isFirstRun ? 999 : 0,
            });

            await newActivity.save();
            // Note: le log "New trade detected" est volontairement supprimé ici.
            // L'executor affiche déjà "⚡ N NEW TRADES TO COPY" avec tous les détails.
        }
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
};

/**
 * Fetch data for all traders in parallel batches.
 * Anciennement séquentiel (63 × ~300ms = ~19s), maintenant ~2-3s avec batches de 8.
 */
const FETCH_BATCH_SIZE = 8;      // traders traités en parallèle par batch
const FETCH_BATCH_DELAY_MS = 150; // délai entre batches pour éviter le rate limit

const fetchTradeData = async () => {
    const startTime = Date.now();

    for (let i = 0; i < userModels.length; i += FETCH_BATCH_SIZE) {
        const batch = userModels.slice(i, i + FETCH_BATCH_SIZE);

        // Tous les traders du batch en parallèle
        const results = await Promise.allSettled(
            batch.map(({ address, UserActivity, UserPosition }) =>
                processOneTrader(address, UserActivity, UserPosition)
            )
        );

        // Log les éventuelles erreurs par trader
        for (let j = 0; j < results.length; j++) {
            const result = results[j];
            if (result.status === 'rejected') {
                const addr = batch[j].address;
                Logger.error(
                    `Error fetching data for ${addr.slice(0, 6)}...${addr.slice(-4)}: ${result.reason}`
                );
            }
        }

        // Délai entre batches (sauf après le dernier)
        if (i + FETCH_BATCH_SIZE < userModels.length) {
            await new Promise(resolve => setTimeout(resolve, FETCH_BATCH_DELAY_MS));
        }
    }

    // Log le temps de cycle (seulement si > 3s pour ne pas spammer)
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (!isFirstRun && parseFloat(elapsed) > 3) {
        Logger.info(`⏱ Fetch cycle: ${elapsed}s (${userModels.length} traders, batches de ${FETCH_BATCH_SIZE})`);
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
// Track last expiring position check time
let lastExpiringCheckTime = 0;

/**
 * Check and auto-sell positions that are expiring soon (1 day before market close)
 */
const checkAndSellExpiringPositions = async () => {
    const now = Date.now();
    const checkInterval = 6 * 60 * 60 * 1000; // Check every 6 hours
    
    if (lastExpiringCheckTime > 0 && (now - lastExpiringCheckTime) < checkInterval) {
        return;
    }
    
    lastExpiringCheckTime = now;
    
    Logger.separator();
    Logger.info('📅 EXPIRING POSITIONS CHECK (selling 1 day before market close)');
    
    try {
        // Get current positions from Polymarket
        const myPositionsUrl = `https://data-api.polymarket.com/positions?user=${ENV.PROXY_WALLET}`;
        const myPositions = await fetchData(myPositionsUrl);
        
        if (!Array.isArray(myPositions) || myPositions.length === 0) {
            Logger.info('📦 No positions to check');
            return;
        }
        
        // Filter for active positions with endDate
        const activePositions = myPositions.filter((pos: any) => 
            parseFloat(pos.size) > 0 && pos.endDate
        );
        
        if (activePositions.length === 0) {
            Logger.info('✅ No positions with end dates');
            return;
        }
        
        // Find positions expiring within 24 hours
        const oneDayFromNow = now + (24 * 60 * 60 * 1000);
        const expiringPositions = activePositions.filter((pos: any) => {
            const endDate = new Date(pos.endDate).getTime();
            return endDate <= oneDayFromNow && endDate > now; // Expires within 24h but not already expired
        });
        
        if (expiringPositions.length === 0) {
            Logger.info('✅ No positions expiring in the next 24 hours');
            return;
        }
        
        Logger.warning(`⚠️ Found ${expiringPositions.length} position(s) expiring within 24 hours!`);
        
        // In DRY_RUN mode, just log what would happen
        if (ENV.DRY_RUN) {
            for (const pos of expiringPositions) {
                const endDate = new Date(pos.endDate);
                const hoursUntilClose = ((endDate.getTime() - now) / (1000 * 60 * 60)).toFixed(1);
                Logger.warning(`   📉 [SIMULATION] Would sell: ${pos.title || pos.market}`);
                Logger.warning(`      Size: ${parseFloat(pos.size).toFixed(2)} tokens | Closes in: ${hoursUntilClose}h (${endDate.toLocaleDateString()})`);
            }
            return;
        }
        
        // Real trading mode - sell the positions
        const createClobClient = (await import('../utils/createClobClient')).default;
        const clobClient = await createClobClient();
        
        let soldCount = 0;
        let errorCount = 0;
        
        for (const pos of expiringPositions) {
            const endDate = new Date(pos.endDate);
            const hoursUntilClose = ((endDate.getTime() - now) / (1000 * 60 * 60)).toFixed(1);
            const size = parseFloat(pos.size);
            
            Logger.warning(`📉 Selling expiring position: ${pos.title || pos.market}`);
            Logger.info(`   Size: ${size.toFixed(2)} tokens | Closes in: ${hoursUntilClose}h (${endDate.toLocaleDateString()})`);
            
            try {
                // Sync cache before selling
                await clobClient.updateBalanceAllowance({
                    asset_type: AssetType.CONDITIONAL,
                    token_id: pos.asset,
                });
                await new Promise(resolve => setTimeout(resolve, 300));
                
                // Use market order to sell everything
                const orderResult = await clobClient.createMarketOrder({
                    tokenID: pos.asset,
                    amount: size,
                    side: Side.SELL,
                });
                
                if (orderResult && !orderResult.errorMsg) {
                    Logger.success(`✅ Sold expiring position: ${pos.title || pos.market}`);
                    soldCount++;
                    
                    // Update position tracker
                    const { getPositionTracker } = await import('../utils/positionTracker');
                    const tracker = getPositionTracker();
                    const curPrice = parseFloat(pos.curPrice) || parseFloat(pos.avgPrice) || 0.5;
                    tracker.trackSell(pos.conditionId, size, curPrice, size * curPrice);
                } else {
                    Logger.error(`❌ Failed to sell: ${orderResult?.errorMsg || 'Unknown error'}`);
                    errorCount++;
                }
                
                // Wait between sells
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                Logger.error(`❌ Error selling expiring position: ${error}`);
                errorCount++;
            }
        }
        
        if (soldCount > 0) {
            Logger.success(`✅ Auto-sold ${soldCount} expiring position(s)`);
        }
        if (errorCount > 0) {
            Logger.warning(`⚠️ Failed to sell ${errorCount} position(s)`);
        }
        
    } catch (error) {
        Logger.error(`Error checking expiring positions: ${error}`);
    }
};

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
    if (lastStaleCheckTime > 0 && timeSinceLastCheck < checkInterval) {
        return;
    }

    Logger.separator();
    Logger.warning(`⏰ STALE POSITION CHECK (every ${checkIntervalHours}h, selling positions > ${AUTO_SELL_DAYS} day(s) old)`);
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
                // Sync cache before selling (prevents "not enough balance/allowance" errors)
                await clobClient.updateBalanceAllowance({
                    asset_type: AssetType.CONDITIONAL,
                    token_id: stalePos.asset,
                });
                await new Promise(resolve => setTimeout(resolve, 300)); // Wait for cache to propagate

                // Get order book
                const orderBook = await clobClient.getOrderBook(stalePos.asset);
                if (!orderBook.bids || orderBook.bids.length === 0) {
                    Logger.warning(`No bids for ${stalePos.market} - skipping`);
                    continue;
                }

                // Calculate total available liquidity
                let totalAvailableSize = 0;
                let weightedPriceSum = 0;
                for (const bid of orderBook.bids) {
                    const bidSize = parseFloat(bid.size);
                    const bidPrice = parseFloat(bid.price);
                    totalAvailableSize += bidSize;
                    weightedPriceSum += bidSize * bidPrice;
                }
                const avgPrice = weightedPriceSum / totalAvailableSize;

                // Sell entire position with Market Order FOK
                const sellAmount = Math.min(realPos.size, totalAvailableSize);

                Logger.info(`📊 ${stalePos.market}: ${totalAvailableSize.toFixed(2)} tokens available, selling ${sellAmount.toFixed(2)}`);

                const signedOrder = await clobClient.createMarketOrder({
                    tokenID: stalePos.asset,
                    amount: sellAmount,
                    side: Side.SELL,
                });

                const result = await clobClient.postOrder(signedOrder, OrderType.FOK);

                if (result.success) {
                    const soldValue = sellAmount * avgPrice;
                    Logger.success(`✅ Auto-sold stale position: ${stalePos.market} (${sellAmount.toFixed(2)} tokens ≈ $${soldValue.toFixed(2)})`);
                    tracker.trackSell(stalePos.conditionId, sellAmount, avgPrice, soldValue);
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

// Promesse résolue quand isFirstRun est terminé — permet à tradeExecutor d'attendre
// avant de démarrer, évitant la race condition sur les trades bot:false
let _resolveFirstRun: () => void;
export const firstRunComplete: Promise<void> = new Promise(resolve => { _resolveFirstRun = resolve; });

const tradeMonitor = async () => {
    await init();
    Logger.success(`Monitoring ${USER_ADDRESSES.length} trader(s) every ${FETCH_INTERVAL}s`);
    Logger.separator();

    // On first run: fetch current API state FIRST, then mark ALL as processed.
    // This prevents copying trades that happened before the bot started.
    // (Bug: without this, fetchTradeData() in the loop would save "new" API trades
    //  as unprocessed even though they could be hours old.)
    if (isFirstRun) {
        Logger.info('First run: fetching current API state (all trades saved as already processed)...');
        await fetchTradeData(); // isFirstRun=true → trades saved directly as bot:true, no age filter
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

    // Signale que l'initialisation est terminée → tradeExecutor peut démarrer
    _resolveFirstRun();

    while (isRunning) {
        await fetchTradeData();
        
        // Check for stale positions if enabled
        await checkAndSellStalePositions();
        
        // Check for small positions (< 1 token) and auto-sell
        await checkAndSellSmallPositions();
        
        // Check for positions expiring soon (1 day before market close)
        await checkAndSellExpiringPositions();
        
        if (!isRunning) break;
        await new Promise((resolve) => setTimeout(resolve, FETCH_INTERVAL * 1000));
    }

    Logger.info('Trade monitor stopped');
};

export default tradeMonitor;
