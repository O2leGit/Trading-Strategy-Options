# Options Strategy Command Center

## Project Overview
Single-page options trading dashboard (`index.html`) — dark-themed, no frameworks, pure HTML/CSS/JS with live market data.

## File Structure
- `index.html` — Entire application (~4,000+ lines). All HTML, CSS, and JS in one file.
- `.claude/launch.json` — Preview server config (port 3847, uses `serve` via node)

## To Preview
Run the `options-dashboard` preview server, or open `index.html` directly in a browser.

## Architecture
- **Tab system**: 3 groups (MARKET, STRATEGIES, TOOLS) with color-coded labels (cyan/orange/purple)
- **MARKET tabs**: Market Overview, News & Sentiment, Regime Classifier, Fundamental Screener
- **STRATEGIES tabs**: Strategy Templates, 0DTE SPX Scanner, Theta Decay Calc, Strike Probability, Pre-Market Edge, Skew Exploiter, Weekly Calendar, Earnings Crusher, EOD Theta Scalper
- **TOOLS tabs**: Position Tracker, Greeks & P/L Calculator, Risk Management, Performance Dashboard, Strategy Education, Connections
- **MARKET object**: Centralized live market data (SPX, VIX, DOW, NASDAQ, Oil, Treasury) with expected move functions
- **Best Plays engine**: Auto-scan system on each strategy tab showing Day Trade / Swing / Monthly plays
- **Black-Scholes**: Options pricing model for Greeks calculation
- **Canvas charts**: P&L visualization
- **localStorage**: Position persistence + API key storage

## Live Data Architecture

### Data Sources (Priority Order)
1. **Yahoo Finance** (primary) — via `corsproxy.io` CORS proxy, no API key needed
   - Indices: `%5EGSPC` (SPX), `%5EDJI` (Dow), `%5EIXIC` (Nasdaq), `%5EVIX`, `CL%3DF` (Oil), `%5ETNX` (10Y Treasury)
   - Sector ETFs: XLE, XLK, XLF, XLV, XLU, XLY, XLP, XLI, XLB, XLRE, IWM, QQQ
   - Endpoint: `query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=1d&interval=5m&includePrePost=true`
2. **Finnhub** (backup + news + WebSocket) — API key in localStorage (`apiKey_finnhub`)
   - REST: `finnhub.io/api/v1/quote?symbol={sym}&token={key}` (uses query param auth, avoids CORS preflight)
   - WebSocket: `wss://ws.finnhub.io?token={key}` — real-time ticks for SPY, QQQ, DIA
   - News: `finnhub.io/api/v1/news?category=general&minId=0&token={key}`
   - Note: Finnhub only has ETF data (SPY), not index data (SPX). SPY×10 ≈ SPX approximation used.
3. **Twelve Data** (tertiary backup) — API key in localStorage (`apiKey_twelve`)
   - Endpoint: `api.twelvedata.com/price?symbol={sym}&apikey={key}`

### Refresh Schedule
- **Core data** (indices, VIX): Every 60 seconds via `fetchAllMarketData()`
- **Secondary data** (sectors, news): Every 5 minutes via `fetchSecondaryData()`
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
- Connections tab: `connTable`, `connTableBody`, `connFetchCount`, `connLastUpdate`, `connWSStatus`
- Header: `dataStatus`, `dataStatusIcon`, `dataStatusText`

### Known Limitations
- **Options Chain**: Yahoo blocks v7 options endpoint through CORS proxies — shows FAIL in connection test
- **No backend**: Pure client-side, relies on CORS proxies and query-param auth to avoid preflight
- **Rate limits**: Yahoo proxy may throttle; Finnhub free tier = 60 calls/min; Twelve Data free = 800/day

## Key Functions
- `fetchAllMarketData()` — Master fetcher: Yahoo primary → Finnhub fallback → Twelve Data fallback
- `fetchYahoo(symbol)` / `fetchYahooQuotes()` — Yahoo Finance via CORS proxy
- `fetchFinnhub(symbol)` / `connectFinnhubWS()` — Finnhub REST + WebSocket
- `fetchSectorData()` / `renderSectorHeatMap()` — 12 sector ETFs via Yahoo
- `fetchMarketNews()` / `renderNews()` — Finnhub news with sentiment analysis
- `updateRegimeIndicators()` — Live regime indicators on Market Overview
- `updateRegimeClassifier()` — Live regime dashboard on Regime tab
- `updateMiscLiveRefs()` — Updates 0DTE SPX/VIX, Risk VIX references
- `updateAllDisplays()` — Master display updater called after each data fetch
- `initLiveData()` — Bootstrap: fetch all data, connect WS, start intervals
- `runConnectionTest()` — Pings all 9 data sources, shows green/red status
- `generateBestPlays(tabId)` — Dispatcher for strategy-specific play generators
- `calculateThetaDashboard()` — Theta income projections
- `calculateProbStrikes()` — Strike probability matrix
- `calculateRiskLimits()` — Position sizing and loss limits
- 9 play generators: `generateZeroDTEPlays()`, `generateThetaPlays()`, etc.

## API Keys (stored in localStorage)
- `apiKey_finnhub` — Finnhub key (configured via Connections tab → Configure button)
- `apiKey_twelve` — Twelve Data key
- `apiKey_alpha` — Alpha Vantage key (reserved, not currently used)

## Design Decisions
- No disclaimers (personal use only)
- Aggressive, high-probability plays displayed
- Dark theme with CSS custom properties
- Responsive layout with CSS Grid and Flexbox
- Multi-source fallback for reliability (Yahoo → Finnhub → Twelve Data)
