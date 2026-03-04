/**
 * Trader Cooldown Manager
 * Prevents copying multiple trades from the same trader on the SAME MARKET within a cooldown period
 * Only the FIRST trade per market is copied, subsequent trades on that market are ignored until cooldown expires
 * Trades on DIFFERENT markets are NOT blocked
 */

import Logger from './logger';

interface CooldownEntry {
    lastTradeTime: number; // Timestamp of last copied trade
    traderAddress: string;
    conditionId: string; // Market identifier
}

class TraderCooldownManager {
    private cooldowns: Map<string, CooldownEntry>; // Key: traderAddress_conditionId
    private cooldownWindowMs: number;

    constructor(cooldownWindowSeconds: number = 300) {
        this.cooldowns = new Map();
        this.cooldownWindowMs = cooldownWindowSeconds * 1000;
        Logger.info(`⏱️  Trader cooldown enabled: ${cooldownWindowSeconds}s between trades per trader PER MARKET`);
    }

    /**
     * Generate a unique key for trader + market combination
     */
    private getKey(traderAddress: string, conditionId: string): string {
        return `${traderAddress.toLowerCase()}_${conditionId}`;
    }

    /**
     * Check if a trader is in cooldown period for a specific market
     */
    isInCooldown(traderAddress: string, conditionId?: string): boolean {
        if (!conditionId) {
            return false; // No market specified = no cooldown
        }
        
        const key = this.getKey(traderAddress, conditionId);
        const entry = this.cooldowns.get(key);
        if (!entry) {
            return false;
        }

        const now = Date.now();
        const timeSinceLastTrade = now - entry.lastTradeTime;
        const inCooldown = timeSinceLastTrade < this.cooldownWindowMs;

        if (inCooldown) {
            const remainingSeconds = Math.ceil((this.cooldownWindowMs - timeSinceLastTrade) / 1000);
            Logger.info(`⏸️  Trader ${traderAddress.substring(0, 10)}... in cooldown for THIS MARKET (${remainingSeconds}s remaining)`);
        }

        return inCooldown;
    }

    /**
     * Record that a trade was copied from this trader for this market
     */
    recordTrade(traderAddress: string, conditionId: string): void {
        const key = this.getKey(traderAddress, conditionId);
        const now = Date.now();
        this.cooldowns.set(key, {
            lastTradeTime: now,
            traderAddress,
            conditionId,
        });

        const cooldownSeconds = this.cooldownWindowMs / 1000;
        Logger.info(`✓ Trade copied. Next trade on this market allowed in ${cooldownSeconds}s`);
    }

    /**
     * Check if we should copy this trade (not in cooldown for this market)
     * If yes, automatically record it
     */
    shouldCopyTrade(traderAddress: string, conditionId?: string): boolean {
        if (!conditionId) {
            // No market info = allow trade (legacy fallback)
            return true;
        }

        if (this.isInCooldown(traderAddress, conditionId)) {
            return false;
        }

        this.recordTrade(traderAddress, conditionId);
        return true;
    }

    /**
     * Get remaining cooldown time in seconds for a specific market
     */
    getRemainingCooldown(traderAddress: string, conditionId?: string): number {
        if (!conditionId) {
            return 0;
        }

        const key = this.getKey(traderAddress, conditionId);
        const entry = this.cooldowns.get(key);
        if (!entry) {
            return 0;
        }

        const now = Date.now();
        const timeSinceLastTrade = now - entry.lastTradeTime;
        const remaining = this.cooldownWindowMs - timeSinceLastTrade;

        return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
    }

    /**
     * Clear cooldown for a specific trader (all markets or specific market)
     */
    clearCooldown(traderAddress: string, conditionId?: string): void {
        if (conditionId) {
            const key = this.getKey(traderAddress, conditionId);
            this.cooldowns.delete(key);
            Logger.info(`🔄 Cooldown cleared for ${traderAddress.substring(0, 10)}... on market ${conditionId.substring(0, 8)}...`);
        } else {
            // Clear all cooldowns for this trader
            const prefix = traderAddress.toLowerCase() + '_';
            const keysToDelete: string[] = [];
            for (const key of this.cooldowns.keys()) {
                if (key.startsWith(prefix)) {
                    keysToDelete.push(key);
                }
            }
            keysToDelete.forEach(key => this.cooldowns.delete(key));
            Logger.info(`🔄 All cooldowns cleared for ${traderAddress.substring(0, 10)}...`);
        }
    }

    /**
     * Clear all cooldowns
     */
    clearAll(): void {
        this.cooldowns.clear();
        Logger.info('🔄 All trader cooldowns cleared');
    }

    /**
     * Get statistics
     */
    getStats(): { totalTrackedCombinations: number; combinationsInCooldown: number } {
        const now = Date.now();
        let combinationsInCooldown = 0;

        for (const entry of this.cooldowns.values()) {
            if (now - entry.lastTradeTime < this.cooldownWindowMs) {
                combinationsInCooldown++;
            }
        }

        return {
            totalTrackedCombinations: this.cooldowns.size,
            combinationsInCooldown,
        };
    }
}

// Singleton instance
let cooldownManager: TraderCooldownManager | null = null;

export const getTraderCooldownManager = (cooldownWindowSeconds?: number): TraderCooldownManager => {
    if (!cooldownManager && cooldownWindowSeconds !== undefined) {
        cooldownManager = new TraderCooldownManager(cooldownWindowSeconds);
    } else if (!cooldownManager) {
        // Default 5 minutes if not specified
        cooldownManager = new TraderCooldownManager(300);
    }
    return cooldownManager;
};

export const resetTraderCooldownManager = (): void => {
    if (cooldownManager) {
        cooldownManager.clearAll();
    }
    cooldownManager = null;
};

export default getTraderCooldownManager;
