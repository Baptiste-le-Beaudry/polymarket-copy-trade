/**
 * Position Tracker - Persistent position tracking
 * 
 * Tracks all positions opened by the bot in a JSON file to:
 * - Persist positions across bot restarts
 * - Track position age for cleanup
 * - Monitor small positions that need to be sold
 * - Keep full trade history
 */

import * as fs from 'fs';
import * as path from 'path';
import Logger from './logger';

const POSITIONS_FILE = path.join(process.cwd(), 'data', 'positions.json');
const TRADE_HISTORY_FILE = path.join(process.cwd(), 'data', 'trade_history.json');

export interface TradeHistoryEntry {
    timestamp: number;
    date: string; // Human readable date
    side: 'BUY' | 'SELL';
    market: string;
    outcome: string;
    size: number;
    price: number;
    value: number;
    trader: string;
    conditionId: string;
    pnl?: number; // Profit/Loss for SELL trades
}

export interface TradeHistory {
    trades: TradeHistoryEntry[];
    totalBuys: number;
    totalSells: number;
    totalVolume: number;
    realizedPnL: number;
    lastUpdated: number;
}

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
    private history: TradeHistory;
    private dataDir: string;

    constructor() {
        this.dataDir = path.join(process.cwd(), 'data');
        this.ensureDataDir();
        this.store = this.loadStore();
        this.history = this.loadHistory();
        
        // Clean up any positions with zero size on startup
        this.cleanupClosedPositions();
    }

    private ensureDataDir(): void {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
            Logger.info(`Created data directory: ${this.dataDir}`);
        }
    }

    private loadHistory(): TradeHistory {
        const isDryRun = process.env.DRY_RUN === 'true';
        
        // In DRY_RUN mode, start fresh
        if (isDryRun) {
            return {
                trades: [],
                totalBuys: 0,
                totalSells: 0,
                totalVolume: 0,
                realizedPnL: 0,
                lastUpdated: Date.now(),
            };
        }
        
        if (!fs.existsSync(TRADE_HISTORY_FILE)) {
            return {
                trades: [],
                totalBuys: 0,
                totalSells: 0,
                totalVolume: 0,
                realizedPnL: 0,
                lastUpdated: Date.now(),
            };
        }

        try {
            const data = fs.readFileSync(TRADE_HISTORY_FILE, 'utf-8');
            return JSON.parse(data);
        } catch (error) {
            return {
                trades: [],
                totalBuys: 0,
                totalSells: 0,
                totalVolume: 0,
                realizedPnL: 0,
                lastUpdated: Date.now(),
            };
        }
    }

    private saveHistory(): void {
        try {
            this.history.lastUpdated = Date.now();
            fs.writeFileSync(TRADE_HISTORY_FILE, JSON.stringify(this.history, null, 2), 'utf-8');
        } catch (error) {
            Logger.error(`Failed to save trade history: ${error}`);
        }
    }

    private addToHistory(entry: TradeHistoryEntry): void {
        this.history.trades.push(entry);
        this.history.totalVolume += entry.value;
        if (entry.side === 'BUY') {
            this.history.totalBuys++;
        } else {
            this.history.totalSells++;
            if (entry.pnl !== undefined) {
                this.history.realizedPnL += entry.pnl;
            }
        }
        this.saveHistory();
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

        // Add to global trade history
        this.addToHistory({
            timestamp: Date.now(),
            date: new Date().toLocaleString('fr-CA'),
            side: 'BUY',
            market,
            outcome,
            size,
            price,
            value,
            trader: trader || 'unknown',
            conditionId,
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
        
        // Calculate P&L
        const avgBuyPrice = pos.initialValue / pos.initialSize;
        const pnl = (price - avgBuyPrice) * size;
        
        // Add trade to history
        pos.trades.push({
            timestamp: Date.now(),
            side: 'SELL',
            size,
            price,
            value,
        });

        // Add to global trade history
        this.addToHistory({
            timestamp: Date.now(),
            date: new Date().toLocaleString('fr-CA'),
            side: 'SELL',
            market: pos.market,
            outcome: pos.outcome,
            size,
            price,
            value,
            trader: pos.trader || 'unknown',
            conditionId,
            pnl,
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
     * Clean up positions with zero or negative size
     */
    public cleanupClosedPositions(): number {
        let cleaned = 0;
        for (const key of Object.keys(this.store.positions)) {
            const pos = this.store.positions[key];
            if ((pos.currentSize || 0) < 0.01) {
                delete this.store.positions[key];
                cleaned++;
            }
        }
        if (cleaned > 0) {
            this.saveStore();
            Logger.info(`🧹 Cleaned up ${cleaned} closed positions from tracker`);
        }
        return cleaned;
    }

    /**
     * Get all tracked positions (only with size > 0)
     */
    public getAllPositions(): TrackedPosition[] {
        return Object.values(this.store.positions).filter(
            (pos) => (pos.currentSize || 0) > 0.01
        );
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
     * Get position count (only positions with size > 0)
     */
    public getPositionCount(): number {
        // Only count positions that still have tokens (not fully sold)
        return Object.values(this.store.positions).filter(
            (pos) => (pos.currentSize || 0) > 0.01
        ).length;
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

    /**
     * Get full trade history
     */
    public getTradeHistory(): TradeHistory {
        return this.history;
    }

    /**
     * Get recent trades (last N trades)
     */
    public getRecentTrades(count: number = 20): TradeHistoryEntry[] {
        return this.history.trades.slice(-count);
    }

    /**
     * Reset all positions and history (for simulation reset)
     */
    public reset(): void {
        // Clear positions
        this.store = {
            positions: {},
            lastUpdated: Date.now(),
        };
        
        // Clear history
        this.history = {
            trades: [],
            totalBuys: 0,
            totalSells: 0,
            totalVolume: 0,
            realizedPnL: 0,
            lastUpdated: Date.now(),
        };
        
        // Save cleared files
        this.saveStore();
        this.saveHistory();
        
        Logger.info('🧹 Position tracker and trade history cleared');
    }

    /**
     * Synchronize local tracker with real Polymarket positions
     * This ensures the tracker reflects actual positions on the blockchain
     * @param realPositions Array of positions from Polymarket API
     * @returns { added: number, removed: number, updated: number }
     */
    public syncWithRealPositions(realPositions: Array<{
        asset: string;
        conditionId: string;
        title?: string;
        slug?: string;
        outcome?: string;
        size: number;
        avgPrice?: number;
        currentValue?: number;
    }>): { added: number; removed: number; updated: number } {
        let added = 0;
        let removed = 0;
        let updated = 0;

        const realConditionIds = new Set(realPositions.filter(p => p.size > 0).map(p => p.conditionId));

        // Remove positions from tracker that don't exist on Polymarket anymore
        const trackedConditionIds = Object.keys(this.store.positions);
        for (const conditionId of trackedConditionIds) {
            if (!realConditionIds.has(conditionId)) {
                const pos = this.store.positions[conditionId];
                Logger.warning(`🗑️ Removing closed position from tracker: ${pos.market || conditionId}`);
                delete this.store.positions[conditionId];
                removed++;
            }
        }

        // Add/update positions from Polymarket
        for (const realPos of realPositions) {
            if (realPos.size <= 0) continue; // Skip empty positions

            const key = realPos.conditionId;
            const existingPos = this.store.positions[key];

            if (!existingPos) {
                // Add missing position to tracker
                Logger.info(`➕ Adding untracked position: ${realPos.title || realPos.slug || realPos.conditionId}`);
                this.store.positions[key] = {
                    asset: realPos.asset,
                    conditionId: realPos.conditionId,
                    market: realPos.title || realPos.slug || 'Unknown Market',
                    outcome: realPos.outcome || 'Unknown',
                    openedAt: Date.now(), // Unknown actual open time
                    initialSize: realPos.size,
                    initialValue: realPos.currentValue || realPos.size * (realPos.avgPrice || 0.5),
                    currentSize: realPos.size,
                    currentValue: realPos.currentValue || realPos.size * (realPos.avgPrice || 0.5),
                    lastUpdated: Date.now(),
                    trades: [{
                        timestamp: Date.now(),
                        side: 'BUY',
                        size: realPos.size,
                        price: realPos.avgPrice || 0.5,
                        value: realPos.currentValue || realPos.size * (realPos.avgPrice || 0.5),
                    }],
                };
                added++;
            } else {
                // Update existing position if size changed significantly
                const currentSize = existingPos.currentSize ?? existingPos.initialSize ?? 0;
                const sizeDiff = Math.abs(currentSize - realPos.size);
                if (sizeDiff > 0.01) {
                    Logger.info(`🔄 Updating position size: ${existingPos.market} (${currentSize.toFixed(2)} → ${realPos.size.toFixed(2)})`);
                    existingPos.currentSize = realPos.size;
                    existingPos.currentValue = realPos.currentValue || realPos.size * (realPos.avgPrice || 0.5);
                    existingPos.lastUpdated = Date.now();
                    updated++;
                }
            }
        }

        // Save changes
        if (added > 0 || removed > 0 || updated > 0) {
            this.saveStore();
        }

        return { added, removed, updated };
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

export function resetPositionTracker(): void {
    if (trackerInstance) {
        trackerInstance.reset();
    }
    trackerInstance = null;
}

export default getPositionTracker;
