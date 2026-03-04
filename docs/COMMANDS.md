# 📚 Liste des Commandes

Guide complet de toutes les commandes disponibles pour le bot de copy trading Polymarket.

---

## ⌨️ Raccourcis Clavier (pendant l'exécution du bot)

| Touche | Action |
|--------|--------|
| `l` | Affiche la liste de toutes les positions actuelles |
| `s` | Vend toutes les positions (avec confirmation) - **fonctionne en mode réel et simulation** |
| `b` | Désactive le circuit breaker et reprend les trades |
| `Ctrl+C` | Arrête le bot immédiatement |

---

## 🔴 Mode Réel vs Simulation

### DRY_RUN=true (Simulation - par défaut)
- Aucune transaction réelle
- Balance virtuelle
- Parfait pour tester les stratégies

### DRY_RUN=false (Argent réel)
- ⚠️ **Transactions réelles sur Polymarket!**
- Vrai argent (USDC) utilisé
- Le bot affiche un avertissement de 5 secondes au démarrage
- **Synchronisation automatique** des positions au démarrage
- **Sell All (touche 's')** fonctionne avec de vraies ventes

### 💡 Recommandations pour le mode réel:
- Commencez avec de petits montants ($50-100)
- Définissez `COPY_SIZE` à une faible valeur (5-10)
- Limitez `MAX_OPEN_POSITIONS` (10-15)
- Surveillez le bot de près les premières heures
- Testez d'abord en simulation!

---

## 🚀 Commandes Principales

### Démarrage du Bot

| Commande | Description |
|----------|-------------|
| `npm run dev` | Démarre le bot en mode développement (TypeScript) |
| `npm run start` | Démarre le bot en mode production (JavaScript compilé) |
| `npm run start-fresh` | Démarre le bot avec une nouvelle simulation (remet la balance à zéro) |
| `npm run build` | Compile le TypeScript en JavaScript |

### Configuration

| Commande | Description |
|----------|-------------|
| `npm run setup` | Assistant de configuration interactif (crée le fichier .env) |
| `npm run help` | Affiche l'aide et les commandes disponibles |

---

## 🔍 Diagnostic et Problèmes

| Commande | Description |
|----------|-------------|
| `npm run check-problems` | Affiche les problèmes détectés par l'analyseur de logs |
| `npm run health-check` | Vérifie l'état de santé du bot |
| `npm run test-fixes` | **[NOUVEAU]** Teste que les fixes anti-pertes fonctionnent correctement |

> **🚨 Circuit Breaker**
> 
> Le bot possède un circuit breaker qui bloque automatiquement les trades BUY si:
> - La perte dépasse **50%** sur une fenêtre de **4 heures**
> 
> Pour désactiver le circuit breaker, appuyez sur **`b`** pendant l'exécution du bot.

> **📊 Analyseur de Logs Automatique**
> 
> Le bot analyse automatiquement les événements et détecte:
> - ❌ Trop d'erreurs répétées
> - ❌ Taux d'échec des trades élevé
> - ❌ Problèmes de connexion
> - ❌ Bot inactif depuis longtemps
> - ❌ Pertes importantes
> 
> Les problèmes sont écrits dans `data/problems.txt` (effacé au redémarrage).
> Les événements sont loggés dans `data/bot_events.log`.

---

## 🧪 Simulation

| Commande | Description |
|----------|-------------|
| `npm run reset-sim` | Réinitialise la simulation (remet la balance à zéro) |
| `npm run simulate` | Simule la profitabilité d'un trader |
| `npm run simulate-old` | Simule avec l'ancienne logique |
| `npm run sim` | Lance des simulations multiples |
| `npm run compare` | Compare les résultats de différentes simulations |
| `npm run aggregate` | Agrège les résultats de simulation |

---

## 💰 Gestion des Positions

| Commande | Description |
|----------|-------------|
| `npm run manual-sell` | Vend manuellement une position spécifique |
| `npm run sell-large` | Vend les positions trop grandes |
| `npm run clean-old` | Nettoie les anciennes positions |
| `npm run close-stale` | Ferme les positions obsolètes |
| `npm run close-resolved` | Ferme les positions résolues |
| `npm run close-high-loss` | **[SIMULATION]** Ferme les positions à forte perte (défaut: > 40%) |
| `npm run redeem-resolved` | Réclame les gains des positions gagnantes résolues |
| `npm run check-alignment` | Analyse l'alignement des positions avec le trader |
| `npm run monitor-positions` | Active le monitoring horaire des positions |

---

## 📊 Vérification & Stats

| Commande | Description |
|----------|-------------|
| `npm run check-stats` | Affiche tes statistiques de trading |
| `npm run check-pnl` | Vérifie les divergences de PnL |
| `npm run check-proxy` | Vérifie le wallet proxy |
| `npm run check-both` | Vérifie les deux wallets (EOA et proxy) |
| `npm run check-activity` | Vérifie l'activité récente |
| `npm run chart` | Affiche un graphique de performance |

---

## 🔍 Recherche de Traders

| Commande | Description |
|----------|-------------|
| `npm run find-traders` | Trouve les meilleurs traders à copier |
| `npm run find-low-risk` | Trouve des traders à faible risque |
| `npm run scan-traders` | Scanne et analyse les meilleurs traders |
| `npm run scan-markets` | Scanne les traders à partir des marchés actifs |
| `npm run fetch-history` | Récupère l'historique des trades d'un trader |

---

## 🔧 Utilitaires Blockchain

| Commande | Description |
|----------|-------------|
| `npm run check-allowance` | Vérifie les allowances de tokens |
| `npm run verify-allowance` | Vérifie l'allowance en détail |
| `npm run set-token-allowance` | Configure l'allowance des tokens |
| `npm run transfer-to-gnosis` | Transfère les positions vers un Gnosis Safe |
| `npm run analyze-liquidity` | Analyse la liquidité d'un marché |

---

## 🔬 Audit & Debug

| Commande | Description |
|----------|-------------|
| `npm run audit` | Audit de l'algorithme de copy trading |
| `npm run audit-old` | Audit avec l'ancienne version |

---

## 🧹 Développement

| Commande | Description |
|----------|-------------|
| `npm run lint` | Vérifie le code avec ESLint |
| `npm run lint:fix` | Corrige automatiquement les erreurs ESLint |
| `npm run format` | Formate le code avec Prettier |
| `npm test` | Lance les tests |
| `npm run test:watch` | Lance les tests en mode watch |
| `npm run test:coverage` | Lance les tests avec couverture de code |

---

## 📝 Variables d'Environnement Importantes

Ces variables se trouvent dans le fichier `.env` :

### Configuration Principale

| Variable | Description |
|----------|-------------|
| `DRY_RUN` | `true` = simulation, `false` = trading réel |
| `SIMULATION_STARTING_BALANCE` | Balance virtuelle de départ (ex: 1200) |
| `MIN_CASH_RESERVE` | Réserve minimum à garder (ex: 300) |
| `USER_ADDRESSES` | Adresses des traders à copier (séparées par des virgules) |
| `PROXY_WALLET` | Ton wallet proxy |
| `PRIVATE_KEY` | Ta clé privée (⚠️ garder secrète!) |

### Stratégie de Trading

| Variable | Description |
|----------|-------------|
| `COPY_STRATEGY` | `PERCENTAGE`, `FIXED`, `ADAPTIVE`, ou `FIXED_TOKENS` |
| `COPY_SIZE` | Taille du trade (dépend de la stratégie) |
| `MAX_ORDER_SIZE_USD` | Taille maximum d'un ordre en USD |
| `MIN_ORDER_SIZE_USD` | Taille minimum d'un ordre en USD |
| `MAX_OPEN_POSITIONS` | Nombre maximum de positions ouvertes |

### Auto-Sell Positions Stale

| Variable | Description |
|----------|-------------|
| `AUTO_SELL_STALE_POSITIONS_DAYS` | Vend les positions inactives après X jours |
| `STALE_POSITION_CHECK_INTERVAL_HOURS` | Vérifie toutes les X heures |

### Aggregation des Trades

| Variable | Description |
|----------|-------------|
| `TRADE_AGGREGATION_ENABLED` | `true` pour activer l'aggregation |
| `TRADE_AGGREGATION_WINDOW_SECONDS` | Fenêtre d'aggregation en secondes |

### Cooldown Trader

| Variable | Description |
|----------|-------------|
| `TRADER_COOLDOWN_ENABLED` | `true` pour activer le cooldown |
| `TRADER_COOLDOWN_SECONDS` | Durée du cooldown en secondes |

---

## 💡 Exemples d'Utilisation

### Démarrer une nouvelle simulation
```bash
npm run reset-sim
npm run dev
```

### Trouver de bons traders puis les copier
```bash
npm run find-traders
# Copier les adresses dans .env
npm run dev
```

### Vérifier l'état de tes positions
```bash
npm run check-stats
npm run check-alignment
```

### Arrêter proprement et vendre tout
```bash
# Pendant que le bot tourne, appuyer sur 's' puis confirmer avec 'yes'
```

### Désactiver le circuit breaker
```bash
# Pendant que le bot tourne, appuyer sur 'b'
```

---

## ⚠️ Notes Importantes

1. **Toujours tester en mode simulation d'abord** (`DRY_RUN=true`)
2. **Ne jamais partager ta clé privée**
3. **Vérifier les allowances avant le trading réel**
4. **Surveiller régulièrement les positions avec `l`**
5. **Le circuit breaker protège contre les grosses pertes** - appuyer sur `b` pour le désactiver si nécessaire
