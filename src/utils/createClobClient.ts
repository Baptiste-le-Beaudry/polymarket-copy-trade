import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { ENV } from '../config/env';
import Logger from './logger';

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const CLOB_HTTP_URL = ENV.CLOB_HTTP_URL;
const RPC_URL = ENV.RPC_URL;

// Réseau Polygon fixe — évite l'auto-détection eth_chainId qui provoque "could not detect network"
const POLYGON_NETWORK = { chainId: 137, name: 'matic' };

// Provider singleton réutilisé (évite de créer une connexion à chaque appel)
let _rpcProvider: ethers.providers.JsonRpcProvider | null = null;
const getRpcProvider = () => {
    if (!_rpcProvider) {
        _rpcProvider = new ethers.providers.JsonRpcProvider(RPC_URL, POLYGON_NETWORK);
    }
    return _rpcProvider;
};

/**
 * Determines if a wallet is a Gnosis Safe by checking if it has contract code.
 * Timeout 5s pour éviter un blocage si le RPC est rate-limité.
 */
const isGnosisSafe = async (address: string): Promise<boolean> => {
    try {
        const codePromise = getRpcProvider().getCode(address);
        const timeoutPromise = new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error('getCode timeout after 5s')), 5000)
        );
        const code = await Promise.race([codePromise, timeoutPromise]);
        return code !== '0x';
    } catch (error) {
        Logger.error(`Error checking wallet type: ${error}`);
        return false; // Par défaut EOA — mode le plus courant
    }
};

const createClobClient = async (): Promise<ClobClient> => {
    const chainId = 137;
    const host = CLOB_HTTP_URL as string;
    const wallet = new ethers.Wallet(PRIVATE_KEY as string);

    // Detect if the wallet is a Gnosis Safe contract or a regular EOA
    let signatureType = SignatureType.EOA;
    let proxyWallet: string | undefined = undefined;

    if (PROXY_WALLET) {
        // En DRY_RUN, pas besoin de détecter le type de wallet (aucun ordre réel)
        // — évite le timeout RPC de 5s au démarrage
        if (ENV.DRY_RUN) {
            signatureType = SignatureType.EOA;
            proxyWallet = undefined;
            Logger.info(`Wallet type: EOA (DRY_RUN — vérif RPC ignorée)`);
        } else {
            const isContract = await isGnosisSafe(PROXY_WALLET as string);
            if (isContract) {
                signatureType = SignatureType.POLY_GNOSIS_SAFE;
                proxyWallet = PROXY_WALLET as string;
                Logger.info(`Wallet type detected: Smart Contract / Gnosis Safe (${proxyWallet})`);
            } else {
                signatureType = SignatureType.EOA;
                proxyWallet = undefined;
                Logger.info(`Wallet type detected: EOA (${PROXY_WALLET})`);
            }
        }
    } else {
        Logger.info('Wallet type: EOA (no PROXY_WALLET configured)');
    }

    /*let clobClient = new ClobClient(
        host,
        chainId,
        wallet,
        undefined,
        signatureType,
        isProxySafe ? (PROXY_WALLET as string) : undefined
    );*/

    let clobClient = new ClobClient(host, chainId, wallet, undefined, signatureType, proxyWallet);


    // Suppress console output during API key creation
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    console.log = function () {};
    console.error = function () {};

    // If credentials are provided via environment, prefer them (useful for contract/proxy wallets)
    let creds: { key?: string; secret?: string; passphrase?: string } | undefined;
    if (process.env.POLY_API_KEY && process.env.POLY_SECRET && process.env.POLY_PASSPHRASE) {
        creds = {
            key: process.env.POLY_API_KEY,
            secret: process.env.POLY_SECRET,
            passphrase: process.env.POLY_PASSPHRASE,
        };
    } else if (ENV.DRY_RUN) {
        // En simulation, pas besoin de credentials CLOB — lecture seule uniquement
        creds = undefined;
    } else {
        const created = await clobClient.createApiKey().catch(() => undefined);
        if (created && created.key) {
            creds = created;
        } else {
            const derived = await clobClient.deriveApiKey().catch(() => undefined);
            if (derived && derived.key) {
                creds = derived;
            } else {
                creds = undefined;
            }
        }
    }



    clobClient = new ClobClient(host, chainId, wallet, creds as any, signatureType, proxyWallet);

    // Restore console functions
    console.log = originalConsoleLog;
    console.error = originalConsoleError;

    return clobClient;
};

export default createClobClient;
