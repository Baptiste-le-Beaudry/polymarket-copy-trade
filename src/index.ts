import connectDB, { closeDB } from './config/db';
import { ENV } from './config/env';
import createClobClient from './utils/createClobClient';
import tradeExecutor, { stopTradeExecutor } from './services/tradeExecutor';
import tradeMonitor, { stopTradeMonitor } from './services/tradeMonitor';
import Logger from './utils/logger';
import { performHealthCheck, logHealthCheck } from './utils/healthCheck';
import test from './test/test';
import { getSimulationTracker } from './utils/simulationBalance';
import { startPositionMonitoring, stopPositionMonitoring } from './scripts/analyzePositionAlignment';
import * as readline from 'readline';

const USER_ADDRESSES = ENV.USER_ADDRESSES;
const PROXY_WALLET = ENV.PROXY_WALLET;

// Graceful shutdown handler
let isShuttingDown = false;

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
        Logger.warning('⚠️ Real trading mode - manual sell not implemented yet');
        // TODO: Implement real sell for live trading
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
const setupKeyboardListener = () => {
    if (process.stdin.isTTY) {
        readline.emitKeypressEvents(process.stdin);
        process.stdin.setRawMode(true);
        
        process.stdin.on('keypress', async (str, key) => {
            // Handle Ctrl+C
            if (key.ctrl && key.name === 'c') {
                await gracefulShutdown('SIGINT');
                return;
            }
            
            // Handle 's' key to sell all positions
            if (key.name === 's' && !isShuttingDown) {
                // Temporarily disable raw mode to allow input
                process.stdin.setRawMode(false);
                
                Logger.separator();
                Logger.warning('⚠️ SELL ALL POSITIONS REQUEST');
                
                const confirmed = await askConfirmation('❓ Are you sure you want to sell ALL positions? (yes/no): ');
                
                if (confirmed) {
                    await sellAllPositions();
                } else {
                    Logger.info('❌ Sell cancelled');
                }
                
                // Re-enable raw mode
                if (process.stdin.isTTY) {
                    process.stdin.setRawMode(true);
                }
            }
        });
        
        Logger.info('⌨️ Press "s" to sell all positions, Ctrl+C to quit (positions will be kept)');
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
        // Welcome message for first-time users
        const colors = {
            reset: '\x1b[0m',
            yellow: '\x1b[33m',
            cyan: '\x1b[36m',
        };
        
        console.log(`\n${colors.yellow}💡 First time running the bot?${colors.reset}`);
        console.log(`   Read the guide: ${colors.cyan}GETTING_STARTED.md${colors.reset}`);
        console.log(`   Run health check: ${colors.cyan}npm run health-check${colors.reset}\n`);
        
        await connectDB();
        Logger.startup(USER_ADDRESSES, PROXY_WALLET);

        // Perform initial health check
        Logger.info('Performing initial health check...');
        const healthResult = await performHealthCheck();
        logHealthCheck(healthResult);

        if (!healthResult.healthy) {
            Logger.warning('Health check failed, but continuing startup...');
        }

        Logger.info('Initializing CLOB client...');
        const clobClient = await createClobClient();
        Logger.success('CLOB client ready');

        Logger.separator();
        Logger.info('Starting trade monitor...');
        tradeMonitor();

        Logger.info('Starting trade executor...');
        tradeExecutor(clobClient);

        // Start automatic position alignment monitoring (hourly cleanup)
        Logger.info('Starting position alignment monitoring...');
        await startPositionMonitoring();

        // Setup keyboard listener for 's' key
        setupKeyboardListener();

        // Display simulation summary every 5 minutes if in DRY_RUN mode
        if (ENV.DRY_RUN) {
            setInterval(() => {
                const simTracker = getSimulationTracker();
                simTracker.printSummary();
                simTracker.generateChart();
            }, 5 * 60 * 1000); // Every 5 minutes
        }

        // test(clobClient);
    } catch (error) {
        Logger.error(`Fatal error during startup: ${error}`);
        await gracefulShutdown('startup-error');
    }
};

// Run main if this file is executed directly
if (require.main === module) {
    main();
}
