/**
 * scripts/kill-bot.js
 * Tue toutes les instances du bot (node dist/index.js ou ts-node src/index.ts)
 * avant de démarrer une nouvelle instance via npm start / npm run dev.
 * Utilise plain Node.js (pas de ts-node) pour fonctionner en predev/prestart.
 */

const { execSync } = require('child_process');

const MY_PID = process.pid;

try {
    // Récupère la liste des processus node.exe avec leur PID et ligne de commande
    const output = execSync(
        'wmic process where "name=\'node.exe\'" get processid,commandline /format:csv 2>nul',
        { encoding: 'utf8', timeout: 5000 }
    );

    const lines = output.split('\n');
    let killed = 0;

    for (const line of lines) {
        const lower = line.toLowerCase();

        // Cible uniquement les processus du bot (dist/index ou src/index)
        const isBot =
            lower.includes('dist\\index.js') ||
            lower.includes('dist/index.js') ||
            lower.includes('src\\index.ts') ||
            lower.includes('src/index.ts') ||
            (lower.includes('ts-node') && lower.includes('index'));

        // Exclut npm-cli et le processus courant (le script kill lui-même)
        const isNpm = lower.includes('npm-cli') || lower.includes('npm.js');

        if (!isBot || isNpm) continue;

        // Extrait le PID (dernière colonne CSV)
        const parts = line.trim().split(',');
        const pid = parseInt(parts[parts.length - 1]);

        if (!pid || isNaN(pid) || pid === MY_PID) continue;

        try {
            execSync(`taskkill /PID ${pid} /F /T 2>nul`, { timeout: 3000 });
            console.log(`[kill-bot] Instance bot tuée — PID ${pid}`);
            killed++;
        } catch {
            // Process already dead, ignore
        }
    }

    if (killed > 0) {
        console.log(`[kill-bot] ${killed} instance(s) fermée(s). Démarrage...`);
        // Petite pause pour laisser les ports/connexions MongoDB se fermer proprement
        const start = Date.now();
        while (Date.now() - start < 800) { /* busy wait court */ }
    }

} catch (err) {
    // Non-bloquant : si wmic échoue, on continue quand même
    console.warn('[kill-bot] Impossible de vérifier les instances existantes:', err.message);
}
