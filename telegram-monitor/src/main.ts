/**
 * telegram-monitor/src/main.ts
 *
 * Surveille les alertes Telegram d'un bot whale (ex: Prediction Radar)
 * et vérifie en temps réel si le copy bot détecte et copie le trade.
 *
 * Usage :
 *   cd telegram-monitor && npm install && npm start
 *
 * Première utilisation : le script demande le code SMS reçu sur ton téléphone.
 * Ensuite, copie la TELEGRAM_SESSION affichée dans le .env pour éviter
 * de te reconnecter à chaque fois.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import dotenv from 'dotenv';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage } from 'telegram/events';
import type { NewMessageEvent } from 'telegram/events/NewMessage';
import mongoose, { Schema } from 'mongoose';

// ─── Config ───────────────────────────────────────────────────────────────────

dotenv.config({ path: path.join(__dirname, '../../.env') });

const API_ID    = parseInt(process.env.TELEGRAM_API_ID    || '0');
const API_HASH  = process.env.TELEGRAM_API_HASH           || '';
const PHONE     = process.env.TELEGRAM_PHONE              || '';
const SESSION   = process.env.TELEGRAM_SESSION            || '';
const BOT_NAME  = process.env.TELEGRAM_BOT_USERNAME       || ''; // ex: PredictionRadarBot
const MONGO_URI = process.env.MONGO_URI                   || '';

if (!API_ID || !API_HASH || !PHONE) {
    console.error('❌ Manque TELEGRAM_API_ID, TELEGRAM_API_HASH ou TELEGRAM_PHONE dans .env');
    console.error('   Voir : https://my.telegram.org/apps');
    process.exit(1);
}

// ─── Mapping nom Telegram → adresse wallet ────────────────────────────────────

const TRADER_MAP: Record<string, string> = {
    'Everything Trader Delta': '0x9d84ce0306f8551e02efef1680475fc0f1dc1344', // ImJustKen
    'Everything Trader Beta':  '0x7744bfd749a70020d16a1fcbac1d064761c9999e', // chungguskhan
    'Everything Trader Alpha': '0x90ed5bffbffbfc344aa1195572d89719a398b5bc', // failstober
    'Politics Trader Alpha':   '0x06ecb7e739f5455922ce57e83284f132c7f0f845', // Frosen
    'Politics Trader Beta':    '0x253da8157571bae06d6cf750eeb1b26830a43307', // Dimpled-Pizza
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface WhaleTrade {
    traderName:    string;
    traderAddress: string | null;
    action:        'BUY' | 'SELL';
    outcome:       string;
    title:         string;
    sizeUsd:       number | null;
    priceUsd:      number | null;
    marketSlug:    string;
    detectedAt:    number; // ms
}

// ─── MongoDB ──────────────────────────────────────────────────────────────────

const activitySchema = new Schema({
    proxyWallet:     String,
    timestamp:       Number,
    transactionHash: String,
    price:           Number,
    side:            String,
    eventSlug:       String,
    slug:            String,
    bot:             Boolean,
    botExcutedTime:  Number,
    executedAt:      Number,
}, { strict: false });

const getActivityModel = (address: string) => {
    const name = `user_activities_${address}`;
    return mongoose.models[name] || mongoose.model(name, activitySchema, name);
};

async function connectMongo() {
    if (!MONGO_URI) {
        console.warn('⚠️  MONGO_URI absent — vérification MongoDB désactivée');
        return false;
    }
    await mongoose.connect(MONGO_URI);
    console.log('✅ MongoDB connecté');
    return true;
}

// ─── Parsing message Telegram ────────────────────────────────────────────────

function parseAlert(text: string): WhaleTrade | null {
    // Le message doit contenir 🐋 WHALE ALERT ou WHALE
    if (!text.includes('WHALE')) return null;

    const nameMatch  = text.match(/👤\s*(.+)/);
    // 📈 BUY Yes  ou  📉 SELL No  (avec ou sans emoji)
    const actionMatch = text.match(/[📈📉]\s*(BUY|SELL)\s+(\S+)/i);
    const titleMatch  = text.match(/📊\s*"(.+?)"/);
    // 💰 Size: $3.2k  ou  $220  ou  $1.1k
    const sizeMatch   = text.match(/💰\s*Size:\s*\$([0-9.,k]+)/i);
    // 💲 Price: 84¢  ou  73¢
    const priceMatch  = text.match(/💲\s*Price:\s*(\d+(?:\.\d+)?)¢/);
    // URL marché
    const urlMatch    = text.match(/https:\/\/polymarket\.com\/event\/([^\s)]+)/);

    if (!nameMatch || !actionMatch) return null;

    const traderName = nameMatch[1].trim();
    const action     = actionMatch[1].toUpperCase() as 'BUY' | 'SELL';
    const outcome    = actionMatch[2];

    // Convertir taille : "3.2k" → 3200, "220" → 220
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
        detectedAt: Date.now(),
    };
}

// ─── Surveillance MongoDB ─────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2_000;   // vérifier toutes les 2s
const TIMEOUT_MS       = 120_000; // abandonner après 2 min

async function waitForBotDetection(trade: WhaleTrade, mongoOk: boolean): Promise<void> {
    if (!mongoOk || !trade.traderAddress) return;

    const Model    = getActivityModel(trade.traderAddress);
    const startMs  = Date.now();
    const tradeSec = Math.floor(trade.detectedAt / 1000);

    console.log(`   🔍 Surveillance MongoDB pour ${trade.traderName} (${TIMEOUT_MS / 1000}s max)...`);

    return new Promise((resolve) => {
        const interval = setInterval(async () => {
            try {
                // Cherche un document récent (≤ 120s avant l'alerte Telegram) avec botExcutedTime = 0
                const doc = await Model.findOne({
                    timestamp:      { $gte: tradeSec - 120 },
                    side:           trade.action === 'BUY' ? 'BUY' : 'SELL',
                    botExcutedTime: 0,
                }).lean().exec();

                if (doc) {
                    const delayBot  = ((Date.now() - startMs) / 1000).toFixed(1);
                    const delayTotal = ((Date.now() - trade.detectedAt) / 1000).toFixed(1);
                    console.log(`   ✅ BOT A DÉTECTÉ le trade en ${delayBot}s après alerte Telegram`);
                    console.log(`   ⏱  Délai total trader→bot: ~${delayTotal}s`);
                    clearInterval(interval);
                    resolve();
                    return;
                }

                // Aussi vérifier si le trade a été exécuté (botExcutedTime > 0)
                const executed = await Model.findOne({
                    timestamp:      { $gte: tradeSec - 120 },
                    side:           trade.action === 'BUY' ? 'BUY' : 'SELL',
                    botExcutedTime: { $gt: 0, $lt: 999 },
                    executedAt:     { $gte: trade.detectedAt },
                }).lean().exec();

                if (executed) {
                    const delayMs = ((executed as any).executedAt - trade.detectedAt) / 1000;
                    console.log(`   ✅ BOT A EXÉCUTÉ le trade ${delayMs.toFixed(1)}s après alerte Telegram`);
                    clearInterval(interval);
                    resolve();
                    return;
                }

            } catch (err) {
                // Ignore les erreurs de polling
            }

            if (Date.now() - startMs > TIMEOUT_MS) {
                console.log(`   ❌ Pas détecté après ${TIMEOUT_MS / 1000}s`);
                console.log(`      → Cause probable: marché sportif (résolu), slippage trop élevé, ou trade trop vieux`);
                clearInterval(interval);
                resolve();
            }
        }, POLL_INTERVAL_MS);
    });
}

// ─── Écriture dans le log principal du bot ────────────────────────────────────

const MAIN_LOG_PATH = path.join(__dirname, '../../../logs/bot.log');

function writeToMainLog(trade: WhaleTrade): void {
    try {
        const now = new Date();
        const time = now.toLocaleTimeString('fr-CA', {
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        });
        const emoji = trade.action === 'BUY' ? '📈' : '📉';
        const priceStr  = trade.priceUsd  ? ` @ ${(trade.priceUsd * 100).toFixed(0)}¢`   : '';
        const sizeStr   = trade.sizeUsd   ? ` | $${trade.sizeUsd.toLocaleString()}`        : '';
        const urlStr    = trade.marketSlug
            ? ` | https://polymarket.com/event/${trade.marketSlug}`
            : '';
        const line =
            `[${time}] 📱 TELEGRAM ${emoji} ${trade.traderName} — ` +
            `${trade.action} ${trade.outcome}${priceStr}${sizeStr}${urlStr}\n`;

        // Créer le dossier logs/ si nécessaire
        const logsDir = path.dirname(MAIN_LOG_PATH);
        if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

        fs.appendFileSync(MAIN_LOG_PATH, line, 'utf-8');
    } catch {
        // Non-bloquant — si le log principal n'est pas accessible, on continue
    }
}

// ─── Handler message ──────────────────────────────────────────────────────────

function handleMessage(event: NewMessageEvent, mongoOk: boolean) {
    const text = event.message?.message ?? '';
    if (!text) return;

    const trade = parseAlert(text);
    if (!trade) return;

    const time = new Date().toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const emoji = trade.action === 'BUY' ? '📈' : '📉';

    console.log('\n' + '═'.repeat(60));
    console.log(`[${time}] ${emoji} ALERTE WHALE REÇUE`);
    console.log(`   Trader : ${trade.traderName}`);
    console.log(`   Action : ${trade.action} ${trade.outcome}`);
    if (trade.title)      console.log(`   Marché : ${trade.title}`);
    if (trade.sizeUsd)    console.log(`   Taille : $${trade.sizeUsd.toLocaleString()}`);
    if (trade.priceUsd)   console.log(`   Prix   : ${(trade.priceUsd * 100).toFixed(0)}¢`);
    if (trade.marketSlug) console.log(`   Lien   : https://polymarket.com/event/${trade.marketSlug}`);

    if (!trade.traderAddress) {
        console.log(`   ⚠️  Adresse inconnue pour "${trade.traderName}" — ajoute-la dans TRADER_MAP`);
    } else {
        console.log(`   Wallet : ${trade.traderAddress}`);
    }

    // Écrire dans le log principal du bot (visible dans logs/bot.log)
    writeToMainLog(trade);

    if (trade.action === 'SELL') {
        console.log(`   ℹ️  SELL — le bot copiera uniquement s'il a une position ouverte`);
        return;
    }

    // Pour les BUY, surveiller si le bot détecte
    waitForBotDetection(trade, mongoOk).catch(console.error);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function input(prompt: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(prompt, ans => { rl.close(); resolve(ans.trim()); }));
}

async function main() {
    console.log('🐋 Telegram Whale Monitor — Polymarket Copy Bot');
    console.log('=' .repeat(60));

    // Connexion MongoDB
    const mongoOk = await connectMongo().catch(() => false);

    // Connexion Telegram
    const session = new StringSession(SESSION);
    const client  = new TelegramClient(session, API_ID, API_HASH, {
        connectionRetries: 5,
    });

    await client.start({
        phoneNumber:  async () => PHONE,
        phoneCode:    async () => {
            console.log('\n📱 Code SMS envoyé sur ton téléphone Telegram');
            return input('   Entre le code reçu : ');
        },
        password:     async () => input('🔒 Mot de passe 2FA : '),
        onError:      (err) => console.error('❌ Telegram error:', err),
    });

    // Afficher la session string (à copier dans .env la 1ère fois)
    const sessionStr = client.session.save() as unknown as string;
    if (!SESSION && sessionStr) {
        console.log('\n' + '─'.repeat(60));
        console.log('📋 COPIE cette ligne dans ton .env pour éviter de te reconnecter :');
        console.log(`TELEGRAM_SESSION='${sessionStr}'`);
        console.log('─'.repeat(60) + '\n');
    }

    console.log('✅ Connecté à Telegram');

    // Trouver la conversation avec le bot whale
    let chatFilter: { chats?: bigint[] } = {};
    if (BOT_NAME) {
        try {
            const entity = await client.getEntity(BOT_NAME);
            const id = (entity as any).id as bigint;
            chatFilter = { chats: [id] };
            console.log(`✅ Bot Telegram trouvé : ${BOT_NAME}`);
        } catch {
            console.warn(`⚠️  Impossible de trouver "${BOT_NAME}" — écoute tous les messages`);
        }
    } else {
        console.warn('⚠️  TELEGRAM_BOT_USERNAME absent — écoute tous les messages entrants');
    }

    // Écouter les nouveaux messages
    client.addEventHandler(
        (event: NewMessageEvent) => handleMessage(event, !!mongoOk),
        new NewMessage(chatFilter)
    );

    console.log('\n👁  En attente d\'alertes whale...');
    console.log('   (Ctrl+C pour arrêter)\n');

    // Garder le processus actif
    await new Promise(() => {});
}

main().catch(err => {
    console.error('❌ Erreur fatale:', err);
    process.exit(1);
});
