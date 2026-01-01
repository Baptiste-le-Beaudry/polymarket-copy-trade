/**
 * Trader Cooldown Manager
 * Prevents copying multiple trades from the same trader within a cooldown period
 * Only the FIRST trade is copied, subsequent trades are ignored until cooldown expires
 */

import Logger from './logger';

interface CooldownEntry {
    lastTradeTime: number; // Timestamp of last copied trade
    traderAddress: string;
}

class TraderCooldownManager {
    private cooldowns: Map<string, CooldownEntry>;
    private cooldownWindowMs: number;

    constructor(cooldownWindowSeconds: number = 300) {
        this.cooldowns = new Map();
        this.cooldownWindowMs = cooldownWindowSeconds * 1000;
        Logger.info(`⏱️  Trader cooldown enabled: ${cooldownWindowSeconds}s between trades per trader`);
    }

    /**
     * Check if a trader is in cooldown period
     */
    isInCooldown(traderAddress: string): boolean {
        const entry = this.cooldowns.get(traderAddress.toLowerCase());
        if (!entry) {
            return false;
        }

        const now = Date.now();
        const timeSinceLastTrade = now - entry.lastTradeTime;
        const inCooldown = timeSinceLastTrade < this.cooldownWindowMs;

        if (inCooldown) {
            const remainingSeconds = Math.ceil((this.cooldownWindowMs - timeSinceLastTrade) / 1000);
            Logger.info(`⏸️  Trader ${traderAddress.substring(0, 10)}... in cooldown (${remainingSeconds}s remaining)`);
        }

        return inCooldown;
    }

    /**
     * Record that a trade was copied from this trader
     */
    recordTrade(traderAddress: string): void {
        const now = Date.now();
        this.cooldowns.set(traderAddress.toLowerCase(), {
            lastTradeTime: now,
            traderAddress,
        });

        const cooldownSeconds = this.cooldownWindowMs / 1000;
        Logger.info(`✓ Trade copied. Next trade from ${traderAddress.substring(0, 10)}... allowed in ${cooldownSeconds}s`);
    }

    /**
     * Check if we should copy this trade (not in cooldown)
     * If yes, automatically record it
     */
    shouldCopyTrade(traderAddress: string): boolean {
        if (this.isInCooldown(traderAddress)) {
            return false;
        }

        this.recordTrade(traderAddress);
        return true;
    }

    /**
     * Get remaining cooldown time in seconds
     */
    getRemainingCooldown(traderAddress: string): number {
        const entry = this.cooldowns.get(traderAddress.toLowerCase());
        if (!entry) {
            return 0;
        }

        const now = Date.now();
        const timeSinceLastTrade = now - entry.lastTradeTime;
        const remaining = this.cooldownWindowMs - timeSinceLastTrade;

        return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
    }

    /**
     * Clear cooldown for a specific trader (useful for testing)
     */
    clearCooldown(traderAddress: string): void {
        this.cooldowns.delete(traderAddress.toLowerCase());
        Logger.info(`🔄 Cooldown cleared for ${traderAddress.substring(0, 10)}...`);
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
    getStats(): { totalTrackedTraders: number; tradersInCooldown: number } {
        const now = Date.now();
        let tradersInCooldown = 0;

        for (const entry of this.cooldowns.values()) {
            if (now - entry.lastTradeTime < this.cooldownWindowMs) {
                tradersInCooldown++;
            }
        }

        return {
            totalTrackedTraders: this.cooldowns.size,
            tradersInCooldown,
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
