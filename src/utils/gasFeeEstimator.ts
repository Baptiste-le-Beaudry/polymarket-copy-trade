/**
 * Real Polygon gas fee estimator
 * Queries Polygon Gas Station API + MATIC price to compute actual USD gas cost
 * Falls back to $0.03 if API is unavailable
 */

import Logger from './logger';
import fetchData from './fetchData';

// Gas units for a typical Polymarket CLOB order on Polygon
const POLYMARKET_GAS_UNITS = 150_000;

// Cache to avoid spamming APIs (refresh every 60 seconds)
let cachedFeeUSD: number | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000;

const FALLBACK_GAS_FEE_USD = 0.03;

interface GasOracleResponse {
    safeLow: { maxFee: number };
    standard: { maxFee: number };
    fast: { maxFee: number };
}

/**
 * Get current gas price in gwei from Polygon Gas Station v2
 */
async function getPolygonGasPriceGwei(): Promise<number> {
    try {
        const data = await fetchData('https://gasstation.polygon.technology/v2') as GasOracleResponse;
        // Use "standard" tier, maxFee in gwei
        const gasPriceGwei = data?.standard?.maxFee ?? data?.fast?.maxFee;
        if (typeof gasPriceGwei === 'number' && gasPriceGwei > 0) {
            return gasPriceGwei;
        }
    } catch {
        // silently fall through
    }
    return 30; // fallback: 30 gwei (typical Polygon gas price)
}

/**
 * Get current MATIC price in USD from CoinGecko
 */
async function getMaticPriceUSD(): Promise<number> {
    try {
        const data = await fetchData(
            'https://api.coingecko.com/api/v3/simple/price?ids=matic-network&vs_currencies=usd'
        ) as { 'matic-network': { usd: number } };
        const price = data?.['matic-network']?.usd;
        if (typeof price === 'number' && price > 0) {
            return price;
        }
    } catch {
        // silently fall through
    }
    return 0.5; // fallback: $0.50 MATIC
}

/**
 * Estimate real USD gas cost for a Polymarket trade on Polygon
 * Result is cached for 60 seconds
 */
export async function estimateGasFeeUSD(): Promise<number> {
    const now = Date.now();

    // Return cached value if fresh
    if (cachedFeeUSD !== null && now - cacheTimestamp < CACHE_TTL_MS) {
        return cachedFeeUSD;
    }

    try {
        const [gasPriceGwei, maticPriceUSD] = await Promise.all([
            getPolygonGasPriceGwei(),
            getMaticPriceUSD(),
        ]);

        // Gas cost in MATIC = gas_price_gwei × 1e-9 × gas_units
        const gasCostMATIC = (gasPriceGwei * 1e-9) * POLYMARKET_GAS_UNITS;
        // Gas cost in USD
        const gasCostUSD = gasCostMATIC * maticPriceUSD;

        // Sanity clamp: never below $0.001, never above $1.00
        cachedFeeUSD = Math.min(1.0, Math.max(0.001, gasCostUSD));
        cacheTimestamp = now;

        Logger.info(
            `[GasFee] ${gasPriceGwei.toFixed(1)} gwei × ${POLYMARKET_GAS_UNITS} gas × $${maticPriceUSD.toFixed(3)}/MATIC = $${cachedFeeUSD.toFixed(4)}`
        );

        return cachedFeeUSD;
    } catch (error) {
        Logger.warning(`[GasFee] API error, using fallback $${FALLBACK_GAS_FEE_USD}: ${error}`);
        return FALLBACK_GAS_FEE_USD;
    }
}

/**
 * Get last cached gas fee (synchronous, no API call)
 * Used in hot paths where async is not practical
 */
export function getCachedGasFeeUSD(): number {
    return cachedFeeUSD ?? FALLBACK_GAS_FEE_USD;
}
