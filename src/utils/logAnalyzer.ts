/**
 * Log Analyzer - Détecte automatiquement les problèmes du bot
 * 
 * Fonctionnalités:
 * - Capture les événements importants dans un fichier log
 * - Analyse périodiquement pour détecter des patterns de problèmes
 * - Écrit les problèmes détectés dans data/problems.txt
 * - Efface le fichier problems.txt au redémarrage
 * - CIRCUIT BREAKER: Arrête les trades si perte > 20%
 */

import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const EVENTS_LOG_FILE = path.join(DATA_DIR, 'bot_events.log');
const PROBLEMS_FILE = path.join(DATA_DIR, 'problems.txt');

// Circuit Breaker Configuration
const CIRCUIT_BREAKER_LOSS_THRESHOLD = 50; // Arrête si perte > 50%
const CIRCUIT_BREAKER_TIME_WINDOW_HOURS = 4; // Fenêtre de temps pour détecter la perte

// Types d'événements à tracker
export type EventType = 
    | 'ERROR'           // Erreur générale
    | 'TRADE_FAILED'    // Trade échoué
    | 'TRADE_SUCCESS'   // Trade réussi
    | 'CONNECTION_ERROR'// Erreur de connexion
    | 'BALANCE_UPDATE'  // Mise à jour balance
    | 'POSITION_STUCK'  // Position bloquée
    | 'HIGH_LOSS'       // Perte importante
    | 'BOT_START'       // Démarrage du bot
    | 'BOT_STOP'        // Arrêt du bot
    | 'WARNING'         // Avertissement
    | 'CIRCUIT_BREAKER' // Circuit breaker activé
    | 'INFO';           // Information

interface BotEvent {
    timestamp: string;
    type: EventType;
    message: string;
    data?: Record<string, unknown>;
}

interface AnalysisResult {
    hasProblems: boolean;
    problems: string[];
    stats: {
        totalEvents: number;
        errors: number;
        tradesFailed: number;
        tradesSuccess: number;
        connectionErrors: number;
        lastActivity: string | null;
    };
}

class LogAnalyzer {
    private events: BotEvent[] = [];
    private analysisInterval: NodeJS.Timeout | null = null;
    private startTime: Date;
    private lastBalance: number | null = null;
    private startingBalance: number | null = null;
    private balanceHistory: { timestamp: Date; balance: number }[] = [];
    private circuitBreakerTriggered: boolean = false;
    private circuitBreakerReason: string | null = null;

    constructor() {
        this.startTime = new Date();
        this.ensureDataDir();
    }

    private ensureDataDir(): void {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
    }

    /**
     * Initialise l'analyseur et efface le fichier problems.txt
     */
    initialize(): void {
        // Effacer le fichier problems.txt au démarrage
        this.clearProblemsFile();
        
        // Charger les événements existants (pour analyse historique)
        this.loadEvents();
        
        // Logger le démarrage
        this.logEvent('BOT_START', 'Bot démarré');
        
        // Démarrer l'analyse périodique (toutes les 5 minutes)
        this.startPeriodicAnalysis(5 * 60 * 1000);
        
        console.log('📊 Log Analyzer initialized - Problems file cleared');
    }

    /**
     * Efface le fichier problems.txt
     */
    clearProblemsFile(): void {
        try {
            if (fs.existsSync(PROBLEMS_FILE)) {
                fs.unlinkSync(PROBLEMS_FILE);
            }
        } catch (error) {
            console.error('Error clearing problems file:', error);
        }
    }

    /**
     * Charge les événements du fichier log
     */
    private loadEvents(): void {
        try {
            if (fs.existsSync(EVENTS_LOG_FILE)) {
                const content = fs.readFileSync(EVENTS_LOG_FILE, 'utf-8');
                const lines = content.trim().split('\n').filter(l => l);
                
                // Garder seulement les événements des dernières 24h
                const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
                
                this.events = lines
                    .map(line => {
                        try {
                            return JSON.parse(line) as BotEvent;
                        } catch {
                            return null;
                        }
                    })
                    .filter((e): e is BotEvent => {
                        if (!e) return false;
                        return new Date(e.timestamp) > oneDayAgo;
                    });
            }
        } catch (error) {
            console.error('Error loading events:', error);
            this.events = [];
        }
    }

    /**
     * Sauvegarde un événement dans le fichier log
     */
    private saveEvent(event: BotEvent): void {
        try {
            const line = JSON.stringify(event) + '\n';
            fs.appendFileSync(EVENTS_LOG_FILE, line);
        } catch (error) {
            console.error('Error saving event:', error);
        }
    }

    /**
     * Log un événement
     */
    logEvent(type: EventType, message: string, data?: Record<string, unknown>): void {
        const event: BotEvent = {
            timestamp: new Date().toISOString(),
            type,
            message,
            data
        };
        
        this.events.push(event);
        this.saveEvent(event);
        
        // Garder seulement les 1000 derniers événements en mémoire
        if (this.events.length > 1000) {
            this.events = this.events.slice(-1000);
        }
    }

    /**
     * Met à jour la balance et détecte les pertes importantes
     */
    updateBalance(balance: number): void {
        const now = new Date();
        
        if (this.startingBalance === null) {
            this.startingBalance = balance;
        }
        
        const previousBalance = this.lastBalance;
        this.lastBalance = balance;
        
        // Ajouter à l'historique des balances
        this.balanceHistory.push({ timestamp: now, balance });
        
        // Garder seulement les X dernières heures d'historique
        const cutoffTime = new Date(now.getTime() - CIRCUIT_BREAKER_TIME_WINDOW_HOURS * 60 * 60 * 1000);
        this.balanceHistory = this.balanceHistory.filter(b => b.timestamp > cutoffTime);
        
        this.logEvent('BALANCE_UPDATE', `Balance: $${balance.toFixed(2)}`, { balance });
        
        // Détecter une perte soudaine (> 5% en une mise à jour)
        if (previousBalance !== null) {
            const change = ((balance - previousBalance) / previousBalance) * 100;
            if (change < -5) {
                this.logEvent('HIGH_LOSS', `Perte soudaine de ${Math.abs(change).toFixed(1)}%`, {
                    previous: previousBalance,
                    current: balance,
                    changePercent: change
                });
            }
        }
        
        // Détecter une perte totale importante (> 15% depuis le début)
        if (this.startingBalance !== null) {
            const totalChange = ((balance - this.startingBalance) / this.startingBalance) * 100;
            if (totalChange < -15) {
                this.logEvent('HIGH_LOSS', `Perte totale de ${Math.abs(totalChange).toFixed(1)}% depuis le début`, {
                    starting: this.startingBalance,
                    current: balance,
                    totalChangePercent: totalChange
                });
            }
        }
        
        // CIRCUIT BREAKER: Vérifier la perte sur la fenêtre de temps
        this.checkCircuitBreaker(balance);
    }

    /**
     * Vérifie si le circuit breaker doit être activé
     */
    private checkCircuitBreaker(currentBalance: number): void {
        if (this.circuitBreakerTriggered) return; // Déjà déclenché
        
        if (this.balanceHistory.length < 2) return; // Pas assez de données
        
        // Trouver la balance max dans la fenêtre de temps
        const maxBalance = Math.max(...this.balanceHistory.map(b => b.balance));
        
        // Calculer la perte depuis le max
        const lossPercent = ((maxBalance - currentBalance) / maxBalance) * 100;
        
        if (lossPercent >= CIRCUIT_BREAKER_LOSS_THRESHOLD) {
            this.triggerCircuitBreaker(
                `Perte de ${lossPercent.toFixed(1)}% en ${CIRCUIT_BREAKER_TIME_WINDOW_HOURS}h ` +
                `(de $${maxBalance.toFixed(2)} à $${currentBalance.toFixed(2)})`
            );
        }
    }

    /**
     * Déclenche le circuit breaker
     */
    private triggerCircuitBreaker(reason: string): void {
        this.circuitBreakerTriggered = true;
        this.circuitBreakerReason = reason;
        
        this.logEvent('CIRCUIT_BREAKER', `🚨 CIRCUIT BREAKER ACTIVÉ: ${reason}`, {
            threshold: CIRCUIT_BREAKER_LOSS_THRESHOLD,
            timeWindowHours: CIRCUIT_BREAKER_TIME_WINDOW_HOURS
        });
        
        console.log('\n');
        console.log('🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨');
        console.log('🛑 CIRCUIT BREAKER ACTIVÉ - TRADES SUSPENDUS');
        console.log(`📉 Raison: ${reason}`);
        console.log('💡 Pour reprendre les trades, redémarrez le bot');
        console.log('🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨');
        console.log('\n');
        
        // Écrire dans le fichier problems
        this.writeProblemsFile({
            hasProblems: true,
            problems: [`🚨 CIRCUIT BREAKER ACTIVÉ: ${reason}`],
            stats: {
                totalEvents: 0,
                errors: 0,
                tradesFailed: 0,
                tradesSuccess: 0,
                connectionErrors: 0,
                lastActivity: new Date().toISOString()
            }
        });
    }

    /**
     * Vérifie si les trades sont autorisés (circuit breaker non activé)
     */
    isTradeAllowed(): boolean {
        return !this.circuitBreakerTriggered;
    }

    /**
     * Obtient la raison du circuit breaker
     */
    getCircuitBreakerReason(): string | null {
        return this.circuitBreakerReason;
    }

    /**
     * Réinitialise le circuit breaker (au redémarrage du bot)
     */
    resetCircuitBreaker(): void {
        this.circuitBreakerTriggered = false;
        this.circuitBreakerReason = null;
        this.balanceHistory = [];
        console.log('✅ Circuit breaker reset');
    }

    /**
     * Démarre l'analyse périodique
     */
    startPeriodicAnalysis(intervalMs: number): void {
        if (this.analysisInterval) {
            clearInterval(this.analysisInterval);
        }
        
        this.analysisInterval = setInterval(() => {
            this.analyzeAndReport();
        }, intervalMs);
    }

    /**
     * Arrête l'analyse périodique
     */
    stopPeriodicAnalysis(): void {
        if (this.analysisInterval) {
            clearInterval(this.analysisInterval);
            this.analysisInterval = null;
        }
    }

    /**
     * Analyse les événements et détecte les problèmes
     */
    analyze(): AnalysisResult {
        const now = new Date();
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        const recentEvents = this.events.filter(e => new Date(e.timestamp) > oneHourAgo);
        
        const stats = {
            totalEvents: recentEvents.length,
            errors: recentEvents.filter(e => e.type === 'ERROR').length,
            tradesFailed: recentEvents.filter(e => e.type === 'TRADE_FAILED').length,
            tradesSuccess: recentEvents.filter(e => e.type === 'TRADE_SUCCESS').length,
            connectionErrors: recentEvents.filter(e => e.type === 'CONNECTION_ERROR').length,
            lastActivity: this.events.length > 0 ? this.events[this.events.length - 1].timestamp : null
        };
        
        const problems: string[] = [];
        
        // 1. Trop d'erreurs (> 10 en 1h)
        if (stats.errors > 10) {
            problems.push(`⚠️ Trop d'erreurs: ${stats.errors} erreurs dans la dernière heure`);
        }
        
        // 2. Trop de trades échoués (> 50% d'échec)
        const totalTrades = stats.tradesFailed + stats.tradesSuccess;
        if (totalTrades > 5 && stats.tradesFailed / totalTrades > 0.5) {
            const failRate = ((stats.tradesFailed / totalTrades) * 100).toFixed(0);
            problems.push(`⚠️ Taux d'échec élevé: ${failRate}% des trades échouent (${stats.tradesFailed}/${totalTrades})`);
        }
        
        // 3. Problèmes de connexion répétés
        if (stats.connectionErrors > 5) {
            problems.push(`⚠️ Problèmes de connexion: ${stats.connectionErrors} erreurs de connexion dans la dernière heure`);
        }
        
        // 4. Bot inactif (pas d'activité depuis 30 min)
        if (stats.lastActivity) {
            const lastActivityTime = new Date(stats.lastActivity);
            const minutesSinceActivity = (now.getTime() - lastActivityTime.getTime()) / (60 * 1000);
            if (minutesSinceActivity > 30) {
                problems.push(`⚠️ Bot inactif: Aucune activité depuis ${Math.round(minutesSinceActivity)} minutes`);
            }
        }
        
        // 5. Pertes importantes récentes
        const highLossEvents = recentEvents.filter(e => e.type === 'HIGH_LOSS');
        if (highLossEvents.length > 0) {
            const lastLoss = highLossEvents[highLossEvents.length - 1];
            problems.push(`⚠️ Pertes détectées: ${lastLoss.message}`);
        }
        
        // 6. Aucun trade réussi depuis longtemps
        const last6Hours = new Date(now.getTime() - 6 * 60 * 60 * 1000);
        const recentSuccesses = this.events.filter(
            e => e.type === 'TRADE_SUCCESS' && new Date(e.timestamp) > last6Hours
        );
        const recentFailures = this.events.filter(
            e => e.type === 'TRADE_FAILED' && new Date(e.timestamp) > last6Hours
        );
        if (recentSuccesses.length === 0 && recentFailures.length > 3) {
            problems.push(`⚠️ Aucun trade réussi depuis 6h mais ${recentFailures.length} échecs`);
        }
        
        return {
            hasProblems: problems.length > 0,
            problems,
            stats
        };
    }

    /**
     * Analyse et écrit les problèmes dans le fichier
     */
    analyzeAndReport(): void {
        const result = this.analyze();
        
        if (result.hasProblems) {
            this.writeProblemsFile(result);
        }
    }

    /**
     * Écrit les problèmes dans le fichier
     */
    private writeProblemsFile(result: AnalysisResult): void {
        const lines: string[] = [
            '═══════════════════════════════════════════════════════════════',
            '  🚨 PROBLÈMES DÉTECTÉS - ' + new Date().toLocaleString('fr-CA'),
            '═══════════════════════════════════════════════════════════════',
            '',
            ...result.problems,
            '',
            '───────────────────────────────────────────────────────────────',
            '  📊 STATISTIQUES (dernière heure)',
            '───────────────────────────────────────────────────────────────',
            `  • Total événements: ${result.stats.totalEvents}`,
            `  • Erreurs: ${result.stats.errors}`,
            `  • Trades réussis: ${result.stats.tradesSuccess}`,
            `  • Trades échoués: ${result.stats.tradesFailed}`,
            `  • Erreurs connexion: ${result.stats.connectionErrors}`,
            '',
            '───────────────────────────────────────────────────────────────',
            '  💡 Ce fichier est effacé au redémarrage du bot',
            '═══════════════════════════════════════════════════════════════',
            ''
        ];
        
        try {
            fs.writeFileSync(PROBLEMS_FILE, lines.join('\n'));
        } catch (error) {
            console.error('Error writing problems file:', error);
        }
    }

    /**
     * Obtient le chemin du fichier problems
     */
    getProblemsFilePath(): string {
        return PROBLEMS_FILE;
    }

    /**
     * Vérifie si des problèmes existent
     */
    hasProblems(): boolean {
        return fs.existsSync(PROBLEMS_FILE);
    }

    /**
     * Lit le contenu du fichier problems
     */
    readProblems(): string | null {
        try {
            if (fs.existsSync(PROBLEMS_FILE)) {
                return fs.readFileSync(PROBLEMS_FILE, 'utf-8');
            }
        } catch (error) {
            console.error('Error reading problems file:', error);
        }
        return null;
    }

    /**
     * Force une analyse immédiate
     */
    forceAnalysis(): AnalysisResult {
        const result = this.analyze();
        if (result.hasProblems) {
            this.writeProblemsFile(result);
        }
        return result;
    }

    /**
     * Nettoie les vieux logs (garde les 7 derniers jours)
     */
    cleanOldLogs(): void {
        try {
            if (!fs.existsSync(EVENTS_LOG_FILE)) return;
            
            const content = fs.readFileSync(EVENTS_LOG_FILE, 'utf-8');
            const lines = content.trim().split('\n').filter(l => l);
            
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            
            const recentLines = lines.filter(line => {
                try {
                    const event = JSON.parse(line) as BotEvent;
                    return new Date(event.timestamp) > sevenDaysAgo;
                } catch {
                    return false;
                }
            });
            
            fs.writeFileSync(EVENTS_LOG_FILE, recentLines.join('\n') + '\n');
            console.log(`🧹 Cleaned old logs: kept ${recentLines.length}/${lines.length} events`);
        } catch (error) {
            console.error('Error cleaning old logs:', error);
        }
    }

    /**
     * Arrête l'analyseur proprement
     */
    shutdown(): void {
        this.stopPeriodicAnalysis();
        this.logEvent('BOT_STOP', 'Bot arrêté');
    }
}

// Instance singleton
let analyzerInstance: LogAnalyzer | null = null;

export function getLogAnalyzer(): LogAnalyzer {
    if (!analyzerInstance) {
        analyzerInstance = new LogAnalyzer();
    }
    return analyzerInstance;
}

export function initializeLogAnalyzer(): void {
    getLogAnalyzer().initialize();
}

export function logBotEvent(type: EventType, message: string, data?: Record<string, unknown>): void {
    getLogAnalyzer().logEvent(type, message, data);
}

export function updateBotBalance(balance: number): void {
    getLogAnalyzer().updateBalance(balance);
}

export function isTradeAllowed(): boolean {
    return getLogAnalyzer().isTradeAllowed();
}

export function getCircuitBreakerReason(): string | null {
    return getLogAnalyzer().getCircuitBreakerReason();
}

export function resetCircuitBreaker(): void {
    getLogAnalyzer().resetCircuitBreaker();
}

export function shutdownLogAnalyzer(): void {
    if (analyzerInstance) {
        analyzerInstance.shutdown();
    }
}

export default LogAnalyzer;
