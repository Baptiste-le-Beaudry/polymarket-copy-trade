/**
 * MEMPOOL MONITOR — Détection des trades AVANT confirmation du bloc Polygon (~2s gagnés)
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * POURQUOI :
 *   Polygon mine un bloc toutes les ~2 secondes. blockchainMonitor.ts réagit APRÈS
 *   confirmation. Ce module réagit à la pending transaction (~50-200ms après broadcast),
 *   soit ~1.5-2s plus tôt.
 *
 * COMMENT ça marche :
 *   1. Connexion WebSocket → abonnement alchemy_pendingTransactions filtré sur CTFExchange
 *   2. Pour chaque tx entrant → décodage du calldata (matchOrders / fillOrder)
 *   3. Si un trader suivi est maker/taker → callback immédiat → bot exécute
 *   4. blockchainMonitor.ts arrive ~2s plus tard avec le même txHash → upsert ignoré
 *      (botExcutedTime déjà 1) → pas de double-exécution
 *
 * PRÉREQUIS :
 *   - POLYGON_WS_URL doit contenir "alchemy.com" (alchemy_pendingTransactions = Alchemy uniquement)
 *   - Sans Alchemy → module désactivé silencieusement
 *
 * RISQUES :
 *   - La tx peut revert (~0.5% sur Polygon) → position ouverte inutilement
 *   - Mitigation : on vérifie la confirmation dans les 30s. Log warning si non-confirmée.
 *     (Annulation automatique = future amélioration)
 */

import { ethers } from 'ethers';
import { ENV } from '../config/env';
import Logger from '../utils/logger';
import { getUserActivityModel } from '../models/userHistory';
import { BlockchainTradePayload, setOnNewBlockchainTrade } from './blockchainMonitor';

// ═══════════════════════════════════════════════════════════════════════
// CONTRATS Polymarket sur Polygon mainnet
// ═══════════════════════════════════════════════════════════════════════
const CTF_EXCHANGE      = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

const CTF_ADDRESSES_LOWER = new Set([
    CTF_EXCHANGE.toLowerCase(),
    NEG_RISK_EXCHANGE.toLowerCase(),
]);

// ═══════════════════════════════════════════════════════════════════════
// ABI CTF Exchange — Order struct + fonctions de matching
// Source : @polymarket/clob-client contrat CTFExchange.sol
// ═══════════════════════════════════════════════════════════════════════
const ORDER_TUPLE = '(uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature)';

const CTF_IFACE = new ethers.utils.Interface([
    `function matchOrders(${ORDER_TUPLE} makerOrder, ${ORDER_TUPLE}[] takerOrders, uint256 makerFillAmount, uint256[] takerFillAmounts) external`,
    `function fillOrder(${ORDER_TUPLE} order, uint256 fillAmount) external`,
]);

// side: 0 = BUY (maker paie USDC pour recevoir des tokens)
//        1 = SELL (maker donne des tokens pour recevoir USDC)
const SIDE_BUY  = 0;
const SIDE_SELL = 1;

// ═══════════════════════════════════════════════════════════════════════
// TRADERS SUIVIS
// ═══════════════════════════════════════════════════════════════════════
const trackedSet = new Set(ENV.USER_ADDRESSES.map(a => a.toLowerCase()));
const addressMap = new Map(ENV.USER_ADDRESSES.map(a => [a.toLowerCase(), a]));

const TOKEN_DECIMALS = 6;
const DIVISOR = 10 ** TOKEN_DECIMALS;

// ═══════════════════════════════════════════════════════════════════════
// CALLBACK DIRECT → EXECUTOR
// Partagé avec blockchainMonitor mais les trades mempool sont insérés AVANT
// → quand blockchainMonitor reçoit le bloc confirmé → upsert ignoré (déjà en DB)
// ═══════════════════════════════════════════════════════════════════════
type MempoolTradeCallback = (payload: BlockchainTradePayload) => void;
let _mempoolCallback: MempoolTradeCallback | null = null;

export const setOnNewMempoolTrade = (cb: MempoolTradeCallback): void => {
    _mempoolCallback = cb;
};

// ═══════════════════════════════════════════════════════════════════════
// CONFIRMATION TRACKER — Détecte les tx non-confirmées après 30s
// ═══════════════════════════════════════════════════════════════════════
interface PendingExecution {
    trackedAddress: string;
    txHash:         string;
    executedAt:     number;
}
const pendingConfirmations = new Map<string, PendingExecution>();

let _confirmCheckInterval: NodeJS.Timeout | null = null;

const startConfirmationTracker = (): void => {
    if (_confirmCheckInterval) return;
    _confirmCheckInterval = setInterval(async () => {
        const now = Date.now();
        const toCheck: PendingExecution[] = [];
        for (const [txHash, info] of pendingConfirmations.entries()) {
            if (now - info.executedAt > 30_000) {
                toCheck.push(info);
                pendingConfirmations.delete(txHash);
            }
        }
        for (const info of toCheck) {
            try {
                const UserActivity = getUserActivityModel(info.trackedAddress);
                const doc = await UserActivity.findOne(
                    { transactionHash: info.txHash, bot: true }
                ).exec();
                if (!doc) {
                    Logger.warning(
                        `⚡ MEMPOOL: Tx non-confirmée après 30s → ${info.txHash.slice(0, 16)}... ` +
                        `(risque de position ouverte à tort — vérifier manuellement)`
                    );
                }
            } catch { /* non-bloquant */ }
        }
    }, 10_000);
};

// ═══════════════════════════════════════════════════════════════════════
// DÉCODAGE DU CALLDATA
// ═══════════════════════════════════════════════════════════════════════
interface DecodedPendingTrade {
    trackedAddress: string;
    tokenId:        string;
    side:           'BUY' | 'SELL';
    usdcSize:       number;
    tokenSize:      number;
    price:          number;
    txHash:         string;
}

const decodePendingTx = (txData: string, txHash: string): DecodedPendingTrade | null => {
    if (!txData || txData === '0x' || txData.length < 10) return null;

    let decoded: ethers.utils.Result | null = null;
    let funcName: string | null = null;

    // Essaie matchOrders d'abord (plus courant), puis fillOrder
    for (const fn of ['matchOrders', 'fillOrder']) {
        try {
            decoded = CTF_IFACE.decodeFunctionData(fn, txData);
            funcName = fn;
            break;
        } catch { /* mauvaise fonction, essayer la suivante */ }
    }

    if (!decoded || !funcName) return null;

    let orders: any[] = [];

    if (funcName === 'matchOrders') {
        const makerOrder = decoded.makerOrder;
        const takerOrders: any[] = decoded.takerOrders || [];
        const makerFill: ethers.BigNumber = decoded.makerFillAmount;
        const takerFills: ethers.BigNumber[] = decoded.takerFillAmounts || [];

        // Vérifier le maker
        const makerLow = makerOrder.maker?.toLowerCase();
        if (makerLow && trackedSet.has(makerLow)) {
            const trackedAddress = addressMap.get(makerLow)!;
            const sideNum: number = makerOrder.side;
            const tokenIdStr: string = makerOrder.tokenId?.toString() ?? '';

            // Calculer les montants réels de ce fill
            const takerFillTotal: ethers.BigNumber = takerFills.reduce(
                (sum: ethers.BigNumber, v: ethers.BigNumber) => sum.add(v),
                ethers.BigNumber.from(0)
            );

            let usdcRaw: ethers.BigNumber, tokenRaw: ethers.BigNumber;
            if (sideNum === SIDE_BUY) {
                usdcRaw  = makerFill;        // USDC payé par le maker
                tokenRaw = takerFillTotal;   // Tokens reçus
            } else {
                tokenRaw = makerFill;        // Tokens vendus par le maker
                usdcRaw  = takerFillTotal;   // USDC reçus
            }

            const usdcSize  = usdcRaw.toNumber()  / DIVISOR;
            const tokenSize = tokenRaw.toNumber()  / DIVISOR;
            const price     = tokenSize > 0 ? usdcSize / tokenSize : 0;

            return {
                trackedAddress,
                tokenId:  tokenIdStr,
                side:     sideNum === SIDE_BUY ? 'BUY' : 'SELL',
                usdcSize,
                tokenSize,
                price,
                txHash,
            };
        }

        // Vérifier les takers
        for (let i = 0; i < takerOrders.length; i++) {
            const takerOrder = takerOrders[i];
            const takerLow = takerOrder.maker?.toLowerCase();
            if (!takerLow || !trackedSet.has(takerLow)) continue;

            const trackedAddress = addressMap.get(takerLow)!;
            const sideNum: number = takerOrder.side;
            const tokenIdStr: string = takerOrder.tokenId?.toString() ?? '';

            const takerFill: ethers.BigNumber = takerFills[i] ?? ethers.BigNumber.from(0);
            // Pour le taker, le fill est inversé par rapport au maker
            // takerFill = montant donné par le taker (side opposé au makerOrder)
            let usdcRaw: ethers.BigNumber, tokenRaw: ethers.BigNumber;
            if (sideNum === SIDE_BUY) {
                // Taker BUY → il paie USDC, reçoit tokens
                // takerFill = montant que le taker reçoit du maker
                usdcRaw  = takerFill;                         // approximation
                tokenRaw = takerFills[i] ?? ethers.BigNumber.from(0);
            } else {
                tokenRaw = takerFill;
                usdcRaw  = takerFills[i] ?? ethers.BigNumber.from(0);
            }

            const usdcSize  = usdcRaw.toNumber()  / DIVISOR;
            const tokenSize = tokenRaw.toNumber()  / DIVISOR;
            const price     = tokenSize > 0 ? usdcSize / tokenSize : 0;

            return {
                trackedAddress,
                tokenId:  tokenIdStr,
                side:     sideNum === SIDE_BUY ? 'BUY' : 'SELL',
                usdcSize,
                tokenSize,
                price,
                txHash,
            };
        }
    } else if (funcName === 'fillOrder') {
        const order = decoded.order;
        const makerLow = order.maker?.toLowerCase();
        if (!makerLow || !trackedSet.has(makerLow)) return null;

        const trackedAddress = addressMap.get(makerLow)!;
        const sideNum: number = order.side;
        const tokenIdStr: string = order.tokenId?.toString() ?? '';
        const fillAmount: ethers.BigNumber = decoded.fillAmount;

        // Pour fillOrder, fillAmount = montant makerAmount rempli
        let usdcRaw: ethers.BigNumber, tokenRaw: ethers.BigNumber;
        if (sideNum === SIDE_BUY) {
            usdcRaw  = fillAmount;
            // Tokens = fillAmount * takerAmount / makerAmount
            const ratio = order.takerAmount.mul(fillAmount).div(order.makerAmount);
            tokenRaw = ratio;
        } else {
            tokenRaw = fillAmount;
            const ratio = order.takerAmount.mul(fillAmount).div(order.makerAmount);
            usdcRaw  = ratio;
        }

        const usdcSize  = usdcRaw.toNumber()  / DIVISOR;
        const tokenSize = tokenRaw.toNumber()  / DIVISOR;
        const price     = tokenSize > 0 ? usdcSize / tokenSize : 0;

        return {
            trackedAddress,
            tokenId:  tokenIdStr,
            side:     sideNum === SIDE_BUY ? 'BUY' : 'SELL',
            usdcSize,
            tokenSize,
            price,
            txHash,
        };
    }

    return null;
};

// ═══════════════════════════════════════════════════════════════════════
// SAUVEGARDE EN DB + CALLBACK
// ═══════════════════════════════════════════════════════════════════════
let mempoolTradeCount = 0;

const handlePendingTx = async (tx: any): Promise<void> => {
    if (!tx?.to || !tx?.hash || !tx?.input) return;

    // Filtrer : uniquement les tx vers CTF Exchange
    if (!CTF_ADDRESSES_LOWER.has(tx.to.toLowerCase())) return;

    let decoded: DecodedPendingTrade | null;
    try {
        decoded = decodePendingTx(tx.input, tx.hash);
    } catch {
        return; // Calldata non-décodable → ignorer silencieusement
    }
    if (!decoded) return;

    const { trackedAddress, tokenId, side, usdcSize, tokenSize, price, txHash } = decoded;
    const nowSec = Math.floor(Date.now() / 1000);

    Logger.info(
        `⚡ MEMPOOL: ${side} détecté — ${trackedAddress.slice(0, 10)}... ` +
        `$${usdcSize.toFixed(2)} @ $${price.toFixed(4)} (AVANT bloc)`
    );

    // Insérer en MongoDB (même format que blockchainMonitor)
    // botExcutedTime: 1 = pre-claimed → blockchainMonitor ignorera ce txHash au bloc confirmé
    const UserActivity = getUserActivityModel(trackedAddress);
    let upsertedId: any;
    try {
        const result = await UserActivity.updateOne(
            { transactionHash: txHash },
            {
                $setOnInsert: {
                    proxyWallet:     trackedAddress,
                    timestamp:       nowSec,
                    conditionId:     '', // Sera rempli par blockchainMonitor arrière-plan
                    type:            'TRADE',
                    size:            tokenSize,
                    usdcSize:        usdcSize,
                    transactionHash: txHash,
                    price:           price,
                    asset:           tokenId,
                    side:            side,
                    title:           `Token ${tokenId.slice(0, 16)}... (mempool)`,
                    slug:            '',
                    eventSlug:       '',
                    name:            '__mempool__',
                    bot:             false,
                    botExcutedTime:  1, // Pre-claimed
                },
            },
            { upsert: true }
        ).exec();

        if (result.upsertedCount === 0) return; // Déjà en DB (double event ou retard)
        upsertedId = result.upsertedId;
    } catch {
        return; // Erreur DB → ignorer, blockchainMonitor prendra le relais
    }

    mempoolTradeCount++;

    // Tracker pour la confirmation (30s)
    pendingConfirmations.set(txHash, { trackedAddress, txHash, executedAt: Date.now() });

    // Appel du callback (même interface que blockchainMonitor)
    if (_mempoolCallback) {
        _mempoolCallback({
            _id:           upsertedId,
            trackedAddress,
            tokenId,
            side,
            usdcSize,
            tokenSize,
            price,
            txHash,
            conditionId:   '',
            title:         `Token ${tokenId.slice(0, 16)}... (mempool)`,
            slug:          '',
            eventSlug:     '',
            timestamp:     nowSec,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// CONNEXION WEBSOCKET ALCHEMY
// ═══════════════════════════════════════════════════════════════════════
let isRunning = true;
let wsConnected = false;

const connectMempool = async (wsUrl: string, retryMs = 5_000): Promise<void> => {
    if (!isRunning) return;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const WS = require('ws');
    let ws: any = null;
    let pingInterval: NodeJS.Timeout | null = null;

    const cleanup = () => {
        if (pingInterval) clearInterval(pingInterval);
        try { ws?.close(); } catch { /* silence */ }
        wsConnected = false;
    };

    const reconnect = (delay: number) => {
        cleanup();
        if (isRunning) setTimeout(() => connectMempool(wsUrl, Math.min(delay * 2, 60_000)), delay);
    };

    try {
        ws = new WS(wsUrl);

        ws.on('error', (err: Error) => {
            Logger.warning(`⚡ MEMPOOL: WebSocket erreur — ${err.message}`);
            reconnect(retryMs);
        });

        ws.on('close', (code: number) => {
            if (wsConnected) {
                Logger.warning(`⚡ MEMPOOL: WebSocket fermé (code ${code}) — retry dans ${retryMs / 1000}s`);
                reconnect(retryMs);
            }
        });

        ws.on('open', () => {
            wsConnected = true;
            Logger.success(
                `⚡ MEMPOOL: Connecté à Alchemy — surveillance de ${ENV.USER_ADDRESSES.length} trader(s) en AVANT-BLOC`
            );

            // Abonnement Alchemy aux pending transactions filtrées par adresse de contrat
            ws.send(JSON.stringify({
                id:     1,
                method: 'eth_subscribe',
                params: ['alchemy_pendingTransactions', {
                    toAddress: [CTF_EXCHANGE, NEG_RISK_EXCHANGE],
                }],
            }));

            // Ping toutes les 30s pour détecter les coupures silencieuses
            pingInterval = setInterval(() => {
                try {
                    ws.send(JSON.stringify({ id: 99, method: 'eth_blockNumber', params: [] }));
                } catch {
                    reconnect(5_000);
                }
            }, 30_000);

            retryMs = 5_000; // Reset délai après connexion réussie
        });

        ws.on('message', (data: Buffer | string) => {
            try {
                const msg = JSON.parse(data.toString());
                // Réponse à l'abonnement : id=1 contient le subscriptionId
                if (msg.id === 1 && msg.result) {
                    Logger.info(`⚡ MEMPOOL: Abonnement alchemy_pendingTransactions actif (id: ${msg.result.slice(0, 10)}...)`);
                    return;
                }
                // Notification de pending transaction
                if (msg.method === 'eth_subscription' && msg.params?.result) {
                    handlePendingTx(msg.params.result).catch(() => {});
                }
            } catch { /* message malformé → ignorer */ }
        });

    } catch (err) {
        Logger.error(`⚡ MEMPOOL: Connexion échouée — ${(err as Error).message}`);
        reconnect(retryMs);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// API PUBLIQUE
// ═══════════════════════════════════════════════════════════════════════

export const getMempoolStatus = (): { connected: boolean; tradeCount: number } => ({
    connected:   wsConnected,
    tradeCount:  mempoolTradeCount,
});

export const stopMempoolMonitor = (): void => {
    isRunning = false;
    if (_confirmCheckInterval) clearInterval(_confirmCheckInterval);
    Logger.info(`⚡ MEMPOOL: Arrêt (${mempoolTradeCount} trade(s) détecté(s) en mempool)`);
};

/**
 * Point d'entrée principal du mempool monitor.
 *
 * Actif uniquement si POLYGON_WS_URL contient "alchemy.com" — la subscription
 * alchemy_pendingTransactions n'est disponible que sur les nœuds Alchemy.
 * Pour les autres nœuds → désactivé silencieusement.
 */
const mempoolMonitor = async (): Promise<void> => {
    const wsUrl = ENV.POLYGON_WS_URL;
    if (!wsUrl || !wsUrl.includes('alchemy.com')) {
        Logger.info(
            '⚡ MEMPOOL: Désactivé (nécessite un nœud Alchemy — configurez POLYGON_WS_URL=wss://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY)'
        );
        return;
    }

    Logger.info('⚡ MEMPOOL: Démarrage de la surveillance avant-bloc (Alchemy)...');
    startConfirmationTracker();
    await connectMempool(wsUrl, 5_000);
};

export default mempoolMonitor;
