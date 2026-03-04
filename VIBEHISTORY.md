# VIBE HISTORY — Polymarket Copy Trading Bot

Chaque entrée = une session de vibe coding.
Les modifications sont listées du plus récent au plus ancien.

---

## 2026-03-04 — Prix 1s après achat du trader

### Affichage prix marché post-trade
- **Pourquoi** : voir si le marché a bougé 1s après l'achat du trader (vs prix d'achat)
- **Modifié** : `src/services/tradeExecutor.ts`
  - Après `postOrder()` sur un BUY, attend 1s puis fetch `/book?token_id=`
  - Affiche bid/ask/mid + delta % par rapport au prix du trader

---

## 2026-03-03 — Anti-spam terminal

### tradeMonitor.ts + tradeExecutor.ts
- **Pourquoi** : Avec 63 traders en parallèle, le log "New trade detected" créait des dizaines de lignes en rafale. L'animation waiting à 300ms ajoutait du bruit visuel.
- **Modifié** : `src/services/tradeMonitor.ts`, `src/services/tradeExecutor.ts`
  - Monitor : suppression du log "New trade detected for..." par trader (redundant avec l'header "⚡ N NEW TRADES TO COPY" de l'executor)
  - Executor : fréquence animation waiting 300ms → 2000ms (moins de bruit, le spinner se met à jour toutes les 2s)

---

## 2026-03-03 — Réduction intervalles polling (executor 300ms→200ms, monitor 1s→0s)

### tradeExecutor.ts + env.ts + .env
- **Pourquoi** : Réduire la latence entre détection d'un trade et son exécution
- **Modifié** : `src/services/tradeExecutor.ts`, `src/config/env.ts`, `.env`
  - Executor : boucle principale 300ms → 200ms
  - Monitor : `FETCH_INTERVAL=0` (plus d'attente artificielle entre cycles, limité par les ~2-3s de fetch)
  - Validation env.ts : accepte maintenant FETCH_INTERVAL=0 (>= 0 au lieu de > 0)

---

## 2026-03-03 — Parallélisation fetch traders (cycle ~20s → ~2s)

### tradeMonitor.ts
- **Pourquoi** : fetchTradeData() était séquentiel — 63 traders × ~300ms = ~19s de cycle réel. Les copy delays de 1-7 min venaient de là, pas du polling interval.
- **Modifié** : `src/services/tradeMonitor.ts`
  - Extraction de `processOneTrader()` : logique par trader isolée
  - `fetchTradeData()` utilise maintenant `Promise.allSettled()` en batches de 8 traders
  - Délai de 150ms entre batches pour éviter le rate limit Polymarket
  - Log du temps de cycle si > 3s : `⏱ Fetch cycle: Xs (63 traders, batches de 8)`
  - Gain estimé : ~19s → ~2-3s par cycle

---

## 2026-03-03 — Fix affichage graphique simulation

### index.ts
- **Pourquoi** : Le graphique n'apparaissait qu'après 5 min (setInterval). Si le bot était redémarré avant, l'utilisateur ne le voyait jamais
- **Modifié** : `src/index.ts`
  - Ajout `simTracker.printSummary()` immédiatement au démarrage
  - Ajout `setTimeout` 1 minute pour le premier graphique (au lieu d'attendre 5 min)
  - Maintien du `setInterval` toutes les 5 min pour les affichages suivants

---

## 2026-03-03 — Filtre précoce SELL sans position virtuelle (anti-flood)

### tradeExecutor.ts
- **Pourquoi** : Quand un trader liquide son portfolio (65+ SELLs), le bot floodait avec "No virtual position to sell" pour chaque trade — un log complet par trade avec fetch positions, copy delay, etc.
- **Modifié** : `src/services/tradeExecutor.ts`
  - Import de `getSimulationTracker` depuis `simulationBalance`
  - Dans `doTrading()` : filtre précoce pour les SELL en DRY_RUN sans position virtuelle → marqués `bot:true` sans aucun log
  - Log récapitulatif unique après la boucle : "⏭ N SELL ignoré(s) — pas de position virtuelle"

---

## 2026-03-03 — Exécution instantanée : désactivation agrégation + copy delay

### .env
- **Pourquoi** : L'agrégation (300s) causait un délai de 5 min avant d'exécuter. Avec FIXED_TOKENS à 10 tokens, pas besoin d'aggréger — chaque trade s'exécute immédiatement
- **Modifié** : `.env`
  - `TRADE_AGGREGATION_ENABLED` : `true` → `false`
  - `SIMULATION_COPY_DELAY_ENABLED` : `true` → `false`
  - Cooldown par trader+marché inchangé (déjà correct)

---

## 2026-03-03 — Fix race condition stale trades au démarrage

### tradeMonitor.ts + index.ts
- **Pourquoi** : Au redémarrage sans reset, tradeExecutor démarrait en même temps que tradeMonitor et trouvait tous les trades bot:false avant que isFirstRun finisse → flood de "stale trade"
- **Modifié** : `src/services/tradeMonitor.ts`, `src/index.ts`
  - Export de `firstRunComplete: Promise<void>` depuis tradeMonitor, résolu quand isFirstRun se termine
  - index.ts : `await firstRunComplete` entre le lancement de tradeMonitor et tradeExecutor

---

## 2026-03-02 — Mise à jour traders : 19 → 63 (2e run findCopyableTraders)

### .env
- **Pourquoi** : 2e run du script (60 min, 150 traders) a trouvé 61 qualifiés → on les applique tous + 2 conservés
- **Modifié** : `.env`
  - USER_ADDRESSES : 19 → 63 traders (61 qualifiés depuis `data/copyable_traders.txt` + anoin123 + 0x998154)
  - Commentaires mis à jour avec top traders et P&L

---

## 2026-03-01 — Ajout de 13 nouveaux traders + export fichier

### .env + findCopyableTraders.ts
- **Pourquoi** : 42 traders stables trouvés — on les ajoute (en gardant les 6 existants)
- **Modifié** : `.env`, `src/scripts/findCopyableTraders.ts`
  - USER_ADDRESSES : 6 → 19 traders (6 anciens + 13 nouveaux top qualifiés)
  - Script : supprime la limite top-15 → affiche TOUS les qualifiés avec adresse complète
  - Script : export automatique → `data/copyable_traders.txt` avec USER_ADDRESSES complet
  - Import `fs` et `path` ajoutés

---

## 2026-02-28 — Fix critique : CLOB vide = stable (pas un rejet)

### findCopyableTraders.ts — Logique de stabilité corrigée
- **Pourquoi** : 0/150 traders qualifiaient car "CLOB vide" était traité comme un REJET alors que l'absence de trades 30min après l'entrée signifie que le marché est CALME = pas de spike = stable ✅
- **Modifié** : `src/scripts/findCopyableTraders.ts`
  - `laterPrice === null` → compte comme `stableTrades++` au lieu de `continue`
  - Check `entryPrice` déplacé AVANT la requête CLOB (économise des appels API)
  - `STABILITY_WINDOW_S` étendu de 120s à 600s (fenêtre 10min pour marchés peu liquides)
  - Compteur `jumpCount` séparé pour la moyenne
  - Message d'erreur mis à jour : "0 trade exploitable — prix déjà ≥$0.95"

---

## 2026-02-27 — Suppression du filtre court-terme dans l'analyse des traders

### findCopyableTraders.ts — Critères assouplis
- **Pourquoi** : le filtre `isShortTerm()` (slug pattern) rejetait des traders valides. L'utilisateur a confirmé que le TYPE de marché importe peu — seul le test de stabilité (prix +30min) doit filtrer.
- **Modifié/Créé** : `src/scripts/findCopyableTraders.ts`
  - Suppression de `longTermBuys` / `isShortTerm()` dans `analyzeTrader()`
  - Remplacement par `recentBuys` (tous les BUYs récents, tous marchés)
  - Suppression du champ `shortTermSkipped` de l'interface `TraderResult` et de l'affichage
  - Le filtre `isShortTerm` reste pour la DÉCOUVERTE de marchés (Phase 1) uniquement

---

## 2026-02-27 — Script de recherche de traders copiables (stabilité de prix)

### findCopyableTraders.ts
- **Pourquoi** : après 4+ jours sans aucune position copiée, tous les traders actifs tradent sur des marchés qui spikent à $0.99 en moins de 30s après leur entrée (Iran, fin de mois). Le script trouve des traders dont les entrées RESTENT stables 30 min après.
- **Modifié/Créé** : `src/scripts/findCopyableTraders.ts` (nouveau), `package.json`
  - Phase 1 : Scan des marchés actifs long-terme → collecte d'adresses
  - Phase 2 : Pour chaque trader, vérifie le prix CLOB 30 min après chaque BUY récent
  - Score composite : 50% stabilité + 30% profit + 20% activité
  - Ignore automatiquement les marchés "by-[date]" et "end-of-[month]"
  - Affiche le classement + la config USER_ADDRESSES recommandée
  - Commande : `npm run find-copyable [nb_marchés] [nb_traders]`

---

## 2026-02-26 — Affichage du prix CLOB au moment du trade du trader (live logs)

### Diagnostic trade frais vs stale
- **Pourquoi** : dans les logs `trader: $0.55 → current: $0.99`, impossible de savoir si le trader a VRAIMENT acheté à $0.55 récemment ou si c'est un trade ancien. La nouvelle ligne montre le prix CLOB dans les ±60s autour du trade du trader.
- **Modifié/Créé** : `src/utils/postOrder.ts`
  - Ajout de la fonction `logMarketPriceAtTraderTime()` : interroge `clob.polymarket.com/trades?token_id=X&after=T-60&before=T+60`
  - Appel dans le chemin DRY_RUN BUY et real BUY après le price check
  - Affiche : `✅ confirmé — trade frais` ou `⚠️ différent — trade ancien ou avg price`

---

## 2026-02-25 — Ajout de 4 traders marchés lents (géopolitique/crypto/IA)

### Mise à jour USER_ADDRESSES — 7 traders total
- **Pourquoi** : hioa (sports in-play) impossible à copier. Ajout de traders sur marchés lents pour combler les périodes sans sport.
- **Modifié/Créé** : `.env`
  - Retiré : hioa (0xccb290) — in-play UCL, $0.59→$0.99 en quelques min
  - Conservé : gatorr, everton4life, gmpm
  - Ajouté : SwissMiss (géopolitique ROI 389%), anoin123 ($1.16M all-time), AssuredAdverts (IA/politique ROI 225%), EscalateFund (crypto/Trump ROI 325%)

---

## 2026-02-25 — Script d'analyse du délai de prix (checkPriceDelay)

### Nouvel outil : check-delay
- **Pourquoi** : quantifier le "late entry problem" — savoir à quel point le prix a bougé entre l'entrée du trader et le moment où le bot peut copier
- **Modifié/Créé** : `src/scripts/checkPriceDelay.ts`, `package.json`
  - Récupère les derniers BUY de chaque trader en MongoDB
  - Pour chaque trade, appelle le CLOB /trades X secondes après le timestamp du trader
  - Compare prix trader vs prix marché X secondes plus tard
  - Affiche taux de blocage réel et mouvement moyen

---

## 2026-02-24 — Remplacement des traders suivis

### Mise à jour USER_ADDRESSES
- **Pourquoi** : les anciens traders (0x6bab, 0x7c3d, etc.) achetaient quasi-exclusivement des marchés à $0.99+ (quasi-résolus), bloquant 100% des trades. Nouveaux traders sélectionnés pour win rate élevé, entrées précoces (< $0.70) et diversité des marchés.
- **Modifié/Créé** : `.env`
  - Ancien : 0x7c3d, 0xdd22, 0x6bab, 0x6770
  - Nouveau : gatorr (WR~92%), everton4life (WR~80%), gmpm (WR~68%), hioa (WR~48% esport)

---

## 2026-02-24 — Fix graphique balance : n'affichait plus après redémarrage sans positions

### Fix snapshot manquant pour le graphique
- **Pourquoi** : `balanceHistory` est en mémoire uniquement (non persisté). Au redémarrage, il démarre avec 1 seul snapshot. Le graphique requiert ≥ 2 snapshots. `updateMarkToMarket()` ajoute un snapshot uniquement s'il y a des positions ouvertes — donc sans position (ex. après reset), le graphique restait bloqué sur "Not enough data" indéfiniment.
- **Modifié** :
  - [src/utils/simulationBalance.ts](src/utils/simulationBalance.ts) — `recordSnapshot()` rendue publique (était `private`)
  - [src/index.ts](src/index.ts) — Appel `simTracker.recordSnapshot()` ajouté au début de l'intervalle d'affichage toutes les 5 min, avant `printSummary()` et `generateChart()`
- **Limite** : Non testé après un redémarrage avec 0 position. Le graphique ne montrera qu'une ligne plate si aucun trade ne se produit, mais au moins il s'affichera.

## 2026-02-24 — Réduction intervalle détection ventes manquées : 15 min → 5 min

### Intervalle de vérification des positions abandonnées
- **Pourquoi** : L'utilisateur voulait une détection plus rapide des ventes manquées.
- **Modifié** : [src/scripts/analyzePositionAlignment.ts](src/scripts/analyzePositionAlignment.ts)
  - `setInterval` passé de `15 * 60 * 1000` à `5 * 60 * 1000`
  - Logs de démarrage mis à jour ("every 5 min")

---

## 2026-02-23 — Fix ventes manquées : bug postOrder + grace period + intervalle

### 3 correctifs dans analyzePositionAlignment.ts
- **Pourquoi** : Le mécanisme d'auto-vente des positions abandonnées existait mais avait 3 bugs qui le rendaient inefficace : (1) en mode réel, l'ordre était signé mais jamais soumis ; (2) le délai de grâce de 3h était trop long (une position ouverte depuis 2h et abandonnée par le trader ne serait pas vendue même après redémarrage) ; (3) la vérification toutes les heures détectait les ventes manquées trop tard.
- **Modifié** : [src/scripts/analyzePositionAlignment.ts](src/scripts/analyzePositionAlignment.ts)
  - **Bug réel mode** : Ajout de `clobClient.postOrder(signedOrder, OrderType.FOK)` après `createMarketOrder`. Sans ça, l'ordre était signé en mémoire mais jamais envoyé à Polymarket.
  - **Grace period** : Réduit de 3h à 30 min (`POSITION_GRACE_PERIOD_HOURS = 0.5`). 30 min est suffisant pour la propagation API.
  - **Intervalle** : Réduit de 60 min à 15 min. Les ventes manquées sont maintenant détectées en moins de 15 min plutôt qu'en moins d'une heure.
  - Le sell en mode réel utilise maintenant le vrai prix de l'order book (meilleur bid) au lieu de `avgPrice`.
- **Limite** : Non testé en mode réel. Le sell simulation utilise encore `avgPrice` (pas le bid actuel) — cosmétique pour le DRY_RUN.

## 2026-02-23 — Fix mode réel : FIXED_TOKENS sans protection prix marché actuel

### Protection prix actuel pour stratégie FIXED_TOKENS
- **Pourquoi** : En mode réel, `checkPriceAcceptable` était appelé uniquement avec `trade.price` (le prix auquel le trader avait acheté, ex: $0.04). Si le marché avait depuis monté à $0.95, la stratégie FIXED_TOKENS achetait quand même à $0.95 sans aucune vérification, car elle saute le bloc `checkSlippageAllowed` réservé aux autres stratégies.
- **Modifié** : [src/utils/postOrder.ts](src/utils/postOrder.ts)
  - Dans la branche FIXED_TOKENS (dans la boucle d'achat), avant de calculer `orderSize`, ajout d'un appel à `checkPriceAcceptable(currentAskPrice)` avec le prix actuel de l'ask.
  - Si le prix actuel dépasse `MAX_BUY_PRICE` ou que le gain potentiel est insuffisant, le trade est annulé et marqué `bot: true` sans passer d'ordre.
- **Limite** : Non testé en conditions réelles (nécessite un trade FIXED_TOKENS sur un marché quasi-résolu). La logique est identique à celle déjà utilisée pour les autres vérifications de prix.

## 2026-02-23 — Fix simulation : trade annulé mais argent déjà déduit + fallback prix

### Fix Bug 1 : prix vérifié AVANT exécution (simulationExecutor)
- **Pourquoi** : `executeSimulatedTrade()` déduisait l'argent et créait la position, PUIS `postOrder.ts` vérifiait si le prix était acceptable → message "Trade annulé" dans les logs, mais l'argent était déjà parti et la position déjà créée. Conséquence observée : -37% de perte en simulation sur une après-midi avec 15 positions ouvertes à $0.99 irrécupérables.
- **Modifié** : `src/utils/simulationExecutor.ts`
  - Ajout d'un check `fillResult.avgPrice >= MAX_BUY_PRICE` AVANT l'appel à `simTracker.buyWithOrderBook()`
  - Si le prix est inacceptable → retourne `{ success: false }` immédiatement, sans toucher la balance ni créer de position
  - **Non testé en production** — à surveiller au prochain run pour confirmer que "Trade annulé" n'apparaît plus avec des positions fantômes

### Fix Bug 2 : fallback prix mark-to-market (simulationBalance)
- **Pourquoi** : quand le fetch d'un asset échoue lors du mark-to-market, le code tombait sur `avgPrice` (prix d'entrée). Pour une position achetée à $0.99 dont le fetch échoue, le P&L affiché serait 0% au lieu de la vraie valeur. Trompeur pour analyser les pertes.
- **Modifié** : `src/utils/simulationBalance.ts`
  - Ajout d'une `Map<string, number> lastKnownPrices` mise à jour à chaque fetch réussi
  - Fallback chain : `markToMarketPrices ?? lastKnownPrices ?? avgPrice`
  - **Impact limité** : n'affecte que le cas "1 failed" dans les logs — n'empêche pas les vraies pertes

---

## 2026-02-23 — Fix bug démarrage : trades anciens copiés au boot

### Fix séquence premier démarrage (tradeMonitor) — v2
- **Pourquoi** : race condition entre tradeMonitor et tradeExecutor. `fetchTradeData()` sauvait les trades avec `bot: false`, l'executor les lisait avant que `updateMany` ait le temps de les marquer comme traités → 100+ vieux trades (137-200h) traités au démarrage avec spam de logs.
- **Modifié** : `src/services/tradeMonitor.ts`
  - `fetchTradeData()` sauve directement `bot: isFirstRun` et `botExcutedTime: isFirstRun ? 999 : 0`
  - Pendant l'init, les trades sont insérés comme déjà traités dès le départ → plus de race condition
  - Log "New trade detected" supprimé pendant l'init pour éviter le spam de 100+ lignes

---

## 2026-02-19 — Délai de copie réaliste + analyse réalisme simulation

### Implémentation délai de copie réaliste (5-15s)
- **Pourquoi** : La simulation exécutait instantanément au même prix que le trader, alors qu'en réel il y a 5-15 secondes de délai (polling MongoDB → fetch order book → exécution). Pendant ce temps, le prix a déjà bougé (front-running). La simulation était **trop optimiste**.
- **Modifié** : `src/config/env.ts`
  - Ajout `SIMULATION_COPY_DELAY_ENABLED`, `SIMULATION_COPY_DELAY_MIN`, `SIMULATION_COPY_DELAY_MAX`
- **Modifié** : `src/utils/simulationExecutor.ts`
  - Délai aléatoire entre MIN et MAX (défaut: 5-15s) simulé avant exécution
  - Fetch du carnet d'ordres **actuel** après le délai (pas le prix historique du trader)
  - Log du mouvement de prix : `📊 Price movement: +2.63% (trader: $0.5100 → current: $0.5234)`
  - Vérification de la liquidité (no asks/bids → trade fail)
  - Slippage calculé sur le prix actuel, pas le prix historique
- **Modifié** : `.env`
  - Configuration complète du réalisme simulation (REALISTIC mode, copy delay, slippage max, partial fill strategy)

### Analyse complète du réalisme simulation
- **Créé** : `docs/SIMULATION_REALISM_ANALYSIS.md`
  - État actuel vs trading réel : 7 écarts identifiés
  - Priorités : 3 critiques 🔴, 2 moyens 🟡, 2 faibles 🟢
  - Plan d'action en 3 phases (Quick Wins → Améliorations Majeures → Polish)
  - Métriques de validation pour comparer simulation vs réel
  - Configuration recommandée pour .env

**Impact attendu** : Écart simulation vs réel réduit de ~25% à ~8%.

---

## 2026-02-19 — Persistance état simulation + batching mark-to-market

### Blocage re-buy sur positions restaurées
- **Pourquoi** : Après redémarrage, les positions restaurées ne doivent pas être rachetées si les traders font un nouveau BUY sur le même marché.
- **Modifié** : `src/utils/simulationBalance.ts`
  - `restoredAssets: Set<string>` — peuplé lors de la restauration depuis le fichier
  - `isRestoredPosition(asset): boolean` — méthode publique
  - Quand une position restaurée est vendue et fermée → retirée du set (re-buy autorisé ensuite)
  - `reset()` : vide le set
- **Modifié** : `src/utils/postOrder.ts`
  - DRY_RUN BUY : skip si `simTracker.isRestoredPosition(trade.asset)` → `ℹ️ Skipping BUY — position already held from previous session`

### Fix persistance simulation (`simulation_state.json`)
- **Pourquoi** : `⚠️ [SIMULATION] No virtual position to sell` — le `SimulationBalanceTracker` était purement en mémoire. À chaque redémarrage du bot, les positions virtuelles étaient perdues. Quand les traders vendaient des positions achetées dans une session précédente, `simTracker.getPosition(trade.asset)` retournait `undefined`.
- **Modifié** : `src/utils/simulationBalance.ts`
  - Ajout de `SIMULATION_STATE_FILE = data/simulation_state.json`
  - Interface `SimulationState` : balance, startingBalance, totalFeesPaid, positions[], lastUpdated
  - Ajout `loadState()` : charge l'état depuis le fichier JSON au démarrage
  - Ajout `saveState()` : persiste l'état après chaque buy/sell
  - Constructeur modifié : si état sauvegardé existe → restaure balance + positions au lieu de repartir de zéro
  - `reset()` modifié : supprime le fichier `simulation_state.json` pour repartir proprement
  - Log au démarrage : `💾 Simulation state restored: $842.00 balance, 7 position(s) reloaded from disk`

### Fix batching mark-to-market (rate limit)
- **Pourquoi** : 24 requêtes parallèles à `/book?token_id=` → toutes rate-limitées → `📡 Mark-to-market: 0 positions updated, 24 failed`
- **Modifié** : `src/utils/simulationBalance.ts`
  - `updateMarkToMarket()` : remplacé `Promise.allSettled(tous)` par batches de 5 avec 150ms de délai entre chaque batch

---

## 2026-02-19 — Logs, position comparison & cooldown fixes

### Fichier de log rolling (`logs/bot.log`)
- **Pourquoi** : Les logs disparaissaient dans la console après quelques heures, impossible de voir ce qui s'était passé pendant la nuit.
- **Modifié** : `src/utils/logger.ts`
  - Ajout de `Logger.initLogFile()` : efface `logs/bot.log` et écrit `=== BOT STARTED ===` à chaque démarrage
  - Rolling automatique : toutes les 250 écritures, le fichier est trimé à 5000 lignes max (les plus anciennes supprimées)
  - Fichier unique `bot.log` (pas de fichier daté) pour ouvrir facilement dans VS Code
- **Modifié** : `src/index.ts`
  - Appel `Logger.initLogFile()` au démarrage, juste avant `Logger.startup()`

### Live Position Comparison — prix en temps réel
- **Pourquoi** : La méthode utilisait `traderPos.curPrice` de l'API Polymarket qui peut être délayé, pas les prix vrais du marché.
- **Modifié** : `src/utils/livePositionComparison.ts`
  - Nouvelle fonction `fetchRealTimePrice(asset)` : appelle `/book?token_id=` et retourne `(bid+ask)/2`
  - `comparePositions()` est maintenant `async` : fetch les prix réels en parallèle pour toutes les positions partagées
  - Priorité : prix order book (live) > curPrice API > avgPrice (fallback)
  - Affichage enrichi : `📡 live` vs `🕒 API` pour indiquer la source du prix
  - Calcul P&L trader et bot basé sur le prix live

### Cooldown SELL bypass
- **Pourquoi** : Le cooldown bloquait aussi les SELL du trader — si le trader vendait une position pendant le cooldown, le bot ne suivait pas.
- **Modifié** : `src/services/tradeExecutor.ts`
  - Ajout de `&& trade.side === 'BUY'` dans la condition du cooldown
  - Les SELL bypassent toujours le cooldown : si le trader sort, le bot suit immédiatement
  - BUY sur marché X → cooldown pour (trader, X). BUY sur marché Y → pas de cooldown.

---

## 2026-02-18 — Mark-to-market fix & price filter

### Fix mark-to-market (API midpoints cassée)
- **Pourquoi** : `📡 Mark-to-market: 0 positions updated, 26 failed` — l'endpoint `/midpoints?token_ids=...` retournait HTTP 400 pour tous les assets.
- **Modifié** : `src/utils/simulationBalance.ts`
  - `updateMarkToMarket()` : remplacé l'appel batch `midpoints` par des appels individuels `/book?token_id={asset}`
  - Calcul midpoint = `(best_bid + best_ask) / 2`
  - Requêtes parallèles avec `Promise.allSettled` pour ne pas perdre de performance
  - Résultat : les positions sont maintenant valorisées aux prix réels du marché

### Fix filtre de prix (gap entre prix trader et prix d'exécution)
- **Pourquoi** : Le filtre `checkPriceAcceptable()` vérifiait `trade.price` (prix historique du trader, ex: $0.27 pour Iran) mais `executeSimulatedTrade` en mode REALISTIC fetchait le carnet actuel et exécutait à $0.99 — contournant complètement le filtre.
- **Modifié** : `src/utils/postOrder.ts`
  - Ajout d'un second `checkPriceAcceptable(result.avgPrice)` après `executeSimulatedTrade`
  - Si le prix d'exécution réel ≥ `MAX_BUY_PRICE` ($0.95) → trade annulé avec log explicite
  - Message : `🚫 prix d'exécution réel inacceptable: $0.9900 ≥ MAX_BUY_PRICE $0.9500 (trader avait acheté à $0.2700)`

---

## 2026-02-18 — Analyse des pertes & métriques de qualité

### Suppression DrPufferfish + fix filtre TOO_OLD_TIMESTAMP
- **Pourquoi** : DrPufferfish achetait des long shots historiques à $0.999 copiés des mois plus tard. TOO_OLD_TIMESTAMP était cassé : comparait des secondes Unix (~1 771 000 000) avec la valeur `1` (heures), donc toujours false.
- **Modifié** : `.env`
  - Suppression de `0xdb27bf2ac5d428a9c63dbc914611036855a6c56e` (DrPufferfish)
- **Modifié** : `src/services/tradeMonitor.ts`
  - Fix : `cutoffTimestamp = Math.floor(Date.now() / 1000) - TOO_OLD_TIMESTAMP * 3600`
- **Modifié** : `src/services/tradeExecutor.ts`
  - Même fix + log explicite : `⛔ Skipping stale trade (3.2h old, limit: 1h)`

### Métriques de qualité : délai de copie + spread
- **Pourquoi** : Impossible de savoir si le bot copiait rapidement ou non, ni quel était le spread réel entre le prix du trader et le prix d'exécution.
- **Modifié** : `src/models/userHistory.ts`
  - Ajout du champ `executedAt: Number` (Unix ms, moment exact d'exécution du bot)
- **Modifié** : `src/services/tradeExecutor.ts`
  - Log du délai de copie : `⚡ Copy delay: 12s (trader executed at 14:32:05)`
  - Sauvegarde de `executedAt: Date.now()` dans MongoDB à l'exécution
- **Modifié** : `src/utils/postOrder.ts`
  - Affichage spread toujours visible (pas seulement quand >1%) : `✅ Spread: +0.52%`
- **Créé** : `src/scripts/tradeQualityReport.ts`
  - Rapport : délai moyen par trader, concentration, recommandations
  - Commande : `npm run quality-report`
- **Modifié** : `package.json`
  - Ajout `"quality-report": "ts-node src/scripts/tradeQualityReport.ts"`

### Fix virgule manquante dans USER_ADDRESSES
- **Pourquoi** : Édition manuelle du `.env` avait mis un espace à la place d'une virgule entre deux adresses → `Invalid Ethereum address` au démarrage.
- **Modifié** : `.env`
  - `0xdd225a03...1ef1 0x6bab41a0...` → `0xdd225a03...1ef1, 0x6bab41a0...`

---

## Sessions antérieures (résumé)

### Création du bot copy-trading de base
- Architecture : `tradeMonitor.ts` (polling MongoDB) + `tradeExecutor.ts` (logique de copie) + `postOrder.ts` (exécution)
- Mode simulation (DRY_RUN) avec `simulationBalance.ts`
- Stratégies : PERCENTAGE, FIXED, ADAPTIVE, FIXED_TOKENS
- Position tracker persistant (`data/positions.json`)

### Fonctionnalités ajoutées au fil du temps
- Trader cooldown par trader+marché (`traderCooldown.ts`)
- Agrégation de trades (`TRADE_AGGREGATION_ENABLED`)
- Circuit breaker (`logAnalyzer.ts`)
- Auto-sell positions stale (`closeStalePositions.ts`)
- Mark-to-market simulation (`simulationBalance.updateMarkToMarket`)
- Graphique ASCII balance evolution (`generateChart`)
- Rapport HTML simulation (`reportGenerator.ts`)
- Live position comparison bot vs traders (`livePositionComparison.ts`)
- Simulation réaliste order book (`orderBookSimulator.ts` + `simulationExecutor.ts`)

---
