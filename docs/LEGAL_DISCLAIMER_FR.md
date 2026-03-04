# 📜 Avis Juridique et Description Technique

**Document explicatif sur le fonctionnement du bot et sa conformité légale au Québec**

---

## 📋 Table des Matières

1. [Description du Logiciel](#1-description-du-logiciel)
2. [Fonctionnement Technique](#2-fonctionnement-technique)
3. [Architecture et Infrastructure](#3-architecture-et-infrastructure)
4. [Distinction avec Polymarket](#4-distinction-avec-polymarket)
5. [Cadre Juridique au Québec](#5-cadre-juridique-au-québec)
6. [Responsabilités de l'Utilisateur](#6-responsabilités-de-lutilisateur)
7. [Avertissements](#7-avertissements)

---

## 1. Description du Logiciel

### 1.1 Qu'est-ce que ce logiciel ?

Ce logiciel est un **outil d'automatisation de trading personnel** qui permet de répliquer automatiquement les stratégies de traders expérimentés sur les marchés de prédiction décentralisés. Il s'agit d'un **bot de copy-trading** qui fonctionne de manière autonome sur l'infrastructure blockchain Polygon.

### 1.2 Objectif du logiciel

- Automatiser l'exécution de trades basés sur les actions de traders sélectionnés
- Fournir des outils d'analyse et de simulation
- Permettre la gestion de portefeuille de manière programmatique
- Offrir un mode simulation pour tester des stratégies sans risque financier

### 1.3 Ce que le logiciel N'EST PAS

- ❌ **Pas une plateforme de paris** - Le logiciel ne gère aucun marché
- ❌ **Pas un intermédiaire financier** - Aucun fonds ne transite par le logiciel
- ❌ **Pas un service de conseil en investissement** - L'utilisateur est seul responsable
- ❌ **Pas affilié à Polymarket** - Logiciel indépendant et open-source

---

## 2. Fonctionnement Technique

### 2.1 Principe de base

Le bot observe les transactions publiques effectuées par des traders sur la blockchain Polygon et peut répliquer ces transactions depuis le portefeuille personnel de l'utilisateur.

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Blockchain    │────▶│   Bot Local     │────▶│  Wallet Perso   │
│    Polygon      │     │  (Observation)  │     │  (Exécution)    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

### 2.2 Flux de données

1. **Lecture** : Le bot lit les données publiques de la blockchain Polygon
2. **Analyse** : Identification des trades effectués par les traders suivis
3. **Décision** : Application des règles configurées par l'utilisateur
4. **Exécution** : Soumission de transactions depuis le wallet de l'utilisateur

### 2.3 Interactions blockchain

Le logiciel interagit **exclusivement** avec :
- **Polygon (MATIC)** : Réseau blockchain de layer 2
- **Smart contracts CLOB** : Contrats de carnet d'ordres décentralisé
- **Tokens ERC-20** : USDC pour les transactions

### 2.4 Mode Simulation

Le logiciel inclut un **mode simulation (DRY_RUN)** qui :
- N'effectue aucune transaction réelle
- Utilise une balance virtuelle
- Permet de tester des stratégies sans risque
- Enregistre les performances hypothétiques

---

## 3. Architecture et Infrastructure

### 3.1 Exécution locale

Le logiciel s'exécute **entièrement sur l'ordinateur de l'utilisateur** :

```
┌──────────────────────────────────────────────────────────┐
│                    ORDINATEUR LOCAL                       │
│  ┌─────────────────────────────────────────────────────┐ │
│  │                   Bot Copy-Trading                   │ │
│  │  • Configuration personnelle (.env)                  │ │
│  │  • Base de données locale (MongoDB)                  │ │
│  │  • Logs et rapports locaux                          │ │
│  │  • Clé privée stockée localement                    │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│              BLOCKCHAIN POLYGON (PUBLIQUE)                │
│  • Lecture des transactions publiques                     │
│  • Soumission de transactions signées                     │
│  • Interaction avec smart contracts décentralisés         │
└──────────────────────────────────────────────────────────┘
```

### 3.2 Aucun serveur centralisé

- **Pas de serveur tiers** : Toute l'exécution est locale
- **Pas de compte utilisateur** : Aucune inscription requise
- **Pas de collecte de données** : Les données restent sur l'ordinateur
- **Open-source** : Code vérifiable publiquement

### 3.3 Contrôle total de l'utilisateur

L'utilisateur conserve **100% du contrôle** sur :
- Sa clé privée (jamais partagée)
- Ses fonds (dans son propre wallet)
- La configuration du bot
- L'exécution ou l'arrêt du logiciel

---

## 4. Distinction avec Polymarket

### 4.1 Qu'est-ce que Polymarket ?

Polymarket est une **plateforme centralisée** de marchés de prédiction qui :
- Gère une interface web (polymarket.com)
- Nécessite une inscription et vérification d'identité
- Opère sous juridiction américaine
- Est **inaccessible aux résidents canadiens** via son interface

### 4.2 Ce que ce bot utilise

Ce logiciel **n'utilise PAS** Polymarket directement. Il interagit avec :

| Composant | Description | Contrôle |
|-----------|-------------|----------|
| **Polygon** | Blockchain publique | Décentralisé |
| **CLOB Contracts** | Smart contracts de trading | Décentralisé |
| **USDC** | Stablecoin | Décentralisé |
| **API publiques** | Données de marché | Publiques |

### 4.3 Différences fondamentales

| Aspect | Polymarket (Web) | Ce Bot |
|--------|------------------|--------|
| **Interface** | Site web centralisé | Logiciel local |
| **Inscription** | Requise avec KYC | Aucune |
| **Géoblocage** | Bloqué au Canada | N/A |
| **Exécution** | Serveurs Polymarket | Ordinateur local |
| **Contrôle fonds** | Via Polymarket | Wallet personnel |
| **Intermédiaire** | Oui | Non |

### 4.4 Interaction directe avec la blockchain

```
POLYMARKET.COM (Interface Web)
        ❌ Bloqué au Canada
        │
        ▼
┌───────────────────────────┐
│   Serveurs Polymarket     │  ◀── Ce bot N'UTILISE PAS ceci
└───────────────────────────┘
        │
        ▼
┌───────────────────────────┐
│  Smart Contracts Polygon  │  ◀── Ce bot interagit DIRECTEMENT ici
└───────────────────────────┘
        ▲
        │
   BOT LOCAL (Ce logiciel)
        ✅ Aucun intermédiaire
```

---

## 5. Cadre Juridique au Québec

### 5.1 Statut légal des cryptomonnaies

Au Canada et au Québec :
- Les cryptomonnaies sont considérées comme des **biens** (propriété)
- Leur détention et échange sont **légaux**
- Les gains sont assujettis à l'**impôt sur les gains en capital**

### 5.2 Réglementation des marchés de prédiction

La Loi sur les loteries du Québec réglemente les **activités de jeu organisées** :
- Les **opérateurs** de jeux de hasard doivent être licenciés
- Les **participants** utilisant des outils personnels ne sont pas visés

### 5.3 Pourquoi ce logiciel est différent

Ce logiciel **ne constitue pas** une activité de jeu réglementée car :

1. **Pas d'opérateur** : L'utilisateur agit pour son propre compte
2. **Pas d'intermédiaire** : Transactions directes sur blockchain
3. **Outil personnel** : Comparable à un tableur ou calculatrice
4. **Pas de service** : Aucun service n'est fourni à des tiers

### 5.4 Analogie juridique

Ce logiciel est comparable à :
- Un **robot de trading boursier** personnel
- Un **script d'automatisation** financière
- Un **outil d'analyse** de données publiques

Ces outils sont légaux lorsqu'utilisés à des fins personnelles.

### 5.5 Distinction avec le jeu illégal

| Jeu illégal | Ce logiciel |
|-------------|-------------|
| Opérateur non licencié offrant des paris | Outil personnel sans opérateur |
| Service offert au public | Usage privé uniquement |
| Fonds détenus par un tiers | Fonds dans wallet personnel |
| Profit de l'organisation | Aucun profit pour le logiciel |

---

## 6. Responsabilités de l'Utilisateur

### 6.1 Obligations fiscales

L'utilisateur est **seul responsable** de :
- Déclarer ses gains et pertes aux autorités fiscales
- Conserver un historique de ses transactions
- Payer les impôts applicables sur les gains en capital

### 6.2 Conformité légale

L'utilisateur doit s'assurer que :
- L'utilisation est conforme aux lois de sa juridiction
- Il comprend les risques associés au trading
- Il n'utilise pas le logiciel à des fins illégales

### 6.3 Gestion des risques

L'utilisateur reconnaît que :
- Le trading comporte des risques de perte
- Les performances passées ne garantissent pas les résultats futurs
- Le mode simulation ne reflète pas exactement le trading réel

---

## 7. Avertissements

### 7.1 Avertissement général

⚠️ **CE LOGICIEL EST FOURNI "TEL QUEL" SANS AUCUNE GARANTIE**

- Aucune garantie de profit ou de performance
- L'utilisateur assume tous les risques financiers
- Les développeurs ne sont pas responsables des pertes

### 7.2 Avertissement sur les risques

⚠️ **LE TRADING COMPORTE DES RISQUES IMPORTANTS**

- Risque de perte totale du capital investi
- Volatilité des marchés de cryptomonnaies
- Risques techniques (bugs, pannes, etc.)
- Risques de smart contracts

### 7.3 Avertissement juridique

⚠️ **CE DOCUMENT N'EST PAS UN AVIS JURIDIQUE**

- Consultez un avocat pour des conseils juridiques personnalisés
- Les lois peuvent changer et varier selon les juridictions
- L'utilisateur est responsable de sa propre conformité légale

### 7.4 Non-affiliation

Ce logiciel est **indépendant** et **non affilié** à :
- Polymarket Inc.
- Polygon Technology
- Toute autre entreprise ou organisation

---

## 📞 Contact et Support

Ce logiciel est open-source et fourni à des fins éducatives et personnelles uniquement.

**Dernière mise à jour** : Février 2026

---

*Ce document est fourni à titre informatif uniquement et ne constitue pas un avis juridique. Consultez un professionnel qualifié pour des conseils adaptés à votre situation.*
