/**
 * Virtual balance tracker for DRY_RUN mode
 * Simulates balance changes without real transactions
 */

import { ENV } from '../config/env';
import Logger from './logger';

class SimulationBalanceTracker {
    private balance: number;
    private positions: Map<string, { size: number; avgPrice: number }>;
    private readonly startingBalance: number;

    constructor(startingBalance: number) {
        this.startingBalance = startingBalance;
        this.balance = startingBalance;
        this.positions = new Map();
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
        Logger.info(`🔄 Virtual balance reset to $${this.startingBalance.toFixed(2)}`);
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
