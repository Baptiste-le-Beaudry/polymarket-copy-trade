import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import Logger from './logger';
import * as crypto from 'crypto';
import { calculateOrderSize, getTradeMultiplier, CopyStrategy } from '../config/copyStrategy';
import { getSimulationTracker } from './simulationBalance';
import { getPositionTracker } from './positionTracker';

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const COPY_STRATEGY_CONFIG = ENV.COPY_STRATEGY_CONFIG;
const PROXY_WALLET = ENV.PROXY_WALLET;

// Legacy parameters (for backward compatibility in SELL logic)
const TRADE_MULTIPLIER = ENV.TRADE_MULTIPLIER;
const COPY_PERCENTAGE = ENV.COPY_PERCENTAGE;

// Polymarket minimum order sizes (from env)
const MIN_ORDER_SIZE_USD = ENV.MIN_ORDER_SIZE_USD ?? 1.0; // Minimum order size in USD for BUY orders
const MIN_ORDER_SIZE_TOKENS = ENV.MIN_ORDER_SIZE_TOKENS ?? 1.0; // Minimum order size in tokens for SELL/MERGE orders

const extractOrderError = (response: unknown): string | undefined => {
    if (!response) {
        return undefined;
    }

    if (typeof response === 'string') {
        return response;
    }

    if (typeof response === 'object') {
        const data = response as Record<string, unknown>;

        const directError = data.error;
        if (typeof directError === 'string') {
            return directError;
        }

        if (typeof directError === 'object' && directError !== null) {
            const nested = directError as Record<string, unknown>;
            if (typeof nested.error === 'string') {
                return nested.error;
            }
            if (typeof nested.message === 'string') {
                return nested.message;
            }
        }

        if (typeof data.errorMsg === 'string') {
            return data.errorMsg;
        }

        if (typeof data.message === 'string') {
            return data.message;
        }
    }

    return undefined;
};

const isInsufficientBalanceOrAllowanceError = (message: string | undefined): boolean => {
    if (!message) {
        return false;
    }
    const lower = message.toLowerCase();
    return lower.includes('not enough balance') || lower.includes('allowance');
};

const postOrder = async (
    clobClient: ClobClient,
    condition: string,
    my_position: UserPositionInterface | undefined,
    user_position: UserPositionInterface | undefined,
    trade: UserActivityInterface,
    my_balance: number,
    user_balance: number,
    userAddress: string
) => {
    // Get UserActivity model first (needed for both real and simulation modes)
    const UserActivity = getUserActivityModel(userAddress);

    // DRY RUN MODE - Skip actual order execution
    if (ENV.DRY_RUN) {
        const simTracker = getSimulationTracker();
        Logger.info('🧪 DRY RUN MODE - Simulation only (no real trades)');
        
        if (condition === 'buy') {
            // Check MAX_OPEN_POSITIONS limit in simulation too
            if (ENV.MAX_OPEN_POSITIONS && !my_position) {
                const tracker = getPositionTracker();
                const currentPositionCount = tracker.getPositionCount();
                
                if (currentPositionCount >= ENV.MAX_OPEN_POSITIONS) {
                    Logger.warning(
                        `❌ [SIMULATION] Cannot execute: Maximum open positions limit reached (${currentPositionCount}/${ENV.MAX_OPEN_POSITIONS})`
                    );
                    await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                    return;
                }
                
                Logger.info(
                    `📊 Position count: ${currentPositionCount}/${ENV.MAX_OPEN_POSITIONS} (${ENV.MAX_OPEN_POSITIONS - currentPositionCount} slots available)`
                );
            }
            
            const virtualBalance = simTracker.getBalance();
            const orderCalc = calculateOrderSize(
                COPY_STRATEGY_CONFIG,
                trade.usdcSize,
                virtualBalance,
                my_position ? my_position.size * my_position.avgPrice : 0
            );
            Logger.info(`📊 ${orderCalc.reasoning}`);
            
            if (orderCalc.finalAmount > 0 && trade.price) {
                try {
                    simTracker.buy(trade.asset, orderCalc.finalAmount, trade.price);
                    Logger.success(`✓ [SIMULATION] BUY executed: $${orderCalc.finalAmount.toFixed(2)} @ $${trade.price.toFixed(4)}`);
                    
                    // Track in persistent position tracker for trader stats
                    const tracker = getPositionTracker();
                    tracker.trackBuy(
                        trade.asset,
                        trade.conditionId,
                        trade.title || 'Unknown Market',
                        trade.outcome || 'Unknown',
                        orderCalc.finalAmount / trade.price,
                        trade.price,
                        orderCalc.finalAmount,
                        userAddress
                    );
                } catch (error) {
                    Logger.error(`❌ [SIMULATION] BUY failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            } else {
                Logger.warning(`⚠️ [SIMULATION] Order too small or missing price`);
            }
        } else if (condition === 'sell') {
            const virtualPosition = simTracker.getPosition(trade.asset);
            if (virtualPosition && trade.price) {
                const tokensToSell = Math.min(virtualPosition.size, trade.size || virtualPosition.size);
                try {
                    simTracker.sell(trade.asset, tokensToSell, trade.price);
                    Logger.success(`✓ [SIMULATION] SELL executed: ${tokensToSell.toFixed(2)} tokens @ $${trade.price.toFixed(4)}`);
                    
                    // Track sell in position tracker
                    const tracker = getPositionTracker();
                    tracker.trackSell(trade.conditionId, tokensToSell, trade.price, tokensToSell * trade.price);
                } catch (error) {
                    Logger.error(`❌ [SIMULATION] SELL failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            } else {
                Logger.warning(`⚠️ [SIMULATION] No virtual position to sell`);
            }
        } else if (condition === 'merge') {
            Logger.success(`✓ [SIMULATION] Would MERGE positions for ${trade.asset.substring(0, 8)}...`);
        }
        
        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        return;
    }
    
    // Helper to compute and log local POLY headers for debugging
    const urlSafeBase64 = (base64: string) => base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const logPolyDebug = (signedOrder: any, owner: string) => {
        try {
            if (!process.env.POLY_SECRET) return;
            const bodyForSig = JSON.stringify({ deferExec: false, order: signedOrder, owner, orderType: OrderType.FOK });
            const ts = Math.floor(Date.now() / 1000).toString();
            const secretRaw = process.env.POLY_SECRET as string;
            let localSigRaw: string | null = null;
            let localSigNormalized: string | null = null;
            try {
                const base64SecretRaw = Buffer.from(secretRaw, 'base64');
                const hmacRaw = crypto.createHmac('sha256', base64SecretRaw).update(String(ts) + 'POST' + '/order' + bodyForSig).digest('base64');
                localSigRaw = urlSafeBase64(hmacRaw);
            } catch (e) {
                // ignore
            }
            try {
                const normalized = secretRaw.replace(/-/g, '+').replace(/_/g, '/');
                const base64SecretNorm = Buffer.from(normalized, 'base64');
                const hmacNorm = crypto.createHmac('sha256', base64SecretNorm).update(String(ts) + 'POST' + '/order' + bodyForSig).digest('base64');
                localSigNormalized = urlSafeBase64(hmacNorm);
            } catch (e) {
                // ignore
            }
            Logger.info(JSON.stringify({ DEBUG_POLY_TIMESTAMP: ts, DEBUG_POLY_COMPUTED_SIGNATURE_RAW: localSigRaw, DEBUG_POLY_COMPUTED_SIGNATURE_NORMALIZED: localSigNormalized, DEBUG_POLY_API_KEY: process.env.POLY_API_KEY || null }));
            // Also log the exact payload string used for the HMAC (helps detect serialization differences)
            Logger.info(JSON.stringify({ DEBUG_POLY_SENT_PAYLOAD: bodyForSig }));
        } catch (e) {
            Logger.error('DEBUG_POLY failed: ' + String(e));
        }
    };
    
    //Merge strategy
    if (condition === 'merge') {
        Logger.info('Executing MERGE strategy...');
        if (!my_position) {
            Logger.warning('No position to merge');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }
        let remaining = my_position.size;

        // Check minimum order size
        if (remaining < MIN_ORDER_SIZE_TOKENS) {
            Logger.warning(
                `Position size (${remaining.toFixed(2)} tokens) too small to merge - skipping`
            );
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        let retry = 0;
        let abortDueToFunds = false;
        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.bids || orderBook.bids.length === 0) {
                Logger.warning('No bids available in order book');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const maxPriceBid = orderBook.bids.reduce((max, bid) => {
                return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
            }, orderBook.bids[0]);

            Logger.info(`Best bid: ${maxPriceBid.size} @ $${maxPriceBid.price}`);
            let order_arges;
            if (remaining <= parseFloat(maxPriceBid.size)) {
                order_arges = {
                    side: Side.SELL,
                    tokenID: my_position.asset,
                    amount: remaining,
                    price: parseFloat(maxPriceBid.price),
                };
            } else {
                order_arges = {
                    side: Side.SELL,
                    tokenID: my_position.asset,
                    amount: parseFloat(maxPriceBid.size),
                    price: parseFloat(maxPriceBid.price),
                };
            }
            // Order args logged internally
            Logger.info(`DEBUG: before createMarketOrder ${JSON.stringify(order_arges)}`);
            let signedOrder: any;
            try {
                signedOrder = await clobClient.createMarketOrder(order_arges);
            } catch (err) {
                Logger.error(`ERROR createMarketOrder ${String(err)}`);
                console.error('ERROR createMarketOrder', err);
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }
            Logger.clearLine();
            Logger.info(JSON.stringify({
                signedOrderSignatureType: (signedOrder as any).signatureType,
                maker: (signedOrder as any).maker,
                signer: (signedOrder as any).signer,
            }));
            // Debug: compute and log local POLY headers/signature for inspection
            logPolyDebug(signedOrder, PROXY_WALLET as string);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
            if (resp.success === true) {
                retry = 0;
                Logger.orderResult(
                    true,
                    `Sold ${order_arges.amount} tokens at $${order_arges.price}`
                );
                remaining -= order_arges.amount;
            } else {
                const errorMessage = extractOrderError(resp);
                if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
                    abortDueToFunds = true;
                    Logger.warning(
                        `Order rejected: ${errorMessage || 'Insufficient balance or allowance'}`
                    );
                    Logger.warning(
                        'Skipping remaining attempts. Top up funds or run `npm run check-allowance` before retrying.'
                    );
                    break;
                }
                retry += 1;
                Logger.warning(
                    `Order failed (attempt ${retry}/${RETRY_LIMIT})${errorMessage ? ` - ${errorMessage}` : ''}`
                );
            }
        }
        if (abortDueToFunds) {
            await UserActivity.updateOne(
                { _id: trade._id },
                { bot: true, botExcutedTime: RETRY_LIMIT }
            );
            return;
        }
        if (retry >= RETRY_LIMIT) {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });
        } else {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        }
    } else if (condition === 'buy') {
        //Buy strategy
        Logger.info('Executing BUY strategy...');

        Logger.info(`Your balance: $${my_balance.toFixed(2)}`);
        Logger.info(`Trader bought: $${trade.usdcSize.toFixed(2)}`);

        // Check MAX_OPEN_POSITIONS limit (if configured)
        // Note: This check is synchronized at the executor level to prevent race conditions
        if (ENV.MAX_OPEN_POSITIONS && !my_position) {
            const tracker = getPositionTracker();
            const currentPositionCount = tracker.getPositionCount();
            
            if (currentPositionCount >= ENV.MAX_OPEN_POSITIONS) {
                Logger.warning(
                    `❌ Cannot execute: Maximum open positions limit reached (${currentPositionCount}/${ENV.MAX_OPEN_POSITIONS})`
                );
                Logger.warning(`💡 Close some positions first or increase MAX_OPEN_POSITIONS`);
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                return;
            }
            
            Logger.info(
                `📊 Position count: ${currentPositionCount}/${ENV.MAX_OPEN_POSITIONS} (${ENV.MAX_OPEN_POSITIONS - currentPositionCount} slots available)`
            );
        }

        // Get current position size for position limit checks
        const currentPositionValue = my_position ? my_position.size * my_position.avgPrice : 0;

        // Use new copy strategy system
        const orderCalc = calculateOrderSize(
            COPY_STRATEGY_CONFIG,
            trade.usdcSize,
            my_balance,
            currentPositionValue
        );

        // Log the calculation reasoning
        Logger.info(`📊 ${orderCalc.reasoning}`);

        // FIXED_TOKENS strategy: buy exact number of tokens regardless of price
        const isFixedTokens = COPY_STRATEGY_CONFIG.strategy === CopyStrategy.FIXED_TOKENS;
        let tokensToBuy: number | null = null;

        if (isFixedTokens) {
            tokensToBuy = orderCalc.finalAmount; // This is the number of tokens (e.g., 3.0)
            Logger.info(`🎯 Fixed tokens strategy: Will buy ${tokensToBuy} tokens at market price`);
        }

        // Check if order should be executed (only for non-FIXED_TOKENS)
        if (!isFixedTokens && orderCalc.finalAmount === 0) {
            Logger.warning(`❌ Cannot execute: ${orderCalc.reasoning}`);
            if (orderCalc.belowMinimum) {
                Logger.warning(`💡 Increase COPY_SIZE or wait for larger trades`);
            }
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        let remaining = isFixedTokens ? 999999 : orderCalc.finalAmount; // Arbitrary high for FIXED_TOKENS

        let retry = 0;
        let abortDueToFunds = false;
        let totalBoughtTokens = 0; // Track total tokens bought for this trade

        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.asks || orderBook.asks.length === 0) {
                Logger.warning('No asks available in order book');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const minPriceAsk = orderBook.asks.reduce((min, ask) => {
                return parseFloat(ask.price) < parseFloat(min.price) ? ask : min;
            }, orderBook.asks[0]);

            Logger.info(`Best ask: ${minPriceAsk.size} @ $${minPriceAsk.price}`);
            
            // FIXED_TOKENS: Calculate USD amount needed for desired tokens
            let orderSize: number;
            if (isFixedTokens && tokensToBuy !== null) {
                const tokensNeeded = tokensToBuy - totalBoughtTokens;
                if (tokensNeeded <= 0) {
                    Logger.success(`✅ Target reached: Bought ${totalBoughtTokens.toFixed(2)} tokens`);
                    break; // Exit - we have enough tokens
                }
                const tokensAvailable = parseFloat(minPriceAsk.size);
                const tokensThisOrder = Math.min(tokensNeeded, tokensAvailable);
                orderSize = tokensThisOrder * parseFloat(minPriceAsk.price);
                
                // Check if buying would exceed cash reserve
                const minReserve = ENV.MIN_CASH_RESERVE || 0;
                const availableAfterReserve = Math.max(0, my_balance - minReserve);
                if (orderSize > availableAfterReserve) {
                    Logger.warning(`⚠️ Insufficient balance after reserve: $${my_balance.toFixed(2)} - $${minReserve} reserve = $${availableAfterReserve.toFixed(2)}`);
                    Logger.warning(`💡 Cannot buy $${orderSize.toFixed(2)} worth of tokens`);
                    await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                    break;
                }
                
                Logger.info(`📦 Buying ${tokensThisOrder.toFixed(2)} tokens = $${orderSize.toFixed(2)}`);
            } else {
                // Regular strategies
                if (parseFloat(minPriceAsk.price) - 0.05 > trade.price) {
                    Logger.warning('Price slippage too high - skipping trade');
                    await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                    break;
                }

                // Check if remaining amount is below minimum before creating order
                if (remaining < MIN_ORDER_SIZE_USD) {
                    Logger.info(
                        `Remaining amount ($${remaining.toFixed(2)}) below minimum - completing trade`
                    );
                    await UserActivity.updateOne(
                        { _id: trade._id },
                        { bot: true, myBoughtSize: totalBoughtTokens }
                    );
                    break;
                }

                const maxOrderSize = parseFloat(minPriceAsk.size) * parseFloat(minPriceAsk.price);
                orderSize = Math.min(remaining, maxOrderSize);
            }

            const order_arges = {
                side: Side.BUY,
                tokenID: trade.asset,
                amount: orderSize,
                price: parseFloat(minPriceAsk.price),
            };

            Logger.info(
                `Creating order: $${orderSize.toFixed(2)} @ $${minPriceAsk.price} (Balance: $${my_balance.toFixed(2)})`
            );
            // Order args logged internally
            Logger.info(`DEBUG: before createMarketOrder ${JSON.stringify(order_arges)}`);
            let signedOrder: any;
            try {
                signedOrder = await clobClient.createMarketOrder(order_arges);
            } catch (err) {
                Logger.error(`ERROR createMarketOrder ${String(err)}`);
                console.error('ERROR createMarketOrder', err);
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }
            Logger.clearLine();
            // Debug: compute and log local POLY headers/signature for inspection
            logPolyDebug(signedOrder, PROXY_WALLET as string);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
            if (resp.success === true) {
                retry = 0;
                const tokensBought = order_arges.amount / order_arges.price;
                totalBoughtTokens += tokensBought;
                Logger.orderResult(
                    true,
                    `Bought $${order_arges.amount.toFixed(2)} at $${order_arges.price} (${tokensBought.toFixed(2)} tokens)`
                );
                
                if (!isFixedTokens) {
                    remaining -= order_arges.amount;
                }
            } else {
                const errorMessage = extractOrderError(resp);
                if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
                    abortDueToFunds = true;
                    Logger.warning(
                        `Order rejected: ${errorMessage || 'Insufficient balance or allowance'}`
                    );
                    Logger.warning(
                        'Skipping remaining attempts. Top up funds or run `npm run check-allowance` before retrying.'
                    );
                    break;
                }
                retry += 1;
                Logger.warning(
                    `Order failed (attempt ${retry}/${RETRY_LIMIT})${errorMessage ? ` - ${errorMessage}` : ''}`
                );
            }
        }
        if (abortDueToFunds) {
            await UserActivity.updateOne(
                { _id: trade._id },
                { bot: true, botExcutedTime: RETRY_LIMIT, myBoughtSize: totalBoughtTokens }
            );
            return;
        }
        if (retry >= RETRY_LIMIT) {
            await UserActivity.updateOne(
                { _id: trade._id },
                { bot: true, botExcutedTime: retry, myBoughtSize: totalBoughtTokens }
            );
        } else {
            await UserActivity.updateOne(
                { _id: trade._id },
                { bot: true, myBoughtSize: totalBoughtTokens }
            );
        }

        // Log the tracked purchase for later sell reference
        if (totalBoughtTokens > 0) {
            Logger.info(
                `📝 Tracked purchase: ${totalBoughtTokens.toFixed(2)} tokens for future sell calculations`
            );
            
            // Track in persistent position tracker
            const tracker = getPositionTracker();
            tracker.trackBuy(
                trade.asset,
                trade.conditionId,
                trade.title || 'Unknown Market',
                trade.outcome || 'Unknown',
                totalBoughtTokens,
                trade.price,
                orderCalc.finalAmount,
                userAddress
            );
        }
    } else if (condition === 'sell') {
        //Sell strategy
        Logger.info('Executing SELL strategy...');
        let remaining = 0;
        if (!my_position) {
            Logger.warning('No position to sell');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        // Get all previous BUY trades for this asset to calculate total bought
        const previousBuys = await UserActivity.find({
            asset: trade.asset,
            conditionId: trade.conditionId,
            side: 'BUY',
            bot: true,
            myBoughtSize: { $exists: true, $gt: 0 },
        }).exec();

        const totalBoughtTokens = previousBuys.reduce(
            (sum, buy) => sum + (buy.myBoughtSize || 0),
            0
        );

        if (totalBoughtTokens > 0) {
            Logger.info(
                `📊 Found ${previousBuys.length} previous purchases: ${totalBoughtTokens.toFixed(2)} tokens bought`
            );
        }

        if (!user_position) {
            // Trader sold entire position - we sell entire position too
            remaining = my_position.size;
            Logger.info(
                `Trader closed entire position → Selling all your ${remaining.toFixed(2)} tokens`
            );
        } else {
            // Calculate the % of position the trader is selling
            const trader_sell_percent = trade.size / (user_position.size + trade.size);
            const trader_position_before = user_position.size + trade.size;

            Logger.info(
                `Position comparison: Trader has ${trader_position_before.toFixed(2)} tokens, You have ${my_position.size.toFixed(2)} tokens`
            );
            Logger.info(
                `Trader selling: ${trade.size.toFixed(2)} tokens (${(trader_sell_percent * 100).toFixed(2)}% of their position)`
            );

            // Use tracked bought tokens if available, otherwise fallback to current position
            let baseSellSize;
            if (totalBoughtTokens > 0) {
                baseSellSize = totalBoughtTokens * trader_sell_percent;
                Logger.info(
                    `Calculating from tracked purchases: ${totalBoughtTokens.toFixed(2)} × ${(trader_sell_percent * 100).toFixed(2)}% = ${baseSellSize.toFixed(2)} tokens`
                );
            } else {
                baseSellSize = my_position.size * trader_sell_percent;
                Logger.warning(
                    `No tracked purchases found, using current position: ${my_position.size.toFixed(2)} × ${(trader_sell_percent * 100).toFixed(2)}% = ${baseSellSize.toFixed(2)} tokens`
                );
            }

            // Apply tiered or single multiplier based on trader's order size (symmetrical with BUY logic)
            const multiplier = getTradeMultiplier(COPY_STRATEGY_CONFIG, trade.usdcSize);
            remaining = baseSellSize * multiplier;

            if (multiplier !== 1.0) {
                Logger.info(
                    `Applying ${multiplier}x multiplier (based on trader's $${trade.usdcSize.toFixed(2)} order): ${baseSellSize.toFixed(2)} → ${remaining.toFixed(2)} tokens`
                );
            }

            // SMART SELL LOGIC: If partial sell would leave < 1 token, sell everything instead
            const wouldRemain = my_position.size - remaining;
            if (wouldRemain > 0 && wouldRemain < MIN_ORDER_SIZE_TOKENS) {
                Logger.warning(
                    `⚠️  Partial sell would leave ${wouldRemain.toFixed(2)} tokens (< ${MIN_ORDER_SIZE_TOKENS} minimum)`
                );
                Logger.info(`💡 Smart sell: Selling entire position (${my_position.size.toFixed(2)} tokens) to avoid stuck position`);
                remaining = my_position.size;
            }
        }

        // FIXED_TOKENS strategy: Always sell 1 token at a time (or all if < 2 tokens remain)
        const isFixedTokens = COPY_STRATEGY_CONFIG.strategy === CopyStrategy.FIXED_TOKENS;
        if (isFixedTokens) {
            if (my_position.size < 2.0) {
                // Less than 2 tokens total - sell everything
                Logger.info(`💡 FIXED_TOKENS: Position has ${my_position.size.toFixed(2)} tokens - selling all`);
                remaining = my_position.size;
            } else {
                // Sell 1 token at a time
                Logger.info(`💡 FIXED_TOKENS: Selling 1 token (position has ${my_position.size.toFixed(2)} tokens)`);
                remaining = Math.min(1.0, my_position.size);
            }
        }

        // Check minimum order size
        if (remaining < MIN_ORDER_SIZE_TOKENS) {
            Logger.warning(
                `❌ Cannot execute: Sell amount ${remaining.toFixed(2)} tokens below minimum (${MIN_ORDER_SIZE_TOKENS} token)`
            );
            Logger.warning(`💡 This happens when position sizes are too small or mismatched`);
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        // Cap sell amount to available position size
        if (remaining > my_position.size) {
            Logger.warning(
                `⚠️  Calculated sell ${remaining.toFixed(2)} tokens > Your position ${my_position.size.toFixed(2)} tokens`
            );
            Logger.warning(`Capping to maximum available: ${my_position.size.toFixed(2)} tokens`);
            remaining = my_position.size;
        }

        let retry = 0;
        let abortDueToFunds = false;
        let totalSoldTokens = 0; // Track total tokens sold

        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.bids || orderBook.bids.length === 0) {
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                Logger.warning('No bids available in order book');
                break;
            }

            const maxPriceBid = orderBook.bids.reduce((max, bid) => {
                return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
            }, orderBook.bids[0]);

            Logger.info(`Best bid: ${maxPriceBid.size} @ $${maxPriceBid.price}`);

            // Check if remaining amount is below minimum before creating order
            if (remaining < MIN_ORDER_SIZE_TOKENS) {
                Logger.info(
                    `Remaining amount (${remaining.toFixed(2)} tokens) below minimum - completing trade`
                );
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const sellAmount = Math.min(remaining, parseFloat(maxPriceBid.size));

            // Final check: don't create orders below minimum
            if (sellAmount < MIN_ORDER_SIZE_TOKENS) {
                Logger.info(
                    `Order amount (${sellAmount.toFixed(2)} tokens) below minimum - completing trade`
                );
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const order_arges = {
                side: Side.SELL,
                tokenID: trade.asset,
                amount: sellAmount,
                price: parseFloat(maxPriceBid.price),
            };
            // Order args logged internally
            Logger.info(`DEBUG: before createMarketOrder ${JSON.stringify(order_arges)}`);
            let signedOrder: any;
            try {
                signedOrder = await clobClient.createMarketOrder(order_arges);
            } catch (err) {
                Logger.error(`ERROR createMarketOrder ${String(err)}`);
                console.error('ERROR createMarketOrder', err);
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }
            Logger.clearLine();
            // Debug: compute and log local POLY headers/signature for inspection
            logPolyDebug(signedOrder, PROXY_WALLET as string);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
            if (resp.success === true) {
                retry = 0;
                totalSoldTokens += order_arges.amount;
                Logger.orderResult(
                    true,
                    `Sold ${order_arges.amount} tokens at $${order_arges.price}`
                );
                remaining -= order_arges.amount;
            } else {
                const errorMessage = extractOrderError(resp);
                if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
                    abortDueToFunds = true;
                    Logger.warning(
                        `Order rejected: ${errorMessage || 'Insufficient balance or allowance'}`
                    );
                    Logger.warning(
                        'Skipping remaining attempts. Top up funds or run `npm run check-allowance` before retrying.'
                    );
                    break;
                }
                retry += 1;
                Logger.warning(
                    `Order failed (attempt ${retry}/${RETRY_LIMIT})${errorMessage ? ` - ${errorMessage}` : ''}`
                );
            }
        }

        // Update tracked purchases after successful sell
        if (totalSoldTokens > 0 && totalBoughtTokens > 0) {
            const sellPercentage = totalSoldTokens / totalBoughtTokens;

            if (sellPercentage >= 0.99) {
                // Sold essentially all tracked tokens - clear tracking
                await UserActivity.updateMany(
                    {
                        asset: trade.asset,
                        conditionId: trade.conditionId,
                        side: 'BUY',
                        bot: true,
                        myBoughtSize: { $exists: true, $gt: 0 },
                    },
                    { $set: { myBoughtSize: 0 } }
                );
                Logger.info(
                    `🧹 Cleared purchase tracking (sold ${(sellPercentage * 100).toFixed(1)}% of position)`
                );
            } else {
                // Partial sell - reduce tracked purchases proportionally
                for (const buy of previousBuys) {
                    const newSize = (buy.myBoughtSize || 0) * (1 - sellPercentage);
                    await UserActivity.updateOne(
                        { _id: buy._id },
                        { $set: { myBoughtSize: newSize } }
                    );
                }
                Logger.info(
                    `📝 Updated purchase tracking (sold ${(sellPercentage * 100).toFixed(1)}% of tracked position)`
                );
            }
            
            // Track sell in persistent position tracker
            const tracker = getPositionTracker();
            tracker.trackSell(
                trade.conditionId,
                totalSoldTokens,
                trade.price,
                totalSoldTokens * trade.price
            );
        }

        if (abortDueToFunds) {
            await UserActivity.updateOne(
                { _id: trade._id },
                { bot: true, botExcutedTime: RETRY_LIMIT }
            );
            return;
        }
        if (retry >= RETRY_LIMIT) {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });
        } else {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        }
    } else {
        Logger.error(`Unknown condition: ${condition}`);
    }
};

export default postOrder;
