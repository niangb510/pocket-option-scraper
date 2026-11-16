const fs = require('fs');
const path = require('path');
const CsvWriter = require('./csv-writer');

const CANDLE_EPSILON = 0.00001;

/**
 * SimulationEngine — Moteur de Paper Trading virtuel
 * Stratégie : Retournement de tendance immédiat (Breakout après 2 bougies identiques)
 */
class SimulationEngine {
  constructor(asset) {
    this.asset = asset || 'unknown';

    // ── Agrégation en bougies de 1 minute ──
    this.currentCandle = null;   // { minute, open, high, low, close, tickCount }
    this.candleHistory = [];       // Bougies fermées non neutres

    // ── État des trades ──
    this.pendingTrade = null;      // Trade programmé pour la prochaine minute
    this.activeTrade = null;       // Trade ouvert en cours

    // ── Statistiques ──
    this.totalTrades = 0;
    this.winTrades = 0;
    this.lossTrades = 0;
    this.tieTrades = 0;
    this.totalProfit = 0;

    // ── CSV ──
    this.csvWriter = null;
    this._initCsv();
  }

  /**
   * Met à jour l'actif surveillé (appelé si l'asset change dans le scraper)
   */
  setAsset(asset) {
    if (asset && asset !== this.asset) {
      console.log(`[SIMULATION] 🔄 Actif mis à jour : ${this.asset} → ${asset}`);
      this.asset = asset;
    }
  }

  _initCsv() {
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const dateStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const csvPath = path.join(dataDir, `simulation_retournement_${dateStr}.csv`);
    this.csvWriter = new CsvWriter(csvPath, [
      'timestamp_signal',
      'timestamp_expiration',
      'asset',
      'direction',
      'prix_entree',
      'prix_sortie',
      'mise',
      'statut',
      'gain_net'
    ]);
  }

  /* ── Helpers ── */
  _getMinuteKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${d}_${h}:${min}`;
  }

  _getNextMinute(minuteKey) {
    const [datePart, timePart] = minuteKey.split('_');
    const [year, month, day] = datePart.split('-').map(Number);
    const [hour, minute] = timePart.split(':').map(Number);
    const date = new Date(year, month - 1, day, hour, minute);
    date.setMinutes(date.getMinutes() + 1);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${d}_${h}:${min}`;
  }

  _formatTime(date) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
  }

  /* ── Tick public ── */
  onTick(price, timestamp) {
    if (!price || price <= 0 || !timestamp) return;
    const now = timestamp instanceof Date ? timestamp : new Date(timestamp);
    const minuteKey = this._getMinuteKey(now);

    // Nouvelle minute ? → fermer la bougie précédente
    if (this.currentCandle && this.currentCandle.minute !== minuteKey) {
      this._closeCurrentCandle();
    }

    // Démarrer ou mettre à jour la bougie courante
    if (!this.currentCandle) {
      this.currentCandle = {
        minute: minuteKey,
        open: price,
        high: price,
        low: price,
        close: price,
        tickCount: 1
      };
    } else {
      this.currentCandle.high = Math.max(this.currentCandle.high, price);
      this.currentCandle.low = Math.min(this.currentCandle.low, price);
      this.currentCandle.close = price;
      this.currentCandle.tickCount++;
    }

    // Si un trade est programmé pour cette minute, on l'ouvre immédiatement
    // (la première tick de la nouvelle minute fait office de prix d'entrée)
    if (this.pendingTrade && this.pendingTrade.entryMinute === minuteKey) {
      this._openTrade(price, now);
    }
  }

  /* ── Fermeture de bougie ── */
  _closeCurrentCandle() {
    const candle = this.currentCandle;
    if (!candle) return;

    const diff = candle.close - candle.open;
    let color;
    if (diff >= CANDLE_EPSILON) color = 'VERT';
    else if (diff <= -CANDLE_EPSILON) color = 'ROUGE';
    else color = 'NEUTRE';

    const timeStr = candle.minute.split('_')[1];
    const candleEmoji = color === 'VERT' ? '🟢' : color === 'ROUGE' ? '🔴' : '⚪';
    console.log(`[BOUGIE] ${timeStr} ${candleEmoji} ${color} | O:${candle.open.toFixed(5)} C:${candle.close.toFixed(5)} | Ticks:${candle.tickCount}`);

    // Résoudre un trade actif qui expire sur cette bougie
    if (this.activeTrade && this.activeTrade.expirationMinute === candle.minute) {
      this._resolveTrade(candle.close);
    }

    // Logique stratégique uniquement sur bougies non neutres
    if (color !== 'NEUTRE') {
      this.candleHistory.push({
        minute: candle.minute,
        open: candle.open,
        close: candle.close,
        color
      });

      // Chercher un signal de cassure si aucun trade en cours
      if (!this.activeTrade && !this.pendingTrade) {
        this._checkBreakout();
      }
    }

    this.currentCandle = null;
  }

  /* ── Détection cassure : 2 bougies identiques + 3ème opposée ── */
  _checkBreakout() {
    const h = this.candleHistory;
    if (h.length < 3) return;

    const c1 = h[h.length - 3];
    const c2 = h[h.length - 2];
    const c3 = h[h.length - 1];

    // 2 bougies de même couleur consécutives, puis 3ème de couleur opposée
    if (c1.color === c2.color && c3.color !== c2.color) {
      const direction = c3.color === 'VERT' ? 'CALL' : 'PUT';
    const entryMinute = this._getNextMinute(c3.minute);
    const expirationMinute = entryMinute; // trade expire à la fermeture de la 4ème bougie (la minute d'entrée)

      this.pendingTrade = {
        direction,
        entryMinute,
        expirationMinute
      };

      console.log(`[SIGNAL] ⚡ Cassure détectée (${c2.color} x2 -> ${c3.color}). Lancement trade ${direction}.`);
    }
  }

  /* ── Ouverture du trade virtuel ── */
  _openTrade(price, timestamp) {
    if (!this.pendingTrade) return;
    const trade = this.pendingTrade;

    this.activeTrade = {
      direction: trade.direction,
      entryPrice: price,
      entryTime: new Date(timestamp),
      expirationMinute: trade.expirationMinute
    };
    this.pendingTrade = null;

    const nowStr = this._formatTime(timestamp);
    console.log(`[TRADE] 🚀 OUVERT | ${trade.direction} | Entrée: ${price.toFixed(5)} | Expire: ${trade.expirationMinute.split('_')[1]} (${nowStr})`);
  }

  /* ── Résolution du trade à la fermeture de la bougie d'expiration ── */
  _resolveTrade(exitPrice) {
    if (!this.activeTrade) return;
    const trade = this.activeTrade;
    const diff = exitPrice - trade.entryPrice;

    let won, statut, gainNet;
    if (trade.direction === 'CALL') {
      won = diff >= CANDLE_EPSILON;
    } else {
      won = diff <= -CANDLE_EPSILON;
    }

    if (won) {
      statut = 'GAGNE';
      gainNet = 0.85;
      this.winTrades++;
    } else if (Math.abs(diff) < CANDLE_EPSILON) {
      statut = 'NUL';
      gainNet = 0;
      this.tieTrades++;
    } else {
      statut = 'PERDU';
      gainNet = -1.00;
      this.lossTrades++;
    }

    this.totalTrades++;
    this.totalProfit += gainNet;

    const emoji = statut === 'GAGNE' ? '✅' : statut === 'NUL' ? '⚖️' : '❌';
    const sign = gainNet >= 0 ? '+' : '';
    console.log(`[TRADE] ${emoji} ${statut} | ${trade.direction} | ${sign}${gainNet.toFixed(2)}€ (Entrée: ${trade.entryPrice.toFixed(5)}, Sortie: ${exitPrice.toFixed(5)}) | Profit total: ${this.totalProfit.toFixed(2)}€`);

    this.csvWriter.writeRow({
      timestamp_signal: trade.entryTime.toISOString(),
      timestamp_expiration: new Date().toISOString(),
      asset: this.asset,
      direction: trade.direction,
      prix_entree: trade.entryPrice.toFixed(5),
      prix_sortie: exitPrice.toFixed(5),
      mise: 1,
      statut,
      gain_net: gainNet.toFixed(2)
    });

    this.activeTrade = null;
  }

  /* ── Arrêt ── */
  stop() {
    console.log('\n[SIMULATION] 🛑 Arrêt demandé...');
    const lastPrice = this.currentCandle ? this.currentCandle.close : null;
    if (this.currentCandle) {
      this._closeCurrentCandle();
    }
    if (this.activeTrade) {
      this._resolveTrade(lastPrice || this.activeTrade.entryPrice);
    }
    if (this.pendingTrade) {
      console.log(`[SIMULATION] ⚠️ Trade en attente annulé (${this.pendingTrade.direction})`);
      this.pendingTrade = null;
    }
    if (this.csvWriter) {
      this.csvWriter.close();
    }
    console.log(`[SIMULATION] 🏁 FIN | Trades: ${this.totalTrades} | Gagnés: ${this.winTrades} | Perdus: ${this.lossTrades} | Nuls: ${this.tieTrades} | Profit: ${this.totalProfit.toFixed(2)}€`);
  }
}

module.exports = SimulationEngine;
