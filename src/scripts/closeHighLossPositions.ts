/**
 * Close High Loss Positions Script
 *
 * Automatically sells simulation positions that exceed a specified loss threshold.
 * This helps clean up legacy positions bought at bad prices (e.g., $0.99).
 *
 * Usage:
 *   npm run close-high-loss [threshold_percent]
 *
 * Example:
 *   npm run close-high-loss 40   # Sells positions with > 40% loss
 *   npm run close-high-loss      # Uses default 40%
 */

import { getSimulationTracker } from '../utils/simulationBalance';
import { executeSimulatedTrade } from '../utils/simulationExecutor';
import createClobClient from '../utils/createClobClient';
import Logger from '../utils/logger';
import { ENV } from '../config/env';

const PROXY_WALLET = ENV.PROXY_WALLET;

interface PositionWithLoss {
    asset: string;
    market: string;
    size: number;
    avgPrice: number;
    currentPrice: number;
    currentValue: number;
    entryValue: number;
    pnl: number;
    pnlPercent: number;
}

const main = async () => {
    // Parse loss threshold from command line argument (default: 40%)
    const lossThresholdPercent = parseFloat(process.argv[2] || '40');

    if (isNaN(lossThresholdPercent) || lossThresholdPercent <= 0 || lossThresholdPercent > 100) {
        console.error('❌ Invalid loss threshold. Must be between 0 and 100.');
        console.error('Usage: npm run close-high-loss [threshold_percent]');
        console.error('Example: npm run close-high-loss 40');
        process.exit(1);
    }

    if (!ENV.DRY_RUN) {
        console.error('❌ This script only works in DRY_RUN mode (simulation).');
        console.error('Set DRY_RUN=true in your .env file.');
        process.exit(1);
    }

    console.log('🔴 Closing High Loss Positions (Simulation Mode)');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`Wallet: ${PROXY_WALLET}`);
    console.log(`Loss Threshold: >${lossThresholdPercent}%`);
    console.log('');

    const simTracker = getSimulationTracker();
    const allPositions = simTracker.getAllPositions();

    if (allPositions.length === 0) {
        console.log('✅ No open positions in simulation.');
        process.exit(0);
    }

    console.log(`📊 Found ${allPositions.length} position(s) in simulation`);
    console.log('');

    // Fetch current prices from order book for each position
    const clobClient = await createClobClient();
    console.log('🔄 Fetching current market prices...');

    const positionsWithLoss: PositionWithLoss[] = [];

    for (const pos of allPositions) {
        try {
            // Fetch current order book to get current price
            const orderBook = await clobClient.getOrderBook(pos.asset);
            const currentPrice = orderBook.bids && orderBook.bids.length > 0
                ? parseFloat(orderBook.bids[0].price)
                : pos.avgPrice; // Fallback to avg price if no bids

            const currentValue = pos.size * currentPrice;
            const entryValue = pos.size * pos.avgPrice;
            const pnl = currentValue - entryValue;
            const pnlPercent = (pnl / entryValue) * 100;

            positionsWithLoss.push({
                asset: pos.asset,
                market: pos.market || pos.asset.substring(0, 12) + '...',
                size: pos.size,
                avgPrice: pos.avgPrice,
                currentPrice,
                currentValue,
                entryValue,
                pnl,
                pnlPercent,
            });
        } catch (error) {
            console.warn(`⚠️  Failed to fetch price for ${pos.market || pos.asset}: ${error}`);
            // Skip this position if we can't fetch the price
        }
    }

    // Filter positions exceeding loss threshold
    const highLossPositions = positionsWithLoss.filter(
        pos => pos.pnlPercent <= -lossThresholdPercent
    );

    if (highLossPositions.length === 0) {
        console.log(`✅ No positions exceed -${lossThresholdPercent}% loss threshold.`);
        console.log('');

        // Show worst position for context
        const worstPosition = positionsWithLoss.sort((a, b) => a.pnlPercent - b.pnlPercent)[0];
        if (worstPosition) {
            console.log('📊 Worst position:');
            console.log(`   ${worstPosition.market}`);
            console.log(`   P&L: ${worstPosition.pnlPercent.toFixed(2)}% ($${worstPosition.pnl.toFixed(2)})`);
        }

        process.exit(0);
    }

    console.log(`🔴 Found ${highLossPositions.length} position(s) exceeding -${lossThresholdPercent}% loss:`);
    console.log('');

    // Sort by worst loss first
    highLossPositions.sort((a, b) => a.pnlPercent - b.pnlPercent);

    // Display positions to be closed
    let totalLoss = 0;
    highLossPositions.forEach((pos, index) => {
        console.log(`${index + 1}. ${pos.market}`);
        console.log(`   Entry: ${pos.size.toFixed(2)} tokens @ $${pos.avgPrice.toFixed(4)} = $${pos.entryValue.toFixed(2)}`);
        console.log(`   Current: ${pos.size.toFixed(2)} tokens @ $${pos.currentPrice.toFixed(4)} = $${pos.currentValue.toFixed(2)}`);
        console.log(`   Loss: ${pos.pnlPercent.toFixed(2)}% ($${pos.pnl.toFixed(2)})`);
        console.log('');
        totalLoss += pos.pnl;
    });

    console.log(`💰 Total unrealized loss: $${totalLoss.toFixed(2)}`);
    console.log('');

    // Prompt for confirmation
    console.log('⚠️  This will SELL all positions above and realize the losses.');
    console.log('   Type "yes" to confirm, or press Ctrl+C to cancel.');
    console.log('');

    // Wait for user input
    const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const answer = await new Promise<string>(resolve => {
        readline.question('Continue? (yes/no): ', resolve);
    });
    readline.close();

    if (answer.toLowerCase() !== 'yes') {
        console.log('❌ Cancelled by user.');
        process.exit(0);
    }

    console.log('');
    console.log('🚀 Starting to close positions...');
    console.log('═══════════════════════════════════════════════════════');

    let totalSold = 0;
    let totalProceeds = 0;
    let failedCount = 0;

    for (let i = 0; i < highLossPositions.length; i++) {
        const pos = highLossPositions[i];
        console.log('');
        console.log(`[${i + 1}/${highLossPositions.length}] ${pos.market}`);
        console.log(`   Selling ${pos.size.toFixed(2)} tokens @ $${pos.currentPrice.toFixed(4)}`);

        try {
            // Execute simulated SELL
            const result = await executeSimulatedTrade(
                pos.asset,
                'SELL',
                pos.size,
                pos.currentPrice,
                PROXY_WALLET // Use proxy wallet as userAddress (not critical for simulation)
            );

            if (result.success && result.executed) {
                const proceeds = (result.tokensTraded || pos.size) * (result.avgPrice || pos.currentPrice);
                totalSold += (result.tokensTraded || pos.size);
                totalProceeds += proceeds;

                console.log(`   ✅ SOLD: ${result.tokensTraded?.toFixed(2) || pos.size.toFixed(2)} tokens @ $${result.avgPrice?.toFixed(4) || pos.currentPrice.toFixed(4)}`);
                console.log(`   💰 Proceeds: $${proceeds.toFixed(2)}`);
                console.log(`   📉 Loss realized: $${pos.pnl.toFixed(2)} (${pos.pnlPercent.toFixed(2)}%)`);
            } else {
                failedCount++;
                console.log(`   ❌ FAILED: ${result.reason || 'Unknown error'}`);
            }
        } catch (error) {
            failedCount++;
            console.log(`   ❌ ERROR: ${error instanceof Error ? error.message : String(error)}`);
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log('');
    console.log('═══════════════════════════════════════════════════════');
    console.log('✅ Close-out Summary');
    console.log(`   Positions targeted: ${highLossPositions.length}`);
    console.log(`   Successfully sold: ${highLossPositions.length - failedCount}`);
    console.log(`   Failed: ${failedCount}`);
    console.log(`   Tokens sold: ${totalSold.toFixed(2)}`);
    console.log(`   USDC proceeds: $${totalProceeds.toFixed(2)}`);
    console.log(`   Loss realized: $${totalLoss.toFixed(2)}`);
    console.log('');

    // Show updated balance
    const updatedBalance = simTracker.getBalance();
    const updatedPositions = simTracker.getAllPositions();
    console.log(`💵 New simulation balance: $${updatedBalance.toFixed(2)}`);
    console.log(`📊 Remaining positions: ${updatedPositions.length}`);
    console.log('═══════════════════════════════════════════════════════');
};

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('❌ Script failed:', error);
        process.exit(1);
    });
