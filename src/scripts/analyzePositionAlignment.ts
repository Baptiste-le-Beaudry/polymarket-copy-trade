/**
 * Analyze if traders still hold positions that the bot is holding
 * AUTO-SELLS positions that ZERO traders hold (complete abandonment)
 * Ignores size differences - only cares about presence/absence
 * Runs automatically every hour when integrated
 */

import createClobClient from '../utils/createClobClient';
import { getSimulationTracker } from '../utils/simulationBalance';
import { getPositionTracker } from '../utils/positionTracker';
import Logger from '../utils/logger';
import { ENV } from '../config/env';

interface TraderPosition {
    trader: string;
    asset: string;
    size: number;
    value: number;
    market: string;
}

interface BotPosition {
    asset: string;
    size: number;
    avgPrice: number;
    value: number;
    openedAt?: Date; // Track when position was opened
}

interface AbandonedPosition {
    asset: string;
    position: BotPosition;
    reason: string;
}

// Configuration  
const POSITION_GRACE_PERIOD_HOURS = 24; // Backup system: only sell truly abandoned positions (24h+ old)

// Global variable to track if monitoring is active
let isMonitoring = false;
let monitorInterval: NodeJS.Timeout | null = null;

async function sellAbandonedPosition(asset: string, position: BotPosition): Promise<void> {
    try {
        Logger.warning(`🗑️ Auto-selling ABANDONED position: ${asset.slice(0, 12)}... ($${position.value.toFixed(2)})`);
        Logger.info(`   Reason: NO traders hold this asset anymore`);
        
        // Get simulation tracker and sell the position
        const simTracker = getSimulationTracker();
        
        // For FIXED_TOKENS strategy, sell all tokens at once since position is abandoned
        const tokensToSell = position.size;
        
        // Use current average price as sell price (in real scenario you'd get market price)
        const sellPrice = position.avgPrice;
        
        simTracker.sell(asset, tokensToSell, sellPrice);
        
        // Also update position tracker
        const positionTracker = getPositionTracker();
        const conditionId = asset; // Using asset as conditionId for simplicity
        positionTracker.trackSell(conditionId, tokensToSell, sellPrice, tokensToSell * sellPrice);
        
        Logger.success(`✅ Sold abandoned position: ${tokensToSell.toFixed(2)} tokens @ $${sellPrice.toFixed(4)} = $${(tokensToSell * sellPrice).toFixed(2)}`);
        
    } catch (error) {
        Logger.error(`❌ Failed to sell abandoned position ${asset}: ${error}`);
    }
}

async function analyzePositionAlignment(): Promise<{ abandonedCount: number; abandonedValue: number }> {
    try {
        const startTime = new Date();
        Logger.info(`🔍 Checking position alignment @ ${startTime.toLocaleTimeString()}...`);

        // Get bot's current positions
        const simTracker = getSimulationTracker();
        const botPositions = new Map<string, BotPosition>();
        
        // Get bot positions from simulation tracker
        const positions = simTracker['positions']; // Access private field
        
        // Also get position tracker to check when positions were opened
        const positionTracker = getPositionTracker();
        const trackedPositions = positionTracker.getAllPositions();
        
        for (const [asset, position] of positions.entries()) {
            // Find when this position was opened (if tracked)
            const tracked = trackedPositions.find(p => p.asset === asset);
            const openedAt = tracked?.openedAt;
            
            botPositions.set(asset, {
                asset,
                size: position.size,
                avgPrice: position.avgPrice,
                value: position.size * position.avgPrice,
                openedAt: openedAt ? new Date(openedAt * 1000) : undefined
            });
        }

        if (botPositions.size === 0) {
            Logger.info('📦 No bot positions to check');
            return { abandonedCount: 0, abandonedValue: 0 };
        }

        // Get clob client
        const clobClient = createClobClient();
        const traders = ENV.USER_ADDRESSES;

        // Track which assets are held by at least one trader
        const assetsHeldByTraders = new Set<string>();
        
        // Check each trader's positions
        for (const trader of traders) {
            try {
                // Fetch positions from API instead of CLOB client
                const url = `https://data-api.polymarket.com/positions?user=${trader}`;
                const fetchData = (await import('../utils/fetchData')).default;
                const positions = await fetchData(url);

                // Filter for active positions (size > 0) - only care about presence, not size
                const activePositions = positions.filter((pos: any) => parseFloat(pos.size) > 0);
                
                // Mark assets that this trader holds
                for (const pos of activePositions) {
                    assetsHeldByTraders.add(pos.asset || pos.conditionId);
                }

            } catch (error) {
                Logger.error(`Error checking trader ${trader.slice(0, 8)}...: ${error}`);
                continue;
            }
        }

        // Find ABANDONED positions (bot has them but ZERO traders hold them)
        // BUT exclude positions opened recently (grace period)
        const abandonedPositions: AbandonedPosition[] = [];
        let totalAbandonedValue = 0;
        let recentPositionsSkipped = 0;

        const now = new Date();
        const graceThreshold = new Date(now.getTime() - (POSITION_GRACE_PERIOD_HOURS * 60 * 60 * 1000));

        for (const [asset, botPosition] of botPositions.entries()) {
            const isHeldByAnyTrader = assetsHeldByTraders.has(asset);
            
            if (!isHeldByAnyTrader) {
                // Check if position was opened recently (within grace period)
                if (botPosition.openedAt && botPosition.openedAt > graceThreshold) {
                    // Skip recently opened positions to avoid race conditions
                    Logger.info(`⏰ SKIPPING recent position: ${asset.slice(0, 12)}... ($${botPosition.value.toFixed(2)}) - opened ${botPosition.openedAt.toLocaleTimeString()}`);
                    recentPositionsSkipped++;
                    continue;
                }
                
                // ABANDONED - no trader holds this asset anymore AND it's not recent
                abandonedPositions.push({
                    asset,
                    position: botPosition,
                    reason: 'Zero traders hold this asset (position aged > 3h)'
                });
                totalAbandonedValue += botPosition.value;
            }
        }

        // Report results
        const alignedCount = botPositions.size - abandonedPositions.length - recentPositionsSkipped;
        Logger.info(`📊 Bot positions: ${botPositions.size} total | ${alignedCount} aligned | ${abandonedPositions.length} abandoned | ${recentPositionsSkipped} recent (protected)`);
        
        if (recentPositionsSkipped > 0) {
            Logger.info(`⏰ Protected ${recentPositionsSkipped} recent positions (${POSITION_GRACE_PERIOD_HOURS}h backup-only policy)`);        
        }
        
        if (abandonedPositions.length > 0) {
            Logger.warning(`🗑️ ABANDONED POSITIONS (missed sell signals - backup cleanup):`);
            Logger.warning(`💡 These positions were held by bot but abandoned by ALL traders 24h+ ago`);
            
            for (const abandoned of abandonedPositions) {
                Logger.warning(`   • ${abandoned.asset.slice(0, 12)}... $${abandoned.position.value.toFixed(2)} (${abandoned.reason})`);
            }
            
            Logger.warning(`💰 Total abandoned value: $${totalAbandonedValue.toFixed(2)}`);
            
            // AUTO-SELL ABANDONED POSITIONS
            for (const abandoned of abandonedPositions) {
                await sellAbandonedPosition(abandoned.asset, abandoned.position);
            }
            
            Logger.success(`✅ Auto-sold ${abandonedPositions.length} abandoned positions worth $${totalAbandonedValue.toFixed(2)}`);
            
        } else {
            Logger.success('✅ All positions are still held by at least one trader');
        }

        return {
            abandonedCount: abandonedPositions.length,
            abandonedValue: totalAbandonedValue
        };

    } catch (error) {
        Logger.error(`Error in position alignment analysis: ${error}`);
        return { abandonedCount: 0, abandonedValue: 0 };
    }
}

// Function to start automatic monitoring every hour
export async function startPositionMonitoring(): Promise<void> {
    if (isMonitoring) {
        Logger.warning('⚠️ Position monitoring is already running');
        return;
    }

    isMonitoring = true;
    Logger.info('🤖 Starting automatic position alignment monitoring (every hour)...');
    Logger.info('💡 BACKUP SYSTEM: Only sells positions abandoned by ALL traders');
    Logger.info('⚡ Normal sell signals should be detected instantly by main bot');
    Logger.info('🛡️ This catches missed signals, connection issues, or bot downtime');
    Logger.info('✅ Size differences are ignored - only cares about presence/absence');
    Logger.info(`⏰ Backup safety system: only processes positions ${POSITION_GRACE_PERIOD_HOURS}h+ old`);
    Logger.info('🛡️ Recent positions are protected from auto-selling (prevents race conditions)');
    
    // Run initial check
    await analyzePositionAlignment();
    
    // Set up hourly monitoring
    monitorInterval = setInterval(async () => {
        try {
            Logger.separator();
            Logger.info('⏰ Hourly position alignment check...');
            const result = await analyzePositionAlignment();
            
            if (result.abandonedCount > 0) {
                Logger.warning(`🚨 Cleaned up ${result.abandonedCount} abandoned positions ($${result.abandonedValue.toFixed(2)})`);
            } else {
                Logger.info('✅ No abandoned positions found');
            }
        } catch (error) {
            Logger.error(`Error in hourly position check: ${error}`);
        }
    }, 60 * 60 * 1000); // Every hour (3,600,000 ms)
    
    Logger.success('✅ Position monitoring started - checking every hour');
}

// Function to stop monitoring
export function stopPositionMonitoring(): void {
    if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
    }
    isMonitoring = false;
    Logger.info('🛑 Position monitoring stopped');
}

// Function to check if monitoring is active
export function isPositionMonitoringActive(): boolean {
    return isMonitoring;
}
async function analyzeRecentTraderActivity() {
    try {
        Logger.separator();
        Logger.info('📈 RECENT TRADER ACTIVITY ANALYSIS');
        Logger.separator();

        const clobClient = createClobClient();
        const traders = ENV.USER_ADDRESSES;

        for (const trader of traders) {
            try {
                Logger.info(`🔍 Recent activity for ${trader.slice(0, 8)}...${trader.slice(-4)}`);

                // Get recent trades (last 24 hours)
                const since = Math.floor(Date.now() / 1000) - (24 * 60 * 60); // 24 hours ago
                
                // Fetch trades from API instead of CLOB client
                const url = `https://data-api.polymarket.com/activity?user=${trader}&type=TRADE`;
                const fetchData = (await import('../utils/fetchData')).default;
                const trades = await fetchData(url);

                // Filter for recent trades
                const recentTrades = trades.filter((t: any) => t.timestamp >= since);
                
                Logger.info(`  📊 ${recentTrades.length} trades in last 24h`);

                // Analyze trade types
                const buys = recentTrades.filter((t: any) => t.side === 'BUY').length;
                const sells = recentTrades.filter((t: any) => t.side === 'SELL').length;
                
                Logger.info(`  📈 BUY trades: ${buys}`);
                Logger.info(`  📉 SELL trades: ${sells}`);
                
                if (sells > buys) {
                    Logger.warning(`  ⚠️ Trader is selling more than buying (${sells} sells vs ${buys} buys)`);
                    Logger.warning(`  💡 Bot might be holding stale positions from this trader`);
                }

                // Show recent sells that might affect bot positions  
                const recentSells = recentTrades
                    .filter((t: any) => t.side === 'SELL')
                    .slice(0, 5); // Last 5 sells

                if (recentSells.length > 0) {
                    Logger.info('  🔴 Recent SELL trades:');
                    for (const sell of recentSells) {
                        const time = new Date(sell.timestamp * 1000).toLocaleString();
                        Logger.info(`    • ${sell.asset.slice(0, 12)}... $${sell.usdcSize} @ ${time}`);
                    }
                }

                Logger.separator();

            } catch (error) {
                Logger.error(`Error analyzing recent activity for trader ${trader}: ${error}`);
                continue;
            }
        }

    } catch (error) {
        Logger.error(`Error in recent trader activity analysis: ${error}`);
    }
}

// Main execution - can be run standalone or integrated
const runAnalysis = async () => {
    try {
        Logger.separator();
        Logger.info('🔍 POSITION ALIGNMENT ANALYSIS');
        Logger.separator();
        Logger.info('📋 LOGIC: Only sells positions that ZERO traders hold');
        Logger.info('✅ Size differences are ignored (normal behavior)');
        Logger.info('✅ Different position counts are ignored (normal behavior)');
        Logger.info(`⏰ Backup mode: only sells truly abandoned positions (${POSITION_GRACE_PERIOD_HOURS}h+ old)`); 
        Logger.info('🛡️ Prevents race conditions with live trading');
        Logger.separator();
        
        const result = await analyzePositionAlignment();
        
        Logger.separator();
        Logger.info('💡 TO START HOURLY MONITORING:');
        Logger.info('   Add to your main bot: startPositionMonitoring()');
        Logger.separator();
        Logger.success('✅ Position alignment analysis completed');
        
        process.exit(0);
        
    } catch (error) {
        Logger.error(`Analysis failed: ${error}`);
        process.exit(1);
    }
};

// Only run if this file is executed directly
if (require.main === module) {
    runAnalysis();
}