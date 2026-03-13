const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const PORT = 3847;
const CONFIG_FILE = path.join(__dirname, 'schwab_config.json');
const TOKENS_FILE = path.join(__dirname, 'schwab_tokens.json');
const SCHWAB_AUTH_BASE = 'https://api.schwabapi.com/v1/oauth';
const SCHWAB_API_BASE = 'https://api.schwabapi.com';
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

// ─── Token Storage ──────────────────────────────────────────────

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return null; }
}

function saveConfig(data) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
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
  res.json({ url });
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send('<h2>Error: No authorization code received</h2>');

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

app.listen(PORT, async () => {
  console.log(`\n  Options Trading Dashboard`);
  console.log(`  ────────────────────────`);
  console.log(`  Dashboard:  http://localhost:${PORT}`);
  console.log(`  Schwab CB:  http://localhost:${PORT}/callback\n`);

  // Try to refresh token on startup
  const tokens = loadTokens();
  if (tokens && tokens.refreshToken) {
    const ok = await refreshAccessToken();
    console.log(ok ? '  Schwab: Auto-reconnected ✓' : '  Schwab: Token expired — please reconnect');
  } else {
    console.log('  Schwab: Not connected');
  }
});
