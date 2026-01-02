/**
 * Display the current simulation balance chart
 * Usage: npm run chart
 */

import { getSimulationTracker } from '../utils/simulationBalance';
import Logger from '../utils/logger';

const showChart = () => {
    try {
        const simTracker = getSimulationTracker();
        
        Logger.separator();
        Logger.info('📊 SIMULATION CHART');
        Logger.separator();
        
        simTracker.printSummary();
        simTracker.generateChart();
        
        process.exit(0);
    } catch (error) {
        Logger.error(`Error displaying chart: ${error}`);
        process.exit(1);
    }
};

showChart();
