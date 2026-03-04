import connectDB, { closeDB } from './config/db';
import { ENV } from './config/env';
import createClobClient from './utils/createClobClient';
import tradeExecutor, { stopTradeExecutor } from './services/tradeExecutor';
import tradeMonitor, { stopTradeMonitor, firstRunComplete } from './services/tradeMonitor';
import Logger from './utils/logger';
import { performHealthCheck, logHealthCheck } from './utils/healthCheck';
import test from './test/test';
import { getSimulationTracker } from './utils/simulationBalance';
import { startPositionMonitoring, stopPositionMonitoring } from './scripts/analyzePositionAlignment';
import { getPositionTracker } from './utils/positionTracker';
import { initializeLogAnalyzer, shutdownLogAnalyzer, logBotEvent, updateBotBalance, getLogAnalyzer } from './utils/logAnalyzer';
import * as readline from 'readline';
import { AssetType, Side, OrderType } from '@polymarket/clob-client';
import fetchData from './utils/fetchData';
import { displayLiveComparison } from './utils/livePositionComparison';

const USER_ADDRESSES = ENV.USER_ADDRESSES;
const PROXY_WALLET = ENV.PROXY_WALLET;

// Graceful shutdown handler
let isShuttingDown = false;

// Retry configuration for real trading
const SELL_RETRY_LIMIT = 3;
const SELL_DELAY_MS = 1500; // Delay between sells to avoid rate limits

/**
 * Sell all positions without stopping the bot
 */
const sellAllPositions = async () => {
    if (ENV.DRY_RUN) {
        const simTracker = getSimulationTracker();
        const positions = simTracker.getAllPositions();
        
        if (positions.length === 0) {
            Logger.info('📦 No positions to sell');
            return;
        }
        
        Logger.separator();
        Logger.warning(`🔄 Selling all ${positions.length} positions...`);
        
        let soldCount = 0;
        for (const pos of positions) {
            try {
                simTracker.sell(pos.asset, pos.size, pos.avgPrice);
                soldCount++;
                Logger.success(`✅ Sold: ${pos.size.toFixed(2)} tokens @ $${pos.avgPrice.toFixed(4)}`);
            } catch (error) {
                Logger.error(`❌ Failed to sell position: ${(error as Error).message}`);
            }
        }
        
        Logger.separator();
        Logger.success(`✅ Sold ${soldCount}/${positions.length} positions`);
        Logger.info(`💰 Current balance: $${simTracker.getCurrentBalance().toFixed(2)}`);
        Logger.separator();
    } else {
        // ============================================
        // REAL TRADING MODE - SELL ALL POSITIONS
        // ============================================
        Logger.separator();
        Logger.warning('🔴 REAL TRADING MODE - SELLING ALL POSITIONS');
        Logger.warning('⚠️  This will sell all your real positions on Polymarket!');
        Logger.separator();

        try {
            // Fetch real positions from Polymarket
            const myPositionsUrl = `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`;
            const myPositions = await fetchData(myPositionsUrl);

            if (!Array.isArray(myPositions) || myPositions.length === 0) {
                Logger.info('📦 No positions to sell');
                return;
            }

            // Filter positions with size > 0
            const activePosisions = myPositions.filter((pos: any) => pos.size > 0);

            if (activePosisions.length === 0) {
                Logger.info('📦 No active positions to sell');
                return;
            }

            Logger.warning(`🔄 Found ${activePosisions.length} positions to sell...`);

            // Create CLOB client
            const clobClient = await createClobClient();
            const tracker = getPositionTracker();

            let soldCount = 0;
            let errorCount = 0;
            let totalSoldValue = 0;

            for (const pos of activePosisions) {
                Logger.info(`\n📊 Processing: ${pos.title || pos.slug || pos.asset.substring(0, 20)}...`);
                Logger.info(`   Size: ${pos.size.toFixed(4)} tokens`);

                // Sync cache before selling (prevents "not enough balance/allowance" errors)
                try {
                    await clobClient.updateBalanceAllowance({
                        asset_type: AssetType.CONDITIONAL,
                        token_id: pos.asset,
                    });
                    await new Promise(resolve => setTimeout(resolve, 300));
                } catch (syncError) {
                    Logger.warning(`   ⚠️ Cache sync failed: ${(syncError as Error).message}`);
                }

                let remaining = pos.size;
                let retries = 0;

                while (remaining > 0.01 && retries < SELL_RETRY_LIMIT) {
                    try {
                        // Get order book for best bid
                        const orderBook = await clobClient.getOrderBook(pos.asset);
                        
                        if (!orderBook.bids || orderBook.bids.length === 0) {
                            Logger.warning(`   ⚠️ No bids available - skipping`);
                            errorCount++;
                            break;
                        }

                        // Calculate total available liquidity across all bids
                        let totalAvailableSize = 0;
                        let weightedPriceSum = 0;
                        for (const bid of orderBook.bids) {
                            const bidSize = parseFloat(bid.size);
                            const bidPrice = parseFloat(bid.price);
                            totalAvailableSize += bidSize;
                            weightedPriceSum += bidSize * bidPrice;
                        }
                        const avgPrice = weightedPriceSum / totalAvailableSize;

                        // Find best bid for display
                        const maxPriceBid = orderBook.bids.reduce((max, bid) => {
                            return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
                        }, orderBook.bids[0]);

                        const bestBidPrice = parseFloat(maxPriceBid.price);
                        
                        // Sell as much as possible with Market Order FOK
                        const sellAmount = Math.min(remaining, totalAvailableSize);

                        Logger.info(`   📊 Order book: ${totalAvailableSize.toFixed(2)} tokens available`);
                        Logger.info(`   Best bid: $${bestBidPrice.toFixed(4)} | Avg price: $${avgPrice.toFixed(4)}`);
                        Logger.info(`   🚀 Market selling: ${sellAmount.toFixed(4)} tokens`);

                        // Create MARKET ORDER (FOK - Fill Or Kill) - sells at best available prices
                        const signedOrder = await clobClient.createMarketOrder({
                            tokenID: pos.asset,
                            amount: sellAmount,
                            side: Side.SELL,
                        });

                        const result = await clobClient.postOrder(signedOrder, OrderType.FOK);

                        if (result.success) {
                            const soldValue = sellAmount * avgPrice; // Approximate value
                            totalSoldValue += soldValue;
                            remaining -= sellAmount;
                            retries = 0; // Reset retries on success

                            Logger.success(`   ✅ MARKET SOLD ${sellAmount.toFixed(4)} tokens ≈ $${soldValue.toFixed(2)}`);

                            // Track in position tracker
                            if (pos.conditionId) {
                                tracker.trackSell(pos.conditionId, sellAmount, avgPrice, soldValue);
                            }

                            // Log event
                            logBotEvent('TRADE_SUCCESS', `SELL ALL: ${sellAmount.toFixed(2)} tokens @ ~$${avgPrice.toFixed(4)}`, {
                                type: 'SELL_ALL',
                                tokens: sellAmount,
                                price: avgPrice,
                                asset: pos.asset,
                                market: pos.title || pos.slug
                            });

                            if (remaining > 0.01) {
                                Logger.info(`   Remaining: ${remaining.toFixed(4)} tokens`);
                                await new Promise(resolve => setTimeout(resolve, SELL_DELAY_MS));
                            }
                        } else {
                            retries++;
                            Logger.warning(`   ⚠️ Order failed (attempt ${retries}/${SELL_RETRY_LIMIT})`);
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        }
                    } catch (error) {
                        retries++;
                        Logger.error(`   ❌ Error: ${(error as Error).message} (attempt ${retries}/${SELL_RETRY_LIMIT})`);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }

                if (remaining <= 0.01) {
                    soldCount++;
                } else {
                    errorCount++;
                    Logger.warning(`   ⚠️ Could not fully sell - ${remaining.toFixed(4)} tokens remaining`);
                }

                // Delay between positions
                await new Promise(resolve => setTimeout(resolve, SELL_DELAY_MS));
            }

            Logger.separator();
            Logger.success(`✅ SELL ALL COMPLETE`);
            Logger.info(`📊 Positions sold: ${soldCount}/${activePosisions.length}`);
            Logger.info(`💰 Total value sold: $${totalSoldValue.toFixed(2)}`);
            if (errorCount > 0) {
                Logger.warning(`⚠️ Errors: ${errorCount} positions could not be fully sold`);
            }
            Logger.separator();

        } catch (error) {
            Logger.error(`❌ Error in Sell All: ${(error as Error).message}`);
            logBotEvent('ERROR', `Sell All failed: ${(error as Error).message}`);
        }
    }
};

/**
 * Synchronize position tracker with real Polymarket positions
 * Should be called at startup in real trading mode
 */
const syncPositionsWithPolymarket = async (): Promise<void> => {
    if (ENV.DRY_RUN) {
        Logger.info('🧪 DRY_RUN mode - skipping position sync');
        return;
    }

    Logger.separator();
    Logger.info('🔄 SYNCHRONIZING POSITIONS WITH POLYMARKET');
    Logger.separator();

    try {
        // Create CLOB client for cache sync
        const clobClient = await createClobClient();

        // Fetch real positions from Polymarket
        const myPositionsUrl = `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`;
        const myPositions = await fetchData(myPositionsUrl);

        if (!Array.isArray(myPositions)) {
            Logger.warning('⚠️ Could not fetch positions from Polymarket');
            return;
        }

        // Filter active positions
        const activePositions = myPositions.filter((p: any) => p.size > 0);

        const tracker = getPositionTracker();
        const localPositions = tracker.getAllPositions();

        Logger.info(`📊 Local tracker: ${localPositions.length} positions`);
        Logger.info(`🌐 Polymarket: ${activePositions.length} active positions`);

        // Sync position allowances with Polymarket cache (prevents "not enough balance/allowance" errors)
        if (activePositions.length > 0) {
            Logger.info(`🔑 Syncing ${activePositions.length} position allowances...`);
            let syncedCount = 0;
            let errorCount = 0;

            for (const pos of activePositions) {
                try {
                    await clobClient.updateBalanceAllowance({
                        asset_type: AssetType.CONDITIONAL,
                        token_id: pos.asset,
                    });
                    syncedCount++;
                } catch {
                    errorCount++;
                }
            }

            if (errorCount === 0) {
                Logger.success(`✅ All ${syncedCount} position allowances synced`);
            } else {
                Logger.warning(`⚠️ Synced ${syncedCount} allowances, ${errorCount} errors`);
            }
        }

        // Sync positions tracker
        const syncResult = tracker.syncWithRealPositions(myPositions);

        if (syncResult.added === 0 && syncResult.removed === 0 && syncResult.updated === 0) {
            Logger.success('✅ Positions already synchronized');
        } else {
            Logger.success(`✅ Sync complete: +${syncResult.added} added, -${syncResult.removed} removed, ~${syncResult.updated} updated`);
        }

        // Log current state
        const finalPositions = tracker.getAllPositions();
        if (finalPositions.length > 0) {
            Logger.info(`\n📋 Current tracked positions (${finalPositions.length}):`);
            for (const pos of finalPositions.slice(0, 5)) {
                Logger.info(`   • ${pos.market.substring(0, 40)}${pos.market.length > 40 ? '...' : ''} | ${(pos.currentSize || pos.initialSize).toFixed(2)} tokens`);
            }
            if (finalPositions.length > 5) {
                Logger.info(`   ... and ${finalPositions.length - 5} more`);
            }
        }

        Logger.separator();

    } catch (error) {
        Logger.error(`❌ Error syncing positions: ${(error as Error).message}`);
        logBotEvent('ERROR', `Position sync failed: ${(error as Error).message}`);
    }
};

/**
 * Display all current positions
 */
const displayAllPositions = async () => {
    Logger.separator();
    Logger.info('📊 CURRENT POSITIONS');
    Logger.separator();
    
    if (ENV.DRY_RUN) {
        const simTracker = getSimulationTracker();
        const positions = simTracker.getAllPositions();
        
        if (positions.length === 0) {
            Logger.info('📦 No positions currently held');
            Logger.separator();
            return;
        }
        
        let totalValue = 0;
        positions.forEach((pos, index) => {
            const value = pos.size * pos.avgPrice;
            totalValue += value;
            Logger.info(`${index + 1}. ${pos.asset.substring(0, 20)}...`);
            Logger.info(`   Size: ${pos.size.toFixed(2)} tokens | Avg Price: $${pos.avgPrice.toFixed(4)} | Value: $${value.toFixed(2)}`);
        });
        
        Logger.separator();
        Logger.info(`📈 Total positions: ${positions.length}`);
        Logger.info(`💰 Total positions value: $${totalValue.toFixed(2)}`);
        Logger.info(`💵 Current balance: $${simTracker.getCurrentBalance().toFixed(2)}`);
    } else {
        // Real trading mode - fetch REAL positions from Polymarket API
        try {
            const myPositionsUrl = `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`;
            const realPositions = await fetchData(myPositionsUrl);
            
            // Filter for active positions (size > 0)
            const activePositions = realPositions.filter((pos: any) => parseFloat(pos.size) > 0);
            
            if (activePositions.length === 0) {
                Logger.info('📦 No positions currently held');
                Logger.separator();
                return;
            }
            
            let totalValue = 0;
            activePositions.forEach((pos: any, index: number) => {
                const size = parseFloat(pos.size);
                const curPrice = parseFloat(pos.curPrice) || parseFloat(pos.avgPrice) || 0;
                const value = size * curPrice;
                totalValue += value;
                
                const title = pos.title || pos.market || 'Unknown Market';
                Logger.info(`${index + 1}. ${title.substring(0, 50)}${title.length > 50 ? '...' : ''}`);
                Logger.info(`   Outcome: ${pos.outcome || 'N/A'} | Size: ${size.toFixed(2)} tokens | Value: $${value.toFixed(2)}`);
            });
            
            Logger.separator();
            Logger.info(`📈 Total positions: ${activePositions.length}`);
            Logger.info(`💰 Total positions value: $${totalValue.toFixed(2)}`);
        } catch (error) {
            Logger.error(`Failed to fetch positions: ${error}`);
        }
    }
    Logger.separator();
};

/**
 * Sync position allowances with Polymarket cache (runs daily)
 * This ensures the bot can sell positions without "not enough balance/allowance" errors
 */
const syncPositionAllowances = async (clobClient: any) => {
    try {
        Logger.info('🔄 Daily position allowance sync starting...');
        
        const positions = await fetchData(`https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`);
        if (!positions || !Array.isArray(positions) || positions.length === 0) {
            Logger.info('📦 No positions to sync');
            return;
        }
        
        let successCount = 0;
        let errorCount = 0;
        
        for (const position of positions) {
            try {
                await clobClient.updateBalanceAllowance({
                    asset_type: AssetType.CONDITIONAL,
                    token_id: position.asset,
                });
                successCount++;
            } catch {
                errorCount++;
            }
            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        Logger.success(`✅ Position sync complete: ${successCount}/${positions.length} synced`);
        if (errorCount > 0) {
            Logger.warning(`⚠️ ${errorCount} positions failed to sync`);
        }
    } catch (error) {
        Logger.warning(`⚠️ Position sync failed: ${(error as Error).message}`);
    }
};

/**
 * Ask user for confirmation
 */
const askConfirmation = (question: string): Promise<boolean> => {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y');
        });
    });
};

/**
 * Setup keyboard listener for 's' key to sell all positions
 */
let isProcessingKeypress = false;

const setupKeyboardListener = () => {
    // Handle SIGINT (Ctrl+C) at process level - most reliable
    process.on('SIGINT', () => {
        console.log('\n👋 Ctrl+C detected - Exiting immediately...');
        process.exit(0);
    });
    
    // Try to setup raw mode keyboard listener
    const setupRawMode = () => {
        try {
            if (!process.stdin.isTTY) {
                Logger.warning('⚠️ Terminal not in TTY mode - keyboard shortcuts disabled');
                Logger.info('💡 Use Ctrl+C to quit, or run: npm run check-stats to see positions');
                return false;
            }
            
            readline.emitKeypressEvents(process.stdin);
            process.stdin.setRawMode(true);
            process.stdin.resume();
            
            process.stdin.on('keypress', async (str, key) => {
                // Handle Ctrl+C immediately - never block this
                if (key && key.ctrl && key.name === 'c') {
                    console.log('\n👋 Ctrl+C detected - Exiting immediately...');
                    try { process.stdin.setRawMode(false); } catch (e) { /* ignore */ }
                    process.exit(0);
                    return;
                }
                
                // Prevent multiple simultaneous key processing
                if (isProcessingKeypress || isShuttingDown) return;
                
                // Ignore if no key info
                if (!key) return;
                
                // Handle 'l' key to list all positions
                if (key.name === 'l') {
                    isProcessingKeypress = true;
                    displayAllPositions();
                    isProcessingKeypress = false;
                    return;
                }
                
                // Handle 'b' key to reset circuit breaker
                if (key.name === 'b') {
                    isProcessingKeypress = true;
                    const { resetCircuitBreaker, isTradeAllowed, getCircuitBreakerReason } = require('./utils/logAnalyzer');
                    if (!isTradeAllowed()) {
                        Logger.separator();
                        Logger.warning('🔓 Resetting circuit breaker...');
                        Logger.info(`Previous reason: ${getCircuitBreakerReason()}`);
                        resetCircuitBreaker();
                        Logger.success('✅ Circuit breaker reset - Trading resumed!');
                        Logger.separator();
                    } else {
                        Logger.info('ℹ️ Circuit breaker is not active');
                    }
                    isProcessingKeypress = false;
                    return;
                }
                
                // Handle 's' key to sell all positions
                if (key.name === 's') {
                    isProcessingKeypress = true;
                    
                    // Temporarily disable raw mode to allow input
                    try { process.stdin.setRawMode(false); } catch (e) { /* ignore */ }
                    
                    Logger.separator();
                    Logger.warning('⚠️ SELL ALL POSITIONS REQUEST');
                    
                    const confirmed = await askConfirmation('❓ Are you sure you want to sell ALL positions? (yes/no): ');
                    
                    if (confirmed) {
                        await sellAllPositions();
                    } else {
                        Logger.info('❌ Sell cancelled');
                    }
                    
                    // Re-enable raw mode
                    try {
                        if (process.stdin.isTTY) {
                            process.stdin.setRawMode(true);
                        }
                    } catch (e) { /* ignore */ }
                    
                    isProcessingKeypress = false;
                }
            });
            
            return true;
        } catch (error) {
            Logger.warning(`⚠️ Could not setup keyboard listener: ${(error as Error).message}`);
            return false;
        }
    };
    
    const keyboardEnabled = setupRawMode();
    
    if (keyboardEnabled) {
        Logger.info('⌨️ Press "l" to list positions, "s" to sell all, "b" to reset circuit breaker, Ctrl+C to quit');
    }
};

const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) {
        Logger.warning('Shutdown already in progress, forcing exit...');
        process.exit(1);
    }

    isShuttingDown = true;
    Logger.separator();
    Logger.info(`Received ${signal}, initiating graceful shutdown...`);

    try {
        // Stop services
        stopTradeMonitor();
        stopTradeExecutor();
        
        // Stop position monitoring if running
        stopPositionMonitoring();

        // Give services time to finish current operations
        Logger.info('Waiting for services to finish current operations...');
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Display final simulation summary WITHOUT liquidating positions
        if (ENV.DRY_RUN) {
            const simTracker = getSimulationTracker();
            
            // Get current value (cash + positions)
            const currentCash = simTracker.getCurrentBalance();
            const positionsValue = simTracker.getPositionsValue();
            const totalValue = currentCash + positionsValue;
            const positions = simTracker.getAllPositions();
            
            // Show final summary WITHOUT selling
            Logger.separator();
            Logger.success('🎯 BOT STOPPED - POSITIONS KEPT');
            Logger.info(`💵 Cash balance: $${currentCash.toFixed(2)}`);
            Logger.info(`📊 Positions value: $${positionsValue.toFixed(2)} (${positions.length} positions)`);
            Logger.info(`💰 Total portfolio: $${totalValue.toFixed(2)}`);
            Logger.success(`📈 Net profit/loss: ${totalValue >= simTracker.getStartingBalance() ? '+' : ''}$${(totalValue - simTracker.getStartingBalance()).toFixed(2)}`);
            Logger.info('💡 Positions will be restored when you restart the bot');
            Logger.separator();
            
            // Generate final reports (without closing positions)
            simTracker.generateChart();
            simTracker.generateHTMLReport();
            simTracker.generateTextReport();
        }

        // Close database connection
        await closeDB();

        Logger.success('Graceful shutdown completed');
        process.exit(0);
    } catch (error) {
        Logger.error(`Error during shutdown: ${error}`);
        process.exit(1);
    }
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    Logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
    // Don't exit immediately, let the application try to recover
});

// Handle uncaught exceptions
process.on('uncaughtException', (error: Error) => {
    Logger.error(`Uncaught Exception: ${error.message}`);
    // Exit immediately for uncaught exceptions as the application is in an undefined state
    gracefulShutdown('uncaughtException').catch(() => {
        process.exit(1);
    });
});

// Handle termination signals (SIGINT is handled by keyboard listener when TTY is available)
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
// Fallback for non-TTY environments (like Docker, scripts)
if (!process.stdin.isTTY) {
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

export const main = async () => {
    try {
        // Initialize log analyzer first (clears problems.txt)
        initializeLogAnalyzer();
        
        // Check if there were problems from previous session
        const analyzer = getLogAnalyzer();
        const previousProblems = analyzer.readProblems();
        if (previousProblems) {
            console.log('\n⚠️ Des problèmes ont été détectés lors de la session précédente.');
        }
        
        // Welcome message for first-time users
        const colors = {
            reset: '\x1b[0m',
            yellow: '\x1b[33m',
            cyan: '\x1b[36m',
            red: '\x1b[31m',
            green: '\x1b[32m',
        };
        
        console.log(`\n${colors.yellow}💡 First time running the bot?${colors.reset}`);
        console.log(`   Read the guide: ${colors.cyan}GETTING_STARTED.md${colors.reset}`);
        console.log(`   Run health check: ${colors.cyan}npm run health-check${colors.reset}\n`);
        
        // ============================================
        // REAL MONEY WARNING
        // ============================================
        if (!ENV.DRY_RUN) {
            console.log(`\n${colors.red}╔════════════════════════════════════════════════════════════════╗${colors.reset}`);
            console.log(`${colors.red}║                    🔴 REAL TRADING MODE 🔴                     ║${colors.reset}`);
            console.log(`${colors.red}╠════════════════════════════════════════════════════════════════╣${colors.reset}`);
            console.log(`${colors.red}║  ⚠️  DRY_RUN=false - This bot will execute REAL trades!        ║${colors.reset}`);
            console.log(`${colors.red}║  ⚠️  Real money will be used. You may lose funds.              ║${colors.reset}`);
            console.log(`${colors.red}║                                                                ║${colors.reset}`);
            console.log(`${colors.red}║  💡 RECOMMENDATIONS:                                           ║${colors.reset}`);
            console.log(`${colors.red}║     • Start with small amounts ($50-100)                       ║${colors.reset}`);
            console.log(`${colors.red}║     • Set COPY_SIZE to a low value (e.g., 5-10)                ║${colors.reset}`);
            console.log(`${colors.red}║     • Set MAX_OPEN_POSITIONS to limit exposure                 ║${colors.reset}`);
            console.log(`${colors.red}║     • Monitor the bot closely for the first few hours          ║${colors.reset}`);
            console.log(`${colors.red}║                                                                ║${colors.reset}`);
            console.log(`${colors.red}║  Press Ctrl+C now if you want to cancel.                       ║${colors.reset}`);
            console.log(`${colors.red}╚════════════════════════════════════════════════════════════════╝${colors.reset}\n`);
            
            // Give user 5 seconds to cancel
            console.log(`${colors.yellow}⏳ Starting in 5 seconds...${colors.reset}`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            console.log(`${colors.green}✅ Starting real trading mode...${colors.reset}\n`);
        }
        
        await connectDB();
        Logger.initLogFile(); // Clear log file and start fresh for this session
        Logger.startup(USER_ADDRESSES, PROXY_WALLET);

        // Perform initial health check
        Logger.info('Performing initial health check...');
        const healthResult = await performHealthCheck();
        logHealthCheck(healthResult);

        if (!healthResult.healthy) {
            Logger.warning('Health check failed, but continuing startup...');
            logBotEvent('WARNING', 'Health check failed at startup', { healthResult });
        }

        // Synchronize positions with Polymarket (real mode only)
        await syncPositionsWithPolymarket();

        Logger.info('Initializing CLOB client...');
        const clobClient = await createClobClient();
        Logger.success('CLOB client ready');

        Logger.separator();
        Logger.info('Starting trade monitor...');
        tradeMonitor();

        // Attendre que isFirstRun soit terminé avant de lancer tradeExecutor
        // → évite la race condition qui cause le flood de "stale trade" au démarrage
        Logger.info('Waiting for historical trades to be marked as processed...');
        await firstRunComplete;

        Logger.info('Starting trade executor...');
        tradeExecutor(clobClient);

        // Start automatic position alignment monitoring (hourly cleanup)
        Logger.info('Starting position alignment monitoring...');
        await startPositionMonitoring();

        // Setup keyboard listener for 's' key
        setupKeyboardListener();

        // Display simulation summary every 5 minutes if in DRY_RUN mode
        if (ENV.DRY_RUN) {
            // Initial balance update - use TOTAL VALUE (cash + positions) for circuit breaker
            const simTracker = getSimulationTracker();
            const initialTotalValue = simTracker.getCurrentBalance() + simTracker.getPositionsValue();
            updateBotBalance(initialTotalValue);

            // Affichage immédiat du résumé au démarrage
            simTracker.printSummary();

            // Update balance every minute for circuit breaker
            setInterval(() => {
                // IMPORTANT: Circuit breaker must use TOTAL portfolio value, not just cash
                const totalValue = simTracker.getCurrentBalance() + simTracker.getPositionsValue();
                updateBotBalance(totalValue);
            }, 60 * 1000); // Every minute

            // Mark-to-market: fetch real prices every 5 minutes
            setInterval(async () => {
                try {
                    await simTracker.updateMarkToMarket();
                    // Update circuit breaker with mark-to-market portfolio value
                    const totalValue = simTracker.getCurrentBalance() + simTracker.getPositionsValue();
                    updateBotBalance(totalValue);
                } catch (error) {
                    Logger.warning(`[MtM] Failed to update prices: ${(error as Error).message}`);
                }
            }, 5 * 60 * 1000); // Every 5 minutes

            // Premier graphique après 1 minute (donne le temps d'accumuler 2+ snapshots)
            setTimeout(() => {
                simTracker.recordSnapshot();
                simTracker.printSummary();
                simTracker.generateChart();
            }, 60 * 1000); // Après 1 minute

            // Puis toutes les 5 minutes
            setInterval(() => {
                simTracker.recordSnapshot(); // Force un snapshot même sans positions (requis pour le graphique)
                simTracker.printSummary();
                simTracker.generateChart();
            }, 5 * 60 * 1000); // Every 5 minutes

            // Live position comparison every 5 minutes (after 2 min warmup)
            setTimeout(() => {
                displayLiveComparison();
                setInterval(() => displayLiveComparison(), 5 * 60 * 1000);
            }, 2 * 60 * 1000);
        } else {
            // Real trading mode - periodic balance update for circuit breaker
            const getMyBalance = (await import('./utils/getMyBalance')).default;
            
            // Function to get positions value
            const getPositionsValue = async (): Promise<number> => {
                try {
                    const positionsUrl = `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`;
                    const positions = await fetchData(positionsUrl);
                    if (!positions || !Array.isArray(positions)) return 0;
                    return positions.reduce((sum: number, pos: any) => {
                        return sum + (pos.currentValue || 0);
                    }, 0);
                } catch {
                    return 0;
                }
            };
            
            // Initial balance update - use TOTAL VALUE (cash + positions) for circuit breaker
            const initialBalance = await getMyBalance(PROXY_WALLET);
            const initialPositionsValue = await getPositionsValue();
            const initialTotalValue = initialBalance + initialPositionsValue;
            updateBotBalance(initialTotalValue); // Circuit breaker uses total portfolio
            Logger.info(`💰 Initial USDC balance: $${initialBalance.toFixed(2)}`);
            
            // Track balance history for chart
            const balanceHistory: { timestamp: number; balance: number; positionsValue: number }[] = [];
            const startTime = Date.now();
            
            // Add initial snapshot for chart - use TOTAL portfolio value as starting point
            const startingBalance = initialBalance + initialPositionsValue; // TOTAL portfolio, not just cash
            balanceHistory.push({
                timestamp: Date.now(),
                balance: initialBalance,
                positionsValue: initialPositionsValue
            });
            Logger.info(`📊 Initial portfolio: $${initialBalance.toFixed(2)} cash + $${initialPositionsValue.toFixed(2)} positions = $${(initialBalance + initialPositionsValue).toFixed(2)} total`);
            
            // Function to print real money summary with chart
            const printRealMoneySummary = async () => {
                try {
                    const currentBalance = await getMyBalance(PROXY_WALLET);
                    const positionsValue = await getPositionsValue();
                    const totalValue = currentBalance + positionsValue;
                    
                    // Add to history
                    balanceHistory.push({
                        timestamp: Date.now(),
                        balance: currentBalance,
                        positionsValue: positionsValue
                    });
                    
                    // Keep last 100 snapshots
                    if (balanceHistory.length > 100) {
                        balanceHistory.shift();
                    }
                    
                    // Calculate stats
                    const profit = totalValue - startingBalance;
                    const profitPercent = ((profit / startingBalance) * 100).toFixed(2);
                    const duration = Date.now() - startTime;
                    const hours = Math.floor(duration / (1000 * 60 * 60));
                    const minutes = Math.floor((duration % (1000 * 60 * 60)) / (1000 * 60));
                    
                    const peakValue = Math.max(...balanceHistory.map(h => h.balance + h.positionsValue), startingBalance);
                    const lowestValue = Math.min(...balanceHistory.map(h => h.balance + h.positionsValue), startingBalance);
                    
                    // Print summary
                    console.log('──────────────────────────────────────────────────────────────────────');
                    Logger.info('💵 REAL MONEY SUMMARY');
                    Logger.info(`💰 Starting Balance: $${startingBalance.toFixed(2)}`);
                    Logger.info(`💵 Current Cash:     $${currentBalance.toFixed(2)}`);
                    Logger.info(`📊 Positions Value:  $${positionsValue.toFixed(2)}`);
                    Logger.info(`💎 Total Value:      $${totalValue.toFixed(2)}`);
                    if (profit >= 0) {
                        Logger.success(`📈 Profit/Loss:     +$${profit.toFixed(2)} (+${profitPercent}%)`);
                    } else {
                        Logger.error(`📉 Profit/Loss:     -$${Math.abs(profit).toFixed(2)} (${profitPercent}%)`);
                    }
                    console.log('──────────────────────────────────────────────────────────────────────');
                    
                    // Generate chart
                    Logger.info('📊 BALANCE EVOLUTION CHART');
                    console.log('──────────────────────────────────────────────────────────────────────');
                    Logger.info(`📅 Session Duration: ${hours}h ${minutes}m`);
                    Logger.info(`💰 Starting Value: $${startingBalance.toFixed(2)}`);
                    Logger.info(`💵 Current Value:  $${totalValue.toFixed(2)}`);
                    if (profit >= 0) {
                        Logger.success(`🟢 Profit/Loss:   +$${profit.toFixed(2)} (+${profitPercent}%)`);
                    } else {
                        Logger.error(`🔴 Profit/Loss:   -$${Math.abs(profit).toFixed(2)} (${profitPercent}%)`);
                    }
                    Logger.info(`📈 Peak Value:     $${peakValue.toFixed(2)}`);
                    Logger.info(`📉 Lowest Value:   $${lowestValue.toFixed(2)}`);
                    
                    // Simple ASCII line chart (only if we have enough data points)
                    if (balanceHistory.length >= 2) {
                        const values = balanceHistory.map(h => h.balance + h.positionsValue);
                        const maxVal = Math.max(...values);
                        const minVal = Math.min(...values);
                        const range = maxVal - minVal || 1;
                        const chartHeight = 8;
                        const chartWidth = Math.max(15, Math.min(50, values.length)); // Minimum 15 columns
                        
                        // Map values to rows (0 = bottom, chartHeight = top)
                        const scaledValues: number[] = [];
                        for (let col = 0; col < chartWidth; col++) {
                            const idx = Math.floor(col * values.length / chartWidth);
                            const val = values[idx];
                            const row = Math.round(((val - minVal) / range) * chartHeight);
                            scaledValues.push(row);
                        }
                        
                        console.log('');
                        for (let row = chartHeight; row >= 0; row--) {
                            let label = '';
                            if (row === chartHeight) label = `$${maxVal.toFixed(0).padStart(6)}`;
                            else if (row === 0) label = `$${minVal.toFixed(0).padStart(6)}`;
                            else if (row === Math.floor(chartHeight / 2)) {
                                const midVal = (maxVal + minVal) / 2;
                                label = `$${midVal.toFixed(0).padStart(6)}`;
                            }
                            else label = '       ';
                            
                            let line = label + ' │';
                            
                            for (let col = 0; col < chartWidth; col++) {
                                const valRow = scaledValues[col];
                                const nextValRow = col < chartWidth - 1 ? scaledValues[col + 1] : valRow;
                                
                                if (valRow === row) {
                                    // Draw point at this position
                                    if (col < chartWidth - 1 && nextValRow > row) {
                                        line += '╱'; // Going up
                                    } else if (col < chartWidth - 1 && nextValRow < row) {
                                        line += '╲'; // Going down
                                    } else {
                                        line += '─'; // Horizontal
                                    }
                                } else if (valRow < row && nextValRow > row) {
                                    line += '│'; // Vertical crossing up
                                } else if (valRow > row && nextValRow < row) {
                                    line += '│'; // Vertical crossing down
                                } else {
                                    line += ' ';
                                }
                            }
                            console.log(line);
                        }
                        console.log('       └' + '─'.repeat(chartWidth + 1));
                        const spacing = Math.max(0, chartWidth - 12);
                        console.log(`        Start${' '.repeat(spacing)}Now`);
                    }
                    
                    console.log('──────────────────────────────────────────────────────────────────────');
                    Logger.info(`📊 Total Snapshots: ${balanceHistory.length}`);
                    console.log('──────────────────────────────────────────────────────────────────────');
                    
                } catch (error) {
                    Logger.warning(`Failed to print summary: ${(error as Error).message}`);
                }
            };
            
            // Update balance every 2 minutes for circuit breaker
            // IMPORTANT: Circuit breaker must use TOTAL portfolio value (cash + positions), not just cash
            setInterval(async () => {
                try {
                    const currentBalance = await getMyBalance(PROXY_WALLET);
                    const currentPositionsValue = await getPositionsValue();
                    const totalValue = currentBalance + currentPositionsValue;
                    updateBotBalance(totalValue); // Circuit breaker uses total portfolio
                } catch (error) {
                    Logger.warning(`Failed to update balance: ${(error as Error).message}`);
                }
            }, 2 * 60 * 1000); // Every 2 minutes
            
            // Print first summary after 1 minute, then every 5 minutes
            setTimeout(printRealMoneySummary, 1 * 60 * 1000); // First display after 1 minute
            setInterval(printRealMoneySummary, 5 * 60 * 1000); // Then every 5 minutes

            // Live position comparison every 5 minutes (after 2 min warmup)
            setTimeout(() => {
                displayLiveComparison();
                setInterval(() => displayLiveComparison(), 5 * 60 * 1000);
            }, 2 * 60 * 1000);

            // Sync position allowances every 24 hours (prevents "not enough balance/allowance" sell errors)
            Logger.info('🔄 Daily position sync enabled (every 24h)');
            setInterval(() => syncPositionAllowances(clobClient), 24 * 60 * 60 * 1000);
            
            // Also run initial sync after 5 minutes (gives time for startup)
            setTimeout(() => syncPositionAllowances(clobClient), 5 * 60 * 1000);
        }

        // test(clobClient);
    } catch (error) {
        Logger.error(`Fatal error during startup: ${error}`);
        logBotEvent('ERROR', `Fatal error during startup: ${error}`);
        await gracefulShutdown('startup-error');
    }
};

// Run main if this file is executed directly
if (require.main === module) {
    main();
}
