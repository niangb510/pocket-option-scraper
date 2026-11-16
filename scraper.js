const puppeteer = require('puppeteer-core');
const readline = require('readline');
const CsvWriter = require('./csv-writer');
const SimulationEngine = require('./simulation-engine');
const fs = require('fs');
const path = require('path');

// ── CONFIGURATION ───────────────────────────────────────────────
const CONFIG = {
  url: 'https://pocketoption.com/fr/cabinet/quick-high-low/',
  asset: process.env.PO_ASSET || null,
  intervalMs: parseInt(process.env.PO_INTERVAL || '1000', 10),
  outputDir: path.join(__dirname, 'data'),
  maxRowsPerFile: 10000,
  headless: process.env.PO_HEADLESS === 'true',
  browserPath: process.env.PO_BROWSER_PATH || null,
  skipScan: process.env.PO_SKIP_SCAN === 'true',
};

// ── BROWSER PATH DETECTION (Windows: Opera, Chrome) ─────────────
function detectBrowserPath() {
  if (CONFIG.browserPath && fs.existsSync(CONFIG.browserPath)) {
    console.log('Browser override: ' + CONFIG.browserPath);
    return CONFIG.browserPath;
  }
  const userName = process.env.USERNAME || process.env.USER || 'user';
  const possiblePaths = [
    // Opera (with built-in VPN)
    path.join('C:', 'Users', userName, 'AppData', 'Local', 'Programs', 'Opera', 'opera.exe'),
    path.join('C:', 'Users', userName, 'AppData', 'Local', 'Programs', 'Opera', 'launcher.exe'),
    path.join('C:', 'Program Files', 'Opera', 'launcher.exe'),
    path.join('C:', 'Program Files (x86)', 'Opera', 'launcher.exe'),
    // Opera GX
    path.join('C:', 'Users', userName, 'AppData', 'Local', 'Programs', 'Opera GX', 'opera.exe'),
    path.join('C:', 'Users', userName, 'AppData', 'Local', 'Programs', 'Opera GX', 'launcher.exe'),
    // Chrome fallback
    path.join('C:', 'Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join('C:', 'Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join('C:', 'Users', userName, 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join('C:', 'Users', userName, 'AppData', 'Local', 'Google', 'Chrome', 'Bin', 'chrome.exe'),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      console.log('Browser found: ' + p);
      return p;
    }
  }
  console.error('Browser not found. Set PO_BROWSER_PATH env variable.');
  process.exit(1);
}

// ── COPY PROFILE RECURSIVELY ────────────────────────────────────
function copyProfileSync(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    // Skip lock files and session files that prevent launching
    if (entry.name === 'lock' || entry.name === 'LOCK' || entry.name === 'SingletonLock') {
      continue;
    }
    if (entry.isDirectory()) {
      copyProfileSync(srcPath, destPath);
    } else {
      try {
        fs.copyFileSync(srcPath, destPath);
      } catch (e) {
        // Skip files that are locked or inaccessible
      }
    }
  }
}

// ── MAIN SCRAPER CLASS ──────────────────────────────────────────
class PocketOptionScraper {
  constructor() {
    this.browser = null;
    this.page = null;
    this.csvWriter = null;
    this.isRunning = false;
    this.isExtracting = false;
    this.currentAsset = null;
    this.currentPrice = null;
    this.currentTimeframe = null;
    this.extractedCount = 0;
    this.lastErrorTime = 0;
    this.errorCount = 0;
    this.consoleLogs = [];
    this.cdpSession = null;
    this.lastWsLogTime = 0;
    this.lastWsMsgTime = 0;
    this.lastDomLogTime = 0;
    this.debugTriggered = false;
    this.bestPriceSelector = null;
    this.previousPrice = null;
    this.simulationEngine = null;
  }

  async start() {
    console.log('Starting Pocket Option scraper...');
    console.log('Interval: ' + CONFIG.intervalMs + 'ms');
    console.log('Output dir: ' + CONFIG.outputDir);
    if (!CONFIG.headless) {
      console.log('Visible mode: browser will open');
    }
    if (!fs.existsSync(CONFIG.outputDir)) {
      fs.mkdirSync(CONFIG.outputDir, { recursive: true });
    }
    const browserPath = detectBrowserPath();
    const userName = process.env.USERNAME || process.env.USER || 'user';
    const operaProfile = path.join('C:', 'Users', userName, 'AppData', 'Roaming', 'Opera Software', 'Opera Stable');
    const operaGxProfile = path.join('C:', 'Users', userName, 'AppData', 'Roaming', 'Opera Software', 'Opera GX Stable');
    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1280,900',
    ];
    let userDataDir = null;
    // If Opera is found and its profile exists, copy it to a temp folder
    // so the built-in VPN is active even when Opera is already running
    if (browserPath.toLowerCase().includes('opera')) {
      if (browserPath.toLowerCase().includes('gx') && fs.existsSync(operaGxProfile)) {
        userDataDir = path.join(__dirname, 'tmp-opera-gx-profile');
        console.log('Copying Opera GX profile for VPN...');
        copyProfileSync(operaGxProfile, userDataDir);
        console.log('Using Opera GX profile (VPN active): ' + userDataDir);
      } else if (fs.existsSync(operaProfile)) {
        userDataDir = path.join(__dirname, 'tmp-opera-profile');
        console.log('Copying Opera profile for VPN...');
        copyProfileSync(operaProfile, userDataDir);
        console.log('Using Opera profile (VPN active): ' + userDataDir);
      } else {
        console.log('WARNING: Opera profile not found. VPN may not be active.');
      }
    }
    if (userDataDir) {
      launchArgs.push('--user-data-dir=' + userDataDir);
    }
    this.browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: CONFIG.headless,
      args: launchArgs,
    });
    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1280, height: 900 });
    // Step 1: Open about:blank so user can activate Opera VPN
    await this.page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('\n--- STEP 1: ACTIVATE VPN ---');
    console.log('   Opera is open on about:blank');
    console.log('   Click the VPN button in Opera (left of address bar)');
    console.log('   Make sure the VPN is ON (blue/green)');
    console.log('   Press ENTER in this terminal when VPN is active');
    console.log('-----------------------------\n');
    await this.waitForEnter();
    // Step 2: Navigate to Pocket Option
    await this.navigateToPocketOption();
  }

  async navigateToPocketOption() {
    console.log('Navigating to ' + CONFIG.url + '...');
    await this.page.goto(CONFIG.url, { waitUntil: 'networkidle2', timeout: 60000 });
    console.log('\n--- STEP 2: READY TO EXTRACT ---');
    console.log('   1. Log in to your Pocket Option account (if needed)');
    console.log('   2. Select the asset you want to monitor');
    console.log('   3. Press ENTER in this terminal to start extraction');
    console.log('---------------------------------\n');
    await this.waitForEnter();
    await this.startExtraction();
  }

  waitForEnter() {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.on('line', () => {
        rl.close();
        resolve();
      });
      console.log('Waiting... (press ENTER when ready)');
    });
  }

  async startExtraction() {
    console.log('\nStarting real-time extraction...');
    console.log('   Press Ctrl+C to stop\n');
    this.extractionStartTime = Date.now();
    // Run diagnostic scans before starting live loop (unless skipped)
    if (!CONFIG.skipScan) {
      await this.scanAllPrices();
      await this.scanAllAssets();
      await this.scanPricesByPosition();
    }
    this.currentAsset = await this.detectCurrentAsset();
    console.log('Asset detected: ' + (this.currentAsset || 'UNKNOWN'));
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeAsset = (this.currentAsset || 'data').replace(/[/\\:*?"<>|]/g, '_');
    const csvFileName = 'po_' + safeAsset + '_' + timestamp + '.csv';
    const csvPath = path.join(CONFIG.outputDir, csvFileName);
    this.csvWriter = new CsvWriter(csvPath, [
      'timestamp', 'asset', 'price', 'timeframe', 'candle', 'action'
    ]);
    this.simulationEngine = new SimulationEngine(this.currentAsset);
    this.isRunning = true;
    // Save initial DOM snapshot for debugging
    console.log('Saving initial DOM snapshot...');
    await this.debugPage();
    // Setup WebSocket interception for price data
    await this.setupWebSocketIntercept();
    this.scheduleNextExtraction();

    process.once('SIGINT', () => {
      this.stop().then(() => process.exit(0));
    });
  }

  async setupWebSocketIntercept() {
    console.log('Setting up WebSocket interception...');
    // Capture console logs for debug
    this.page.on('console', (msg) => {
      this.consoleLogs.push({ type: msg.type(), text: msg.text(), time: Date.now() });
      if (this.consoleLogs.length > 500) this.consoleLogs.shift();
    });
    // Ensure debug directory exists for WS logs
    const debugDir = path.join(CONFIG.outputDir, 'debug');
    if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
    this.wsLogPath = path.join(debugDir, 'ws_messages_' + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl');
    this.wsLogStream = fs.createWriteStream(this.wsLogPath, { flags: 'a' });
    // Intercept websocket messages via CDP
    this.cdpSession = await this.page.target().createCDPSession();
    await this.cdpSession.send('Network.enable');
    this.cdpSession.on('Network.webSocketFrameReceived', ({ response }) => {
      try {
        const data = response.payloadData;
        const ts = Date.now();
        // Always log raw message for debugging
        if (this.wsLogStream) {
          this.wsLogStream.write(JSON.stringify({ t: ts, dir: 'in', raw: data }) + '\n');
        }
        
        let decodedData = data;
        if (data && typeof data === 'string' && !data.startsWith('{') && !data.startsWith('[')) {
          try {
            const decoded = Buffer.from(data, 'base64').toString('utf8');
            if (decoded.startsWith('{') || decoded.startsWith('[')) {
              decodedData = decoded;
            }
          } catch (e) {
            // ignore
          }
        }

        // Try to parse as JSON
        let parsed = null;
        try {
          parsed = JSON.parse(decodedData);
        } catch (e) {
          // Not JSON — try to parse as array or other common WS formats
          if (decodedData.startsWith('[') && decodedData.endsWith(']')) {
            try {
              parsed = JSON.parse(decodedData);
            } catch (e2) {
              // ignore
            }
          } else if (decodedData.startsWith('{') && decodedData.endsWith('}')) {
            try {
              parsed = JSON.parse(decodedData);
            } catch (e2) {
              // ignore
            }
          }
        }
        if (parsed) {
          // Try to extract price from various possible nested formats
          this.tryExtractPriceFromMessage(parsed, ts);
        }
      } catch (e) {
        // ignore
      }
    });
    this.cdpSession.on('Network.webSocketFrameSent', ({ response }) => {
      try {
        const data = response.payloadData;
        const ts = Date.now();
        if (this.wsLogStream) {
          this.wsLogStream.write(JSON.stringify({ t: ts, dir: 'out', raw: data }) + '\n');
        }
      } catch (e) {
        // ignore
      }
    });
    console.log('WebSocket interception active');
    console.log('WebSocket messages will be logged to: ' + this.wsLogPath);
  }

  tryExtractPriceFromMessage(parsed, ts) {
    // Try many possible paths for price data
    const candidates = [
      parsed.price,
      parsed.rate,
      parsed.spot,
      parsed.bid,
      parsed.last,
      parsed.value,
      parsed.currentPrice,
      parsed.close,
      parsed.open,
      parsed.high,
      parsed.low,
      parsed.current,
      parsed.quote,
      parsed.ask,
      parsed.strike,
      parsed.ltp,
      parsed.tick,
      parsed.lastPrice,
      parsed.marketPrice,
      parsed.tradePrice,
    ];
    // Also try nested arrays/objects
    if (Array.isArray(parsed)) {
      // Check if it's a flat array of [symbol, timestamp, price]
      if (parsed.length === 3 && typeof parsed[0] === 'string' && typeof parsed[1] === 'number' && typeof parsed[2] === 'number') {
        const asset = parsed[0].replace('_otc', ' OTC').replace('_', '/'); // convert AUDNZD_otc to AUDNZD OTC or AUD/NZD OTC
        const numPrice = parsed[2];
        // Normalize asset name to match what is detected on screen
        let normalizedAsset = asset;
        if (this.currentAsset) {
          const cleanSymbol = asset.replace(/[^A-Z]/gi, '').toUpperCase();
          const cleanCurrent = this.currentAsset.replace(/[^A-Z]/gi, '').toUpperCase();
          if (cleanSymbol === cleanCurrent) {
            normalizedAsset = this.currentAsset;
          }
        }
        this.handleWebSocketPrice({ price: numPrice, asset: normalizedAsset, timeframe: this.currentTimeframe || '1m', _raw: parsed });
        return;
      }
      for (const item of parsed) {
        if (item && typeof item === 'object') {
          this.tryExtractPriceFromMessage(item, ts);
        }
      }
    }
    if (parsed && typeof parsed === 'object') {
      // Try common nested keys
      for (const key of ['data', 'payload', 'result', 'body', 'message', 'params', 'args', 'd', 'p', 'r', 'm']) {
        if (parsed[key] !== undefined && parsed[key] !== null) {
          if (Array.isArray(parsed[key])) {
            for (const item of parsed[key]) {
              if (item && typeof item === 'object') {
                this.tryExtractPriceFromMessage(item, ts);
              }
            }
          } else if (typeof parsed[key] === 'object') {
            this.tryExtractPriceFromMessage(parsed[key], ts);
          }
        }
      }
    }
    for (const price of candidates) {
      if (price !== undefined && price !== null) {
        const numPrice = parseFloat(price);
        if (!isNaN(numPrice) && numPrice > 0 && numPrice < 100000) {
          // Build a data object compatible with handleWebSocketPrice
          const asset = parsed.symbol || parsed.pair || parsed.asset || parsed.instrument || parsed.ticker || parsed.s || parsed.name || parsed.currency || parsed.instrument || this.currentAsset || 'unknown';
          const timeframe = parsed.timeframe || parsed.tf || parsed.period || parsed.interval || parsed.resolution || this.currentTimeframe || '1m';
          this.handleWebSocketPrice({ price: numPrice, asset, timeframe, _raw: parsed });
          return; // found one, stop
        }
      }
    }
  }

  handleWebSocketPrice(data) {
    if (!this.isRunning || !this.csvWriter) return;
    const price = data.price || data.rate || data.spot || data.bid || data.last;
    const asset = data.asset || data.symbol || data.pair || this.currentAsset || 'unknown';
    const timeframe = data.timeframe || data.tf || this.currentTimeframe || '1m';

    // Only accept price updates for the currently selected asset on the screen
    if (this.currentAsset && this.currentAsset !== 'unknown') {
      const cleanCurrent = this.currentAsset.replace(/[^A-Z]/gi, '').toUpperCase();
      const cleanAsset = asset.replace(/[^A-Z]/gi, '').toUpperCase();
      if (cleanCurrent !== cleanAsset && !cleanCurrent.includes(cleanAsset) && !cleanAsset.includes(cleanCurrent)) {
        return; // Skip updates for other assets
      }
    }

    if (price !== undefined && price !== null) {
      const now = new Date();
      const timestamp = now.toISOString();
      const numPrice = parseFloat(price);
      if (!isNaN(numPrice) && numPrice > 0) {
        // Deduplication: skip if price hasn't changed significantly
        if (this.currentPrice !== null && Math.abs(numPrice - this.currentPrice) < 0.00001) {
          this.lastWsMsgTime = now.getTime(); // Update this to prevent DOM fallback even for identical ticks
          return;
        }
        // Reject obvious payout amounts (small round numbers like 3.84, 5.00, 11.93)
        // These are typical payout amounts in €, not market prices
        if (numPrice < 100 && numPrice > 0 && Number.isInteger(numPrice * 100) && (numPrice * 100) % 1 === 0) {
          if (numPrice < 0.5 || numPrice > 20) {
            if (numPrice === 3.84 || numPrice === 5.00 || numPrice === 11.93 || numPrice === 8.82 || numPrice === 2.50 || numPrice === 1.50 || numPrice === 16.93) {
              return;
            }
          }
        }
        this.currentPrice = numPrice;
        const finalAsset = (this.currentAsset && this.currentAsset !== 'unknown') ? this.currentAsset : asset;
        this.currentTimeframe = timeframe;
        const candle = this.detectCandleColor(numPrice);
        const row = {
          timestamp,
          asset: finalAsset,
          price: numPrice,
          timeframe,
          candle,
          action: 'WS',
        };
        this.csvWriter.writeRow(row);
        this.extractedCount++;
        if (this.simulationEngine) this.simulationEngine.onTick(numPrice, now);
        
        // Throttled console output: only update lastWsLogTime when a log is actually written
        const lastLog = this.lastWsLogTime || 0;
        if (now - lastLog > 2000) {
          const candleEmoji = candle === 'UP' ? '↑' : candle === 'DOWN' ? '↓' : '→';
          console.log('[' + timestamp.split('T')[1].split('.')[0] + '] ' + finalAsset + ' | ' + numPrice.toFixed(5) + ' | ' + candleEmoji + ' ' + candle + ' | ' + timeframe + ' (WS)');
          this.lastWsLogTime = now.getTime();
        }
        this.lastWsMsgTime = now.getTime(); // Update this for every valid WS price received!
      }
    }
  }

  scheduleNextExtraction() {
    if (!this.isRunning) return;
    setTimeout(() => {
      this.extractData().then(() => {
        this.scheduleNextExtraction();
      }).catch(() => {
        this.scheduleNextExtraction();
      });
    }, CONFIG.intervalMs);
  }

  async detectCurrentAsset() {
    try {
      const asset = await this.page.evaluate(() => {
        const selectors = [
          '.current-symbol',
          '.asset-select__name',
          '.current-symbol__text',
          '.js-current-symbol',
          '[data-testid="asset-name"]',
          '.asset-name',
          '.current-asset',
          '.chart-asset-name',
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.textContent) {
            const text = el.textContent.trim();
            // Filter out short texts that are likely timeframes (M1, M5, etc.)
            if (text.length > 3 && !/^M\d+$/.test(text) && !/^H\d+$/.test(text)) {
              return text;
            }
          }
        }
        return null;
      });
      return asset;
    } catch (e) {
      return null;
    }
  }

  async scanAllPrices() {
    try {
      const candidates = await this.page.evaluate(() => {
        const results = [];

        // Helper: check if element is inside trading panel / transactions / payout areas
        const isInTradingPanel = (el) => {
          const forbiddenSelectors = [
            '.right-widget-container',
            '.control-panel',
            '.call-put-block',
            '.call-put-wrap',
            '.buttons__wrap',
            '.deals-list',
            '.widget-slot',
            '.top-bar',
            '.header',
            '.modal',
            '.popup',
          ];
          for (const sel of forbiddenSelectors) {
            const ancestor = el.closest(sel);
            if (ancestor) return true;
          }
          return false;
        };

        // Helper: check if text looks like payout / transaction amount
        // NOTE: This check is now only applied to leaf elements (elements with no children)
        // to avoid filtering out parent containers that happen to contain trading panel text
        const isPayoutText = (text, el) => {
          const lower = text.toLowerCase();
          // Only treat as payout text if it starts with a currency symbol
          if (/^[\+\-]?[€$£¥]/.test(text)) return true;
          // Or if it contains explicit payout/transaction words
          const forbidden = ['paiement', 'payout', 'montant', 'achat', 'vente'];
          for (const word of forbidden) {
            if (lower.includes(word)) return true;
          }
          return false;
        };

        const selectors = [
          '.strike-value',
          '.current-quote',
          '.quote__val',
          '.price-block__value',
          '#put-call-buttons .price',
          '.js-strike-value',
          '.js-current-price',
          '[data-testid="current-price"]',
          '.current-price',
          '.price-value',
          '.chart-price',
          '.spot',
          '.rate',
          '.bid',
          '.ask',
          '.last-price',
          '.trade-price',
          '.current-rate',
          '.spot-price',
          '[data-field="price"]',
          '[data-field="rate"]',
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.textContent) {
            const text = el.textContent.trim();
            if (isPayoutText(text)) continue;
            const clean = text.replace(/[^\d.,]/g, '').replace(/\,/g, '.');
            const num = parseFloat(clean);
            if (!isNaN(num) && num > 0) {
              results.push({ selector: sel, price: num, raw: text });
            }
          }
        }
        // Also scan within the main content area for numbers that look like prices
        const scope = document.querySelector('.site-content-in') || document.querySelector('.site-content') || document.querySelector('.wrapper') || document.body;
        const allEls = scope.querySelectorAll('*');
        for (const el of allEls) {
          // Skip hidden elements and non-textual tags
          if (el.offsetParent === null) continue;
          const tag = el.tagName.toLowerCase();
          if (tag === 'script' || tag === 'style' || tag === 'noscript') continue;
          // Skip if inside trading panel
          if (isInTradingPanel(el)) continue;
          const text = el.textContent?.trim();
          if (text) {
            if (isPayoutText(text)) continue;
            const match = text.match(/(\d{1,3}[.,]\d{2,6})/);
            if (match) {
              const num = parseFloat(match[1].replace(',', '.'));
              if (!isNaN(num) && num > 0 && num < 100000) {
                const cls = (typeof el.className === 'string' ? el.className : '') || '';
                const id = el.id || '';
                const hint = (cls ? '.' + cls.split(' ').join('.') : '') + (id ? '#' + id : '');
                const key = tag + hint + '|' + text;
                if (!results.some(r => r._key === key)) {
                  results.push({ selector: tag + hint, price: num, raw: text, _key: key });
                }
              }
            }
          }
        }
        return results;
      });
      console.log('\n--- PRICE SCAN (first 30 candidates) ---');
      candidates.slice(0, 30).forEach((c, i) => {
        console.log('  ' + (i + 1) + '. [' + c.selector + '] => ' + c.price + '  (raw: "' + c.raw + '")');
      });
      if (candidates.length === 0) {
        console.log('  No price candidates found!');
      }
      console.log('------------------------------------------\n');
    } catch (e) {
      console.error('Price scan error:', e.message);
    }
  }

  async scanAllAssets() {
    try {
      const candidates = await this.page.evaluate(() => {
        const results = [];
        const selectors = [
          '.current-symbol',
          '.asset-select__name',
          '.current-symbol__text',
          '.js-current-symbol',
          '[data-testid="asset-name"]',
          '.asset-name',
          '.current-asset',
          '.chart-asset-name',
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.textContent) {
            const text = el.textContent.trim();
            if (text.length > 2) {
              results.push({ selector: sel, text });
            }
          }
        }
        // Also scan within the main content area for asset-like text
        const scope = document.querySelector('.site-content-in') || document.querySelector('.site-content') || document.querySelector('.wrapper') || document.body;
        const allEls = scope.querySelectorAll('*');
        for (const el of allEls) {
          // Skip hidden elements and non-textual tags
          if (el.offsetParent === null) continue;
          const tag = el.tagName.toLowerCase();
          if (tag === 'script' || tag === 'style' || tag === 'noscript') continue;
          const text = el.textContent?.trim();
          if (text && (/[A-Z]{2,6}\/[^\s/]{2,20}/.test(text) || text.includes('OTC'))) {
            const cls = (typeof el.className === 'string' ? el.className : '') || '';
            const id = el.id || '';
            const hint = (cls ? '.' + cls.split(' ').join('.') : '') + (id ? '#' + id : '');
            if (!results.some(r => r.text === text)) {
              results.push({ selector: tag + hint, text });
            }
          }
        }
        return results;
      });
      console.log('--- ASSET SCAN (first 10 candidates) ---');
      candidates.slice(0, 10).forEach((c, i) => {
        console.log('  ' + (i + 1) + '. [' + c.selector + '] => "' + c.text + '"');
      });
      if (candidates.length === 0) {
        console.log('  No asset candidates found!');
      }
      console.log('------------------------------------------\n');
    } catch (e) {
      console.error('Asset scan error:', e.message);
    }
  }

  async scanPricesByPosition() {
    try {
      const candidates = await this.page.evaluate(() => {
        const results = [];
        const scope = document.querySelector('.site-content-in') || document.querySelector('.site-content') || document.querySelector('.wrapper') || document.body;
        const allEls = scope.querySelectorAll('*');
        const w = window.innerWidth;
        const h = window.innerHeight;
        const centerX = w / 2;
        const centerY = h / 2;

        // Helper: check if element is inside trading panel / transactions / payout areas
        const isInTradingPanel = (el) => {
          const forbiddenSelectors = [
            '.right-widget-container',
            '.control-panel',
            '.call-put-block',
            '.call-put-wrap',
            '.buttons__wrap',
            '.deals-list',
            '.widget-slot',
            '.top-bar',
            '.header',
            '.modal',
            '.popup',
          ];
          for (const sel of forbiddenSelectors) {
            const ancestor = el.closest(sel);
            if (ancestor) return true;
          }
          return false;
        };

        // Helper: check if text looks like payout / transaction amount
        const isPayoutText = (text) => {
          const lower = text.toLowerCase();
          const forbidden = ['paiement', 'payout', 'montant', 'achat', 'vente', 'temps', 'ouvert', 'fermé', 'transactions', 'euro', '€', '$', '+€', '-€', '+$', '-$'];
          for (const word of forbidden) {
            if (lower.includes(word)) return true;
          }
          // If text starts with currency symbol or +currency
          if (/^[\+\-]?[€$£¥]/.test(text)) return true;
          return false;
        };

        for (const el of allEls) {
          if (el.offsetParent === null) continue;
          const tag = el.tagName.toLowerCase();
          if (tag === 'script' || tag === 'style' || tag === 'noscript') continue;
          const text = el.textContent?.trim();
          if (!text) continue;
          // Skip if inside trading panel
          if (isInTradingPanel(el)) continue;
          // Only apply payout text filter to leaf elements (no children) or elements with very short text
          // This avoids filtering out parent containers that contain trading panel text
          const isLeaf = el.children.length === 0;
          if (isLeaf && isPayoutText(text, el)) continue;
           const rect = el.getBoundingClientRect();
          // Skip large container elements (like the chart container itself)
          if (rect.width > 350 || rect.height > 150) continue;
          if (el.children.length > 2) continue;
          if (text.length > 25) continue;

          const match = text.match(/(\d{1,3}[.,]\d{2,6})/);
          if (!match) continue;
          const num = parseFloat(match[1].replace(',', '.'));
          if (isNaN(num) || num <= 0 || num >= 100000) continue;
          const style = window.getComputedStyle(el);
          const fontSize = parseFloat(style.fontSize) || 10;
          const isBold = style.fontWeight === '700' || style.fontWeight === 'bold';
          const isVisible = rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.top < h && rect.left >= 0 && rect.left < w;
          if (!isVisible) continue;
          const distFromCenter = Math.sqrt(Math.pow(rect.left + rect.width / 2 - centerX, 2) + Math.pow(rect.top + rect.height / 2 - centerY, 2));
          // Score: larger font, closer to center, bold = higher score
          const score = fontSize * 10 + (isBold ? 50 : 0) + Math.max(0, 500 - distFromCenter);
          const cls = (typeof el.className === 'string' ? el.className : '') || '';
          const id = el.id || '';
          const hint = (cls ? '.' + cls.split(' ').join('.') : '') + (id ? '#' + id : '');
          results.push({
            selector: tag + hint,
            price: num,
            raw: text,
            fontSize,
            isBold,
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            score: Math.round(score),
          });
        }
        // Sort by score descending
        results.sort((a, b) => b.score - a.score);
        return results;
      });
      console.log('\n--- PRICE SCAN BY POSITION (top 20) ---');
      console.log('  Format: [selector] => price | fontSize | position (x,y) | score');
      candidates.slice(0, 20).forEach((c, i) => {
        console.log('  ' + (i + 1) + '. [' + c.selector + '] => ' + c.price + ' | font:' + c.fontSize + 'px | pos:(' + c.x + ',' + c.y + ') size:' + c.width + 'x' + c.height + ' | score:' + c.score + ' | raw:"' + c.raw.substring(0, 60) + '"');
      });
      if (candidates.length === 0) {
        console.log('  No price candidates found by position!');
      } else {
        // Cache the best selector for use in extractData()
        this.bestPriceSelector = candidates[0].selector;
        console.log('  Best selector cached: ' + this.bestPriceSelector);
      }
      console.log('------------------------------------------\n');
    } catch (e) {
      console.error('Price position scan error:', e.message);
    }
  }

  async findPriceByExactText(knownPrice) {
    try {
      const found = await this.page.evaluate((price) => {
        const results = [];
        const strPrice = String(price);
        const walk = (el, path) => {
          if (el.nodeType === Node.TEXT_NODE) {
            const text = el.textContent.trim();
            if (text === strPrice || text.includes(strPrice)) {
              const parent = el.parentElement;
              if (parent) {
                const cls = (typeof parent.className === 'string' ? parent.className : '') || '';
                const id = parent.id || '';
                const tag = parent.tagName.toLowerCase();
                const hint = (cls ? '.' + cls.split(' ').join('.') : '') + (id ? '#' + id : '');
                const rect = parent.getBoundingClientRect();
                results.push({
                  selector: tag + hint,
                  path: path,
                  text: text,
                  x: Math.round(rect.left),
                  y: Math.round(rect.top),
                });
              }
            }
            return;
          }
          if (el.nodeType === Node.ELEMENT_NODE) {
            const tag = el.tagName.toLowerCase();
            const cls = (typeof el.className === 'string' ? el.className : '') || '';
            const id = el.id || '';
            const hint = (cls ? '.' + cls.split(' ').join('.') : '') + (id ? '#' + id : '');
            const newPath = path + ' > ' + tag + hint;
            for (const child of el.childNodes) {
              walk(child, newPath);
            }
          }
        };
        walk(document.body, 'body');
        return results;
      }, knownPrice);
      console.log('\n--- EXACT PRICE SEARCH for "' + knownPrice + '" ---');
      if (found.length === 0) {
        console.log('  No element found with exact text "' + knownPrice + '"');
      } else {
        found.forEach((f, i) => {
          console.log('  ' + (i + 1) + '. [' + f.selector + '] pos:(' + f.x + ',' + f.y + ') text:"' + f.text + '"');
        });
      }
      console.log('------------------------------------------\n');
    } catch (e) {
      console.error('Exact price search error:', e.message);
    }
  }

  async debugPage() {
    try {
      const debugDir = path.join(CONFIG.outputDir, 'debug');
      if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      // Screenshot
      const screenshotPath = path.join(debugDir, 'screenshot_' + ts + '.png');
      await this.page.screenshot({ path: screenshotPath, fullPage: true });
      console.log('   Screenshot saved: ' + screenshotPath);
      // HTML dump
      const html = await this.page.content();
      const htmlPath = path.join(debugDir, 'page_' + ts + '.html');
      fs.writeFileSync(htmlPath, html);
      console.log('   HTML saved: ' + htmlPath);
      // Console logs
      const consolePath = path.join(debugDir, 'console_' + ts + '.json');
      fs.writeFileSync(consolePath, JSON.stringify(this.consoleLogs || [], null, 2));
      console.log('   Console logs saved: ' + consolePath);
    } catch (e) {
      console.error('Debug error:', e.message);
    }
  }

  async extractData() {
    if (!this.isRunning || this.isExtracting) return;
    // Skip DOM extraction if WebSocket provided data recently (within last 2s)
    if (this.lastWsMsgTime > 0 && Date.now() - this.lastWsMsgTime < 2000) {
      return;
    }
    this.isExtracting = true;
    try {
      const now = new Date();
      const timestamp = now.toISOString();
      // Try to extract price from DOM with targeted selectors
      const price = await this.page.evaluate(() => {
        // Helper: check if element is inside trading panel / transactions / payout areas
        const isInTradingPanel = (el) => {
          const forbiddenSelectors = [
            '.right-widget-container',
            '.control-panel',
            '.call-put-block',
            '.call-put-wrap',
            '.buttons__wrap',
            '.deals-list',
            '.widget-slot',
            '.top-bar',
            '.header',
            '.modal',
            '.popup',
          ];
          for (const sel of forbiddenSelectors) {
            const ancestor = el.closest(sel);
            if (ancestor) return true;
          }
          return false;
        };

        // Helper: check if text looks like payout / transaction amount
        // NOTE: This check is now only applied to leaf elements (elements with no children)
        // to avoid filtering out parent containers that happen to contain trading panel text
        const isPayoutText = (text, el) => {
          const lower = text.toLowerCase();
          // Only treat as payout text if it starts with a currency symbol
          if (/^[\+\-]?[€$£¥]/.test(text)) return true;
          // Or if it contains explicit payout/transaction words
          const forbidden = ['paiement', 'payout', 'montant', 'achat', 'vente'];
          for (const word of forbidden) {
            if (lower.includes(word)) return true;
          }
          return false;
        };

        const selectors = [
          '.strike-value',
          '.current-quote',
          '.quote__val',
          '.price-block__value',
          '#put-call-buttons .price',
          '.js-strike-value',
          '.js-current-price',
          '[data-testid="current-price"]',
          '.current-price',
          '.price-value',
          '.chart-price',
          '.spot',
          '.rate',
          '.bid',
          '.ask',
          '.last-price',
          '.trade-price',
          '.current-rate',
          '.spot-price',
          '[data-field="price"]',
          '[data-field="rate"]',
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.textContent) {
            const text = el.textContent.trim();
            if (isPayoutText(text)) continue;
            const clean = text.replace(/[^\d.,]/g, '').replace(/\,/g, '.');
            const num = parseFloat(clean);
            if (!isNaN(num) && num > 0) return num;
          }
        }

        // Try to find price from global JS variables (Pocket Option stores it in window sometimes)
        const tryGlobalVars = () => {
          const directCandidates = [
            window.price, window.currentPrice, window.spot, window.rate, window.lastPrice,
            window.chartPrice, window.currentRate, window.assetPrice,
          ];
          for (const val of directCandidates) {
            if (typeof val === 'number' && val > 0 && val < 100000) return val;
          }
          // Try TradingView widget APIs
          try {
            if (window.tvWidget && window.tvWidget.activeChart) {
              const chart = window.tvWidget.activeChart();
              if (chart && chart.getPrice) {
                const p = chart.getPrice();
                if (typeof p === 'number' && p > 0 && p < 100000) return p;
              }
              if (chart && chart.getMainSeries) {
                const series = chart.getMainSeries();
                if (series && series.price) {
                  const p = series.price();
                  if (typeof p === 'number' && p > 0 && p < 100000) return p;
                }
              }
            }
          } catch (e) { /* ignore */ }
          // Try Pocket Option specific objects
          try {
            if (window.AppData && window.AppData.rates) {
              const rates = window.AppData.rates;
              for (const key of Object.keys(rates)) {
                const val = rates[key];
                if (typeof val === 'number' && val > 0 && val < 100000) return val;
              }
            }
          } catch (e) { /* ignore */ }
          // Try curated list of likely global object names
          const likelyObjectNames = [
            'chart', 'trading', 'market', 'data', 'quote', 'quotes', 'prices', 'rates', 'spots',
            'lastPrices', 'asset', 'assets', 'tick', 'ticks', 'priceData', 'marketData', 'pocketOption',
          ];
          for (const name of likelyObjectNames) {
            try {
              const obj = window[name];
              if (obj && typeof obj === 'object') {
                const nested = obj.price || obj.currentPrice || obj.spot || obj.rate || obj.lastPrice || obj.bid || obj.ask || obj.value;
                if (typeof nested === 'number' && nested > 0 && nested < 100000) return nested;
              }
            } catch (e) {
              // ignore
            }
          }
          return null;
        };
        const globalPrice = tryGlobalVars();
        if (globalPrice !== null) return globalPrice;

        // Fallback: use cached best selector from startup scan
        const cachedSelector = window.__bestPriceSelector;
        if (cachedSelector) {
          try {
            const el = document.querySelector(cachedSelector);
            if (el && el.textContent) {
              const text = el.textContent.trim();
              if (!isPayoutText(text)) {
                const clean = text.replace(/[^\d.,]/g, '').replace(/\,/g, '.');
                const num = parseFloat(clean);
                if (!isNaN(num) && num > 0 && num < 100000) return num;
              }
            }
          } catch (e) {
            // Invalid selector, clear it
            window.__bestPriceSelector = null;
          }
        }
        // Fallback: position-aware scan — only run every 10 seconds to avoid performance issues
        const nowMs = Date.now();
        if (!window.__lastPositionScan || nowMs - window.__lastPositionScan > 10000) {
          window.__lastPositionScan = nowMs;
          const scope = document.querySelector('.charts') || document.querySelector('.chart-item') || document.querySelector('.site-content-in') || document.querySelector('.site-content') || document.querySelector('.wrapper') || document.body;
          const allEls = scope.querySelectorAll('*');
          const w = window.innerWidth;
          const h = window.innerHeight;
          const centerX = w / 2;
          const centerY = h / 2;
          let bestEl = null;
          let bestScore = -1;
          let bestSelector = null;
          for (const el of allEls) {
            if (el.offsetParent === null) continue;
            const tag = el.tagName.toLowerCase();
            if (tag === 'script' || tag === 'style' || tag === 'noscript') continue;
            // Skip if inside trading panel
            if (isInTradingPanel(el)) continue;
            const text = el.textContent?.trim();
            if (!text) continue;
            if (isPayoutText(text)) continue;
             const rect = el.getBoundingClientRect();
             // Skip large container elements (like the chart container itself)
             if (rect.width > 350 || rect.height > 150) continue;
             if (el.children.length > 2) continue;
             if (text.length > 25) continue;

             const match = text.match(/(\d{1,3}[.,]\d{2,6})/);
             if (!match) continue;
             const num = parseFloat(match[1].replace(',', '.'));
             if (isNaN(num) || num <= 0 || num >= 100000) continue;
             const style = window.getComputedStyle(el);
            const fontSize = parseFloat(style.fontSize) || 10;
            const isBold = style.fontWeight === '700' || style.fontWeight === 'bold';
            const isVisible = rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.top < h && rect.left >= 0 && rect.left < w;
            if (!isVisible) continue;
            const distFromCenter = Math.sqrt(Math.pow(rect.left + rect.width / 2 - centerX, 2) + Math.pow(rect.top + rect.height / 2 - centerY, 2));
            const score = fontSize * 10 + (isBold ? 50 : 0) + Math.max(0, 500 - distFromCenter);
            if (score > bestScore) {
              bestScore = score;
              bestEl = num;
              // Build a robust selector: prefer id, then class+tag, then tag with nth-of-type
              const id = el.id || '';
              const cls = (typeof el.className === 'string' ? el.className : '') || '';
              if (id) {
                bestSelector = '#' + id;
              } else if (cls) {
                const classSelector = '.' + cls.split(/\s+/).filter(Boolean).join('.');
                bestSelector = tag + classSelector;
              } else {
                // Tag with nth-of-type to make it more specific
                const siblings = Array.from(el.parentNode.children).filter(c => c.tagName.toLowerCase() === tag);
                const index = siblings.indexOf(el) + 1;
                bestSelector = tag + ':nth-of-type(' + index + ')';
              }
              window.__bestPriceSelector = bestSelector;
            }
          }
          if (bestEl !== null) return bestEl;
        }
        return null;
      });
      const timeframe = await this.page.evaluate(() => {
        const selectors = [
          '.period-current',
          '.period-value',
          '.js-period-val',
          '.timeframe-value',
          '[data-testid="timeframe"]',
          '.timeframe',
          '.tf-value',
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.textContent) {
            const text = el.textContent.trim();
            // Validate it looks like a timeframe (M1, M5, H1, etc.)
            if (/^(M\d+|H\d+|D\d+)$/.test(text)) {
              return text;
            }
          }
        }
        return '1m';
      });
      if (price !== null) {
        // Deduplication: skip if price hasn't changed significantly
        if (this.currentPrice !== null && Math.abs(price - this.currentPrice) < 0.00001) {
          // skip duplicate
        } else {
          this.currentPrice = price;
          this.currentTimeframe = timeframe;
          const candle = this.detectCandleColor(price);
          const row = {
            timestamp,
            asset: this.currentAsset || 'unknown',
            price,
            timeframe,
            candle,
            action: 'DOM',
          };
          this.csvWriter.writeRow(row);
          this.extractedCount++;
          if (this.simulationEngine) this.simulationEngine.onTick(price, now);
          // Throttle console output: max 1 log per 2 seconds
          const nowMs = now.getTime();
          if (nowMs - this.lastDomLogTime > 2000) {
            const candleEmoji = candle === 'UP' ? '↑' : candle === 'DOWN' ? '↓' : '→';
            console.log('[' + timestamp.split('T')[1].split('.')[0] + '] ' + (this.currentAsset || '???') + ' | ' + price.toFixed(5) + ' | ' + candleEmoji + ' ' + candle + ' | ' + timeframe + ' (DOM)');
            this.lastDomLogTime = nowMs;
          }
        }
      }
      // Auto-debug if no prices found after 5 seconds (moved outside price block)
      if (!this.debugTriggered && this.extractedCount === 0 && now.getTime() - this.extractionStartTime > 5000) {
        this.debugTriggered = true;
        console.log('\nNo prices detected yet. Running auto-debug...');
        await this.debugPage();
        console.log('Debug files saved. Check data/debug/ folder.');
      }
      const detectedAsset = await this.detectCurrentAsset();
      if (detectedAsset && detectedAsset !== this.currentAsset) {
        console.log('\nAsset changed: ' + (this.currentAsset || '?') + ' -> ' + detectedAsset);
        this.currentAsset = detectedAsset;
        if (this.simulationEngine) {
          this.simulationEngine.setAsset(this.currentAsset);
        }
      }
      if (this.csvWriter && this.csvWriter.rowCount >= CONFIG.maxRowsPerFile) {
        console.log('\nRotating CSV file (limit reached)...');
        this.csvWriter.close();
        const newTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const newFileName = 'po_' + (this.currentAsset || 'data').replace(/[/\\:*?"<>|]/g, '_') + '_' + newTimestamp + '.csv';
        const newPath = path.join(CONFIG.outputDir, newFileName);
        this.csvWriter = new CsvWriter(newPath, ['timestamp', 'asset', 'price', 'timeframe', 'candle', 'action']);
      }
    } catch (err) {
      const now = Date.now();
      if (now - this.lastErrorTime > 5000) {
        console.error('Extraction error:', err.message);
        this.lastErrorTime = now;
        this.errorCount = 1;
      } else {
        this.errorCount++;
      }
    } finally {
      this.isExtracting = false;
    }
  }

  detectCandleColor(price) {
    const THRESHOLD = 0.00005;
    if (this.previousPrice === null) {
      this.previousPrice = price;
      return 'NEUTRAL';
    }
    const diff = price - this.previousPrice;
    if (Math.abs(diff) < THRESHOLD) {
      return 'NEUTRAL';
    }
    if (diff > 0) {
      this.previousPrice = price;
      return 'UP';
    }
    this.previousPrice = price;
    return 'DOWN';
  }

  async stop() {
    console.log('\nStopping scraper...');
    this.isRunning = false;
    // Attendre la fin de l'extraction en cours
    while (this.isExtracting) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (this.csvWriter) {
      this.csvWriter.close();
    }
    if (this.simulationEngine) {
      this.simulationEngine.stop();
    }
    console.log('\nSUMMARY:');
    console.log('   Rows extracted: ' + this.extractedCount);
    console.log('   Errors: ' + this.errorCount);
    console.log('   Folder: ' + CONFIG.outputDir);
    if (this.browser) {
      await this.browser.close();
      console.log('   Browser closed');
    }
    if (this.cdpSession) {
      try {
        await this.cdpSession.detach();
      } catch (e) {
        // ignore
      }
    }
    // Clean up temp Opera profile directories
    const tempProfiles = [
      path.join(__dirname, 'tmp-opera-profile'),
      path.join(__dirname, 'tmp-opera-gx-profile'),
    ];
    for (const p of tempProfiles) {
      if (fs.existsSync(p)) {
        try {
          fs.rmSync(p, { recursive: true, force: true });
          console.log('   Temp profile cleaned: ' + p);
        } catch (e) {
          // ignore cleanup errors
        }
      }
    }
    console.log('\nExtraction complete!');
  }
}

module.exports = { PocketOptionScraper, CONFIG };

if (require.main === module) {
  const scraper = new PocketOptionScraper();
  scraper.start().catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });
}
