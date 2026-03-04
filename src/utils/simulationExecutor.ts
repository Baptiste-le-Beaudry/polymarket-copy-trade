/**
 * Simulation executor that orchestrates order book simulation
 * Integrates orderBookSimulator with simulation balance tracking
 */

import { SimulationMode, PartialFillStrategy, getSimulationConfig } from '../config/simulationConfig';
import { simulateOrderBookFill } from './orderBookSimulator';
import { getOrderBookCache } from './orderBookCache';
import { getSimulationTracker } from './simulationBalance';
import Logger from './logger';
import createClobClient from './createClobClient';
import { ENV } from '../config/env';

export interface SimulatedTradeResult {
    success: boolean;
    executed: boolean;
    tokensTraded?: number;
    avgPrice?: number;
    slippage?: number;
    partialFill?: boolean;
    levelsUsed?: number;
    reason?: string;
}

/**
 * Execute a simulated trade using order book simulation or simple mode
 */
export async function executeSimulatedTrade(
    asset: string,
    side: 'BUY' | 'SELL',
    amount: number, // USD for BUY, tokens for SELL
    traderPrice: number,
    userAddress: string
): Promise<SimulatedTradeResult> {
    const config = getSimulationConfig();
    const simTracker = getSimulationTracker();

    // SIMPLE mode: Use current implementation (fallback)
    if (config.mode === SimulationMode.SIMPLE) {
        return executeSimpleMode(asset, side, amount, traderPrice, simTracker);
    }

    // REALISTIC or HYBRID mode: Try order book simulation
    try {
        const result = await executeOrderBookMode(asset, side, amount, traderPrice, config, simTracker);
        return result;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        Logger.error(`[SIMULATION] Order book simulation failed: ${errorMessage}`);

        // HYBRID mode: Fallback to SIMPLE
        if (config.mode === SimulationMode.HYBRID) {
            Logger.warning('[SIMULATION] Falling back to SIMPLE mode due to error');
            return executeSimpleMode(asset, side, amount, traderPrice, simTracker);
        }

        // REALISTIC mode: Fail the trade
        return {
            success: false,
            executed: false,
            reason: `Order book simulation failed: ${errorMessage}`
        };
    }
}

/**
 * Execute trade in SIMPLE mode (current implementation)
 */
async function executeSimpleMode(
    asset: string,
    side: 'BUY' | 'SELL',
    amount: number,
    traderPrice: number,
    simTracker: any
): Promise<SimulatedTradeResult> {
    try {
        if (side === 'BUY') {
            await simTracker.buy(asset, amount, traderPrice);
            const tokens = amount / traderPrice;
            return {
                success: true,
                executed: true,
                tokensTraded: tokens,
                avgPrice: traderPrice,
                slippage: 0.5, // Fixed 0.5% slippage in simple mode
                partialFill: false
            };
        } else {
            await simTracker.sell(asset, amount, traderPrice);
            return {
                success: true,
                executed: true,
                tokensTraded: amount,
                avgPrice: traderPrice,
                slippage: 0,
                partialFill: false
            };
        }
    } catch (error) {
        return {
            success: false,
            executed: false,
            reason: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * Execute trade using order book simulation
 */
async function executeOrderBookMode(
    asset: string,
    side: 'BUY' | 'SELL',
    amount: number,
    traderPrice: number,
    config: any,
    simTracker: any
): Promise<SimulatedTradeResult> {
    const cache = getOrderBookCache();
    const clobClient = await createClobClient();

    // ============================================================
    // REALISTIC COPY DELAY: Simulate the lag between trader and bot
    // ============================================================
    if (ENV.SIMULATION_COPY_DELAY_ENABLED) {
        const minDelay = ENV.SIMULATION_COPY_DELAY_MIN;
        const maxDelay = ENV.SIMULATION_COPY_DELAY_MAX;
        const copyDelaySeconds = Math.random() * (maxDelay - minDelay) + minDelay;

        Logger.info(`⏱️ [SIMULATION] Simulating copy delay: ${copyDelaySeconds.toFixed(1)}s`);

        // Simulate the delay (bot is waiting while trader executed already)
        await new Promise(resolve => setTimeout(resolve, copyDelaySeconds * 1000));
    }

    // ============================================================
    // FETCH CURRENT ORDER BOOK (not cached — must reflect real-time market)
    // ============================================================
    // CRITICAL: After the delay, fetch the CURRENT order book to see actual market state
    const orderBook = await clobClient.getOrderBook(asset);

    // Check if order book has liquidity
    if (side === 'BUY' && (!orderBook.asks || orderBook.asks.length === 0)) {
        Logger.warning('[SIMULATION] No asks available — market has no sell orders');
        return {
            success: false,
            executed: false,
            reason: 'No liquidity (no asks)'
        };
    }
    if (side === 'SELL' && (!orderBook.bids || orderBook.bids.length === 0)) {
        Logger.warning('[SIMULATION] No bids available — market has no buy orders');
        return {
            success: false,
            executed: false,
            reason: 'No liquidity (no bids)'
        };
    }

    // Get current best price (what the bot would actually get NOW)
    const currentBestPrice = side === 'BUY'
        ? parseFloat(orderBook.asks[0].price)
        : parseFloat(orderBook.bids[0].price);

    // Calculate price movement since trader executed
    const priceMovement = ((currentBestPrice - traderPrice) / traderPrice) * 100;

    Logger.info(
        `📊 [SIMULATION] Price movement: ${priceMovement >= 0 ? '+' : ''}${priceMovement.toFixed(2)}% ` +
        `(trader: $${traderPrice.toFixed(4)} → current: $${currentBestPrice.toFixed(4)})`
    );

    // Calculate tokens to fill based on side
    const tokensToFill = side === 'BUY' ? amount / traderPrice : amount;

    // Simulate order book fill
    const fillResult = await simulateOrderBookFill(asset, side, tokensToFill);

    if (!fillResult.fullyFilled) {
        Logger.warning(
            `[SIMULATION] Partial fill: ${fillResult.tokensFilled.toFixed(2)}/${tokensToFill.toFixed(2)} tokens ` +
            `(${((fillResult.tokensFilled / tokensToFill) * 100).toFixed(1)}%)`
        );
    }

    // Calculate slippage (current best price vs actual execution price)
    const slippage = fillResult.avgPrice > 0
        ? ((fillResult.avgPrice - currentBestPrice) / currentBestPrice) * 100
        : 0;

    // Check if slippage exceeds maximum
    if (Math.abs(slippage) > config.maxSlippagePercent) {
        Logger.warning(
            `[SIMULATION] High slippage detected: ${slippage.toFixed(2)}% ` +
            `(max: ${config.maxSlippagePercent}%)`
        );
    }

    // Handle partial fills based on strategy
    if (!fillResult.fullyFilled) {
        if (config.partialFillStrategy === PartialFillStrategy.ABORT) {
            Logger.warning('[SIMULATION] Trade aborted due to insufficient liquidity (ABORT strategy)');
            return {
                success: false,
                executed: false,
                reason: 'Insufficient liquidity - trade aborted',
                partialFill: true
            };
        }

        // WARN or PARTIAL strategy: accept the partial fill
        Logger.warning(
            `[SIMULATION] Accepting partial fill (${config.partialFillStrategy} strategy)`
        );
    }

    // Log order book details
    if (fillResult.levelsUsed.length > 1) {
        Logger.info('[SIMULATION] Order book fill details:');
        fillResult.levelsUsed.forEach((level, index) => {
            Logger.info(
                `  L${index + 1}: ${level.size.toFixed(2)} tokens @ $${level.price.toFixed(4)} = $${(level.size * level.price).toFixed(2)}`
            );
        });
        Logger.info(
            `  Total: ${fillResult.tokensFilled.toFixed(2)} tokens @ $${fillResult.avgPrice.toFixed(4)} avg`
        );
    }

    // ============================================================
    // PRICE ACCEPTANCE CHECK — BEFORE committing to simTracker
    // This must happen BEFORE buy() is called to avoid "Trade annulé"
    // after money has already been deducted and position created.
    // ============================================================
    if (side === 'BUY') {
        const maxBuyPrice = ENV.MAX_BUY_PRICE;
        const minGainPercent = ENV.MIN_GAIN_POTENTIAL_PERCENT;
        const execPrice = fillResult.avgPrice;

        if (execPrice >= maxBuyPrice) {
            return {
                success: false,
                executed: false,
                reason: `Prix trop élevé: $${execPrice.toFixed(4)} ≥ MAX_BUY_PRICE $${maxBuyPrice.toFixed(4)} (gain max = ${((1 - execPrice) / execPrice * 100).toFixed(2)}%)`
            };
        }
        const gainPotential = (1 - execPrice) / execPrice * 100;
        if (gainPotential < minGainPercent) {
            return {
                success: false,
                executed: false,
                reason: `Gain potentiel insuffisant: ${gainPotential.toFixed(2)}% < ${minGainPercent}% min (prix: $${execPrice.toFixed(4)})`
            };
        }
    }

    // Execute the simulated trade
    try {
        if (side === 'BUY') {
            // Use buyWithOrderBook if available, otherwise fall back to regular buy
            if (typeof simTracker.buyWithOrderBook === 'function') {
                await simTracker.buyWithOrderBook(asset, amount, traderPrice, fillResult);
            } else {
                // Fallback: use avgPrice from order book simulation
                const actualUsdAmount = fillResult.tokensFilled * fillResult.avgPrice;
                await simTracker.buy(asset, actualUsdAmount, fillResult.avgPrice);
            }
        } else {
            // Use sellWithOrderBook if available, otherwise fall back to regular sell
            if (typeof simTracker.sellWithOrderBook === 'function') {
                await simTracker.sellWithOrderBook(asset, fillResult.tokensFilled, traderPrice, fillResult);
            } else {
                // Fallback: use avgPrice from order book simulation
                await simTracker.sell(asset, fillResult.tokensFilled, fillResult.avgPrice);
            }
        }

        return {
            success: true,
            executed: true,
            tokensTraded: fillResult.tokensFilled,
            avgPrice: fillResult.avgPrice,
            slippage,
            partialFill: !fillResult.fullyFilled,
            levelsUsed: fillResult.levelsUsed.length
        };
    } catch (error) {
        return {
            success: false,
            executed: false,
            reason: error instanceof Error ? error.message : String(error)
        };
    }
}
