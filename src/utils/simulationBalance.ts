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
import { estimateGasFeeUSD, getCachedGasFeeUSD } from './gasFeeEstimator';
import fetchData from './fetchData';

const SIMULATION_STATE_FILE = path.join(process.cwd(), 'data', 'simulation_state.json');

interface SimulationState {
    balance: number;
    startingBalance: number;
    totalFeesPaid: number;
    positions: Array<{
        asset: string;
        size: number;
        avgPrice: number;
        openedAt: number;
        market?: string;
    }>;
    lastUpdated: number;
}

// Fallback static fees (used when REAL_GAS_FEES=false or API unavailable)
const STATIC_GAS_FEE_USD = 0.03; // Average gas fee per transaction on Polygon (~$0.02-0.05)
const ESTIMATED_SLIPPAGE_PERCENT = 0.5; // 0.5% slippage on market orders

// Resolve gas fee: real from API if enabled, static otherwise
async function getGasFeeUSD(): Promise<number> {
    if (ENV.REAL_GAS_FEES) {
        return estimateGasFeeUSD();
    }
    return STATIC_GAS_FEE_USD;
}

// Synchronous version for use in hot paths (uses cached value)
function getGasFeeUSDSync(): number {
    if (ENV.REAL_GAS_FEES) {
        return getCachedGasFeeUSD();
    }
    return STATIC_GAS_FEE_USD;
}

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
    // Mark-to-market: current market prices fetched periodically from Polymarket
    private markToMarketPrices: Map<string, number> = new Map();
    // Last known good prices — persists across failed mark-to-market fetches
    // When a fetch fails, we use this instead of falling back to entry price ($0.99)
    private lastKnownPrices: Map<string, number> = new Map();
    // Assets restored from a previous session — BUY is blocked on these to avoid re-buying
    private restoredAssets: Set<string> = new Set();

    constructor(startingBalance: number) {
        this.startingBalance = startingBalance;
        this.positions = new Map();
        this.balanceHistory = [];
        this.sessionStartTime = new Date();
        this.totalFeesPaid = 0;

        // Try to restore persisted state from previous session
        const savedState = this.loadState();
        if (savedState) {
            this.balance = savedState.balance;
            this.totalFeesPaid = savedState.totalFeesPaid;
            for (const pos of savedState.positions) {
                this.positions.set(pos.asset, {
                    size: pos.size,
                    avgPrice: pos.avgPrice,
                    openedAt: pos.openedAt,
                    market: pos.market,
                });
                // Mark as restored so BUY logic can skip re-buying them
                this.restoredAssets.add(pos.asset);
            }
            Logger.info(
                `💾 Simulation state restored: $${this.balance.toFixed(2)} balance, ` +
                `${this.positions.size} position(s) reloaded from disk (BUY blocked on restored positions)`
            );
        } else {
            this.balance = startingBalance;
            Logger.info(`💰 Simulation mode: Starting with $${startingBalance.toFixed(2)} virtual balance`);
        }

        Logger.info(`💸 Fees enabled: Gas fee ${ENV.REAL_GAS_FEES ? '(real Polygon)' : `$${STATIC_GAS_FEE_USD}`}/tx, Slippage ${ESTIMATED_SLIPPAGE_PERCENT}%`);

        // Record initial balance
        this.recordSnapshot();
    }

    /**
     * Load simulation state from disk (persisted across restarts)
     */
    private loadState(): SimulationState | null {
        try {
            if (!fs.existsSync(SIMULATION_STATE_FILE)) return null;
            const data = fs.readFileSync(SIMULATION_STATE_FILE, 'utf-8');
            const state: SimulationState = JSON.parse(data);
            if (
                typeof state.balance === 'number' &&
                Array.isArray(state.positions)
            ) {
                return state;
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * Save simulation state to disk so positions survive bot restarts
     */
    private saveState(): void {
        try {
            const dataDir = path.join(process.cwd(), 'data');
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            const state: SimulationState = {
                balance: this.balance,
                startingBalance: this.startingBalance,
                totalFeesPaid: this.totalFeesPaid,
                positions: Array.from(this.positions.entries()).map(([asset, pos]) => ({
                    asset,
                    size: pos.size,
                    avgPrice: pos.avgPrice,
                    openedAt: pos.openedAt,
                    market: pos.market,
                })),
                lastUpdated: Date.now(),
            };
            fs.writeFileSync(SIMULATION_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
        } catch {
            // Silently fail — persistence is best-effort
        }
    }

    getBalance(): number {
        return this.balance;
    }

    getPosition(asset: string): SimulationPosition | undefined {
        return this.positions.get(asset);
    }

    /**
     * Returns true if this asset was restored from a previous session.
     * Used to block re-buying positions that already exist in the simulation.
     */
    isRestoredPosition(asset: string): boolean {
        return this.restoredAssets.has(asset);
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
     * Fetch current market prices for all open positions (mark-to-market)
     * Uses Polymarket CLOB book API (midpoints endpoint is broken — returns HTTP 400)
     * Fetches each asset individually and computes midpoint = (best_bid + best_ask) / 2
     */
    async updateMarkToMarket(): Promise<void> {
        const assets = Array.from(this.positions.keys());
        if (assets.length === 0) return;

        let updated = 0;
        let failed = 0;

        // Fetch order books in small batches to avoid rate-limiting (5 at a time, 150ms delay)
        const BATCH_SIZE = 5;
        const BATCH_DELAY_MS = 150;

        for (let i = 0; i < assets.length; i += BATCH_SIZE) {
            const batch = assets.slice(i, i + BATCH_SIZE);

            const batchResults = await Promise.allSettled(
                batch.map(async (asset) => {
                    const data = await fetchData(
                        `https://clob.polymarket.com/book?token_id=${asset}`
                    ) as { bids: Array<{ price: string }>; asks: Array<{ price: string }> };

                    if (data?.bids?.[0] && data?.asks?.[0]) {
                        const bid = parseFloat(data.bids[0].price);
                        const ask = parseFloat(data.asks[0].price);
                        if (bid > 0 && ask > 0 && isFinite(bid) && isFinite(ask)) {
                            return { asset, midpoint: (bid + ask) / 2 };
                        }
                    }
                    throw new Error('No valid bid/ask');
                })
            );

            for (const result of batchResults) {
                if (result.status === 'fulfilled') {
                    this.markToMarketPrices.set(result.value.asset, result.value.midpoint);
                    this.lastKnownPrices.set(result.value.asset, result.value.midpoint);
                    updated++;
                } else {
                    failed++;
                    // Keep lastKnownPrices unchanged — will be used as fallback
                }
            }

            // Wait between batches to avoid rate-limiting
            if (i + BATCH_SIZE < assets.length) {
                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
            }
        }

        const posValue = this.getPositionsValue();
        const total = this.balance + posValue;
        const pnl = total - this.startingBalance;
        const pnlPct = (pnl / this.startingBalance) * 100;

        Logger.info(
            `📡 Mark-to-market: ${updated} positions updated${failed > 0 ? `, ${failed} failed` : ''} | ` +
            `Portfolio: $${this.balance.toFixed(2)} cash + $${posValue.toFixed(2)} positions = ` +
            `$${total.toFixed(2)} total (${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}, ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`
        );

        // Record updated snapshot
        this.recordSnapshot();
    }

    /**
     * Record a snapshot of the current balance and portfolio value
     */
    recordSnapshot(): void {
        // Use mark-to-market prices when available, entry price as fallback
        const snapshot: BalanceSnapshot = {
            timestamp: new Date(),
            balance: this.balance,
            totalValue: this.balance + this.getPositionsValue(),
            positionsCount: this.positions.size,
            cashBalance: this.balance,
        };

        this.balanceHistory.push(snapshot);
    }

    /**
     * Simulate buying tokens (with gas fees and slippage)
     */
    async buy(asset: string, usdAmount: number, price: number): Promise<void> {
        // Simule un délai de 1 seconde pour refléter la latence réelle
        await new Promise(resolve => setTimeout(resolve, 1000));
        // Validate price
        if (!price || price <= 0 || !isFinite(price)) {
            throw new Error(`Invalid price for buy: ${price}`);
        }
        if (!usdAmount || usdAmount <= 0 || !isFinite(usdAmount)) {
            throw new Error(`Invalid USD amount for buy: ${usdAmount}`);
        }
        
        // Calculate slippage and fees (use real gas fee if enabled)
        const gasFeeUSD = await getGasFeeUSD();
        const slippageCost = usdAmount * (ESTIMATED_SLIPPAGE_PERCENT / 100);
        const effectiveUsdAmount = usdAmount + slippageCost; // Slippage increases cost
        const totalCost = effectiveUsdAmount + gasFeeUSD; // Add gas fee

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
        this.totalFeesPaid += slippageCost + gasFeeUSD;

        Logger.success(`✓ [VIRTUAL] Bought ${tokens.toFixed(2)} tokens @ $${price.toFixed(4)} = $${usdAmount.toFixed(2)} +${slippageCost.toFixed(3)} slippage +${gasFeeUSD.toFixed(4)} gas`);
        Logger.info(`💰 Virtual balance: $${this.balance.toFixed(2)} (fees paid: $${this.totalFeesPaid.toFixed(2)})`);

        // Record snapshot after trade
        this.recordSnapshot();
        this.saveState();
    }

    /**
     * Simulate selling tokens (with gas fees)
     */
    async sell(asset: string, tokens: number, price: number): Promise<void> {
        // Simule un délai de 1 seconde pour refléter la latence réelle
        await new Promise(resolve => setTimeout(resolve, 1000));
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
        const gasFeeUSD = await getGasFeeUSD();
        const netUsdAmount = usdAmount - gasFeeUSD; // Deduct gas fee from proceeds

        this.balance += netUsdAmount;
        this.totalFeesPaid += gasFeeUSD;

        position.size -= tokens;
        if (position.size < 0.01) {
            // Close position if less than 0.01 tokens remaining
            this.positions.delete(asset);
            // No longer restored — allow re-buying if traders enter again
            this.restoredAssets.delete(asset);
        }

        Logger.success(`✓ [VIRTUAL] Sold ${tokens.toFixed(2)} tokens @ $${price.toFixed(4)} = $${usdAmount.toFixed(2)} -${gasFeeUSD.toFixed(4)} gas`);
        Logger.info(`💰 Virtual balance: $${this.balance.toFixed(2)} (fees paid: $${this.totalFeesPaid.toFixed(2)})`);

        // Record snapshot after trade
        this.recordSnapshot();
        this.saveState();
    }

    /**
     * Simulate buying tokens using order book simulation results
     * This method uses the realistic execution data from order book simulator
     */
    async buyWithOrderBook(
        asset: string,
        usdAmount: number,
        traderPrice: number,
        orderBookResult: {
            totalCost: number;
            avgPrice: number;
            tokensFilled: number;
            fullyFilled: boolean;
            levelsUsed: Array<{ price: number; size: number }>;
        }
    ): Promise<void> {
        // Simule un délai de 1 seconde pour refléter la latence réelle
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Validate
        if (!orderBookResult.avgPrice || orderBookResult.avgPrice <= 0) {
            throw new Error(`Invalid avgPrice from order book: ${orderBookResult.avgPrice}`);
        }
        if (!orderBookResult.tokensFilled || orderBookResult.tokensFilled <= 0) {
            throw new Error(`Invalid tokensFilled from order book: ${orderBookResult.tokensFilled}`);
        }

        // Calculate realistic costs (use real gas fee if enabled)
        const gasFeeUSD = await getGasFeeUSD();
        const actualUsdAmount = orderBookResult.tokensFilled * orderBookResult.avgPrice;
        const slippageCost = actualUsdAmount * (ESTIMATED_SLIPPAGE_PERCENT / 100);
        const totalCost = actualUsdAmount + slippageCost + gasFeeUSD;

        // Check MIN_CASH_RESERVE
        const minReserve = ENV.MIN_CASH_RESERVE || 0;
        const availableAfterReserve = Math.max(0, this.balance - minReserve);

        if (totalCost > availableAfterReserve) {
            throw new Error(`Insufficient virtual balance: $${this.balance.toFixed(2)} - $${minReserve.toFixed(0)} reserve = $${availableAfterReserve.toFixed(2)} available, need $${totalCost.toFixed(2)}`);
        }

        if (totalCost > this.balance) {
            throw new Error(`Insufficient virtual balance: $${this.balance.toFixed(2)} < $${totalCost.toFixed(2)} (including fees)`);
        }

        const tokens = orderBookResult.tokensFilled;
        const avgPrice = orderBookResult.avgPrice;
        const existing = this.positions.get(asset);

        if (existing) {
            // Update average price but keep original opened date
            const totalTokens = existing.size + tokens;
            const totalValue = existing.size * existing.avgPrice + tokens * avgPrice;
            existing.size = totalTokens;
            existing.avgPrice = totalValue / totalTokens;
        } else {
            this.positions.set(asset, {
                size: tokens,
                avgPrice: avgPrice,
                openedAt: Date.now()
            });
        }

        this.balance -= totalCost;
        this.totalFeesPaid += slippageCost + gasFeeUSD;

        const slippageVsTrader = ((avgPrice - traderPrice) / traderPrice) * 100;

        Logger.success(
            `✓ [VIRTUAL] Bought ${tokens.toFixed(2)} tokens @ $${avgPrice.toFixed(4)} avg ` +
            `(trader: $${traderPrice.toFixed(4)}, slippage: ${slippageVsTrader >= 0 ? '+' : ''}${slippageVsTrader.toFixed(2)}%)`
        );
        Logger.info(
            `  💰 Cost: $${actualUsdAmount.toFixed(2)} + $${slippageCost.toFixed(3)} slippage + $${gasFeeUSD.toFixed(4)} gas = $${totalCost.toFixed(2)}`
        );
        Logger.info(`💵 Virtual balance: $${this.balance.toFixed(2)} (fees paid: $${this.totalFeesPaid.toFixed(2)})`);

        if (!orderBookResult.fullyFilled) {
            Logger.warning(`⚠️ Partial fill: ${orderBookResult.levelsUsed.length} order book levels used`);
        }

        // Record snapshot after trade
        this.recordSnapshot();
        this.saveState();
    }

    /**
     * Simulate selling tokens using order book simulation results
     * This method uses the realistic execution data from order book simulator
     */
    async sellWithOrderBook(
        asset: string,
        tokens: number,
        traderPrice: number,
        orderBookResult: {
            totalCost: number;
            avgPrice: number;
            tokensFilled: number;
            fullyFilled: boolean;
            levelsUsed: Array<{ price: number; size: number }>;
        }
    ): Promise<void> {
        // Simule un délai de 1 seconde pour refléter la latence réelle
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Validate
        if (!orderBookResult.avgPrice || orderBookResult.avgPrice <= 0) {
            throw new Error(`Invalid avgPrice from order book: ${orderBookResult.avgPrice}`);
        }
        if (!orderBookResult.tokensFilled || orderBookResult.tokensFilled <= 0) {
            throw new Error(`Invalid tokensFilled from order book: ${orderBookResult.tokensFilled}`);
        }

        const position = this.positions.get(asset);
        if (!position) {
            throw new Error(`No position found for asset ${asset}`);
        }
        if (orderBookResult.tokensFilled > position.size) {
            throw new Error(`Insufficient tokens: ${position.size} < ${orderBookResult.tokensFilled}`);
        }

        const tokensSold = orderBookResult.tokensFilled;
        const avgPrice = orderBookResult.avgPrice;
        const usdAmount = tokensSold * avgPrice;
        const gasFeeUSD = await getGasFeeUSD();
        const netUsdAmount = usdAmount - gasFeeUSD;

        this.balance += netUsdAmount;
        this.totalFeesPaid += gasFeeUSD;

        position.size -= tokensSold;
        if (position.size < 0.01) {
            // Close position if less than 0.01 tokens remaining
            this.positions.delete(asset);
            // No longer restored — allow re-buying if traders enter again
            this.restoredAssets.delete(asset);
        }

        const slippageVsTrader = ((avgPrice - traderPrice) / traderPrice) * 100;

        Logger.success(
            `✓ [VIRTUAL] Sold ${tokensSold.toFixed(2)} tokens @ $${avgPrice.toFixed(4)} avg ` +
            `(trader: $${traderPrice.toFixed(4)}, slippage: ${slippageVsTrader >= 0 ? '+' : ''}${slippageVsTrader.toFixed(2)}%)`
        );
        Logger.info(`  💰 Proceeds: $${usdAmount.toFixed(2)} - $${gasFeeUSD.toFixed(4)} gas = $${netUsdAmount.toFixed(2)}`);
        Logger.info(`💵 Virtual balance: $${this.balance.toFixed(2)} (fees paid: $${this.totalFeesPaid.toFixed(2)})`);

        if (!orderBookResult.fullyFilled) {
            Logger.warning(`⚠️ Partial fill: ${orderBookResult.levelsUsed.length} order book levels used`);
        }

        // Record snapshot after trade
        this.recordSnapshot();
        this.saveState();
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
     * Get current positions value using mark-to-market prices when available,
     * falling back to entry price (avgPrice) if no real price has been fetched yet
     */
    getPositionsValue(): number {
        let positionsValue = 0;
        for (const [asset, position] of this.positions.entries()) {
            const currentPrice = this.markToMarketPrices.get(asset) ?? this.lastKnownPrices.get(asset) ?? position.avgPrice;
            positionsValue += position.size * currentPrice;
        }
        return positionsValue;
    }

    /**
     * Get mark-to-market price for a specific asset (or entry price as fallback)
     */
    getCurrentPrice(asset: string): number {
        const position = this.positions.get(asset);
        if (!position) return 0;
        return this.markToMarketPrices.get(asset) ?? this.lastKnownPrices.get(asset) ?? position.avgPrice;
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
            const hasMtM = this.markToMarketPrices.size > 0;
            Logger.info(`\n📦 Virtual Positions (${hasMtM ? 'mark-to-market' : 'entry price'}):`);

            let totalEntryValue = 0;
            let totalCurrentValue = 0;

            for (const [asset, position] of this.positions.entries()) {
                const entryValue = position.size * position.avgPrice;
                const currentPrice = this.markToMarketPrices.get(asset) ?? this.lastKnownPrices.get(asset) ?? position.avgPrice;
                const currentValue = position.size * currentPrice;
                const pnl = currentValue - entryValue;
                const pnlPct = position.avgPrice > 0 ? ((currentPrice - position.avgPrice) / position.avgPrice) * 100 : 0;
                totalEntryValue += entryValue;
                totalCurrentValue += currentValue;

                const pnlStr = hasMtM
                    ? ` | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%) @ $${currentPrice.toFixed(4)}`
                    : '';
                const market = position.market ? position.market.substring(0, 35) : asset.substring(0, 12) + '...';
                Logger.info(
                    `   • ${market} | ${position.size.toFixed(2)} tokens @ $${position.avgPrice.toFixed(4)} entry = $${entryValue.toFixed(2)}${pnlStr}`
                );
            }

            if (hasMtM) {
                const totalPnl = totalCurrentValue - totalEntryValue;
                const totalPnlPct = totalEntryValue > 0 ? (totalPnl / totalEntryValue) * 100 : 0;
                Logger.info(
                    `   ────────────────────────────────────────────────────────`
                );
                Logger.info(
                    `   📊 Positions total: $${totalEntryValue.toFixed(2)} invested → $${totalCurrentValue.toFixed(2)} current | ` +
                    `P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} (${totalPnlPct >= 0 ? '+' : ''}${totalPnlPct.toFixed(1)}%)`
                );
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
        this.restoredAssets.clear();
        this.balanceHistory = [];
        this.sessionStartTime = new Date();
        this.totalFeesPaid = 0;
        this.recordSnapshot();

        // Delete persisted state so next restart starts fresh
        try {
            if (fs.existsSync(SIMULATION_STATE_FILE)) {
                fs.unlinkSync(SIMULATION_STATE_FILE);
            }
        } catch {
            // Silently fail
        }

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

        const gasFeePerTx = getGasFeeUSDSync();
        for (const [asset, position] of positionsToClose) {
            const usdAmount = position.size * position.avgPrice;
            const netUsdAmount = usdAmount - gasFeePerTx;

            totalProceeds += netUsdAmount;
            this.balance += netUsdAmount;
            this.totalFeesPaid += gasFeePerTx;

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
        Logger.success(`📈 Portfolio liquidated at shutdown: +$${(totalProceeds - (totalPositionsValue - (positionsToClose.length * gasFeePerTx))).toFixed(2)} net after fees`);
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
