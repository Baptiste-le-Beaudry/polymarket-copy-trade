/**
 * Compare bot performance vs trader performance on shared positions
 * Shows exactly where the bot loses money compared to the trader
 */

import mongoose from 'mongoose';
import { ENV } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';
import Logger from '../utils/logger';
import * as fs from 'fs';
import * as path from 'path';

interface PositionComparison {
    asset: string;
    market: string;

    // Entry comparison
    traderEntryPrice: number;
    botEntryPrice: number;
    entrySlippage: number;
    entrySlippagePercent: number;
    entryTimingDelay: number; // seconds

    // Position sizes
    traderTokens: number;
    botTokens: number;
    traderUSD: number;
    botUSD: number;

    // Exit comparison (if sold)
    traderExitPrice?: number;
    botExitPrice?: number;
    exitSlippage?: number;
    exitSlippagePercent?: number;
    exitTimingDelay?: number;

    // P&L comparison
    traderProfit?: number;
    traderProfitPercent?: number;
    botProfit?: number;
    botProfitPercent?: number;
    performanceDiff?: number; // Bot profit - Trader profit (negative = bot lost more)

    // Status
    status: 'OPEN' | 'BOTH_CLOSED' | 'TRADER_CLOSED_BOT_OPEN';
    entryTime: number;
    exitTime?: number;
}

async function compareTraderPerformance() {
    try {
        await mongoose.connect(ENV.MONGO_URI);
        Logger.info('✓ Connected to MongoDB');

        const comparisons: PositionComparison[] = [];

        // For each trader we're copying
        for (const traderAddress of ENV.USER_ADDRESSES) {
            Logger.info(`\n📊 Analyzing trader ${traderAddress.substring(0, 10)}...`);

            const TraderActivity = getUserActivityModel(traderAddress.toLowerCase());
            const BotActivity = getUserActivityModel(ENV.PROXY_WALLET.toLowerCase());

            // Get all trader BUY trades
            const traderBuys = await TraderActivity.find({
                side: 'BUY',
                bot: false
            }).sort({ timestamp: 1 });

            Logger.info(`Found ${traderBuys.length} trader BUY trades`);

            for (const traderBuy of traderBuys) {
                // Find corresponding bot BUY on same asset
                const botBuy = await BotActivity.findOne({
                    asset: traderBuy.asset,
                    side: 'BUY',
                    bot: true,
                    timestamp: { $gte: traderBuy.timestamp } // Bot bought after trader
                }).sort({ timestamp: 1 }); // First bot buy after trader buy

                if (!botBuy) continue; // Bot didn't copy this trade

                // Entry comparison
                const entryTimingDelay = botBuy.timestamp && traderBuy.timestamp
                    ? (botBuy.timestamp - traderBuy.timestamp) / 1000
                    : 0;
                const entrySlippage = (botBuy.price || 0) - (traderBuy.price || 0);
                const entrySlippagePercent = traderBuy.price
                    ? (entrySlippage / traderBuy.price) * 100
                    : 0;

                // Find SELL trades
                const traderSell = await TraderActivity.findOne({
                    asset: traderBuy.asset,
                    side: 'SELL',
                    bot: false,
                    timestamp: { $gt: traderBuy.timestamp }
                }).sort({ timestamp: 1 });

                const botSell = await BotActivity.findOne({
                    asset: traderBuy.asset,
                    side: 'SELL',
                    bot: true,
                    timestamp: { $gt: botBuy.timestamp }
                }).sort({ timestamp: 1 });

                const comparison: PositionComparison = {
                    asset: traderBuy.asset || '',
                    market: traderBuy.title || 'Unknown Market',

                    // Entry
                    traderEntryPrice: traderBuy.price || 0,
                    botEntryPrice: botBuy.price || 0,
                    entrySlippage,
                    entrySlippagePercent,
                    entryTimingDelay,

                    // Sizes
                    traderTokens: traderBuy.size || 0,
                    botTokens: botBuy.size || 0,
                    traderUSD: traderBuy.usdcSize || 0,
                    botUSD: botBuy.usdcSize || 0,

                    // Status
                    status: 'OPEN',
                    entryTime: traderBuy.timestamp || 0
                };

                // Exit comparison (if both sold)
                if (traderSell && botSell) {
                    const exitTimingDelay = botSell.timestamp && traderSell.timestamp
                        ? (botSell.timestamp - traderSell.timestamp) / 1000
                        : 0;
                    const exitSlippage = (botSell.price || 0) - (traderSell.price || 0);
                    const exitSlippagePercent = traderSell.price
                        ? (exitSlippage / traderSell.price) * 100
                        : 0;

                    comparison.traderExitPrice = traderSell.price || 0;
                    comparison.botExitPrice = botSell.price || 0;
                    comparison.exitSlippage = exitSlippage;
                    comparison.exitSlippagePercent = exitSlippagePercent;
                    comparison.exitTimingDelay = exitTimingDelay;
                    comparison.exitTime = traderSell.timestamp || 0;

                    // Calculate P&L
                    const traderProfit = ((traderSell.price || 0) - (traderBuy.price || 0)) * (traderBuy.size || 0);
                    const traderProfitPercent = traderBuy.price
                        ? ((traderSell.price || 0) - (traderBuy.price || 0)) / (traderBuy.price || 0) * 100
                        : 0;

                    const botProfit = ((botSell.price || 0) - (botBuy.price || 0)) * (botBuy.size || 0);
                    const botProfitPercent = botBuy.price
                        ? ((botSell.price || 0) - (botBuy.price || 0)) / (botBuy.price || 0) * 100
                        : 0;

                    comparison.traderProfit = traderProfit;
                    comparison.traderProfitPercent = traderProfitPercent;
                    comparison.botProfit = botProfit;
                    comparison.botProfitPercent = botProfitPercent;
                    comparison.performanceDiff = botProfitPercent - traderProfitPercent;
                    comparison.status = 'BOTH_CLOSED';
                } else if (traderSell && !botSell) {
                    comparison.status = 'TRADER_CLOSED_BOT_OPEN';
                    comparison.traderExitPrice = traderSell.price || 0;
                    comparison.exitTime = traderSell.timestamp || 0;

                    // Trader P&L only
                    const traderProfit = ((traderSell.price || 0) - (traderBuy.price || 0)) * (traderBuy.size || 0);
                    const traderProfitPercent = traderBuy.price
                        ? ((traderSell.price || 0) - (traderBuy.price || 0)) / (traderBuy.price || 0) * 100
                        : 0;
                    comparison.traderProfit = traderProfit;
                    comparison.traderProfitPercent = traderProfitPercent;
                }

                comparisons.push(comparison);
            }
        }

        Logger.info(`\n✓ Analyzed ${comparisons.length} shared positions\n`);

        // Generate report
        generateReport(comparisons);

        await mongoose.disconnect();
        Logger.info('✓ Disconnected from MongoDB');

    } catch (error) {
        Logger.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}

function generateReport(comparisons: PositionComparison[]) {
    Logger.separator();
    Logger.info('📊 TRADER vs BOT PERFORMANCE COMPARISON');
    Logger.separator();

    const closedPositions = comparisons.filter(c => c.status === 'BOTH_CLOSED');
    const openPositions = comparisons.filter(c => c.status === 'OPEN');
    const traderClosedOnly = comparisons.filter(c => c.status === 'TRADER_CLOSED_BOT_OPEN');

    Logger.info(`Total Shared Positions: ${comparisons.length}`);
    Logger.info(`  • Both Closed: ${closedPositions.length}`);
    Logger.info(`  • Both Open: ${openPositions.length}`);
    Logger.info(`  • Trader Closed, Bot Open: ${traderClosedOnly.length}`);
    Logger.separator();

    // Entry slippage statistics
    const avgEntrySlippage = comparisons.reduce((sum, c) => sum + c.entrySlippagePercent, 0) / comparisons.length;
    const avgEntryDelay = comparisons.reduce((sum, c) => sum + c.entryTimingDelay, 0) / comparisons.length;

    Logger.info('📈 ENTRY ANALYSIS (Buy Slippage)');
    Logger.info(`Average Entry Slippage: ${avgEntrySlippage >= 0 ? '+' : ''}${avgEntrySlippage.toFixed(2)}%`);
    Logger.info(`Average Timing Delay: ${avgEntryDelay.toFixed(2)} seconds`);
    Logger.separator();

    // Declare performance diff variable
    let avgPerformanceDiff = 0;

    // Exit slippage statistics (for closed positions)
    if (closedPositions.length > 0) {
        const avgExitSlippage = closedPositions.reduce((sum, c) => sum + (c.exitSlippagePercent || 0), 0) / closedPositions.length;
        const avgExitDelay = closedPositions.reduce((sum, c) => sum + (c.exitTimingDelay || 0), 0) / closedPositions.length;

        Logger.info('📉 EXIT ANALYSIS (Sell Slippage)');
        Logger.info(`Average Exit Slippage: ${avgExitSlippage >= 0 ? '+' : ''}${avgExitSlippage.toFixed(2)}%`);
        Logger.info(`Average Timing Delay: ${avgExitDelay.toFixed(2)} seconds`);
        Logger.separator();

        // Performance comparison
        const avgTraderProfit = closedPositions.reduce((sum, c) => sum + (c.traderProfitPercent || 0), 0) / closedPositions.length;
        const avgBotProfit = closedPositions.reduce((sum, c) => sum + (c.botProfitPercent || 0), 0) / closedPositions.length;
        avgPerformanceDiff = closedPositions.reduce((sum, c) => sum + (c.performanceDiff || 0), 0) / closedPositions.length;

        Logger.info('💰 PERFORMANCE COMPARISON (Closed Positions)');
        Logger.info(`Trader Avg P&L: ${avgTraderProfit >= 0 ? '+' : ''}${avgTraderProfit.toFixed(2)}%`);
        Logger.info(`Bot Avg P&L:    ${avgBotProfit >= 0 ? '+' : ''}${avgBotProfit.toFixed(2)}%`);
        Logger.info(`Performance Gap: ${avgPerformanceDiff >= 0 ? '+' : ''}${avgPerformanceDiff.toFixed(2)}% ${avgPerformanceDiff < 0 ? '⚠️ BOT UNDERPERFORMS' : '✓ BOT MATCHES'}`);
        Logger.separator();

        // Top 5 worst performances
        const worstPerformances = [...closedPositions]
            .sort((a, b) => (a.performanceDiff || 0) - (b.performanceDiff || 0))
            .slice(0, 5);

        Logger.info('❌ TOP 5 WORST BOT PERFORMANCES');
        worstPerformances.forEach((pos, idx) => {
            Logger.info(`${idx + 1}. ${pos.market.substring(0, 50)}...`);
            Logger.info(`   Trader: ${pos.traderProfitPercent?.toFixed(2)}% | Bot: ${pos.botProfitPercent?.toFixed(2)}% | Gap: ${pos.performanceDiff?.toFixed(2)}%`);
            Logger.info(`   Entry Slippage: ${pos.entrySlippagePercent >= 0 ? '+' : ''}${pos.entrySlippagePercent.toFixed(2)}% (${pos.entryTimingDelay.toFixed(1)}s delay)`);
            Logger.info(`   Exit Slippage: ${(pos.exitSlippagePercent || 0) >= 0 ? '+' : ''}${(pos.exitSlippagePercent || 0).toFixed(2)}% (${(pos.exitTimingDelay || 0).toFixed(1)}s delay)`);
        });
        Logger.separator();

        // Top 5 best performances
        const bestPerformances = [...closedPositions]
            .sort((a, b) => (b.performanceDiff || 0) - (a.performanceDiff || 0))
            .slice(0, 5);

        Logger.info('✅ TOP 5 BEST BOT PERFORMANCES');
        bestPerformances.forEach((pos, idx) => {
            Logger.info(`${idx + 1}. ${pos.market.substring(0, 50)}...`);
            Logger.info(`   Trader: ${pos.traderProfitPercent?.toFixed(2)}% | Bot: ${pos.botProfitPercent?.toFixed(2)}% | Gap: ${pos.performanceDiff?.toFixed(2)}%`);
            Logger.info(`   Entry Slippage: ${pos.entrySlippagePercent >= 0 ? '+' : ''}${pos.entrySlippagePercent.toFixed(2)}% (${pos.entryTimingDelay.toFixed(1)}s delay)`);
            Logger.info(`   Exit Slippage: ${(pos.exitSlippagePercent || 0) >= 0 ? '+' : ''}${(pos.exitSlippagePercent || 0).toFixed(2)}% (${(pos.exitTimingDelay || 0).toFixed(1)}s delay)`);
        });
    }

    Logger.separator();

    // Recommendations
    Logger.info('💡 RECOMMENDATIONS');
    if (avgEntrySlippage > 2) {
        Logger.warning('  ⚠️  High entry slippage (>2%)');
        Logger.info('  • Reduce MAX_SLIPPAGE_PERCENT to reject trades with high slippage');
        Logger.info('  • Copy traders with smaller position sizes');
    }
    if (avgEntryDelay > 10) {
        Logger.warning('  ⚠️  High timing delay (>10s)');
        Logger.info('  • Check FETCH_INTERVAL (should be 1-3 seconds)');
        Logger.info('  • Verify network/API performance');
    }
    if (closedPositions.length > 0 && avgPerformanceDiff < -1) {
        Logger.warning('  ⚠️  Bot significantly underperforms trader');
        Logger.info('  • This is expected due to timing delay and slippage');
        Logger.info('  • Consider only copying traders with proven >5% edge');
    }

    Logger.separator();

    // Save detailed report to file
    const reportPath = path.join(process.cwd(), 'trader-comparison-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(comparisons, null, 2), 'utf-8');
    Logger.success(`📄 Detailed report saved: ${reportPath}`);
}

// Run comparison
compareTraderPerformance();
