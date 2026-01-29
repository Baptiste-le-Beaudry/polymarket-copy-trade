/**
 * Clean Old Positions Script
 * 
 * Sells positions that are older than X days or smaller than X tokens
 * Useful for cleaning up stuck or forgotten positions
 */

import { ClobClient } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import { getPositionTracker } from '../utils/positionTracker';
import createClobClient from '../utils/createClobClient';
import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';
import { Side } from '@polymarket/clob-client';
import * as readline from 'readline';

const PROXY_WALLET = ENV.PROXY_WALLET;
const MIN_ORDER_SIZE_TOKENS = ENV.MIN_ORDER_SIZE_TOKENS ?? 1.0;

interface Position {
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    currentValue: number;
    title: string;
    outcome: string;
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function question(query: string): Promise<string> {
    return new Promise((resolve) => {
        rl.question(query, resolve);
    });
}

async function sellPosition(
    clobClient: ClobClient,
    position: Position,
    reason: string
): Promise<boolean> {
    try {
        Logger.info(`\n🔄 Selling: ${position.title} - ${position.outcome}`);
        Logger.info(`   Reason: ${reason}`);
        Logger.info(`   Size: ${position.size.toFixed(2)} tokens @ $${position.avgPrice.toFixed(4)}`);

        if (position.size < MIN_ORDER_SIZE_TOKENS) {
            Logger.warning(`   ⚠️  Position too small to sell (< ${MIN_ORDER_SIZE_TOKENS} tokens)`);
            return false;
        }

        // Get current market price
        const orderBook = await clobClient.getOrderBook(position.asset);
        if (!orderBook.bids || orderBook.bids.length === 0) {
            Logger.warning('   ❌ No bids available');
            return false;
        }

        const maxPriceBid = orderBook.bids.reduce((max, bid) => {
            return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
        }, orderBook.bids[0]);

        Logger.info(`   Best bid: $${maxPriceBid.price}`);

        const sellAmount = Math.min(position.size, parseFloat(maxPriceBid.size));

        const signedOrder = await clobClient.createOrder({
            tokenID: position.asset,
            size: sellAmount,
            price: parseFloat(maxPriceBid.price),
            side: Side.SELL,
            feeRateBps: 0,
        });

        const result = await clobClient.postOrder(signedOrder);

        if (result.success && result.orderID) {
            Logger.info(`   ✅ Sold ${sellAmount.toFixed(2)} tokens at $${maxPriceBid.price}`);
            
            // Track the sell
            const tracker = getPositionTracker();
            tracker.trackSell(
                position.conditionId,
                sellAmount,
                parseFloat(maxPriceBid.price),
                sellAmount * parseFloat(maxPriceBid.price)
            );
            
            return true;
        } else {
            Logger.error(`   ❌ Failed to sell: ${JSON.stringify(result)}`);
            return false;
        }
    } catch (error) {
        Logger.error(`   ❌ Error selling position: ${error}`);
        return false;
    }
}

async function main() {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║        CLEAN OLD POSITIONS                               ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    // Get options
    console.log('What would you like to clean?\n');
    console.log('1. Positions older than X days');
    console.log('2. Positions smaller than X tokens');
    console.log('3. Both old AND small positions');
    console.log('4. All open positions (DANGEROUS!)');
    console.log('5. Exit\n');

    const choice = await question('Enter your choice (1-5): ');

    if (choice === '5') {
        console.log('Exiting...');
        rl.close();
        process.exit(0);
    }

    let daysOld = 0;
    let minTokens = 0;

    if (choice === '1' || choice === '3') {
        const daysInput = await question('Positions older than how many days? (default: 30): ');
        daysOld = parseInt(daysInput) || 30;
    }

    if (choice === '2' || choice === '3') {
        const tokensInput = await question(
            `Positions smaller than how many tokens? (default: ${MIN_ORDER_SIZE_TOKENS}): `
        );
        minTokens = parseFloat(tokensInput) || MIN_ORDER_SIZE_TOKENS;
    }

    // Initialize
    const clobClient = await createClobClient();
    const tracker = getPositionTracker();

    // Get current positions from Polymarket
    Logger.info(`\n📊 Fetching your positions...`);
    const positions: Position[] = await fetchData(
        `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`
    );

    if (!positions || positions.length === 0) {
        Logger.info('No positions found.');
        rl.close();
        process.exit(0);
    }

    Logger.info(`Found ${positions.length} open positions\n`);

    // Filter positions based on criteria
    let positionsToSell: Position[] = [];

    if (choice === '1') {
        // Old positions
        const oldPositions = tracker.getOldPositions(daysOld);
        positionsToSell = positions.filter((p) =>
            oldPositions.some((op) => op.conditionId === p.conditionId)
        );
        console.log(`\n🔍 Found ${positionsToSell.length} positions older than ${daysOld} days\n`);
    } else if (choice === '2') {
        // Small positions
        positionsToSell = positions.filter((p) => p.size < minTokens && p.size >= MIN_ORDER_SIZE_TOKENS);
        console.log(`\n🔍 Found ${positionsToSell.length} positions smaller than ${minTokens} tokens\n`);
    } else if (choice === '3') {
        // Old AND small
        const oldPositions = tracker.getOldPositions(daysOld);
        positionsToSell = positions.filter(
            (p) =>
                p.size < minTokens &&
                p.size >= MIN_ORDER_SIZE_TOKENS &&
                oldPositions.some((op) => op.conditionId === p.conditionId)
        );
        console.log(
            `\n🔍 Found ${positionsToSell.length} positions older than ${daysOld} days AND smaller than ${minTokens} tokens\n`
        );
    } else if (choice === '4') {
        // All positions
        positionsToSell = positions.filter((p) => p.size >= MIN_ORDER_SIZE_TOKENS);
        console.log(`\n⚠️  WARNING: This will sell ALL ${positionsToSell.length} positions!\n`);
    }

    if (positionsToSell.length === 0) {
        Logger.info('No positions match the criteria.');
        rl.close();
        process.exit(0);
    }

    // Show preview
    console.log('═══════════════════════════════════════════════════════════\n');
    console.log('Positions to be sold:\n');
    positionsToSell.forEach((p, i) => {
        const trackedPos = tracker.getPosition(p.conditionId);
        const age = trackedPos
            ? Math.floor((Date.now() - trackedPos.openedAt) / (1000 * 60 * 60 * 24))
            : '?';
        console.log(`${i + 1}. ${p.title.substring(0, 50)}...`);
        console.log(`   ${p.outcome}`);
        console.log(`   Size: ${p.size.toFixed(2)} tokens | Value: $${p.currentValue.toFixed(2)} | Age: ${age} days\n`);
    });

    const totalValue = positionsToSell.reduce((sum, p) => sum + p.currentValue, 0);
    console.log(`Total value to sell: $${totalValue.toFixed(2)}\n`);
    console.log('═══════════════════════════════════════════════════════════\n');

    const confirm = await question(
        '⚠️  Are you sure you want to sell these positions? (yes/no): '
    );

    if (confirm.toLowerCase() !== 'yes') {
        console.log('Cancelled.');
        rl.close();
        process.exit(0);
    }

    // Sell positions
    let successCount = 0;
    let failCount = 0;

    for (const position of positionsToSell) {
        const trackedPos = tracker.getPosition(position.conditionId);
        const age = trackedPos
            ? Math.floor((Date.now() - trackedPos.openedAt) / (1000 * 60 * 60 * 24))
            : 0;

        let reason = '';
        if (choice === '1') reason = `${age} days old`;
        else if (choice === '2') reason = `${position.size.toFixed(2)} tokens (small)`;
        else if (choice === '3') reason = `${age} days old, ${position.size.toFixed(2)} tokens`;
        else reason = 'Manual cleanup';

        const success = await sellPosition(clobClient, position, reason);
        if (success) {
            successCount++;
        } else {
            failCount++;
        }

        // Wait a bit between sells to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('📊 CLEANUP SUMMARY');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`✅ Successfully sold: ${successCount}`);
    console.log(`❌ Failed to sell:   ${failCount}`);
    console.log('═══════════════════════════════════════════════════════════\n');

    rl.close();
    process.exit(0);
}

main().catch((error) => {
    Logger.error(`Fatal error: ${error}`);
    rl.close();
    process.exit(1);
});
