# VIBE HISTORY — Polymarket Copy Trading Bot

Chaque entrée = une session de vibe coding.
Les modifications sont listées du plus récent au plus ancien.

## 2026-04-21 — Fix limit orders achetaient à $0.99 (plafond MAX_BUY_PRICE)

### limitPrice maintenant plafonné à MAX_BUY_PRICE - 0.01
- **Pourquoi** : avec 50% de tolérance, traderPrice $0.66 × 1.50 = $0.99 → le watcher achetait exactement à $0.99, causant des entrées à $0.9900 avec ~1% de gain potentiel max. Les 19 positions actuelles ont toutes une entry à $0.99 pour cette raison
- **Modifié** : `src/utils/simulationExecutor.ts`
  - Calcul : `limitPrice = Math.min(traderPrice × 1.50, MAX_BUY_PRICE - 0.01)` = `$0.97` max
  - Si `limitPrice <= traderPrice` (trader déjà trop proche du max) → refus immédiat, pas de limit order inutile
  - Double protection dans le watcher : `currentAsk < ENV.MAX_BUY_PRICE` avant d'exécuter
- **Modifié** : `data/pending_limit_orders.json`
  - 159 ordres existants recalculés (7 plafonnés à $0.97)

## 2026-04-20 — Limit order tolerance +15% → +50%

### Augmentation de la tolérance de prix pour les limit orders
- **Pourquoi** : à +15%, les limit orders ne se remplissent presque jamais — le marché ne revient pas à traderPrice×1.15 après un choc whale. À +50%, le bot peut acheter quand le book revient partiellement (ex: trader à $0.33 → bot accepte jusqu'à $0.495)
- **Modifié** : `src/utils/simulationExecutor.ts`
  - `LIMIT_ORDER_PRICE_TOLERANCE` : 0.15 → 0.50
- **Modifié** : `data/pending_limit_orders.json`
  - 183 ordres existants recalculés : limitPrice = traderPrice × 1.50
- **Risque** : prix d'entrée plus élevé = gain potentiel réduit, mais mieux que jamais entrer

## 2026-04-20 — Fix bug "BUY executed" factice / positions fantômes

### Les limit orders en attente ne devaient pas logger "BUY executed" ni trackBuy()
- **Pourquoi** : `executeSimulatedTrade` retourne `{success: true, executed: false}` pour les limit orders en queue. Mais `postOrder.ts` vérifiait seulement `result.success` pour logger "BUY executed" et appeler `tracker.trackBuy()`. Résultat : 183 positions dans positionTracker, 14 en simulation, balance ne bougeait jamais, confusion totale
- **Modifié** : `src/utils/postOrder.ts`
  - Ajout vérification `if (!result.executed) return` avant le log "BUY executed" et trackBuy()
  - Ajout log `⏳ BUY queued as limit order` pour clarifier
  - Passe `tradeMeta` (conditionId, title, outcome, eventSlug) à `executeSimulatedTrade`
- **Modifié** : `src/utils/simulationExecutor.ts`
  - `PendingLimitOrder` enrichi avec conditionId, title, outcome, userAddress, eventSlug
  - `executeOrderBookMode` accepte `userAddress` et `tradeMeta` et les injecte dans le limit order
  - Le watcher appelle maintenant `tracker.trackBuy()` quand un limit order se remplit réellement
- **À tester** : vérifier que les positions en simulation augmentent quand le book revient à un prix acceptable

## 2026-04-17 — Persistance des limit orders sur disque

### Limit orders survivent aux redémarrages du bot
- **Pourquoi** : `pendingLimitOrders` était un tableau en RAM — tout redémarrage (même crash) effaçait tous les ordres en attente, causant des positions manquées
- **Modifié** : `src/utils/simulationExecutor.ts`
  - Ajout de `saveLimitOrders()` / `loadLimitOrders()` avec fichier `data/pending_limit_orders.json`
  - Sauvegarde à chaque ajout/suppression d'ordre
  - Chargement au démarrage avec filtrage automatique des ordres expirés
  - Watcher redémarre automatiquement si des ordres restaurés existent (délai 5s)
  - `getPendingLimitOrdersCount()` exportée pour affichage dans le summary
- **Modifié** : `src/utils/simulationBalance.ts`
  - `printSummary()` affiche maintenant le nombre de limit orders en attente
- **À tester** : redémarrer le bot avec des limit orders actifs et vérifier qu'ils persistent

## 2026-04-11 — Fix fuite mémoire sessions longues

### Cap balanceHistory + nettoyage maps de prix après sell
- **Pourquoi** : `balanceHistory` grossissait sans limite (~8600 entrées/mois), `lastKnownPrices` et `markToMarketPrices` conservaient les entrées après fermeture de position
- **Modifié** : `src/utils/simulationBalance.ts`
  - `recordSnapshot()` : plafond à 2000 entrées (slice -2000)
  - `sell()` et `sellWithOrderBook()` : `markToMarketPrices.delete()` + `lastKnownPrices.delete()` quand position fermée
  - Node.js ne crashera plus en mémoire sur plusieurs semaines de fonctionnement

## 2026-04-11 — Ajout trader 0xc8075693...

### Nouveau trader ajouté à USER_ADDRESSES
- **Pourquoi** : l'utilisateur souhaite copier ce nouveau trader
- **Modifié** : `.env`
  - Ajout de `0xc8075693f48668a264b9fa313b47f52712fcc12b` à la fin de `USER_ADDRESSES` (18 traders au total)

## 2026-04-11 — Ajout trader 0xb6d6e99d...

### Nouveau trader ajouté à USER_ADDRESSES
- **Pourquoi** : l'utilisateur souhaite copier ce nouveau trader
- **Modifié** : `.env`
  - Ajout de `0xb6d6e99d3bfe055874a04279f659f009fd57be17` à la fin de `USER_ADDRESSES` (17 traders au total)

## 2026-04-11 — Ajout trader 0x019782ca...

### Nouveau trader ajouté à USER_ADDRESSES
- **Pourquoi** : l'utilisateur souhaite copier ce nouveau trader
- **Modifié** : `.env`
  - Ajout de `0x019782cab5d844f02bafb71f512758be78579f3c` à la fin de `USER_ADDRESSES` (16 traders au total)

## 2026-04-11 — Ajout trader 0xd7375270...

### Nouveau trader ajouté à USER_ADDRESSES
- **Pourquoi** : l'utilisateur souhaite copier ce nouveau trader
- **Modifié** : `.env`
  - Ajout de `0xd7375270e4769d3cc31885773070a5f12d5bbe95` à la fin de `USER_ADDRESSES` (15 traders au total)

## 2026-04-07 — Ajout trader 0xa4b366ad...

### Nouveau trader ajouté à USER_ADDRESSES
- **Pourquoi** : l'utilisateur souhaite copier ce nouveau trader
- **Modifié** : `.env`
  - Ajout de `0xa4b366ad22fc0d06f1e934ff468e8922431a87b8` à la fin de `USER_ADDRESSES` (14 traders au total)

## 2026-04-10 — Liens Polymarket dans le summary des positions

### eventSlug stocké dans TrackedPosition + lien affiché dans printSummary
- **Pourquoi** : impossible de savoir quel marché correspond à quelle position sans ouvrir Polymarket manuellement
- **Modifié** : `src/utils/positionTracker.ts`
  - Ajout `eventSlug?: string` dans `TrackedPosition`
  - Ajout paramètre `eventSlug?` dans `trackBuy()`
  - Ajout méthode `getPositionByAsset(asset)` pour lookup par tokenId
- **Modifié** : `src/utils/postOrder.ts` — passe `trade.eventSlug` aux deux appels `trackBuy()`
- **Modifié** : `src/utils/simulationBalance.ts` — `printSummary()` affiche `🔗 https://polymarket.com/event/{eventSlug}` sous chaque position si disponible

## 2026-04-10 — Auto-sell positions quasi-résolues YES (prix ≥ $0.995)

### Auto-sell dans updateMarkToMarket
- **Pourquoi** : les positions à $0.9995 (marché quasi-résolu YES) restaient bloquées indéfiniment — le bot attendait que les traders vendent d'abord, mais les traders laissent souvent tourner jusqu'à la résolution officielle. La balance stagnait et le capital était immobilisé.
- **Modifié** : `src/utils/simulationBalance.ts`
  - Dans `updateMarkToMarket()`, après chaque mise à jour de prix réussie, si `midpoint >= 0.995` → auto-sell immédiat au prix actuel
  - Seuil 0.995 choisi pour : vendre $0.9995 (résolu) mais PAS les positions à $0.9350/$0.9050 (marchés actifs en baisse)
  - Les positions achetées à $0.99 avec MtM à $0.99 exactement ne déclenchent pas l'auto-sell (leur MtM oscille sous 0.995 tant que le marché est actif)

## 2026-04-07 — Fix limit order watcher ignorait les assets à prix moyen/élevé

### Suppression ratio > 2.0 + vérification gamma-api sur chemin spread non-extrême
- **Pourquoi** : les trades avec prix trader ≥ ~$0.50 (ex: $0.70, $0.91) tombaient dans `simulateOrderBookFill` au lieu du limit order watcher — `currentBestPrice / traderPrice > 2.0` trop restrictif (ask $0.99 / trader $0.70 = 1.41). De plus le chemin "spread non-extrême" queued sans vérifier gamma-api — risque de queuer sur marché résolu
- **Modifié** : `src/utils/simulationExecutor.ts`
  - Suppression de `currentBestPrice / traderPrice > 2.0`
  - Ajout `isMarketResolved()` avant le push dans le chemin spread non-extrême (comme dans le chemin extrême)

## 2026-04-07 — Fix race condition : vieux trades reprocessés au démarrage

### BOT_START_TIMESTAMP comme filtre permanent dans readTempTrades
- **Pourquoi** : au démarrage, le bot voyait des dizaines de trades avec 3-55min de retard ("🐢 REST API seul") malgré le purge initial. Race condition : tradeMonitor insère des trades dans MongoDB APRÈS que le purge s'est exécuté → ils passent à travers car `readTempTrades` n'utilisait qu'un cutoff glissant (`TOO_OLD_TIMESTAMP`)
- **Modifié** : `src/services/tradeExecutor.ts`
  - `BOT_START_TIMESTAMP` déplacé au niveau module (calculé à l'import, avant toute connexion)
  - `readTempTrades()` : `cutoffTimestamp = Math.max(rollingCutoff, BOT_START_TIMESTAMP)` — aucun trade antérieur au lancement ne peut plus passer, même en cas de race condition
  - Suppression de la déclaration locale redondante dans `runTradeExecutor()`

## 2026-04-07 — Limit order watcher : timeout 5min → 3 jours, check 8s → 5min

- **Pourquoi** : aucun trade en 3 jours car les limit orders expiraient après 5min avant que les market makers reviennent
- **Modifié** : `src/utils/simulationExecutor.ts`
  - `LIMIT_ORDER_TIMEOUT_MS` : 5min → 3 jours
  - `LIMIT_ORDER_CHECK_INTERVAL_MS` : 8s → 5min (évite de bombarder l'API sur 3 jours)

## 2026-04-04 — Fix arrêt bot bloqué par limit order watcher

### stopLimitOrderWatcher() sur SIGINT
- **Pourquoi** : le watcher tournait en boucle async et empêchait le bot de s'arrêter sur Ctrl+C
- **Modifié** : `src/utils/simulationExecutor.ts` — ajout `stopLimitOrderWatcher()` (vide la queue + flag stop), boucle vérifie `!limitOrderWatcherStopped`
- **Modifié** : `src/index.ts` — import + appel `stopLimitOrderWatcher()` avant `process.exit(0)` dans le handler SIGINT

## 2026-04-04 — Fix rejectedAssetCache bloquait les limit orders

### Suppression du cache de rejet pour les marchés illiquides
- **Pourquoi** : `rejectAsset()` était appelé dès qu'un ask était trop élevé → les trades suivants sur le même token étaient ignorés pendant 10min avec "Ask trop élevé (rejeté <10min)", empêchant le limit order watcher de fonctionner
- **Modifié** : `src/utils/postOrder.ts`
  - Supprimé l'appel à `rejectAsset(_asset)` — remplacé par commentaire explicatif
- **Modifié** : `src/utils/simulationExecutor.ts`
  - Ajout check anti-doublon avant chaque `pendingLimitOrders.push` : si un limit order existe déjà pour cet asset, on retourne sans en ajouter un deuxième

## 2026-04-04 — Startup cutoff + TOO_OLD_TIMESTAMP à 1h

### Ignorer le passé au démarrage, surveiller 1h pendant l'exécution
- **Pourquoi** : TOO_OLD_TIMESTAMP=0.01h (36s) faisait expirer les limit orders en attente avant que les market makers reviennent. Augmenter à 1h permet de surveiller les books. Mais on ne veut pas acheter des trades d'avant le lancement.
- **Modifié** : `src/services/tradeExecutor.ts`
  - Startup purge : remplace `now - TOO_OLD_TIMESTAMP` par `BOT_START_TIMESTAMP = now` → tout le passé est ignoré au démarrage
  - Log changé de warning en info (normal behavior)
- **Modifié** : `.env`
  - `TOO_OLD_TIMESTAMP` : `0.01` → `1` (1 heure)

## 2026-04-04 — Limit order watcher : achat réel quand market makers reviennent

### Surveillance book post-whale pour marchés illiquides actifs
- **Pourquoi** : au lieu de simuler un fill fictif immédiat @ prix trader, le bot enregistre un limit order et surveille le book toutes les 8s — quand l'ask redescend ≤ prix_trader × 1.15, l'achat s'exécute au prix réel
- **Modifié** : `src/utils/simulationExecutor.ts`
  - Ajout `PendingLimitOrder` interface + `pendingLimitOrders[]` queue
  - Ajout `startLimitOrderWatcher()` — boucle async, démarre si pas déjà active
  - Tolérance : +15% au-dessus du prix trader (`LIMIT_ORDER_PRICE_TOLERANCE = 0.15`)
  - Timeout : 5 minutes (abandon si market makers ne reviennent pas)
  - Check interval : 8 secondes
  - Log `✅ LIMIT ORDER rempli après Xs` quand exécuté
  - Log `⏰ LIMIT ORDER expiré` si timeout
  - À tester : vérifier que le watcher s'arrête bien quand la queue est vide

## 2026-04-04 — Fix isDeadMarket : vérification gamma-api au lieu du spread seul

### Marché illiquide actif vs marché résolu — distinction correcte
- **Pourquoi** : le check `bid < 5¢ ET ask > 95¢` refusait les marchés actifs illiquides (whale vient de vider le book) autant que les marchés résolus — ex: 2028 election refusé alors qu'actif
- **Modifié** : `src/utils/simulationExecutor.ts`
  - Ajout `isMarketResolved(tokenId)` — appelle `gamma-api.polymarket.com/markets?clob_token_ids=` pour vérifier `closed` et `active`
  - Si token introuvable dans gamma → considéré résolu/invalide
  - Cache 5min pour éviter de re-fetcher à chaque trade sur le même asset
  - Spread extrême + marché résolu → refus ; spread extrême + marché actif → limit order simulé
  - Import `fetchData` ajouté

## 2026-04-04 — Filtre prix extrêmes (< 2¢ ou > 98¢)

### Refus des trades sur marchés quasi-résolus
- **Pourquoi** : le bot copiait des trades à 1¢ (marché résolu NO) et à 99¢ (marché résolu YES) — ces positions ne valent rien ou n'ont plus de gain possible
- **Modifié** : `src/services/tradeExecutor.ts`
  - Ajout filtre BUY avant exécution : `price < 0.02` → refus avec log `⛔ Prix trop bas`
  - Ajout filtre BUY : `price > 0.98` → refus avec log `⛔ Prix trop élevé`
  - Les SELL ne sont pas filtrés (on vend toujours si on a la position)
- **Note** : les 2 positions actuelles à 1¢ viennent de sessions précédentes — elles ont des tokenIds invalides qui causent aussi les échecs MtM

## 2026-04-04 — Retrait traders perdants + fix Mark-to-Market

### Fix #1 — Retrait 3 traders perdants
- **Pourquoi** : scores négatifs confirmés sur plusieurs semaines de trading
- **Modifié** : `.env`
  - Retiré `0x7744...999e` (score -19164, P&L réalisé -$19088)
  - Retiré `0x90ed...b5bc` (score -230, positions ouvertes -$37603)
  - Retiré `0xc097...5dea` (score -154, P&L -$96)
  - Passage de 16 → 13 traders suivis

### Fix #3 — Mark-to-Market : fallback gamma-api
- **Pourquoi** : 100% des MtM échouaient car spread CLOB > 0.80 (bid≈0.001/ask≈0.999) — tous les assets tombaient dans le cas "marché illiquide" sans fallback
- **Modifié** : `src/utils/simulationBalance.ts`
  - Ajout fonction `fetchGammaPrice(tokenId)` — interroge `gamma-api.polymarket.com/markets?clob_token_ids=` pour récupérer `outcomePrices`
  - En cas de spread > 0.80 sur CLOB → essaie gamma-api avant d'abandonner
  - Même fallback si CLOB ne répond pas du tout
  - À tester : vérifier que les prix gamma sont cohérents vs CLOB

## 2026-04-04 — Affichage prix marché pour chaque position dans les logs

### Prix actuel visible dans SIMULATION SUMMARY
- **Pourquoi** : le P&L et le prix actuel n'étaient affichés que si `hasMtM` était vrai (mark-to-market fonctionnel) — or MtM échoue souvent → ligne prix jamais visible
- **Modifié** : `src/utils/simulationBalance.ts`
  - Suppression du check `hasMtM` conditionnel
  - Affichage systématique du prix avec indicateur de source : 📡 live / ⏱ last known / 📌 entry price
  - Ligne P&L toujours affichée par position
  - Ligne total P&L toujours affichée en bas
  - Légende des icônes en pied de tableau

## 2026-04-04 — Refus des positions sur marchés résolus/morts

### Filtre marché mort (bid < 5¢ ET ask > 95¢)
- **Pourquoi** : le bot simulait des limit orders au prix du trader (ex: 5¢) sur des marchés avec bid=$0.001 / ask=$0.99 — ces positions ne valent rien et ne seraient jamais remplies en réel
- **Modifié** : `src/utils/simulationExecutor.ts`
  - Calcul de `currentBestBid` depuis le carnet d'ordres
  - Détection `isDeadMarket` : bid < 0.05 ET ask > 0.95
  - Si marché mort → `return { success: false }` avant de simuler le limit order
  - Le log affiche `Marché résolu/mort (bid $X / ask $Y) — limit order impossible`

## 2026-04-03 — Skip tentative API key CLOB en DRY_RUN

### Suppression erreur "Could not create api key" en simulation
- **Pourquoi** : en DRY_RUN, `createClobClient` tentait `createApiKey()` + `deriveApiKey()` inutilement → erreur CLOB 400 dans les logs à chaque démarrage
- **Modifié** : `src/utils/createClobClient.ts`
  - Ajout branche `else if (ENV.DRY_RUN)` → `creds = undefined` directement (pas de tentative auth)

## 2026-04-01 — Fix Telegram entity "[object Object]" dans chats filter

### Correction filtre NewMessage
- **Pourquoi** : `new NewMessage({ chats: [entity] })` passait l'objet entier → erreur répétée `Cannot find any entity corresponding to "[object Object]"`
- **Modifié** : `src/services/telegramWhaleMonitor.ts`
  - Extrait `entity.id` (BigInt) et passe `chatId` dans `chats` au lieu de l'objet entier

## 2026-03-31 — TOO_OLD_TIMESTAMP accepte les décimales

### Validation assouplie pour valeurs fractionnaires
- **Pourquoi** : valeur `0.01` dans `.env` rejetée par la validation `parseInt` + check `< 1` — impossible de tester avec un filtre de quelques secondes
- **Modifié** : `src/config/env.ts`
  - Validation : `parseInt` → `parseFloat`, condition `< 1` → `<= 0`
  - Déclaration ENVobjet : `parseInt` → `parseFloat`
  - Hotreload : `parseInt` → `parseFloat`
  - Message d'erreur mis à jour (« decimals allowed »)

## 2026-03-31 — Auto-kill instances bot au démarrage (predev/prestart)

### Fermeture automatique des instances existantes
- **Pourquoi** : il était possible de lancer plusieurs instances simultanément (`npm run dev` + `npm start`), ce qui divisait les messages Telegram entre les instances → alertes whale manquées
- **Créé** : `scripts/kill-bot.js`
  - Script Node.js (plain JS, pas ts-node) qui cherche les processus `node.exe` dont la commande contient `dist/index.js` ou `src/index.ts`
  - Les tue via `taskkill /PID ... /F /T` avant de démarrer le bot
  - Exclut le processus npm-cli lui-même pour ne pas se tuer
  - Pause 800ms après kill pour laisser MongoDB se fermer proprement
- **Modifié** : `package.json`
  - Ajout `"predev": "node scripts/kill-bot.js"` et `"prestart": "node scripts/kill-bot.js"`
- **Ce qui reste à tester** : vérifier que `npm run dev` affiche "[kill-bot] Instance bot tuée" si une instance tourne déjà, puis démarre normalement

## 2026-03-31 — Fix 3 bugs simulation : SELL illiquide, MtM, processingAssets

### Simulation SELL : fallback LIMIT ORDER pour marchés illiquides
- **Pourquoi** : quand un trader vend dans un marché peu liquide, les bids sont consommées → bid tombe à $0.001. Le bot copiait la vente à bid=$0.001 au lieu du prix réel du trader → slippage -94% à -99% en simulation (ex : NBA Champion vendu à $0.001 au lieu de $0.019)
- **Modifié** : `src/utils/simulationExecutor.ts`
  - Ajout d'un fallback "LIMIT ORDER SELL" dans `executeOrderBookMode` : si bid < 50% du prix du trader, simule la vente au prix du trader (même logique que le fallback BUY déjà en place)
  - Condition : `currentBestPrice / traderPrice < 0.5` (bid < moitié du prix trader)
  - **Ce qui reste à tester** : vérifier que les SELLs NBA Champion, Eurovision etc. s'exécutent maintenant au prix réel du trader

### Fix MtM : ne plus supprimer `lastKnownPrices` sur spread large
- **Pourquoi** : quand le spread > 0.80 (marché illiquide), le code supprimait aussi `lastKnownPrices`, effaçant le dernier bon prix connu → fallback systématique au prix d'entrée. Maintenant si un prix avait été obtenu avant que le marché devienne illiquide, il est conservé.
- **Modifié** : `src/utils/simulationBalance.ts`
  - Suppression de `this.lastKnownPrices.delete(asset)` dans le bloc spread > 0.80
  - **Ce qui reste à tester** : les 27 positions en marché illiquide continuent d'afficher "0 updated, 27 failed" (attendu car aucun bon prix n'a jamais été obtenu pour ces nouvelles positions)

### Fix processingAssets : `isAssetRejected` path ne libérait pas le verrou
- **Pourquoi** : quand un asset était dans `rejectedAssetCache` (Ask trop élevé <10min), le trade BUY quittait via `continue` sans appeler `processingAssets.delete` → l'asset restait verrouillé → messages "Déjà en cours de traitement" répétés à chaque batch sur le même marché
- **Modifié** : `src/services/tradeExecutor.ts`
  - Ajout de `processingAssets.delete(trade.asset)` avant le `continue` dans le bloc `isAssetRejected`

## 2026-03-30 — Fix simulation jamais exécutée (marchés illiquides + bugs processingAssets)

### Simulation : fallback mode LIMIT ORDER pour marchés illiquides
- **Pourquoi** : les whales achètent dans des marchés peu liquides. Leur achat consomme toutes les asks bon marché → le bot arrive quelques secondes plus tard et trouve ask=$0.99. Le filtre `MAX_BUY_PRICE=0.98` refusait correctement mais la simulation ne produisait JAMAIS d'achat, la rendant inutile.
- **Modifié** : `src/utils/simulationExecutor.ts`
  - Ajout d'un fallback "LIMIT ORDER" dans `executeOrderBookMode` : si ask ≥ MAX_BUY_PRICE ET ask > 2× prix du trader, simule l'exécution au prix du trader (comme si on avait placé un ordre limite)
  - Représente la réalité : un bot professionnel placerait un ordre limite au prix du trader qui se remplirait quand les teneurs de marché reviennent
- **Modifié** : `src/config/env.ts`
  - `SIMULATION_MAX_SLIPPAGE_PERCENT` défaut : 5% → 50% (5% était beaucoup trop strict pour le copy trading sur marchés prédiction)
  - Permet les cas où le prix monte 20-40% entre l'achat du trader et la détection bot

### Bug fix : `processingAssets` jamais nettoyé sur sorties anticipées
- **Pourquoi** : quand un trade BUY quittait via `continue` avant `postOrder` (trade trop vieux, cooldown, marché résolu, pas de position, filtre), l'asset restait bloqué dans le Set `processingAssets` pour toute la session → tous les trades futurs sur le même marché étaient bloqués avec "Déjà en cours de traitement"
- **Modifié** : `src/services/tradeExecutor.ts`
  - Ajout de `processingAssets.delete(trade.asset)` avant chaque `continue` anticipé (5 endroits)

### Fix telegramWhaleMonitor : ignorer les marchés fermés
- **Pourquoi** : `fetchCurrentPrice` itérait sur tous les sous-marchés d'un event, incluant les marchés `closed=true` ou `active=false` — leur book affiche bid=0.01 ask=0.99 (spread extrême faussement interprété comme prix réel)
- **Modifié** : `src/services/telegramWhaleMonitor.ts`
  - Ajout `if (market.closed || market.active === false) continue;` dans la boucle `fetchCurrentPrice`
- **Ce qui reste à tester** : vérifier que l'alerte Telegram affiche maintenant un prix cohérent avec les messages (25¢, 34¢, etc.)

## 2026-03-30 — Fix flood de trades anciens au démarrage

### Nettoyage post-firstRun pour éviter les trades "glissants"
- **Pourquoi** : au démarrage, le `firstRun` a un timeout de 60s — si les 16 traders ne sont pas tous fetché à temps, les trades manquants apparaissent comme "nouveaux" dès le premier cycle du loop. Avec `TOO_OLD_TIMESTAMP=24h` (défaut), des trades vieux de plusieurs heures passent.
- **Cause secondaire** : le blockchain monitor rate parfois des trades (`blockchain raté`), qui arrivent en retard via REST API après firstRun
- **Modifié** : `src/services/tradeMonitor.ts`
  - Ajout d'un `setTimeout(5s)` après `_resolveFirstRun()` qui fait un second `updateMany({ bot: false })` pour attraper les trades tardifs qui ont glissé pendant la race condition firstRun
  - Non-bloquant (arrière-plan), affiche le nombre de trades supplémentaires marqués

## 2026-03-30 — Fix connexion Telegram (connect() → start())

### Correction : le monitor Telegram ne recevait pas les messages
- **Pourquoi** : `client.connect()` établit la socket TCP mais ne valide pas la session MTProto — les messages n'étaient jamais reçus. Il faut `client.start()` qui authentifie la session existante.
- **Modifié** : `src/services/telegramWhaleMonitor.ts`
  - Remplacement de `client.connect()` par `client.start({...})` avec callbacks qui throw si session expirée
  - Ajout `client = null; running = false` dans le catch pour nettoyer l'état en cas d'erreur

## 2026-03-27 — Fetch prix actuel sur alerte Telegram whale

### Affichage du prix actuel du marché à la réception d'une alerte whale
- **Pourquoi** : l'utilisateur veut voir le prix actuel du marché quand une alerte Telegram arrive (pas seulement le prix du trader)
- **Modifié** : `src/services/telegramWhaleMonitor.ts`
  - Import de `fetchData`
  - Nouvelle fonction `fetchCurrentPrice(eventSlug, outcome)` : appelle `gamma-api.polymarket.com/events?slug=` pour récupérer les token_ids, puis `/book?token_id=` pour bid/ask
  - `handleMessage` appelle `fetchCurrentPrice` en arrière-plan et affiche `💲 Prix actuel — bid Xc / ask Xc / mid Xc (trader: Xc)`
- **À noter** : le fetch prix est async (non-bloquant), s'affiche quelques ms après l'alerte initiale — à tester sur de vraies alertes

## 2026-03-27 — Intégration du monitor Telegram directement dans le bot principal

### Affichage des alertes whale dans le terminal principal du bot
- **Pourquoi** : le `telegram-monitor/` est un processus séparé (non lancé), les alertes whale n'apparaissaient jamais dans le terminal principal du bot
- **Modifié/Créé** : `src/services/telegramWhaleMonitor.ts` (nouveau)
  - Service intégré au bot principal, se connecte via `TELEGRAM_SESSION` si disponible
  - Affiche les alertes whale (📱 TELEGRAM WHALE) directement dans le terminal via `Logger`
  - Désactivé silencieusement si les variables Telegram manquent
  - Démarre avec `startTelegramWhaleMonitor()`, s'arrête avec `stopTelegramWhaleMonitor()`
- **Modifié** : `src/index.ts`
  - Import + appel `startTelegramWhaleMonitor()` après les autres services
  - Appel `stopTelegramWhaleMonitor()` dans le shutdown graceful
- **Modifié** : `package.json` — ajout dépendance `telegram`
- **À noter** : nécessite `TELEGRAM_SESSION` dans `.env` (obtenu via `telegram-monitor/` au premier lancement)

## 2026-03-26 — Intégration alertes Telegram dans le log principal du bot

### Affichage des alertes Telegram dans logs/bot.log
- **Pourquoi** : les alertes whale du groupe Telegram (liens Polymarket + prix) n'étaient pas visibles dans le log principal du bot — les deux streams (bot + telegram-monitor) étaient séparés
- **Modifié** : `telegram-monitor/src/main.ts`
  - Ajout `import * as fs from 'fs'`
  - Ajout constante `MAIN_LOG_PATH = path.join(__dirname, '../../../logs/bot.log')`
  - Nouvelle fonction `writeToMainLog(trade: WhaleTrade)` : écrit une ligne formatée dans `logs/bot.log` via `fs.appendFileSync`
  - Format : `[HH:MM:SS] 📱 TELEGRAM 📈 Trader Name — BUY Yes @ 28¢ | $1,100 | https://polymarket.com/event/...`
  - Crée le dossier `logs/` si absent
  - Appel dans `handleMessage()` juste après le parsing (pour BUY et SELL)
  - Affichage terminal : "Slug" renommé "Lien", URL complète affichée (pas juste le slug)
- Reste à tester : vérifier que le chemin relatif `../../../logs/bot.log` est correct depuis le dossier de build `telegram-monitor/dist/`

## 2026-03-25 — Fix race condition : double traitement concurrent du même asset

### Déduplication concurrent des callbacks blockchain
- **Pourquoi** : 2 transactions du même trader sur le même asset arrivaient simultanément via 2 callbacks blockchain → les 2 passaient le check `isAssetRejected` avant que l'un ait fini → double traitement identique dans les logs
- **Modifié** : `src/services/tradeExecutor.ts`
  - Ajout `processingAssets: Set<string>` au niveau module
  - Début du for loop : check synchrone `processingAssets.has(asset)` → si déjà en traitement → mark `bot: true` + skip
  - Fin du for loop : `processingAssets.delete(asset)` pour libérer l'asset
  - Le check + add est synchrone → atomique en JS single-thread (pas de race entre has et add)
- Reste à tester : cas où 2 traders différents achètent le même asset simultanément (le 2e serait bloqué — acceptable car même rejet de toute façon)

## 2026-03-23 — Cache de rejet : éviter le re-traitement du même marché

### Nouveau cache de marchés rejetés (ask trop élevé)
- **Pourquoi** : le bot retraitait plusieurs fois le même marché (ask=$0.9990) quand plusieurs traders achetaient le même token — chaque trade déclenchait un cycle complet inutile (fetch order book, logs "Saut de prix", etc.)
- **Créé** : `src/utils/rejectedAssetCache.ts`
  - Map en mémoire : `asset → timestamp du rejet`, TTL 10 minutes
  - `rejectAsset(asset)` : marque un asset comme rejeté
  - `isAssetRejected(asset)` : retourne true si rejeté dans les 10 dernières minutes
- **Modifié** : `src/utils/postOrder.ts`
  - Après détection `ask >= MAX_BUY_PRICE` (ligne "AUSSI REFUSÉE") : appel `rejectAsset(_asset)`
- **Modifié** : `src/services/tradeExecutor.ts`
  - Avant `postOrder()` : check `isAssetRejected(trade.asset)` — si rejeté récemment → mark `bot: true` et skip immédiat
- Reste à tester : comportement si le prix redescend après 10 min (TTL expiration → le marché est retenté normalement)

## 2026-03-23 — Fix mark-to-market : marché illiquide/résolu affiché à $0.50

### Fix prix mark-to-market erroné
- **Pourquoi** : une position s'affichait avec prix courant $0.50 et P&L -47.9%, alors que l'entrée était à $0.96. La cause : quand un marché est illiquide ou résolu, le CLOB retourne bid=$0.01 / ask=$0.99 → midpoint = (0.01 + 0.99) / 2 = $0.50, trompeur
- **Modifié** : `src/utils/simulationBalance.ts` — méthode `updateMarkToMarket()`
  - Ajout d'un test de spread : si `(ask - bid) > 0.80` → marché illiquide/résolu détecté
  - Dans ce cas : on efface le prix erroné de `markToMarketPrices` ET `lastKnownPrices`
  - Résultat : fallback sur `position.avgPrice` (prix d'entrée) au lieu d'afficher $0.50 trompeur
- Reste à tester : cas où un marché vraiment 50/50 illiquide serait faussement ignoré (peu probable vu le seuil de 0.80)

## 2026-03-23 — Outil Telegram Monitor : vérification timing whale→bot

### Nouveau dossier telegram-monitor/
- **Pourquoi** : des trades whale apparaissaient sur Telegram mais n'étaient pas copiés — besoin d'un outil pour diagnostiquer le délai entre l'alerte Telegram et la détection par le bot
- **Créé** : `telegram-monitor/` (standalone, indépendant du bot principal)
  - `package.json` — deps : telegram (gramjs MTProto), mongoose, dotenv
  - `tsconfig.json` — config TypeScript standalone
  - `src/main.ts` — script principal :
    - Connexion Telegram via MTProto (compte utilisateur, pas bot API)
    - Parse les alertes whale (👤 nom, 📈/📉 BUY/SELL, 💰 taille, 💲 prix)
    - Mapping nom Telegram → adresse wallet (5 traders connus)
    - Pour chaque BUY détecté : surveille MongoDB toutes les 2s pendant 120s
    - Affiche délai Telegram→détection bot et Telegram→exécution bot
- **Modifié** : `.env` — ajout section TELEGRAM_MONITOR (API_ID, API_HASH, PHONE, SESSION, BOT_USERNAME)
- **Première utilisation** : demande le code SMS Telegram → génère TELEGRAM_SESSION → copier dans .env
- Reste à tester : parsing de tous les formats de messages, faux positifs MongoDB, cas où le bot rate le trade

## 2026-03-19 — Mise à jour traders : scan strict + 10 traders positionnels

### Mise à jour .env avec nouveaux traders
- **Pourquoi** : Impressive-Credenza s'est révélé être un news trader (ask=$0.99 en quelques secondes) malgré avg_buy_price $0.46. Re-scan avec filtre MAX_AVG_BUY_PRICE=0.45, 80 marchés, 120 traders analysés
- **Modifié** : `.env` — USER_ADDRESSES
  - Conservés : Quick-Witted-Cook, Sweet-Honoree, Delayed-Vanadyl (P&L réel positif confirmé)
  - Ajoutés 7 nouveaux traders POSITIONAL (score 60-82, 21-57 marchés chacun, 0% résolutions rapides) :
    Dry-Instance, Better-Lettuce, Ugly-Tambourine, Well-Off-Fringe, Dutiful-Thirst, Male-Offramp, Indolent-Cummerbund
  - Total : 10 traders, tous positionnels, avg_buy_price < $0.35
- **Écarté** : Enchanted-Plaintiff (score 98 mais -$64,721 open, seulement 4 marchés = risque concentré)
- Reste à vérifier : si ces traders génèrent des trades copiables en conditions réelles (leurs marchés seront peut-être différents des marchés actuels scannés)

## 2026-03-17 — Outil standalone : Polymarket Trader Finder avec analyse OpenAI

### Nouveau dossier trader-finder/
- **Pourquoi** : trader actuel (Whimsical-Terminal) fait du news trading — marchés résolus en <5s, impossible à copier. Besoin d'un outil séparé pour trouver des traders "positionnels" (achètent à prix bas, tiennent des jours/semaines)
- **Créé** : `trader-finder/` (dossier autonome, indépendant du bot principal)
  - `package.json` — dépendances : dotenv, openai, ts-node, typescript
  - `tsconfig.json` — config TypeScript standalone
  - `.env.example` — config : OPENAI_API_KEY, MARKETS_TO_SCAN, MAX_TRADERS, MAX_AVG_BUY_PRICE
  - `src/main.ts` — script principal : découverte marchés → analyse traders → export résultats
  - `src/openaiClassify.ts` — module OpenAI (gpt-4o-mini) : POSITIONAL / NEWS_TRADER / MIXED
  - `output/` — dossier de résultats (results.txt exporté après chaque run)

### Algorithme de filtrage
- **Filtre 1** : `avg_buy_price > $0.70` → news trader → éliminé avant appel OpenAI
- **Filtre 2** : `pctFastResolution` (% marchés résolus en <2h après achat) via gamma API
- **Score copiabilité** : 40% prix, 25% % achats <$0.70, 20% pas de résolution rapide, 10% P&L, 5% confiance IA
- **Fallback heuristique** si pas de clé OpenAI : logique simple basée sur les métriques
- Reste à tester : pertinence des seuils, qualité des classifications OpenAI, fiabilité des données gamma API

## 2026-03-16 — Fix diagnostics prix + seuil MAX_BUY_PRICE

### Fix endpoints diagnostics (401 → prices-history)
- **Pourquoi** : `logMarketPriceAtTraderTime` et `logMarketPriceNSecBefore` appelaient `/trades?token_id=` qui retourne HTTP 401 (auth requise)
- **Modifié** : `src/utils/postOrder.ts`
  - Remplacé `/trades?token_id=` par `/prices-history?market=` dans les deux fonctions (endpoint public)
  - Même correction pour `logTimeToReachPriceThreshold` : catch silencieux → log visible

### Fix ordre d'affichage des diagnostics (DRY_RUN)
- **Pourquoi** : diagnostics fire-and-forget complétaient APRÈS le séparateur `──────` (après 1s de délai dans tradeExecutor) → logs apparaissaient dans la mauvaise section du log, invisibles
- **Modifié** : `src/utils/postOrder.ts`
  - DRY_RUN BUY : `Promise.all([...]).catch()` → `await Promise.all([...]).catch()`
  - DRY_RUN BUY : IIFE fire-and-forget → inline `await` (book fetch + `logTimeToReachPriceThreshold`)
  - Résultat : tous les diagnostics apparaissent AVANT `❌ [SIMULATION] BUY failed`
  - Mode réel inchangé (fire-and-forget conservé pour latence critique)

### Fix seuil logTimeToReachPriceThreshold
- **Pourquoi** : seuil hardcodé à `0.97` mais `MAX_BUY_PRICE` est `0.98` dans .env → le log "quand le prix a atteint 0.98" n'apparaissait jamais correctement
- **Modifié** : `src/utils/postOrder.ts`
  - Les 2 call sites : `0.97` → `ENV.MAX_BUY_PRICE`
  - Désormais le log dit exactement quand le prix a croisé le seuil de refus configuré

### Config 1 trader
- **Pourquoi** : simplification — ne suivre que le meilleur trader
- **Modifié** : `.env`
  - `USER_ADDRESSES` réduit à `0x96489...` (Whimsical-Terminal, rank:1, score:100, +$51K réalisé)

## 2026-03-16 — Optimisation latence 3 phases : sub-1s overhead post-bloc

### Phase 1a — Logs diagnostics fire-and-forget en mode réel
- **Pourquoi** : `logMarketPriceAtTraderTime` + `logTimeToReachPriceThreshold` étaient encore `await`és dans la branche BUY réelle (lines 661-664) → ~600ms bloqués
- **Modifié** : `src/utils/postOrder.ts`
  - Remplacé `await logMarketPriceAtTraderTime(...)` + `await logTimeToReachPriceThreshold(...)` par `Promise.all([...]).catch(() => {})` fire-and-forget
  - Gain estimé : ~600ms sur le chemin critique réel

### Phase 1b — HTTP keep-alive sur fetchData.ts
- **Pourquoi** : chaque appel `axios.get()` ouvrait une nouvelle connexion TCP+TLS (~20-50ms par appel)
- **Modifié** : `src/utils/fetchData.ts`
  - Ajout `http.Agent` + `https.Agent` avec `keepAlive: true, keepAliveMsecs: 10000`
  - Passés à chaque `axios.get()` via `httpAgent`/`httpsAgent`

### Phase 1c — Pre-claim à l'insertion (supprime 2e round-trip MongoDB)
- **Pourquoi** : le callback executor faisait un `findOneAndUpdate` (~80ms) pour réclamer le trade
- **Modifié** : `src/services/blockchainMonitor.ts`
  - `botExcutedTime: 0` → `botExcutedTime: 1` dans `$setOnInsert` (pre-claimed)
  - `_id: result.upsertedId` ajouté dans le payload callback
- **Modifié** : `src/services/tradeExecutor.ts`
  - Callback blockchain : supprimé `findOneAndUpdate`, construit `TradeWithUser` directement depuis payload
  - Gain estimé : ~80ms par trade blockchain

### Phase 2a — Cache balance 30s (supprime appel RPC bloquant)
- **Pourquoi** : `getMyBalance()` = appel RPC Polygon (~200ms) au moment du trade
- **Modifié** : `src/services/tradeExecutor.ts`
  - Ajout `_cachedBalance` + `_refreshBalance()` (loop setTimeout 30s)
  - `doTrading` utilise `_cachedBalance` si disponible, déclenche refresh en arrière-plan
  - Gain estimé : ~200ms en mode réel

### Phase 2b — Cache order book pré-chauffé
- **Pourquoi** : `clobClient.getOrderBook()` = appel HTTP CLOB (~200ms) dans la boucle de trading
- **Modifié** : `src/utils/postOrder.ts`
  - Ajout `_orderBookCache` (Map, TTL 1.5s) + export `setPreWarmedOrderBook()`
  - `getOrderBookCached()` : vérifie le cache avant chaque appel CLOB
  - Les 3 boucles (MERGE/BUY/SELL) utilisent la version cachée
- **Modifié** : `src/services/tradeExecutor.ts`
  - Import `setPreWarmedOrderBook` depuis postOrder
  - Callbacks blockchain ET mempool : `clobClient.getOrderBook()` lancé en fire-and-forget dès réception du payload
  - Gain estimé : ~200ms si cache chaud

### Phase 3 — Mempool monitor (Alchemy pendingTransactions)
- **Pourquoi** : détection APRÈS confirmation du bloc = ~2s de délai incompressible
- **Créé** : `src/services/mempoolMonitor.ts`
  - Subscription `alchemy_pendingTransactions` filtrée sur CTFExchange + NegRiskExchange
  - Décodage calldata avec ethers.js Interface (`matchOrders` + `fillOrder`)
  - Extraction maker/taker → vérif dans trackedSet
  - Insert en MongoDB avec `botExcutedTime: 1` (pre-claimed)
  - Callback direct → executor (même logique que blockchainMonitor)
  - Confirmation tracker 30s : log warning si tx non-confirmée
  - Actif uniquement si `POLYGON_WS_URL` contient "alchemy.com"
- **Modifié** : `src/services/tradeExecutor.ts`
  - Import + enregistrement `setOnNewMempoolTrade(...)` avec même handler que blockchain
- **Modifié** : `src/index.ts`
  - Import + démarrage `mempoolMonitor()` après `blockchainMonitor()`
  - `stopMempoolMonitor()` ajouté dans `gracefulShutdown`

### Résultat attendu (overhead post-détection)
```
Avant : ~800-1100ms (blockchain event → ordre CLOB)
Après : ~250-400ms  (blockchain event → ordre CLOB)
Avec mempool Alchemy : ~50-200ms (pending tx → ordre CLOB, soit ~2s avant le bloc)
```
- À tester : déduplication mempool→blockchain (txHash pre-claimed), calldata decode sur vrais trades
- Non garanti : le décodage `matchOrders` takers (approximation des fill amounts)


## 2026-03-16 — Optimisation latence : ~1.7s → ~200ms post-block

### 1. Logs diagnostics en fire-and-forget
- **Pourquoi** : 3 appels API bloquaient l'exécution avant le trade : logMarketPrice + logNSecBefore + logTimeToReach + bookNow = ~1000ms perdus
- **Modifié** : `src/utils/postOrder.ts`
  - `Promise.all([logMarketPriceAtTraderTime, logMarketPriceNSecBefore])` → fire-and-forget
  - `bookNow` fetch (diagnostic) + `logTimeToReachPriceThreshold` → regroupés dans un IIFE async non-attendu
  - `executeSimulatedTrade()` est maintenant le **premier** appel async

### 2. Skip getCachedPositions pour BUY trades < 30s
- **Pourquoi** : l'API positions Polymarket prend 20-60s à indexer → appel inutile + ~300ms perdus
- **Modifié** : `src/services/tradeExecutor.ts`
  - Si `trade.side === 'BUY' && tradeStaleSec < 30` → `user_positions = []` (pas d'appel API)

### 3. Callback direct blockchain → executor (bypass MongoDB poll)
- **Pourquoi** : le poll MongoDB (toutes les 50ms) + write/read = ~150-300ms perdus
- **Modifié** : `src/services/blockchainMonitor.ts`
  - Ajout `BlockchainTradePayload` interface et `setOnNewBlockchainTrade()` export
  - Dans `saveSyntheticTrade` : appel `_onTradeCallback` immédiatement après upsert réussi
- **Modifié** : `src/services/tradeExecutor.ts`
  - Import `setOnNewBlockchainTrade`
  - Au démarrage : enregistre le callback avec claim atomique MongoDB pour éviter double-exécution

**Résultat attendu** : ~2s (bloc Polygon) + ~200ms (overhead) = **~2.2s total** (vs ~4s avant)
Reste à tester : vérifier qu'il n'y a pas de double-exécution sur les trades rapides

---

## 2026-03-16 — Fix 0 trades copiés + assouplissement filtres + log prix→0.97

### Bug critique : traderHasPosition bloquait tous les trades blockchain
- **Pourquoi** : blockchain détecte un trade en ~3s, mais l'API positions Polymarket indexe en 20-60s → vérification retournait toujours false → 0 trades copiés en 43h
- **Modifié** : `src/services/tradeExecutor.ts`
  - Pour trades < 120s : skip la vérif + log `⚡ Trade récent (Xs) — vérif position ignorée`
  - Pour trades > 120s : comportement inchangé

### Assouplissement filtres prix
- **Modifié** : `src/config/env.ts`
  - MAX_BUY_PRICE : 0.975 → 0.98
  - MIN_GAIN_POTENTIAL_PERCENT : 2.0% → 1.0%
  - Corrigé incohérence dans `reloadDynamicEnv()` (valeurs différentes des defaults)

### Log prix → $0.97
- **Pourquoi** : voir si les trades copiés étaient rentables (le prix monte-t-il vers résolution ?)
- **Modifié** : `src/utils/postOrder.ts`
  - `logTimeToReachPriceThreshold` appelé pour tous les BUY avec seuil 0.97 (avant : seulement si retard > 5 min)

---

## 2026-03-16 — Seuil alerte fetch cycle dynamique

### Alerte "Fetch cycle lent" trop sensible
- **Pourquoi** : 10-12s est normal pour 69 traders × 2 API calls en batches → seuil fixe à 10s déclenche à chaque cycle
- **Modifié** : `src/services/tradeMonitor.ts`
  - Seuil dynamique : `max(20, nbTraders × 0.4 × 1.3)` → 36s pour 69 traders (n'alerte que si vraiment dégradé)

---

## 2026-03-14 — Accélération du démarrage (RPC timeout + updateMany parallèle)

### Skip `isGnosisSafe` en DRY_RUN
- **Pourquoi** : Au démarrage, `createClobClient` appelait `getCode` sur le RPC → timeout 5s inutile en simulation
- **Modifié** : `src/utils/createClobClient.ts`
  - Ajout `if (ENV.DRY_RUN)` → saute la vérif RPC et déclare EOA directement (économise 5s)

### Parallélisation `updateMany` premier run
- **Pourquoi** : 69 appels MongoDB séquentiels pour marquer les trades historiques → lenteur au démarrage
- **Modifié** : `src/services/tradeMonitor.ts`
  - `for` loop → `Promise.all()` → tous les `updateMany` en parallèle (économise ~0.5-1s)

---

## 2026-03-14 — Réduction verbosité démarrage (positions traders + historique)

### Suppression détails positions dans tradersPositions
- **Pourquoi** : 3 positions × 69 traders = ~207 lignes au démarrage — illisible
- **Modifié** : `src/utils/logger.ts`
  - `tradersPositions()` : supprimé le bloc per-position (forEach imbriqué)
  - Garde uniquement la ligne `0x1234...abcd: N positions | +X.X%` par trader

### Résumé unique pour les trades historiques marqués
- **Pourquoi** : ~32 lignes `Marked X historical trades as processed for 0x...` au démarrage
- **Modifié** : `src/services/tradeMonitor.ts`
  - Boucle updateMany : accumuler `totalMarked` au lieu de logger par trader
  - Un seul log : `Historical trades processed (N marqués). Now monitoring for new trades only.`

## 2026-03-14 — Mise à jour automatique des rapports toutes les 5 min

### simulation-report.txt et .html écrasés toutes les 5 min
- **Pourquoi** : Les rapports n'étaient générés qu'à l'arrêt du bot — impossible de voir l'état courant sans stopper
- **Modifié** : `src/index.ts`
  - `generateTextReport()` et `generateHTMLReport()` ajoutés dans le `setInterval` 5 min (avec le graphique)
- **Modifié** : `src/utils/simulationBalance.ts`
  - Suppression du log `📄 Text report saved` (inutile toutes les 5 min, polluait les logs)

## 2026-03-14 — Statut blockchain dans le display périodique

### Indicateur ✅/❌ blockchain affiché avec le graphique toutes les 5 min
- **Pourquoi** : L'utilisateur ne peut pas voir si le blockchain monitor est connecté ou non sans chercher dans les logs de démarrage
- **Modifié** : `src/services/blockchainMonitor.ts`
  - Ajout de `wsConnected` (bool) et `wsEffectiveUrl` (string) au niveau module
  - `wsConnected = true` à la connexion, `false` sur erreur/ping échoué
  - Export `getBlockchainStatus()` → `{ connected, tradeCount, url }`
- **Modifié** : `src/index.ts`
  - Import de `getBlockchainStatus`
  - Dans `setInterval` 5 min (avec le graphique) : log ✅ ou ❌ selon connexion
  - Ex: `⚡ BLOCKCHAIN: ✅ Connecté (12 trade(s) détecté(s)) — wss://...`
  - À tester : vérifier que le statut change bien entre ✅ et ❌ selon l'état réel

## 2026-03-14 — Heure Montréal dans les logs de copy delay

### Affichage heure Montréal (HH:MM:SS)
- **Pourquoi** : `toLocaleTimeString()` utilisait le timezone du serveur (UTC) — l'heure affichée ne correspondait pas à l'heure locale du trader
- **Modifié** : `src/services/tradeExecutor.ts`
  - `toLocaleTimeString('fr-CA', { timeZone: 'America/Montreal', hour12: false })` → ex: "14:38:55 Montréal"
  - Format 24h avec secondes

## 2026-03-14 — Fix flood logs "REST API seul"

### Flood de warnings par trade remplacé par résumé par trader
- **Pourquoi** : Chaque nouveau trade détecté avec >3 min de délai générait une ligne de warning → avec 69 traders, plusieurs centaines de lignes par cycle rendaient les logs illisibles
- **Modifié** : `src/services/tradeMonitor.ts`
  - Boucle d'insertion hors `isFirstRun` : collecte maintenant le nombre de trades lents + délai max
  - Un seul log par trader (ex : "3 trade(s) en retard, max 8m15s (0xd6ee...37a2)") au lieu de N logs
  - À tester : vérifier que le résumé apparaît bien, et que les trades lents sont toujours comptés

## 2026-03-14 — Réduction logs verbeux + fix RPC 429 en DRY_RUN

### Logs de démarrage condensés
- **Pourquoi** : Au démarrage, 69 adresses de traders s'affichaient une par une (Logger.startup), puis le statut DB pour chaque trader (Logger.dbConnection) — inutile et illisible
- **Modifié** : `src/utils/logger.ts`
  - `startup()` : n'affiche plus que le nombre total + 3 premières adresses + "et N autres"
  - `dbConnection()` : remplace la liste par trader par une seule ligne "X traders — Y trades au total"

### Fix health check RPC/balance en mode DRY_RUN
- **Pourquoi** : En DRY_RUN, le health check appelait le RPC Polygon (HTTP 429 = rate limit) et getMyBalance — deux appels inutiles car la simulation utilise une balance virtuelle
- **Modifié** : `src/utils/healthCheck.ts`
  - Check RPC : ignoré si `DRY_RUN=true`, status forcé à `ok` avec message "Ignoré (DRY_RUN mode)"
  - Check balance : ignoré si `DRY_RUN=true`, status forcé à `ok` avec message "Ignoré (DRY_RUN mode — balance virtuelle)"
  - À tester : vérifier que le health check reste propre en mode live (non DRY_RUN)

---

## 2026-03-14 — Fix blockchain monitor : fallback nœud public + MIN_GAIN cohérent

### Blockchain monitor ne démarrait jamais (POLYGON_WS_URL vide)
- **Pourquoi** : tous les trades détectés avec 28-173 min de retard (REST seul), car le blockchain monitor s'arrêtait silencieusement si POLYGON_WS_URL était absent
- **Modifié** : `src/services/blockchainMonitor.ts`
  - Si POLYGON_WS_URL vide → utilise automatiquement `wss://polygon-bor-rpc.publicnode.com` (nœud public gratuit)
  - Le bot n'a plus besoin de configurer POLYGON_WS_URL pour avoir le blockchain monitor actif
- **Modifié** : `.env.example`
  - `POLYGON_WS_URL` prérempli avec le nœud public au lieu d'être vide
- **Modifié** : `src/config/env.ts`
  - `MIN_GAIN_POTENTIAL_PERCENT` : 3.0% → **2.0%** (cohérent avec MAX_BUY_PRICE=0.975 — à $0.975 le gain est 2.56%)
- **Limite** : nœud public moins fiable que Alchemy/QuickNode — peut se déconnecter plus souvent

---

## 2026-03-14 — Blockchain monitor : hot path optimisé

### Réduction latence event blockchain → MongoDB
- **Pourquoi** : `saveSyntheticTrade` faisait findOne + Gamma API (~500ms) avant de sauvegarder → executor attendait inutilement
- **Modifié** : `src/services/blockchainMonitor.ts`
  - `preloadMarketCache()` : charge tous les marchés connus depuis MongoDB au démarrage → lookupMarketInfo instantané pour les trades suivants
  - `saveSyntheticTrade` : findOne + save → **upsert $setOnInsert** (1 seul aller MongoDB)
  - Gamma API déportée en **arrière-plan non-bloquant** après sauvegarde (plus dans le chemin critique)
  - Hot path estimé : ~500-1200ms → **~50-150ms** (cache chaud) ou ~150ms (MongoDB miss)

---

## 2026-03-14 — Optimisation vitesse d'exécution

### Réduction de la latence entre détection et ordre placé
- **Pourquoi** : 0 trades copiés — délai trop long entre détection et exécution
- **Modifié** : `src/utils/postOrder.ts`
  - Appels CLOB diagnostics séquentiels → `Promise.all` parallèle (~500ms économisés en DRY_RUN)
- **Modifié** : `src/services/tradeExecutor.ts`
  - Polling MongoDB : 200ms → **50ms** (réaction 4× plus rapide aux nouveaux trades)
- **Limite** : gains marginaux — la vraie solution reste le blockchain monitor (POLYGON_WS_URL) qui réduit la détection de 15-60s à ~3s

---

## 2026-03-14 — Assouplissement filtres : MAX_BUY_PRICE 0.975, MAX_SLIPPAGE 80%

### Raison : 0 trades copiés en 24h malgré des trades détectés
- **Pourquoi** : `MAX_BUY_PRICE=0.95` et `MAX_SLIPPAGE_PERCENT=10%` bloquaient tous les trades — délai REST ~15s = slippage > 10% sur marchés actifs
- **Modifié** : `src/config/env.ts`
  - `MAX_BUY_PRICE` : défaut 0.95 → **0.975** (accepte les trades jusqu'à $0.975, gain min ~2.6%)
  - `MAX_SLIPPAGE_PERCENT` : défaut 10% → **80%** (large tolérance pour compenser le délai REST)
- **Modifié** : `.env.example` — commentaires mis à jour
- **Limite** : MAX_SLIPPAGE 80% est très permissif — à resserrer une fois le blockchain monitor actif (~3s de délai → slippage naturellement faible)
- **À surveiller** : trades copiés à des prix bien supérieurs au prix du trader

---

## 2026-03-14 — Auto-nettoyage MongoDB wired in + cleanup manuel 206k docs

### Auto-cleanup branché dans la boucle principale
- **Pourquoi** : `autoCleanupMongo()` était définie mais jamais appelée — le nettoyage auto n'avait pas lieu
- **Modifié** : `src/services/tradeMonitor.ts`
  - Ajout de `await autoCleanupMongo()` dans le `while (isRunning)` loop, après les checks de positions
  - S'exécute toutes les 6h, supprime les trades `bot: true` et les anciens de +7j
- **Action effectuée** : Nettoyage manuel via `cleanupMongo.ts` → 206 930 documents supprimés
- **Limite** : Premier cycle de cleanup auto dans 6h après démarrage du bot

---

## 2026-03-14 — Fix isFirstRun : ne plus insérer toute l'historique au démarrage

### Cause racine du re-remplissage MongoDB après cleanup
- **Pourquoi** : `isFirstRun` insérait TOUTES les activités fetchées de l'API Polymarket, sans filtre de date. Résultat : 0xe8dd → 47,067 trades, 0xf0b0 → 42,306 trades réinsérés immédiatement après chaque nettoyage. La DB se remplissait à 512MB en une seule session.
- **Modifié** : `src/services/tradeMonitor.ts`
  - Suppression de `isFirstRun ? activities :` — le filtre `cutoffTimestamp` s'applique maintenant AUSSI au premier run
  - Seules les activités des dernières 3h (TOO_OLD_TIMESTAMP) sont stockées au démarrage
  - Impact : ~69 × 10 trades au lieu de 200,000+
- **Action requise** : Relancer `npx ts-node src/scripts/cleanupMongo.ts` puis redémarrer le bot
- **Limite** : Si `TOO_OLD_TIMESTAMP` est trop court (< 1h), des trades récents légitimes pourraient être ignorés. La valeur 3h est correcte.

---

## 2026-03-13 — bulkWrite positions : suppression des boucles MongoDB séquentielles

### Remplacement N × findOneAndUpdate par un seul bulkWrite
- **Pourquoi** : Après fetch parallèle + batch 16, cycle encore à 29.9s. Cause : traders avec 95+ positions (0x5f39, 0xf0b0) faisaient 95 `findOneAndUpdate` séquentiels ≈ 5s par trader, bloquant tout leur batch.
- **Modifié** : `src/services/tradeMonitor.ts`
  - Boucle `for position of positions` → `bulkWrite(bulkOps, { ordered: false })`
  - 95 positions : ~5s → ~100ms (1 seul aller-retour MongoDB au lieu de 95)
- **Résultat attendu** : Cycle ~10-15s au lieu de 29.9s

---

## 2026-03-13 — Accélération cycle REST : fetch parallèle + batch 16

### Réduction du délai de détection via REST polling
- **Pourquoi** : Cycle de fetch prenait 38.8s pour 69 traders. Deux causes : (1) chaque `processOneTrader` faisait 2 appels HTTP séquentiels, (2) FETCH_BATCH_SIZE=8 → 9 batches.
- **Modifié** : `src/services/tradeMonitor.ts`
  - `processOneTrader` : les 2 `fetchData` (activités + positions) maintenant en `Promise.all` → -1-2s par batch
  - `FETCH_BATCH_SIZE` : 8 → 16 → 5 batches au lieu de 9
  - Suppression du second `fetchData(positionsUrl)` devenu redondant
- **Résultat attendu** : Cycle ~15-20s au lieu de 38s, délai de détection moyen ~8-10s
- **Limite** : Si rate-limit Polymarket, baisser FETCH_BATCH_SIZE à 12

---

## 2026-03-13 — Fix logs CLOB : catch silencieux et format API

### Diagnostic erreur API CLOB /trades silencieuse
- **Pourquoi** : `logMarketPriceAtTraderTime` et `logMarketPriceNSecBefore` avaient des `catch {}` silencieux. Si l'API CLOB `/trades` retourne une erreur (HTTP 400/404) ou un format `{ data: [...] }` au lieu d'un array brut, rien n'était affiché.
- **Modifié** : `src/utils/postOrder.ts`
  - Les deux fonctions gèrent maintenant les deux formats de réponse API (`Array` brut OU `{ data: [...] }`)
  - Les `catch` blocs loggent maintenant le message d'erreur (ex: `erreur API CLOB (Request failed with status code 400)`)
  - Cela permettra de diagnostiquer pourquoi les logs "Prix il y a 10s" n'apparaissent pas
- **Limite** : À tester — si le CLOB retourne 400 pour ces marchés, il faudra trouver une alternative

---

## 2026-03-13 — TTL MongoDB 30 jours pour éviter quota dépassé

### Auto-expiration des trades dans MongoDB Atlas
- **Pourquoi** : MongoDB Atlas plan gratuit limité à 512 MB. La base était pleine (512/512 MB), le bot ne pouvait plus écrire. Les trades s'accumulent indéfiniment sans nettoyage automatique.
- **Modifié** : `src/models/userHistory.ts`
  - Ajout du champ `createdAt: { type: Date, default: Date.now, expires: 30 * 24 * 3600 }` dans `activitySchema`
  - MongoDB crée automatiquement un index TTL — les documents sont supprimés 30 jours après leur création
  - Les documents existants (sans `createdAt`) ne sont pas affectés — utiliser `cleanupMongo.ts` pour nettoyer l'existant
- **Action requise** : Lancer `npx ts-node src/scripts/cleanupMongo.ts` pour vider les 512 MB actuels, puis redémarrer le bot
- **Limite** : Le TTL ne s'applique qu'aux nouveaux documents. Prendra ~30 jours avant de réduire l'espace significativement si nettoyage manuel non fait.

---

## 2026-03-12 — Fix log diagnostique CLOB avant filtre de prix

### Déplacement des logs avant checkPriceAcceptable
- **Pourquoi** : `logMarketPriceNSecBefore` et `logMarketPriceAtTraderTime` étaient appelés APRÈS `checkPriceAcceptable`. Les trades NHL à $0.99 retournaient immédiatement sans jamais afficher les logs diagnostiques. L'utilisateur ne voyait jamais "Prix il y a 10s".
- **Modifié** : `src/utils/postOrder.ts`
  - En mode DRY_RUN BUY : les logs CLOB sont maintenant appelés AVANT le filtre `checkPriceAcceptable`
  - Résultat : même les trades refusés (prix trop haut) affichent l'historique du prix
- **Limite** : L'API CLOB `/trades` peut retourner vide si peu de transactions dans la fenêtre ±60s autour du timestamp du trader

---

## 2026-03-11 — Diagnostic du délai d'indexation API Polymarket

### Log historique des prix : quand le prix atteint MAX_BUY_PRICE depuis l'achat du trader
- **Pourquoi** : Tous les trades détectés arrivent avec ~127 min de retard. L'API REST Polymarket indexe certaines transactions blockchain avec un délai énorme (jusqu'à 2h+). Résultat : le prix est déjà à 0.99 (marché résolu) quand le bot le détecte. L'utilisateur voulait comprendre pourquoi et voir en combien de temps le prix a atteint le seuil (MAX_BUY_PRICE = 0.98 par défaut).
- **Modifié** : `src/utils/postOrder.ts`
  - Ajout de la fonction `logTimeToReachPriceThreshold(asset, traderTimestamp, traderPrice, threshold)` : interroge `clob.polymarket.com/prices-history` avec fidelity=1min pour trouver le premier point où prix ≥ seuil
  - Appel automatique dans DRY_RUN BUY et mode réel BUY si délai > 5 min (300s)
  - Log exemple : `📈 Prix ≥ $0.98 atteint 3m42s après l'achat du trader (trader: $0.6710 → $0.9900 @ 10:37:42 AM)`
  - Si le seuil n'est jamais atteint : log informatif avec le dernier prix connu
- **Limite** : L'API prices-history peut retourner des données vides pour des marchés peu liquides. Non-bloquant (try/catch).
- **Cause racine identifiée (non fixée)** : Retard d'indexation API Polymarket REST = 127min. Solution long terme = WebSocket blockchain direct pour détecter les trades en quelques secondes.

---

## 2026-03-10 — Ajout de 6 nouveaux traders (findCopyableTraders)

### Extension de la liste des traders à copier
- **Pourquoi** : La liste existante (63 traders) générait 0 trade en 20h car tous faisaient du "last-second resolution arb". Ajout de traders qualifiés avec P&L réalisé positif et stabilité de prix prouvée.
- **Modifié** : `.env`
  - `USER_ADDRESSES` : 63 → 69 traders
  - 6 nouveaux ajoutés (depuis `findCopyableTraders.ts --40marchés --100traders`, 43 qualifiés, 100% stabilité) :
    - `0x2f5242...` (Interesting-Aspic) — +$777 réalisé, score 72
    - `0x3b1a8b...` (Mellow-Conversation) — +$523 réalisé, score 72
    - `0xa8f13f...` (Artistic-Woodwind) — +$381 réalisé, score 71
    - `0x0da3b2...` (Likely-Spear) — +$42 réalisé, score 70
    - `0x44bb0d...` (Quarterly-Refusal) — +$5 réalisé, score 70
    - `0x580ff4...` (Vibrant-Highway) — +$1 réalisé, score 70

---

## 2026-03-10 — Hot-reload config .env sans redémarrer

### Rechargement à chaud des paramètres de trading
- **Pourquoi** : Modifier MAX_BUY_PRICE, MAX_SLIPPAGE_PERCENT etc. nécessitait un redémarrage du bot (et une perte de la session simulation). Maintenant les changements dans .env prennent effet immédiatement.
- **Modifié** : `src/config/env.ts`
  - Ajout `MAX_SLIPPAGE_PERCENT` dans l'objet ENV (était lue directement depuis process.env, donc non hot-reloadable)
  - Ajout `export const reloadDynamicEnv()` : relit .env avec dotenv override, met à jour les propriétés de ENV, affiche les valeurs changées
  - Paramètres hot-reloadables : MAX_BUY_PRICE, MIN_GAIN_POTENTIAL_PERCENT, MAX_SLIPPAGE_PERCENT, TOO_OLD_TIMESTAMP, SIMULATION_MAX_SLIPPAGE_PERCENT, TRADER_COOLDOWN_*, DIP_FOLLOW_*
- **Modifié** : `src/utils/postOrder.ts`
  - Remplacé `const MAX_SLIPPAGE_PERCENT = parseFloat(...)` par `const getMaxSlippagePercent = () => ENV.MAX_SLIPPAGE_PERCENT`
  - Permet de refléter la valeur mise à jour à chaque vérification de slippage
- **Modifié** : `src/index.ts`
  - Import `reloadDynamicEnv` + `fs`, `path`
  - Touche `r` : recharge manuellement la config
  - `fs.watch('.env', ...)` avec debounce 300ms : recharge automatiquement si .env est sauvegardé
  - Message raccourcis mis à jour : `l | s | b | r | Ctrl+C`

---

## 2026-03-10 — Fix logs prix marché + timing breakdown simulation

### Prix 10 secondes avant le trade du trader (visible dans les logs)
- **Pourquoi** : Les logs `logMarketPriceAtTraderTime` et `logMarketPriceNMinBefore` étaient fire-and-forget → leurs résultats apparaissaient après les logs d'exécution, donc invisibles. Aussi l'utilisateur voulait 10 secondes, pas 10 minutes.
- **Modifié** : `src/utils/postOrder.ts`
  - Changé les deux appels de fire-and-forget → `await` (apparaissent maintenant AVANT l'exécution)
  - Renommé `logMarketPriceNMinBefore` → `logMarketPriceNSecBefore` (paramètre `secondsBefore`)
  - Changé 10 minutes → 10 secondes dans les appels (et dans la fenêtre de query CLOB : ±60s autour du point cible)
  - Seuil d'arrow ajusté : `>5%` au lieu de `>10%` pour 10 secondes (mouvements plus petits)

### Timing breakdown de l'exécution simulation
- **Pourquoi** : Ordres prenant 10+ secondes sans explication. `createClobClient()` faisait un wallet type check (getCode, timeout 5s) à chaque trade.
- **Modifié** : `src/utils/simulationExecutor.ts`
  - Ajout `_cachedClobClient` module-level : le client CLOB n'est créé qu'une fois (1er trade)
  - Log au 1er appel : `⏱ createClobClient : X.Xs (premier appel)`
  - Variables de timing `tClientStart/End`, `tFetchStart/End`, `tSimStart/End`
  - Log résumé : `⏱ Timing simulation : client=Xs | orderBook=Xs | fill=Xs | total=Xs`

---

## 2026-03-08 — Réduction bruit logs : skip BUY en résumé groupé

### Suppression des logs individuels "Trader no longer holds position"
- **Pourquoi** : 140 lignes de "⛔ Skipping BUY" pour un seul batch de trades, totalement illisible
- **Modifié** : `src/services/tradeExecutor.ts`
  - `doTrading()` : ajout compteurs `skippedNoPositionCount` + `skippedResolvedCount`
  - Suppression logs individuels + séparateurs pour ces deux cas
  - Résumé unique en fin de batch : `⏭ N BUY ignoré(s) — trader a déjà clôturé ces positions`
  - Même pattern que `skippedSellCount` déjà en place

---

## 2026-03-08 — Vérification prix à la détection ("si exécution immédiate")

### Check : est-ce que l'exécution immédiate aurait fonctionné ?
- **Pourquoi** : L'utilisateur veut savoir si le bot est fondamentalement trop lent ou si c'est le délai de simulation
- **Modifié** : `src/utils/postOrder.ts`
  - Fetch CLOB book immédiat avant `executeSimulatedTrade` → prix à la détection
  - Log : `✅/❌ Prix à la détection (+57s) : ask $X.XX — exécution immédiate POSSIBLE/AUSSI REFUSÉE`

---

## 2026-03-08 — Affichage prix il y a 10 min dans les logs

### Contexte dynamique du marché avant le trade
- **Pourquoi** : L'utilisateur veut voir l'évolution du prix avant que le trader achète (momentum)
- **Modifié** : `src/utils/postOrder.ts`
  - Ajout de `logMarketPriceNMinBefore()` : appel CLOB pour récupérer le prix 10 min avant le trade du trader
  - Log : `📈 Prix il y a 10 min : $X.XX → trader @ $Y.YY (+ZZ.Z% en 10 min)`
  - Appel fire-and-forget, non-bloquant

---

## 2026-03-08 — Optimisation DRY_RUN : suppression appels API inutiles dans doTrading()

### Élimination overhead 3min45s en mode simulation
- **Pourquoi** : En DRY_RUN, le bot faisait `fetchData(positions PROXY_WALLET)` + `getBalance()` (RPC rate-limited) avant chaque ordre → 3-4 min de timeouts → marchés résolus avant exécution
- **Modifié** : `src/services/tradeExecutor.ts`
  - Dans `doTrading()` : si `ENV.DRY_RUN`, utilise `getSimulationTracker().getCurrentBalance()` directement (pas d'appel RPC/API)
  - Dans `doAggregatedTrading()` : même optimisation
  - En mode réel : comportement inchangé (Promise.all positions + balance)

---

## 2026-03-08 — Suppression log sauvegardé blockchain (trop verbeux)

### Suppression log individuel par trade blockchain
- **Pourquoi** : Des centaines de "sauvegardé" par minute dans le terminal, la plupart jamais copiés
- **Modifié** : `src/services/blockchainMonitor.ts`
  - Supprimé le `Logger.info("⚡ BLOCKCHAIN #X: BUY/SELL sauvegardé → ...")` dans `saveSyntheticTrade()`
  - Le compteur `blockchainTradeCount` s'incrémente toujours (visible au shutdown)

---

## 2026-03-08 — Fix critique : trades obsolètes bloquant l'exécuteur

### Filtre timestamp dans readTempTrades() + purge bulk au démarrage
- **Pourquoi** : Des milliers de vieux trades (bot:false) de sessions précédentes saturaient readTempTrades(), bloquant les nouveaux trades pendant 10-20+ min (à 86ms par trade)
- **Modifié** : `src/services/tradeExecutor.ts`
  - `readTempTrades()` : ajout filtre `{ timestamp: { $gte: cutoffTimestamp } }` dans la requête MongoDB → n'extrait que les trades récents (< TOO_OLD_TIMESTAMP_HOURS)
  - `tradeExecutor()` : purge bulk au démarrage : `updateMany({ bot:false, timestamp: { $lt: cutoff } })` pour chaque trader → marque tous les vieux trades en 1 requête par trader au lieu de 1086 requêtes individuelles

---

## 2026-03-07 — Fix gel au démarrage : init() et processOneTrader optimisés

### Parallélisation init() + bulk MongoDB dans processOneTrader
- **Pourquoi** : Le bot figeait plusieurs dizaines de secondes au démarrage à cause de boucles séquentielles sur 63 traders
- **Modifié** : `src/services/tradeMonitor.ts`
  - `init()` : 2 boucles `for await` séquentielles → `Promise.all()` (countDocuments × 63 + UserPosition.find × 63 en parallèle)
  - `init()` : positions bot + positions traders lancées en parallèle avec `Promise.all`
  - `processOneTrader()` : N×`findOne()` séquentiels → 1 `find($in)` + `Set` lookup + `insertMany` (premier run) ou save individuel (runs suivants)
  - Gain estimé : démarrage ~30-60s → ~3-5s

---

## 2026-03-07 — Optimisation : appels API parallèles à la pose d'ordre

### Parallélisation fetch positions bot + balance + logMarketPrice
- **Pourquoi** : Économiser ~600ms par trade en faisant tourner les appels réseau indépendants en parallèle au lieu de séquentiellement
- **Modifié** : `src/services/tradeExecutor.ts`
  - `doTrading` : `fetchData(botPositions)` + `getBalance()` → `Promise.all([...])` (~300ms économisés)
  - `doAggregatedTrading` : même optimisation
- **Modifié** : `src/utils/postOrder.ts`
  - `logMarketPriceAtTraderTime()` : suppression du `await` (fire & forget — info seulement, non bloquant) (~300ms économisés)
  - Appliqué dans les deux branches (DRY_RUN + réel)

---

## 2026-03-07 — Réduction intervalle vérification positions abandonnées

### analyzePositionAlignment : passage de 15 min à 5 min
- **Pourquoi** : Réagir plus vite aux ventes manquées — 15 min était trop lent pour le backup system
- **Modifié** : `src/scripts/analyzePositionAlignment.ts`
  - `setInterval` : `15 * 60 * 1000` → `5 * 60 * 1000`
  - Logs de démarrage et de cycle mis à jour en conséquence

---

## 2026-03-07 — Confirmation timing d'exécution des trades

### Log de confirmation post-exécution
- **Pourquoi** : Savoir si l'ordre a été placé dans un délai acceptable après le trade du trader
- **Modifié** : `src/services/tradeExecutor.ts`
  - Ajout d'un timer `orderStartMs` juste avant `postOrder()`
  - Après `postOrder()`, log du temps de placement de l'ordre + délai total trader→bot
  - Icône selon délai total : ⚡ <30s (dans les temps) | ⏱ <90s (acceptable) | 🐌 (hors délai)

---

## 2026-03-07 — Dip Follower : acheter quand le trader est en perte

### Fonctionnalité DIP_FOLLOW
- **Pourquoi** : Permettre au bot d'acheter une position qu'un trader détient déjà, mais seulement si le prix actuel est en dessous du prix d'achat du trader (dip) — opportunité d'entrée au rabais
- **Créé** : `src/services/positionDipFollower.ts`
  - Scan périodique des positions ouvertes de tous les traders (toutes les 15 min)
  - Filtre : marché actif (non résolu, non résiduel), prix actuel < avg trader d'au moins X%, pas trop ancienne
  - Confirmation via order book live (bid/ask)
  - Achat en DRY_RUN via `executeSimulatedTrade` + enregistrement dans `positionTracker`
  - Achat réel via CLOB client
  - La revente est automatiquement gérée par `tradeExecutor` existant (copie SELL du trader)
- **Modifié** : `src/config/env.ts`
  - Ajout de `DIP_FOLLOW_ENABLED`, `DIP_FOLLOW_MIN_DIP_PERCENT`, `DIP_FOLLOW_MAX_POSITION_DAYS`, `DIP_FOLLOW_INTERVAL_MINUTES`, `DIP_FOLLOW_MIN_CURRENT_PRICE`, `DIP_FOLLOW_MAX_CURRENT_PRICE`
- **Modifié** : `.env`
  - Ajout de la section `DIP FOLLOWER` avec toutes les variables (désactivé par défaut)
- **Modifié** : `src/index.ts`
  - Import + démarrage du dip follower 2 min après le lancement (si `DIP_FOLLOW_ENABLED=true`)

---

## 2026-03-07 — Fix crash ethers.js WebSocket "callback undefined"

### Fix crash bot sur erreur interne ethers.js v5
- **Pourquoi** : Quand de nombreux events blockchain arrivent en rafale, ethers.js v5 WebSocketProvider désynchronise sa map interne de callbacks → `Cannot read properties of undefined (reading 'callback')` → uncaughtException → arrêt du bot
- **Modifié** : `src/services/blockchainMonitor.ts`
  - Ajout de `restartBlockchainMonitor()` — remet `isMonitorRunning=true` et reconnecte le WebSocket
- **Modifié** : `src/index.ts`
  - Handler `uncaughtException` : détecte ce bug spécifique et appelle `restartBlockchainMonitor()` au lieu d'arrêter le bot
  - Import de `restartBlockchainMonitor` ajouté

---

## 2026-03-06 — WebSocket : Alchemy → publicnode.com (fix 429)

### Fix WebSocket rate limit
- **Pourquoi** : Alchemy free tier retourne HTTP 429 sur le WebSocket → bot en REST-only, délai 80s au lieu de ~3-15s
- **Modifié** : `.env`
  - `POLYGON_WS_URL` : `wss://polygon-mainnet.g.alchemy.com/...` → `wss://polygon-bor-rpc.publicnode.com`
  - Le nœud Alchemy reste pour le HTTP RPC (getMyBalance, getCode) — moins soumis aux 429

---

## 2026-03-06 — Stratégie FIXED_TOKENS → FIXED $10 par position

### Changement stratégie de copie
- **Pourquoi** : FIXED_TOKENS achetait 10 tokens peu importe le prix → montant en $ variable. L'utilisateur veut $10 fixe par trade.
- **Modifié** : `.env`
  - `COPY_STRATEGY='FIXED_TOKENS'` → `COPY_STRATEGY='FIXED'`
  - `COPY_SIZE='10.0'` inchangé (signifie maintenant $10 USDC, pas 10 tokens)

---

## 2026-03-06 — Fix premier démarrage : timeout 60s sur fetch initial des 63 traders

### Fix : bot figé 10+ minutes sur "Waiting for historical trades to be marked..."
- **Pourquoi** : Au démarrage, `fetchTradeData()` fait 2 appels API × 63 traders = 126
  appels. Si Polymarket rate-limite certains traders, chaque batch peut prendre 30s.
  Avec 8 batches × 30s = 4+ min min → 10+ min en pratique. Les `findOne({ transactionHash })`
  sur des collections de 24k trades sans index aggravaient le problème.
- **Modifié** : `src/services/tradeMonitor.ts`
  - `fetchTradeData()` au premier démarrage wrappé dans `Promise.race` avec timeout 60s
  - Après 60s : log warning + continue avec `updateMany` fallback (marque tout comme traité)
  - Le bot démarre toujours en < 90s même si l'API est lente ou rate-limitée

---

## 2026-03-06 — Fix crash WebSocket 429 : bot ne plante plus si Alchemy rate-limite

### Fix : Uncaught Exception "Unexpected server response: 429" → crash total
- **Pourquoi** : Quand Alchemy retourne HTTP 429 pendant le handshake WebSocket,
  la bibliothèque `ws` émet un event `'unexpected-response'` non capturé par ethers.js.
  Sans handler, Node.js le propage en `uncaughtException` → graceful shutdown → bot mort.
- **Modifié** : `src/services/blockchainMonitor.ts`
  - Accès au WebSocket brut via `(provider as any)._websocket`
  - Handler `'unexpected-response'` intercepte le 429 AVANT qu'il remonte
  - Logique de retry exponentielle existante utilisée (5s → 10s → 20s → 60s max)
  - Le bot continue de fonctionner (REST polling actif pendant la reconnexion)

---

## 2026-03-06 — Fix "could not detect network" : provider singleton + réseau fixe

### Fix : ethers.js créait un nouveau provider à chaque trade et auto-détectait le réseau
- **Pourquoi** : `getMyBalance` créait `new JsonRpcProvider(url)` à chaque appel,
  forçant un appel `eth_chainId` de détection réseau à chaque fois. Avec le rate
  limit Alchemy, ce call échouait → `could not detect network` dans les logs.
- **Modifié** : `src/utils/getMyBalance.ts`
  - Réseau Polygon déclaré explicitement `{ chainId: 137, name: 'matic' }` → plus d'auto-détection
  - Provider singleton réutilisé entre les appels → moins de connexions RPC

---

## 2026-03-06 — Fix rate limit Alchemy : trades ne bloquent plus si RPC 429

### Fix : getMyBalance appelé à chaque trade → blocage si RPC rate-limité
- **Pourquoi** : `tradeExecutor` appelle `getMyBalance` (ethers.js / RPC) avant chaque
  trade. En DRY_RUN, cette valeur sert uniquement à l'affichage — si Alchemy
  retourne 429, le trade entier bloquait ou plantait.
- **Modifié** : `src/services/tradeExecutor.ts`
  - Ajout fonction `getBalance()` avec try/catch
  - En DRY_RUN : fallback sur `simulationTracker.getCurrentBalance()` si RPC échoue
  - En mode réel : erreur propagée (balance critique pour le vrai trading)

---

## 2026-03-06 — Fix gel au démarrage : timeouts manquants dans health check

### Fix : bot figé indéfiniment sur "Performing initial health check..."
- **Pourquoi** : `getMyBalance` utilise ethers.js `JsonRpcProvider` sans aucun timeout.
  Si le RPC est lent/down, le health check bloquait pour toujours.
  Idem pour `fetchData` Polymarket (3 retries × 10s = 30s possible sans fin).
  MongoDB aussi sans `serverSelectionTimeoutMS`.
- **Modifié** : `src/utils/healthCheck.ts`
  - Ajout fonction `withTimeout<T>()` (Promise.race + setTimeout)
  - Wrap `getMyBalance` → timeout 8s max
  - Wrap `fetchData` Polymarket → timeout 10s max
- **Modifié** : `src/config/db.ts`
  - Ajout `serverSelectionTimeoutMS: 10000` et `connectTimeoutMS: 10000`
  - Le bot échoue proprement si MongoDB ne répond pas en 10s (au lieu de bloquer)

---

## 2026-03-04 — Protection simulation : double filtre prix + slippage copie

### Fix : bot achetait à $0.999 quand trader avait payé $0.036 (+2675% slippage)
- **Pourquoi** : Un 1er fix (mid price) avait retiré la protection correcte. Le bot simulait
  des achats à $0.999 pour trades où trader avait payé $0.036.
  Live compare montrait Bot P&L -50% vs Trader P&L +1289%.
- **Modifié** : `src/utils/simulationExecutor.ts`
  - Revenu à `fillResult.avgPrice` (ask) pour le check `MAX_BUY_PRICE` (comportement original)
  - Ajout 2ème check : **slippage copie** = (ask - prix trader) / prix trader
    → si slippage > `SIMULATION_MAX_SLIPPAGE_PERCENT` (défaut 5%), trade rejeté
    → protège : ask $0.999 / trader $0.036 = 2675% → bloqué ✅
- **Modifié** : `src/utils/postOrder.ts`
  - Suppression du check secondaire redondant sur `result.avgPrice`

---

## 2026-03-04 — Blockchain monitor (Polygon WebSocket)

### Détection ultra-rapide des trades on-chain (~3s vs 17-65s)
- **Pourquoi** : Court-circuiter l'indexation Polymarket (15-60s) en lisant directement la blockchain
- **Créé** : `src/services/blockchainMonitor.ts`
  - WebSocket ethers v5 sur nœud Polygon (configurable via POLYGON_WS_URL)
  - Écoute `OrderFilled` events sur CTFExchange + NegRiskExchange (2 contrats Polymarket)
  - Décodage : makerAssetId==0 → USDC (BUY), sinon token conditionnel (SELL)
  - Lookup conditionId : MongoDB positions → Gamma API (3 couches cache)
  - Sauvegarde trade synthétique directement en MongoDB (bot:false) → executor 200ms
  - Déduplication via transactionHash (quand l'API Polymarket synchro plus tard, TX déjà présente)
  - Auto-reconnect exponentiel (5s → 10s → ... → 60s max)
  - Ping santé toutes les 30s, désactivé silencieusement si POLYGON_WS_URL absent
- **Modifié** : `src/config/env.ts` — ajout `POLYGON_WS_URL` optionnel
- **Modifié** : `src/index.ts` — démarre blockchainMonitor(), arrêt au gracefulShutdown
- **Modifié** : `.env.example` — documentation POLYGON_WS_URL (public + Alchemy)

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
