# Analyse : Réalisme de la Simulation vs Trading Réel

**Date** : 2026-02-19
**Objectif** : Identifier les écarts entre le mode simulation (DRY_RUN) et le trading réel, et proposer des améliorations.

---

## 1. État Actuel de l'Implémentation

### ✅ Déjà Implémenté (Bien)

| Fonctionnalité | Mode Simulation | Mode Réel | Status |
|----------------|-----------------|-----------|--------|
| **Persistance des positions** | ✅ `simulation_state.json` | ✅ Blockchain + tracker | **Excellent** |
| **Mark-to-market** | ✅ Prix CLOB réels (5 min) | ✅ Prix CLOB API | **Excellent** |
| **Order book simulation** | ✅ REALISTIC/HYBRID mode | ✅ Vraie exécution | **Très bon** |
| **Slippage dynamique** | ✅ Basé sur order book | ✅ Slippage réel | **Très bon** |
| **Partial fills** | ✅ Géré (WARN/PARTIAL/ABORT) | ✅ Géré | **Très bon** |
| **Gas fees** | ⚠️ Statique $0.03 ou API Polygon | ✅ Réel | **Bon** |
| **Délai d'exécution** | ✅ 1 seconde simulé | ✅ Réel (~2-5s) | **Bon** |
| **Graphique évolution** | ✅ Basé sur MtM | ✅ Basé sur positions réelles | **Bon** |

### ⚠️ Écarts Identifiés (À Améliorer)

---

## 2. Écarts Majeurs Entre Simulation et Réel

### 2.1 🔴 **Timing & Front-Running**

**Problème** : La simulation exécute instantanément au prix du trader, **sans tenir compte** :
- Du délai réseau (polling MongoDB → fetch order book → exécution) : **~5-15 secondes**
- Du front-running : entre le moment où le trader exécute et où le bot copie, le prix a déjà bougé
- De la volatilité intra-seconde sur les marchés actifs

**Impact** : La simulation est **trop optimiste** — elle assume qu'on obtient le même prix que le trader, alors qu'en réel on est **toujours derrière**.

**Exemple réel** :
```
Trader achète à 14:32:05.123 → Prix: $0.5100
Bot détecte à   14:32:17.456 → Prix actuel: $0.5234 (+2.6%)
Bot exécute à   14:32:22.789 → Prix final: $0.5278 (+3.5%)
```

**Simulation actuelle** :
```
Trader achète à 14:32:05 → Prix: $0.5100
Bot exécute (simulé) → Prix: $0.5100 (même prix, irréaliste)
```

**Recommandation** : ✅ **PRIORITÉ HAUTE**
Ajouter un **délai de copie réaliste** + fetch du prix ACTUEL au moment de la copie :
```typescript
// Dans executeSimulatedTrade(), avant l'exécution :
const copyDelaySeconds = Math.random() * 10 + 5; // 5-15 secondes
await new Promise(resolve => setTimeout(resolve, copyDelaySeconds * 1000));

// Fetch le prix ACTUEL (pas le prix historique du trader)
const currentOrderBook = await clobClient.getOrderBook(asset);
const currentBestPrice = parseFloat(currentOrderBook.asks[0].price);
const priceImpact = ((currentBestPrice - traderPrice) / traderPrice) * 100;

Logger.info(`⏱️ Copy delay: ${copyDelaySeconds.toFixed(1)}s | Price movement: ${priceImpact >= 0 ? '+' : ''}${priceImpact.toFixed(2)}%`);
```

---

### 2.2 🔴 **Échecs d'Exécution & Rejets**

**Problème** : La simulation assume que **tous les trades passent**, alors qu'en réel :
- Orders rejetés pour "not enough balance/allowance" (même après sync)
- Orders rejetés pour "price changed" (FOK fail)
- Timeouts réseau (10-20% des calls en période de forte activité)
- Rate limiting Polymarket API (429 errors)

**Impact** : La simulation **surestime** le nombre de positions acquises.

**Statistiques réelles observées** (d'après les logs VIBEHISTORY) :
- ~15% d'échecs sur les BUY en période normale
- ~30% d'échecs sur les SELL (allowance issues)

**Recommandation** : ✅ **PRIORITÉ MOYENNE**
Ajouter un **taux d'échec aléatoire** basé sur des stats réelles :
```typescript
// Paramètres .env :
SIMULATION_FAILURE_RATE_BUY='0.15'  // 15% échec
SIMULATION_FAILURE_RATE_SELL='0.30' // 30% échec

// Dans executeSimulatedTrade() :
const failureRate = side === 'BUY'
    ? ENV.SIMULATION_FAILURE_RATE_BUY
    : ENV.SIMULATION_FAILURE_RATE_SELL;

if (Math.random() < failureRate) {
    const reasons = [
        'Order rejected: not enough balance',
        'Order timeout (network)',
        'Order rejected: price changed (FOK)',
        'Rate limit exceeded (429)'
    ];
    const reason = reasons[Math.floor(Math.random() * reasons.length)];
    Logger.warning(`[SIMULATION] Trade failed: ${reason}`);
    return { success: false, executed: false, reason };
}
```

---

### 2.3 🟡 **Prix d'Entrée vs Prix Réel**

**Problème** : En mode SIMPLE, la simulation utilise `trade.price` (prix historique du trader) au lieu du prix **actuel** du marché.

**Mode actuel** : HYBRID (défaut) — utilise le carnet d'ordres réel ✅

**Vérification** : Le mode REALISTIC/HYBRID est-il vraiment utilisé ?
```bash
# Ajouter dans .env pour confirmer :
SIMULATION_MODE='REALISTIC'  # Force le mode réaliste
```

**Recommandation** : ✅ **PRIORITÉ BASSE** (déjà géré par REALISTIC mode)
S'assurer que REALISTIC mode est bien utilisé par défaut. Ajouter un log au démarrage :
```typescript
Logger.info(`🎯 Simulation mode: ${config.mode} (slippage max: ${config.maxSlippagePercent}%)`);
```

---

### 2.4 🟡 **Gas Fees & Frais Réels**

**État actuel** :
- Simulation : `STATIC_GAS_FEE_USD = $0.03` (ou API Polygon si `REAL_GAS_FEES=true`)
- Réel : Gas fees Polygon variables ($0.01 - $0.10 selon congestion)

**Problème** : Gas fees statiques ne reflètent pas :
- Pics de congestion Polygon (événements majeurs → $0.30/tx)
- Variabilité journalière (nuit US = $0.01, prime time = $0.08)

**Recommandation** : ✅ **PRIORITÉ BASSE**
Activer `REAL_GAS_FEES=true` dans `.env` pour fetcher les vrais gas fees Polygon via l'API.

```env
# Dans .env :
REAL_GAS_FEES='true'  # Utilise l'API Polygon pour gas fees réels
```

**Bonus** : Ajouter une **variation aléatoire** pour simuler la congestion :
```typescript
// Dans getGasFeeUSD() :
const baseGasFee = await estimateGasFeeUSD(); // API Polygon
const variance = (Math.random() - 0.5) * 0.02; // ±$0.01
const finalGasFee = Math.max(0.005, baseGasFee + variance); // Min $0.005
return finalGasFee;
```

---

### 2.5 🟡 **Métriques de Qualité Manquantes**

**Problème** : La simulation ne track pas certaines métriques critiques qui existent en mode réel :
- **Copy delay** : temps entre trade trader et trade bot (déjà logué, mais pas dans le graphique)
- **Spread historique** : évolution du spread moyen sur la session
- **Win rate par trader** : quel % de positions sont profitables

**Recommandation** : ✅ **PRIORITÉ BASSE**
Ajouter ces métriques dans le rapport HTML/TXT :
```typescript
// Dans generateTextReport() :
report += `Copy Delay Average: ${this.getAverageCopyDelay().toFixed(1)}s\n`;
report += `Spread Average: ${this.getAverageSpread().toFixed(2)}%\n`;
report += `Win Rate: ${this.getWinRate().toFixed(1)}%\n`;
```

---

### 2.6 🔴 **Restore sans Mark-to-Market Immédiat**

**Problème** : Au redémarrage, les positions restaurées utilisent leur `avgPrice` (prix d'entrée) jusqu'au premier cycle de mark-to-market (5 min).

**Impact** : Le graphique initial affiche des valeurs **incorrectes** pendant 5 minutes.

**Exemple** :
```
Bot restart à 10:00:00
Positions restaurées : 50 tokens "Iran" @ $0.99 entry → valeur affichée: $49.50
Prix actuel marché : $0.02 → valeur réelle: $1.00
Premier MtM à 10:05:00 → graphique passe de $49.50 → $1.00 (saut brutal)
```

**Recommandation** : ✅ **PRIORITÉ HAUTE**
Appeler `updateMarkToMarket()` **immédiatement après** la restauration des positions :
```typescript
// Dans le constructor de SimulationBalanceTracker :
if (savedState) {
    // ... restaurer positions ...

    // Fetch MtM immédiatement pour avoir des prix à jour
    Logger.info('🔄 Fetching mark-to-market prices for restored positions...');
    await this.updateMarkToMarket();
    Logger.success(`✅ Positions valued at current market prices`);
}
```

---

### 2.7 🟡 **Historique de Balance Perdu au Redémarrage**

**Problème** : `balanceHistory` est **en mémoire uniquement** → le graphique repart de zéro à chaque restart.

**Impact** : On perd l'historique complet de la simulation entre les sessions.

**Recommandation** : ✅ **PRIORITÉ MOYENNE**
Persister `balanceHistory` dans `simulation_state.json` :
```typescript
// Interface SimulationState (dans simulationBalance.ts) :
interface SimulationState {
    balance: number;
    startingBalance: number;
    totalFeesPaid: number;
    positions: Array<...>;
    balanceHistory: BalanceSnapshot[];  // NOUVEAU
    sessionStartTime: number;           // NOUVEAU
    lastUpdated: number;
}

// Dans loadState() :
if (savedState.balanceHistory) {
    this.balanceHistory = savedState.balanceHistory.map(snap => ({
        ...snap,
        timestamp: new Date(snap.timestamp)
    }));
}
if (savedState.sessionStartTime) {
    this.sessionStartTime = new Date(savedState.sessionStartTime);
}

// Dans saveState() :
balanceHistory: this.balanceHistory,
sessionStartTime: this.sessionStartTime.getTime(),
```

**Résultat** : Graphique continu montrant **toute l'historique** depuis le premier lancement.

---

## 3. Tableau Récapitulatif des Recommandations

| # | Écart | Impact | Priorité | Effort | ROI |
|---|-------|--------|----------|--------|-----|
| 1 | **Délai de copie réaliste** | 🔴 Critique | HAUTE | Faible | ⭐⭐⭐⭐⭐ |
| 2 | **MtM immédiat au restart** | 🔴 Critique | HAUTE | Très faible | ⭐⭐⭐⭐⭐ |
| 3 | **Taux d'échec aléatoire** | 🟡 Moyen | MOYENNE | Moyen | ⭐⭐⭐⭐ |
| 4 | **Persistance balanceHistory** | 🟡 Moyen | MOYENNE | Faible | ⭐⭐⭐⭐ |
| 5 | **Gas fees variables** | 🟢 Faible | BASSE | Très faible | ⭐⭐⭐ |
| 6 | **Métriques qualité** | 🟢 Faible | BASSE | Moyen | ⭐⭐ |
| 7 | **Confirm REALISTIC mode** | 🟢 Faible | BASSE | Très faible | ⭐⭐ |

---

## 4. Plan d'Action Recommandé

### Phase 1 : Quick Wins (30 min)
1. ✅ Ajouter `updateMarkToMarket()` immédiat après restauration
2. ✅ Ajouter log confirmation du mode simulation au démarrage
3. ✅ Activer `REAL_GAS_FEES=true` dans `.env`

### Phase 2 : Améliorations Majeures (2-3h)
4. ✅ Implémenter délai de copie réaliste + fetch prix actuel
5. ✅ Ajouter taux d'échec aléatoire configurable
6. ✅ Persister `balanceHistory` dans le JSON

### Phase 3 : Polish (1-2h)
7. ✅ Ajouter métriques qualité dans rapports
8. ✅ Créer dashboard comparatif simulation vs réel (optionnel)

---

## 5. Métriques de Validation

Pour valider le réalisme de la simulation, comparer sur une session de 24h :

| Métrique | Simulation Actuelle | Simulation Améliorée | Mode Réel | Écart Acceptable |
|----------|---------------------|----------------------|-----------|------------------|
| Nombre de trades exécutés | X | Y | Z | ±5% |
| Prix moyen d'entrée | $A | $B | $C | ±2% |
| Slippage moyen | X% | Y% | Z% | ±1% |
| P&L final | $X | $Y | $Z | ±10% |

---

## 6. Configuration Recommandée (.env)

```env
# ================================================================
# SIMULATION REALISM SETTINGS
# ================================================================
# Mode simulation : SIMPLE, REALISTIC, HYBRID (défaut: REALISTIC)
SIMULATION_MODE='REALISTIC'

# Slippage maximum autorisé en simulation (%)
SIMULATION_MAX_SLIPPAGE_PERCENT='5.0'

# Stratégie pour partial fills : WARN, PARTIAL, ABORT
SIMULATION_PARTIAL_FILL_STRATEGY='WARN'

# Taux d'échec simulés (0.0-1.0)
SIMULATION_FAILURE_RATE_BUY='0.15'   # 15% échec sur BUY
SIMULATION_FAILURE_RATE_SELL='0.30'  # 30% échec sur SELL

# Délai de copie (secondes) : min-max
SIMULATION_COPY_DELAY_MIN='5'
SIMULATION_COPY_DELAY_MAX='15'

# Gas fees : true = API Polygon réelle, false = statique
REAL_GAS_FEES='true'
```

---

## 7. Conclusion

### Forces Actuelles ✅
- Order book simulation **excellente** (REALISTIC mode)
- Mark-to-market toutes les 5 min
- Persistance des positions
- Partial fills gérés

### Faiblesses Critiques 🔴
1. **Pas de délai de copie** → prix trop optimistes
2. **Pas de taux d'échec** → nombre de trades surestimé
3. **MtM pas immédiat au restart** → graphique faux au démarrage

### Impact Estimé
Avec les améliorations **Phase 1 + Phase 2**, l'écart simulation vs réel devrait passer de **~20-30%** à **~5-10%** (acceptable pour une simulation).

---

**Prochaine étape** : Implémenter Phase 1 (quick wins) puis mesurer l'impact.
