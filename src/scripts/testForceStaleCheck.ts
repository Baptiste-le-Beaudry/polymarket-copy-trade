#!/usr/bin/env ts-node

import dotenv from 'dotenv';
dotenv.config();

import Logger from '../utils/logger';
import { getSimulationTracker } from '../utils/simulationBalance';

async function forceStaleCheck() {
    try {
        Logger.info('🧪 Forcing stale positions check...');
        
        const simTracker = getSimulationTracker();
        
        // Get current positions
        const allPositions = simTracker.getAllPositions();
        Logger.info(`📊 Found ${allPositions.length} total positions`);
        
        // Check for stale positions (1 day threshold)
        const stalePositions = simTracker.getOldPositions(1);
        Logger.info(`🔍 Found ${stalePositions.length} positions older than 1 day`);
        
        if (stalePositions.length > 0) {
            Logger.warning(`⚠️ [SIMULATION] Found ${stalePositions.length} stale positions (older than 1 days)`);
            Logger.info('🔄 [SIMULATION] Auto-selling stale positions...');
            
            let soldCount = 0;
            for (const stalePos of stalePositions) {
                const ageHours = Math.floor((Date.now() - stalePos.openedAt) / (60 * 60 * 1000));
                Logger.info(`📉 [SIMULATION] Selling stale position: ${stalePos.asset} (${stalePos.size?.toFixed(2) || '0'} tokens @ $${stalePos.avgPrice?.toFixed(4) || '0'}) - ${ageHours}h old`);
                
                // Sell the position
                simTracker.sell(stalePos.asset, stalePos.size || 0, stalePos.avgPrice || 0);
                soldCount++;
            }
            
            if (soldCount > 0) {
                Logger.success(`✅ [SIMULATION] Auto-sold ${soldCount} stale positions`);
            }
        } else {
            Logger.success('✅ [SIMULATION] No stale positions found (older than 1 days)');
        }
        
        // Show remaining positions
        const remainingPositions = simTracker.getAllPositions();
        Logger.info(`📦 Remaining positions: ${remainingPositions.length}`);
        
    } catch (error) {
        Logger.error(`❌ Error during stale check: ${(error as Error).message}`);
        console.error(error);
    }
}

forceStaleCheck();