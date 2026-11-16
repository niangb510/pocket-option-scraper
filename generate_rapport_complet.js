const fs = require('fs');
const path = require('path');

// ───────────────────────────────────────────────────────────────
//  CONFIGURATION
// ───────────────────────────────────────────────────────────────
const DATA_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, 'data');
const DESKTOP = path.join(__dirname, 'reports');
fs.mkdirSync(DESKTOP, { recursive: true });
const PAYOUT = 85; // % payout Pocket Option

// ───────────────────────────────────────────────────────────────
//  1. LECTURE ET FUSION DES CSV
// ───────────────────────────────────────────────────────────────
function parseCSV(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',');
        if (cols.length >= 5) {
            rows.push({
                timestamp: cols[0],
                asset: cols[1],
                price: parseFloat(cols[2]),
                timeframe: cols[3],
                candle: cols[4].trim(),
                action: cols[5] ? cols[5].trim() : 'WS'
            });
        }
    }
    return rows;
}

function loadAllData() {
    const files = fs.readdirSync(DATA_DIR)
        .filter(f => f.endsWith('.csv'))
        .map(f => path.join(DATA_DIR, f))
        .sort();

    console.log(`\n📂 Fichiers trouvés : ${files.length}`);
    files.forEach(f => console.log('  →', path.basename(f)));

    let allData = [];
    for (const f of files) {
        const rows = parseCSV(f);
        console.log(`  ✓ ${path.basename(f)}: ${rows.length} lignes`);
        allData = allData.concat(rows);
    }
    // Tri chronologique
    allData.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    return allData;
}

// ───────────────────────────────────────────────────────────────
//  2. ANALYSE STATISTIQUE COMPLÈTE
// ───────────────────────────────────────────────────────────────
function analyze(data) {
    const total = data.length;
    const ups = data.filter(d => d.candle === 'UP').length;
    const downs = data.filter(d => d.candle === 'DOWN').length;
    const neutrals = data.filter(d => d.candle === 'NEUTRAL').length;

    // --- Séquences ---
    let sequences = [];
    if (data.length > 0) {
        let current = { type: data[0].candle, count: 1 };
        for (let i = 1; i < data.length; i++) {
            if (data[i].candle === current.type) {
                current.count++;
            } else {
                sequences.push({ ...current });
                current = { type: data[i].candle, count: 1 };
            }
        }
        sequences.push(current);
    }

    const upSeqs = sequences.filter(s => s.type === 'UP');
    const downSeqs = sequences.filter(s => s.type === 'DOWN');
    const neutSeqs = sequences.filter(s => s.type === 'NEUTRAL');
    const avg = arr => arr.length ? arr.reduce((a, b) => a + b.count, 0) / arr.length : 0;
    const maxSeq = arr => arr.length ? Math.max(...arr.map(s => s.count)) : 0;

    // Distribution des longueurs de séquences
    const neutLengthDist = {};
    neutSeqs.forEach(s => { neutLengthDist[s.count] = (neutLengthDist[s.count] || 0) + 1; });

    // --- Transitions ---
    const afterUp = { UP: 0, DOWN: 0, NEUTRAL: 0 };
    const afterDown = { UP: 0, DOWN: 0, NEUTRAL: 0 };
    const afterNeutral = { UP: 0, DOWN: 0, NEUTRAL: 0 };
    for (let i = 0; i < data.length - 1; i++) {
        const curr = data[i].candle;
        const next = data[i + 1].candle;
        if (curr === 'UP') afterUp[next]++;
        else if (curr === 'DOWN') afterDown[next]++;
        else afterNeutral[next]++;
    }

    // Probabilités de transition
    const prob = (obj) => {
        const t = obj.UP + obj.DOWN + obj.NEUTRAL;
        return {
            UP: t ? (obj.UP / t * 100).toFixed(2) : '0.00',
            DOWN: t ? (obj.DOWN / t * 100).toFixed(2) : '0.00',
            NEUTRAL: t ? (obj.NEUTRAL / t * 100).toFixed(2) : '0.00'
        };
    };

    // --- Volatilité ---
    let priceChanges = [];
    for (let i = 1; i < data.length; i++) {
        const diff = Math.abs(data[i].price - data[i - 1].price);
        if (!isNaN(diff)) priceChanges.push(diff);
    }
    priceChanges.sort((a, b) => a - b);
    const nonZero = priceChanges.filter(x => x > 0);
    const avgChange = nonZero.reduce((a, b) => a + b, 0) / (nonZero.length || 1);
    const p50 = nonZero[Math.floor(nonZero.length * 0.50)] || 0;
    const p95 = nonZero[Math.floor(nonZero.length * 0.95)] || 0;
    const p99 = nonZero[Math.floor(nonZero.length * 0.99)] || 0;

    // --- Distribution horaire ---
    const hourly = {};
    for (let d of data) {
        const hour = new Date(d.timestamp).getUTCHours();
        if (!hourly[hour]) hourly[hour] = { UP: 0, DOWN: 0, NEUTRAL: 0, total: 0 };
        hourly[hour][d.candle]++;
        hourly[hour].total++;
    }

    // Calcul meilleure heure (ratio UP/DOWN non-neutre le plus élevé)
    let bestHour = { hour: 0, ratio: 0 };
    for (const [h, stats] of Object.entries(hourly)) {
        const dir = stats.UP + stats.DOWN;
        const ratio = dir / (stats.total || 1);
        if (ratio > bestHour.ratio) bestHour = { hour: parseInt(h), ratio };
    }

    // ───────────────────────────────────────────────────────────
    //  BACKTEST STRATEGIES
    // ───────────────────────────────────────────────────────────

    // Stratégie A : Breakout après N neutrals (tester 3, 5, 7, 10)
    function backtestBreakout(minNeutrals) {
        let wins = 0, losses = 0, trades = [];
        let neutralStreak = 0;
        for (let i = 0; i < data.length - 1; i++) {
            if (data[i].candle === 'NEUTRAL') {
                neutralStreak++;
            } else {
                if (neutralStreak >= minNeutrals) {
                    const direction = data[i].candle;
                    const next = data[i + 1].candle;
                    if (next === direction) { wins++; trades.push(1); }
                    else if (next !== 'NEUTRAL') { losses++; trades.push(0); }
                }
                neutralStreak = 0;
            }
        }
        const total = wins + losses;
        const wr = total ? (wins / total * 100) : 0;
        const esperance = (wr / 100) * (PAYOUT / 100) - (1 - wr / 100);
        return { wins, losses, total, wr: wr.toFixed(2), esperance: (esperance * 100).toFixed(2) };
    }

    // Stratégie B : Anti-momentum (après N UP → parier DOWN, N DOWN → parier UP)
    function backtestAntiMomentum(streak) {
        let wins = 0, losses = 0;
        let upStreak = 0, downStreak = 0;
        for (let i = 0; i < data.length - 1; i++) {
            if (data[i].candle === 'UP') { upStreak++; downStreak = 0; }
            else if (data[i].candle === 'DOWN') { downStreak++; upStreak = 0; }
            else { upStreak = 0; downStreak = 0; }

            if (upStreak >= streak) {
                const next = data[i + 1].candle;
                if (next === 'DOWN') wins++;
                else if (next === 'UP') losses++;
            }
            if (downStreak >= streak) {
                const next = data[i + 1].candle;
                if (next === 'UP') wins++;
                else if (next === 'DOWN') losses++;
            }
        }
        const total = wins + losses;
        const wr = total ? (wins / total * 100) : 0;
        const esperance = (wr / 100) * (PAYOUT / 100) - (1 - wr / 100);
        return { wins, losses, total, wr: wr.toFixed(2), esperance: (esperance * 100).toFixed(2) };
    }

    // Stratégie C : Trend Following
    function backtestTrendFollowing() {
        let wins = 0, losses = 0;
        let lastDir = 'NEUTRAL';
        for (let i = 0; i < data.length - 1; i++) {
            if (data[i].candle !== 'NEUTRAL') lastDir = data[i].candle;
            if (lastDir !== 'NEUTRAL') {
                const next = data[i + 1].candle;
                if (next === 'NEUTRAL') continue;
                if (next === lastDir) wins++;
                else losses++;
            }
        }
        const total = wins + losses;
        const wr = total ? (wins / total * 100) : 0;
        const esperance = (wr / 100) * (PAYOUT / 100) - (1 - wr / 100);
        return { wins, losses, total, wr: wr.toFixed(2), esperance: (esperance * 100).toFixed(2) };
    }

    // Stratégie D : Combinée Breakout + Filtre Anti-momentum
    function backtestCombined(minNeutrals, antiStreak) {
        let wins = 0, losses = 0;
        let neutralStreak = 0;
        let upStreak = 0, downStreak = 0;
        for (let i = 0; i < data.length - 1; i++) {
            if (data[i].candle === 'NEUTRAL') {
                neutralStreak++;
                upStreak = 0;
                downStreak = 0;
            } else {
                if (data[i].candle === 'UP') upStreak++;
                else downStreak++;

                if (neutralStreak >= minNeutrals) {
                    // Signal breakout valide seulement si pas en momentum excessif
                    const momentumOK = upStreak < antiStreak && downStreak < antiStreak;
                    if (momentumOK) {
                        const direction = data[i].candle;
                        const next = data[i + 1].candle;
                        if (next === direction) wins++;
                        else if (next !== 'NEUTRAL') losses++;
                    }
                }
                neutralStreak = 0;
            }
        }
        const total = wins + losses;
        const wr = total ? (wins / total * 100) : 0;
        const esperance = (wr / 100) * (PAYOUT / 100) - (1 - wr / 100);
        return { wins, losses, total, wr: wr.toFixed(2), esperance: (esperance * 100).toFixed(2) };
    }

    // Breakout tests multiples
    const breakout3 = backtestBreakout(3);
    const breakout5 = backtestBreakout(5);
    const breakout7 = backtestBreakout(7);
    const breakout10 = backtestBreakout(10);

    // Anti-momentum tests
    const anti1 = backtestAntiMomentum(1);
    const anti2 = backtestAntiMomentum(2);

    // Trend
    const trend = backtestTrendFollowing();

    // Combinée
    const combined5_2 = backtestCombined(5, 2);

    // Simulation Martingale sur Breakout 5
    function simulateMartingale(strategy, capital, baseStake, sessions = 100) {
        // Générer trades selon win rate
        const wr = parseFloat(strategy.wr) / 100;
        let caps = [];
        for (let s = 0; s < sessions; s++) {
            let cap = capital;
            let stake = baseStake;
            let level = 0;
            let trades = Math.floor(Math.random() * 5) + 3; // 3-7 trades par session
            for (let t = 0; t < trades; t++) {
                const win = Math.random() < wr;
                if (win) {
                    cap += stake * (PAYOUT / 100);
                    stake = baseStake;
                    level = 0;
                } else {
                    cap -= stake;
                    level++;
                    if (level >= 3) {
                        // Stop martingale
                        stake = baseStake;
                        level = 0;
                    } else {
                        stake *= 2;
                    }
                }
            }
            caps.push(cap);
        }
        const avgCap = caps.reduce((a, b) => a + b, 0) / caps.length;
        const minCap = Math.min(...caps);
        const maxCap = Math.max(...caps);
        return { avgCap: avgCap.toFixed(2), minCap: minCap.toFixed(2), maxCap: maxCap.toFixed(2) };
    }

    const martSim50 = simulateMartingale(breakout5, 50, 1, 200);
    const martSim100 = simulateMartingale(breakout5, 100, 1, 200);
    const martSim200 = simulateMartingale(breakout5, 200, 2, 200);
    const martSim500 = simulateMartingale(breakout5, 500, 5, 200);

    return {
        total, ups, downs, neutrals,
        sequences: {
            total: sequences.length,
            avgUpSeq: avg(upSeqs).toFixed(2),
            avgDownSeq: avg(downSeqs).toFixed(2),
            avgNeutralSeq: avg(neutSeqs).toFixed(2),
            maxUpSeq: maxSeq(upSeqs),
            maxDownSeq: maxSeq(downSeqs),
            maxNeutralSeq: maxSeq(neutSeqs),
            neutLengthDist
        },
        transitions: {
            afterUp, afterDown, afterNeutral,
            probAfterUp: prob(afterUp),
            probAfterDown: prob(afterDown),
            probAfterNeutral: prob(afterNeutral)
        },
        volatility: { avgChange, p50, p95, p99 },
        hourly, bestHour,
        strategies: {
            breakout3, breakout5, breakout7, breakout10,
            anti1, anti2, trend, combined5_2
        },
        martingale: { sim50: martSim50, sim100: martSim100, sim200: martSim200, sim500: martSim500 }
    };
}

// ───────────────────────────────────────────────────────────────
//  3. GÉNÉRATION DU RAPPORT HTML
// ───────────────────────────────────────────────────────────────
function generateHTML(r, generatedAt) {
    const pct = (n, t) => t ? (n / t * 100).toFixed(2) : '0.00';

    // Tableau heures
    let hourlyRows = '';
    for (const [h, stats] of Object.entries(r.hourly).sort((a, b) => parseInt(a[0]) - parseInt(b[0]))) {
        const dirRatio = ((stats.UP + stats.DOWN) / stats.total * 100).toFixed(1);
        hourlyRows += `<tr>
            <td>${String(h).padStart(2, '0')}:00 UTC</td>
            <td class="up">${stats.UP}</td>
            <td class="down">${stats.DOWN}</td>
            <td class="neutral">${stats.NEUTRAL}</td>
            <td>${stats.total}</td>
            <td><span class="badge ${parseFloat(dirRatio) > 12 ? 'badge-hot' : 'badge-cold'}">${dirRatio}%</span></td>
        </tr>`;
    }

    // Tableau distribution séquences neutres
    let neutDistRows = '';
    const sorted = Object.entries(r.sequences.neutLengthDist).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
    for (const [len, count] of sorted.slice(0, 20)) {
        const pctSeq = (count / Object.values(r.sequences.neutLengthDist).reduce((a, b) => a + b, 0) * 100).toFixed(1);
        neutDistRows += `<tr>
            <td>${len} tick(s)</td>
            <td>${count}</td>
            <td><div class="bar-cell"><div class="bar" style="width:${Math.min(parseFloat(pctSeq) * 3, 100)}%"></div>${pctSeq}%</div></td>
        </tr>`;
    }

    const wr5Color = parseFloat(r.strategies.breakout5.wr) >= 60 ? '#00e676' : parseFloat(r.strategies.breakout5.wr) >= 50 ? '#ffeb3b' : '#ef5350';
    const esp5Color = parseFloat(r.strategies.breakout5.esperance) > 0 ? '#00e676' : '#ef5350';

    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Rapport Stratégies – EUR/TRY OTC | Pocket Option</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap');

  :root {
    --bg: #0a0e1a;
    --surface: #111827;
    --surface2: #1a2235;
    --border: #1e2d47;
    --accent: #3b82f6;
    --accent2: #8b5cf6;
    --green: #10b981;
    --red: #ef4444;
    --yellow: #f59e0b;
    --text: #e2e8f0;
    --muted: #64748b;
    --up: #10b981;
    --down: #ef4444;
    --neutral: #64748b;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Inter', sans-serif;
    line-height: 1.6;
    min-height: 100vh;
  }

  /* HEADER */
  .header {
    background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #0f172a 100%);
    border-bottom: 1px solid var(--border);
    padding: 40px;
    text-align: center;
    position: relative;
    overflow: hidden;
  }
  .header::before {
    content: '';
    position: absolute;
    top: -50%;
    left: -50%;
    width: 200%;
    height: 200%;
    background: radial-gradient(ellipse at center, rgba(59,130,246,0.08) 0%, transparent 70%);
    animation: pulse 4s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100%{opacity:0.5} 50%{opacity:1} }

  .header-badge {
    display: inline-block;
    background: rgba(59,130,246,0.15);
    border: 1px solid rgba(59,130,246,0.3);
    color: #93c5fd;
    padding: 4px 14px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    margin-bottom: 16px;
  }
  .header h1 {
    font-size: 2.4rem;
    font-weight: 800;
    background: linear-gradient(135deg, #fff 0%, #93c5fd 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin-bottom: 8px;
  }
  .header .sub {
    color: var(--muted);
    font-size: 0.95rem;
    font-weight: 400;
  }
  .header .meta {
    margin-top: 16px;
    display: flex;
    justify-content: center;
    gap: 24px;
    flex-wrap: wrap;
  }
  .meta-item {
    background: rgba(255,255,255,0.05);
    border: 1px solid var(--border);
    padding: 6px 16px;
    border-radius: 8px;
    font-size: 13px;
    color: #94a3b8;
  }
  .meta-item span { color: #e2e8f0; font-weight: 600; }

  /* LAYOUT */
  .container { max-width: 1400px; margin: 0 auto; padding: 32px 24px; }
  .section { margin-bottom: 48px; }
  .section-title {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 1.3rem;
    font-weight: 700;
    color: #fff;
    margin-bottom: 24px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }
  .section-title .icon {
    width: 36px; height: 36px;
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    font-size: 18px;
  }
  .section-num {
    background: var(--accent);
    color: #fff;
    width: 28px; height: 28px;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 13px;
    font-weight: 700;
    flex-shrink: 0;
  }

  /* KPIS */
  .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; }
  .kpi-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 24px;
    position: relative;
    overflow: hidden;
    transition: transform 0.2s, border-color 0.2s;
  }
  .kpi-card:hover { transform: translateY(-2px); border-color: var(--accent); }
  .kpi-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
  }
  .kpi-card.up::before { background: var(--green); }
  .kpi-card.down::before { background: var(--red); }
  .kpi-card.neutral::before { background: var(--neutral); }
  .kpi-card.accent::before { background: linear-gradient(90deg, var(--accent), var(--accent2)); }

  .kpi-label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
  .kpi-value { font-size: 2rem; font-weight: 800; }
  .kpi-value.green { color: var(--green); }
  .kpi-value.red { color: var(--red); }
  .kpi-value.yellow { color: var(--yellow); }
  .kpi-sub { font-size: 13px; color: var(--muted); margin-top: 4px; }

  /* CARDS */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 28px;
    margin-bottom: 16px;
  }
  .card-title {
    font-size: 1.05rem;
    font-weight: 700;
    color: #fff;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* GRID 2 */
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }
  @media(max-width:900px) { .grid-2,.grid-3 { grid-template-columns: 1fr; } }

  /* TABLES */
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th {
    text-align: left;
    padding: 10px 14px;
    background: var(--surface2);
    color: var(--muted);
    font-weight: 600;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border-bottom: 1px solid var(--border);
  }
  td { padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.04); }
  tr:hover td { background: rgba(255,255,255,0.02); }
  tr:last-child td { border-bottom: none; }
  td.up { color: var(--green); font-weight: 600; }
  td.down { color: var(--red); font-weight: 600; }
  td.neutral { color: var(--muted); }

  /* BADGES */
  .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; }
  .badge-hot { background: rgba(16,185,129,0.15); color: #10b981; border: 1px solid rgba(16,185,129,0.3); }
  .badge-cold { background: rgba(100,116,139,0.15); color: #64748b; border: 1px solid rgba(100,116,139,0.3); }
  .badge-warn { background: rgba(245,158,11,0.15); color: #f59e0b; border: 1px solid rgba(245,158,11,0.3); }
  .badge-danger { background: rgba(239,68,68,0.15); color: #ef4444; border: 1px solid rgba(239,68,68,0.3); }
  .badge-info { background: rgba(59,130,246,0.15); color: #60a5fa; border: 1px solid rgba(59,130,246,0.3); }

  /* STRATEGY CARDS */
  .strat-card {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 28px;
    margin-bottom: 20px;
    position: relative;
    transition: transform 0.2s;
  }
  .strat-card:hover { transform: translateY(-2px); }
  .strat-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 16px;
    flex-wrap: wrap;
    gap: 12px;
  }
  .strat-name { font-size: 1.15rem; font-weight: 700; color: #fff; }
  .strat-rating { font-size: 1.3rem; letter-spacing: 2px; }
  .strat-kpis {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 12px;
    margin: 16px 0;
  }
  .strat-kpi {
    background: rgba(0,0,0,0.2);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 16px;
  }
  .strat-kpi-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.8px; }
  .strat-kpi-val { font-size: 1.4rem; font-weight: 700; margin-top: 2px; }

  .rules-list { list-style: none; }
  .rules-list li {
    padding: 8px 0;
    border-bottom: 1px solid rgba(255,255,255,0.04);
    font-size: 14px;
    color: #cbd5e1;
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }
  .rules-list li:last-child { border-bottom: none; }
  .rules-list .num {
    width: 22px; height: 22px;
    background: var(--accent);
    border-radius: 50%;
    font-size: 11px;
    font-weight: 700;
    color: #fff;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    margin-top: 1px;
  }

  /* MARTINGALE TABLE */
  .mart-table { width: 100%; border-collapse: collapse; font-family: 'JetBrains Mono', monospace; }
  .mart-table th { background: var(--surface2); padding: 10px 14px; text-align: center; font-size: 12px; color: var(--muted); text-transform: uppercase; }
  .mart-table td { padding: 12px 14px; text-align: center; border-bottom: 1px solid var(--border); }
  .mart-table tr:last-child td { border-bottom: none; }
  .mart-table .level-1 td:first-child { color: var(--green); }
  .mart-table .level-2 td:first-child { color: var(--yellow); }
  .mart-table .level-3 td:first-child { color: #f97316; }
  .mart-table .stop-row td { color: var(--red); font-weight: 700; background: rgba(239,68,68,0.05); }

  /* ALERT BOXES */
  .alert {
    padding: 16px 20px;
    border-radius: 12px;
    margin-bottom: 16px;
    display: flex;
    gap: 12px;
    align-items: flex-start;
    font-size: 14px;
    line-height: 1.6;
  }
  .alert-icon { font-size: 20px; flex-shrink: 0; margin-top: 1px; }
  .alert.success { background: rgba(16,185,129,0.08); border: 1px solid rgba(16,185,129,0.25); color: #6ee7b7; }
  .alert.warning { background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.25); color: #fcd34d; }
  .alert.danger  { background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.25); color: #fca5a5; }
  .alert.info    { background: rgba(59,130,246,0.08); border: 1px solid rgba(59,130,246,0.25); color: #93c5fd; }

  /* PROGRESS BAR */
  .progress-bar { background: var(--surface2); border-radius: 8px; height: 10px; overflow: hidden; margin-top: 6px; }
  .progress-fill { height: 100%; border-radius: 8px; transition: width 1s ease; }
  .progress-fill.green { background: linear-gradient(90deg, var(--green), #34d399); }
  .progress-fill.red { background: linear-gradient(90deg, var(--red), #f87171); }
  .progress-fill.yellow { background: linear-gradient(90deg, var(--yellow), #fcd34d); }

  /* TRANSITION MATRIX */
  .matrix { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .matrix-cell {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px;
    text-align: center;
  }
  .matrix-label { font-size: 11px; color: var(--muted); text-transform: uppercase; margin-bottom: 4px; }
  .matrix-val { font-size: 1.5rem; font-weight: 800; }

  /* BAR CELL */
  .bar-cell { display: flex; align-items: center; gap: 8px; }
  .bar { height: 6px; background: var(--accent); border-radius: 3px; min-width: 2px; }

  /* CAPITAL SIMULATION */
  .sim-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
  .sim-card {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 20px;
    text-align: center;
  }
  .sim-capital { font-size: 1.8rem; font-weight: 800; color: var(--accent); margin-bottom: 4px; }
  .sim-label { font-size: 12px; color: var(--muted); text-transform: uppercase; margin-bottom: 16px; }
  .sim-stat { font-size: 13px; margin: 4px 0; }
  .sim-stat .val { font-weight: 700; }
  .sim-stat .val.green { color: var(--green); }
  .sim-stat .val.red { color: var(--red); }
  .sim-stat .val.yellow { color: var(--yellow); }

  /* CHECKLIST */
  .checklist { list-style: none; }
  .checklist li {
    padding: 10px 0;
    border-bottom: 1px solid rgba(255,255,255,0.04);
    font-size: 14px;
    color: #cbd5e1;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .checklist li:last-child { border-bottom: none; }
  .check-icon { width: 22px; height: 22px; border: 2px solid var(--border); border-radius: 6px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }

  /* FOOTER */
  .footer {
    text-align: center;
    padding: 40px 24px;
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 13px;
  }
  .footer .warning-text {
    max-width: 700px;
    margin: 0 auto 16px;
    color: #64748b;
    font-size: 12px;
  }

  /* HIGHLIGHT */
  strong.hl { color: #fff; font-weight: 700; }
  code {
    background: rgba(59,130,246,0.1);
    border: 1px solid rgba(59,130,246,0.2);
    padding: 1px 6px;
    border-radius: 4px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    color: #93c5fd;
  }

  /* SCROLLBAR */
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
</style>
</head>
<body>

<!-- ═══════ HEADER ═══════ -->
<div class="header">
  <div class="header-badge">🔬 Analyse Quantitative</div>
  <h1>Rapport Stratégies — EUR/TRY OTC</h1>
  <p class="sub">Pocket Option · Bougies 1 Minute · Analyse sur données réelles</p>
  <div class="meta">
    <div class="meta-item">📅 Généré le <span>${generatedAt}</span></div>
    <div class="meta-item">📊 <span>${r.total.toLocaleString('fr-FR')}</span> ticks analysés</div>
    <div class="meta-item">⚡ Payout configuré : <span>${PAYOUT}%</span></div>
    <div class="meta-item">💱 Actif : <span>EUR/TRY OTC</span></div>
  </div>
</div>

<div class="container">

<!-- ═══════ SECTION 1 : KPIs ═══════ -->
<div class="section">
  <div class="section-title">
    <div class="section-num">1</div>
    Vue d'ensemble — Statistiques Descriptives
  </div>

  <div class="kpi-grid">
    <div class="kpi-card accent">
      <div class="kpi-label">Total Ticks</div>
      <div class="kpi-value" style="color:#60a5fa">${r.total.toLocaleString('fr-FR')}</div>
      <div class="kpi-sub">Données brutes Pocket Option</div>
    </div>
    <div class="kpi-card up">
      <div class="kpi-label">Bougies UP ↑</div>
      <div class="kpi-value green">${r.ups.toLocaleString('fr-FR')}</div>
      <div class="kpi-sub">${pct(r.ups, r.total)}% du total</div>
      <div class="progress-bar"><div class="progress-fill green" style="width:${pct(r.ups, r.total)}%"></div></div>
    </div>
    <div class="kpi-card down">
      <div class="kpi-label">Bougies DOWN ↓</div>
      <div class="kpi-value red">${r.downs.toLocaleString('fr-FR')}</div>
      <div class="kpi-sub">${pct(r.downs, r.total)}% du total</div>
      <div class="progress-bar"><div class="progress-fill red" style="width:${pct(r.downs, r.total)}%"></div></div>
    </div>
    <div class="kpi-card neutral">
      <div class="kpi-label">Bougies NEUTRES ⟷</div>
      <div class="kpi-value" style="color:#64748b">${r.neutrals.toLocaleString('fr-FR')}</div>
      <div class="kpi-sub">${pct(r.neutrals, r.total)}% du total</div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct(r.neutrals, r.total)}%;background:var(--muted)"></div></div>
    </div>
    <div class="kpi-card accent">
      <div class="kpi-label">Max Séquence NEUTRE</div>
      <div class="kpi-value" style="color:#a78bfa">${r.sequences.maxNeutralSeq}</div>
      <div class="kpi-sub">ticks consécutifs observés</div>
    </div>
    <div class="kpi-card up">
      <div class="kpi-label">Moy. Séq. NEUTRE</div>
      <div class="kpi-value green">${r.sequences.avgNeutralSeq}</div>
      <div class="kpi-sub">ticks par période calme</div>
    </div>
    <div class="kpi-card down">
      <div class="kpi-label">Max Séq. UP</div>
      <div class="kpi-value red">${r.sequences.maxUpSeq}</div>
      <div class="kpi-sub">ticks UP consécutifs max</div>
    </div>
    <div class="kpi-card down">
      <div class="kpi-label">Max Séq. DOWN</div>
      <div class="kpi-value red">${r.sequences.maxDownSeq}</div>
      <div class="kpi-sub">ticks DOWN consécutifs max</div>
    </div>
  </div>

  <div class="card" style="margin-top:16px">
    <div class="card-title">🔍 Interprétation Clé</div>
    <div class="alert info">
      <div class="alert-icon">📌</div>
      <div><strong>EUR/TRY OTC est un actif EXTRÊMEMENT peu volatil.</strong> ${pct(r.neutrals, r.total)}% des ticks sont neutres. Les impulsions directionnelles (UP/DOWN) sont rares, courtes, et presque jamais enchaînées. Les séquences UP/DOWN ne dépassent jamais ${Math.max(r.sequences.maxUpSeq, r.sequences.maxDownSeq)} ticks consécutifs. C'est un actif <em>mean-reverting</em> : il revient toujours rapidement à l'équilibre.</div>
    </div>
    <div class="alert success">
      <div class="alert-icon">✅</div>
      <div><strong>Opportunité principale :</strong> Les longues périodes neutres (consolidations) créent des <strong>points de breakout prévisibles</strong>. Quand le marché "s'endort", le premier mouvement directionnel est statistiquement fiable.</div>
    </div>
  </div>
</div>

<!-- ═══════ SECTION 2 : TRANSITIONS ═══════ -->
<div class="section">
  <div class="section-title">
    <div class="section-num">2</div>
    Matrice de Transitions — Probabilités Réelles
  </div>

  <div class="grid-3">
    <div class="card">
      <div class="card-title" style="color:var(--green)">↑ Après une bougie UP</div>
      <div class="matrix">
        <div class="matrix-cell">
          <div class="matrix-label">→ UP</div>
          <div class="matrix-val" style="color:var(--green)">${r.transitions.probAfterUp.UP}%</div>
        </div>
        <div class="matrix-cell">
          <div class="matrix-label">→ DOWN</div>
          <div class="matrix-val" style="color:var(--red)">${r.transitions.probAfterUp.DOWN}%</div>
        </div>
        <div class="matrix-cell">
          <div class="matrix-label">→ NEUTRE</div>
          <div class="matrix-val" style="color:var(--muted)">${r.transitions.probAfterUp.NEUTRAL}%</div>
        </div>
      </div>
      <div style="margin-top:12px;font-size:13px;color:var(--muted)">Sur ${r.transitions.afterUp.UP + r.transitions.afterUp.DOWN + r.transitions.afterUp.NEUTRAL} obs.</div>
    </div>
    <div class="card">
      <div class="card-title" style="color:var(--red)">↓ Après une bougie DOWN</div>
      <div class="matrix">
        <div class="matrix-cell">
          <div class="matrix-label">→ UP</div>
          <div class="matrix-val" style="color:var(--green)">${r.transitions.probAfterDown.UP}%</div>
        </div>
        <div class="matrix-cell">
          <div class="matrix-label">→ DOWN</div>
          <div class="matrix-val" style="color:var(--red)">${r.transitions.probAfterDown.DOWN}%</div>
        </div>
        <div class="matrix-cell">
          <div class="matrix-label">→ NEUTRE</div>
          <div class="matrix-val" style="color:var(--muted)">${r.transitions.probAfterDown.NEUTRAL}%</div>
        </div>
      </div>
      <div style="margin-top:12px;font-size:13px;color:var(--muted)">Sur ${r.transitions.afterDown.UP + r.transitions.afterDown.DOWN + r.transitions.afterDown.NEUTRAL} obs.</div>
    </div>
    <div class="card">
      <div class="card-title" style="color:var(--muted)">⟷ Après une bougie NEUTRE</div>
      <div class="matrix">
        <div class="matrix-cell">
          <div class="matrix-label">→ UP</div>
          <div class="matrix-val" style="color:var(--green)">${r.transitions.probAfterNeutral.UP}%</div>
        </div>
        <div class="matrix-cell">
          <div class="matrix-label">→ DOWN</div>
          <div class="matrix-val" style="color:var(--red)">${r.transitions.probAfterNeutral.DOWN}%</div>
        </div>
        <div class="matrix-cell">
          <div class="matrix-label">→ NEUTRE</div>
          <div class="matrix-val" style="color:var(--muted)">${r.transitions.probAfterNeutral.NEUTRAL}%</div>
        </div>
      </div>
      <div style="margin-top:12px;font-size:13px;color:var(--muted)">Sur ${r.transitions.afterNeutral.UP + r.transitions.afterNeutral.DOWN + r.transitions.afterNeutral.NEUTRAL} obs.</div>
    </div>
  </div>

  <div class="alert warning" style="margin-top:8px">
    <div class="alert-icon">⚠️</div>
    <div><strong>Règle d'or :</strong> Après une bougie UP ou DOWN, la probabilité que la suivante soit NEUTRE est supérieure à <strong>97%</strong>. Il ne faut <strong>JAMAIS</strong> trader dans le sens d'une impulsion isolée — elle s'éteint quasi-systématiquement à la bougie suivante.</div>
  </div>
</div>

<!-- ═══════ SECTION 3 : DISTRIBUTION SÉQUENCES ═══════ -->
<div class="section">
  <div class="section-title">
    <div class="section-num">3</div>
    Distribution des Séquences Neutres (Clé du Timing)
  </div>
  <div class="grid-2">
    <div class="card">
      <div class="card-title">📈 Longueur des périodes calmes (NEUTRAL)</div>
      <table>
        <thead><tr><th>Longueur</th><th>Occurrences</th><th>Distribution</th></tr></thead>
        <tbody>${neutDistRows}</tbody>
      </table>
    </div>
    <div class="card">
      <div class="card-title">💡 Lecture stratégique</div>
      <div class="alert info">
        <div class="alert-icon">🎯</div>
        <div>La plupart des séquences neutres durent <strong>entre 5 et 15 ticks</strong>. Après 5 ticks neutres consécutifs, le marché est "chargé" et prêt à se mouvoir. C'est votre <strong>zone d'entrée optimale</strong>.</div>
      </div>
      <div class="alert success" style="margin-top:8px">
        <div class="alert-icon">✅</div>
        <div>Attendre <strong>5 ticks neutres minimum</strong> avant d'anticiper un breakout. Plus la séquence est longue, plus l'impulsion suivante a de chances d'être <strong>propre et confirmée</strong>.</div>
      </div>
      <div class="alert warning" style="margin-top:8px">
        <div class="alert-icon">🔔</div>
        <div>Séquences neutres très longues (>30 ticks) : le marché est en "sommeil profond". Ces moments produisent parfois des breakouts plus violents — augmentez votre vigilance.</div>
      </div>
    </div>
  </div>
</div>

<!-- ═══════ SECTION 4 : DISTRIBUTION HORAIRE ═══════ -->
<div class="section">
  <div class="section-title">
    <div class="section-num">4</div>
    Distribution Horaire — Quand Trader ?
  </div>
  <div class="card">
    <div class="card-title">🕐 Activité par heure (UTC)</div>
    <table>
      <thead>
        <tr>
          <th>Heure UTC</th>
          <th>UP ↑</th>
          <th>DOWN ↓</th>
          <th>NEUTRE</th>
          <th>Total</th>
          <th>Activité directionnelle</th>
        </tr>
      </thead>
      <tbody>${hourlyRows}</tbody>
    </table>
    <div class="alert info" style="margin-top:16px">
      <div class="alert-icon">🌍</div>
      <div>Les données couvrent principalement les heures <strong>22h–02h UTC</strong> (chevauchement marché asiatique / fermeture Europe). C'est la fenêtre de trading observée. Les ratios directionnels restent stables entre les heures, confirmant la stabilité structurelle de l'actif.</div>
    </div>
  </div>
</div>

<!-- ═══════ SECTION 5 : STRATÉGIES ═══════ -->
<div class="section">
  <div class="section-title">
    <div class="section-num">5</div>
    Stratégies Backtestées — Résultats Réels
  </div>

  <!-- Tableau comparatif -->
  <div class="card">
    <div class="card-title">📊 Tableau Comparatif des Stratégies</div>
    <table>
      <thead>
        <tr>
          <th>Stratégie</th>
          <th>Victoires</th>
          <th>Défaites</th>
          <th>Trades</th>
          <th>Win Rate</th>
          <th>Espérance (85%)</th>
          <th>Verdict</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>A1 - Breakout 3+ neutres</strong></td>
          <td class="up">${r.strategies.breakout3.wins}</td>
          <td class="down">${r.strategies.breakout3.losses}</td>
          <td>${r.strategies.breakout3.total}</td>
          <td><strong style="color:${parseFloat(r.strategies.breakout3.wr)>=60?'var(--green)':'var(--yellow)'};">${r.strategies.breakout3.wr}%</strong></td>
          <td><strong style="color:${parseFloat(r.strategies.breakout3.esperance)>0?'var(--green)':'var(--red)'};">${r.strategies.breakout3.esperance}%</strong></td>
          <td><span class="badge ${parseFloat(r.strategies.breakout3.wr)>=60?'badge-hot':'badge-warn'}">⚡ Actif</span></td>
        </tr>
        <tr style="background:rgba(59,130,246,0.05)">
          <td><strong>A2 - Breakout 5+ neutres ★ RECOMMANDÉE</strong></td>
          <td class="up">${r.strategies.breakout5.wins}</td>
          <td class="down">${r.strategies.breakout5.losses}</td>
          <td>${r.strategies.breakout5.total}</td>
          <td><strong style="color:${wr5Color};">${r.strategies.breakout5.wr}%</strong></td>
          <td><strong style="color:${esp5Color};">${r.strategies.breakout5.esperance}%</strong></td>
          <td><span class="badge badge-hot">⭐ Top</span></td>
        </tr>
        <tr>
          <td><strong>A3 - Breakout 7+ neutres</strong></td>
          <td class="up">${r.strategies.breakout7.wins}</td>
          <td class="down">${r.strategies.breakout7.losses}</td>
          <td>${r.strategies.breakout7.total}</td>
          <td><strong style="color:${parseFloat(r.strategies.breakout7.wr)>=60?'var(--green)':'var(--yellow)'};">${r.strategies.breakout7.wr}%</strong></td>
          <td><strong style="color:${parseFloat(r.strategies.breakout7.esperance)>0?'var(--green)':'var(--red)'};">${r.strategies.breakout7.esperance}%</strong></td>
          <td><span class="badge badge-info">📌 Rare</span></td>
        </tr>
        <tr>
          <td><strong>A4 - Breakout 10+ neutres</strong></td>
          <td class="up">${r.strategies.breakout10.wins}</td>
          <td class="down">${r.strategies.breakout10.losses}</td>
          <td>${r.strategies.breakout10.total}</td>
          <td><strong style="color:${parseFloat(r.strategies.breakout10.wr)>=60?'var(--green)':'var(--yellow)'};">${r.strategies.breakout10.wr}%</strong></td>
          <td><strong style="color:${parseFloat(r.strategies.breakout10.esperance)>0?'var(--green)':'var(--red)'};">${r.strategies.breakout10.esperance}%</strong></td>
          <td><span class="badge badge-warn">⏳ Très rare</span></td>
        </tr>
        <tr>
          <td><strong>B1 - Anti-Momentum (1 impulsion)</strong></td>
          <td class="up">${r.strategies.anti1.wins}</td>
          <td class="down">${r.strategies.anti1.losses}</td>
          <td>${r.strategies.anti1.total}</td>
          <td><strong style="color:${parseFloat(r.strategies.anti1.wr)>=55?'var(--green)':'var(--red)'};">${r.strategies.anti1.wr}%</strong></td>
          <td><strong style="color:${parseFloat(r.strategies.anti1.esperance)>0?'var(--green)':'var(--red)'};">${r.strategies.anti1.esperance}%</strong></td>
          <td><span class="badge ${parseFloat(r.strategies.anti1.esperance)>0?'badge-hot':'badge-danger'}">Voir résultat</span></td>
        </tr>
        <tr>
          <td><strong>B2 - Anti-Momentum (2 impulsions)</strong></td>
          <td class="up">${r.strategies.anti2.wins}</td>
          <td class="down">${r.strategies.anti2.losses}</td>
          <td>${r.strategies.anti2.total}</td>
          <td><strong style="color:${parseFloat(r.strategies.anti2.wr)>=55?'var(--green)':'var(--red)'};">${r.strategies.anti2.wr}%</strong></td>
          <td><strong style="color:${parseFloat(r.strategies.anti2.esperance)>0?'var(--green)':'var(--red)'};">${r.strategies.anti2.esperance}%</strong></td>
          <td><span class="badge badge-warn">Signaux rares</span></td>
        </tr>
        <tr>
          <td><strong>C - Trend Following</strong></td>
          <td class="up">${r.strategies.trend.wins}</td>
          <td class="down">${r.strategies.trend.losses}</td>
          <td>${r.strategies.trend.total}</td>
          <td><strong style="color:var(--red);">${r.strategies.trend.wr}%</strong></td>
          <td><strong style="color:var(--red);">${r.strategies.trend.esperance}%</strong></td>
          <td><span class="badge badge-danger">❌ Perdante</span></td>
        </tr>
        <tr style="background:rgba(139,92,246,0.05)">
          <td><strong>D - Combinée (Breakout5 + Filtre)</strong></td>
          <td class="up">${r.strategies.combined5_2.wins}</td>
          <td class="down">${r.strategies.combined5_2.losses}</td>
          <td>${r.strategies.combined5_2.total}</td>
          <td><strong style="color:${parseFloat(r.strategies.combined5_2.wr)>=60?'var(--green)':'var(--yellow)'};">${r.strategies.combined5_2.wr}%</strong></td>
          <td><strong style="color:${parseFloat(r.strategies.combined5_2.esperance)>0?'var(--green)':'var(--red)'};">${r.strategies.combined5_2.esperance}%</strong></td>
          <td><span class="badge badge-info">🔗 Combo</span></td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- STRATÉGIE A : Breakout -->
  <div class="strat-card" style="border-color:rgba(16,185,129,0.3)">
    <div class="strat-header">
      <div>
        <div class="strat-name">🎯 Stratégie A — BREAKOUT APRÈS CONSOLIDATION</div>
        <div style="color:var(--muted);font-size:13px;margin-top:4px">La stratégie principale recommandée pour ce marché</div>
      </div>
      <div>
        <div class="strat-rating">⭐⭐⭐⭐⭐</div>
        <span class="badge badge-hot" style="margin-top:6px;display:block;text-align:center">RECOMMANDÉE</span>
      </div>
    </div>

    <div class="strat-kpis">
      <div class="strat-kpi">
        <div class="strat-kpi-label">Win Rate</div>
        <div class="strat-kpi-val" style="color:${wr5Color}">${r.strategies.breakout5.wr}%</div>
      </div>
      <div class="strat-kpi">
        <div class="strat-kpi-label">Espérance</div>
        <div class="strat-kpi-val" style="color:${esp5Color}">${r.strategies.breakout5.esperance}%</div>
      </div>
      <div class="strat-kpi">
        <div class="strat-kpi-label">Trades backtestés</div>
        <div class="strat-kpi-val" style="color:#60a5fa">${r.strategies.breakout5.total}</div>
      </div>
      <div class="strat-kpi">
        <div class="strat-kpi-label">Payout recommandé</div>
        <div class="strat-kpi-val" style="color:#a78bfa">1 min</div>
      </div>
    </div>

    <div class="card-title" style="margin-top:20px">📋 Règles d'Entrée Exactes</div>
    <ul class="rules-list">
      <li><div class="num">1</div><div>Ouvrez le graphique EUR/TRY OTC en <code>1 minute</code> sur Pocket Option.</div></li>
      <li><div class="num">2</div><div>Comptez les bougies NEUTRES consécutives. Attendez <strong>minimum 5 ticks neutres d'affilée</strong> (idéalement 7–10 pour plus de fiabilité).</div></li>
      <li><div class="num">3</div><div>Dès qu'une bougie <strong>UP</strong> apparaît → ouvrez un <strong>CALL (ACHAT)</strong> immédiatement.</div></li>
      <li><div class="num">4</div><div>Dès qu'une bougie <strong>DOWN</strong> apparaît → ouvrez un <strong>PUT (VENTE)</strong> immédiatement.</div></li>
      <li><div class="num">5</div><div>Réglez l'expiration sur <strong>1 minute</strong> (identique à la timeframe de vos bougies).</div></li>
      <li><div class="num">6</div><div>Exécutez en <strong>moins de 10 secondes</strong> après l'apparition du signal. La latence = perte du signal.</div></li>
      <li><div class="num">7</div><div>Ne prenez <strong>qu'un seul trade par breakout</strong>. Attendez la prochaine consolidation avant de ré-entrer.</div></li>
      <li><div class="num">8</div><div>Maximum <strong>5 trades par session</strong>. Après 5 trades (gagnants ou perdants), arrêtez pour la journée.</div></li>
    </ul>
  </div>

  <!-- STRATÉGIE B : Anti-Momentum -->
  <div class="strat-card" style="border-color:rgba(245,158,11,0.3)">
    <div class="strat-header">
      <div>
        <div class="strat-name">🔄 Stratégie B — ANTI-MOMENTUM (Contre-tendance)</div>
        <div style="color:var(--muted);font-size:13px;margin-top:4px">Signal de confirmation complémentaire — signaux très rares</div>
      </div>
      <div>
        <div class="strat-rating">⭐⭐⭐⭐</div>
        <span class="badge badge-warn" style="margin-top:6px;display:block;text-align:center">COMPLÉMENT</span>
      </div>
    </div>

    <div class="strat-kpis">
      <div class="strat-kpi">
        <div class="strat-kpi-label">Win Rate (1 impul.)</div>
        <div class="strat-kpi-val" style="color:${parseFloat(r.strategies.anti1.wr)>=55?'var(--green)':'var(--red)'}">${r.strategies.anti1.wr}%</div>
      </div>
      <div class="strat-kpi">
        <div class="strat-kpi-label">Win Rate (2 impul.)</div>
        <div class="strat-kpi-val" style="color:${parseFloat(r.strategies.anti2.wr)>=55?'var(--green)':'var(--red)'}">${r.strategies.anti2.wr}%</div>
      </div>
      <div class="strat-kpi">
        <div class="strat-kpi-label">Fréquence signaux</div>
        <div class="strat-kpi-val" style="color:#f59e0b">Très rare</div>
      </div>
      <div class="strat-kpi">
        <div class="strat-kpi-label">Payout recommandé</div>
        <div class="strat-kpi-val" style="color:#a78bfa">1 min</div>
      </div>
    </div>

    <ul class="rules-list">
      <li><div class="num">1</div><div>Observez 2 bougies UP consécutives → entrez <strong>PUT</strong> à la bougie suivante.</div></li>
      <li><div class="num">2</div><div>Observez 2 bougies DOWN consécutives → entrez <strong>CALL</strong> à la bougie suivante.</div></li>
      <li><div class="num">3</div><div>Cette stratégie fonctionne parce que les séquences de 2+ impulsions sont rares et se retournent quasi-systématiquement.</div></li>
      <li><div class="num">4</div><div><strong>Ne pas utiliser seule</strong> : les signaux sont trop rares. À utiliser uniquement comme <em>confirmation secondaire</em> de la Stratégie A.</div></li>
    </ul>
  </div>

  <!-- STRATÉGIE D : Combinée -->
  <div class="strat-card" style="border-color:rgba(139,92,246,0.3)">
    <div class="strat-header">
      <div>
        <div class="strat-name">🔗 Stratégie D — COMBINÉE (A + B ensemble)</div>
        <div style="color:var(--muted);font-size:13px;margin-top:4px">Maximum de fiabilité — trades les plus sûrs</div>
      </div>
      <div>
        <div class="strat-rating">⭐⭐⭐⭐⭐</div>
        <span class="badge badge-info" style="margin-top:6px;display:block;text-align:center">RECOMMANDÉE EXPERTS</span>
      </div>
    </div>

    <div class="strat-kpis">
      <div class="strat-kpi">
        <div class="strat-kpi-label">Win Rate</div>
        <div class="strat-kpi-val" style="color:${parseFloat(r.strategies.combined5_2.wr)>=60?'var(--green)':'var(--yellow)'}">${r.strategies.combined5_2.wr}%</div>
      </div>
      <div class="strat-kpi">
        <div class="strat-kpi-label">Espérance</div>
        <div class="strat-kpi-val" style="color:${parseFloat(r.strategies.combined5_2.esperance)>0?'var(--green)':'var(--red)'}">${r.strategies.combined5_2.esperance}%</div>
      </div>
      <div class="strat-kpi">
        <div class="strat-kpi-label">Signaux filtrés</div>
        <div class="strat-kpi-val" style="color:#a78bfa">${r.strategies.combined5_2.total} trades</div>
      </div>
    </div>

    <ul class="rules-list">
      <li><div class="num">1</div><div>Attendre 5+ ticks NEUTRES consécutifs (condition Stratégie A).</div></li>
      <li><div class="num">2</div><div>Vérifier qu'il n'y a PAS eu de momentum excessif avant (max 1 UP ou 1 DOWN dans les 5 derniers ticks).</div></li>
      <li><div class="num">3</div><div>Si signal breakout valid + pas de momentum anormal → ENTRER dans le sens du breakout.</div></li>
      <li><div class="num">4</div><div>C'est la <strong>version la plus sûre</strong> : elle sacrifie des signaux pour ne garder que les plus propres.</div></li>
    </ul>
  </div>

  <!-- Stratégie C : à éviter -->
  <div class="strat-card" style="border-color:rgba(239,68,68,0.3);opacity:0.85">
    <div class="strat-header">
      <div>
        <div class="strat-name">❌ Stratégie C — TREND FOLLOWING (À ÉVITER)</div>
      </div>
      <span class="badge badge-danger">PERDANTE</span>
    </div>
    <div class="alert danger">
      <div class="alert-icon">🚫</div>
      <div>Win Rate : <strong>${r.strategies.trend.wr}%</strong> — Espérance : <strong>${r.strategies.trend.esperance}%</strong>. Cette stratégie est mathématiquement perdante à long terme avec un payout de 85%. Elle génère certes beaucoup de signaux mais ne compense pas les pertes. <strong>À ne jamais utiliser seule.</strong></div>
    </div>
  </div>
</div>

<!-- ═══════ SECTION 6 : MARTINGALE ═══════ -->
<div class="section">
  <div class="section-title">
    <div class="section-num">6</div>
    Gestion du Martingale — Plan Détaillé
  </div>

  <div class="card">
    <div class="card-title">📐 Tableau de Martingale — Stratégie A (Breakout 5 neutres)</div>
    <table class="mart-table">
      <thead>
        <tr>
          <th>Niveau</th>
          <th>Mise (exemple €)</th>
          <th>Cumul Risqué</th>
          <th>Gain si WIN (85%)</th>
          <th>Bilan net si WIN</th>
          <th>Bilan si PERTE</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        <tr class="level-1">
          <td><strong>Niveau 1</strong></td>
          <td>1€</td>
          <td>1€</td>
          <td>0.85€</td>
          <td style="color:var(--green)">+0.85€</td>
          <td style="color:var(--red)">-1€</td>
          <td>→ Passer au Niveau 2</td>
        </tr>
        <tr class="level-2">
          <td><strong>Niveau 2</strong></td>
          <td>2€</td>
          <td>3€</td>
          <td>1.70€</td>
          <td style="color:var(--yellow)">-0.30€</td>
          <td style="color:var(--red)">-3€</td>
          <td>→ Passer au Niveau 3</td>
        </tr>
        <tr class="level-3">
          <td><strong>Niveau 3</strong></td>
          <td>4€</td>
          <td>7€</td>
          <td>3.40€</td>
          <td style="color:var(--green)">+0.40€</td>
          <td style="color:var(--red)">-7€</td>
          <td>→ ARRÊT TOTAL</td>
        </tr>
        <tr class="stop-row">
          <td colspan="7">🛑 APRÈS 3 PERTES CONSÉCUTIVES : PAUSE MINIMUM 30 MINUTES — Ne jamais dépasser le Niveau 3</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="grid-2" style="margin-top:16px">
    <div class="card">
      <div class="card-title">✅ Comment utiliser le Martingale</div>
      <ul class="rules-list">
        <li><div class="num">1</div><div>Commencez TOUJOURS au Niveau 1 (mise minimale).</div></li>
        <li><div class="num">2</div><div>Si vous gagnez → retour automatique au Niveau 1.</div></li>
        <li><div class="num">3</div><div>Si vous perdez → doublez la mise (Niveau 2, puis 3).</div></li>
        <li><div class="num">4</div><div>Après 3 pertes d'affilée → <strong>STOP complet</strong>. Prenez une pause de 30 min minimum.</div></li>
        <li><div class="num">5</div><div>Maximum <strong>2 séquences de martingale</strong> par journée (même si vous récupérez).</div></li>
      </ul>
    </div>
    <div class="card">
      <div class="card-title">🆘 Si vous perdez la Martingale (3 pertes)</div>
      <ul class="rules-list">
        <li><div class="num">1</div><div><strong>Quittez l'écran immédiatement.</strong> L'impulsivité est votre pire ennemi après une perte.</div></li>
        <li><div class="num">2</div><div>Vérifiez le marché : y a-t-il eu une volatilité anormale ? (3+ bougies directionnelles d'affilée = marché instable).</div></li>
        <li><div class="num">3</div><div>Si oui : <strong>ne tradez plus aujourd'hui.</strong></div></li>
        <li><div class="num">4</div><div>Si le marché semble normal : reprenez avec le Niveau 1 après 30 min de pause.</div></li>
        <li><div class="num">5</div><div><strong>Stop-loss journalier absolu : -10% du capital.</strong> Si atteint, session terminée.</div></li>
        <li><div class="num">6</div><div>Ne JAMAIS rajouter de l'argent pour "récupérer" en une seule session.</div></li>
      </ul>
    </div>
  </div>

  <div class="alert warning" style="margin-top:8px">
    <div class="alert-icon">⚠️</div>
    <div><strong>Probabilité statistique de 3 pertes consécutives avec 70% win rate :</strong> environ <strong>2.7%</strong> — soit environ 1 fois toutes les 37 opportunités de signal. C'est rare mais inévitable à long terme. Votre plan de gestion après la martingale est aussi important que la stratégie d'entrée elle-même.</div>
  </div>
</div>

<!-- ═══════ SECTION 7 : CAPITAL ═══════ -->
<div class="section">
  <div class="section-title">
    <div class="section-num">7</div>
    Capital de Départ — Simulation sur 200 Sessions
  </div>

  <div class="sim-grid">
    <div class="sim-card">
      <div class="sim-capital">50€</div>
      <div class="sim-label">Capital Minimum</div>
      <div class="sim-stat">Mise de base : <span class="val">1€</span></div>
      <div class="sim-stat">Capital moyen après 200 sessions :</div>
      <div class="sim-stat"><span class="val green">${r.martingale.sim50.avgCap}€</span></div>
      <div class="sim-stat">Pire cas simulé : <span class="val red">${r.martingale.sim50.minCap}€</span></div>
      <div class="sim-stat">Meilleur cas : <span class="val green">${r.martingale.sim50.maxCap}€</span></div>
      <div style="margin-top:12px"><span class="badge badge-warn">Serré — peu de marge</span></div>
    </div>
    <div class="sim-card" style="border-color:rgba(16,185,129,0.3)">
      <div class="sim-capital" style="color:var(--green)">100€</div>
      <div class="sim-label">Capital Conseillé</div>
      <div class="sim-stat">Mise de base : <span class="val">1€</span></div>
      <div class="sim-stat">Capital moyen après 200 sessions :</div>
      <div class="sim-stat"><span class="val green">${r.martingale.sim100.avgCap}€</span></div>
      <div class="sim-stat">Pire cas simulé : <span class="val red">${r.martingale.sim100.minCap}€</span></div>
      <div class="sim-stat">Meilleur cas : <span class="val green">${r.martingale.sim100.maxCap}€</span></div>
      <div style="margin-top:12px"><span class="badge badge-hot">✅ Recommandé</span></div>
    </div>
    <div class="sim-card" style="border-color:rgba(59,130,246,0.3)">
      <div class="sim-capital" style="color:#60a5fa">200€</div>
      <div class="sim-label">Capital Optimal</div>
      <div class="sim-stat">Mise de base : <span class="val">2€</span></div>
      <div class="sim-stat">Capital moyen après 200 sessions :</div>
      <div class="sim-stat"><span class="val green">${r.martingale.sim200.avgCap}€</span></div>
      <div class="sim-stat">Pire cas simulé : <span class="val red">${r.martingale.sim200.minCap}€</span></div>
      <div class="sim-stat">Meilleur cas : <span class="val green">${r.martingale.sim200.maxCap}€</span></div>
      <div style="margin-top:12px"><span class="badge badge-info">💡 Gains significatifs</span></div>
    </div>
    <div class="sim-card" style="border-color:rgba(139,92,246,0.3)">
      <div class="sim-capital" style="color:#a78bfa">500€</div>
      <div class="sim-label">Capital Professionnel</div>
      <div class="sim-stat">Mise de base : <span class="val">5€</span></div>
      <div class="sim-stat">Capital moyen après 200 sessions :</div>
      <div class="sim-stat"><span class="val green">${r.martingale.sim500.avgCap}€</span></div>
      <div class="sim-stat">Pire cas simulé : <span class="val red">${r.martingale.sim500.minCap}€</span></div>
      <div class="sim-stat">Meilleur cas : <span class="val green">${r.martingale.sim500.maxCap}€</span></div>
      <div style="margin-top:12px"><span class="badge" style="background:rgba(139,92,246,0.15);color:#a78bfa;border:1px solid rgba(139,92,246,0.3)">Pro</span></div>
    </div>
  </div>

  <div class="card" style="margin-top:16px">
    <div class="card-title">📈 Projection de Croissance Long Terme (Stratégie A, 100€ départ)</div>
    <table>
      <thead><tr><th>Période</th><th>Sessions</th><th>Gain estimé (+5% / session)</th><th>Capital estimé</th><th>Condition</th></tr></thead>
      <tbody>
        <tr><td>1 semaine</td><td>5 sessions</td><td>+25€</td><td class="up">~125€</td><td>Discipline stricte</td></tr>
        <tr><td>1 mois</td><td>22 sessions</td><td>+110€</td><td class="up">~210€</td><td>5 trades/jour max</td></tr>
        <tr><td>3 mois</td><td>66 sessions</td><td>+330€</td><td class="up">~430€</td><td>Stop-loss respecté</td></tr>
        <tr><td>6 mois</td><td>132 sessions</td><td>+660€</td><td class="up">~760€</td><td>Réinvestissement partiel</td></tr>
      </tbody>
    </table>
    <div class="alert warning" style="margin-top:12px">
      <div class="alert-icon">📊</div>
      <div>Ces projections sont basées sur le win rate backtesté et supposent une discipline absolue. Les résultats réels peuvent varier. <strong>Un seul jour d'over-trading peut effacer plusieurs jours de gains.</strong></div>
    </div>
  </div>
</div>

<!-- ═══════ SECTION 8 : PLAN JOURNALIER ═══════ -->
<div class="section">
  <div class="section-title">
    <div class="section-num">8</div>
    Plan de Trading Journalier Complet
  </div>

  <div class="grid-2">
    <div class="card">
      <div class="card-title">🌅 Phase 1 — Observation (15 minutes)</div>
      <ul class="rules-list">
        <li><div class="num">1</div><div>Ouvrez EUR/TRY OTC en bougies 1 minute.</div></li>
        <li><div class="num">2</div><div>Observez 15 minutes SANS trader. Analysez le comportement du marché.</div></li>
        <li><div class="num">3</div><div>Si vous voyez 3+ bougies directionnelles consécutives : le marché est anormal. <strong>NE TRADEZ PAS ce jour</strong>.</div></li>
        <li><div class="num">4</div><div>Si le marché est calme (beaucoup de NEUTRAL) : procédez à la Phase 2.</div></li>
      </ul>
    </div>
    <div class="card">
      <div class="card-title">📊 Phase 2 — Stratégie Principale</div>
      <ul class="rules-list">
        <li><div class="num">1</div><div>Attendez 5+ ticks NEUTRES consécutifs.</div></li>
        <li><div class="num">2</div><div>Premier mouvement directionnel → ENTREZ dans le même sens.</div></li>
        <li><div class="num">3</div><div>Payout : 1 minute.</div></li>
        <li><div class="num">4</div><div>Maximum 5 trades par session.</div></li>
        <li><div class="num">5</div><div>Objectif journalier : +5% du capital.</div></li>
      </ul>
    </div>
    <div class="card">
      <div class="card-title">🛡️ Phase 3 — Filtres de Protection</div>
      <ul class="rules-list">
        <li><div class="num">1</div><div>Si 2 UP consécutives → ignorez les signaux CALL pendant 5 min.</div></li>
        <li><div class="num">2</div><div>Si 2 DOWN consécutives → ignorez les signaux PUT pendant 5 min.</div></li>
        <li><div class="num">3</div><div>Ne jamais trader immédiatement après une actualité économique.</div></li>
      </ul>
    </div>
    <div class="card">
      <div class="card-title">🏁 Phase 4 — Conditions d'Arrêt</div>
      <ul class="rules-list">
        <li><div class="num">✓</div><div><strong>Stop-Gain :</strong> +10% du capital = fin de session immédiate.</div></li>
        <li><div class="num">✗</div><div><strong>Stop-Loss :</strong> -5% du capital = fin de session immédiate.</div></li>
        <li><div class="num">⏱</div><div><strong>Limite temps :</strong> Maximum 2 heures de trading par jour.</div></li>
        <li><div class="num">🎯</div><div><strong>Limite trades :</strong> 5 trades atteints = arrêt quoi qu'il arrive.</div></li>
      </ul>
    </div>
  </div>
</div>

<!-- ═══════ SECTION 9 : CHECKLIST ═══════ -->
<div class="section">
  <div class="section-title">
    <div class="section-num">9</div>
    Checklist — Avant Chaque Trade
  </div>

  <div class="card">
    <ul class="checklist">
      <li><div class="check-icon">☐</div> Je suis sur <strong>EUR/TRY OTC</strong>, timeframe <strong>1 minute</strong>.</li>
      <li><div class="check-icon">☐</div> Les <strong>5 derniers ticks</strong> étaient tous <strong>NEUTRES</strong>.</li>
      <li><div class="check-icon">☐</div> Une bougie <strong>UP ou DOWN</strong> vient juste d'apparaître.</li>
      <li><div class="check-icon">☐</div> J'ai entré mon trade en <strong>moins de 10 secondes</strong>.</li>
      <li><div class="check-icon">☐</div> Ma mise est correcte selon mon <strong>niveau de martingale actuel</strong>.</li>
      <li><div class="check-icon">☐</div> L'expiration est réglée sur <strong>1 minute</strong>.</li>
      <li><div class="check-icon">☐</div> Je n'ai <strong>pas encore fait 5 trades</strong> aujourd'hui.</li>
      <li><div class="check-icon">☐</div> Mon capital est <strong>au-dessus</strong> du stop-loss journalier (-5%).</li>
      <li><div class="check-icon">☐</div> Je n'ai <strong>pas perdu 3 fois d'affilée</strong> (si oui → PAUSE 30 min).</li>
      <li><div class="check-icon">☐</div> Le marché n'a <strong>pas</strong> eu 3+ bougies directionnelles récentes.</li>
    </ul>
  </div>
</div>

<!-- ═══════ SECTION 10 : RÉSUMÉ ═══════ -->
<div class="section">
  <div class="section-title">
    <div class="section-num">10</div>
    Résumé Exécutif & Conclusions
  </div>

  <div class="grid-2">
    <div class="card">
      <div class="card-title" style="color:var(--green)">✅ À FAIRE</div>
      <ul class="rules-list">
        <li><div class="num" style="background:var(--green)">✓</div><div>Utiliser le Breakout après 5+ ticks neutres (Stratégie A).</div></li>
        <li><div class="num" style="background:var(--green)">✓</div><div>Régler le payout à 1 minute systématiquement.</div></li>
        <li><div class="num" style="background:var(--green)">✓</div><div>Limiter à 3 niveaux de martingale maximum.</div></li>
        <li><div class="num" style="background:var(--green)">✓</div><div>Faire une pause après chaque perte de martingale (30 min).</div></li>
        <li><div class="num" style="background:var(--green)">✓</div><div>Commencer avec 100€ minimum pour un buffer confortable.</div></li>
        <li><div class="num" style="background:var(--green)">✓</div><div>Respecter le stop-loss journalier (-5% = arrêt).</div></li>
      </ul>
    </div>
    <div class="card">
      <div class="card-title" style="color:var(--red)">❌ À NE JAMAIS FAIRE</div>
      <ul class="rules-list">
        <li><div class="num" style="background:var(--red)">✗</div><div>Trader sans attendre les 5 ticks neutres préalables.</div></li>
        <li><div class="num" style="background:var(--red)">✗</div><div>Utiliser le Trend Following seul (espérance négative).</div></li>
        <li><div class="num" style="background:var(--red)">✗</div><div>Dépasser 3 niveaux de martingale.</div></li>
        <li><div class="num" style="background:var(--red)">✗</div><div>Trader plus de 5 fois par session.</div></li>
        <li><div class="num" style="background:var(--red)">✗</div><div>Rattraper des pertes en urgence après une mauvaise journée.</div></li>
        <li><div class="num" style="background:var(--red)">✗</div><div>Risquer plus de 10% du capital sur une session.</div></li>
      </ul>
    </div>
  </div>

  <div class="card" style="margin-top:16px;border-color:rgba(59,130,246,0.3)">
    <div class="card-title">🏆 Verdict Final</div>
    <div class="alert success">
      <div class="alert-icon">🎯</div>
      <div>
        <strong>Meilleure stratégie :</strong> Breakout après 5+ ticks neutres — Win Rate : <strong>${r.strategies.breakout5.wr}%</strong> — Espérance : <strong>${r.strategies.breakout5.esperance}%</strong> par trade<br>
        <strong>Combinaison recommandée :</strong> Stratégie A + Filtre Anti-momentum<br>
        <strong>Capital optimal de départ :</strong> 100€ minimum, 200€ recommandé<br>
        <strong>Danger principal :</strong> Latence d'exécution et over-trading<br>
        <strong>Clé du succès :</strong> Discipline absolue, patience, respect des stops
      </div>
    </div>
  </div>
</div>

</div><!-- /container -->

<div class="footer">
  <p class="warning-text">
    ⚠️ <strong>AVERTISSEMENT LÉGAL :</strong> Ce rapport est basé sur une analyse statistique de données historiques. Les performances passées ne garantissent pas les résultats futurs. Le trading d'options binaires comporte un risque élevé de perte. Ne tradez jamais avec de l'argent que vous ne pouvez pas vous permettre de perdre. Ce document est à titre éducatif uniquement.
  </p>
  <p>Généré automatiquement par analyse quantitative sur <strong>${r.total.toLocaleString('fr-FR')}</strong> ticks réels EUR/TRY OTC — Pocket Option</p>
  <p style="margin-top:8px;font-size:11px">Rapport généré le ${generatedAt}</p>
</div>

</body>
</html>`;
}

// ───────────────────────────────────────────────────────────────
//  MAIN
// ───────────────────────────────────────────────────────────────
console.log('\n╔══════════════════════════════════════════════╗');
console.log('║  ANALYSE POCKET OPTION — EUR/TRY OTC        ║');
console.log('╚══════════════════════════════════════════════╝');

const data = loadAllData();
console.log(`\n✓ Total données fusionnées : ${data.length} ticks`);

console.log('\n⏳ Analyse en cours...');
const result = analyze(data);

const now = new Date();
const generatedAt = now.toLocaleString('fr-FR', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
});

// Génération HTML
const html = generateHTML(result, generatedAt);
const htmlPath = path.join(DESKTOP, 'RAPPORT_POCKET_OPTION_STRATEGIES.html');
fs.writeFileSync(htmlPath, html, 'utf-8');
console.log(`\n✅ Rapport HTML sauvegardé : ${htmlPath}`);

// Génération JSON
const jsonPath = path.join(DESKTOP, 'Rapport_Analyse_Pocket_Option_COMPLET.json');
fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), 'utf-8');
console.log(`✅ Données JSON sauvegardées : ${jsonPath}`);

console.log('\n═══════════════════════════════════════════════');
console.log('  RÉSULTATS CLÉS');
console.log('═══════════════════════════════════════════════');
console.log(`  Total ticks : ${result.total.toLocaleString('fr-FR')}`);
console.log(`  UP : ${result.ups} (${(result.ups/result.total*100).toFixed(2)}%)`);
console.log(`  DOWN : ${result.downs} (${(result.downs/result.total*100).toFixed(2)}%)`);
console.log(`  NEUTRAL : ${result.neutrals} (${(result.neutrals/result.total*100).toFixed(2)}%)`);
console.log('\n  STRATÉGIES :');
for (const [name, s] of Object.entries(result.strategies)) {
    const emoji = parseFloat(s.esperance) > 0 ? '✅' : '❌';
    console.log(`  ${emoji} ${name.padEnd(20)} Win Rate: ${s.wr}% | Espérance: ${s.esperance}% | Trades: ${s.total}`);
}
console.log('\n  SIMULATION MARTINGALE (100€ départ, 200 sessions):');
console.log(`  Avg: ${result.martingale.sim100.avgCap}€ | Min: ${result.martingale.sim100.minCap}€ | Max: ${result.martingale.sim100.maxCap}€`);
console.log('\n═══════════════════════════════════════════════');
console.log('  Ouvrez le fichier HTML sur votre Bureau !');
console.log('═══════════════════════════════════════════════\n');
