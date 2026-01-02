# 📊 Graphique de Simulation - Guide d'Utilisation

## Vue d'ensemble

Le bot génère maintenant **automatiquement un graphique ASCII** montrant l'évolution de votre balance virtuelle pendant les simulations en mode `DRY_RUN`.

## Fonctionnalités

### ✅ Suivi Automatique
- **Enregistrement automatique** de chaque transaction (achat/vente)
- **Snapshots** de la balance après chaque trade
- **Historique complet** de la session de simulation

### 📈 Graphique ASCII
Le graphique affiche :
- **Évolution de la balance** dans le temps (ligne continue)
- **Valeur min/max** atteinte pendant la session
- **Profit/Perte** total en $ et %
- **Durée de la session**
- **Nombre de positions** ouvertes

## Comment l'utiliser

### 1. Mode Automatique (lors de l'arrêt)
Lorsque vous arrêtez le bot (Ctrl+C), le graphique s'affiche automatiquement :

```bash
npm start
# ... Le bot tourne ...
# Appuyez sur Ctrl+C

# Le graphique s'affiche automatiquement avant la fermeture
```

### 2. Affichage Toutes les 5 Minutes
En mode `DRY_RUN`, le bot affiche automatiquement :
- Le résumé de simulation
- Le graphique de balance

Toutes les **5 minutes** pendant qu'il tourne.

### 3. Commande Manuelle
Affichez le graphique à tout moment avec :

```bash
npm run chart
```

## Exemple de Sortie

```
──────────────────────────────────────────────────────────────────────
📊 BALANCE EVOLUTION CHART
──────────────────────────────────────────────────────────────────────
📅 Session Duration: 2h 34m 12s
💰 Starting Value: $1000.00
💵 Current Value:  $1125.50
🟢 Profit/Loss:   $125.50 (+12.55%)
📈 Peak Value:     $1180.20
📉 Lowest Value:   $975.30
──────────────────────────────────────────────────────────────────────

  $  1180 ┤
         ┤        ●●●●
         ┤      ●●│││││●●
         ┤    ●●││││││││││●
         ┤   ●│││││││││││││●●
         ┤  ●││││││││││││││││●
  $  1077 ┤ ●│││││││││││││││││●●
         ┤●││││││││││││││││││││●
         ┤││││││││││││││││││││││●
         ┤│││││││││││││││││││││││●●
         ┤││││││││││││││││││││││││││
         ┤│││││││││││││││││││││││││││
         ┤││││││││││││││││││││││││││││
         ┤││││││││││││││││││││││││││││
         ┤│││││││││││││││││││││││││││││
  $   975 ┤││││││││││││││││││││││││││││││
         └────────────────────────────────────────────────────────
          14:23                                           16:57

──────────────────────────────────────────────────────────────────────
📊 Total Snapshots: 47
📦 Current Positions: 8
──────────────────────────────────────────────────────────────────────
```

## Configuration

### Activer/Désactiver
Le graphique est automatiquement activé quand :
```env
DRY_RUN='true'
```

Dans votre fichier `.env`.

### Balance de Départ
Configurez le montant initial :
```env
SIMULATION_STARTING_BALANCE='1000.0'
```

## Données Enregistrées

Pour chaque snapshot, le bot enregistre :
- **Timestamp** : Date et heure exactes
- **Balance en cash** : USD disponibles
- **Valeur totale du portfolio** : Cash + positions
- **Nombre de positions** : Positions ouvertes

## Statistiques Affichées

### 📊 Métriques Principales
- **Starting Value** : Valeur au début de la session
- **Current Value** : Valeur actuelle du portfolio
- **Profit/Loss** : Gain/Perte en $ et %
- **Peak Value** : Valeur maximale atteinte
- **Lowest Value** : Valeur minimale atteinte

### 📈 Métriques de Trading
- **Session Duration** : Temps écoulé depuis le début
- **Total Snapshots** : Nombre de trades/événements enregistrés
- **Current Positions** : Positions actuellement ouvertes

## Cas d'Usage

### 🎯 Analyse de Performance
Utilisez le graphique pour :
- Vérifier la **tendance générale** (hausse/baisse)
- Identifier les **périodes volatiles**
- Comparer les **différentes stratégies**

### 🔍 Debugging
Le graphique aide à :
- Détecter des **pertes importantes** soudaines
- Voir l'**impact des cooldowns** sur les performances
- Analyser l'**efficacité de la stratégie** de copy trading

### 📚 Apprentissage
Avant d'utiliser de l'argent réel :
- **Testez** différents paramètres
- **Observez** l'évolution de la balance
- **Ajustez** votre stratégie en conséquence

## Notes Techniques

### Précision du Graphique
- **Résolution** : 60 points horizontaux, 15 lignes verticales
- **Interpolation** : Linéaire entre les snapshots
- **Format** : ASCII art pour compatibilité universelle

### Performance
- **Mémoire** : Minimal (quelques Ko pour l'historique)
- **CPU** : Négligeable (calculs simples)
- **Storage** : En mémoire uniquement (pas de fichiers)

### Limitations
- ⚠️ L'historique est **effacé** au redémarrage du bot
- ⚠️ Graphique ASCII uniquement (pas de PNG/SVG)
- ⚠️ Nécessite au moins **2 trades** pour générer le graphique

## Commandes Disponibles

| Commande | Description |
|----------|-------------|
| `npm start` | Lance le bot, affiche le graphique à l'arrêt |
| `npm run chart` | Affiche le graphique immédiatement |
| `npm run dev` | Mode développement avec graphique |

## Prochaines Améliorations Possibles

- [ ] Export du graphique en image PNG
- [ ] Sauvegarde de l'historique dans MongoDB
- [ ] Graphiques comparatifs multi-sessions
- [ ] Métriques avancées (Sharpe ratio, drawdown, etc.)
- [ ] Dashboard web interactif

## Support

Pour toute question ou suggestion :
1. Consultez d'abord [GETTING_STARTED.md](GETTING_STARTED.md)
2. Vérifiez que `DRY_RUN='true'` est activé
3. Assurez-vous d'avoir au moins 2 trades enregistrés

---

**Astuce** : Lancez le bot pendant quelques heures en mode simulation, puis arrêtez-le pour voir l'évolution complète de votre balance virtuelle ! 📊✨
