/**
 * Check Problems - Affiche les problèmes détectés par l'analyseur de logs
 */

import * as fs from 'fs';
import * as path from 'path';

const PROBLEMS_FILE = path.join(process.cwd(), 'data', 'problems.txt');
const EVENTS_LOG_FILE = path.join(process.cwd(), 'data', 'bot_events.log');

const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    bold: '\x1b[1m',
};

console.log(`\n${colors.bold}${colors.cyan}═══════════════════════════════════════════════════════════════${colors.reset}`);
console.log(`${colors.bold}  🔍 BOT PROBLEM CHECKER${colors.reset}`);
console.log(`${colors.cyan}═══════════════════════════════════════════════════════════════${colors.reset}\n`);

// Check problems file
if (fs.existsSync(PROBLEMS_FILE)) {
    const content = fs.readFileSync(PROBLEMS_FILE, 'utf-8');
    console.log(`${colors.red}${colors.bold}🚨 PROBLÈMES DÉTECTÉS:${colors.reset}\n`);
    console.log(content);
} else {
    console.log(`${colors.green}✅ Aucun problème détecté!${colors.reset}\n`);
}

// Show recent events summary
if (fs.existsSync(EVENTS_LOG_FILE)) {
    const content = fs.readFileSync(EVENTS_LOG_FILE, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l);
    
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    
    let errors = 0;
    let tradeSuccess = 0;
    let tradeFailed = 0;
    let warnings = 0;
    
    lines.forEach(line => {
        try {
            const event = JSON.parse(line);
            if (new Date(event.timestamp) > oneHourAgo) {
                switch (event.type) {
                    case 'ERROR': errors++; break;
                    case 'TRADE_SUCCESS': tradeSuccess++; break;
                    case 'TRADE_FAILED': tradeFailed++; break;
                    case 'WARNING': warnings++; break;
                }
            }
        } catch {}
    });
    
    console.log(`${colors.cyan}───────────────────────────────────────────────────────────────${colors.reset}`);
    console.log(`${colors.bold}  📊 STATISTIQUES (dernière heure)${colors.reset}`);
    console.log(`${colors.cyan}───────────────────────────────────────────────────────────────${colors.reset}`);
    console.log(`  • Total événements loggés: ${lines.length}`);
    console.log(`  • Trades réussis: ${colors.green}${tradeSuccess}${colors.reset}`);
    console.log(`  • Trades échoués: ${colors.red}${tradeFailed}${colors.reset}`);
    console.log(`  • Erreurs: ${colors.red}${errors}${colors.reset}`);
    console.log(`  • Avertissements: ${colors.yellow}${warnings}${colors.reset}`);
    
    if (tradeSuccess + tradeFailed > 0) {
        const successRate = ((tradeSuccess / (tradeSuccess + tradeFailed)) * 100).toFixed(1);
        console.log(`  • Taux de succès: ${parseFloat(successRate) >= 50 ? colors.green : colors.red}${successRate}%${colors.reset}`);
    }
    
    // Show last 5 events
    console.log(`\n${colors.cyan}───────────────────────────────────────────────────────────────${colors.reset}`);
    console.log(`${colors.bold}  📝 DERNIERS ÉVÉNEMENTS${colors.reset}`);
    console.log(`${colors.cyan}───────────────────────────────────────────────────────────────${colors.reset}`);
    
    const recentEvents = lines.slice(-5).reverse();
    recentEvents.forEach(line => {
        try {
            const event = JSON.parse(line);
            const time = new Date(event.timestamp).toLocaleTimeString('fr-CA');
            let color = colors.reset;
            switch (event.type) {
                case 'ERROR': color = colors.red; break;
                case 'TRADE_FAILED': color = colors.red; break;
                case 'TRADE_SUCCESS': color = colors.green; break;
                case 'WARNING': color = colors.yellow; break;
            }
            console.log(`  ${time} ${color}[${event.type}]${colors.reset} ${event.message}`);
        } catch {}
    });
} else {
    console.log(`${colors.yellow}⚠️ Aucun fichier de log trouvé. Le bot n'a pas encore été exécuté.${colors.reset}`);
}

console.log(`\n${colors.cyan}═══════════════════════════════════════════════════════════════${colors.reset}\n`);
