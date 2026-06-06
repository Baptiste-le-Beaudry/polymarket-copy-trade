/**
 * BLOCKCHAIN MONITOR — Détection ultra-rapide des trades on-chain
 * ═══════════════════════════════════════════════════════════════════════
 *
 * POURQUOI ce module existe :
 *   Avec le polling REST classique, la latence totale est 17-65 secondes :
 *     Trader achète → Polygon mine la tx (~2s) → Polymarket indexe (~15-60s)
 *     → notre fetch cycle (~2-3s) → exécution
 *
 *   Avec ce module WebSocket blockchain, on court-circuite l'indexation :
 *     Trader achète → Polygon mine la tx (~2s) → notre listener reçoit l'event
 *     → on décode depuis la blockchain → on écrit en MongoDB directement
 *     → executor exécute en 200ms → TOTAL: ~3s (6 à 20x plus rapide)
 *
 * COMMENT ça marche :
 *   Polymarket utilise deux contrats sur Polygon mainnet :
 *     - CTFExchange     (0x4bFb...) : marchés standards YES/NO
 *     - NegRiskExchange (0xC5d5...) : marchés NegRisk (multi-outcome)
 *
 *   Chaque fois qu'un order est rempli, ces contrats émettent :
 *     event OrderFilled(
 *       bytes32 indexed orderHash,
 *       address indexed maker,        ← celui qui avait l'order en carnet
 *       address indexed taker,        ← celui qui a rempli l'order
 *       uint256 makerAssetId,         ← 0 = USDC (maker paie), ≠ 0 = token conditionnel
 *       uint256 takerAssetId,         ← 0 = USDC (taker paie), ≠ 0 = token conditionnel
 *       uint256 makerAmountFilled,
 *       uint256 takerAmountFilled,
 *       uint256 fee
 *     )
 *
 *   Règle de décodage (assetId == 0 ↔ USDC, le "côté argent") :
 *     maker est notre trader ET makerAssetId == 0  → BUY (il paie USDC)
 *     maker est notre trader ET makerAssetId != 0  → SELL (il donne des tokens)
 *     taker est notre trader ET takerAssetId == 0  → BUY (il paie USDC)
 *     taker est notre trader ET takerAssetId != 0  → SELL (il donne des tokens)
 *
 * CONFIGURATION :
 *   Ajoutez POLYGON_WS_URL dans .env :
 *     Public gratuit   : wss://polygon-bor-rpc.publicnode.com
 *     Alchemy (recommandé) : wss://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
 *   Si POLYGON_WS_URL est absent, ce module est désactivé silencieusement.
 *   Le bot continue avec le polling REST classique (double filet de sécurité).
 *
 * DÉDUPLICATION :
 *   Les trades synthétiques sont sauvegardés avec transactionHash = txHash.
 *   Quand l'API Polymarket indexe enfin le trade (15-60s plus tard),
 *   processOneTrader() trouve transactionHash déjà en DB et l'ignore.
 *   Aucune double exécution possible.
 */

import { ethers } from 'ethers';
import { ENV } from '../config/env';
import Logger from '../utils/logger';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTES — Contrats Polymarket sur Polygon mainnet
// Source : @polymarket/clob-client/dist/config.js (MATIC_CONTRACTS)
// ═══════════════════════════════════════════════════════════════════════
const CTF_EXCHANGE      = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

/**
 * ABI minimal — uniquement l'event OrderFilled.
 * makerAssetId / takerAssetId = 0  ↔ USDC (collatéral, "côté argent")
 * makerAssetId / takerAssetId != 0 ↔ token conditionnel ERC-1155 (le "pari")
 */
const ORDER_FILLED_ABI = [
    'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
];

/**
 * USDC et tokens conditionnels Polymarket = 6 décimales.
 * Source : @polymarket/clob-client (COLLATERAL_TOKEN_DECIMALS = CONDITIONAL_TOKEN_DECIMALS = 6)
 */
const TOKEN_DECIMALS = 6;

/** BigNumber zéro — représente le côté USDC dans les events (ethers v5) */
const BN_ZERO = ethers.BigNumber.from(0);

// ═══════════════════════════════════════════════════════════════════════
// INDEX DES TRADERS SUIVIS (lookup O(1))
// ═══════════════════════════════════════════════════════════════════════

/** Adresses en minuscules pour comparaison rapide */
const trackedSet = new Set(ENV.USER_ADDRESSES.map(a => a.toLowerCase()));

/** Minuscule → forme originale (pour les requêtes MongoDB) */
const addressMap = new Map(ENV.USER_ADDRESSES.map(a => [a.toLowerCase(), a]));

/** Modèles MongoDB par adresse (instanciés une seule fois au démarrage) */
const userModels = ENV.USER_ADDRESSES.map(address => ({
    address,
    UserActivity: getUserActivityModel(address),
    UserPosition: getUserPositionModel(address),
}));

// ═══════════════════════════════════════════════════════════════════════
// CACHE conditionId (tokenId → infos marché)
// Evite des appels API répétés pour les mêmes marchés
// ═══════════════════════════════════════════════════════════════════════
interface MarketInfo {
    conditionId: string;
    title?:     string;
    slug?:      string;
    eventSlug?: string;
}
const marketCache = new Map<string, MarketInfo>();

/**
 * Pré-charge le cache au démarrage depuis les positions MongoDB.
 * Les marchés déjà connus (positions existantes des traders) auront un lookup instantané.
 * Appelé une seule fois avant connect().
 */
const preloadMarketCache = async (): Promise<void> => {
    let count = 0;
    for (const { UserPosition } of userModels) {
        const positions = await UserPosition.find(
            {},
            { asset: 1, conditionId: 1, title: 1, slug: 1, eventSlug: 1, _id: 0 }
        ).lean().exec() as Array<{ asset?: string; conditionId?: string; title?: string; slug?: string; eventSlug?: string }>;

        for (const pos of positions) {
            if (pos.asset && pos.conditionId) {
                marketCache.set(pos.asset, {
                    conditionId: pos.conditionId,
                    title:       pos.title,
                    slug:        pos.slug,
                    eventSlug:   pos.eventSlug,
                });
                count++;
            }
        }
    }
    if (count > 0) {
        Logger.info(`⚡ BLOCKCHAIN: Cache pré-chargé — ${count} marché(s) connu(s)`);
    }
};

/**
 * Résoudre tokenId (ERC-1155 conditionnel) → conditionId + métadonnées.
 *
 * Stratégie en 3 couches (du plus rapide au plus lent) :
 *  1. Cache mémoire           — instantané
 *  2. MongoDB positions       — positions déjà connues contiennent asset → conditionId
 *  3. Gamma API               — lookup distant pour les nouveaux marchés inconnus
 *
 * Retourne null si introuvable. Le trade est quand même créé avec conditionId vide.
 */
const lookupMarketInfo = async (tokenId: string): Promise<MarketInfo | null> => {
    // 1. Cache mémoire
    const cached = marketCache.get(tokenId);
    if (cached) return cached;

    // 2. MongoDB positions (nos données de positions stockent asset → conditionId)
    for (const { UserPosition } of userModels) {
        const pos = await UserPosition.findOne({ asset: tokenId }).exec();
        if (pos?.conditionId) {
            const info: MarketInfo = {
                conditionId: pos.conditionId,
                title:       pos.title       || undefined,
                slug:        pos.slug        || undefined,
                eventSlug:   pos.eventSlug   || undefined,
            };
            marketCache.set(tokenId, info);
            return info;
        }
    }

    // 3. Gamma API — fallback pour les nouveaux marchés jamais vus
    try {
        const data = await fetchData(
            `https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}`
        ) as Array<{ conditionId?: string; title?: string; slug?: string; eventSlug?: string }>;

        if (Array.isArray(data) && data.length > 0 && data[0].conditionId) {
            const info: MarketInfo = {
                conditionId: data[0].conditionId,
                title:       data[0].title     || undefined,
                slug:        data[0].slug      || undefined,
                eventSlug:   data[0].eventSlug || undefined,
            };
            marketCache.set(tokenId, info);
            return info;
        }
    } catch {
        // Non-bloquant — on continue sans conditionId
    }

    return null;
};

// ═══════════════════════════════════════════════════════════════════════
// DÉCODAGE DE L'EVENT OrderFilled
// ═══════════════════════════════════════════════════════════════════════
interface DecodedTrade {
    trackedAddress: string;  // Adresse originale (casse préservée) du trader suivi
    tokenId:        string;  // ERC-1155 token conditionnel (décimal sous forme string)
    side:           'BUY' | 'SELL';
    usdcSize:       number;  // Montant USDC humain (déjà divisé par 10^6)
    tokenSize:      number;  // Nombre de tokens (déjà divisé par 10^6)
    price:          number;  // Prix par token = usdcSize / tokenSize
    txHash:         string;  // Hash de la transaction Polygon
}

/**
 * Décode un event OrderFilled et retourne les infos si un trader suivi est impliqué.
 * Retourne null si aucune adresse suivie n'apparaît dans l'event.
 *
 * Règle fondamentale :
 *   assetId == 0  → USDC (l'argent, le collatéral)
 *   assetId != 0  → token conditionnel ERC-1155 (le "pari")
 *
 * Note : les montants sont des ethers.BigNumber (v5) — on utilise .isZero() et .toNumber()
 */
const decodeTrade = (
    maker: string,
    taker: string,
    makerAssetId:      ethers.BigNumber,
    takerAssetId:      ethers.BigNumber,
    makerAmountFilled: ethers.BigNumber,
    takerAmountFilled: ethers.BigNumber,
    txHash: string,
): DecodedTrade | null => {
    const makerLow = maker.toLowerCase();
    const takerLow = taker.toLowerCase();

    const isTrackedMaker = trackedSet.has(makerLow);
    const isTrackedTaker = trackedSet.has(takerLow);
    if (!isTrackedMaker && !isTrackedTaker) return null;

    let trackedAddress: string;
    let tokenId: string;
    let side: 'BUY' | 'SELL';
    let usdcRaw: ethers.BigNumber;
    let tokenRaw: ethers.BigNumber;

    if (isTrackedMaker) {
        trackedAddress = addressMap.get(makerLow)!;

        if (makerAssetId.eq(BN_ZERO)) {
            // Maker paie USDC → il ACHÈTE des tokens conditionnels
            side     = 'BUY';
            tokenId  = takerAssetId.toString();
            usdcRaw  = makerAmountFilled;
            tokenRaw = takerAmountFilled;
        } else {
            // Maker fournit des tokens → il VEND des tokens conditionnels
            side     = 'SELL';
            tokenId  = makerAssetId.toString();
            usdcRaw  = takerAmountFilled;
            tokenRaw = makerAmountFilled;
        }
    } else {
        // isTrackedTaker
        trackedAddress = addressMap.get(takerLow)!;

        if (takerAssetId.eq(BN_ZERO)) {
            // Taker paie USDC → il ACHÈTE des tokens conditionnels
            side     = 'BUY';
            tokenId  = makerAssetId.toString();
            usdcRaw  = takerAmountFilled;
            tokenRaw = makerAmountFilled;
        } else {
            // Taker fournit des tokens → il VEND des tokens conditionnels
            side     = 'SELL';
            tokenId  = takerAssetId.toString();
            usdcRaw  = makerAmountFilled;
            tokenRaw = takerAmountFilled;
        }
    }

    const divisor  = 10 ** TOKEN_DECIMALS;
    const usdcSize = usdcRaw.toNumber()  / divisor;
    const tokenSize = tokenRaw.toNumber() / divisor;
    const price    = tokenSize > 0 ? usdcSize / tokenSize : 0;

    return { trackedAddress, tokenId, side, usdcSize, tokenSize, price, txHash };
};

// ═══════════════════════════════════════════════════════════════════════
// SAUVEGARDE DU TRADE SYNTHÉTIQUE EN MONGODB
// Contourne complètement l'API Polymarket.
// L'executor le voit dans les 200ms suivantes.
// ═══════════════════════════════════════════════════════════════════════

/** Compteur de trades détectés via blockchain (pour les logs) */
let blockchainTradeCount = 0;

/** État de connexion WebSocket courant (mis à jour par connect()) */
let wsConnected = false;
let wsEffectiveUrl = '';

// ═══════════════════════════════════════════════════════════════════════
// CALLBACK DIRECT → EXECUTOR (bypass MongoDB poll, -150ms de latence)
// Plutôt que d'attendre que l'executor lise MongoDB toutes les 50ms,
// on l'appelle directement dès que le trade est inséré.
// ═══════════════════════════════════════════════════════════════════════
export interface BlockchainTradePayload {
    _id:            any;            // MongoDB ObjectId — passé directement pour éviter un 2e round-trip
    trackedAddress: string;
    tokenId:        string;
    side:           'BUY' | 'SELL';
    usdcSize:       number;
    tokenSize:      number;
    price:          number;
    txHash:         string;
    conditionId:    string;
    title:          string;
    slug:           string;
    eventSlug:      string;
    timestamp:      number;
}

type OnTradeCallback = (payload: BlockchainTradePayload) => void;
let _onTradeCallback: OnTradeCallback | null = null;

/** Enregistre le handler appelé immédiatement à chaque nouveau trade on-chain */
export const setOnNewBlockchainTrade = (cb: OnTradeCallback): void => {
    _onTradeCallback = cb;
};

const saveSyntheticTrade = async (decoded: DecodedTrade): Promise<void> => {
    const { trackedAddress, tokenId, side, usdcSize, tokenSize, price, txHash } = decoded;

    const UserActivity = getUserActivityModel(trackedAddress);
    const nowSec = Math.floor(Date.now() / 1000);

    // ─── CHEMIN CRITIQUE (rapide) ─────────────────────────────────────────────
    // Lookup cache mémoire + MongoDB seulement. La Gamma API (~500ms) est
    // déportée en arrière-plan APRÈS la sauvegarde pour ne pas bloquer l'executor.
    let marketInfo = marketCache.get(tokenId) ?? null;
    if (!marketInfo) {
        for (const { UserPosition } of userModels) {
            const pos = await UserPosition.findOne(
                { asset: tokenId },
                { conditionId: 1, title: 1, slug: 1, eventSlug: 1, _id: 0 }
            ).lean().exec() as { conditionId?: string; title?: string; slug?: string; eventSlug?: string } | null;
            if (pos?.conditionId) {
                marketInfo = {
                    conditionId: pos.conditionId,
                    title:       pos.title     || undefined,
                    slug:        pos.slug      || undefined,
                    eventSlug:   pos.eventSlug || undefined,
                };
                marketCache.set(tokenId, marketInfo);
                break;
            }
        }
    }

    // Upsert avec $setOnInsert : atomique, 1 seul aller MongoDB au lieu de findOne + save.
    // Si txHash déjà présent (event reçu en double) → upsertedCount = 0, on sort.
    //
    // OPTIMISATION LATENCE : botExcutedTime: 1 dès l'insertion (pre-claimed).
    // → L'executor callback n'a plus besoin d'un 2e round-trip MongoDB pour le claim.
    // → Le poll MongoDB (readTempTrades filtre botExcutedTime: 0) ne verra pas ce trade.
    //   Seul le callback direct le traite — le poll reste le filet de sécurité pour les trades REST.
    const result = await UserActivity.updateOne(
        { transactionHash: txHash },
        {
            $setOnInsert: {
                proxyWallet:     trackedAddress,
                timestamp:       nowSec,
                conditionId:     marketInfo?.conditionId ?? '',
                type:            'TRADE',
                size:            tokenSize,
                usdcSize:        usdcSize,
                transactionHash: txHash,
                price:           price,
                asset:           tokenId,
                side:            side,
                title:           marketInfo?.title    ?? `Token ${tokenId.slice(0, 16)}...`,
                slug:            marketInfo?.slug     ?? '',
                eventSlug:       marketInfo?.eventSlug ?? '',
                name:            '__blockchain__',
                bot:             false,
                botExcutedTime:  1, // Pre-claimed : évite le 2e round-trip MongoDB dans l'executor
            },
        },
        { upsert: true }
    ).exec();

    if (result.upsertedCount === 0) return; // Déjà en DB (event dupliqué)

    blockchainTradeCount++;

    // ─── CALLBACK DIRECT → executor réagit immédiatement (évite le poll MongoDB) ─
    // _id passé dans le payload pour que l'executor construise TradeWithUser sans fetch DB.
    if (_onTradeCallback) {
        _onTradeCallback({
            _id:         result.upsertedId, // MongoDB ObjectId du document inséré
            trackedAddress,
            tokenId,
            side,
            usdcSize,
            tokenSize,
            price,
            txHash,
            conditionId: marketInfo?.conditionId ?? '',
            title:       marketInfo?.title    ?? `Token ${tokenId.slice(0, 16)}...`,
            slug:        marketInfo?.slug     ?? '',
            eventSlug:   marketInfo?.eventSlug ?? '',
            timestamp:   nowSec,
        });
    }

    // ─── ARRIÈRE-PLAN : Gamma API pour les nouveaux marchés inconnus ──────────
    // Trade déjà en DB → executor peut réagir immédiatement (~50ms plus tôt).
    // On enrichit conditionId/title quand la réponse Gamma arrive (~500ms après).
    if (!marketInfo) {
        fetchData(`https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}`)
            .then((data: unknown) => {
                const arr = data as Array<{ conditionId?: string; title?: string; slug?: string; eventSlug?: string }>;
                if (Array.isArray(arr) && arr.length > 0 && arr[0].conditionId) {
                    const info: MarketInfo = {
                        conditionId: arr[0].conditionId,
                        title:       arr[0].title     || undefined,
                        slug:        arr[0].slug      || undefined,
                        eventSlug:   arr[0].eventSlug || undefined,
                    };
                    marketCache.set(tokenId, info);
                    UserActivity.updateOne(
                        { transactionHash: txHash },
                        { $set: { conditionId: info.conditionId, title: info.title ?? '', slug: info.slug ?? '', eventSlug: info.eventSlug ?? '' } }
                    ).exec().catch(() => {});
                }
            })
            .catch(() => {});
    }
};

// ═══════════════════════════════════════════════════════════════════════
// CONNEXION WEBSOCKET AVEC RECONNEXION AUTOMATIQUE (ethers v5)
// ═══════════════════════════════════════════════════════════════════════
let isMonitorRunning = true;

/**
 * Abonne le provider aux events OrderFilled des deux contrats.
 * Appelé à chaque reconnexion (les abonnements ne survivent pas aux déconnexions).
 */
const subscribeToEvents = (provider: ethers.providers.WebSocketProvider): void => {
    for (const exchangeAddr of [CTF_EXCHANGE, NEG_RISK_EXCHANGE]) {
        const contract      = new ethers.Contract(exchangeAddr, ORDER_FILLED_ABI, provider);
        const exchangeLabel = exchangeAddr === CTF_EXCHANGE ? 'CTFExchange' : 'NegRiskExchange';

        // En ethers v5, le callback reçoit (...args, event) — on prend tout via rest args
        contract.on('OrderFilled', async (...args: unknown[]) => {
            // Le dernier argument est l'objet event (ethers v5)
            const event = args[args.length - 1] as ethers.Event;
            const [, maker, taker, makerAssetId, takerAssetId, makerAmountFilled, takerAmountFilled] = args as [
                string, string, string,
                ethers.BigNumber, ethers.BigNumber,
                ethers.BigNumber, ethers.BigNumber,
                ethers.BigNumber
            ];

            try {
                const decoded = decodeTrade(
                    maker, taker,
                    makerAssetId, takerAssetId,
                    makerAmountFilled, takerAmountFilled,
                    event.transactionHash
                );
                if (!decoded) return; // Pas un trader suivi

                await saveSyntheticTrade(decoded);

            } catch (err) {
                Logger.error(`⚡ BLOCKCHAIN: Erreur traitement event: ${(err as Error).message}`);
            }
        });
    }

    Logger.info(`⚡ BLOCKCHAIN: Abonné aux OrderFilled de CTFExchange + NegRiskExchange`);
};

/**
 * Connexion au nœud Polygon avec reconnexion exponentielle.
 * En cas d'échec : délai doublé à chaque tentative (5s → 10s → 20s → ... → 60s max).
 */
const connect = async (wsUrl: string, retryDelayMs = 5_000): Promise<void> => {
    if (!isMonitorRunning) return;

    let provider: ethers.providers.WebSocketProvider | null = null;
    let healthCheckInterval: NodeJS.Timeout | null = null;

    try {
        Logger.info(`⚡ BLOCKCHAIN: Connexion à ${wsUrl.split('/')[2] ?? wsUrl}...`);
        provider = new ethers.providers.WebSocketProvider(wsUrl);

        // Intercepte les réponses HTTP non-101 (ex: 429 rate limit) avant ethers.js
        // La bibliothèque `ws` émet 'unexpected-response' pour les codes != 101
        // Si non intercepté → uncaught exception qui tue le process entier
        const rawWs = (provider as any)._websocket;
        if (rawWs && typeof rawWs.on === 'function') {
            rawWs.on('unexpected-response', (_req: unknown, res: { statusCode: number }) => {
                try { provider?.destroy(); } catch { /* silence */ }
                const nextDelay = Math.min(retryDelayMs * 2, 60_000);
                Logger.warning(
                    `⚡ BLOCKCHAIN: WebSocket refusé (HTTP ${res.statusCode}) ` +
                    `— retry dans ${nextDelay / 1000}s`
                );
                if (isMonitorRunning) setTimeout(() => connect(wsUrl, nextDelay), nextDelay);
            });
        }

        // Attend que le WebSocket soit établi avec un timeout de 15s.
        // Sans timeout, ethers.js v5 peut bloquer indéfiniment si le serveur
        // accepte la connexion WebSocket (101) mais ne répond pas à eth_chainId.
        await Promise.race([
            provider.ready,
            new Promise<never>((_, reject) =>
                setTimeout(
                    () => reject(new Error('provider.ready timeout après 15s — nœud lent ou non-Polygon')),
                    15_000
                )
            ),
        ]);

        wsConnected = true;
        Logger.success(
            `⚡ BLOCKCHAIN: Connecté à Polygon — ` +
            `surveillance de ${ENV.USER_ADDRESSES.length} trader(s)`
        );

        subscribeToEvents(provider);

        /**
         * Ping de santé toutes les 30s.
         * Détecte les coupures "silencieuses" où le WebSocket reste ouvert
         * mais ne reçoit plus d'events (split-brain).
         */
        healthCheckInterval = setInterval(async () => {
            try {
                await provider!.getBlockNumber();
            } catch {
                wsConnected = false;
                Logger.warning(`⚡ BLOCKCHAIN: Ping échoué — reconnexion...`);
                clearInterval(healthCheckInterval!);
                try { provider?.destroy(); } catch { /* silence */ }
                if (isMonitorRunning) setTimeout(() => connect(wsUrl, 5_000), 5_000);
            }
        }, 30_000);

        // Reset du délai de reconnexion après connexion réussie
        retryDelayMs = 5_000;

    } catch (error) {
        wsConnected = false;
        if (healthCheckInterval) clearInterval(healthCheckInterval);
        try { provider?.destroy(); } catch { /* silence */ }

        const nextDelay = Math.min(retryDelayMs * 2, 60_000);
        Logger.error(
            `⚡ BLOCKCHAIN: Connexion échouée (${(error as Error).message}) ` +
            `— retry dans ${nextDelay / 1000}s`
        );
        if (isMonitorRunning) {
            setTimeout(() => connect(wsUrl, nextDelay), nextDelay);
        }
    }
};

// ═══════════════════════════════════════════════════════════════════════
// API PUBLIQUE
// ═══════════════════════════════════════════════════════════════════════

/** Retourne l'état courant de la connexion blockchain (utilisé pour l'affichage périodique) */
export const getBlockchainStatus = (): { connected: boolean; tradeCount: number; url: string } => ({
    connected: wsConnected,
    tradeCount: blockchainTradeCount,
    url: wsEffectiveUrl,
});

/** Arrête proprement le monitoring (appelé depuis gracefulShutdown dans index.ts) */
export const stopBlockchainMonitor = (): void => {
    isMonitorRunning = false;
    Logger.info(
        `⚡ BLOCKCHAIN: Arrêt (${blockchainTradeCount} trade(s) détecté(s) cette session)`
    );
};

/**
 * Redémarre le blockchain monitor après une erreur interne (ex: bug ethers.js v5 callback).
 * Remet isMonitorRunning à true et reconnecte le WebSocket.
 */
export const restartBlockchainMonitor = (): void => {
    isMonitorRunning = true;
    const wsUrl = ENV.POLYGON_WS_URL;
    if (wsUrl) {
        Logger.info('⚡ BLOCKCHAIN: Redémarrage après erreur interne...');
        connect(wsUrl, 5_000).catch(err =>
            Logger.error(`⚡ BLOCKCHAIN: Erreur au redémarrage: ${(err as Error).message}`)
        );
    }
};

/**
 * Point d'entrée principal du blockchain monitor.
 *
 * Si POLYGON_WS_URL n'est pas configuré → désactivé silencieusement.
 * Le bot continue de fonctionner uniquement avec le polling REST.
 */
const blockchainMonitor = async (): Promise<void> => {
    const wsUrl = ENV.POLYGON_WS_URL;

    // Fallback automatique vers le nœud public si POLYGON_WS_URL non configuré
    const effectiveUrl = wsUrl || 'wss://polygon-bor-rpc.publicnode.com';
    wsEffectiveUrl = effectiveUrl;

    if (!wsUrl) {
        Logger.info('⚡ BLOCKCHAIN: POLYGON_WS_URL absent — nœud public utilisé (wss://polygon-bor-rpc.publicnode.com)');
        Logger.info('⚡ BLOCKCHAIN: Pour plus de fiabilité, configurez POLYGON_WS_URL=wss://... dans .env');
    }

    // Pré-charger le cache marchés → lookupMarketInfo instantané pour les traders déjà suivis
    await preloadMarketCache();

    await connect(effectiveUrl, 5_000);
};

export default blockchainMonitor;
