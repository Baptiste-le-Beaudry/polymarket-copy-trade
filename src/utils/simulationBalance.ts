/**
 * Virtual balance tracker for DRY_RUN mode
 * Simulates balance changes without real transactions
 */

import { ENV } from '../config/env';
import Logger from './logger';

interface BalanceSnapshot {
    timestamp: Date;
    balance: number;
    totalValue: number;
    positionsCount: number;
}

class SimulationBalanceTracker {
    private balance: number;
    private positions: Map<string, { size: number; avgPrice: number }>;
    private readonly startingBalance: number;
    private balanceHistory: BalanceSnapshot[];
    private sessionStartTime: Date;

    constructor(startingBalance: number) {
        this.startingBalance = startingBalance;
        this.balance = startingBalance;
        this.positions = new Map();
        this.balanceHistory = [];
        this.sessionStartTime = new Date();
        
        // Record initial balance
        this.recordSnapshot();
        
        Logger.info(`💰 Simulation mode: Starting with $${startingBalance.toFixed(2)} virtual balance`);
    }

    getBalance(): number {
        return this.balance;
    }

    getPosition(asset: string): { size: number; avgPrice: number } | undefined {
        return this.positions.get(asset);
    }

    getAllPositions(): Array<{ asset: string; size: number; avgPrice: number }> {
        return Array.from(this.positions.entries()).map(([asset, pos]) => ({
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
        };

        this.balanceHistory.push(snapshot);
    }

    /**
     * Simulate buying tokens
     */
    buy(asset: string, usdAmount: number, price: number): void {
        if (usdAmount > this.balance) {
            throw new Error(`Insufficient virtual balance: $${this.balance.toFixed(2)} < $${usdAmount.toFixed(2)}`);
        }

        const tokens = usdAmount / price;
        const existing = this.positions.get(asset);

        if (existing) {
            // Update average price
            const totalTokens = existing.size + tokens;
            const totalValue = existing.size * existing.avgPrice + tokens * price;
            existing.size = totalTokens;
            existing.avgPrice = totalValue / totalTokens;
        } else {
            this.positions.set(asset, { size: tokens, avgPrice: price });
        }

        this.balance -= usdAmount;
        Logger.success(`✓ [VIRTUAL] Bought ${tokens.toFixed(2)} tokens @ $${price.toFixed(4)} = $${usdAmount.toFixed(2)}`);
        Logger.info(`💰 Virtual balance: $${this.balance.toFixed(2)}`);
        
        // Record snapshot after trade
        this.recordSnapshot();
    }

    /**
     * Simulate selling tokens
     */
    sell(asset: string, tokens: number, price: number): void {
        const position = this.positions.get(asset);
        if (!position) {
            throw new Error(`No position found for asset ${asset}`);
        }
        if (tokens > position.size) {
            throw new Error(`Insufficient tokens: ${position.size} < ${tokens}`);
        }

        const usdAmount = tokens * price;
        this.balance += usdAmount;

        position.size -= tokens;
        if (position.size < 0.01) {
            // Close position if less than 0.01 tokens remaining
            this.positions.delete(asset);
        }

        Logger.success(`✓ [VIRTUAL] Sold ${tokens.toFixed(2)} tokens @ $${price.toFixed(4)} = $${usdAmount.toFixed(2)}`);
        Logger.info(`💰 Virtual balance: $${this.balance.toFixed(2)}`);
        
        // Record snapshot after trade
        this.recordSnapshot();
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

        if (this.positions.size > 0) {
            Logger.info('\n📦 Virtual Positions:');
            for (const [asset, position] of this.positions.entries()) {
                const value = position.size * position.avgPrice;
                Logger.info(`   • ${asset.substring(0, 12)}... | ${position.size.toFixed(2)} tokens @ $${position.avgPrice.toFixed(4)} = $${value.toFixed(2)}`);
            }
        }
        Logger.separator();
    }

    reset(): void {
        this.balance = this.startingBalance;
        this.positions.clear();
        this.balanceHistory = [];
        this.sessionStartTime = new Date();
        this.recordSnapshot();
        Logger.info(`🔄 Virtual balance reset to $${this.startingBalance.toFixed(2)}`);
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

        // Display summary stats
        Logger.info(`📅 Session Duration: ${this.getSessionDuration()}`);
        Logger.info(`💰 Starting Value: $${startValue.toFixed(2)}`);
        Logger.info(`💵 Current Value:  $${endValue.toFixed(2)}`);
        const pnlColor = pnl >= 0 ? '🟢' : '🔴';
        Logger.info(`${pnlColor} Profit/Loss:   $${pnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)`);
        Logger.info(`📈 Peak Value:     $${maxValue.toFixed(2)}`);
        Logger.info(`📉 Lowest Value:   $${minValue.toFixed(2)}`);
        Logger.separator();

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
        console.log(`          ${this.formatTime(history[0].timestamp).padEnd(chartWidth / 2)}${this.formatTime(history[history.length - 1].timestamp).padStart(chartWidth / 2)}`);
        
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
     * Format timestamp for chart labels
     */
    private formatTime(date: Date): string {
        return date.toLocaleTimeString('en-US', { 
            hour: '2-digit', 
            minute: '2-digit',
            hour12: false 
        });
    }

    /**
     * Get balance history data (for external analysis)
     */
    getBalanceHistory(): BalanceSnapshot[] {
        return [...this.balanceHistory];
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
