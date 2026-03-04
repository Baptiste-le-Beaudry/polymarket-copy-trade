import createClobClient from './createClobClient';

/**
 * Simule un achat ou une vente sur le carnet d'ordres réel (order book)
 * @param asset L'asset (marketId) à trader
 * @param side 'BUY' ou 'SELL'
 * @param tokens Nombre de tokens à acheter/vendre
 * @returns { totalCost, avgPrice, tokensFilled, levelsUsed }
 */
export async function simulateOrderBookFill(asset: string, side: 'BUY' | 'SELL', tokens: number) {
    const clobClient = await createClobClient();
    const orderBook = await clobClient.getOrderBook(asset);
    const levels = side === 'BUY' ? orderBook.asks : orderBook.bids;
    let tokensToFill = tokens;
    let totalCost = 0;
    let tokensFilled = 0;
    const levelsUsed: Array<{ price: number, size: number }> = [];

    for (const level of levels) {
        const price = parseFloat(level.price);
        const size = parseFloat(level.size);
        if (tokensToFill <= 0) break;
        const fill = Math.min(tokensToFill, size);
        totalCost += fill * price;
        tokensFilled += fill;
        levelsUsed.push({ price, size: fill });
        tokensToFill -= fill;
    }

    const avgPrice = tokensFilled > 0 ? totalCost / tokensFilled : 0;
    return {
        totalCost,
        avgPrice,
        tokensFilled,
        fullyFilled: tokensFilled === tokens,
        levelsUsed,
    };
}