/**
 * Position Tracker - Persistent position tracking
 * 
 * Tracks all positions opened by the bot in a JSON file to:
 * - Persist positions across bot restarts
 * - Track position age for cleanup
 * - Monitor small positions that need to be sold
 */

import * as fs from 'fs';
import * as path from 'path';
import Logger from './logger';

const POSITIONS_FILE = path.join(process.cwd(), 'data', 'positions.json');

export interface TrackedPosition {
    asset: string;
    conditionId: string;
    market: string;
    outcome: string;
    openedAt: number; // timestamp
    initialSize: number; // tokens
    initialValue: number; // USD
    currentSize?: number; // updated periodically
    currentValue?: number; // updated periodically
    lastUpdated?: number;
    trader?: string; // address of trader copied
    trades: {
        timestamp: number;
        side: 'BUY' | 'SELL';
        size: number;
        price: number;
        value: number;
        trader?: string;
    }[];
}

export interface PositionStore {
    positions: { [key: string]: TrackedPosition }; // key = conditionId
    lastUpdated: number;
}

class PositionTracker {
    private store: PositionStore;
    private dataDir: string;

    constructor() {
        this.dataDir = path.join(process.cwd(), 'data');
        this.ensureDataDir();
        this.store = this.loadStore();
    }

    private ensureDataDir(): void {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
            Logger.info(`Created data directory: ${this.dataDir}`);
        }
    }

    private loadStore(): PositionStore {
        // In DRY_RUN mode, always start with fresh positions
        const isDryRun = process.env.DRY_RUN === 'true';
        
        if (isDryRun) {
            const oldPositionsCount = this.getOldPositionsCount();
            if (oldPositionsCount > 0) {
                Logger.warning(`🧹 DRY_RUN mode: Clearing ${oldPositionsCount} old simulation positions`);
            }
            Logger.info('🆕 Starting fresh simulation - no positions loaded');
            return {
                positions: {},
                lastUpdated: Date.now(),
            };
        }
        
        if (!fs.existsSync(POSITIONS_FILE)) {
            return {
                positions: {},
                lastUpdated: Date.now(),
            };
        }

        try {
            const data = fs.readFileSync(POSITIONS_FILE, 'utf-8');
            const store = JSON.parse(data);
            Logger.info(`Loaded ${Object.keys(store.positions).length} tracked positions from disk`);
            return store;
        } catch (error) {
            Logger.error(`Failed to load positions file: ${error}`);
            return {
                positions: {},
                lastUpdated: Date.now(),
            };
        }
    }

    private getOldPositionsCount(): number {
        if (!fs.existsSync(POSITIONS_FILE)) {
            return 0;
        }
        try {
            const data = fs.readFileSync(POSITIONS_FILE, 'utf-8');
            const store = JSON.parse(data);
            return Object.keys(store.positions).length;
        } catch {
            return 0;
        }
    }

    private saveStore(): void {
        try {
            this.store.lastUpdated = Date.now();
            fs.writeFileSync(POSITIONS_FILE, JSON.stringify(this.store, null, 2), 'utf-8');
        } catch (error) {
            Logger.error(`Failed to save positions file: ${error}`);
        }
    }

    /**
     * Track a new BUY trade
     */
    public trackBuy(
        asset: string,
        conditionId: string,
        market: string,
        outcome: string,
        size: number,
        price: number,
        value: number,
        trader?: string
    ): void {
        const key = conditionId;
        
        if (!this.store.positions[key]) {
            // New position
            this.store.positions[key] = {
                asset,
                conditionId,
                market,
                outcome,
                openedAt: Date.now(),
                initialSize: size,
                initialValue: value,
                currentSize: size,
                currentValue: value,
                lastUpdated: Date.now(),
                trader,
                trades: [],
            };
            Logger.info(`📝 Tracking new position: ${market} - ${outcome}`);
        }

        // Add trade to history
        this.store.positions[key].trades.push({
            timestamp: Date.now(),
            side: 'BUY',
            size,
            price,
            value,
            trader,
        });

        // Update current values
        const pos = this.store.positions[key];
        pos.currentSize = (pos.currentSize || 0) + size;
        pos.currentValue = (pos.currentValue || 0) + value;
        pos.lastUpdated = Date.now();

        this.saveStore();
    }

    /**
     * Track a SELL trade
     */
    public trackSell(
        conditionId: string,
        size: number,
        price: number,
        value: number
    ): void {
        const key = conditionId;

        if (!this.store.positions[key]) {
            Logger.warning(`Position ${conditionId} not found in tracker - cannot track sell`);
            return;
        }

        const pos = this.store.positions[key];
        
        // Add trade to history
        pos.trades.push({
            timestamp: Date.now(),
            side: 'SELL',
            size,
            price,
            value,
        });

        // Update current values
        pos.currentSize = Math.max(0, (pos.currentSize || 0) - size);
        pos.lastUpdated = Date.now();

        // Remove position if fully closed
        if (pos.currentSize < 0.01) {
            Logger.info(`✅ Position fully closed: ${pos.market} - ${pos.outcome}`);
            delete this.store.positions[key];
        }

        this.saveStore();
    }

    /**
     * Update position with current market data
     */
    public updatePosition(conditionId: string, currentSize: number, currentValue: number): void {
        const key = conditionId;
        if (this.store.positions[key]) {
            this.store.positions[key].currentSize = currentSize;
            this.store.positions[key].currentValue = currentValue;
            this.store.positions[key].lastUpdated = Date.now();
            this.saveStore();
        }
    }

    /**
     * Get all tracked positions
     */
    public getAllPositions(): TrackedPosition[] {
        return Object.values(this.store.positions);
    }

    /**
     * Get positions older than X days
     */
    public getOldPositions(daysOld: number): TrackedPosition[] {
        const cutoffTime = Date.now() - daysOld * 24 * 60 * 60 * 1000;
        return Object.values(this.store.positions).filter(
            (pos) => pos.openedAt < cutoffTime
        );
    }

    /**
     * Get positions smaller than X tokens
     */
    public getSmallPositions(minTokens: number): TrackedPosition[] {
        return Object.values(this.store.positions).filter(
            (pos) => (pos.currentSize || 0) < minTokens && (pos.currentSize || 0) > 0
        );
    }

    /**
     * Get position count
     */
    public getPositionCount(): number {
        return Object.keys(this.store.positions).length;
    }

    /**
     * Check if we have a position
     */
    public hasPosition(conditionId: string): boolean {
        return !!this.store.positions[conditionId];
    }

    /**
     * Get a specific position
     */
    public getPosition(conditionId: string): TrackedPosition | undefined {
        return this.store.positions[conditionId];
    }

    /**
     * Remove a position manually
     */
    public removePosition(conditionId: string): void {
        if (this.store.positions[conditionId]) {
            delete this.store.positions[conditionId];
            this.saveStore();
            Logger.info(`Removed tracked position: ${conditionId}`);
        }
    }

    /**
     * Get summary statistics
     */
    public getSummary(): {
        totalPositions: number;
        oldPositions: number;
        smallPositions: number;
        totalValue: number;
    } {
        const positions = Object.values(this.store.positions);
        const old = this.getOldPositions(30).length;
        const small = this.getSmallPositions(1.0).length;
        const totalValue = positions.reduce((sum, pos) => sum + (pos.currentValue || 0), 0);

        return {
            totalPositions: positions.length,
            oldPositions: old,
            smallPositions: small,
            totalValue,
        };
    }

    /**
     * Get trader statistics
     */
    public getTraderStats(): Array<{
        trader: string;
        totalTrades: number;
        totalVolume: number;
        positionsOpened: number;
        avgTradeSize: number;
    }> {
        const traderMap = new Map<string, {
            trades: number;
            volume: number;
            positions: Set<string>;
        }>();

        // Aggregate stats from all positions
        for (const pos of Object.values(this.store.positions)) {
            for (const trade of pos.trades) {
                if (trade.trader) {
                    if (!traderMap.has(trade.trader)) {
                        traderMap.set(trade.trader, {
                            trades: 0,
                            volume: 0,
                            positions: new Set(),
                        });
                    }
                    const stats = traderMap.get(trade.trader)!;
                    stats.trades++;
                    stats.volume += trade.value;
                    if (trade.side === 'BUY') {
                        stats.positions.add(pos.conditionId);
                    }
                }
            }
        }

        // Convert to array and sort by volume
        return Array.from(traderMap.entries())
            .map(([trader, stats]) => ({
                trader,
                totalTrades: stats.trades,
                totalVolume: stats.volume,
                positionsOpened: stats.positions.size,
                avgTradeSize: stats.volume / stats.trades,
            }))
            .sort((a, b) => b.totalVolume - a.totalVolume);
    }
}

// Singleton instance
let trackerInstance: PositionTracker | null = null;

export function getPositionTracker(): PositionTracker {
    if (!trackerInstance) {
        trackerInstance = new PositionTracker();
    }
    return trackerInstance;
}

export default getPositionTracker;
