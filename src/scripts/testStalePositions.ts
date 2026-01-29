#!/usr/bin/env ts-node

import dotenv from 'dotenv';
dotenv.config();

import Logger from '../utils/logger';
import { getSimulationTracker } from '../utils/simulationBalance';

async function testStalePositions() {
    try {
        Logger.info('🧪 Testing stale positions detection...');
        
        const simTracker = getSimulationTracker();
        
        // Create a fake old position by modifying the openedAt timestamp
        const asset = 'test-asset-123';
        const twoDaysAgo = Date.now() - (2 * 24 * 60 * 60 * 1000);
        
        // Add position manually with old timestamp
        simTracker['positions'].set(asset, {
            size: 100,
            avgPrice: 0.5,
            openedAt: twoDaysAgo,
            market: 'Test Market - Old Position'
        });
        
        Logger.info(`📊 Created test position from 2 days ago`);
        
        // Check for stale positions (1 day threshold)
        const stalePositions = simTracker.getOldPositions(1);
        
        Logger.info(`🔍 Found ${stalePositions.length} stale positions:`);
        stalePositions.forEach((pos, index) => {
            const ageHours = Math.floor((Date.now() - pos.openedAt) / (60 * 60 * 1000));
            Logger.info(`  ${index + 1}. ${pos.market || pos.asset} - ${pos.size} tokens @ $${pos.avgPrice} (${ageHours}h old)`);
        });
        
        if (stalePositions.length > 0) {
            Logger.success('✅ Stale position detection is working!');
        } else {
            Logger.error('❌ No stale positions detected - something is wrong');
        }
        
    } catch (error) {
        Logger.error(`❌ Test failed: ${(error as Error).message}`);
    }
}

testStalePositions();