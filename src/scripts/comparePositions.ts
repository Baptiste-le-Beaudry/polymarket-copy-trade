// Script: comparePositions.js
// Description: Compare Polymarket positions and PnL for multiple addresses
// Usage: npx ts-node src/scripts/comparePositions.ts

import axios from 'axios';

const addresses = [
  '0x830eDACF303b85A991343c7e0AAeFE1b8F94C870', // Your address
  '0x9d84ce0306f8551e02efef1680475fc0f1dc1344', // Trader 1
  '0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b', // Trader 2
];

const POLYMARKET_API = 'https://api.polymarket.com/v4/users/';

async function fetchPositions(address: string) {
  const url = `${POLYMARKET_API}${address}/positions?status=active`;
  try {
    const { data } = await axios.get(url);
    if (!data.positions || !Array.isArray(data.positions)) {
      console.error(`Aucune donnée de position trouvée pour ${address}`);
      return {};
    }
    // Map: marketId -> position
    const positions: Record<string, any> = {};
    for (const pos of data.positions) {
      positions[pos.marketId] = pos;
    }
    return positions;
  } catch (e: any) {
    console.error(`Erreur lors de la récupération des positions pour ${address}:`, e.message);
    return {};
  }
}

function formatPnL(pnl: number) {
  return `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}$`;
}

async function main() {
  const allPositions = await Promise.all(addresses.map(fetchPositions));
  const [userPositions, ...traderPositions] = allPositions;

  // Affiche les marchés pour chaque adresse
  addresses.forEach((addr, idx) => {
    const pos = allPositions[idx];
    const marketIds = Object.keys(pos);
    console.log(`\nAdresse: ${addr}`);
    if (marketIds.length === 0) {
      console.log('  Aucun marché trouvé.');
    } else {
      console.log('  Marchés actifs:');
      marketIds.forEach(m => {
        const title = pos[m]?.market?.title || '(titre inconnu)';
        console.log(`    - ${m} : ${title}`);
      });
    }
  });

  // Find common marketIds
  const userMarkets = Object.keys(userPositions);
  const traderMarkets = traderPositions.map(tp => Object.keys(tp));
  const commonMarkets = userMarkets.filter(marketId => traderMarkets.every(tm => tm.includes(marketId)));

  if (commonMarkets.length === 0) {
    console.log('\nAucune position en commun trouvée.');
    return;
  }

  console.log('\nPositions en commun:');
  for (const marketId of commonMarkets) {
    const userPos = userPositions[marketId];
    const trader1Pos = traderPositions[0][marketId];
    const trader2Pos = traderPositions[1][marketId];
    const title = userPos.market?.title || trader1Pos.market?.title || trader2Pos.market?.title || marketId;
    console.log(`\nMarché: ${title}`);
    console.log(`- Ton PnL:      ${userPos.pnl !== undefined ? formatPnL(userPos.pnl) : 'N/A'}`);
    console.log(`- Trader 1 PnL: ${trader1Pos?.pnl !== undefined ? formatPnL(trader1Pos.pnl) : 'N/A'}`);
    console.log(`- Trader 2 PnL: ${trader2Pos?.pnl !== undefined ? formatPnL(trader2Pos.pnl) : 'N/A'}`);
    // Compare %
    const userPct = userPos.amount ? (userPos.pnl / userPos.amount) * 100 : 0;
    const t1Pct = trader1Pos?.amount ? (trader1Pos.pnl / trader1Pos.amount) * 100 : 0;
    const t2Pct = trader2Pos?.amount ? (trader2Pos.pnl / trader2Pos.amount) * 100 : 0;
    console.log(`- Ton %:      ${userPos.amount ? userPct.toFixed(2) + '%' : 'N/A'}`);
    console.log(`- Trader 1 %: ${trader1Pos?.amount ? t1Pct.toFixed(2) + '%' : 'N/A'}`);
    console.log(`- Trader 2 %: ${trader2Pos?.amount ? t2Pct.toFixed(2) + '%' : 'N/A'}`);
  }
}

main().catch(e => {
  console.error('Erreur:', e.message);
});
