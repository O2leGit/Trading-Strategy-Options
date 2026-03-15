const express = require('express');
const https = require('https');
const http = require('http');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ─── Environment Detection ──────────────────────────────────────
const certExists = fs.existsSync(path.join(__dirname, 'server-cert.pem'));
const IS_CLOUD = !certExists || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3847;
const SITE_PASSWORD = process.env.SITE_PASSWORD || ''; // Set in Railway env vars
console.log(`Environment: ${IS_CLOUD ? 'CLOUD' : 'LOCAL'}, certs: ${certExists}, PORT: ${PORT}`);

// ─── Password Protection (cloud only) ──────────────────────────
if (IS_CLOUD && SITE_PASSWORD) {
  app.use((req, res, next) => {
    // Skip auth for callback (Schwab redirect) and health check
    if (req.path === '/callback' || req.path === '/health' || req.path.startsWith('/api/')) return next();
    // Check cookie
    if (req.headers.cookie && req.headers.cookie.includes('auth=granted')) return next();
    // Check if submitting password
    if (req.method === 'POST' && req.path === '/login') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const params = new URLSearchParams(body);
        if (params.get('password') === SITE_PASSWORD) {
          res.setHeader('Set-Cookie', 'auth=granted; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000');
          return res.redirect('/');
        }
        return res.send(loginPage('Wrong password'));
      });
      return;
    }
    // Show login page
    if (req.path === '/login' || req.accepts('html')) {
      return res.send(loginPage());
    }
    return res.status(401).json({ error: 'Authentication required' });
  });
}

function loginPage(error) {
  return `<!DOCTYPE html>
<html><head><title>Login</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="background:#0f0f23;color:#e2e8f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
  <form method="POST" action="/login" style="background:#1a1a2e;padding:40px;border-radius:12px;border:1px solid #334155;text-align:center;min-width:300px;">
    <h2 style="color:#06b6d4;margin:0 0 24px;">Options Command Center</h2>
    ${error ? `<p style="color:#ef4444;font-size:0.85rem;">${error}</p>` : ''}
    <input type="password" name="password" placeholder="Enter password" autofocus
      style="width:100%;padding:12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:1rem;box-sizing:border-box;margin-bottom:16px;">
    <button type="submit" style="width:100%;padding:12px;background:#06b6d4;color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer;">Enter</button>
  </form>
</body></html>`;
}

// Intercept root requests with ?code= parameter (Schwab OAuth callback)
app.use((req, res, next) => {
  if (req.path === '/' && req.query.code) {
    console.log('Root callback intercepted with code!');
    req.url = '/callback' + '?code=' + encodeURIComponent(req.query.code);
    if (req.query.session) req.url += '&session=' + encodeURIComponent(req.query.session);
  }
  next();
});

app.use(express.static(path.join(__dirname)));

// Health check for Railway
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ─── Client Dashboard ────────────────────────────────────────
app.use('/clients', express.static(path.join(__dirname, 'client-dashboard')));
const SNAPSHOT_FILE = path.join(__dirname, 'client-dashboard', 'daily-snapshot.json');

app.get('/clients/api/snapshot', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    res.json(data);
  } catch {
    res.status(404).json({ error: 'No snapshot available yet' });
  }
});

app.post('/clients/api/generate-snapshot', async (req, res) => {
  try {
    const snapshot = { generatedAt: new Date().toISOString(), market: {}, sectors: {}, news: [], regime: {} };

    const symbols = {
      spx: '%5EGSPC', vix: '%5EVIX', dow: '%5EDJI', nasdaq: '%5EIXIC',
      oil: 'CL%3DF', treasury: '%5ETNX'
    };
    for (const [name, sym] of Object.entries(symbols)) {
      try {
        const r = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=5d&interval=1d&includePrePost=false`, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const result = r.data.chart.result[0];
        const meta = result.meta;
        const closes = result.indicators.quote[0].close;
        const prevClose = meta.chartPreviousClose || closes[closes.length - 2];
        const price = meta.regularMarketPrice;
        snapshot.market[name] = {
          price, prevClose,
          change: price - prevClose,
          changePct: ((price - prevClose) / prevClose * 100).toFixed(2)
        };
      } catch (e) {
        console.error(`Snapshot: Failed to fetch ${name}:`, e.message);
      }
    }

    const sectorSymbols = ['XLE','XLK','XLF','XLV','XLU','XLY','XLP','XLI','XLB','XLRE','IWM','QQQ'];
    for (const sym of sectorSymbols) {
      try {
        const r = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=5d&interval=1d`, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const result = r.data.chart.result[0];
        const meta = result.meta;
        const closes = result.indicators.quote[0].close;
        const prevClose = meta.chartPreviousClose || closes[closes.length - 2];
        const price = meta.regularMarketPrice;
        snapshot.sectors[sym] = {
          price, changePct: ((price - prevClose) / prevClose * 100).toFixed(2)
        };
      } catch (e) {
        console.error(`Snapshot: Failed to fetch sector ${sym}:`, e.message);
      }
    }

    const vix = snapshot.market.vix?.price || 20;
    snapshot.regime = {
      vix,
      level: vix < 15 ? 'Low Volatility' : vix < 20 ? 'Normal' : vix < 30 ? 'Elevated' : 'Crisis',
      ivRank: Math.min(100, Math.max(0, Math.round((vix - 12) / (40 - 12) * 100))),
      expectedMove1d: snapshot.market.spx ? (snapshot.market.spx.price * (vix / 100) * Math.sqrt(1 / 365)).toFixed(1) : null,
      expectedMove1w: snapshot.market.spx ? (snapshot.market.spx.price * (vix / 100) * Math.sqrt(5 / 365)).toFixed(1) : null
    };

    const finnhubKey = process.env.FINNHUB_KEY || '';
    if (finnhubKey) {
      try {
        const r = await axios.get(`https://finnhub.io/api/v1/news?category=general&minId=0&token=${finnhubKey}`);
        snapshot.news = (r.data || []).slice(0, 15).map(n => ({
          headline: n.headline, source: n.source, url: n.url,
          datetime: n.datetime, summary: n.summary?.substring(0, 200)
        }));
      } catch (e) {
        console.error('Snapshot: Failed to fetch news:', e.message);
      }
    }

    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
    console.log('Daily snapshot generated at', snapshot.generatedAt);
    res.json({ success: true, generatedAt: snapshot.generatedAt });
  } catch (e) {
    console.error('Snapshot generation failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Server-provided API keys (from env vars) ──────────────────
app.get('/api/keys', (req, res) => {
  res.json({
    finnhub: process.env.FINNHUB_KEY || '',
    twelve: process.env.TWELVE_DATA_KEY || '',
    polygon: process.env.POLYGON_KEY || ''
  });
});

// ─── Yahoo Finance Proxy (avoids CORS issues) ──────────────────
app.get('/api/yahoo/chart/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const range = req.query.range || '1d';
    const interval = req.query.interval || '5m';
    const includePrePost = req.query.includePrePost || 'true';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}&includePrePost=${includePrePost}`;
    const r = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    res.json(r.data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.message });
  }
});

app.get('/api/yahoo/options/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const url = `https://query1.finance.yahoo.com/v7/finance/options/${symbol}`;
    const r = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    res.json(r.data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.message });
  }
});

// ─── Polygon.io Proxy (with caching to avoid 429 rate limits) ──
const polygonCache = {};
const POLYGON_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

app.get('/api/polygon/*', async (req, res) => {
  const polygonKey = process.env.POLYGON_KEY || '';
  if (!polygonKey) return res.status(400).json({ error: 'Polygon key not configured' });

  const polygonPath = req.params[0]; // everything after /api/polygon/
  const queryStr = new URLSearchParams(req.query);
  queryStr.set('apiKey', polygonKey);
  const cacheKey = polygonPath + '?' + queryStr.toString();

  // Return cached if fresh
  if (polygonCache[cacheKey] && Date.now() - polygonCache[cacheKey].time < POLYGON_CACHE_TTL) {
    return res.json(polygonCache[cacheKey].data);
  }

  try {
    const url = `https://api.polygon.io/${polygonPath}?${queryStr.toString()}`;
    const r = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    polygonCache[cacheKey] = { data: r.data, time: Date.now() };
    res.json(r.data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.message });
  }
});

// ─── Schwab Configuration ──────────────────────────────────────
const CONFIG_FILE = path.join(__dirname, 'schwab_config.json');
const TOKENS_FILE = path.join(__dirname, 'schwab_tokens.json');
const SCHWAB_AUTH_BASE = 'https://api.schwabapi.com/v1/oauth';
const SCHWAB_API_BASE = 'https://api.schwabapi.com';

// Redirect URI: use env var on cloud, fallback for local
const REDIRECT_URI = process.env.SCHWAB_REDIRECT_URI || 'https://127.0.0.1';

// ─── Token Storage ──────────────────────────────────────────────

function loadConfig() {
  // Cloud: use env vars; Local: use config file
  if (IS_CLOUD && process.env.SCHWAB_APP_KEY) {
    return { appKey: process.env.SCHWAB_APP_KEY, secret: process.env.SCHWAB_APP_SECRET };
  }
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return null; }
}

function saveConfig(data) {
  console.log('Writing config to:', CONFIG_FILE);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
  console.log('Config file exists after write:', fs.existsSync(CONFIG_FILE));
}

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); } catch { return null; }
}

function saveTokens(data) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2));
}

function isTokenValid() {
  const tokens = loadTokens();
  if (!tokens || !tokens.accessToken) return false;
  return tokens.expiresAt > Date.now() + 60000;
}

async function refreshAccessToken() {
  const config = loadConfig();
  const tokens = loadTokens();
  if (!config || !tokens || !tokens.refreshToken) return false;

  try {
    const basicAuth = Buffer.from(`${config.appKey}:${config.secret}`).toString('base64');
    const res = await axios.post(`${SCHWAB_AUTH_BASE}/token`,
      `grant_type=refresh_token&refresh_token=${encodeURIComponent(tokens.refreshToken)}`,
      {
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    const newTokens = {
      accessToken: res.data.access_token,
      refreshToken: res.data.refresh_token || tokens.refreshToken,
      expiresAt: Date.now() + (res.data.expires_in * 1000),
      accountHash: tokens.accountHash,
      accountNumber: tokens.accountNumber
    };
    saveTokens(newTokens);
    console.log('Token refreshed successfully');
    return true;
  } catch (e) {
    console.error('Token refresh failed:', e.response?.data || e.message);
    return false;
  }
}

async function getValidToken() {
  if (isTokenValid()) return loadTokens().accessToken;
  const refreshed = await refreshAccessToken();
  if (refreshed) return loadTokens().accessToken;
  return null;
}

// ─── Auth Middleware ─────────────────────────────────────────────

async function requireAuth(req, res, next) {
  const token = await getValidToken();
  if (!token) return res.status(401).json({ error: 'Not authenticated. Please connect to Schwab.' });
  req.schwabToken = token;
  req.accountHash = loadTokens().accountHash;
  next();
}

// ─── Credential Routes ──────────────────────────────────────────

app.post('/schwab/config', (req, res) => {
  const { appKey, secret } = req.body;
  if (!appKey || !secret) return res.status(400).json({ error: 'App Key and Secret required' });
  saveConfig({ appKey, secret });
  console.log('Schwab credentials saved');
  res.json({ success: true });
});

app.get('/schwab/config', (req, res) => {
  const config = loadConfig();
  if (!config) return res.json({ hasConfig: false });
  res.json({ hasConfig: true, appKey: config.appKey.slice(0, 6) + '...' });
});

// ─── OAuth Routes ───────────────────────────────────────────────

app.get('/schwab/auth-url', (req, res) => {
  const config = loadConfig();
  if (!config) return res.status(400).json({ error: 'Save credentials first' });
  const url = `${SCHWAB_AUTH_BASE}/authorize?client_id=${config.appKey}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code`;
  console.log('Auth URL generated with redirect_uri:', REDIRECT_URI);
  res.json({ url });
});

app.get('/callback', async (req, res) => {
  console.log('Callback hit! Full URL:', req.originalUrl);
  const code = req.query.code;
  if (!code) return res.send(`<h2>Error: No authorization code received</h2><pre>Query: ${JSON.stringify(req.query, null, 2)}</pre>`);

  const config = loadConfig();
  if (!config) return res.send('<h2>Error: No credentials configured</h2>');

  try {
    const basicAuth = Buffer.from(`${config.appKey}:${config.secret}`).toString('base64');
    const tokenRes = await axios.post(`${SCHWAB_AUTH_BASE}/token`,
      `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
      {
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const tokenData = {
      accessToken: tokenRes.data.access_token,
      refreshToken: tokenRes.data.refresh_token,
      expiresAt: Date.now() + (tokenRes.data.expires_in * 1000),
      accountHash: null
    };

    try {
      const acctRes = await axios.get(`${SCHWAB_API_BASE}/trader/v1/accounts/accountNumbers`, {
        headers: { 'Authorization': `Bearer ${tokenData.accessToken}` }
      });
      if (acctRes.data && acctRes.data.length > 0) {
        tokenData.accountHash = acctRes.data[0].hashValue;
        tokenData.accountNumber = acctRes.data[0].accountNumber;
      }
    } catch (e) {
      console.error('Failed to fetch account hash:', e.message);
    }

    saveTokens(tokenData);
    console.log('Schwab OAuth complete — connected!');

    res.send(`
      <html><body style="background:#1a1a2e; color:#10b981; font-family:system-ui; display:flex; align-items:center; justify-content:center; height:100vh; margin:0;">
        <div style="text-align:center;">
          <h1 style="font-size:3rem;">✅</h1>
          <h2>Connected to Schwab!</h2>
          <p style="color:#94a3b8;">You can close this tab and return to the dashboard.</p>
          <script>setTimeout(() => window.close(), 3000);</script>
        </div>
      </body></html>
    `);
  } catch (e) {
    console.error('OAuth token exchange failed:', e.response?.data || e.message);
    res.send(`<h2>Authentication failed</h2><pre>${JSON.stringify(e.response?.data || e.message, null, 2)}</pre>`);
  }
});

// Manual code entry (fallback)
app.get('/schwab/manual-callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.json({ success: false, error: 'No code provided' });

  const config = loadConfig();
  if (!config) return res.json({ success: false, error: 'No credentials configured' });

  try {
    const basicAuth = Buffer.from(`${config.appKey}:${config.secret}`).toString('base64');
    const tokenRes = await axios.post(`${SCHWAB_AUTH_BASE}/token`,
      `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
      {
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const tokenData = {
      accessToken: tokenRes.data.access_token,
      refreshToken: tokenRes.data.refresh_token,
      expiresAt: Date.now() + (tokenRes.data.expires_in * 1000),
      accountHash: null
    };

    try {
      const acctRes = await axios.get(`${SCHWAB_API_BASE}/trader/v1/accounts/accountNumbers`, {
        headers: { 'Authorization': `Bearer ${tokenData.accessToken}` }
      });
      if (acctRes.data && acctRes.data.length > 0) {
        tokenData.accountHash = acctRes.data[0].hashValue;
        tokenData.accountNumber = acctRes.data[0].accountNumber;
      }
    } catch (e) {
      console.error('Failed to fetch account hash:', e.message);
    }

    saveTokens(tokenData);
    console.log('Schwab OAuth complete via manual code — connected!');
    res.json({ success: true });
  } catch (e) {
    console.error('Manual OAuth failed:', e.response?.data || e.message);
    res.json({ success: false, error: JSON.stringify(e.response?.data || e.message) });
  }
});

app.get('/schwab/status', (req, res) => {
  const tokens = loadTokens();
  if (!tokens || !tokens.accessToken) return res.json({ connected: false });
  const acctDisplay = tokens.accountNumber ? '****' + tokens.accountNumber.slice(-4) : 'Unknown';
  res.json({
    connected: true,
    accountId: acctDisplay,
    expiresIn: Math.max(0, Math.floor((tokens.expiresAt - Date.now()) / 1000)),
    hasAccountHash: !!tokens.accountHash
  });
});

app.post('/schwab/disconnect', (req, res) => {
  try { fs.unlinkSync(TOKENS_FILE); } catch {}
  console.log('Schwab disconnected');
  res.json({ success: true });
});

// ─── API Proxy Routes ───────────────────────────────────────────

app.get('/schwab/accounts', requireAuth, async (req, res) => {
  try {
    const r = await axios.get(
      `${SCHWAB_API_BASE}/trader/v1/accounts/${req.accountHash}?fields=positions`,
      { headers: { 'Authorization': `Bearer ${req.schwabToken}` } }
    );
    res.json(r.data);
  } catch (e) {
    res.status(e.response?.status || 500).json(e.response?.data || { error: e.message });
  }
});

app.post('/schwab/orders', requireAuth, async (req, res) => {
  try {
    const r = await axios.post(
      `${SCHWAB_API_BASE}/trader/v1/accounts/${req.accountHash}/orders`,
      req.body,
      { headers: { 'Authorization': `Bearer ${req.schwabToken}`, 'Content-Type': 'application/json' } }
    );
    const location = r.headers['location'] || '';
    const orderId = location.split('/').pop();
    res.json({ success: true, orderId, status: r.status });
  } catch (e) {
    console.error('Order failed:', e.response?.data || e.message);
    res.status(e.response?.status || 500).json(e.response?.data || { error: e.message });
  }
});

app.get('/schwab/orders', requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const from = new Date(now - 7 * 86400000).toISOString();
    const to = now.toISOString();
    const r = await axios.get(
      `${SCHWAB_API_BASE}/trader/v1/accounts/${req.accountHash}/orders?fromEnteredTime=${from}&toEnteredTime=${to}`,
      { headers: { 'Authorization': `Bearer ${req.schwabToken}` } }
    );
    res.json(r.data);
  } catch (e) {
    res.status(e.response?.status || 500).json(e.response?.data || { error: e.message });
  }
});

app.get('/schwab/orders/:orderId', requireAuth, async (req, res) => {
  try {
    const r = await axios.get(
      `${SCHWAB_API_BASE}/trader/v1/accounts/${req.accountHash}/orders/${req.params.orderId}`,
      { headers: { 'Authorization': `Bearer ${req.schwabToken}` } }
    );
    res.json(r.data);
  } catch (e) {
    res.status(e.response?.status || 500).json(e.response?.data || { error: e.message });
  }
});

// ─── Start ──────────────────────────────────────────────────────

if (IS_CLOUD) {
  // Cloud: plain HTTP (Railway/Render handles SSL)
  // IMPORTANT: Must bind to 0.0.0.0 for Railway's proxy to reach the app
  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`\n  Options Trading Dashboard (CLOUD)`);
    console.log(`  ──────────────────────────────────`);
    console.log(`  Port: ${PORT}`);
    console.log(`  Schwab redirect: ${REDIRECT_URI}`);
    console.log(`  Password protected: ${SITE_PASSWORD ? 'YES' : 'NO'}\n`);

    const tokens = loadTokens();
    if (tokens && tokens.refreshToken) {
      const ok = await refreshAccessToken();
      console.log(ok ? '  Schwab: Auto-reconnected ✓' : '  Schwab: Token expired — please reconnect');
    } else {
      console.log('  Schwab: Not connected');
    }
  });
} else {
  // Local: HTTPS with SSL certs
  const certPath = path.join(__dirname, 'server-cert.pem');
  const keyPath = path.join(__dirname, 'server-key.pem');

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const sslOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };

    https.createServer(sslOptions, app).listen(PORT, async () => {
      console.log(`\n  Options Trading Dashboard (LOCAL)`);
      console.log(`  ──────────────────────────────────`);
      console.log(`  Dashboard:  https://127.0.0.1:${PORT}`);
      console.log(`  Schwab CB:  ${REDIRECT_URI}\n`);

      // Also listen on 443 for https://127.0.0.1 redirects
      try {
        https.createServer(sslOptions, app).listen(443, () => {
          console.log('  Port 443 listener active ✓');
        });
      } catch (e) {
        console.log('  Port 443 unavailable:', e.code);
      }

      const tokens = loadTokens();
      if (tokens && tokens.refreshToken) {
        const ok = await refreshAccessToken();
        console.log(ok ? '  Schwab: Auto-reconnected ✓' : '  Schwab: Token expired — please reconnect');
      } else {
        console.log('  Schwab: Not connected');
      }
    });
  } else {
    // No certs — fall back to HTTP locally
    app.listen(PORT, async () => {
      console.log(`\n  Options Trading Dashboard (LOCAL - HTTP)`);
      console.log(`  Dashboard:  http://localhost:${PORT}\n`);
    });
  }
}
