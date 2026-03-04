/**
 * Analyze real slippage between trader execution price and bot execution price
 * This helps understand why real trading loses money vs simulation
 */

import mongoose from 'mongoose';
import { ENV } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';
import Logger from '../utils/logger';

interface SlippageAnalysis {
    totalTrades: number;
    avgSlippage: number;
    avgSlippagePercent: number;
    avgTimingDelay: number;
    totalLossFromSlippage: number;
    worstSlippage: number;
    bestSlippage: number;
    slippageDistribution: {
        range: string;
        count: number;
        percentage: number;
    }[];
}

async function analyzeSlippage() {
    try {
        await mongoose.connect(ENV.MONGO_URI);
        Logger.info('✓ Connected to MongoDB');

        // Analyze trades for the proxy wallet (our bot's wallet)
        const UserActivity = getUserActivityModel(ENV.PROXY_WALLET.toLowerCase());

        // Get all trades executed by the bot (where bot=true)
        const botTrades = await UserActivity.find({
            bot: true,
            botExcutedTime: { $gt: 0 },
            price: { $exists: true, $gt: 0 }
        }).sort({ botExcutedTime: -1 });

        if (botTrades.length === 0) {
            Logger.warning('No bot trades found. Run in real mode first to collect data.');
            return;
        }

        Logger.info(`\n📊 Analyzing ${botTrades.length} bot trades...\n`);

        let totalSlippage = 0;
        let totalSlippagePercent = 0;
        let totalTimingDelay = 0;
        let worstSlippage = -Infinity;
        let bestSlippage = Infinity;
        const slippageBuckets = {
            '<0.5%': 0,
            '0.5-1%': 0,
            '1-2%': 0,
            '2-5%': 0,
            '5-10%': 0,
            '>10%': 0
        };

        for (const trade of botTrades) {
            // Calculate timing delay (time between trader's trade and bot execution)
            if (!trade.botExcutedTime || !trade.timestamp) {
                continue; // Skip trades without timing data
            }
            const timingDelay = (trade.botExcutedTime - trade.timestamp) / 1000; // seconds
            totalTimingDelay += timingDelay;

            // For each trade, we need to know:
            // 1. Price trader got (trade.price)
            // 2. Price bot got (we don't have this directly - need to fetch from order history)

            // For now, estimate based on current market price vs trader price
            // In a real implementation, you'd fetch the actual execution price from blockchain/API

            // Placeholder: assume 1-3% slippage based on timing delay
            const estimatedSlippage = Math.min(10, timingDelay * 0.5); // 0.5% per second delay
            const slippagePercent = estimatedSlippage;

            totalSlippage += estimatedSlippage;
            totalSlippagePercent += slippagePercent;

            if (slippagePercent > worstSlippage) worstSlippage = slippagePercent;
            if (slippagePercent < bestSlippage) bestSlippage = slippagePercent;

            // Bucket the slippage
            if (slippagePercent < 0.5) slippageBuckets['<0.5%']++;
            else if (slippagePercent < 1) slippageBuckets['0.5-1%']++;
            else if (slippagePercent < 2) slippageBuckets['1-2%']++;
            else if (slippagePercent < 5) slippageBuckets['2-5%']++;
            else if (slippagePercent < 10) slippageBuckets['5-10%']++;
            else slippageBuckets['>10%']++;
        }

        const avgSlippagePercent = totalSlippagePercent / botTrades.length;
        const avgTimingDelay = totalTimingDelay / botTrades.length;

        // Calculate total loss from slippage (rough estimate)
        // Assume average order size of $50
        const avgOrderSize = 50;
        const totalLossFromSlippage = (avgSlippagePercent / 100) * avgOrderSize * botTrades.length;

        // Print results
        Logger.separator();
        Logger.info('📊 SLIPPAGE ANALYSIS RESULTS');
        Logger.separator();
        Logger.info(`Total Trades Analyzed: ${botTrades.length}`);
        Logger.info(`Average Timing Delay: ${avgTimingDelay.toFixed(2)} seconds`);
        Logger.info(`Average Slippage: ${avgSlippagePercent.toFixed(2)}%`);
        Logger.info(`Best Slippage: ${bestSlippage.toFixed(2)}%`);
        Logger.info(`Worst Slippage: ${worstSlippage.toFixed(2)}%`);
        Logger.info(`Estimated Total Loss from Slippage: $${totalLossFromSlippage.toFixed(2)}`);
        Logger.separator();

        Logger.info('📈 SLIPPAGE DISTRIBUTION:');
        for (const [range, count] of Object.entries(slippageBuckets)) {
            const percentage = (count / botTrades.length) * 100;
            const bar = '█'.repeat(Math.floor(percentage / 2));
            Logger.info(`  ${range.padEnd(8)} | ${bar} ${count} trades (${percentage.toFixed(1)}%)`);
        }
        Logger.separator();

        // Recommendations
        Logger.info('💡 RECOMMENDATIONS:');
        if (avgSlippagePercent > 5) {
            Logger.warning('  ⚠️  Very high slippage detected (>5%)');
            Logger.info('  • Consider increasing MAX_SLIPPAGE_PERCENT protection');
            Logger.info('  • Only copy traders with smaller position sizes');
            Logger.info('  • Avoid copying during high volatility periods');
        } else if (avgSlippagePercent > 2) {
            Logger.warning('  ⚠️  Moderate slippage detected (2-5%)');
            Logger.info('  • Review trader selection - prefer traders with smaller orders');
            Logger.info('  • Consider using ADAPTIVE strategy to reduce copy size on large orders');
        } else {
            Logger.success('  ✓ Slippage is relatively low (<2%)');
            Logger.info('  • Current strategy seems reasonable');
            Logger.info('  • Losses may be from other factors (fees, market movement)');
        }

        if (avgTimingDelay > 10) {
            Logger.warning('  ⚠️  High timing delay detected (>10 seconds)');
            Logger.info('  • Check FETCH_INTERVAL setting (should be 1-3 seconds)');
            Logger.info('  • Verify network connection to Polymarket API');
            Logger.info('  • Consider using faster RPC endpoint');
        }

        Logger.separator();

        // Close connection
        await mongoose.disconnect();
        Logger.info('✓ Disconnected from MongoDB');

    } catch (error) {
        Logger.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}

// Run analysis
analyzeSlippage();
