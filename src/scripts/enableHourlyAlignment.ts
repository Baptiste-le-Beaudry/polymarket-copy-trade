/**
 * Enable automatic hourly position alignment monitoring
 * Add this to your main bot to auto-sell abandoned positions every hour
 */

import { startPositionMonitoring, stopPositionMonitoring } from './analyzePositionAlignment';
import Logger from '../utils/logger';

// Function to gracefully handle shutdown
process.on('SIGINT', () => {
    Logger.info('🛑 Stopping hourly position monitoring...');
    stopPositionMonitoring();
    process.exit(0);
});

process.on('SIGTERM', () => {
    Logger.info('🛑 Stopping hourly position monitoring...');
    stopPositionMonitoring();
    process.exit(0);
});

// Start monitoring
const startMonitoring = async () => {
    try {
        Logger.separator();
        Logger.info('🚀 HOURLY POSITION ALIGNMENT MONITOR');
        Logger.separator();
        Logger.info('📋 RULE: Auto-sells positions when ZERO traders hold them');
        Logger.info('✅ Ignores size differences (normal)');
        Logger.info('✅ Ignores position count differences (normal)');
        Logger.info('⏰ Checks every hour automatically');
        Logger.separator();
        
        await startPositionMonitoring();
        
        // Keep the process running
        Logger.info('📡 Monitoring active - press Ctrl+C to stop');
        Logger.separator();
        
        // Keep process alive
        setInterval(() => {
            // Do nothing, just keep alive
        }, 1000);
        
    } catch (error) {
        Logger.error(`Failed to start position monitoring: ${error}`);
        process.exit(1);
    }
};

startMonitoring();