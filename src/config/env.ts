import * as dotenv from 'dotenv';
import { CopyStrategy, CopyStrategyConfig, parseTieredMultipliers } from './copyStrategy';
dotenv.config();

// Normalize POLY_SECRET if present: convert URL-safe base64 to standard base64 with padding
const normalizeBase64 = (s?: string): string => {
    if (!s) return '';
    let normalized = s.replace(/-/g, '+').replace(/_/g, '/');
    const pad = normalized.length % 4;
    if (pad !== 0) normalized += '='.repeat(4 - pad);
    return normalized;
};

const POLY_API_KEY_PRESENT = !!process.env.POLY_API_KEY;
const POLY_SECRET_PRESENT = !!process.env.POLY_SECRET;
if (POLY_API_KEY_PRESENT || POLY_SECRET_PRESENT) {
    console.log(`POLY_* present in environment: API_KEY=${POLY_API_KEY_PRESENT}, SECRET=${POLY_SECRET_PRESENT}`);
}

/**
 * Validate Ethereum address format
 */
const isValidEthereumAddress = (address: string): boolean => {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
};

/**
 * Validate required environment variables
 */
const validateRequiredEnv = (): void => {
    const required = [
        'USER_ADDRESSES',
        'PROXY_WALLET',
        'PRIVATE_KEY',
        'CLOB_HTTP_URL',
        'CLOB_WS_URL',
        'MONGO_URI',
        'RPC_URL',
        'USDC_CONTRACT_ADDRESS',
    ];

    const missing: string[] = [];
    for (const key of required) {
        if (!process.env[key]) {
            missing.push(key);
        }
    }

    if (missing.length > 0) {
        console.error('\n❌ Configuration Error: Missing required environment variables\n');
        console.error(`Missing variables: ${missing.join(', ')}\n`);
        console.error('🔧 Quick fix:');
        console.error('   1. Run the setup wizard: npm run setup');
        console.error('   2. Or manually create .env file with all required variables\n');
        console.error('📖 See docs/QUICK_START.md for detailed instructions\n');
        throw new Error(
            `Missing required environment variables: ${missing.join(', ')}`
        );
    }
};

/**
 * Validate Ethereum addresses
 */
const validateAddresses = (): void => {
    if (process.env.PROXY_WALLET && !isValidEthereumAddress(process.env.PROXY_WALLET)) {
        console.error('\n❌ Invalid Wallet Address\n');
        console.error(`Your PROXY_WALLET: ${process.env.PROXY_WALLET}`);
        console.error('Expected format:    0x followed by 40 hexadecimal characters\n');
        console.error('Example: 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0\n');
        console.error('💡 Tips:');
        console.error('   • Copy your wallet address from MetaMask');
        console.error('   • Make sure it starts with 0x');
        console.error('   • Should be exactly 42 characters long\n');
        throw new Error(
            `Invalid PROXY_WALLET address format: ${process.env.PROXY_WALLET}`
        );
    }

    if (
        process.env.USDC_CONTRACT_ADDRESS &&
        !isValidEthereumAddress(process.env.USDC_CONTRACT_ADDRESS)
    ) {
        console.error('\n❌ Invalid USDC Contract Address\n');
        console.error(`Current value: ${process.env.USDC_CONTRACT_ADDRESS}`);
        console.error('Default value: 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174\n');
        console.error('⚠️  Unless you know what you\'re doing, use the default value!\n');
        throw new Error(
            `Invalid USDC_CONTRACT_ADDRESS format: ${process.env.USDC_CONTRACT_ADDRESS}`
        );
    }
};

/**
 * Validate numeric configuration values
 */
const validateNumericConfig = (): void => {
    const fetchInterval = parseInt(process.env.FETCH_INTERVAL || '1', 10);
    if (isNaN(fetchInterval) || fetchInterval < 0) {
        throw new Error(
            `Invalid FETCH_INTERVAL: ${process.env.FETCH_INTERVAL}. Must be a non-negative integer (0 = no extra wait between cycles).`
        );
    }

    const retryLimit = parseInt(process.env.RETRY_LIMIT || '3', 10);
    if (isNaN(retryLimit) || retryLimit < 1 || retryLimit > 10) {
        throw new Error(
            `Invalid RETRY_LIMIT: ${process.env.RETRY_LIMIT}. Must be between 1 and 10.`
        );
    }

    const tooOldTimestamp = parseFloat(process.env.TOO_OLD_TIMESTAMP || '24');
    if (isNaN(tooOldTimestamp) || tooOldTimestamp <= 0) {
        throw new Error(
            `Invalid TOO_OLD_TIMESTAMP: ${process.env.TOO_OLD_TIMESTAMP}. Must be a positive number (hours, decimals allowed).`
        );
    }

    const requestTimeout = parseInt(process.env.REQUEST_TIMEOUT_MS || '10000', 10);
    if (isNaN(requestTimeout) || requestTimeout < 1000) {
        throw new Error(
            `Invalid REQUEST_TIMEOUT_MS: ${process.env.REQUEST_TIMEOUT_MS}. Must be at least 1000ms.`
        );
    }

    const networkRetryLimit = parseInt(process.env.NETWORK_RETRY_LIMIT || '3', 10);
    if (isNaN(networkRetryLimit) || networkRetryLimit < 1 || networkRetryLimit > 10) {
        throw new Error(
            `Invalid NETWORK_RETRY_LIMIT: ${process.env.NETWORK_RETRY_LIMIT}. Must be between 1 and 10.`
        );
    }
    
    // Validate TRADE_MULTIPLIER
    const tradeMultiplier = parseFloat(process.env.TRADE_MULTIPLIER || '1.0');
    if (isNaN(tradeMultiplier) || tradeMultiplier < 0) {
        throw new Error(
            `Invalid TRADE_MULTIPLIER: ${process.env.TRADE_MULTIPLIER}. Must be >= 0.`
        );
    }
    if (tradeMultiplier > 100) {
        console.warn(`⚠️  TRADE_MULTIPLIER is very high (${tradeMultiplier}x) - make sure this is intentional!`);
    }
};

/**
 * Validate URL formats
 */
const validateUrls = (): void => {
    if (process.env.CLOB_HTTP_URL && !process.env.CLOB_HTTP_URL.startsWith('http')) {
        console.error('\n❌ Invalid CLOB_HTTP_URL\n');
        console.error(`Current value: ${process.env.CLOB_HTTP_URL}`);
        console.error('Default value: https://clob.polymarket.com/\n');
        console.error('⚠️  Use the default value unless you have a specific reason to change it!\n');
        throw new Error(
            `Invalid CLOB_HTTP_URL: ${process.env.CLOB_HTTP_URL}. Must be a valid HTTP/HTTPS URL.`
        );
    }

    if (process.env.CLOB_WS_URL && !process.env.CLOB_WS_URL.startsWith('ws')) {
        console.error('\n❌ Invalid CLOB_WS_URL\n');
        console.error(`Current value: ${process.env.CLOB_WS_URL}`);
        console.error('Default value: wss://ws-subscriptions-clob.polymarket.com/ws\n');
        console.error('⚠️  Use the default value unless you have a specific reason to change it!\n');
        throw new Error(
            `Invalid CLOB_WS_URL: ${process.env.CLOB_WS_URL}. Must be a valid WebSocket URL (ws:// or wss://).`
        );
    }

    if (process.env.RPC_URL && !process.env.RPC_URL.startsWith('http')) {
        console.error('\n❌ Invalid RPC_URL\n');
        console.error(`Current value: ${process.env.RPC_URL}`);
        console.error('Must start with: http:// or https://\n');
        console.error('💡 Get a free RPC endpoint from:');
        console.error('   • Infura:  https://infura.io');
        console.error('   • Alchemy: https://www.alchemy.com');
        console.error('   • Ankr:    https://www.ankr.com\n');
        console.error('Example: https://polygon-mainnet.infura.io/v3/YOUR_PROJECT_ID\n');
        throw new Error(`Invalid RPC_URL: ${process.env.RPC_URL}. Must be a valid HTTP/HTTPS URL.`);
    }

    if (process.env.MONGO_URI && !process.env.MONGO_URI.startsWith('mongodb')) {
        console.error('\n❌ Invalid MONGO_URI\n');
        console.error(`Current value: ${process.env.MONGO_URI}`);
        console.error('Must start with: mongodb:// or mongodb+srv://\n');
        console.error('💡 Setup MongoDB Atlas (free):');
        console.error('   1. Visit https://www.mongodb.com/cloud/atlas/register');
        console.error('   2. Create a free cluster');
        console.error('   3. Create database user with password');
        console.error('   4. Whitelist IP: 0.0.0.0/0 (or your IP)');
        console.error('   5. Get connection string from "Connect" button\n');
        console.error('Example: mongodb+srv://username:password@cluster.mongodb.net/database\n');
        throw new Error(
            `Invalid MONGO_URI: ${process.env.MONGO_URI}. Must be a valid MongoDB connection string.`
        );
    }
};

// Run all validations
validateRequiredEnv();
validateAddresses();
validateNumericConfig();
validateUrls();

// Parse USER_ADDRESSES: supports both comma-separated string and JSON array
const parseUserAddresses = (input: string): string[] => {
    const trimmed = input.trim();
    // Check if it's JSON array format
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                const addresses = parsed
                    .map((addr) => addr.toLowerCase().trim())
                    .filter((addr) => addr.length > 0);
                // Validate each address
                for (const addr of addresses) {
                    if (!isValidEthereumAddress(addr)) {
                        console.error('\n❌ Invalid Trader Address in USER_ADDRESSES\n');
                        console.error(`Invalid address: ${addr}`);
                        console.error('Expected format: 0x followed by 40 hexadecimal characters\n');
                        console.error('💡 Where to find trader addresses:');
                        console.error('   • Polymarket Leaderboard: https://polymarket.com/leaderboard');
                        console.error('   • Predictfolio: https://predictfolio.com\n');
                        console.error('Example: USER_ADDRESSES=\'0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b\'\n');
                        throw new Error(`Invalid Ethereum address in USER_ADDRESSES: ${addr}`);
                    }
                }
                return addresses;
            }
        } catch (e) {
            if (e instanceof Error && e.message.includes('Invalid Ethereum address')) {
                throw e;
            }
            throw new Error(
                `Invalid JSON format for USER_ADDRESSES: ${e instanceof Error ? e.message : String(e)}`
            );
        }
    }
    // Otherwise treat as comma-separated
    const addresses = trimmed
        .split(',')
        .map((addr) => addr.toLowerCase().trim())
        .filter((addr) => addr.length > 0);
    // Validate each address
    for (const addr of addresses) {
        if (!isValidEthereumAddress(addr)) {
            console.error('\n❌ Invalid Trader Address in USER_ADDRESSES\n');
            console.error(`Invalid address: ${addr}`);
            console.error('Expected format: 0x followed by 40 hexadecimal characters\n');
            console.error('💡 Where to find trader addresses:');
            console.error('   • Polymarket Leaderboard: https://polymarket.com/leaderboard');
            console.error('   • Predictfolio: https://predictfolio.com\n');
            console.error('Example: USER_ADDRESSES=\'0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b\'\n');
            throw new Error(`Invalid Ethereum address in USER_ADDRESSES: ${addr}`);
        }
    }
    return addresses;
};

// Parse copy strategy configuration
const parseCopyStrategy = (): CopyStrategyConfig => {
    // Support legacy COPY_PERCENTAGE + TRADE_MULTIPLIER for backward compatibility
    const hasLegacyConfig = process.env.COPY_PERCENTAGE && !process.env.COPY_STRATEGY;

    if (hasLegacyConfig) {
        console.warn(
            '⚠️  Using legacy COPY_PERCENTAGE configuration. Consider migrating to COPY_STRATEGY.'
        );
        const copyPercentage = parseFloat(process.env.COPY_PERCENTAGE || '10.0');
        const tradeMultiplier = parseFloat(process.env.TRADE_MULTIPLIER || '1.0');
        const effectivePercentage = copyPercentage * tradeMultiplier;

        const config: CopyStrategyConfig = {
            strategy: CopyStrategy.PERCENTAGE,
            copySize: effectivePercentage,
            maxOrderSizeUSD: parseFloat(process.env.MAX_ORDER_SIZE_USD || '100.0'),
            minOrderSizeUSD: parseFloat(process.env.MIN_ORDER_SIZE_USD || '1.0'),
            maxPositionSizeUSD: process.env.MAX_POSITION_SIZE_USD
                ? parseFloat(process.env.MAX_POSITION_SIZE_USD)
                : undefined,
            maxDailyVolumeUSD: process.env.MAX_DAILY_VOLUME_USD
                ? parseFloat(process.env.MAX_DAILY_VOLUME_USD)
                : undefined,
        };

        // Parse tiered multipliers if configured (even for legacy mode)
        if (process.env.TIERED_MULTIPLIERS) {
            try {
                config.tieredMultipliers = parseTieredMultipliers(process.env.TIERED_MULTIPLIERS);
                console.log(`✓ Loaded ${config.tieredMultipliers.length} tiered multipliers`);
            } catch (error) {
                throw new Error(`Failed to parse TIERED_MULTIPLIERS: ${error instanceof Error ? error.message : String(error)}`);
            }
        } else if (tradeMultiplier !== 1.0) {
            // If using legacy single multiplier, store it
            config.tradeMultiplier = tradeMultiplier;
        }

        return config;
    }

    // Parse new copy strategy configuration
    const strategyStr = (process.env.COPY_STRATEGY || 'PERCENTAGE').toUpperCase();
    const strategy =
        CopyStrategy[strategyStr as keyof typeof CopyStrategy] || CopyStrategy.PERCENTAGE;

    const config: CopyStrategyConfig = {
        strategy,
        copySize: parseFloat(process.env.COPY_SIZE || '10.0'),
        maxOrderSizeUSD: parseFloat(process.env.MAX_ORDER_SIZE_USD || '100.0'),
        minOrderSizeUSD: parseFloat(process.env.MIN_ORDER_SIZE_USD || '1.0'),
        maxPositionSizeUSD: process.env.MAX_POSITION_SIZE_USD
            ? parseFloat(process.env.MAX_POSITION_SIZE_USD)
            : undefined,
        maxDailyVolumeUSD: process.env.MAX_DAILY_VOLUME_USD
            ? parseFloat(process.env.MAX_DAILY_VOLUME_USD)
            : undefined,
    };

    // Add adaptive strategy parameters if applicable
    if (strategy === CopyStrategy.ADAPTIVE) {
        config.adaptiveMinPercent = parseFloat(
            process.env.ADAPTIVE_MIN_PERCENT || config.copySize.toString()
        );
        config.adaptiveMaxPercent = parseFloat(
            process.env.ADAPTIVE_MAX_PERCENT || config.copySize.toString()
        );
        config.adaptiveThreshold = parseFloat(process.env.ADAPTIVE_THRESHOLD_USD || '500.0');
    }

    // Parse tiered multipliers if configured
    if (process.env.TIERED_MULTIPLIERS) {
        try {
            config.tieredMultipliers = parseTieredMultipliers(process.env.TIERED_MULTIPLIERS);
            console.log(`✓ Loaded ${config.tieredMultipliers.length} tiered multipliers`);
        } catch (error) {
            throw new Error(`Failed to parse TIERED_MULTIPLIERS: ${error instanceof Error ? error.message : String(error)}`);
        }
    } else if (process.env.TRADE_MULTIPLIER) {
        // Fall back to single multiplier if no tiers configured
        const singleMultiplier = parseFloat(process.env.TRADE_MULTIPLIER);
        if (singleMultiplier !== 1.0) {
            config.tradeMultiplier = singleMultiplier;
            console.log(`✓ Using single trade multiplier: ${singleMultiplier}x`);
        }
    }

    return config;
};

export const ENV = {
    USER_ADDRESSES: parseUserAddresses(process.env.USER_ADDRESSES as string),
    PROXY_WALLET: process.env.PROXY_WALLET as string,
    PRIVATE_KEY: process.env.PRIVATE_KEY as string,
    CLOB_HTTP_URL: process.env.CLOB_HTTP_URL as string,
    CLOB_WS_URL: process.env.CLOB_WS_URL as string,
    POLY_API_KEY: process.env.POLY_API_KEY as string | undefined,
    POLY_SECRET: normalizeBase64(process.env.POLY_SECRET) as string | undefined,
    POLY_PASSPHRASE: process.env.POLY_PASSPHRASE as string | undefined,
    FETCH_INTERVAL: parseInt(process.env.FETCH_INTERVAL || '1', 10),
    TOO_OLD_TIMESTAMP: parseFloat(process.env.TOO_OLD_TIMESTAMP || '24'),
    RETRY_LIMIT: parseInt(process.env.RETRY_LIMIT || '3', 10),
    DRY_RUN: process.env.DRY_RUN === 'true',
    SIMULATION_STARTING_BALANCE: parseFloat(process.env.SIMULATION_STARTING_BALANCE || '1000.0'),
    SIMULATION_MODE: process.env.SIMULATION_MODE || 'HYBRID',
    SIMULATION_MAX_SLIPPAGE_PERCENT: parseFloat(process.env.SIMULATION_MAX_SLIPPAGE_PERCENT || '50.0'),
    SIMULATION_PARTIAL_FILL_STRATEGY: process.env.SIMULATION_PARTIAL_FILL_STRATEGY || 'WARN',
    // Copy delay simulation (realistic timing between trader and bot execution)
    SIMULATION_COPY_DELAY_MIN: parseFloat(process.env.SIMULATION_COPY_DELAY_MIN || '5.0'),
    SIMULATION_COPY_DELAY_MAX: parseFloat(process.env.SIMULATION_COPY_DELAY_MAX || '15.0'),
    SIMULATION_COPY_DELAY_ENABLED: process.env.SIMULATION_COPY_DELAY_ENABLED !== 'false', // Enabled by default
    // Legacy parameters (kept for backward compatibility)
    TRADE_MULTIPLIER: parseFloat(process.env.TRADE_MULTIPLIER || '1.0'),
    COPY_PERCENTAGE: parseFloat(process.env.COPY_PERCENTAGE || '10.0'),
    // New copy strategy configuration
    COPY_STRATEGY_CONFIG: parseCopyStrategy(),
    // Network settings
    REQUEST_TIMEOUT_MS: parseInt(process.env.REQUEST_TIMEOUT_MS || '10000', 10),
    NETWORK_RETRY_LIMIT: parseInt(process.env.NETWORK_RETRY_LIMIT || '3', 10),
    // Trade aggregation settings
    TRADE_AGGREGATION_ENABLED: process.env.TRADE_AGGREGATION_ENABLED === 'true',
    TRADE_AGGREGATION_WINDOW_SECONDS: parseInt(
        process.env.TRADE_AGGREGATION_WINDOW_SECONDS || '300',
        10
    ), // 5 minutes default
    // Trader cooldown settings
    TRADER_COOLDOWN_ENABLED: process.env.TRADER_COOLDOWN_ENABLED === 'true',
    TRADER_COOLDOWN_SECONDS: parseInt(process.env.TRADER_COOLDOWN_SECONDS || '300', 10),
    MONGO_URI: process.env.MONGO_URI as string,
    RPC_URL: process.env.RPC_URL as string,
    USDC_CONTRACT_ADDRESS: process.env.USDC_CONTRACT_ADDRESS as string,
    // Minimum order sizes
    MIN_ORDER_SIZE_USD: parseFloat(process.env.MIN_ORDER_SIZE_USD || '1.0'),
    MIN_ORDER_SIZE_TOKENS: parseFloat(process.env.MIN_ORDER_SIZE_TOKENS || '1.0'),
    // Position limits
    MAX_OPEN_POSITIONS: process.env.MAX_OPEN_POSITIONS
        ? parseInt(process.env.MAX_OPEN_POSITIONS, 10)
        : undefined,
    // Auto-sell stale positions
    AUTO_SELL_STALE_POSITIONS_DAYS: process.env.AUTO_SELL_STALE_POSITIONS_DAYS
        ? parseInt(process.env.AUTO_SELL_STALE_POSITIONS_DAYS, 10)
        : undefined,
    STALE_POSITION_CHECK_INTERVAL_HOURS: process.env.STALE_POSITION_CHECK_INTERVAL_HOURS
        ? parseInt(process.env.STALE_POSITION_CHECK_INTERVAL_HOURS, 10)
        : 24,
    // Cash reserve (minimum balance to keep)
    MIN_CASH_RESERVE: parseFloat(process.env.MIN_CASH_RESERVE || '0'),
    // Trader filtering criteria
    MIN_TRADER_WIN_RATE: parseFloat(process.env.MIN_TRADER_WIN_RATE || '0'),
    MIN_TRADER_AVG_POSITION_SIZE: parseFloat(process.env.MIN_TRADER_AVG_POSITION_SIZE || '0'),
    MIN_MARKET_DAILY_VOLUME: parseFloat(process.env.MIN_MARKET_DAILY_VOLUME || '0'),
    // Blockchain WebSocket (optionnel — active le monitoring Polygon direct)
    // Public gratuit : wss://polygon-bor-rpc.publicnode.com
    // Alchemy (recommandé) : wss://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
    // Si absent : désactivé silencieusement, REST polling reste actif en fallback
    POLYGON_WS_URL: process.env.POLYGON_WS_URL ?? '',
    // Price protection filters
    // MAX_BUY_PRICE: refuse BUY trades at prices above this threshold (default: 0.95)
    // At $0.95 max gain = 5.26%, below that fees eat all profit
    MAX_BUY_PRICE: parseFloat(process.env.MAX_BUY_PRICE || '0.98'),
    // MIN_GAIN_POTENTIAL_PERCENT: minimum possible gain % to accept a trade (default: 1.0)
    // Computed as: (1 - price) / price * 100. At $0.97 = 3.09%, at $0.99 = 1.01% (rejected)
    MIN_GAIN_POTENTIAL_PERCENT: parseFloat(process.env.MIN_GAIN_POTENTIAL_PERCENT || '1.0'),
    // MAX_SLIPPAGE_PERCENT: slippage max autorisé entre prix trader et ask actuel (défaut: 10%)
    MAX_SLIPPAGE_PERCENT: parseFloat(process.env.MAX_SLIPPAGE_PERCENT || '80.0'),
    // REAL_GAS_FEES: use Polygon Gas Station API for real gas costs (default: true)
    REAL_GAS_FEES: process.env.REAL_GAS_FEES !== 'false',
    // ─── DIP FOLLOWER ────────────────────────────────────────────────────────
    // Achète quand un trader est en perte sur un marché actif non résolu
    DIP_FOLLOW_ENABLED: process.env.DIP_FOLLOW_ENABLED === 'true',
    DIP_FOLLOW_MIN_DIP_PERCENT: parseFloat(process.env.DIP_FOLLOW_MIN_DIP_PERCENT || '5.0'),
    DIP_FOLLOW_MAX_POSITION_DAYS: parseFloat(process.env.DIP_FOLLOW_MAX_POSITION_DAYS || '30.0'),
    DIP_FOLLOW_INTERVAL_MINUTES: parseFloat(process.env.DIP_FOLLOW_INTERVAL_MINUTES || '15.0'),
    DIP_FOLLOW_MIN_CURRENT_PRICE: parseFloat(process.env.DIP_FOLLOW_MIN_CURRENT_PRICE || '0.05'),
    DIP_FOLLOW_MAX_CURRENT_PRICE: parseFloat(process.env.DIP_FOLLOW_MAX_CURRENT_PRICE || '0.90'),
};

/**
 * Recharge à chaud les paramètres de trading depuis le fichier .env.
 * Appelé automatiquement quand .env est modifié, ou manuellement via la touche 'r'.
 * Seuls les paramètres de trading sont rechargés (pas les URLs, clés API, etc.)
 */
export const reloadDynamicEnv = (): void => {
    dotenv.config({ override: true });

    // Snapshot avant mise à jour (pour le log des changements)
    const prev = {
        MAX_BUY_PRICE: ENV.MAX_BUY_PRICE,
        MIN_GAIN_POTENTIAL_PERCENT: ENV.MIN_GAIN_POTENTIAL_PERCENT,
        MAX_SLIPPAGE_PERCENT: ENV.MAX_SLIPPAGE_PERCENT,
        TOO_OLD_TIMESTAMP: ENV.TOO_OLD_TIMESTAMP,
        SIMULATION_MAX_SLIPPAGE_PERCENT: ENV.SIMULATION_MAX_SLIPPAGE_PERCENT,
        TRADER_COOLDOWN_ENABLED: ENV.TRADER_COOLDOWN_ENABLED,
        TRADER_COOLDOWN_SECONDS: ENV.TRADER_COOLDOWN_SECONDS,
        DIP_FOLLOW_ENABLED: ENV.DIP_FOLLOW_ENABLED,
        DIP_FOLLOW_MIN_DIP_PERCENT: ENV.DIP_FOLLOW_MIN_DIP_PERCENT,
    };

    // Mise à jour des paramètres hot-reloadables
    (ENV as any).MAX_BUY_PRICE = parseFloat(process.env.MAX_BUY_PRICE || '0.98');
    (ENV as any).MIN_GAIN_POTENTIAL_PERCENT = parseFloat(process.env.MIN_GAIN_POTENTIAL_PERCENT || '1.0');
    (ENV as any).MAX_SLIPPAGE_PERCENT = parseFloat(process.env.MAX_SLIPPAGE_PERCENT || '10.0');
    (ENV as any).TOO_OLD_TIMESTAMP = parseFloat(process.env.TOO_OLD_TIMESTAMP || '24');
    (ENV as any).SIMULATION_MAX_SLIPPAGE_PERCENT = parseFloat(process.env.SIMULATION_MAX_SLIPPAGE_PERCENT || '50.0');
    (ENV as any).TRADER_COOLDOWN_ENABLED = process.env.TRADER_COOLDOWN_ENABLED === 'true';
    (ENV as any).TRADER_COOLDOWN_SECONDS = parseInt(process.env.TRADER_COOLDOWN_SECONDS || '300', 10);
    (ENV as any).DIP_FOLLOW_ENABLED = process.env.DIP_FOLLOW_ENABLED === 'true';
    (ENV as any).DIP_FOLLOW_MIN_DIP_PERCENT = parseFloat(process.env.DIP_FOLLOW_MIN_DIP_PERCENT || '5.0');

    // Affiche uniquement les valeurs qui ont changé
    const changes: string[] = [];
    if (ENV.MAX_BUY_PRICE !== prev.MAX_BUY_PRICE)
        changes.push(`MAX_BUY_PRICE: $${prev.MAX_BUY_PRICE.toFixed(2)} → $${ENV.MAX_BUY_PRICE.toFixed(2)}`);
    if (ENV.MIN_GAIN_POTENTIAL_PERCENT !== prev.MIN_GAIN_POTENTIAL_PERCENT)
        changes.push(`MIN_GAIN: ${prev.MIN_GAIN_POTENTIAL_PERCENT}% → ${ENV.MIN_GAIN_POTENTIAL_PERCENT}%`);
    if (ENV.MAX_SLIPPAGE_PERCENT !== prev.MAX_SLIPPAGE_PERCENT)
        changes.push(`MAX_SLIPPAGE: ${prev.MAX_SLIPPAGE_PERCENT}% → ${ENV.MAX_SLIPPAGE_PERCENT}%`);
    if (ENV.TOO_OLD_TIMESTAMP !== prev.TOO_OLD_TIMESTAMP)
        changes.push(`TOO_OLD: ${prev.TOO_OLD_TIMESTAMP}h → ${ENV.TOO_OLD_TIMESTAMP}h`);
    if (ENV.SIMULATION_MAX_SLIPPAGE_PERCENT !== prev.SIMULATION_MAX_SLIPPAGE_PERCENT)
        changes.push(`SIM_SLIPPAGE: ${prev.SIMULATION_MAX_SLIPPAGE_PERCENT}% → ${ENV.SIMULATION_MAX_SLIPPAGE_PERCENT}%`);
    if (ENV.TRADER_COOLDOWN_ENABLED !== prev.TRADER_COOLDOWN_ENABLED)
        changes.push(`COOLDOWN: ${prev.TRADER_COOLDOWN_ENABLED} → ${ENV.TRADER_COOLDOWN_ENABLED}`);
    if (ENV.DIP_FOLLOW_ENABLED !== prev.DIP_FOLLOW_ENABLED)
        changes.push(`DIP_FOLLOW: ${prev.DIP_FOLLOW_ENABLED} → ${ENV.DIP_FOLLOW_ENABLED}`);
    if (ENV.DIP_FOLLOW_MIN_DIP_PERCENT !== prev.DIP_FOLLOW_MIN_DIP_PERCENT)
        changes.push(`DIP_MIN: ${prev.DIP_FOLLOW_MIN_DIP_PERCENT}% → ${ENV.DIP_FOLLOW_MIN_DIP_PERCENT}%`);

    if (changes.length > 0) {
        console.log(`\n🔄 [HOT RELOAD] Paramètres mis à jour :`);
        changes.forEach(c => console.log(`   ✓ ${c}`));
        console.log('');
    } else {
        console.log(`\n🔄 [HOT RELOAD] Config rechargée — aucun changement\n`);
    }
};
