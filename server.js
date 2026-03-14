const express = require('express');
const https = require('https');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

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

// ─── Client Dashboard ────────────────────────────────────────
// Serve client dashboard at /clients
app.use('/clients', express.static(path.join(__dirname, 'client-dashboard')));

// Daily snapshot data endpoint — clients fetch this instead of hitting APIs directly
const SNAPSHOT_FILE = path.join(__dirname, 'client-dashboard', 'daily-snapshot.json');

app.get('/clients/api/snapshot', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    res.json(data);
  } catch {
    res.status(404).json({ error: 'No snapshot available yet' });
  }
});

// Generate daily snapshot — call this manually or via scheduled task
app.post('/clients/api/generate-snapshot', async (req, res) => {
  try {
    const snapshot = { generatedAt: new Date().toISOString(), market: {}, sectors: {}, news: [], regime: {} };

    // Fetch core market data from Yahoo
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

    // Fetch sector data
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

    // Derive regime
    const vix = snapshot.market.vix?.price || 20;
    snapshot.regime = {
      vix,
      level: vix < 15 ? 'Low Volatility' : vix < 20 ? 'Normal' : vix < 30 ? 'Elevated' : 'Crisis',
      ivRank: Math.min(100, Math.max(0, Math.round((vix - 12) / (40 - 12) * 100))),
      expectedMove1d: snapshot.market.spx ? (snapshot.market.spx.price * (vix / 100) * Math.sqrt(1 / 365)).toFixed(1) : null,
      expectedMove1w: snapshot.market.spx ? (snapshot.market.spx.price * (vix / 100) * Math.sqrt(5 / 365)).toFixed(1) : null
    };

    // Fetch news from Finnhub if key available
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

const PORT = 3847;
const CONFIG_FILE = path.join(__dirname, 'schwab_config.json');
const TOKENS_FILE = path.join(__dirname, 'schwab_tokens.json');
const SCHWAB_AUTH_BASE = 'https://api.schwabapi.com/v1/oauth';
const SCHWAB_API_BASE = 'https://api.schwabapi.com';
// Must match EXACTLY what's registered in Schwab Developer Portal
const REDIRECT_URI = 'https://127.0.0.1';

// ─── Token Storage ──────────────────────────────────────────────

function loadConfig() {
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
  return tokens.expiresAt > Date.now() + 60000; // 1 min buffer
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
      accountHash: tokens.accountHash
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
  console.log('Auth URL generated:', url);
  console.log('Redirect URI:', REDIRECT_URI);
  res.json({ url });
});

app.get('/callback', async (req, res) => {
  console.log('Callback hit! Full URL:', req.originalUrl);
  console.log('Query params:', req.query);
  console.log('Headers referer:', req.headers.referer || 'none');
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

    // Fetch account hash
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

// Manual code entry (when popup redirect fails due to self-signed cert)
app.get('/schwab/manual-callback', async (req, res) => {
  const code = req.query.code;
  console.log('Manual callback with code:', code ? code.substring(0, 20) + '...' : 'NONE');
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
    // Schwab returns 201 with Location header containing order ID
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

const sslOptions = {
  key: fs.readFileSync(path.join(__dirname, 'server-key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'server-cert.pem'))
};

https.createServer(sslOptions, app).listen(PORT, async () => {
  console.log(`\n  Options Trading Dashboard`);
  console.log(`  ────────────────────────`);
  console.log(`  Dashboard:  https://127.0.0.1:${PORT}`);
  console.log(`  Clients:    https://127.0.0.1:${PORT}/clients`);
  console.log(`  Schwab CB:  https://127.0.0.1:${PORT}/callback`);
  console.log(`  Alt CB:     https://127.0.0.1 (port 443)\n`);

  // Also listen on 443 to catch redirects to https://127.0.0.1 (no port)
  try {
    https.createServer(sslOptions, app).listen(443, () => {
      console.log('  Port 443 listener active ✓');
    });
  } catch (e) {
    console.log('  Port 443 unavailable (need admin):', e.code);
  }

  // Try to refresh token on startup
  const tokens = loadTokens();
  if (tokens && tokens.refreshToken) {
    const ok = await refreshAccessToken();
    console.log(ok ? '  Schwab: Auto-reconnected ✓' : '  Schwab: Token expired — please reconnect');
  } else {
    console.log('  Schwab: Not connected');
  }
});
