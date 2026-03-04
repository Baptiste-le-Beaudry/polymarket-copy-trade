/**
 * Cache for order book data to reduce API calls
 * Implements a simple TTL-based cache
 */

interface CachedOrderBook {
    asset: string;
    orderBook: any;
    timestamp: number;
}

const CACHE_TTL_MS = 5000; // 5 seconds TTL

class OrderBookCache {
    private cache: Map<string, CachedOrderBook>;

    constructor() {
        this.cache = new Map();
    }

    /**
     * Get cached order book if available and not expired
     */
    get(asset: string): any | null {
        const cached = this.cache.get(asset);

        if (!cached) {
            return null;
        }

        const now = Date.now();
        const age = now - cached.timestamp;

        if (age > CACHE_TTL_MS) {
            // Cache expired, remove it
            this.cache.delete(asset);
            return null;
        }

        return cached.orderBook;
    }

    /**
     * Store order book in cache with current timestamp
     */
    set(asset: string, orderBook: any): void {
        this.cache.set(asset, {
            asset,
            orderBook,
            timestamp: Date.now()
        });
    }

    /**
     * Clear entire cache
     */
    clear(): void {
        this.cache.clear();
    }

    /**
     * Clear expired entries from cache
     */
    clearExpired(): void {
        const now = Date.now();
        for (const [asset, cached] of this.cache.entries()) {
            const age = now - cached.timestamp;
            if (age > CACHE_TTL_MS) {
                this.cache.delete(asset);
            }
        }
    }

    /**
     * Get cache statistics
     */
    getStats(): { size: number; assets: string[] } {
        return {
            size: this.cache.size,
            assets: Array.from(this.cache.keys())
        };
    }
}

// Singleton instance
let cacheInstance: OrderBookCache | null = null;

export const getOrderBookCache = (): OrderBookCache => {
    if (!cacheInstance) {
        cacheInstance = new OrderBookCache();
    }
    return cacheInstance;
};

export default getOrderBookCache;
