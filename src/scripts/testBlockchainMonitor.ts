/**
 * TEST BLOCKCHAIN MONITOR — Script de debug autonome
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Ce script teste le monitoring blockchain SANS démarrer le bot complet.
 * Pas de MongoDB, pas de CLOB client, pas de trade execution.
 *
 * USAGE :
 *   npx ts-node src/scripts/testBlockchainMonitor.ts
 *
 * CE QUE ÇA TESTE :
 *   ✅ Connexion WebSocket au nœud Polygon
 *   ✅ Réception des events OrderFilled (TOUS les events, pas filtrés)
 *   ✅ Décodage : makerAssetId==0 → BUY, sinon SELL
 *   ✅ Calcul du prix depuis les amounts (÷ 10^6)
 *   ✅ Détection si un de NOS traders est impliqué
 *   ✅ Vérification que les adresses contrats sont correctes
 *
 * NIVEAUX DE LOG :
 *   MODE=all    → TOUS les OrderFilled events (peut être verbeux sur Polygon mainnet)
 *   MODE=tracked → seulement les events impliquant nos traders suivis (défaut)
 *   MODE=stats  → résumé toutes les 10s, sans détail
 *
 * VARIABLES D'ENV UTILISÉES :
 *   POLYGON_WS_URL  — URL WebSocket du nœud Polygon (requis)
 *   USER_ADDRESSES  — adresses des traders à surveiller (pour le filtre "tracked")
 *
 * DURÉE :
 *   Le script tourne 5 minutes puis s'arrête automatiquement.
 *   Ctrl+C pour stopper plus tôt.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { ethers } from 'ethers';

// ─── Contrats Polymarket ──────────────────────────────────────────────────────
const CTF_EXCHANGE      = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

const ORDER_FILLED_ABI = [
    'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
];

const TOKEN_DECIMALS = 6;
const BN_ZERO = ethers.BigNumber.from(0);

// ─── Config ───────────────────────────────────────────────────────────────────
const WS_URL = process.env.POLYGON_WS_URL || '';
// MODE : 'tracked' (défaut) | 'all' | 'stats'
// Peut être passé en argument CLI : ts-node testBlockchainMonitor.ts all
const MODE = (process.argv[2] || process.env.MODE || 'tracked') as 'all' | 'tracked' | 'stats';

const RAW_ADDRESSES = process.env.USER_ADDRESSES || '';
const TRACKED: Set<string> = new Set(
    RAW_ADDRESSES.split(',')
        .map(a => a.trim().replace(/'/g, '').toLowerCase())
        .filter(a => a.length > 0)
);

// ─── Compteurs globaux ────────────────────────────────────────────────────────
let totalEvents  = 0;     // tous les OrderFilled reçus
let trackedCount = 0;     // events impliquant nos traders
let buyCount     = 0;
let sellCount    = 0;
let lastBlock    = 0;
const startTime  = Date.now();

// ─── Helpers d'affichage ──────────────────────────────────────────────────────
const hr = (char = '─', len = 70) => char.repeat(len);

const log = (msg: string) => {
    const ts = new Date().toLocaleTimeString();
    console.log(`[${ts}] ${msg}`);
};

const logSection = (title: string) => {
    console.log('\n' + hr('═'));
    console.log(`  ${title}`);
    console.log(hr('═'));
};

// ─── Décodage event ───────────────────────────────────────────────────────────
interface DecodedEvent {
    maker:         string;
    taker:         string;
    makerAssetId:  string;    // décimal string ("0" = USDC)
    takerAssetId:  string;
    usdcSize:      number;
    tokenSize:     number;
    price:         number;
    fee:           number;
    side:          'BUY' | 'SELL';
    tokenId:       string;    // l'ID du token conditionnel
    trackedSide:   'maker' | 'taker' | null;
    trackedAddr:   string | null;
    exchange:      string;
    blockNumber:   number;
    txHash:        string;
}

const decodeEvent = (
    exchange: string,
    maker: string,
    taker: string,
    makerAssetId:      ethers.BigNumber,
    takerAssetId:      ethers.BigNumber,
    makerAmountFilled: ethers.BigNumber,
    takerAmountFilled: ethers.BigNumber,
    fee:               ethers.BigNumber,
    event: ethers.Event,
): DecodedEvent => {
    const makerLow = maker.toLowerCase();
    const takerLow = taker.toLowerCase();

    const isTrackedMaker = TRACKED.has(makerLow);
    const isTrackedTaker = TRACKED.has(takerLow);

    // Détermination du côté et du token conditionnel
    let side: 'BUY' | 'SELL';
    let tokenId: string;
    let usdcRaw: ethers.BigNumber;
    let tokenRaw: ethers.BigNumber;

    // Le "tracker" est toujours le maker si possible, sinon le taker
    if (isTrackedMaker || !isTrackedTaker) {
        if (makerAssetId.eq(BN_ZERO)) {
            side     = 'BUY';  // maker paie USDC → achète des tokens
            tokenId  = takerAssetId.toString();
            usdcRaw  = makerAmountFilled;
            tokenRaw = takerAmountFilled;
        } else {
            side     = 'SELL'; // maker donne des tokens → reçoit USDC
            tokenId  = makerAssetId.toString();
            usdcRaw  = takerAmountFilled;
            tokenRaw = makerAmountFilled;
        }
    } else {
        // taker est le trader suivi
        if (takerAssetId.eq(BN_ZERO)) {
            side     = 'BUY';  // taker paie USDC → achète des tokens
            tokenId  = makerAssetId.toString();
            usdcRaw  = takerAmountFilled;
            tokenRaw = makerAmountFilled;
        } else {
            side     = 'SELL'; // taker donne des tokens → reçoit USDC
            tokenId  = takerAssetId.toString();
            usdcRaw  = makerAmountFilled;
            tokenRaw = takerAmountFilled;
        }
    }

    const divisor   = 10 ** TOKEN_DECIMALS;
    const usdcSize  = usdcRaw.toNumber()  / divisor;
    const tokenSize = tokenRaw.toNumber() / divisor;
    const price     = tokenSize > 0 ? usdcSize / tokenSize : 0;
    const feeUsd    = fee.toNumber() / divisor;

    return {
        maker,
        taker,
        makerAssetId: makerAssetId.toString(),
        takerAssetId: takerAssetId.toString(),
        usdcSize,
        tokenSize,
        price,
        fee: feeUsd,
        side,
        tokenId,
        trackedSide:  isTrackedMaker ? 'maker' : isTrackedTaker ? 'taker' : null,
        trackedAddr:  isTrackedMaker ? maker : isTrackedTaker ? taker : null,
        exchange,
        blockNumber:  event.blockNumber,
        txHash:       event.transactionHash,
    };
};

// ─── Affichage d'un event ─────────────────────────────────────────────────────
const displayEvent = (d: DecodedEvent, isTracked: boolean) => {
    const sideIcon = d.side === 'BUY' ? '🟢 BUY ' : '🔴 SELL';
    const exLabel  = d.exchange === CTF_EXCHANGE ? 'CTF     ' : 'NegRisk ';

    if (isTracked) {
        // Affichage complet pour les traders suivis
        console.log('\n' + hr('─'));
        console.log(`  ⚡ TRADER SUIVI DÉTECTÉ !`);
        console.log(hr('─'));
        console.log(`  Adresse  : ${d.trackedAddr} (${d.trackedSide})`);
        console.log(`  Action   : ${sideIcon} | Exchange: ${exLabel}`);
        console.log(`  Montant  : ${d.tokenSize.toFixed(4)} tokens @ $${d.price.toFixed(4)}`);
        console.log(`  USDC     : $${d.usdcSize.toFixed(4)} | Fee: $${d.fee.toFixed(6)}`);
        console.log(`  Token ID : ${d.tokenId.slice(0, 20)}...`);
        console.log(`  Block    : #${d.blockNumber}`);
        console.log(`  Tx       : https://polygonscan.com/tx/${d.txHash}`);
        console.log('');

        // DEBUG — valeurs brutes pour vérifier le décodage
        console.log(`  [DEBUG RAW]`);
        console.log(`    maker         : ${d.maker}`);
        console.log(`    taker         : ${d.taker}`);
        console.log(`    makerAssetId  : ${d.makerAssetId} ${d.makerAssetId === '0' ? '← USDC (maker paie)' : '← token conditionnel'}`);
        console.log(`    takerAssetId  : ${d.takerAssetId} ${d.takerAssetId === '0' ? '← USDC (taker paie)' : '← token conditionnel'}`);
        console.log(hr('─'));
    } else {
        // Affichage compact pour les autres events
        const addr = `${d.maker.slice(0, 6)}...${d.maker.slice(-4)}`;
        log(`[${exLabel}] ${sideIcon} $${d.usdcSize.toFixed(2)} @ $${d.price.toFixed(4)} | maker:${addr} | block:#${d.blockNumber}`);
    }
};

// ─── Stats périodiques ────────────────────────────────────────────────────────
const printStats = () => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log('\n' + hr('·'));
    console.log(`  📊 STATS — ${elapsed}s de monitoring`);
    console.log(`  Events total : ${totalEvents}`);
    console.log(`  Nos traders  : ${trackedCount} (${buyCount} BUY, ${sellCount} SELL)`);
    console.log(`  Dernier block: #${lastBlock}`);
    console.log(hr('·'));
};

// ─── Connexion et écoute ──────────────────────────────────────────────────────
const run = async () => {
    // ── Validation config ────────────────────────────────────────────────────
    logSection('🔍 TEST BLOCKCHAIN MONITOR');

    console.log(`  POLYGON_WS_URL : ${WS_URL || '❌ ABSENT'}`);
    console.log(`  MODE           : ${MODE}`);
    console.log(`  Traders suivis : ${TRACKED.size}`);
    if (TRACKED.size > 0) {
        for (const addr of [...TRACKED].slice(0, 5)) {
            console.log(`    • ${addr}`);
        }
        if (TRACKED.size > 5) console.log(`    ... et ${TRACKED.size - 5} autres`);
    }
    console.log('');

    if (!WS_URL) {
        console.error('❌ POLYGON_WS_URL manquant dans .env');
        console.error('   Ajoutez : POLYGON_WS_URL=wss://polygon-bor-rpc.publicnode.com');
        process.exit(1);
    }

    // ── Connexion WebSocket ──────────────────────────────────────────────────
    log(`Connexion à ${WS_URL.split('/')[2]}...`);

    let provider: ethers.providers.WebSocketProvider;
    try {
        provider = new ethers.providers.WebSocketProvider(WS_URL);
        await provider.ready;
        const block = await provider.getBlockNumber();
        lastBlock = block;
        log(`✅ Connecté ! Dernier block Polygon : #${block}`);
    } catch (err) {
        console.error(`❌ Connexion échouée : ${(err as Error).message}`);
        console.error(`   Essayez : wss://polygon-bor-rpc.publicnode.com`);
        process.exit(1);
    }

    console.log('');
    log(`Écoute des events OrderFilled sur les 2 contrats Polymarket...`);
    if (MODE === 'all') {
        log(`⚠️  MODE=all : TOUS les events affichés (peut être très verbeux !)`);
    } else if (MODE === 'tracked') {
        log(`MODE=tracked : seulement les events impliquant nos ${TRACKED.size} trader(s)`);
        if (TRACKED.size === 0) {
            log(`⚠️  Aucun trader suivi dans USER_ADDRESSES — aucun event ne s'affichera !`);
        }
    } else {
        log(`MODE=stats : résumé toutes les 10s`);
    }
    log(`Ctrl+C pour stopper | Durée max : 5 minutes`);
    console.log('');

    // ── Abonnement events ────────────────────────────────────────────────────
    for (const [exchangeAddr, exchangeLabel] of [
        [CTF_EXCHANGE,      'CTFExchange'],
        [NEG_RISK_EXCHANGE, 'NegRiskExchange'],
    ] as [string, string][]) {
        const contract = new ethers.Contract(exchangeAddr, ORDER_FILLED_ABI, provider);

        contract.on('OrderFilled', (...args: unknown[]) => {
            const event = args[args.length - 1] as ethers.Event;
            const [, maker, taker, makerAssetId, takerAssetId, makerAmountFilled, takerAmountFilled, fee] = args as [
                string, string, string,
                ethers.BigNumber, ethers.BigNumber,
                ethers.BigNumber, ethers.BigNumber,
                ethers.BigNumber
            ];

            try {
                const d = decodeEvent(
                    exchangeAddr,
                    maker, taker,
                    makerAssetId, takerAssetId,
                    makerAmountFilled, takerAmountFilled,
                    fee,
                    event,
                );

                totalEvents++;
                lastBlock = Math.max(lastBlock, d.blockNumber);
                const isTracked = d.trackedSide !== null;

                if (isTracked) {
                    trackedCount++;
                    if (d.side === 'BUY') buyCount++; else sellCount++;
                }

                if (MODE === 'all') {
                    displayEvent(d, isTracked);
                } else if (MODE === 'tracked' && isTracked) {
                    displayEvent(d, true);
                }
                // MODE=stats : on compte seulement

            } catch (err) {
                log(`⚠️  Erreur décodage event [${exchangeLabel}]: ${(err as Error).message}`);
            }
        });

        log(`Abonné à ${exchangeLabel} (${exchangeAddr.slice(0, 10)}...)`);
    }

    // ── Stats périodiques (mode stats ou toutes les 30s) ─────────────────────
    const statsInterval = MODE === 'stats' ? 10_000 : 30_000;
    const statsTimer = setInterval(printStats, statsInterval);

    // ── Arrêt automatique après 5 minutes ────────────────────────────────────
    const MAX_DURATION = 5 * 60 * 1000;
    setTimeout(() => {
        clearInterval(statsTimer);
        printStats();
        log('⏱ Durée max atteinte (5 min) — arrêt automatique');
        provider.destroy();
        process.exit(0);
    }, MAX_DURATION);

    // ── Ctrl+C ───────────────────────────────────────────────────────────────
    process.on('SIGINT', () => {
        clearInterval(statsTimer);
        console.log('');
        printStats();
        log('👋 Arrêt (Ctrl+C)');
        try { provider.destroy(); } catch { /* silence */ }
        process.exit(0);
    });
};

run().catch(err => {
    console.error('Erreur fatale:', err);
    process.exit(1);
});
