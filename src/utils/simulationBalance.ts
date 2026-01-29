/**
 * Virtual balance tracker for DRY_RUN mode
 * Simulates balance changes without real transactions
 * Includes estimated fees (gas + slippage) for realistic simulation
 */

import { ENV } from '../config/env';
import Logger from './logger';
import * as fs from 'fs';
import * as path from 'path';
import ReportGenerator from './reportGenerator';

// Estimated fees for realistic simulation
const ESTIMATED_GAS_FEE_USD = 0.03; // Average gas fee per transaction on Polygon (~$0.02-0.05)
const ESTIMATED_SLIPPAGE_PERCENT = 0.5; // 0.5% slippage on market orders

interface BalanceSnapshot {
    timestamp: Date;
    balance: number;
    totalValue: number;
    positionsCount: number;
    cashBalance?: number; // Optional for backward compatibility
}

interface SimulationPosition {
    size: number;
    avgPrice: number;
    openedAt: number; // timestamp
    market?: string;
}

class SimulationBalanceTracker {
    private balance: number;
    private positions: Map<string, SimulationPosition>;
    private readonly startingBalance: number;
    private balanceHistory: BalanceSnapshot[];
    private sessionStartTime: Date;
    private totalFeesPaid: number = 0;

    constructor(startingBalance: number) {
        this.startingBalance = startingBalance;
        this.balance = startingBalance;
        this.positions = new Map();
        this.balanceHistory = [];
        this.sessionStartTime = new Date();
        this.totalFeesPaid = 0;
        
        // Record initial balance
        this.recordSnapshot();
        
        Logger.info(`💰 Simulation mode: Starting with $${startingBalance.toFixed(2)} virtual balance`);
        Logger.info(`💸 Fees enabled: Gas fee $${ESTIMATED_GAS_FEE_USD}/tx, Slippage ${ESTIMATED_SLIPPAGE_PERCENT}%`);
    }

    getBalance(): number {
        return this.balance;
    }

    getPosition(asset: string): SimulationPosition | undefined {
        return this.positions.get(asset);
    }

    getAllPositions(): Array<{ asset: string; size: number; avgPrice: number; openedAt: number; market?: string }> {
        return Array.from(this.positions.entries()).map(([asset, pos]) => ({
            asset,
            ...pos,
        }));
    }

    /**
     * Get positions older than specified days
     * Also returns positions without openedAt timestamp (legacy positions)
     */
    getOldPositions(daysOld: number): Array<{ asset: string; size: number; avgPrice: number; openedAt: number; market?: string }> {
        const cutoffTime = Date.now() - daysOld * 24 * 60 * 60 * 1000;
        return Array.from(this.positions.entries())
            .filter(([_, pos]) => !pos.openedAt || pos.openedAt < cutoffTime) // Include positions without timestamp
            .map(([asset, pos]) => ({
                asset,
                ...pos,
            }));
    }

    /**
     * Record a snapshot of the current balance and portfolio value
     */
    private recordSnapshot(): void {
        const currentPrices = new Map<string, number>();
        // Use average prices for positions (in production, you'd fetch real prices)
        for (const [asset, position] of this.positions.entries()) {
            currentPrices.set(asset, position.avgPrice);
        }

        const snapshot: BalanceSnapshot = {
            timestamp: new Date(),
            balance: this.balance,
            totalValue: this.getTotalValue(currentPrices),
            positionsCount: this.positions.size,
            cashBalance: this.balance,
        };

        this.balanceHistory.push(snapshot);
    }

    /**
     * Simulate buying tokens (with gas fees and slippage)
     */
    buy(asset: string, usdAmount: number, price: number): void {
        // Validate price
        if (!price || price <= 0 || !isFinite(price)) {
            throw new Error(`Invalid price for buy: ${price}`);
        }
        if (!usdAmount || usdAmount <= 0 || !isFinite(usdAmount)) {
            throw new Error(`Invalid USD amount for buy: ${usdAmount}`);
        }
        
        // Calculate slippage and fees
        const slippageCost = usdAmount * (ESTIMATED_SLIPPAGE_PERCENT / 100);
        const effectiveUsdAmount = usdAmount + slippageCost; // Slippage increases cost
        const totalCost = effectiveUsdAmount + ESTIMATED_GAS_FEE_USD; // Add gas fee
        
        // Check MIN_CASH_RESERVE - don't go below the reserve
        const minReserve = ENV.MIN_CASH_RESERVE || 0;
        const availableAfterReserve = Math.max(0, this.balance - minReserve);
        
        if (totalCost > availableAfterReserve) {
            throw new Error(`Insufficient virtual balance: $${this.balance.toFixed(2)} - $${minReserve.toFixed(0)} reserve = $${availableAfterReserve.toFixed(2)} available, need $${totalCost.toFixed(2)}`);
        }
        
        if (totalCost > this.balance) {
            throw new Error(`Insufficient virtual balance: $${this.balance.toFixed(2)} < $${totalCost.toFixed(2)} (including fees)`);
        }

        const tokens = usdAmount / price; // Tokens based on original amount
        const existing = this.positions.get(asset);

        if (existing) {
            // Update average price but keep original opened date
            const totalTokens = existing.size + tokens;
            const totalValue = existing.size * existing.avgPrice + tokens * price;
            existing.size = totalTokens;
            existing.avgPrice = totalValue / totalTokens;
        } else {
            this.positions.set(asset, { 
                size: tokens, 
                avgPrice: price,
                openedAt: Date.now()
            });
        }

        this.balance -= totalCost;
        this.totalFeesPaid += slippageCost + ESTIMATED_GAS_FEE_USD;
        
        Logger.success(`✓ [VIRTUAL] Bought ${tokens.toFixed(2)} tokens @ $${price.toFixed(4)} = $${usdAmount.toFixed(2)} +${slippageCost.toFixed(3)} slippage +${ESTIMATED_GAS_FEE_USD.toFixed(3)} gas`);
        Logger.info(`💰 Virtual balance: $${this.balance.toFixed(2)} (fees paid: $${this.totalFeesPaid.toFixed(2)})`);
        
        // Record snapshot after trade
        this.recordSnapshot();
    }

    /**
     * Simulate selling tokens (with gas fees)
     */
    sell(asset: string, tokens: number, price: number): void {
        // Validate inputs
        if (!price || price <= 0 || !isFinite(price)) {
            throw new Error(`Invalid price for sell: ${price}`);
        }
        if (!tokens || tokens <= 0 || !isFinite(tokens)) {
            throw new Error(`Invalid token amount for sell: ${tokens}`);
        }
        
        const position = this.positions.get(asset);
        if (!position) {
            throw new Error(`No position found for asset ${asset}`);
        }
        if (tokens > position.size) {
            throw new Error(`Insufficient tokens: ${position.size} < ${tokens}`);
        }

        const usdAmount = tokens * price;
        const netUsdAmount = usdAmount - ESTIMATED_GAS_FEE_USD; // Deduct gas fee from proceeds
        
        this.balance += netUsdAmount;
        this.totalFeesPaid += ESTIMATED_GAS_FEE_USD;

        position.size -= tokens;
        if (position.size < 0.01) {
            // Close position if less than 0.01 tokens remaining
            this.positions.delete(asset);
        }

        Logger.success(`✓ [VIRTUAL] Sold ${tokens.toFixed(2)} tokens @ $${price.toFixed(4)} = $${usdAmount.toFixed(2)} -${ESTIMATED_GAS_FEE_USD.toFixed(3)} gas`);
        Logger.info(`💰 Virtual balance: $${this.balance.toFixed(2)} (fees paid: $${this.totalFeesPaid.toFixed(2)})`);
        
        // Record snapshot after trade
        this.recordSnapshot();
    }

    /**
     * Sell entire position (alias for stale position auto-selling)
     */
    sellPosition(asset: string, tokens: number, currentPrice: number): void {
        this.sell(asset, tokens, currentPrice);
    }

    /**
     * Get total portfolio value (cash + positions at current prices)
     */
    getTotalValue(currentPrices: Map<string, number>): number {
        let positionsValue = 0;
        for (const [asset, position] of this.positions.entries()) {
            const currentPrice = currentPrices.get(asset) || position.avgPrice;
            positionsValue += position.size * currentPrice;
        }
        return this.balance + positionsValue;
    }

    /**
     * Get current balance (cash only)
     */
    getCurrentBalance(): number {
        return this.balance;
    }

    /**
     * Get starting balance
     */
    getStartingBalance(): number {
        return this.startingBalance;
    }

    /**
     * Get current positions value
     */
    getPositionsValue(): number {
        let positionsValue = 0;
        for (const [asset, position] of this.positions.entries()) {
            positionsValue += position.size * position.avgPrice;
        }
        return positionsValue;
    }

    /**
     * Print summary
     */
    printSummary(): void {
        Logger.separator();
        Logger.info('🧪 SIMULATION SUMMARY');
        Logger.info(`💰 Starting Balance: $${this.startingBalance.toFixed(2)}`);
        Logger.info(`💵 Current Cash:     $${this.balance.toFixed(2)}`);
        Logger.info(`📊 Open Positions:   ${this.positions.size}`);
        
        const totalInvested = this.startingBalance - this.balance;
        if (totalInvested > 0) {
            Logger.info(`📈 Invested:         $${totalInvested.toFixed(2)}`);
        }
        Logger.info(`💸 Total Fees Paid:  $${this.totalFeesPaid.toFixed(2)} (gas + slippage)`);

        if (this.positions.size > 0) {
            Logger.info('\n📦 Virtual Positions:');
            for (const [asset, position] of this.positions.entries()) {
                const value = position.size * position.avgPrice;
                Logger.info(`   • ${asset.substring(0, 12)}... | ${position.size.toFixed(2)} tokens @ $${position.avgPrice.toFixed(4)} = $${value.toFixed(2)}`);
            }
        }

        // Trader statistics
        const positionTracker = require('./positionTracker').getPositionTracker();
        const traderStats = positionTracker.getTraderStats();
        
        if (traderStats.length > 0) {
            Logger.separator();
            Logger.info('👥 TRADER PERFORMANCE');
            for (let i = 0; i < Math.min(5, traderStats.length); i++) {
                const trader = traderStats[i];
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}️⃣`;
                Logger.info(
                    `${medal} ${trader.trader.substring(0, 10)}... | ` +
                    `${trader.totalTrades} trades | ` +
                    `$${trader.totalVolume.toFixed(2)} volume | ` +
                    `${trader.positionsOpened} positions | ` +
                    `$${trader.avgTradeSize.toFixed(2)} avg`
                );
            }
        }

        Logger.separator();
    }

    reset(): void {
        this.balance = this.startingBalance;
        this.positions.clear();
        this.balanceHistory = [];
        this.sessionStartTime = new Date();
        this.totalFeesPaid = 0;
        this.recordSnapshot();
        Logger.info(`🔄 Virtual balance reset to $${this.startingBalance.toFixed(2)}`);
    }

    /**
     * Close all open positions at current prices
     * Returns the final balance after selling everything
     */
    closeAllPositions(): number {
        if (this.positions.size === 0) {
            Logger.info('📦 No positions to close');
            return this.balance;
        }

        Logger.separator();
        Logger.info('🔒 CLOSING ALL POSITIONS (SHUTDOWN)');
        Logger.separator();

        const positionsToClose = Array.from(this.positions.entries());
        let totalProceeds = 0;
        let totalPositionsValue = 0;
        const closureDetails: string[] = [];
        const positionTracker = require('./positionTracker').getPositionTracker();

        // Calculate initial total value before closing
        for (const [asset, position] of positionsToClose) {
            const positionValue = position.size * position.avgPrice;
            totalPositionsValue += positionValue;
        }

        Logger.info(`💼 Closing ${positionsToClose.length} positions worth $${totalPositionsValue.toFixed(2)} total`);
        Logger.separator();

        for (const [asset, position] of positionsToClose) {
            const usdAmount = position.size * position.avgPrice;
            const netUsdAmount = usdAmount - ESTIMATED_GAS_FEE_USD;
            
            totalProceeds += netUsdAmount;
            this.balance += netUsdAmount;
            this.totalFeesPaid += ESTIMATED_GAS_FEE_USD;

            const logLine = `✓ Closed ${asset.substring(0, 12)}... | ` +
                `${position.size.toFixed(2)} tokens @ $${position.avgPrice.toFixed(4)} = ` +
                `$${netUsdAmount.toFixed(2)} (after gas)`;
            
            Logger.success(logLine);
            closureDetails.push(logLine);
            
            // Track sell in position tracker
            try {
                positionTracker.trackSell(asset, position.size, position.avgPrice, usdAmount);
            } catch (error) {
                // Position might not be tracked, ignore error during shutdown
            }
        }

        this.positions.clear();
        
        // Record snapshot AFTER positions are closed to show final value
        this.recordSnapshot();

        Logger.separator();
        Logger.success(`💰 All positions closed | Total proceeds: $${totalProceeds.toFixed(2)}`);
        Logger.success(`💵 Final balance: $${this.balance.toFixed(2)}`);
        Logger.success(`📈 Portfolio liquidated at shutdown: +$${(totalProceeds - (totalPositionsValue - (positionsToClose.length * ESTIMATED_GAS_FEE_USD))).toFixed(2)} net after fees`);
        Logger.separator();

        return this.balance;
    }

    /**
     * Generate an ASCII chart showing balance over time
     */
    generateChart(): void {
        if (this.balanceHistory.length < 2) {
            Logger.info('📊 Not enough data to generate chart (need at least 2 snapshots)');
            return;
        }

        Logger.separator();
        Logger.info('📊 BALANCE EVOLUTION CHART');
        Logger.separator();

        const history = this.balanceHistory;
        const chartHeight = 15;
        const chartWidth = 60;

        // Find min/max values
        const values = history.map(s => s.totalValue);
        const minValue = Math.min(...values);
        const maxValue = Math.max(...values);
        const valueRange = maxValue - minValue || 1;

        // Calculate performance
        const startValue = history[0].totalValue;
        const endValue = history[history.length - 1].totalValue;
        const pnl = endValue - startValue;
        const pnlPercent = ((endValue - startValue) / startValue) * 100;

        // Check if there was a significant jump in the last snapshot (liquidation)
        let liquidationEffect = 0;
        if (history.length >= 2) {
            const secondToLastValue = history[history.length - 2].totalValue;
            liquidationEffect = endValue - secondToLastValue;
        }

        // Display summary stats
        Logger.info(`📅 Session Duration: ${this.getSessionDuration()}`);
        Logger.info(`💰 Starting Value: $${startValue.toFixed(2)}`);
        Logger.info(`💵 Current Value:  $${endValue.toFixed(2)}`);
        const pnlColor = pnl >= 0 ? '🟢' : '🔴';
        Logger.info(`${pnlColor} Profit/Loss:   $${pnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)`);
        Logger.info(`📈 Peak Value:     $${maxValue.toFixed(2)}`);
        Logger.info(`📉 Lowest Value:   $${minValue.toFixed(2)}`);
        
        // Show liquidation effect if significant
        if (Math.abs(liquidationEffect) > 1.0) {
            Logger.info(`🔒 Final Liquidation: ${liquidationEffect >= 0 ? '+' : ''}$${liquidationEffect.toFixed(2)} (positions → cash)`);
        }

        // Generate ASCII chart
        const chart: string[][] = Array(chartHeight).fill(null).map(() => Array(chartWidth).fill(' '));

        // Plot line
        for (let i = 0; i < chartWidth; i++) {
            const dataIndex = Math.floor((i / chartWidth) * history.length);
            const value = history[dataIndex].totalValue;
            const normalizedValue = (value - minValue) / valueRange;
            const yPos = chartHeight - 1 - Math.floor(normalizedValue * (chartHeight - 1));

            // Draw point and connecting line
            chart[yPos][i] = '●';
            
            // Fill vertical line for visual effect
            if (i > 0) {
                const prevDataIndex = Math.floor(((i - 1) / chartWidth) * history.length);
                const prevValue = history[prevDataIndex].totalValue;
                const prevNormalizedValue = (prevValue - minValue) / valueRange;
                const prevYPos = chartHeight - 1 - Math.floor(prevNormalizedValue * (chartHeight - 1));

                const minY = Math.min(yPos, prevYPos);
                const maxY = Math.max(yPos, prevYPos);
                for (let y = minY; y <= maxY; y++) {
                    if (chart[y][i] === ' ') {
                        chart[y][i] = '│';
                    }
                }
            }
        }

        // Print chart with labels
        console.log(`\n  $${maxValue.toFixed(0).padStart(6)} ┤`);
        for (let y = 0; y < chartHeight; y++) {
            const value = minValue + ((chartHeight - 1 - y) / (chartHeight - 1)) * valueRange;
            if (y === Math.floor(chartHeight / 2)) {
                console.log(`  $${value.toFixed(0).padStart(6)} ┤` + chart[y].join(''));
            } else {
                console.log(`         ┤` + chart[y].join(''));
            }
        }
        console.log(`  $${minValue.toFixed(0).padStart(6)} ┤`);
        console.log(`         └${'─'.repeat(chartWidth)}`);
        console.log(`          ${this.formatElapsedTime(history[0].timestamp).padEnd(chartWidth / 2)}${this.formatElapsedTime(history[history.length - 1].timestamp).padStart(chartWidth / 2)}`);
        
        // Add liquidation annotation if applicable
        if (Math.abs(liquidationEffect) > 1.0) {
            console.log(`         ${' '.repeat(chartWidth - 10)}↑ Final liquidation: ${liquidationEffect >= 0 ? '+' : ''}$${liquidationEffect.toFixed(2)}`);
        }
        
        Logger.separator();

        // Trade statistics
        const totalTrades = history.length - 1;
        Logger.info(`📊 Total Snapshots: ${totalTrades}`);
        Logger.info(`📦 Current Positions: ${this.positions.size}`);
        Logger.separator();
    }

    /**
     * Get session duration as human-readable string
     */
    private getSessionDuration(): string {
        const duration = Date.now() - this.sessionStartTime.getTime();
        const hours = Math.floor(duration / (1000 * 60 * 60));
        const minutes = Math.floor((duration % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((duration % (1000 * 60)) / 1000);

        if (hours > 0) {
            return `${hours}h ${minutes}m ${seconds}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds}s`;
        } else {
            return `${seconds}s`;
        }
    }

    /**
     * Format timestamp for chart labels (show elapsed time in hours)
     */
    private formatTime(date: Date): string {
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        return `${hours}:${minutes}`;
    }

    /**
     * Format timestamp as elapsed hours since session start
     */
    private formatElapsedTime(date: Date): string {
        const elapsed = date.getTime() - this.sessionStartTime.getTime();
        const hours = elapsed / (1000 * 60 * 60);
        
        if (hours < 1) {
            const minutes = Math.floor(elapsed / (1000 * 60));
            return `${minutes}m`;
        } else if (hours < 10) {
            return `${hours.toFixed(1)}h`;
        } else {
            return `${Math.floor(hours)}h`;
        }
    }

    /**
     * Get balance history data (for external analysis)
     */
    getBalanceHistory(): BalanceSnapshot[] {
        return [...this.balanceHistory];
    }

    /**
     * Get total fees paid
     */
    getTotalFeesPaid(): number {
        return this.totalFeesPaid;
    }

    /**
     * Generate HTML report with charts
     */
    generateHTMLReport(): void {
        const reportGen = new ReportGenerator();
        
        const stats = {
            startingBalance: this.startingBalance,
            endingBalance: this.balance,
            endingTotalValue: this.getTotalValue(
                new Map(Array.from(this.positions.entries()).map(([k, v]) => [k, v.avgPrice]))
            ),
            totalFeesPaid: this.totalFeesPaid,
            sessionDuration: this.getSessionDuration(),
            positionsCount: this.positions.size,
            balanceHistory: this.balanceHistory,
        };

        reportGen.generateReport(stats);
    }

    /**
     * Generate text report file (overwrites existing file)
     */
    generateTextReport(): void {
        const reportPath = path.join(process.cwd(), 'simulation-report.txt');
        
        // Get trader statistics
        const positionTracker = require('./positionTracker').getPositionTracker();
        const traderStats = positionTracker.getTraderStats();
        
        // Calculate summary values
        const history = this.balanceHistory;
        const startValue = history[0]?.totalValue || this.startingBalance;
        const endValue = history[history.length - 1]?.totalValue || this.balance;
        const pnl = endValue - startValue;
        const pnlPercent = ((endValue - startValue) / startValue) * 100;
        
        const values = history.map(s => s.totalValue);
        const minValue = Math.min(...values);
        const maxValue = Math.max(...values);
        
        // Build report content
        let report = '';
        report += '='.repeat(80) + '\n';
        report += '                    SIMULATION REPORT\n';
        report += '='.repeat(80) + '\n';
        report += `Generated: ${new Date().toLocaleString()}\n`;
        report += `Session Duration: ${this.getSessionDuration()}\n`;
        report += '\n';
        
        // Performance Summary
        report += '-'.repeat(80) + '\n';
        report += 'PERFORMANCE SUMMARY\n';
        report += '-'.repeat(80) + '\n';
        report += `Starting Balance: $${this.startingBalance.toFixed(2)}\n`;
        report += `Current Cash:     $${this.balance.toFixed(2)}\n`;
        report += `Starting Value:   $${startValue.toFixed(2)}\n`;
        report += `Current Value:    $${endValue.toFixed(2)}\n`;
        report += `Profit/Loss:      $${pnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)\n`;
        report += `Peak Value:       $${maxValue.toFixed(2)}\n`;
        report += `Lowest Value:     $${minValue.toFixed(2)}\n`;
        report += `Total Fees Paid:  $${this.totalFeesPaid.toFixed(2)} (gas + slippage)\n`;
        report += '\n';
        
        // Open Positions
        report += '-'.repeat(80) + '\n';
        report += `OPEN POSITIONS (${this.positions.size})\n`;
        report += '-'.repeat(80) + '\n';
        if (this.positions.size > 0) {
            const totalInvested = this.startingBalance - this.balance;
            report += `Total Invested: $${totalInvested.toFixed(2)}\n\n`;
            
            for (const [asset, position] of this.positions.entries()) {
                const value = position.size * position.avgPrice;
                report += `  • ${asset}\n`;
                report += `    Tokens: ${position.size.toFixed(2)} @ $${position.avgPrice.toFixed(4)}\n`;
                report += `    Value:  $${value.toFixed(2)}\n\n`;
            }
        } else {
            report += 'No open positions\n';
            
            // Check if we have a significant jump in the final balance snapshot
            // This indicates positions were closed at shutdown
            if (history.length >= 2) {
                const secondToLastValue = history[history.length - 2].totalValue;
                const finalValue = endValue;
                const shutdownGain = finalValue - secondToLastValue;
                
                if (Math.abs(shutdownGain) > 1.0) {
                    report += `\n📋 SHUTDOWN LIQUIDATION DETECTED\n`;
                    report += `Portfolio value before shutdown: $${secondToLastValue.toFixed(2)}\n`;
                    report += `Portfolio value after closing positions: $${finalValue.toFixed(2)}\n`;
                    report += `Net effect of position closure: ${shutdownGain >= 0 ? '+' : ''}$${shutdownGain.toFixed(2)}\n`;
                }
            }
        }
        
        // Balance Chart (ASCII)
        if (history.length >= 2) {
            report += '-'.repeat(80) + '\n';
            report += 'BALANCE EVOLUTION CHART\n';
            report += '-'.repeat(80) + '\n';
            
            const chartHeight = 15;
            const chartWidth = 60;
            const valueRange = maxValue - minValue || 1;
            
            // Generate ASCII chart
            const chart: string[][] = Array(chartHeight).fill(null).map(() => Array(chartWidth).fill(' '));
            
            for (let i = 0; i < chartWidth; i++) {
                const dataIndex = Math.floor((i / chartWidth) * history.length);
                const value = history[dataIndex].totalValue;
                const normalizedValue = (value - minValue) / valueRange;
                const yPos = chartHeight - 1 - Math.floor(normalizedValue * (chartHeight - 1));
                
                chart[yPos][i] = '●';
                
                if (i > 0) {
                    const prevDataIndex = Math.floor(((i - 1) / chartWidth) * history.length);
                    const prevValue = history[prevDataIndex].totalValue;
                    const prevNormalizedValue = (prevValue - minValue) / valueRange;
                    const prevYPos = chartHeight - 1 - Math.floor(prevNormalizedValue * (chartHeight - 1));
                    
                    const minY = Math.min(yPos, prevYPos);
                    const maxY = Math.max(yPos, prevYPos);
                    for (let y = minY; y <= maxY; y++) {
                        if (chart[y][i] === ' ') {
                            chart[y][i] = '│';
                        }
                    }
                }
            }
            
            // Add chart to report
            report += `\n  $${maxValue.toFixed(0).padStart(6)} ┤\n`;
            for (let y = 0; y < chartHeight; y++) {
                const value = minValue + ((chartHeight - 1 - y) / (chartHeight - 1)) * valueRange;
                if (y === Math.floor(chartHeight / 2)) {
                    report += `  $${value.toFixed(0).padStart(6)} ┤` + chart[y].join('') + '\n';
                } else {
                    report += `         ┤` + chart[y].join('') + '\n';
                }
            }
            report += `  $${minValue.toFixed(0).padStart(6)} ┤\n`;
            report += `         └${'─'.repeat(chartWidth)}\n`;
            const startTime = this.formatElapsedTime(history[0].timestamp);
            const endTime = this.formatElapsedTime(history[history.length - 1].timestamp);
            report += `          ${startTime.padEnd(chartWidth / 2)}${endTime.padStart(chartWidth / 2)}\n\n`;
        }
        
        // Trader Performance
        if (traderStats.length > 0) {
            report += '-'.repeat(80) + '\n';
            report += 'TRADER PERFORMANCE (Top 10)\n';
            report += '-'.repeat(80) + '\n';
            
            for (let i = 0; i < Math.min(10, traderStats.length); i++) {
                const trader = traderStats[i];
                const rank = i + 1;
                const medal = i === 0 ? '[1ST]' : i === 1 ? '[2ND]' : i === 2 ? '[3RD]' : `[${rank}th]`;
                
                report += `${medal} ${trader.trader}\n`;
                report += `     Trades:        ${trader.totalTrades}\n`;
                report += `     Total Volume:  $${trader.totalVolume.toFixed(2)}\n`;
                report += `     Positions:     ${trader.positionsOpened}\n`;
                report += `     Avg Trade:     $${trader.avgTradeSize.toFixed(2)}\n\n`;
            }
        }
        
        // Balance History
        if (history.length > 0) {
            report += '-'.repeat(80) + '\n';
            report += `BALANCE HISTORY (${history.length} snapshots)\n`;
            report += '-'.repeat(80) + '\n';
            
            // Show first 5 and last 5 snapshots
            const showCount = Math.min(5, Math.floor(history.length / 2));
            
            for (let i = 0; i < showCount; i++) {
                const snapshot = history[i];
                report += `${snapshot.timestamp.toLocaleString()}: $${snapshot.totalValue.toFixed(2)} `;
                report += `(Cash: $${(snapshot.cashBalance || snapshot.balance).toFixed(2)}, Positions: ${snapshot.positionsCount})\n`;
            }
            
            if (history.length > showCount * 2) {
                report += `... (${history.length - showCount * 2} snapshots omitted) ...\n`;
            }
            
            for (let i = Math.max(showCount, history.length - showCount); i < history.length; i++) {
                const snapshot = history[i];
                report += `${snapshot.timestamp.toLocaleString()}: $${snapshot.totalValue.toFixed(2)} `;
                report += `(Cash: $${(snapshot.cashBalance || snapshot.balance).toFixed(2)}, Positions: ${snapshot.positionsCount})\n`;
            }
            report += '\n';
        }
        
        report += '='.repeat(80) + '\n';
        report += 'END OF REPORT\n';
        report += '='.repeat(80) + '\n';
        
        // Write to file (overwrites existing)
        try {
            fs.writeFileSync(reportPath, report, 'utf-8');
            Logger.success(`📄 Text report saved: ${reportPath}`);
        } catch (error) {
            Logger.error(`Failed to write text report: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

// Singleton instance
let simulationTracker: SimulationBalanceTracker | null = null;

export const getSimulationTracker = (): SimulationBalanceTracker => {
    if (!simulationTracker) {
        const startingBalance = ENV.SIMULATION_STARTING_BALANCE || 1000;
        simulationTracker = new SimulationBalanceTracker(startingBalance);
    }
    return simulationTracker;
};

export const resetSimulationTracker = (): void => {
    if (simulationTracker) {
        simulationTracker.reset();
    }
};

export default getSimulationTracker;
