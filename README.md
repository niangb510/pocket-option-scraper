# Pocket Option Scraper — collecte de prix et simulation de stratégies

Outil Node.js qui **récupère les prix en temps réel** d'un actif affiché dans le navigateur, les **agrège en bougies de 1 minute** et **simule une stratégie de trading en direct** (paper trading : aucun ordre réel n'est passé), puis produit des **rapports statistiques**.

Projet personnel réalisé pendant mon Bachelor Informatique à Epitech, pour répondre à une question simple : *une stratégie basée sur les bougies peut-elle être rentable ?* Les résultats sont plus bas : la réponse est **non**.

## Fonctionnalités

- **Interception WebSocket via le Chrome DevTools Protocol** : le prix est lu directement dans les messages reçus par la page, et non dans le DOM (il est dessiné dans un canvas).
- **Navigateur Chromium au choix** : détection automatique d'Opera / Opera GX / Chrome (`puppeteer-core`). Avec Opera, le VPN intégré peut être activé.
- **Export CSV horodaté** avec rotation automatique des fichiers (`csv-writer.js`).
- **Moteur de simulation** (`simulation-engine.js`) : bougies 1 min, signal de retournement après 2 bougies identiques, trades virtuels de 1 min, payout de 85 %, statistiques en direct.
- **Analyse et rapports** : séquences, probabilités de transition, motifs, backtests de plusieurs stratégies, rapport HTML/JSON.

## Architecture

```
scraper.js ──► interception WebSocket (CDP) ──► tick { timestamp, prix }
                                                   │
                         ┌─────────────────────────┴───────────────┐
                         ▼                                         ▼
               csv-writer.js → data/po_*.csv          simulation-engine.js
                         │                              (bougies 1 min + trades virtuels)
                         ▼                                         │
      analyze_data.js / generate_rapport_complet.js ◄──────────────┘
                         │
                         ▼
                 reports/ (HTML, JSON, TXT)
```

| Fichier | Rôle |
|---|---|
| `scraper.js` | Lance le navigateur, intercepte les WebSockets, extrait le prix et écrit les ticks |
| `csv-writer.js` | Petit utilitaire d'écriture CSV |
| `simulation-engine.js` | Paper trading en temps réel sur les ticks reçus |
| `analyze_data.js` | Statistiques et backtest des stratégies sur un CSV |
| `generate_rapport_complet.js` | Rapport HTML complet sur tous les CSV d'un dossier |
| `samples/` | Données réelles d'une session de 6 h (EUR/TRY OTC, 12 juin 2026) |
| `docs/` | Bilan de cette session |

## Installation

Prérequis : **Node.js 18+** et un navigateur Chromium installé (Opera, Opera GX ou Chrome).

```bash
git clone https://github.com/niangb510/pocket-option-scraper.git
cd pocket-option-scraper
npm install
```

## Utilisation

### Essayer sans compte, avec les données d'exemple

```bash
npm run demo:analyze   # statistiques + backtest sur samples/
npm run demo:report    # rapport HTML complet dans reports/
```

### Collecte en direct

```bash
npm start
```

1. Le navigateur s'ouvre (si c'est Opera, active le VPN puis appuie sur Entrée).
2. Connecte-toi **manuellement** à ton compte (de préférence un compte démo) et choisis l'actif.
3. Appuie sur **Entrée** dans le terminal : la collecte et la simulation démarrent.
4. **Ctrl+C** pour arrêter. Les fichiers sont écrits dans `data/`.

Variables d'environnement facultatives :

| Variable | Défaut | Rôle |
|---|---|---|
| `PO_BROWSER_PATH` | détection auto | Chemin vers l'exécutable du navigateur |
| `PO_ASSET` | — | Actif à surveiller |
| `PO_INTERVAL` | `1000` | Intervalle d'échantillonnage (ms) |
| `PO_HEADLESS` | `false` | Navigateur sans fenêtre |
| `PO_SKIP_SCAN` | `false` | Sauter le scan initial de la page |

### Analyser ses propres données

```bash
node analyze_data.js data/po_MON_ACTIF.csv     # sans argument : le CSV le plus récent de data/
node generate_rapport_complet.js data          # tous les CSV du dossier
```

## Résultats

Session réelle du 12 au 13 juin 2026, sur EUR/TRY OTC, pendant 6 heures :

| Mesure | Valeur |
|---|---|
| Ticks collectés | 18 609 |
| Ticks haussiers / baissiers | 1 056 / 1 053 |
| Trades simulés (mise 1 €, 1 min) | 90 |
| Taux de réussite | **50,6 %** |
| Résultat net | **−5,60 €** |

**Conclusion.** Avec un payout de 85 %, il faut gagner plus de **54 %** des trades rien que pour ne pas perdre d'argent. La stratégie testée fait 50,6 %, c'est-à-dire le niveau du hasard. Un premier backtest affichait 69 %, mais sur seulement 26 trades : l'échantillon était trop petit et le résultat ne s'est pas confirmé en conditions réelles. Les actifs « OTC » ont en plus des prix fixés par le courtier lui-même, et non par un marché.

Ce projet m'a surtout appris **à vérifier une stratégie sur assez de données avant d'y croire**.

## Ce que j'ai appris

- Lire les communications d'une application web temps réel avec le Chrome DevTools Protocol (frames WebSocket).
- Extraire une donnée qui n'apparaît pas dans le DOM (rendu canvas).
- Agréger un flux de ticks en bougies OHLC et construire un moteur de simulation événementiel.
- Évaluer une stratégie avec rigueur : taille d'échantillon, seuil de rentabilité, comparaison au hasard.

## Pistes d'amélioration

- Brancher le moteur de simulation sur des **données de marché réelles et longues** (API Binance, Yahoo Finance) pour des backtests sur plusieurs années.
- Ajouter des tests unitaires pour `simulation-engine.js`.
- Passer en TypeScript.

## Avertissements

- **Projet éducatif.** Ce n'est pas un conseil en investissement, et aucun ordre réel n'est passé.
- Les options binaires sont interdites à la commercialisation auprès des particuliers dans l'Union européenne (ESMA, 2018). Pocket Option n'est pas un courtier agréé en France : consulte les listes noires de l'AMF.
- L'automatisation d'un site peut être contraire à ses conditions d'utilisation : c'est à vous de les vérifier.
- **Ne publiez jamais** le dossier `data/` ni les dossiers `tmp-*` : ils peuvent contenir des messages WebSocket avec votre jeton de session, ou une copie de votre profil navigateur. Ils sont exclus par `.gitignore`.

## Licence

MIT, voir [LICENSE](LICENSE).
