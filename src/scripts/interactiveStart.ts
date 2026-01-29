/**
 * Interactive startup script with simulation reset option
 */

import { resetSimulationTracker, getSimulationTracker } from '../utils/simulationBalance';
import Logger from '../utils/logger';
import { main as originalMain } from '../index';
import * as readline from 'readline';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function askQuestion(question: string): Promise<string> {
    return new Promise((resolve) => {
        rl.question(question, resolve);
    });
}

async function interactiveStart(): Promise<void> {
    try {
        // Check current simulation state
        const simTracker = getSimulationTracker();
        const currentBalance = simTracker.getCurrentBalance();
        const positionsValue = simTracker.getPositionsValue();
        const totalValue = currentBalance + positionsValue;
        const startingBalance = simTracker.getStartingBalance();
        
        // Show current state
        Logger.separator();
        Logger.info('🎯 POLYMARKET COPY TRADING BOT');
        Logger.separator();
        
        Logger.info('📊 CURRENT SIMULATION STATE:');
        Logger.info(`💰 Starting balance: $${startingBalance.toFixed(2)}`);
        Logger.info(`💵 Current cash: $${currentBalance.toFixed(2)}`);
        Logger.info(`📦 Positions value: $${positionsValue.toFixed(2)}`);
        Logger.info(`📈 Total value: $${totalValue.toFixed(2)}`);
        
        const pnl = totalValue - startingBalance;
        const pnlPercent = ((pnl) / startingBalance) * 100;
        const pnlColor = pnl >= 0 ? '🟢' : '🔴';
        Logger.info(`${pnlColor} Profit/Loss: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)`);
        
        Logger.separator();
        
        // Ask if user wants to reset
        if (currentBalance < 10 || positionsValue > 0) {
            console.log('💡 RESET OPTIONS:');
            console.log('   1. Continue with current state');
            console.log('   2. Reset to fresh simulation ($' + startingBalance.toFixed(2) + ', 0 positions)');
            console.log('');
            
            const choice = await askQuestion('Choose option (1 or 2): ');
            
            if (choice.trim() === '2') {
                Logger.separator();
                Logger.info('🔄 RESETTING SIMULATION...');
                
                // Reset simulation
                resetSimulationTracker();
                
                const newTracker = getSimulationTracker();
                Logger.success('✅ SIMULATION RESET COMPLETE');
                Logger.info(`💰 Balance reset to: $${newTracker.getCurrentBalance().toFixed(2)}`);
                Logger.info(`📦 Positions cleared: 0`);
                Logger.info(`📈 History cleared: Fresh start`);
                Logger.separator();
            }
        }
        
        rl.close();
        
        // Start the bot
        Logger.info('🚀 Starting copy trading bot...');
        Logger.separator();
        
        await originalMain();
        
    } catch (error) {
        rl.close();
        Logger.error(`❌ Error in interactive startup: ${error}`);
        process.exit(1);
    }
}

// Export for use by index.js
export { interactiveStart };

// Run if called directly
if (require.main === module) {
    interactiveStart().catch((error) => {
        Logger.error(`Fatal error: ${error}`);
        process.exit(1);
    });
}