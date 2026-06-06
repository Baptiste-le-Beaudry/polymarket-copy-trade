/**
 * src/services/telegramWhaleMonitor.ts
 *
 * Surveille les alertes whale Telegram et les affiche dans le terminal principal.
 * Démarre automatiquement si TELEGRAM_API_ID, TELEGRAM_API_HASH et TELEGRAM_PHONE sont définis.
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage } from 'telegram/events';
import type { NewMessageEvent } from 'telegram/events/NewMessage';
import Logger from '../utils/logger';
import fetchData from '../utils/fetchData';

// ─── Config ───────────────────────────────────────────────────────────────────

let client: TelegramClient | null = null;
let running = false;

// Mapping nom Telegram → adresse wallet (synchronisé avec telegram-monitor/)
const TRADER_MAP: Record<string, string> = {
    'Everything Trader Delta': '0x9d84ce0306f8551e02efef1680475fc0f1dc1344',
    'Everything Trader Beta':  '0x7744bfd749a70020d16a1fcbac1d064761c9999e',
    'Everything Trader Alpha': '0x90ed5bffbffbfc344aa1195572d89719a398b5bc',
    'Politics Trader Alpha':   '0x06ecb7e739f5455922ce57e83284f132c7f0f845',
    'Politics Trader Beta':    '0x253da8157571bae06d6cf750eeb1b26830a43307',
};

// ─── Parsing ──────────────────────────────────────────────────────────────────

function parseAlert(text: string): {
    traderName: string;
    traderAddress: string | null;
    action: 'BUY' | 'SELL';
    outcome: string;
    title: string;
    sizeUsd: number | null;
    priceUsd: number | null;
    marketSlug: string;
} | null {
    if (!text.includes('WHALE')) return null;

    const nameMatch   = text.match(/👤\s*(.+)/);
    const actionMatch = text.match(/[📈📉]\s*(BUY|SELL)\s+(\S+)/i);
    const titleMatch  = text.match(/📊\s*"(.+?)"/);
    const sizeMatch   = text.match(/💰\s*Size:\s*\$([0-9.,k]+)/i);
    const priceMatch  = text.match(/💲\s*Price:\s*(\d+(?:\.\d+)?)¢/);
    const urlMatch    = text.match(/https:\/\/polymarket\.com\/event\/([^\s)]+)/);

    if (!nameMatch || !actionMatch) return null;

    const traderName = nameMatch[1].trim();
    const action     = actionMatch[1].toUpperCase() as 'BUY' | 'SELL';
    const outcome    = actionMatch[2];

    let sizeUsd: number | null = null;
    if (sizeMatch) {
        const raw = sizeMatch[1].toLowerCase().replace(',', '');
        sizeUsd = raw.endsWith('k') ? parseFloat(raw) * 1000 : parseFloat(raw);
    }

    return {
        traderName,
        traderAddress: TRADER_MAP[traderName] ?? null,
        action,
        outcome,
        title:      titleMatch?.[1]  ?? '',
        sizeUsd,
        priceUsd:   priceMatch ? parseInt(priceMatch[1]) / 100 : null,
        marketSlug: urlMatch?.[1]    ?? '',
    };
}

// ─── Fetch prix actuel depuis Polymarket ─────────────────────────────────────

async function fetchCurrentPrice(eventSlug: string, outcome: string): Promise<{
    bid: number; ask: number; mid: number; tokenId: string;
} | null> {
    try {
        // Récupère l'event et ses marchés depuis la gamma-api
        const events = await fetchData(
            `https://gamma-api.polymarket.com/events?slug=${eventSlug}`
        ) as Array<{ markets?: Array<{
            outcomes?: string;
            clobTokenIds?: string;
            outcomePrices?: string;
            active?: boolean;
            closed?: boolean;
        }> }>;

        if (!Array.isArray(events) || events.length === 0) return null;

        const markets = events[0].markets ?? [];

        for (const market of markets) {
            if (!market.clobTokenIds || !market.outcomes) continue;
            // Ignorer les marchés fermés/résolus — leur book affiche bid=0.01 ask=0.99
            if (market.closed || market.active === false) continue;

            let outcomes: string[];
            let tokenIds: string[];

            try {
                outcomes = JSON.parse(market.outcomes);
                tokenIds = JSON.parse(market.clobTokenIds);
            } catch {
                continue;
            }

            // Cherche l'outcome correspondant (case-insensitive)
            const idx = outcomes.findIndex(o => o.toLowerCase() === outcome.toLowerCase());
            const tokenId = idx !== -1 ? tokenIds[idx] : tokenIds[0];
            if (!tokenId) continue;

            // Fetch le carnet d'ordres
            const bookData = await fetchData(
                `https://clob.polymarket.com/book?token_id=${tokenId}`
            ) as { bids: Array<{ price: string }>; asks: Array<{ price: string }> };

            if (bookData?.bids?.[0] && bookData?.asks?.[0]) {
                const bid = parseFloat(bookData.bids[0].price);
                const ask = parseFloat(bookData.asks[0].price);
                return { bid, ask, mid: (bid + ask) / 2, tokenId };
            }
        }
    } catch {
        // Non-bloquant
    }
    return null;
}

// ─── Handler message ──────────────────────────────────────────────────────────

function handleMessage(event: NewMessageEvent) {
    const text = event.message?.message ?? '';
    if (!text) return;

    const trade = parseAlert(text);
    if (!trade) return;

    const emoji  = trade.action === 'BUY' ? '📈' : '📉';
    const priceStr = trade.priceUsd ? ` @ ${(trade.priceUsd * 100).toFixed(0)}¢` : '';
    const sizeStr  = trade.sizeUsd  ? ` — $${trade.sizeUsd.toLocaleString()}`    : '';
    const wallet   = trade.traderAddress
        ? ` (${trade.traderAddress.slice(0, 6)}...${trade.traderAddress.slice(-4)})`
        : ' (adresse inconnue)';

    Logger.separator();
    Logger.info(`📱 TELEGRAM WHALE ${emoji} ${trade.traderName}${wallet}`);
    Logger.info(`   ${trade.action} ${trade.outcome}${priceStr}${sizeStr}`);
    if (trade.title)      Logger.info(`   "${trade.title}"`);
    if (trade.marketSlug) Logger.info(`   https://polymarket.com/event/${trade.marketSlug}`);

    // Fetch prix actuel en arrière-plan
    if (trade.marketSlug) {
        fetchCurrentPrice(trade.marketSlug, trade.outcome).then(price => {
            if (price) {
                const mid  = (price.mid * 100).toFixed(0);
                const bid  = (price.bid * 100).toFixed(0);
                const ask  = (price.ask * 100).toFixed(0);
                const traderPriceStr = trade.priceUsd
                    ? ` (trader: ${(trade.priceUsd * 100).toFixed(0)}¢)`
                    : '';
                Logger.info(`   💲 Prix actuel — bid ${bid}¢ / ask ${ask}¢ / mid ${mid}¢${traderPriceStr}`);
            } else {
                Logger.info('   💲 Prix actuel — indisponible');
            }
            Logger.separator();
        }).catch(() => {
            Logger.separator();
        });
    } else {
        Logger.separator();
    }
}

// ─── Démarrage ────────────────────────────────────────────────────────────────

export async function startTelegramWhaleMonitor(): Promise<void> {
    const API_ID   = parseInt(process.env.TELEGRAM_API_ID    || '0');
    const API_HASH = process.env.TELEGRAM_API_HASH            || '';
    const PHONE    = process.env.TELEGRAM_PHONE               || '';
    const SESSION  = process.env.TELEGRAM_SESSION             || '';
    const BOT_NAME = process.env.TELEGRAM_BOT_USERNAME        || '';

    if (!API_ID || !API_HASH || !PHONE) {
        Logger.warning('📱 Telegram whale monitor désactivé (TELEGRAM_API_ID/HASH/PHONE manquants)');
        return;
    }

    if (!SESSION) {
        Logger.warning('📱 Telegram whale monitor désactivé — TELEGRAM_SESSION manquant');
        Logger.warning('   Lance telegram-monitor/ séparément une 1ère fois pour obtenir la session');
        return;
    }

    try {
        const session = new StringSession(SESSION);
        client = new TelegramClient(session, API_ID, API_HASH, {
            connectionRetries: 5,
        });

        // client.start() valide la session existante (contrairement à connect() qui ne l'authentifie pas).
        // Si la session est expirée, le callback phoneCode throw → capturé par le catch.
        await client.start({
            phoneNumber: async () => PHONE,
            phoneCode: async () => {
                Logger.warning('📱 Telegram: session expirée — relance telegram-monitor/ pour re-authentifier');
                throw new Error('Session expirée');
            },
            password: async () => { throw new Error('2FA requis'); },
            onError: (err) => Logger.warning(`📱 Telegram auth error: ${err.message}`),
        });

        running = true;

        // Filtrer sur le bot whale si configuré
        if (BOT_NAME) {
            try {
                const entity = await client.getEntity(BOT_NAME);
                const chatId = (entity as any).id;
                client.addEventHandler(handleMessage, new NewMessage({ chats: [chatId] }));
                Logger.success(`📱 Telegram whale monitor actif — écoute ${BOT_NAME}`);
            } catch {
                Logger.warning(`📱 Telegram: bot "${BOT_NAME}" introuvable — écoute tous les messages`);
                client.addEventHandler(handleMessage, new NewMessage({}));
            }
        } else {
            Logger.success('📱 Telegram whale monitor actif — écoute tous les messages');
            client.addEventHandler(handleMessage, new NewMessage({}));
        }

    } catch (err) {
        Logger.warning(`📱 Telegram whale monitor — connexion échouée: ${(err as Error).message}`);
        client = null;
        running = false;
    }
}

export async function stopTelegramWhaleMonitor(): Promise<void> {
    if (client && running) {
        try {
            await client.disconnect();
        } catch {
            // ignore
        }
        running = false;
        client = null;
    }
}
