/**
 * Liquidity Analysis Tool
 * 
 * Analyzes market liquidity and detects competing bot activity
 * Run with: npx ts-node src/scripts/analyzeLiquidity.ts
 */

import { ENV } from '../config/env';
import createClobClient from '../utils/createClobClient';
import fetchData from '../utils/fetchData';

const USER_ADDRESSES = ENV.USER_ADDRESSES;

interface OrderBookLevel {
    price: string;
    size: string;
}

interface OrderBook {
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
}

interface LiquidityAnalysis {
    asset: string;
    market: string;
    timestamp: Date;
    bidDepth: number;      // Total $ on buy side
    askDepth: number;      // Total $ on sell side
    spread: number;        // Bid-ask spread in %
    topBidSize: number;    // Size at best bid
    topAskSize: number;    // Size at best ask
    canFill15Tokens: boolean;
    slippageFor15Tokens: number; // % slippage to buy 15 tokens
}

interface CompetitorAnalysis {
    traderAddress: string;
    recentTrades: number;
    avgTimeBetweenTrades: number; // seconds
    suspectedBotCopiers: number;
    liquidityTakenWithin5s: number; // % of trades where liquidity was taken fast
}

async function analyzeOrderBook(clobClient: any, asset: string, market: string): Promise<LiquidityAnalysis> {
    const orderBook: OrderBook = await clobClient.getOrderBook(asset);
    
    // Calculate bid depth (total $ available to sell into)
    let bidDepth = 0;
    let tokensAtBids = 0;
    if (orderBook.bids && orderBook.bids.length > 0) {
        for (const bid of orderBook.bids) {
            const size = parseFloat(bid.size);
            const price = parseFloat(bid.price);
            bidDepth += size * price;
            tokensAtBids += size;
        }
    }
    
    // Calculate ask depth (total $ available to buy)
    let askDepth = 0;
    let tokensAtAsks = 0;
    let slippageFor15Tokens = 0;
    let tokensFilled = 0;
    let costFor15Tokens = 0;
    
    if (orderBook.asks && orderBook.asks.length > 0) {
        const bestAskPrice = parseFloat(orderBook.asks[0].price);
        
        for (const ask of orderBook.asks) {
            const size = parseFloat(ask.size);
            const price = parseFloat(ask.price);
            askDepth += size * price;
            tokensAtAsks += size;
            
            // Calculate slippage to buy 15 tokens
            if (tokensFilled < 15) {
                const tokensNeeded = 15 - tokensFilled;
                const tokensToBuy = Math.min(tokensNeeded, size);
                costFor15Tokens += tokensToBuy * price;
                tokensFilled += tokensToBuy;
            }
        }
        
        if (tokensFilled >= 15) {
            const avgPrice = costFor15Tokens / 15;
            slippageFor15Tokens = ((avgPrice - bestAskPrice) / bestAskPrice) * 100;
        } else {
            slippageFor15Tokens = -1; // Not enough liquidity
        }
    }
    
    // Calculate spread
    let spread = 0;
    if (orderBook.bids?.length > 0 && orderBook.asks?.length > 0) {
        const bestBid = parseFloat(orderBook.bids[0].price);
        const bestAsk = parseFloat(orderBook.asks[0].price);
        spread = ((bestAsk - bestBid) / bestBid) * 100;
    }
    
    return {
        asset,
        market,
        timestamp: new Date(),
        bidDepth,
        askDepth,
        spread,
        topBidSize: orderBook.bids?.[0] ? parseFloat(orderBook.bids[0].size) : 0,
        topAskSize: orderBook.asks?.[0] ? parseFloat(orderBook.asks[0].size) : 0,
        canFill15Tokens: tokensAtAsks >= 15,
        slippageFor15Tokens,
    };
}

async function detectCompetingBots(traderAddress: string): Promise<CompetitorAnalysis> {
    console.log(`\n🔍 Analyzing trader: ${traderAddress.slice(0, 10)}...`);
    
    // Fetch recent trades
    const url = `https://data-api.polymarket.com/activity?user=${traderAddress}&type=TRADE&limit=50`;
    const trades = await fetchData(url);
    
    if (!Array.isArray(trades) || trades.length === 0) {
        return {
            traderAddress,
            recentTrades: 0,
            avgTimeBetweenTrades: 0,
            suspectedBotCopiers: 0,
            liquidityTakenWithin5s: 0,
        };
    }
    
    // Calculate time between trades
    const timestamps = trades.map(t => new Date(t.timestamp).getTime()).sort((a, b) => b - a);
    let totalGap = 0;
    for (let i = 1; i < timestamps.length; i++) {
        totalGap += timestamps[i - 1] - timestamps[i];
    }
    const avgTimeBetweenTrades = timestamps.length > 1 ? totalGap / (timestamps.length - 1) / 1000 : 0;
    
    // For each trade, check if there were other trades on the same market within 5 seconds
    // This could indicate competing bots
    let fastFollowCount = 0;
    
    for (const trade of trades.slice(0, 10)) { // Check last 10 trades
        const tradeTime = new Date(trade.timestamp).getTime();
        const marketUrl = `https://data-api.polymarket.com/activity?asset=${trade.asset}&type=TRADE&limit=20`;
        
        try {
            const marketTrades = await fetchData(marketUrl);
            if (Array.isArray(marketTrades)) {
                // Count trades within 5 seconds of trader's trade (excluding trader's own)
                const nearbyTrades = marketTrades.filter(t => {
                    const otherTime = new Date(t.timestamp).getTime();
                    const timeDiff = Math.abs(otherTime - tradeTime);
                    return timeDiff > 0 && timeDiff < 5000 && t.proxyWallet !== traderAddress;
                });
                
                if (nearbyTrades.length > 0) {
                    fastFollowCount++;
                }
            }
        } catch {
            // Ignore errors for individual market checks
        }
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    const liquidityTakenWithin5s = (fastFollowCount / Math.min(trades.length, 10)) * 100;
    
    // Estimate number of bot copiers based on fast follow rate
    const suspectedBotCopiers = liquidityTakenWithin5s > 50 ? 3 : 
                                liquidityTakenWithin5s > 30 ? 2 :
                                liquidityTakenWithin5s > 10 ? 1 : 0;
    
    return {
        traderAddress,
        recentTrades: trades.length,
        avgTimeBetweenTrades,
        suspectedBotCopiers,
        liquidityTakenWithin5s,
    };
}

async function main() {
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('        🔬 LIQUIDITY & COMPETITOR ANALYSIS');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`📅 ${new Date().toLocaleString()}\n`);
    
    const clobClient = await createClobClient();
    
    // 1. Analyze liquidity for recent markets traded by followed traders
    console.log('\n📊 STEP 1: Analyzing Order Book Liquidity');
    console.log('─'.repeat(60));
    
    const marketsToAnalyze: { asset: string; market: string }[] = [];
    
    for (const address of USER_ADDRESSES.slice(0, 3)) { // Check top 3 traders
        const url = `https://data-api.polymarket.com/activity?user=${address}&type=TRADE&limit=5`;
        const trades = await fetchData(url);
        
        if (Array.isArray(trades)) {
            for (const trade of trades) {
                if (!marketsToAnalyze.find(m => m.asset === trade.asset)) {
                    marketsToAnalyze.push({
                        asset: trade.asset,
                        market: trade.title || trade.slug || 'Unknown',
                    });
                }
            }
        }
    }
    
    console.log(`\n📈 Analyzing ${marketsToAnalyze.length} recent markets...\n`);
    
    const liquidityResults: LiquidityAnalysis[] = [];
    
    for (const market of marketsToAnalyze.slice(0, 10)) { // Limit to 10 markets
        try {
            const analysis = await analyzeOrderBook(clobClient, market.asset, market.market);
            liquidityResults.push(analysis);
            
            const canFillIcon = analysis.canFill15Tokens ? '✅' : '❌';
            const spreadColor = analysis.spread < 1 ? '🟢' : analysis.spread < 3 ? '🟡' : '🔴';
            const slippageStr = analysis.slippageFor15Tokens >= 0 
                ? `${analysis.slippageFor15Tokens.toFixed(2)}%`
                : 'INSUFFICIENT';
            
            console.log(`${canFillIcon} ${market.market.slice(0, 50)}...`);
            console.log(`   💰 Ask Depth: $${analysis.askDepth.toFixed(2)} | Bid Depth: $${analysis.bidDepth.toFixed(2)}`);
            console.log(`   ${spreadColor} Spread: ${analysis.spread.toFixed(2)}% | Slippage (15 tokens): ${slippageStr}`);
            console.log(`   📦 Top Ask: ${analysis.topAskSize.toFixed(2)} tokens | Top Bid: ${analysis.topBidSize.toFixed(2)} tokens`);
            console.log('');
            
            await new Promise(resolve => setTimeout(resolve, 300));
        } catch (error) {
            console.log(`❌ Error analyzing ${market.market}: ${error}`);
        }
    }
    
    // Summary
    const fillableCount = liquidityResults.filter(r => r.canFill15Tokens).length;
    const avgSpread = liquidityResults.reduce((sum, r) => sum + r.spread, 0) / liquidityResults.length;
    const avgSlippage = liquidityResults
        .filter(r => r.slippageFor15Tokens >= 0)
        .reduce((sum, r) => sum + r.slippageFor15Tokens, 0) / 
        liquidityResults.filter(r => r.slippageFor15Tokens >= 0).length || 0;
    
    console.log('\n📊 LIQUIDITY SUMMARY');
    console.log('─'.repeat(60));
    console.log(`✅ Markets with enough liquidity for 15 tokens: ${fillableCount}/${liquidityResults.length}`);
    console.log(`📈 Average spread: ${avgSpread.toFixed(2)}%`);
    console.log(`📉 Average slippage for 15 tokens: ${avgSlippage.toFixed(3)}%`);
    
    // 2. Detect competing bots
    console.log('\n\n🤖 STEP 2: Detecting Competing Bots');
    console.log('─'.repeat(60));
    
    const competitorResults: CompetitorAnalysis[] = [];
    
    for (const address of USER_ADDRESSES) {
        const analysis = await detectCompetingBots(address);
        competitorResults.push(analysis);
        
        const botIcon = analysis.suspectedBotCopiers === 0 ? '🟢' : 
                       analysis.suspectedBotCopiers <= 1 ? '🟡' : '🔴';
        
        console.log(`\n${botIcon} Trader: ${address.slice(0, 10)}...`);
        console.log(`   📊 Recent trades: ${analysis.recentTrades}`);
        console.log(`   ⏱️  Avg time between trades: ${analysis.avgTimeBetweenTrades.toFixed(0)}s`);
        console.log(`   🤖 Suspected bot copiers: ${analysis.suspectedBotCopiers}`);
        console.log(`   ⚡ Liquidity taken within 5s: ${analysis.liquidityTakenWithin5s.toFixed(1)}%`);
    }
    
    // Final summary
    const totalSuspectedBots = competitorResults.reduce((sum, r) => sum + r.suspectedBotCopiers, 0);
    const avgFastFollow = competitorResults.reduce((sum, r) => sum + r.liquidityTakenWithin5s, 0) / competitorResults.length;
    
    console.log('\n\n═══════════════════════════════════════════════════════════════════');
    console.log('        📋 FINAL ANALYSIS');
    console.log('═══════════════════════════════════════════════════════════════════');
    
    console.log('\n🔍 COMPETITION LEVEL:');
    if (avgFastFollow < 20) {
        console.log('   🟢 LOW - Few bots are copying these traders');
        console.log('   💡 You should get most orders filled without issues');
    } else if (avgFastFollow < 40) {
        console.log('   🟡 MEDIUM - Some competition detected');
        console.log('   💡 Expect ~10-20% of orders to miss liquidity');
    } else {
        console.log('   🔴 HIGH - Many bots are copying these traders');
        console.log('   💡 Consider finding less popular traders or acting faster');
    }
    
    console.log('\n💧 LIQUIDITY ASSESSMENT:');
    if (fillableCount === liquidityResults.length && avgSlippage < 0.5) {
        console.log('   🟢 EXCELLENT - All markets have enough liquidity');
    } else if (fillableCount >= liquidityResults.length * 0.7) {
        console.log('   🟡 GOOD - Most markets have enough liquidity');
    } else {
        console.log('   🔴 POOR - Many markets lack liquidity for 15 tokens');
        console.log('   💡 Consider reducing COPY_SIZE to 10 tokens or less');
    }
    
    console.log('\n📈 RECOMMENDATIONS:');
    if (avgFastFollow > 30) {
        console.log('   • Reduce FETCH_INTERVAL from 1s to faster if possible');
        console.log('   • Consider using WebSocket for real-time updates');
    }
    if (avgSlippage > 1) {
        console.log('   • Slippage is high - consider smaller position sizes');
    }
    if (totalSuspectedBots > 3) {
        console.log('   • Many bots detected - consider finding unique traders');
        console.log('   • Use npm run find-traders to discover new traders');
    }
    
    console.log('\n═══════════════════════════════════════════════════════════════════\n');
}

main().catch(console.error);
