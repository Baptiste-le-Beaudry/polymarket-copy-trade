/**
 * cleanupMongo.ts
 * Supprime les trades déjà traités (bot: true) de toutes les collections MongoDB.
 * À lancer quand le quota Atlas est dépassé ou pour maintenance.
 *
 * Usage: npx ts-node src/scripts/cleanupMongo.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { getUserActivityModel } from '../models/userHistory';

const MONGO_URI = process.env.MONGO_URI as string;

// Copie de USER_ADDRESSES depuis le .env
const parseAddresses = (input: string): string[] =>
    input
        .replace(/'/g, '')
        .split(',')
        .map((a) => a.trim().toLowerCase())
        .filter(Boolean);

const USER_ADDRESSES = parseAddresses(process.env.USER_ADDRESSES || '');

async function main() {
    if (!MONGO_URI) {
        console.error('❌ MONGO_URI manquant dans .env');
        process.exit(1);
    }
    if (USER_ADDRESSES.length === 0) {
        console.error('❌ USER_ADDRESSES manquant dans .env');
        process.exit(1);
    }

    console.log(`\n🔌 Connexion à MongoDB Atlas...`);
    await mongoose.connect(MONGO_URI);
    console.log(`✅ Connecté\n`);

    let totalDeleted = 0;
    const cutoff7days = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;

    for (const address of USER_ADDRESSES) {
        const model = getUserActivityModel(address);

        // 1. Supprimer tous les trades traités (bot: true) — plus utiles
        const deletedProcessed = await model.deleteMany({ bot: true });

        // 2. Supprimer les trades non traités mais très anciens (> 7 jours) — sécurité
        const deletedOld = await model.deleteMany({
            bot: false,
            timestamp: { $lt: cutoff7days },
        });

        const total = deletedProcessed.deletedCount + deletedOld.deletedCount;
        totalDeleted += total;

        if (total > 0) {
            console.log(
                `🧹 ${address.slice(0, 10)}... → ${deletedProcessed.deletedCount} traités + ${deletedOld.deletedCount} anciens supprimés`
            );
        }
    }

    console.log(`\n✅ Nettoyage terminé : ${totalDeleted} documents supprimés au total`);
    console.log(`💡 Relancez le bot — MongoDB devrait avoir de l'espace libre maintenant\n`);

    await mongoose.disconnect();
    process.exit(0);
}

main().catch((err) => {
    console.error('❌ Erreur:', err.message);
    process.exit(1);
});
