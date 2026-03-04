/**
 * Analyze if traders still hold positions that the bot is holding
 * AUTO-SELLS positions that ZERO traders hold (complete abandonment)
 * Ignores size differences - only cares about presence/absence
 * Runs automatically every hour when integrated
 * 
 * WORKS IN BOTH MODES:
 * - DRY_RUN=true: Uses simulation tracker
 * - DRY_RUN=false: Fetches REAL positions from Polymarket API
 */

import createClobClient from '../utils/createClobClient';
import { getSimulationTracker } from '../utils/simulationBalance';
import { getPositionTracker } from '../utils/positionTracker';
import Logger from '../utils/logger';
import { ENV } from '../config/env';
import fetchData from '../utils/fetchData';

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
// Délai de grâce : protège les positions récentes contre l'auto-vente (race condition API)
// 30 min est suffisant pour que l'API Polymarket propage les positions des traders
const POSITION_GRACE_PERIOD_HOURS = 0.5; // 30 minutes (ex: 3h → trop lent si bot redémarré)

// Global variable to track if monitoring is active
let isMonitoring = false;
let monitorInterval: NodeJS.Timeout | null = null;

// Import required types for real selling
import { AssetType, Side, OrderType } from '@polymarket/clob-client';

// Real position interface from Polymarket API
interface RealPosition {
    asset: string;
    conditionId: string;
    size: string;
    avgPrice: string;
    initialValue: string;
    curPrice: string;
    pnlPercent: string;
    proxyWallet: string;
    outcome: string;
    market: string;
    title?: string;
}

async function sellAbandonedPosition(asset: string, position: BotPosition, conditionId?: string): Promise<boolean> {
    const isDryRun = ENV.DRY_RUN;
    
    try {
        Logger.warning(`🗑️ Auto-selling ABANDONED position: ${asset.slice(0, 12)}... ($${position.value.toFixed(2)})`);
        Logger.info(`   Reason: NO traders hold this asset anymore`);
        
        if (isDryRun) {
            // SIMULATION MODE - use simulation tracker
            const simTracker = getSimulationTracker();
            const tokensToSell = position.size;
            const sellPrice = position.avgPrice;
            
            simTracker.sell(asset, tokensToSell, sellPrice);
            
            const positionTracker = getPositionTracker();
            positionTracker.trackSell(conditionId || asset, tokensToSell, sellPrice, tokensToSell * sellPrice);
            
            Logger.success(`✅ [SIMULATION] Sold abandoned: ${tokensToSell.toFixed(2)} tokens @ $${sellPrice.toFixed(4)} = $${(tokensToSell * sellPrice).toFixed(2)}`);
            return true;
        } else {
            // REAL MODE - execute actual sell order
            Logger.info(`🔄 Syncing allowance cache before selling...`);

            // Sync allowance for this specific token
            const clobClient = await createClobClient();
            try {
                await clobClient.updateBalanceAllowance({
                    asset_type: AssetType.CONDITIONAL,
                    token_id: asset,
                });
                Logger.info(`✅ Allowance cache synced for ${asset.slice(0, 12)}...`);
            } catch (syncError) {
                Logger.warning(`⚠️ Allowance sync warning: ${syncError}`);
            }

            const tokensToSell = position.size;

            // Fetch current order book to get best bid price
            const orderBook = await clobClient.getOrderBook(asset);
            if (!orderBook.bids || orderBook.bids.length === 0) {
                Logger.error(`❌ No bids available for ${asset.slice(0, 12)}... — cannot sell`);
                return false;
            }
            const bestBid = orderBook.bids.reduce((max, bid) =>
                parseFloat(bid.price) > parseFloat(max.price) ? bid : max,
                orderBook.bids[0]
            );
            const bidPrice = parseFloat(bestBid.price);

            // Use MARKET ORDER FOK for immediate execution
            Logger.info(`📤 Placing MARKET ORDER SELL for ${tokensToSell.toFixed(2)} tokens @ $${bidPrice.toFixed(4)}...`);

            const signedOrder = await clobClient.createMarketOrder({
                tokenID: asset,
                amount: tokensToSell,
                side: Side.SELL,
                price: bidPrice,
            });

            // IMPORTANT: must call postOrder to actually submit the order
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            if (resp && resp.success === true) {
                const soldValue = tokensToSell * bidPrice;
                Logger.success(`✅ [REAL] Sold abandoned: ${tokensToSell.toFixed(2)} tokens @ $${bidPrice.toFixed(4)} ≈ $${soldValue.toFixed(2)}`);

                // Update position tracker
                const positionTracker = getPositionTracker();
                positionTracker.trackSell(conditionId || asset, tokensToSell, bidPrice, soldValue);

                return true;
            } else {
                const errMsg = (resp as any)?.error || (resp as any)?.errorMsg || JSON.stringify(resp);
                Logger.error(`❌ Order failed: ${errMsg}`);
                return false;
            }
        }
        
    } catch (error) {
        Logger.error(`❌ Failed to sell abandoned position ${asset}: ${error}`);
        return false;
    }
}

async function analyzePositionAlignment(): Promise<{ abandonedCount: number; abandonedValue: number }> {
    try {
        const startTime = new Date();
        const isDryRun = ENV.DRY_RUN;
        Logger.info(`🔍 Checking position alignment @ ${startTime.toLocaleTimeString()}...`);
        Logger.info(`📋 Mode: ${isDryRun ? 'SIMULATION' : 'REAL TRADING'}`);

        // Get bot's current positions - DIFFERENT APPROACH FOR REAL vs SIMULATION
        const botPositions = new Map<string, BotPosition & { conditionId?: string }>();
        
        // Also get position tracker to check when positions were opened
        const positionTracker = getPositionTracker();
        const trackedPositions = positionTracker.getAllPositions();
        
        if (isDryRun) {
            // SIMULATION MODE - use simulation tracker
            const simTracker = getSimulationTracker();
            const positions = simTracker['positions'] as Map<string, any>; // Access private field
            
            for (const [asset, position] of Array.from(positions.entries())) {
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
        } else {
            // REAL MODE - fetch positions from Polymarket API
            const PROXY_WALLET = ENV.PROXY_WALLET;
            const myPositionsUrl = `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`;
            
            Logger.info(`📡 Fetching REAL positions from Polymarket API...`);
            const realPositions: RealPosition[] = await fetchData(myPositionsUrl);
            
            // Filter for active positions (size > 0)
            const activePositions = realPositions.filter(pos => parseFloat(pos.size) > 0);
            Logger.info(`📦 Found ${activePositions.length} active positions`);
            
            for (const pos of activePositions) {
                const asset = pos.asset;
                const size = parseFloat(pos.size);
                const avgPrice = parseFloat(pos.avgPrice) || parseFloat(pos.curPrice) || 0.5;
                
                // Try to find when this position was opened (from tracker)
                const tracked = trackedPositions.find(p => p.asset === asset || p.conditionId === pos.conditionId);
                const openedAt = tracked?.openedAt;
                
                botPositions.set(asset, {
                    asset,
                    size,
                    avgPrice,
                    value: size * avgPrice,
                    openedAt: openedAt ? new Date(openedAt * 1000) : undefined,
                    conditionId: pos.conditionId
                });
            }
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
                // Fetch positions from API
                const url = `https://data-api.polymarket.com/positions?user=${trader}`;
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

        for (const [asset, botPosition] of Array.from(botPositions.entries())) {
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
                    reason: `Zero traders hold this asset (position aged > ${POSITION_GRACE_PERIOD_HOURS * 60}min)`
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
            let soldCount = 0;
            for (const abandoned of abandonedPositions) {
                const success = await sellAbandonedPosition(
                    abandoned.asset, 
                    abandoned.position,
                    (abandoned.position as any).conditionId
                );
                if (success) soldCount++;
            }
            
            Logger.success(`✅ Auto-sold ${soldCount}/${abandonedPositions.length} abandoned positions worth $${totalAbandonedValue.toFixed(2)}`);
            
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
    Logger.info('🤖 Starting automatic position alignment monitoring (every 5 min)...');
    Logger.info('💡 BACKUP SYSTEM: Only sells positions abandoned by ALL traders');
    Logger.info('⚡ Normal sell signals should be detected instantly by main bot');
    Logger.info('🛡️ This catches missed signals, connection issues, or bot downtime');
    Logger.info('✅ Size differences are ignored - only cares about presence/absence');
    Logger.info(`⏰ Backup safety system: only processes positions ${POSITION_GRACE_PERIOD_HOURS * 60}min+ old`);
    Logger.info('🛡️ Recent positions are protected from auto-selling (prevents race conditions)');
    
    // Run initial check
    await analyzePositionAlignment();
    
    // Vérification toutes les 5 minutes
    monitorInterval = setInterval(async () => {
        try {
            Logger.separator();
            Logger.info('⏰ Vérification positions abandonnées (toutes les 5 min)...');
            const result = await analyzePositionAlignment();

            if (result.abandonedCount > 0) {
                Logger.warning(`🚨 Cleaned up ${result.abandonedCount} abandoned positions ($${result.abandonedValue.toFixed(2)})`);
            } else {
                Logger.info('✅ No abandoned positions found');
            }
        } catch (error) {
            Logger.error(`Error in position check: ${error}`);
        }
    }, 5 * 60 * 1000); // Toutes les 5 minutes

    Logger.success('✅ Position monitoring started - checking every 5 minutes');
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
                
                // Fetch trades from API
                const url = `https://data-api.polymarket.com/activity?user=${trader}&type=TRADE`;
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