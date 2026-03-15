# Options Strategy Command Center

## Project Overview
Single-page options trading dashboard (`index.html`) — dark-themed, no frameworks, pure HTML/CSS/JS with live market data. Deployed to Railway cloud with password protection.

## File Structure
- `index.html` — Entire frontend application (~4,500+ lines). All HTML, CSS, and JS in one file.
- `server.js` — Express backend (~600 lines). API proxies, Schwab OAuth, password protection, cloud/local dual mode.
- `package.json` — Dependencies: express, axios. Node >=18.
- `schwab_config.json` — Schwab OAuth credentials (gitignored)
- `schwab_tokens.json` — Schwab OAuth tokens (gitignored)
- `server-cert.pem` / `server-key.pem` — Self-signed SSL certs for local HTTPS (gitignored)
- `.gitignore` — Excludes node_modules, tokens, config, certs, .env, dist/
- `.claude/launch.json` — Preview server config (port 3847, uses `serve` via node)

## Deployment

### Railway (Production)
- **URL**: `https://trading-strategy-options-production.up.railway.app`
- **Auto-deploy**: Pushes to `master` branch on GitHub trigger auto-deploy
- **GitHub repo**: `O2leGit/Trading-Strategy-Options` (private)
- **Port**: Railway injects `PORT` env var (8080), app binds to `0.0.0.0`
- **Password**: Set via `SITE_PASSWORD` env var, cookie-based session (`auth=granted`)
- **SSL**: Railway handles SSL termination (app runs plain HTTP internally)

### Railway Environment Variables (9 total)
- `NODE_ENV` = production
- `SITE_PASSWORD` — Dashboard login password
- `SCHWAB_APP_KEY` — Schwab OAuth app key
- `SCHWAB_APP_SECRET` — Schwab OAuth app secret
- `SCHWAB_REDIRECT_URI` = `https://trading-strategy-options-production.up.railway.app/callback`
- `FINNHUB_KEY` — Finnhub API key (60 calls/min free)
- `TWELVE_DATA_KEY` — Twelve Data API key (800 calls/day free)
- `POLYGON_KEY` — Polygon.io API key (5 calls/min free)
- `ALPHA_VANTAGE_KEY` — Alpha Vantage API key (25 calls/day free)

### Local Development
- Run `node server.js` — auto-detects local mode (HTTPS with self-signed certs on port 3847)
- Or open `index.html` directly in browser (uses CORS proxies, no server needed)

## Architecture
- **Tab system**: 3 groups (MARKET, STRATEGIES, TOOLS) with color-coded labels (cyan/orange/purple)
- **MARKET tabs**: Market Overview, News & Sentiment, Regime Classifier, Fundamental Screener
- **STRATEGIES tabs**: Strategy Templates, 0DTE SPX Scanner, Theta Decay Calc, Strike Probability, Pre-Market Edge, Skew Exploiter, Weekly Calendar, Earnings Crusher, EOD Theta Scalper
- **TOOLS tabs**: Position Tracker, Greeks & P/L Calculator, Risk Management, Performance Dashboard, Strategy Education, Backtester, Paper Trading, Connections
- **MARKET object**: Centralized live market data (SPX, VIX, DOW, NASDAQ, Oil, Treasury) with expected move functions
- **Best Plays engine**: Auto-scan system on each strategy tab showing Day Trade / Swing / Monthly plays
- **Black-Scholes**: Options pricing model for Greeks calculation (bsPrice, bsGreeks, bsImpliedVol)
- **Canvas charts**: P&L visualization
- **localStorage**: Position persistence + API key storage

## Live Data Architecture

### Data Sources (Priority Order — 4-tier fallback)
1. **Yahoo Finance** (primary) — via server-side proxy (`/api/yahoo/chart/:symbol`), no API key needed
   - Indices: `%5EGSPC` (SPX), `%5EDJI` (Dow), `%5EIXIC` (Nasdaq), `%5EVIX`, `CL%3DF` (Oil), `%5ETNX` (10Y Treasury)
   - Sector ETFs: XLE, XLK, XLF, XLV, XLU, XLY, XLP, XLI, XLB, XLRE, IWM, QQQ
   - Client tries server proxy first (`/api/yahoo/chart/`), falls back to `corsproxy.io` CORS proxy
2. **Finnhub** (backup + news + WebSocket) — API key from env var or localStorage
   - REST: `finnhub.io/api/v1/quote?symbol={sym}&token={key}` (query param auth, avoids CORS preflight)
   - WebSocket: `wss://ws.finnhub.io?token={key}` — real-time ticks for SPY, QQQ, DIA
   - News: `finnhub.io/api/v1/news?category=general&minId=0&token={key}`
   - Note: Finnhub only has ETF data (SPY), not index data (SPX). SPY×10 ≈ SPX approximation used.
3. **Twelve Data** (tertiary backup) — API key from env var or localStorage
   - Endpoint: `api.twelvedata.com/quote?symbol={sym}&apikey={key}`
4. **Alpha Vantage** (4th fallback + technicals + news sentiment) — via server proxy (`/api/alpha/*`) with 10-min cache
   - Quotes: `GLOBAL_QUOTE` function
   - Technicals: RSI (14-period), MACD, Bollinger Bands (20-period)
   - News sentiment: `NEWS_SENTIMENT` function with AI sentiment scores
   - Rate limit: 25 calls/day free tier — aggressive 10-min server-side caching

### Options Data
- **Polygon.io** — Options chain data via server proxy (`/api/polygon/*`) with 5-min cache
  - Contract listings: `/v3/reference/options/contracts`
  - Previous day aggregates: `/v2/aggs/ticker/{symbol}/prev`
  - Client uses `rateLimitedPolygonFetch()` for direct calls (5 calls/min)
  - Black-Scholes theoretical pricing with VIX-based IV estimates and IV smile model
  - Replaced Yahoo v7 options endpoint (permanently dead, returns 401 "Invalid Crumb")

### Server-Side API Proxies (server.js)
All proxies bypass CORS issues and inject API keys from env vars:
- `/api/keys` — Returns all API keys from env vars (auto-saved to client localStorage)
- `/api/yahoo/chart/:symbol` — Yahoo Finance chart data proxy
- `/api/yahoo/options/:symbol` — Yahoo Finance options proxy (legacy, v7 is dead)
- `/api/polygon/*` — Polygon.io proxy with 5-minute cache
- `/api/alpha/*` — Alpha Vantage proxy with 10-minute cache

### API Key Management
- Server provides keys via `/api/keys` endpoint (from Railway env vars)
- `fetchServerKeys()` runs on page load, auto-saves to localStorage
- `getApiKeys()` returns keys from localStorage with server key fallback
- UI config modal on Connections tab allows manual key entry
- Keys stored in localStorage: `apiKey_finnhub`, `apiKey_twelve`, `apiKey_polygon`, `apiKey_alpha`

### Refresh Schedule
- **Core data** (indices, VIX): Every 60 seconds via `fetchAllMarketData()`
- **Secondary data** (sectors, news): Every 5 minutes via `fetchSecondaryData()`
- **Earnings calendar**: Once on load, then every 6 hours
- **Options scan**: Every 3 minutes via `runPriorityScan()` (respects per-ticker cooldown)
- **WebSocket**: Real-time tick updates for SPY/QQQ/DIA (when Finnhub key configured)

### Derived Values (computed from live data)
- **Regime**: VIX < 15 = Low, 15-20 = Normal, 20-30 = Elevated, 30+ = Crisis
- **IV Rank**: `Math.round((vix - 12) / (40 - 12) * 100)` (clamped 0-100)
- **Expected Moves**: `spx * (vix/100) * sqrt(T/365)` for 1d/1w/1m
- **Overnight Gap**: `((spx - spxPrevClose) / spxPrevClose * 100)`
- **Sentiment**: Keyword-based analysis of Finnhub news headlines

### Dynamic HTML IDs (live-updated elements)
- Market cards: `val-spx`, `chg-spx`, `val-dow`, `chg-dow`, `val-nasdaq`, `chg-nasdaq`, `val-vix`, `chg-vix`, `val-oil`, `chg-oil`, `val-tsy`, `chg-tsy`
- Market Overview: `regimeBadge`, `regimeIndicators`, `sectorHeatMap`
- News tab: `liveNewsContainer`
- Regime tab: `regimeDashboard`, `regimeVerdict`, `regimeVerdictBox`, `regimeVerdictTitle`, `regimeVerdictText`
- 0DTE tab: `dte-spx`, `dte-spx-chg`, `dte-vix`
- Risk tab: `risk-vix-current`
- Connections tab: `connTable`, `connTableBody`, `connFetchCount`, `connLastUpdate`, `connWSStatus`, `apiKeyStatus`
- Header: `dataStatus`, `dataStatusIcon`, `dataStatusText`

### Connection Test (11 feeds)
`runConnectionTest()` tests all data sources in parallel:
1-6. Yahoo Finance: S&P 500, Dow, Nasdaq, VIX, WTI Crude, 10Y Treasury
7. Options Chain (Polygon.io via server proxy)
8. Finnhub REST (SPY quote)
9. Twelve Data (SPY quote)
10. Polygon Options (contract references)
11. Alpha Vantage (SPY Global Quote)

## Key Functions

### Data Fetching
- `fetchAllMarketData()` — Master fetcher: Yahoo → Finnhub → Twelve Data → Alpha Vantage fallback chain
- `fetchYahoo(symbol)` / `fetchYahooQuotes()` — Yahoo Finance via server proxy, CORS proxy fallback
- `fetchFinnhub(symbol)` / `fetchFinnhubQuotes()` — Finnhub REST quotes
- `fetchTwelveData(symbol)` — Twelve Data backup quotes
- `fetchAlphaVantage(symbol)` — Alpha Vantage Global Quote (4th fallback)
- `fetchAlphaTechnicals(symbol)` — Alpha Vantage RSI, MACD, Bollinger Bands
- `fetchAlphaNewsSentiment(tickers)` — Alpha Vantage AI news sentiment
- `fetchSectorData()` / `renderSectorHeatMap()` — 12 sector ETFs via Yahoo
- `fetchMarketNews()` / `renderNews()` — Finnhub news with keyword sentiment
- `connectFinnhubWS()` — Finnhub WebSocket for real-time SPY/QQQ/DIA ticks
- `fetchPolygonChain(symbol)` — Polygon options chain with Black-Scholes Greeks
- `fetchOptionsChain(symbol)` — Legacy Yahoo v7 options (dead, kept as fallback stub)
- `fetchServerKeys()` — Fetches API keys from server `/api/keys`, auto-saves to localStorage

### Display Updates
- `updateMarketCards(data)` — Updates market card UI elements + MARKET object
- `updateRegimeIndicators()` — Live regime indicators on Market Overview
- `updateRegimeClassifier()` — Live regime dashboard on Regime tab
- `updateMiscLiveRefs()` — Updates 0DTE SPX/VIX, Risk VIX references
- `updateAllDisplays()` — Master display updater called after each data fetch
- `setDataStatus(icon, text, color)` — Updates header data status indicator

### Strategy Engine
- `generateBestPlays(tabId)` — Dispatcher for strategy-specific play generators
- `calculateThetaDashboard()` — Theta income projections
- `calculateProbStrikes()` — Strike probability matrix
- `calculateRiskLimits()` — Position sizing and loss limits
- 9 play generators: `generateZeroDTEPlays()`, `generateThetaPlays()`, etc.
- `runPriorityScan()` — Options chain scanner across SCAN_UNIVERSE (50 tickers)

### Connection & Config
- `runConnectionTest()` — Tests all 11 data feeds, shows green/red status
- `getApiKeys()` — Returns all API keys (localStorage + server fallback)
- `showApiConfig()` / `saveApiConfig()` — API key configuration modal
- `initLiveData()` — Bootstrap: fetch all data, connect WS, start intervals

### Schwab Integration
- `schwabCheckStatus()` — Check Schwab connection on startup
- OAuth flow: `/schwab/auth-url` → `/callback` → `/schwab/status`
- Order execution: `/schwab/orders` (POST for new, GET for history)
- Account data: `/schwab/accounts` (positions + balances)

## Schwab Broker Integration
- **OAuth flow**: Server handles token exchange, refresh, and storage
- **Callback URL**: `https://trading-strategy-options-production.up.railway.app/callback`
- **Root callback interception**: `/?code=` redirected to `/callback` for Schwab compatibility
- **Token management**: Auto-refresh on server start, `schwab_tokens.json` persistence
- **Cloud credentials**: From `SCHWAB_APP_KEY` / `SCHWAB_APP_SECRET` env vars
- **Local credentials**: From `schwab_config.json` file

## Task Management
- **vibe-kanban**: For complex, multi-step projects, use `npx vibe-kanban` to create and manage a kanban board for tracking tasks
- Launch the board: `npx vibe-kanban` (opens in browser)
- Use the MCP server mode or CLI to create/update tasks programmatically
- Use this whenever a task has 5+ steps, multiple files changing, or spans multiple sessions

## Design Decisions
- No disclaimers (personal use only)
- Aggressive, high-probability plays displayed
- Dark theme with CSS custom properties
- Responsive layout with CSS Grid and Flexbox
- Multi-source fallback for reliability (Yahoo → Finnhub → Twelve → Alpha Vantage)
- Server-side API proxying to avoid CORS and protect API keys
- Server-side caching for rate-limited APIs (Polygon 5-min, Alpha Vantage 10-min)
- Password protection with cookie-based sessions (cloud only)
- Environment-aware: auto-detects cloud vs local, adjusts SSL/port/auth accordingly
