/**
 * Reset simulation to original state
 * Clears all positions, resets balance to starting amount, clears history
 */

import { resetSimulationTracker, getSimulationTracker } from '../utils/simulationBalance';
import { resetPositionTracker } from '../utils/positionTracker';
import Logger from '../utils/logger';
import * as fs from 'fs';
import * as path from 'path';

async function resetSimulation(): Promise<void> {
    try {
        Logger.separator();
        Logger.info('🔄 RESETTING SIMULATION TO ORIGINAL STATE');
        Logger.separator();
        
        // Reset simulation balance and positions
        Logger.info('💰 Resetting virtual balance and positions...');
        resetSimulationTracker();
        
        // Reset position tracker and trade history
        Logger.info('📊 Clearing position tracker and trade history...');
        resetPositionTracker();
        
        // Also clear the files directly to be sure
        const dataDir = path.join(process.cwd(), 'data');
        const positionsFile = path.join(dataDir, 'positions.json');
        const historyFile = path.join(dataDir, 'trade_history.json');
        
        if (fs.existsSync(positionsFile)) {
            fs.writeFileSync(positionsFile, JSON.stringify({ positions: {}, lastUpdated: Date.now() }, null, 2));
            Logger.info('🗑️ Cleared positions.json');
        }
        
        if (fs.existsSync(historyFile)) {
            fs.writeFileSync(historyFile, JSON.stringify({
                trades: [],
                totalBuys: 0,
                totalSells: 0,
                totalVolume: 0,
                realizedPnL: 0,
                lastUpdated: Date.now(),
            }, null, 2));
            Logger.info('🗑️ Cleared trade_history.json');
        }

        // CRITICAL FIX: Also delete simulation_state.json to prevent positions from being restored
        const simulationStateFile = path.join(dataDir, 'simulation_state.json');
        if (fs.existsSync(simulationStateFile)) {
            fs.unlinkSync(simulationStateFile);
            Logger.info('🗑️ Deleted simulation_state.json (prevents position resurrection)');
        }

        // Show final state
        const simTracker = getSimulationTracker();
        Logger.separator();
        Logger.success('✅ SIMULATION RESET COMPLETE');
        Logger.info(`💰 Starting balance: $${simTracker.getStartingBalance().toFixed(2)}`);
        Logger.info(`💵 Current balance: $${simTracker.getCurrentBalance().toFixed(2)}`);
        Logger.info(`📦 Open positions: 0`);
        Logger.info(`📈 Balance history: Reset to initial snapshot`);
        Logger.info(`📜 Trade history: Cleared`);
        Logger.separator();
        
        Logger.info('🚀 Ready to start fresh simulation!');
        Logger.info('💡 Use "npm run dev" to begin copy trading');
        
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