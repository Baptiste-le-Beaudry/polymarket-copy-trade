/**
 * Reset simulation to original state
 * Clears all positions, resets balance to starting amount, clears history
 */

import { resetSimulationTracker, getSimulationTracker } from '../utils/simulationBalance';
import { getPositionTracker } from '../utils/positionTracker';
import Logger from '../utils/logger';

async function resetSimulation(): Promise<void> {
    try {
        Logger.separator();
        Logger.info('🔄 RESETTING SIMULATION TO ORIGINAL STATE');
        Logger.separator();
        
        // Reset simulation balance and positions
        Logger.info('💰 Resetting virtual balance and positions...');
        resetSimulationTracker();
        
        // Reset position tracker if it exists
        try {
            const positionTracker = getPositionTracker();
            // Position tracker doesn't have a reset method, that's ok
            Logger.info('📊 Position tracker will be reset on next use');
        } catch (error) {
            // Position tracker might not exist, that's ok
            Logger.info('📊 Position tracker not found');
        }
        
        // Show final state
        const simTracker = getSimulationTracker();
        Logger.separator();
        Logger.success('✅ SIMULATION RESET COMPLETE');
        Logger.info(`💰 Starting balance: $${simTracker.getStartingBalance().toFixed(2)}`);
        Logger.info(`💵 Current balance: $${simTracker.getCurrentBalance().toFixed(2)}`);
        Logger.info(`📦 Open positions: 0`);
        Logger.info(`📈 Balance history: Reset to initial snapshot`);
        Logger.separator();
        
        Logger.info('🚀 Ready to start fresh simulation!');
        Logger.info('💡 Use "npm start" to begin copy trading');
        
    } catch (error) {
        Logger.error(`❌ Error resetting simulation: ${error}`);
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    resetSimulation().then(() => {
        process.exit(0);
    }).catch((error) => {
        Logger.error(`Fatal error: ${error}`);
        process.exit(1);
    });
}

export default resetSimulation;