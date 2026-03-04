import { AssetType, ClobClient } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import createClobClient from '../utils/createClobClient';
import fetchData from '../utils/fetchData';

const PROXY_WALLET = ENV.PROXY_WALLET;

interface Position {
    asset: string;
    size: number;
    title?: string;
    outcome?: string;
}

const main = async () => {
    console.log('🔄 Syncing Position Allowances for Polymarket');
    console.log('═══════════════════════════════════════════════\n');
    console.log(`📍 Wallet: ${PROXY_WALLET}\n`);

    try {
        const clobClient = await createClobClient();
        
        console.log('✅ Connected to Polymarket\n');
        
        // Fetch all positions
        console.log('📥 Fetching positions...');
        const positions: Position[] = await fetchData(`https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`);
        console.log(`Found ${positions.length} position(s)\n`);

        if (positions.length === 0) {
            console.log('No positions to sync.');
            return;
        }

        // Sync each position's allowance cache
        console.log('🔄 Syncing allowance cache for each position token...\n');
        
        let successCount = 0;
        let errorCount = 0;

        for (const position of positions) {
            const tokenId = position.asset;
            const title = position.title || 'Unknown';
            const outcome = position.outcome || '';
            
            try {
                await clobClient.updateBalanceAllowance({
                    asset_type: AssetType.CONDITIONAL,
                    token_id: tokenId,
                });
                console.log(`✅ Synced: ${title.substring(0, 50)}... (${outcome})`);
                successCount++;
            } catch (error: any) {
                console.log(`❌ Failed: ${title.substring(0, 50)}... - ${error.message || 'Unknown error'}`);
                errorCount++;
            }
            
            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        console.log('\n═══════════════════════════════════════════════');
        console.log(`📊 Results: ${successCount} synced, ${errorCount} errors`);
        console.log('═══════════════════════════════════════════════\n');
        
        console.log('✅ Done! Your positions should now be sellable.');
        
    } catch (error: any) {
        console.error('❌ Error:', error.message);
    }
};

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('❌ Fatal error:', error);
        process.exit(1);
    });
