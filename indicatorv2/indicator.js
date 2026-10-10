/* =========================================================
   IT Guru – 15-Min Breakout Retest Indicator
   ---------------------------------------------------------
   Phases:
     1. RANGE       – Collect the first 15 real-time minutes
     2. BREAKOUT    – Detect candle closing outside range
     3. RETEST      – Price returns to breakout level
     4. INDECISION  – Doji / spinning-top / pin bar / inside bar
     5. CONFIRM     – Engulfing / morning-evening star / inside
                      bar breakout confirms direction
     6. TRADE       – Entry plotted with SL + TP (R:R)

   Features:
     - Audio/visual alerts on phase transitions
     - LocalStorage persistence for settings & signal log
     - Auto-reconnect with exponential backoff
     - Debounced symbol/timeframe switching
     - Signal export (CSV)
     - Signal export (PDF with chart screenshots per page)
     - Win/Loss tracking (monitors if price hit TP or SL)
     - Configurable parameters (range, tolerance, etc.)
     - Light/Dark theme toggle
     - EMA overlays (8 & 21)
     - Keyboard shortcuts
     - Auto-reset after trade for continuous scanning
     - EMA 8/21 trend filter for breakout alignment
     - Higher-timeframe trend via EMA 100 proxy
     - ATR-based tolerance for consistent retest detection
     - True swing point detection for structural SL placement
     - Breakout strength / volume proxy via candle range vs ATR
     - Trailing stop (ATR-based) and partial TP at 1:1
     - Pin bar / hammer / shooting star indecision detection
     - Inside bar indecision + mother-candle breakout confirm
     - Morning star / evening star 3-candle confirmation
     - S/R confluence check at retest level
     - False breakout invalidation
     - Confluence score (0-16) quality gauge w/ signal strength meter
     - MACD momentum filter (12/26/9)
     - Bollinger Bands squeeze detection (20/2σ)
     - ADX trend strength / volatility regime (14)
     - Stochastic oscillator momentum filter (14/3/3)
     - Body-size breakout conviction check
     - Minimum R:R gate to reject low-quality trades
     - Pure trailing stop mode (no fixed TP)
     - RSI at retest (confirms pullback has room to reverse)
     - Volume spike on breakout (filters weak/fake breakouts)
     - Session filter (London/NY/Asian/Overlap)
     - Fibonacci at retest (S/R confluence from fib levels)
     - Piercing line / dark cloud cover confirmation (from MD)
     - Dragonfly / gravestone doji detection (from MD)
     - Tweezers tops & bottoms confirmation (from MD)
     - Reset session button (clears all stats/signals/log)
     - Scalping mode (from MD: shorter range, tighter SL/TP, quick
       profits, max-candle timeout — for 1min/5min chart trading)
     - Fib Golden Zone Scalp strategy (1min micro-trend → break of
       structure → 0.5–0.618 retracement entry → swing TP)
     - Power of 3 (ICT) strategy (1H open → manipulation sweep →
       MSS with displacement/FVG → entry on retrace into FVG;
       partial TP at 1R + SL → breakeven, let rest run to full TP)
     - Liquidity Sweep fixed 2:1 R:R (per strategy spec)
     - London Sweep: true sweep filter (wick beyond Asian range but
       close back inside = liquidity grab; ignores clean breakouts)
     - NY Open Range: WIN/LOSS outcome monitoring with running tally
   ========================================================= */

"use strict";

/* ================= CONFIG ================= */
let APP_ID  = 120128;

/** Public market-data endpoint — no API token required (charts, indicators, analysis).
 *  This is the same Deriv API WebSocket endpoint used for authenticated trading;
 *  no auth token is sent on it, so it is safe to use for public market data. */
let PUBLIC_WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

/** Authenticated trading endpoint — used only for authorize / buy / sell / balance. */
let AUTH_WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

/** Legacy alias — always points to the public feed. */
let WS_URL = PUBLIC_WS_URL;

/** Rebuild AUTH_WS_URL/PUBLIC_WS_URL after APP_ID changes (WS_URL stays on the public feed). */
function updateWsUrl() {
  PUBLIC_WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
  AUTH_WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
  WS_URL = PUBLIC_WS_URL;
}

/** Safely parse a JSON response, returning {} on empty/invalid body */
async function safeJson(resp) {
  const text = await resp.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return {}; }
}

const DERIV_TOKEN_KEY = "deriv_token";
const STREAM_MODE_KEY = "itguru_indicator_streamMode";
const NOTIF_ICON = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><text y='32' font-size='32'>📊</text></svg>";

/* Tuning defaults (user-configurable via UI) */
let RANGE_MINUTES             = 15;
let MAX_CANDLE_HISTORY        = 200;
let LEVEL_TOUCH_TOLERANCE     = 0.15;
let DOJI_BODY_RATIO           = 0.2;
let SPINNING_TOP_BODY_RATIO   = 0.35;
let SWING_LOOKBACK_PERIOD     = 35;  /* widened from 20 — gives trades more breathing room */
const CHART_PRICE_PADDING     = 0.08;

/* EMA periods */
const EMA_FAST_PERIOD = 8;
const EMA_SLOW_PERIOD = 21;
const HTF_EMA_PERIOD  = 100;  /* long EMA on current TF as HTF trend proxy */
const MTF_EMA_PERIOD  = 200;  /* long EMA on current TF as structural trend proxy (MTF approximation) */

/* ATR */
const ATR_PERIOD = 14;

/* True swing detection: bars on each side to confirm a pivot */
const SWING_NEIGHBOR_BARS = 3;

/* Trailing stop distance in ATR multiples */
const TRAILING_STOP_ATR_MULT = 1.3;  /* tightened from 1.5 — lock in profits sooner */

/* Tesla 3–6–9 Scaling Model: profit target R multiples and breakeven triggers */
const TESLA_T1_R = 3;  /* first partial exit target */
const TESLA_T2_R = 6;  /* second partial exit target */
const TESLA_T3_R = 9;  /* final target / runner exit */
const TESLA_CONSERVATIVE_BE_TRIGGER = 1;  /* slide SL to BE when price reaches +1R */
const TESLA_AGGRESSIVE_BE_TRIGGER   = 2;  /* slide SL to BE when price reaches +2R */

/* Pin bar: tail must be at least this multiple of body */
const PIN_BAR_TAIL_RATIO = 2.0;
/* Pin bar: the rejection wick must be this much larger than the other wick */
const PIN_BAR_WICK_DOMINANCE = 1.5;

/* Morning/Evening star: max body-to-range ratio for the middle "star" candle */
const STAR_BODY_RATIO = 0.35;

/* Tweezers: matching highs/lows tolerance as fraction of price */
const TWEEZERS_TOLERANCE_PCT = 0.001;  /* 0.1% of price */

/* S/R confluence: ATR multiplier for tolerance, and fallback price percentage */
const SR_CONFLUENCE_ATR_MULT = 0.5;
const SR_CONFLUENCE_PRICE_PCT = 0.002;

/* False breakout: number of candles to watch for price returning inside range */
const FALSE_BREAKOUT_CANDLES = 3;

/* Profit-Direction Constraint constants */
const STOCH_CROSSOVER_BUFFER  = 20;   /* buffer zone for K/D crossover from oversold/overbought */
const VWAP_ATR_TOLERANCE      = 0.5;  /* ATR multiplier for VWAP proximity */
const VWAP_PRICE_TOLERANCE_PCT = 0.002; /* price % tolerance when ATR unavailable */
const HHHL_LOOKBACK_PERIOD    = 10;   /* candles to look back for swing structure */

/* RSI */
const RSI_PERIOD = 14;
const RSI_RETEST_BULL_MAX = 45;  /* RSI at retest should be ≤ this for BULL (require deeper pullback for room to rise) */
const RSI_RETEST_BEAR_MIN = 55;  /* RSI at retest should be ≥ this for BEAR (require stronger upward bounce during retest for room to fall) */

/* Volume spike (range-based proxy – synthetic indices have no tick volume) */
const VOLUME_SPIKE_LOOKBACK = 20;
const VOLUME_SPIKE_MULT = 1.8;   /* raised from 1.5 — require a stronger breakout candle to filter weak/fake breakouts */

/* Session filter (UTC hours) */
const SESSION_LONDON   = { start: 7, end: 16 };
const SESSION_NEW_YORK = { start: 12, end: 21 };
const SESSION_ASIAN    = { start: 0, end: 9 };

/* Fibonacci retracement levels & tolerance */
const FIB_LEVELS = [0.236, 0.382, 0.5, 0.618, 0.786];
const FIB_TOLERANCE_ATR_MULT = 0.3;

/* MACD parameters */
const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIGNAL_PERIOD = 9;

/* Bollinger Bands */
const BB_PERIOD = 20;
const BB_STD_DEV = 2.0;
const BB_SQUEEZE_THRESHOLD = 0.75;  /* bandwidth ratio below this = squeeze */

/* ADX (Average Directional Index) */
const ADX_PERIOD = 14;
const ADX_TRENDING_THRESHOLD = 25;  /* ADX ≥ 25 = trending market */
const ADX_RANGING_THRESHOLD = 20;   /* ADX < 20 = ranging */

/* Stochastic Oscillator */
const STOCH_K_PERIOD = 14;
const STOCH_D_PERIOD = 3;
const STOCH_SMOOTH = 3;
const STOCH_OVERSOLD = 20;
const STOCH_OVERBOUGHT = 80;

/* ================= FEATURE ENHANCEMENT CONSTANTS ================= */

/* Feature 10: Fibonacci extension levels beyond 1.0 */
const FIB_EXTENSIONS = [1.272, 1.414, 1.618, 2.0, 2.618];

/* Feature 2: Orderblock detection (Strategy 12) */
const ORDERBLOCK_MAX_HISTORY        = 30;
const ORDERBLOCK_COOLDOWN           = 8;
const ORDERBLOCK_MAX_SL_ATR         = 1.5;
const ORDERBLOCK_LOOKBACK           = 40;
const ORDERBLOCK_IMPULSE_LOOKBACK   = 15;   /* max candles to scan back for impulse start */
const ORDERBLOCK_IMPULSE_DOMINANCE  = 0.7;  /* fraction of impulse candles that must agree on direction */
const ORDERBLOCK_STRONG_CANDLE_RATIO = 0.5; /* fraction of impulse candles that must be "strong" */
const ORDERBLOCK_MIN_IMPULSE_ATR    = 1.5;  /* impulse total range must be ≥ this × ATR */
const ORDERBLOCK_ZONE_TOLERANCE_ATR = 0.3;  /* ATR multiple for OB zone retest tolerance */
const ORDERBLOCK_SL_BUFFER_ATR      = 0.3;  /* ATR buffer beyond OB zone for SL placement */

/* Feature 1: Backtesting engine */
const BACKTEST_DEFAULT_SPEED_MS = 200;
const BACKTEST_MIN_SPEED_MS     = 50;
const BACKTEST_MAX_SPEED_MS     = 2000;

/* Feature 15: Multi-R partial exit ladder defaults */
const MULTI_R_LADDER_DEFAULT = [
  { r: 1.0, pct: 25 },
  { r: 2.0, pct: 25 },
  { r: 3.0, pct: 50 }
];

/* Feature 11: Economic calendar */
const NEWS_CACHE_EXPIRY_MS   = 3600000;
const NEWS_PAUSE_DEFAULT_MIN = 5;

/* Feature 13: Adaptive confluence weighting */
const CONF_WEIGHT_MIN_SAMPLES = 10;

/* Auto-trade: minimum stake for Deriv contracts */
const MIN_AUTO_TRADE_STAKE = 0.37;
const MIN_LIMIT_ORDER_AMOUNT = 0.37;  /* Deriv minimum for SL/TP limit order values */
const AUTO_TRADE_MAX_CONSECUTIVE_ERRORS = 3; /* pause auto-trading after this many consecutive errors */
const DEFAULT_AUTO_TRADE_MULTIPLIER = 100;
const MAX_AUTO_TRADE_HISTORY = 100;
const DEFAULT_MAX_CONCURRENT_TRADES = 1;  /* default: 1 trade at a time per symbol */
const MAX_CONCURRENT_TRADES_LIMIT = 10;   /* hard cap to prevent runaway trades */

/* ================= PER-SYMBOL MULTIPLIER CACHE (from contracts_for API) ================= */
const symbolMultiplierCache = {};  /* { symbol: [50, 100, 150, ...] } */
let sessionStartBalance = null;    /* balance when session started — for live P/L */

/* ================= HARDCODED FALLBACK MULTIPLIERS PER SYMBOL ================= */
/* These provide an immediate, known-valid default when the contracts_for API has
   not yet responded or the WebSocket is not connected.  The API cache always takes
   precedence when available — these are the safety net so trades never fire with
   an invalid multiplier.  Values sourced from Deriv's published contract specs. */
const SYMBOL_FALLBACK_MULTIPLIERS = {
  /* --- Volatility (1s) --- */
  "1HZ10V":   [20, 50, 100, 200, 300, 500],
  "1HZ15V":   [20, 50, 100, 200, 300, 500],
  "1HZ25V":   [20, 50, 100, 200, 300, 500],
  "1HZ30V":   [20, 50, 100, 200, 300, 500],
  "1HZ50V":   [20, 50, 100, 200, 300, 500],
  "1HZ75V":   [50, 100, 200, 300, 500],
  "1HZ90V":   [50, 100, 200, 300, 500],
  "1HZ100V":  [50, 100, 200, 300, 500],
  "1HZ150V":  [50, 100, 200, 300, 500],
  "1HZ200V":  [50, 100, 200, 300, 500],
  "1HZ250V":  [50, 100, 200, 300, 500],
  "1HZ300V":  [50, 100, 200, 300, 500],

  /* NOTE: R_10–R_100 removed — deprecated by Deriv API (use 1HZ equivalents) */

  /* --- Boom Indices --- */
  "BOOM300N": [50, 100, 200, 300, 500],
  "BOOM500":  [50, 100, 200, 300, 500],
  "BOOM600":  [50, 100, 200, 300, 500],
  "BOOM900":  [50, 100, 200, 300, 500],
  "BOOM1000": [50, 100, 200, 300, 500],

  /* --- Crash Indices --- */
  "CRASH300N": [50, 100, 200, 300, 500],
  "CRASH500": [50, 100, 200, 300, 500],
  "CRASH600": [50, 100, 200, 300, 500],
  "CRASH900": [50, 100, 200, 300, 500],
  "CRASH1000": [50, 100, 200, 300, 500],

  /* --- Jump Indices --- */
  "JD10":     [50, 100, 200, 300, 500],
  "JD25":     [50, 100, 200, 300, 500],
  "JD50":     [50, 100, 200, 300, 500],
  "JD75":     [50, 100, 200, 300, 500],
  "JD100":    [50, 100, 200, 300, 500],

  /* --- Step Indices (stpRNG = Step Index 100 … stpRNG5 = Step Index 500) --- */
  "stpRNG":  [50, 100, 200, 300, 500],
  "stpRNG2": [50, 100, 200, 300, 500],
  "stpRNG3": [50, 100, 200, 300, 500],
  "stpRNG4": [50, 100, 200, 300, 500],
  "stpRNG5": [50, 100, 200, 300, 500],

  /* --- Daily Reset Indices --- */
  "RDBULL":   [50, 100, 200, 300, 500],
  "RDBEAR":   [50, 100, 200, 300, 500],

  /* --- DEX Indices --- */
  "DEX600DN": [50, 100, 200, 300, 500],
  "DEX600UP": [50, 100, 200, 300, 500],
  "DEX900DN": [50, 100, 200, 300, 500],
  "DEX900UP": [50, 100, 200, 300, 500],
  "DEX1500DN": [50, 100, 200, 300, 500],
  "DEX1500UP": [50, 100, 200, 300, 500],

  /* --- Drift Switch Indices --- */
  "DSI10":    [50, 100, 200, 300, 500],
  "DSI20":    [50, 100, 200, 300, 500],
  "DSI30":    [50, 100, 200, 300, 500],

  /* --- Forex Majors --- */
  "frxEURUSD":[50, 100, 200, 300, 500],
  "frxGBPUSD":[50, 100, 200, 300, 500],
  "frxUSDJPY":[50, 100, 200, 300, 500],
  "frxUSDCHF":[50, 100, 200, 300, 500],
  "frxAUDUSD":[50, 100, 200, 300, 500],
  "frxUSDCAD":[50, 100, 200, 300, 500],
  "frxNZDUSD":[50, 100, 200, 300, 500],

  /* --- Forex Crosses --- */
  "frxEURGBP":[50, 100, 200, 300, 500],
  "frxEURJPY":[50, 100, 200, 300, 500],
  "frxEURAUD":[50, 100, 200, 300, 500],
  "frxEURCAD":[50, 100, 200, 300, 500],
  "frxEURCHF":[50, 100, 200, 300, 500],
  "frxEURNZD":[50, 100, 200, 300, 500],
  "frxGBPJPY":[50, 100, 200, 300, 500],
  "frxGBPAUD":[50, 100, 200, 300, 500],
  "frxGBPCAD":[50, 100, 200, 300, 500],
  "frxGBPCHF":[50, 100, 200, 300, 500],
  "frxGBPNZD":[50, 100, 200, 300, 500],
  "frxAUDJPY":[50, 100, 200, 300, 500],
  "frxAUDNZD":[50, 100, 200, 300, 500],
  "frxAUDCAD":[50, 100, 200, 300, 500],
  "frxAUDCHF":[50, 100, 200, 300, 500],
  "frxNZDJPY":[50, 100, 200, 300, 500],
  "frxNZDCAD":[50, 100, 200, 300, 500],
  "frxNZDCHF":[50, 100, 200, 300, 500],
  "frxCADJPY":[50, 100, 200, 300, 500],
  "frxCADCHF":[50, 100, 200, 300, 500],
  "frxCHFJPY":[50, 100, 200, 300, 500],

  /* --- Forex Exotics --- */
  "frxUSDMXN":[50, 100, 200, 300, 500],
  "frxUSDNOK":[50, 100, 200, 300, 500],
  "frxUSDSEK":[50, 100, 200, 300, 500],
  "frxUSDSGD":[50, 100, 200, 300, 500],
  "frxUSDZAR":[50, 100, 200, 300, 500],
  "frxUSDPLN":[50, 100, 200, 300, 500],
  "frxUSDTRY":[50, 100, 200, 300, 500],
  "frxUSDHKD":[50, 100, 200, 300, 500],

  /* --- Commodities --- */
  "frxXAUUSD":[50, 100, 200, 300, 500],
  "frxXAGUSD":[50, 100, 200, 300, 500],
  "frxXPTUSD":[50, 100, 200, 300, 500],
  "frxXPDUSD":[50, 100, 200, 300, 500],
  "XAUUSDmicro":[50, 100, 200, 300, 500],
  "XAUUSD.s":  [50, 100, 200, 300, 500]
};

/**
 * Return valid multiplier list for a symbol: API cache first, then hardcoded fallback.
 */
function getValidMultipliersForSymbol(sym) {
  if (symbolMultiplierCache[sym] && symbolMultiplierCache[sym].length > 0) {
    return symbolMultiplierCache[sym];
  }
  return SYMBOL_FALLBACK_MULTIPLIERS[sym] || null;
}

/**
 * Return the recommended (first/default) multiplier for a symbol.
 * Uses cached API data when available, otherwise the hardcoded fallback.
 * Falls back to DEFAULT_AUTO_TRADE_MULTIPLIER if the symbol is unknown.
 */
function getRecommendedMultiplier(sym) {
  const valid = getValidMultipliersForSymbol(sym);
  if (valid && valid.length > 0) {
    /* Pick 100 if it's in the list, otherwise the first entry */
    if (valid.includes(DEFAULT_AUTO_TRADE_MULTIPLIER)) return DEFAULT_AUTO_TRADE_MULTIPLIER;
    return valid[0];
  }
  return DEFAULT_AUTO_TRADE_MULTIPLIER;
}

/* Scalping mode (from TRENDLINE_TRADING_STRATEGY.md: "Use 15min or 5min as your
   larger timeframe when scalping 1min or 5min charts" / "5-10 pip profits") */
const SCALP_RANGE_MINUTES       = 5;     /* shorter opening range for quick setups */
const SCALP_TRAILING_ATR_MULT   = 0.75;  /* tighter trailing stop (half the normal 1.5×) */
const SCALP_RR_TARGET           = 1.0;   /* quick 1:1 R:R target instead of larger swings */
const SCALP_LOOKBACK            = 10;    /* tighter swing lookback for closer SL */
const SCALP_MAX_CANDLES         = 15;    /* auto-timeout: close trade monitoring after N candles */

/* Telegram */
const CHART_RENDER_DELAY_MS       = 500;   /* wait for canvas redraw before screenshot */
const TELEGRAM_SCREENSHOT_TIMEOUT_MS = 1200; /* fall back to text quickly if screenshot is slow */
const TELEGRAM_PROXY_URL          = "../api/telegram/proxy";   /* server-side proxy to bypass CORS */
const TELEGRAM_STATUS_CLEAR_MS    = 5000;  /* auto-clear status message */
const TELEGRAM_EXPORT_WIDTH       = 1920;  /* high-res export width for Telegram screenshots */
const TELEGRAM_EXPORT_HEIGHT      = 1080;  /* high-res export height for Telegram screenshots */

/* Profiles API */
const PROFILES_API_URL            = "../api/profiles";         /* server-side profiles endpoint */
const TIMEFRAME_LABELS = { "60":"1m","120":"2m","180":"3m","300":"5m","600":"10m","900":"15m","1800":"30m","3600":"1h","7200":"2h","14400":"4h","28800":"8h","86400":"1d" };

/* ================= SYMBOL SPECIFICATIONS (pip size / contract size / pip value) ================= */
/**
 * Accurate per-symbol data for lot-size & risk calculations.
 *   type          – "forex" | "commodity" | "synthetic"
 *   pipSize       – smallest meaningful price increment (1 pip)
 *   contractSize  – units per standard lot (forex = 100 000, gold = 100 oz …)
 *   quoteCur      – ISO quote currency (used to determine if pip value is fixed)
 *
 * For forex pairs quoted in USD the pip value per standard lot is a fixed $10.
 * For other quote currencies the pip value is calculated dynamically from
 * the current price: pipValue = contractSize × pipSize / currentPrice.
 *
 * Synthetic indices (Volatility, Boom, Crash, Jump, Step, DEX, DriftSwitch,
 * DailyReset) use the Deriv MT5 server — lot size applies.
 *   contractSize = 1 for most synthetics (PnL = priceMove × lots × contractSize).
 *   lotSize = dollarRisk / (|entry − SL| × contractSize).
 */
const SYMBOL_SPECS = (() => {
  const s = {};

  /* Helper – define a forex / commodity symbol */
  function fx(sym, quoteCur, pipSz, contractSz) {
    s[sym] = { type: "forex", pipSize: pipSz, contractSize: contractSz, quoteCur };
  }

  /* ---------- Forex Majors ---------- */
  fx("frxEURUSD", "USD", 0.0001, 100000);
  fx("frxGBPUSD", "USD", 0.0001, 100000);
  fx("frxAUDUSD", "USD", 0.0001, 100000);
  fx("frxNZDUSD", "USD", 0.0001, 100000);
  fx("frxUSDJPY", "JPY", 0.01,   100000);
  fx("frxUSDCAD", "CAD", 0.0001, 100000);
  fx("frxUSDCHF", "CHF", 0.0001, 100000);

  /* ---------- Forex Crosses ---------- */
  fx("frxEURGBP", "GBP", 0.0001, 100000);
  fx("frxEURJPY", "JPY", 0.01,   100000);
  fx("frxEURAUD", "AUD", 0.0001, 100000);
  fx("frxEURCAD", "CAD", 0.0001, 100000);
  fx("frxEURCHF", "CHF", 0.0001, 100000);
  fx("frxEURNZD", "NZD", 0.0001, 100000);
  fx("frxGBPJPY", "JPY", 0.01,   100000);
  fx("frxGBPAUD", "AUD", 0.0001, 100000);
  fx("frxGBPCAD", "CAD", 0.0001, 100000);
  fx("frxGBPCHF", "CHF", 0.0001, 100000);
  fx("frxGBPNZD", "NZD", 0.0001, 100000);
  fx("frxAUDJPY", "JPY", 0.01,   100000);
  fx("frxAUDNZD", "NZD", 0.0001, 100000);
  fx("frxAUDCAD", "CAD", 0.0001, 100000);
  fx("frxAUDCHF", "CHF", 0.0001, 100000);
  fx("frxNZDJPY", "JPY", 0.01,   100000);
  fx("frxNZDCAD", "CAD", 0.0001, 100000);
  fx("frxNZDCHF", "CHF", 0.0001, 100000);
  fx("frxCADJPY", "JPY", 0.01,   100000);
  fx("frxCADCHF", "CHF", 0.0001, 100000);
  fx("frxCHFJPY", "JPY", 0.01,   100000);

  /* ---------- Forex Exotics ---------- */
  fx("frxUSDMXN", "MXN", 0.0001, 100000);
  fx("frxUSDNOK", "NOK", 0.0001, 100000);
  fx("frxUSDSEK", "SEK", 0.0001, 100000);
  fx("frxUSDSGD", "SGD", 0.0001, 100000);
  fx("frxUSDZAR", "ZAR", 0.0001, 100000);
  fx("frxUSDPLN", "PLN", 0.0001, 100000);
  fx("frxUSDTRY", "TRY", 0.0001, 100000);
  fx("frxUSDHKD", "HKD", 0.0001, 100000);

  /* ---------- Commodities ---------- */
  fx("frxXAUUSD", "USD", 0.01,   100);    /* Gold:          100 oz / lot, pip = $0.01 */
  fx("frxXAGUSD", "USD", 0.001,  5000);   /* Silver:       5000 oz / lot, pip = $0.001 */
  fx("frxXPTUSD", "USD", 0.01,   100);    /* Platinum:      100 oz / lot */
  fx("frxXPDUSD", "USD", 0.01,   100);    /* Palladium:     100 oz / lot */
  fx("XAUUSDmicro","USD", 0.01,   10);    /* Gold Micro:     10 oz / lot, pip = $0.01 */
  fx("XAUUSD.s",  "USD", 0.01,   100);    /* Gold Spot:     100 oz / lot, pip = $0.01 */

  /* ---------- Synthetics (Deriv MT5 — lot-size applies, contractSize = 1) --- */
  const syntheticSymbols = [
    "1HZ10V","1HZ15V","1HZ25V","1HZ30V","1HZ50V","1HZ75V","1HZ90V",
    "1HZ100V","1HZ150V","1HZ200V","1HZ250V","1HZ300V",
    /* NOTE: R_10–R_100 removed — deprecated by Deriv API */
    "BOOM300N","BOOM500","BOOM600","BOOM900","BOOM1000",
    "CRASH300N","CRASH500","CRASH600","CRASH900","CRASH1000",
    "JD10","JD25","JD50","JD75","JD100",
    "stpRNG","stpRNG2","stpRNG3","stpRNG4","stpRNG5",
    "RDBULL","RDBEAR",
    "DEX600DN","DEX600UP","DEX900DN","DEX900UP","DEX1500DN","DEX1500UP",
    "DSI10","DSI20","DSI30"
  ];
  syntheticSymbols.forEach(sym => { s[sym] = { type: "synthetic", contractSize: 1 }; });

  return s;
})();

/* ================= DEPRECATED SYMBOL MIGRATION ================= */
/**
 * Map deprecated/incorrect Deriv API symbol codes to their current equivalents.
 * Used to auto-migrate symbols persisted in localStorage from older versions.
 *
 * NOTE: "STPIDX", "STPIDX100"–"STPIDX500" were invented by this app and are
 * NOT valid Deriv WebSocket symbols. The real Deriv Step Index codes are
 * stpRNG (Step Index 100) through stpRNG5 (Step Index 500).
 */
const DEPRECATED_SYMBOL_MAP = {
  "R_10":    "1HZ10V",
  "R_25":    "1HZ25V",
  "R_50":    "1HZ50V",
  "R_75":    "1HZ75V",
  "R_100":   "1HZ100V",
  "STPIDX":    "stpRNG",
  "STPIDX100": "stpRNG",
  "STPIDX200": "stpRNG2",
  "STPIDX300": "stpRNG3",
  "STPIDX400": "stpRNG4",
  "STPIDX500": "stpRNG5"
};

function migrateSymbol(sym) {
  if (!sym || typeof sym !== "string") return sym;
  return DEPRECATED_SYMBOL_MAP[sym] || sym;
}

const STEP_INDEX_LABELS = {
  "stpRNG":  "Step Index 100",
  "stpRNG2": "Step Index 200",
  "stpRNG3": "Step Index 300",
  "stpRNG4": "Step Index 400",
  "stpRNG5": "Step Index 500"
};

/**
 * Resolve the symbol to request from the Deriv feed: migrate any deprecated
 * or invented code to the canonical Deriv code. Returns the canonical symbol.
 */
function resolveFeedSymbol(sym) {
  const resolved = migrateSymbol(sym);
  if (resolved !== sym) {
    addLog(`🔀 Symbol migration: "${sym}" → "${resolved}" (Deriv canonical code)`);
  }
  return resolved;
}

/* ================= CREDENTIAL ENCRYPTION ================= */
/**
 * XOR-based obfuscation for credentials stored in localStorage.
 * NOT military-grade crypto – but prevents plain-text token exposure in
 * DevTools → Application → Local Storage which is the main risk vector
 * for a client-side-only app.  Uses a per-install random salt stored
 * alongside settings so each browser profile gets a unique key.
 */
const _CRED_VERSION = "v1:";
function _getCredSalt() {
  const key = "itguru_cred_salt";
  let salt = localStorage.getItem(key);
  if (!salt) {
    const arr = new Uint8Array(24);
    crypto.getRandomValues(arr);
    salt = Array.from(arr, b => b.toString(36).padStart(2, "0")).join("");
    localStorage.setItem(key, salt);
  }
  return salt;
}
function _obfuscate(plain) {
  if (!plain) return "";
  const key = _getCredSalt();
  let out = "";
  for (let i = 0; i < plain.length; i++) {
    out += String.fromCharCode(plain.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return _CRED_VERSION + btoa(out);          /* Prefix with version marker */
}
function _deobfuscate(encoded) {
  if (!encoded) return "";
  try {
    /* Strip version prefix if present */
    const payload = encoded.startsWith(_CRED_VERSION) ? encoded.slice(_CRED_VERSION.length) : encoded;
    /* If no version prefix, treat as legacy plain-text */
    if (!encoded.startsWith(_CRED_VERSION)) return encoded;
    const xored = atob(payload);
    const key = _getCredSalt();
    let out = "";
    for (let i = 0; i < xored.length; i++) {
      out += String.fromCharCode(xored.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return out;
  } catch { return ""; }
}

/* Multi-panel context tracking (used throughout for context-aware processing) */
let _multiPanelProcessing = null;  /* null = normal mode, otherwise the panel's symbol */
let focusedPanelSymbol = null;     /* which multi-panel drives the main view */
let _historicalProcessing = false; /* true during processAllCandles() to suppress live-only actions */

/* ================= MARKET TYPE DETECTION & TUNING ================= */
/**
 * Market types supported:
 *   "volatility"  – standard/1s volatility indices (R_xx, 1HZxxV)
 *   "boom"        – Boom indices (spike UP direction)
 *   "crash"       – Crash indices (spike DOWN direction)
 *   "jump"        – Jump indices (sudden jumps in either direction)
 *   "step"        – Step Index (fixed-increment moves)
 *   "dailyreset"  – Daily Reset indices (Bull/Bear market trends)
 *   "dex"         – DEX indices (news-event spike simulation)
 *   "driftswitch" – Drift Switch indices (regime-switching trends)
 *   "forex"       – Forex pairs
 *   "commodity"   – Gold/Silver/Platinum/Palladium
 */
function getMarketType(symbol) {
  if (!symbol) symbol = _multiPanelProcessing || (UI.symbolSelect ? UI.symbolSelect.value : "");
  if (/^BOOM/i.test(symbol))  return "boom";
  if (/^CRASH/i.test(symbol)) return "crash";
  if (/^JD/i.test(symbol))    return "jump";
  if (/^stpRNG\d*$/i.test(symbol) || /^STPIDX/i.test(symbol)) return "step";
  if (/^(RDBULL|RDBEAR)/i.test(symbol)) return "dailyreset";
  if (/^DEX/i.test(symbol))   return "dex";
  if (/^DSI/i.test(symbol))   return "driftswitch";
  if (/^1HZ/i.test(symbol) || /^R_/i.test(symbol)) return "volatility";
  if (/^XAUUSD/i.test(symbol))  return "commodity";   /* XAUUSDmicro, XAUUSD.s */
  if (/^frxX/i.test(symbol))    return "commodity";
  if (/^frx/i.test(symbol))     return "forex";
  return "volatility";
}

/**
 * Spike detection for Boom/Crash indices.
 * Boom indices produce large upward spikes; Crash produce downward spikes.
 * A spike candle has a range ≥ SPIKE_RANGE_MULT × ATR and the body is strongly
 * directional (body ≥ 70% of range in the expected direction).
 */
const SPIKE_RANGE_MULT = 2.0;
const SPIKE_BODY_PCT   = 0.70;

function isSpikeCandle(candle, expectedDir) {
  if (atrValue <= 0) return false;
  const range = candle.high - candle.low;
  if (range < atrValue * SPIKE_RANGE_MULT) return false;
  const body = candle.close - candle.open;
  const absBody = Math.abs(body);
  if (absBody < range * SPIKE_BODY_PCT) return false;
  if (expectedDir === "BULL") return body > 0;
  if (expectedDir === "BEAR") return body < 0;
  return true;
}

/**
 * Jump detection for Jump indices.
 * Jumps are sudden price discontinuities — a candle whose open differs from
 * the previous close by ≥ JUMP_GAP_ATR_MULT × ATR, or whose range is
 * extremely large relative to recent candles.
 */
const JUMP_GAP_ATR_MULT   = 1.0;
const JUMP_RANGE_ATR_MULT = 2.5;

function isJumpCandle(idx) {
  if (idx < 1 || idx >= candles.length || atrValue <= 0) return false;
  const c = candles[idx];
  const prev = candles[idx - 1];
  const gap = Math.abs(c.open - prev.close);
  if (gap >= atrValue * JUMP_GAP_ATR_MULT) return true;
  const range = c.high - c.low;
  return range >= atrValue * JUMP_RANGE_ATR_MULT;
}

/**
 * Step Index strategy helpers.
 * Step Index moves in fixed increments, so we look for consecutive steps
 * in the same direction (momentum runs) and mean-reversion after extended runs.
 * Returns the run length (positive = up steps, negative = down steps).
 */
const STEP_RUN_THRESHOLD = 5;   /* consecutive steps to confirm a trend */
const STEP_REVERSAL_BARS = 3;   /* bars of reversal to confirm mean reversion */

function getStepRunLength() {
  if (candles.length < 3) return 0;
  let run = 0;
  for (let i = candles.length - 1; i >= 1; i--) {
    const dir = candles[i].close - candles[i - 1].close;
    if (dir > 0) {
      if (run < 0) break;
      run++;
    } else if (dir < 0) {
      if (run > 0) break;
      run--;
    } else {
      break;
    }
  }
  return run;
}

/**
 * Returns market-type-specific tuning overrides.
 * These affect breakout conviction, tolerance, and trade management.
 */
function getMarketTuning() {
  const mtype = getMarketType();
  switch (mtype) {
    case "boom":
      return {
        /* Boom: directional spikes UP — look for bullish breakouts primarily */
        preferredDir: "BULL",
        breakoutConvictionMult: 0.6,    /* lower conviction threshold (spikes are erratic) */
        volumeSpikeMult: 2.0,           /* require stronger volume spike */
        retestToleranceMult: 0.7,       /* tighter retest (price retraces quickly) */
        trailingATRMult: 2.0,           /* wider trailing for spike momentum */
        rangeDurationMult: 1.0,
        spikeAware: true,
        label: "Boom"
      };
    case "crash":
      return {
        /* Crash: directional spikes DOWN — look for bearish breakouts primarily */
        preferredDir: "BEAR",
        breakoutConvictionMult: 0.6,
        volumeSpikeMult: 2.0,
        retestToleranceMult: 0.7,
        trailingATRMult: 2.0,
        rangeDurationMult: 1.0,
        spikeAware: true,
        label: "Crash"
      };
    case "jump":
      return {
        /* Jump: sudden both-direction jumps — widen tolerance, quick entries */
        preferredDir: null,
        breakoutConvictionMult: 0.5,    /* jumps are instant, body may not fill range */
        volumeSpikeMult: 1.2,           /* lower bar for volume (jumps are inherently volatile) */
        retestToleranceMult: 1.2,       /* wider retest tolerance for gap fills */
        trailingATRMult: 2.5,           /* wider trailing to survive jump volatility */
        rangeDurationMult: 0.67,        /* shorter opening range (10 min for jumps) */
        spikeAware: false,
        label: "Jump"
      };
    case "step":
      return {
        /* Step: fixed increments — tight tolerances, momentum runs */
        preferredDir: null,
        breakoutConvictionMult: 0.4,    /* small bodies are normal */
        volumeSpikeMult: 1.0,           /* volume spike not meaningful */
        retestToleranceMult: 0.5,       /* very tight retest (precise levels) */
        trailingATRMult: 1.0,           /* tight trailing for small moves */
        rangeDurationMult: 1.5,         /* longer range to capture structure */
        spikeAware: false,
        label: "Step"
      };
    case "dailyreset":
      return {
        /* Daily Reset: one-directional daily trends that reset — follow the trend */
        preferredDir: null,
        breakoutConvictionMult: 1.2,    /* require stronger conviction (many false breaks) */
        volumeSpikeMult: 1.5,           /* moderate volume filter for real breakouts */
        retestToleranceMult: 0.8,       /* moderately tight retest */
        trailingATRMult: 1.5,           /* standard trailing */
        rangeDurationMult: 1.5,         /* longer range to capture structure */
        spikeAware: false,
        label: "Daily Reset"
      };
    case "dex":
      return {
        /* DEX: news-event spike simulation — spike-aware like Boom/Crash */
        preferredDir: null,             /* UP/DN variant determines direction in strategy */
        breakoutConvictionMult: 0.7,    /* spikes produce erratic candles */
        volumeSpikeMult: 1.8,           /* strong volume filter for genuine spikes */
        retestToleranceMult: 0.8,       /* tighter retest (fast-moving) */
        trailingATRMult: 2.0,           /* wider trailing for spike momentum */
        rangeDurationMult: 1.0,
        spikeAware: true,
        label: "DEX"
      };
    case "driftswitch":
      return {
        /* Drift Switch: regime-switching trends — follow the current regime */
        preferredDir: null,
        breakoutConvictionMult: 0.8,    /* trends are smooth within regime */
        volumeSpikeMult: 1.0,           /* volume not as meaningful */
        retestToleranceMult: 1.0,       /* standard retest */
        trailingATRMult: 1.5,           /* standard trailing */
        rangeDurationMult: 1.0,
        spikeAware: false,
        label: "Drift Switch"
      };
    default:
      return {
        preferredDir: null,
        breakoutConvictionMult: 1.0,
        volumeSpikeMult: 1.0,
        retestToleranceMult: 1.0,
        trailingATRMult: 1.0,
        rangeDurationMult: 1.0,
        spikeAware: false,
        label: mtype.charAt(0).toUpperCase() + mtype.slice(1)
      };
  }
}

/* ================= PROFIT-OPTIMIZED STRATEGY PARAMETERS (per symbol type) ================= */
/**
 * Returns profit-optimized strategy parameters for Volatility 1s and Standard indices.
 * Other symbols get default (unmodified) values so existing behaviour is preserved.
 *
 * @param {string} [symbol] – symbol string; defaults to active symbol
 */
function getStrategyProfitParams(symbol) {
  if (!symbol) symbol = _multiPanelProcessing || (UI.symbolSelect ? UI.symbolSelect.value : "");
  const isVol1s  = /^1HZ/i.test(symbol);
  const isVolStd = /^R_/i.test(symbol); /* legacy — R_ symbols deprecated by Deriv API */

  if (isVol1s) {
    return {
      rrLiquiditySweep: 2.5,
      rrStopLossHunt:   2.5,
      rrFailedPinBar:   2.0,
      rrGridScalperMA:  2.5,
      rrFVGFallback:    2.5,
      rrPO3Fallback:    2.5,
      rrMTFMin:         2.5,
      slBufferMult:     0.8,
      trailingMult:     1.8,
      cooldownReduction: 0.5,
      minImpulseATR:    1.2
    };
  }

  if (isVolStd) {
    return {
      rrLiquiditySweep: 2.5,
      rrStopLossHunt:   2.5,
      rrFailedPinBar:   2.0,
      rrGridScalperMA:  2.5,
      rrFVGFallback:    2.5,
      rrPO3Fallback:    2.5,
      rrMTFMin:         2.5,
      slBufferMult:     0.9,
      trailingMult:     1.7,
      cooldownReduction: 0.7,
      minImpulseATR:    1.3
    };
  }

  /* All other symbols: default (unchanged) behaviour */
  return {
    rrLiquiditySweep: 2.0,
    rrStopLossHunt:   2.0,
    rrFailedPinBar:   1.5,
    rrGridScalperMA:  2.0,
    rrFVGFallback:    2.0,
    rrPO3Fallback:    2.0,
    rrMTFMin:         2.0,
    slBufferMult:     1.0,
    trailingMult:     1.0,
    cooldownReduction: 1.0,
    minImpulseATR:    1.5
  };
}

/* Auto-reconnect */
const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY  = 30000;
const MAX_RECONNECT_ATTEMPTS = 50;
let reconnectAttempts = 0;
let reconnectTimer    = null;
let intentionalClose  = false;

/* Toast notification durations */
const TOAST_WARNING_DURATION_MS = 4000;
const TOAST_ERROR_DURATION_MS = 10000;

/* Ping/keepalive (Deriv WS sessions time out after inactivity) */
const PING_INTERVAL_MS = 30000;
let pingTimer = null;

/* Stream watchdog – force-close stale connections if no OHLC/candle data arrives */
const STREAM_WATCHDOG_TIMEOUT_MS = 120000; /* 2 minutes */
let streamWatchdogTimer = null;

/* Debounce */
let reconnectDebounceTimer = null;
const RECONNECT_DEBOUNCE_MS = 400;

/* Chart redraw optimization */
let chartRedrawTimer = null;
const CHART_REDRAW_DEBOUNCE_MS = 16; /* ~60fps */
let chartRedrawPending = false;

/* API rate limiting */
const apiCallTimestamps = new Map(); /* endpoint -> array of timestamps */
const API_RATE_LIMIT_WINDOW_MS = 60000; /* 1 minute window */
const API_RATE_LIMIT_MAX_CALLS = 120; /* max calls per window */

/**
 * Check if an API call is allowed based on rate limiting.
 * @param {string} endpoint - The API endpoint identifier (e.g., "telegram", "contracts_for")
 * @returns {boolean} - True if the call is allowed, false if rate limited
 */
function getApiRateLimitWaitMs(endpoint) {
  const now = Date.now();
  if (!apiCallTimestamps.has(endpoint)) {
    apiCallTimestamps.set(endpoint, []);
  }
  
  const timestamps = apiCallTimestamps.get(endpoint);
  
  /* Remove timestamps outside the window */
  const validTimestamps = timestamps.filter(t => now - t < API_RATE_LIMIT_WINDOW_MS);
  apiCallTimestamps.set(endpoint, validTimestamps);
  
  /* Check if we've exceeded the limit */
  if (validTimestamps.length >= API_RATE_LIMIT_MAX_CALLS) {
    const oldestCall = validTimestamps[0];
    return Math.max(1, API_RATE_LIMIT_WINDOW_MS - (now - oldestCall));
  }
  
  /* Record this call */
  validTimestamps.push(now);
  return 0;
}

function isApiCallAllowed(endpoint) {
  const waitMs = getApiRateLimitWaitMs(endpoint);
  if (waitMs > 0) {
    const waitTime = Math.ceil(waitMs / 1000);
    addLog(`⚠️ Rate limit reached for ${endpoint}. Please wait ${waitTime}s.`);
    return false;
  }
  return true;
}

async function waitForApiCallSlot(endpoint, maxWaitMs = 20000) {
  const deadline = Date.now() + maxWaitMs;
  let warned = false;

  while (true) {
    const waitMs = getApiRateLimitWaitMs(endpoint);
    if (waitMs === 0) return true;
    if (!warned) {
      addLog(`⏳ ${endpoint} rate-limited, queueing send...`);
      if (endpoint === "telegram") recordTelegramDeliveryStat("queued", 1);
      warned = true;
    }
    if (Date.now() + waitMs > deadline) return false;
    await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, 1000)));
  }
}

/* ================= STATE ================= */
let authorized    = false;
let ws            = null;   /* public market-data WebSocket (charts + indicators) */
let authWs        = null;   /* authenticated WebSocket — trading actions only */
let candles       = [];
let rangeStartEpoch = null;
let openingRange  = null;
let breakout      = null;
let retestInfo    = null;
let indecisionInfo = null;
let confirmInfo   = null;
let trade         = null;
let phase         = "WAITING";

/* Win/Loss tracking */
const SIGNAL_HISTORY_MAX = 200;       /* max in-memory signal entries (oldest trimmed first) */
const BANNER_DISPLAY_MAX = 100;        /* max cards rendered in any signal/scalp/strategy banner */
let signalHistory   = [];
let signalWins      = 0;
let signalLosses    = 0;
let monitoringTrade = false;

/* EMA state */
let emaFast = [];
let emaSlow = [];
let emaHTF  = [];   /* EMA 100 for HTF trend proxy */
let emaMTF  = [];   /* EMA 200 for multi-timeframe structure */
let vwapValues = []; /* VWAP approximation (typical price rolling average) */

/* ATR state */
let atrValue  = 0;
let atrValues = [];

/* Trailing stop / partial TP state */
let trailingSL    = null;
let partialTpHit  = false;

/* Tesla 3–6–9 Scaling Model state (reset with each new trade) */
let teslaT1Hit  = false;
let teslaT2Hit  = false;
let teslaT3Hit  = false;
let teslaBEHit  = false;

/* Connection uptime */
let connectTime = null;
let uptimeInterval = null;

/* Public market feed stats (reflected in #publicFeedPanel) */
let publicFeedTickCount  = 0;
let publicFeedLastUpdate = null;  // Date or null
let autoStartFeedEnabled = true;  // overridden by API config + localStorage toggle

/* Candle countdown timer */
let candleCountdownInterval = null;

/* Sound & Notifications */
let soundEnabled = true;
let notificationsEnabled = false;

/* Global notification throttle — suppress rapid-fire browser notifications */
const NOTIFICATION_COOLDOWN_MS = 30000;   /* min 30s between browser notifications */
const NOTIFICATION_BURST_MAX   = 3;       /* max notifications allowed in one burst window */
const NOTIFICATION_BURST_WINDOW_MS = 60000; /* 60 s sliding window for burst tracking */
let _notifTimestamps = [];                /* timestamps of recent notifications */

/* Chart interaction state */
let chartMouseX = -1;
let chartMouseY = -1;
let chartMouseActive = false;

/* Theme */
let currentTheme = "dark";

/* Strategy filter toggles */
let autoResetEnabled    = true;
let emaFilterEnabled    = true;    /* EMA 8/21 trend alignment mandatory by default */
let htfFilterEnabled    = false;
let atrToleranceEnabled = false;
let trailingStopEnabled = true;
let partialTpEnabled    = true;
let falseBreakoutEnabled = true;
let minRREnabled         = true;
let pureTrailingEnabled  = false;
let minRRValue           = 2.0;    /* raised from 1.5 — require better reward per unit of risk */
let teslaScalingEnabled  = false;  /* Tesla 3–6–9 scaling level alerts */
let teslaScalingPlan     = "conservative";  /* "conservative" | "aggressive" */

/* Auto-trade: allow the indicator to place trades on Deriv when a signal fires */
let autoTradeEnabled         = false;  /* breakout-retest TRADE signals */
let autoTradeScalpEnabled    = false;  /* live scalp signals */
let autoTradeStrategyEnabled = false;  /* custom strategy signals (liquidity sweep, etc.) */
/* Per-strategy auto-trade sub-toggles (all default ON — gated behind master autoTradeStrategyEnabled) */
let autoTradeLiquiditySweep  = true;
let autoTradeStopLossHunt    = true;
let autoTradeFailedPinBar    = true;
let autoTradeFibScalp        = true;
let autoTradePo3             = true;
let autoTradeNYOpenRange     = true;
let autoTradeSessionRange    = true;
let autoTradeFvgStrat        = true;
let autoTradeStake           = 1;      /* base USD stake per trade (user-configured floor) */
let autoTradeMaxStake        = 0;      /* max USD stake cap for compounding (0 = no cap) */
let autoTradeCurrentStake    = 1;      /* live stake — compounds on consecutive wins, resets on loss */
let autoTradeWinStreak       = 0;      /* consecutive win counter (mirrors bot.js winStreak) */
let autoTradeLossCount       = 0;      /* consecutive loss counter */
let autoTradeSessionTP       = 0;      /* stop auto-trading when cumulative P/L >= this (0 = disabled) */
let autoTradeSessionSL       = 0;      /* stop auto-trading when cumulative P/L <= -this (0 = disabled) */
let autoTradeHalted          = false;  /* true when session TP/SL has been hit */
const AUTO_TRADE_STAKE_SCALE = 1.04;   /* per-win compound factor (matches bot.js STAKE_SCALE) */
const AUTO_TRADE_WIN_STREAK_MIN = 2;   /* consecutive wins required before scaling up */
const AUTO_TRADE_MAX_LOSSES  = 3;      /* consecutive losses before pausing auto-trades */
let autoTradeMultiplier      = DEFAULT_AUTO_TRADE_MULTIPLIER; /* multiplier for MULTUP/MULTDOWN */
let maxConcurrentTrades      = DEFAULT_MAX_CONCURRENT_TRADES; /* max simultaneous trades per symbol */
/* --- Per-symbol auto-trade slots ---
 * Each symbol can have multiple in-flight trades (up to maxConcurrentTrades).
 * Key = Deriv symbol string (e.g. "R_100"), value = slot object.
 * The slot tracks active trades in the `activeTrades` array. */
const autoTradeSlots = new Map();

/** Return (or create) the per-symbol auto-trade slot. */
function getAutoTradeSlot(symbol) {
  if (!autoTradeSlots.has(symbol)) {
    autoTradeSlots.set(symbol, {
      inProgress: false,
      contractId: null,
      pendingContractId: null,
      pendingTimer: null,
      consecutiveErrors: 0,
      fetchingMultiplier: false,
      activeTrades: []  /* array of { tradeId, contractId, pendingTimer, startTime } for concurrent tracking */
    });
  }
  return autoTradeSlots.get(symbol);
}

/** Check if ANY symbol has an in-flight auto-trade (for backward-compat). */
function isAnyAutoTradeInProgress() {
  for (const s of autoTradeSlots.values()) {
    if (s.inProgress) return true;
  }
  return false;
}

/** Find the slot that owns a given contract ID (searches both legacy and activeTrades). */
function findSlotByContractId(contractId) {
  if (!contractId) return null;
  const cid = String(contractId);
  for (const [sym, slot] of autoTradeSlots.entries()) {
    if (String(slot.contractId) === cid) return { symbol: sym, slot };
    /* Also search activeTrades array for concurrent trade tracking */
    const found = slot.activeTrades.find(t => String(t.contractId) === cid);
    if (found) return { symbol: sym, slot, tradeEntry: found };
  }
  return null;
}

/** Find a trade entry by tradeId within a symbol's slot. */
function findTradeByTradeId(symbol, tradeId) {
  const slot = autoTradeSlots.get(symbol);
  if (!slot || !tradeId) return null;
  return slot.activeTrades.find(t => t.tradeId === tradeId);
}

/** Remove a completed/failed trade from the activeTrades array and update inProgress. */
function removeActiveTrade(symbol, tradeId) {
  const slot = autoTradeSlots.get(symbol);
  if (!slot) return;
  const idx = slot.activeTrades.findIndex(t => t.tradeId === tradeId);
  if (idx !== -1) {
    const entry = slot.activeTrades[idx];
    if (entry.pendingTimer) {
      clearTimeout(entry.pendingTimer);
      entry.pendingTimer = null;
    }
    slot.activeTrades.splice(idx, 1);
  }
  /* Update legacy inProgress flag: true if any trades still active */
  slot.inProgress = slot.activeTrades.length > 0;
  if (!slot.inProgress) {
    slot.contractId = null;
    slot.pendingContractId = null;
  }
}

/* Legacy global aliases — retained only to avoid "not defined" errors
   in any code path that reads them (e.g. resetIndicator).  All functional
   auto-trade state is now in per-symbol slots (autoTradeSlots). */
let autoTradeInProgress        = false; /* unused shadow */
let autoTradeContractId        = null;  /* unused shadow */
let autoTradePendingContractId = null;  /* unused shadow */
let autoTradePendingTimer      = null;  /* unused shadow */
let autoTradeConsecutiveErrors = 0;     /* unused shadow */
let _autoTradeIdCounter = 0;           /* monotonically increasing counter for unique trade IDs */

let autoTradeScalpOpposite   = false;  /* reverse scalp signal direction */
let autoTradeStrategyOpposite = false; /* reverse strategy signal direction */
let autoTradeHistory         = [];     /* trade history: { time, source, type, symbol, profit, result } */
let autoTradePL              = 0;      /* cumulative P/L for auto-trades */
let autoTradeBalance         = null;   /* latest Deriv account balance */
const AUTO_TRADE_PENDING_TIMEOUT_MS = 3600000; /* 1 hour max for a pending multiplier trade */
const AUTO_TRADE_QUERY_TIMEOUT_MS   = 15000;   /* 15s grace period for one-shot status query */
const AUTO_TRADE_PROPOSAL_TIMEOUT_MS = 30000;  /* 30s max for proposal → buy to complete */

/* Account sizing */
let accountSize          = 0;     /* 0 = disabled / not entered */
let riskPercent          = 1.0;   /* default 1% risk per trade */

/* Stream Mode – hides sensitive info (App ID, token, account details) for live streaming */
let streamMode           = false;
let _lastAuthorizeAcct   = null;  /* cached so badge tooltip restores when stream mode is toggled off */

/* ---- Symbol spec helpers ---- */

/** Return the active symbol from the UI or multi-panel context. */
function getActiveSymbol() {
  return _multiPanelProcessing || (UI.symbolSelect ? UI.symbolSelect.value : "");
}

/** Look up pip / contract specs for a symbol. Falls back to sensible defaults. */
function getSymbolSpecs(symbol) {
  if (!symbol) symbol = getActiveSymbol();
  if (SYMBOL_SPECS[symbol]) return SYMBOL_SPECS[symbol];
  /* Auto-detect unknown symbols by market type */
  const mt = getMarketType(symbol);
  if (mt === "forex")     return { type: "forex", pipSize: 0.0001, contractSize: 100000, quoteCur: "USD" };
  if (mt === "commodity") return { type: "forex", pipSize: 0.01,   contractSize: 100,    quoteCur: "USD" };
  /* ↑ commodity uses type:"forex" intentionally — same lot-size math applies;
       the SYMBOL_SPECS table already covers all known commodities with accurate specs */
  return { type: "synthetic" };
}

/**
 * Fetch valid multiplier values for a symbol from the Deriv contracts_for API.
 * Caches the result so we only call once per symbol per session.
 * Returns a promise that resolves to an array of valid multiplier values (e.g. [20, 50, 100, 200]).
 */
function fetchValidMultipliers(sym) {
  if (symbolMultiplierCache[sym]) return Promise.resolve(symbolMultiplierCache[sym]);
  /* contracts_for is an authenticated API call — prefer authWs, fall back to ws */
  const apiWs = (authWs && authWs.readyState === WebSocket.OPEN) ? authWs : ws;
  if (!apiWs || apiWs.readyState !== WebSocket.OPEN) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };

    const handler = (evt) => {
      const d = JSON.parse(evt.data);
      if (d.msg_type !== "contracts_for") return;
      /* Only handle the response for our symbol */
      if (d.echo_req && d.echo_req.contracts_for !== sym) return;
      apiWs.removeEventListener("message", handler);

      if (d.error) {
        console.warn(`contracts_for (multipliers) error for ${sym}:`, d.error.message);
        done(null);
        return;
      }

      const contracts = d.contracts_for?.available ?? [];
      /* Find MULTUP / MULTDOWN contracts and extract multiplier_range */
      const multContracts = contracts.filter(c =>
        c.contract_type === "MULTUP" || c.contract_type === "MULTDOWN"
      );

      if (multContracts.length === 0) {
        console.warn(`No multiplier contracts found for ${sym}`);
        done(null);
        return;
      }

      /* Build a sorted, deduplicated list of valid multipliers across all MULT contracts */
      const validSet = new Set();
      for (const c of multContracts) {
        if (Array.isArray(c.multiplier_range)) {
          c.multiplier_range.forEach(m => validSet.add(Number(m)));
        }
      }

      const validMultipliers = Array.from(validSet).filter(m => m > 0).sort((a, b) => a - b);

      if (validMultipliers.length === 0) {
        console.warn(`No valid multipliers returned for ${sym}`);
        done(null);
        return;
      }

      symbolMultiplierCache[sym] = validMultipliers;
      console.log(`📏 Valid multipliers for ${sym}:`, validMultipliers);
      done(validMultipliers);
    };

    apiWs.addEventListener("message", handler);
    try {
      apiWs.send(JSON.stringify({ contracts_for: sym }));
    } catch (err) {
      console.warn("contracts_for (multipliers) send failed:", err);
      apiWs.removeEventListener("message", handler);
      done(null);
      return;
    }

    /* Timeout after 10 s so we don't hang forever */
    setTimeout(() => {
      ws.removeEventListener("message", handler);
      done(null);
    }, 10000);
  });
}

/**
 * Pick the best valid multiplier for a symbol.
 * Prefers the current user-selected value if it's valid;
 * otherwise picks the closest valid multiplier to the current value.
 */
function pickBestMultiplier(validMultipliers, currentValue) {
  if (!validMultipliers || validMultipliers.length === 0) return currentValue;
  /* If the current value is already valid, keep it */
  if (validMultipliers.includes(currentValue)) return currentValue;
  /* Find the closest valid multiplier */
  let best = validMultipliers[0];
  let bestDist = Math.abs(currentValue - best);
  for (const m of validMultipliers) {
    const dist = Math.abs(currentValue - m);
    if (dist < bestDist) { best = m; bestDist = dist; }
  }
  return best;
}

/**
 * Auto-update the multiplier when the symbol changes.
 *
 * Phase 1 (synchronous): immediately validate against the hardcoded
 *   fallback map so the multiplier is never left at an invalid value
 *   even if the WebSocket hasn't responded yet.
 *
 * Phase 2 (async): fetch the real multiplier list from the Deriv
 *   contracts_for API and refine the value if the API returns a
 *   different set than the fallback.
 */
function autoUpdateMultiplier(sym) {
  const current = parseInt(autoTradeMultiplier, 10) || DEFAULT_AUTO_TRADE_MULTIPLIER;

  /* Phase 1 — immediate correction from fallback / cache */
  const knownValid = getValidMultipliersForSymbol(sym);
  if (knownValid && knownValid.length > 0) {
    const best = pickBestMultiplier(knownValid, current);
    if (best !== current) {
      autoTradeMultiplier = best;
      if (UI.autoTradeMultiplier) UI.autoTradeMultiplier.value = best;
      addLog(`🔧 Multiplier auto-adjusted to ×${best} for ${sym} (valid: ${knownValid.join(", ")})`);
      saveSettings();
    } else {
      addLog(`✅ Multiplier ×${current} is valid for ${sym}`);
    }
  }

  /* Phase 2 — async API refinement (updates the cache for future trades) */
  fetchValidMultipliers(sym).then(apiValid => {
    if (!apiValid || apiValid.length === 0) return;

    const latest = parseInt(autoTradeMultiplier, 10) || DEFAULT_AUTO_TRADE_MULTIPLIER;
    const best = pickBestMultiplier(apiValid, latest);

    if (best !== latest) {
      autoTradeMultiplier = best;
      if (UI.autoTradeMultiplier) UI.autoTradeMultiplier.value = best;
      addLog(`🔧 Multiplier refined to ×${best} for ${sym} via API (valid: ${apiValid.join(", ")})`);
      saveSettings();
    }
  }).catch(() => { /* silent — multiplier refinement is best-effort */ });
}

/**
 * Pip value per 1 standard lot in USD for a given symbol.
 *
 * USD-quoted pairs   → fixed:  contractSize × pipSize  (always $10 for 100 k forex)
 * Non-USD-quoted     → dynamic: contractSize × pipSize / currentPrice
 *                      (converts quote-currency value to approximate USD via the pair's price)
 */
function getPipValuePerLot(symbol, currentPrice) {
  const sp = getSymbolSpecs(symbol);
  if (sp.type === "synthetic") return 0;            /* not applicable */
  if (sp.quoteCur === "USD") return sp.contractSize * sp.pipSize;  /* exact */
  if (!currentPrice || currentPrice <= 0) return 0; /* can't compute */
  return sp.contractSize * sp.pipSize / currentPrice;
}

/**
 * Calculate account-based position metrics from trade data.
 * Returns null if accountSize or riskPercent is not set.
 *
 * For forex / commodities:
 *   lotSize  = dollarRisk / (pipsAtRisk × pipValuePerStdLot)
 *   pips     = |entry – SL| / pipSize
 *
 * For synthetics (Deriv MT5):
 *   lotSize  = dollarRisk / (|entry – SL| × contractSize)
 */
function calcPositionMetrics(tradeObj) {
  if (!tradeObj || accountSize <= 0 || riskPercent <= 0) return null;
  if (tradeObj.entry === null || tradeObj.entry === undefined || tradeObj.sl === null || tradeObj.sl === undefined) return null;

  const dollarRisk   = accountSize * (riskPercent / 100);
  const dollarReward = dollarRisk * (tradeObj.rr || 0);
  const riskDist     = Math.abs(tradeObj.entry - tradeObj.sl);

  const symbol = tradeObj.symbol || getActiveSymbol();
  const specs  = getSymbolSpecs(symbol);

  if (specs.type === "forex") {
    /* ---- Forex / Commodity lot-size calculation ---- */
    const pips    = specs.pipSize > 0 ? riskDist / specs.pipSize : 0;
    const pipVal  = getPipValuePerLot(symbol, tradeObj.entry);
    const lotSize = (pips > 0 && pipVal > 0) ? dollarRisk / (pips * pipVal) : 0;
    return {
      dollarRisk,
      dollarReward,
      lotSize:     Math.round(lotSize * 100) / 100,   /* round to 0.01 lots */
      pips:        Math.round(pips * 10) / 10,         /* round to 0.1 pips */
      pipValue:    Math.round(pipVal * 100) / 100,
      isSynthetic: false
    };
  }

  /* ---- Synthetic indices (Deriv MT5): lot-size calculation ---- */
  const contractSz = specs.contractSize || 1;
  const lotSize    = (riskDist > 0 && contractSz > 0)
                     ? dollarRisk / (riskDist * contractSz)
                     : 0;
  return {
    dollarRisk,
    dollarReward,
    lotSize:     Math.round(lotSize * 100) / 100,   /* round to 0.01 lots */
    pips:        0,
    pipValue:    0,
    isSynthetic: true
  };
}

/* Confluence score for current setup */
let confluenceScore = 0;

/* Telegram integration */
let telegramBotToken  = "";
let telegramChatId    = "";
let telegramAutoSend  = false;
let telegramScalpAutoSend = false;  /* auto-send live scalp alerts to Telegram */
let telegramOutcomeSend   = false;  /* auto-send WIN/LOSS trade outcome to Telegram */
let telegramScalpOutcomeSend = false; /* auto-send WIN/LOSS scalp outcome to Telegram */
let telegramSessionRangeAutoSend = false;  /* auto-send session range signals (tight Asian, London sweep) to Telegram */
let telegramSessionRangeOutcomeSend = false; /* auto-send WIN/LOSS outcome for session range trades to Telegram */
let telegramStrategyAutoSend     = false;  /* auto-send custom strategy alerts (Liquidity Sweep, Stop Loss Hunt, Failed Pin Bar) to Telegram */
let telegramStrategyOutcomeSend  = false;  /* auto-send WIN/LOSS outcome for custom strategies to Telegram */
let telegramProfitExitAlertEnabled = false;  /* auto-send alert when trade that reached 1:1 profit reverses back to entry */
let telegramDeliveryHudEl = null;
let telegramDeliveryStats = { queued: 0, sent: 0, failed: 0 };

/* RSI state */
let rsiValues = [];

/* New strategy filter toggles */
let rsiFilterEnabled     = true;
let volumeSpikeEnabled   = true;
let sessionFilterEnabled = false;
let sessionFilterMode    = "london_ny";  /* london | new_york | overlap | asian | london_ny */
let fibRetestEnabled     = false;

/* GainzAlgo V2 indicator state */
let macdLine = [];
let macdSignal = [];
let macdHistogram = [];
let bbUpper = [];
let bbLower = [];
let bbMiddle = [];
let bbWidth = [];
let adxValue = 0;
let adxDiPlus = 0;
let adxDiMinus = 0;
let stochK = [];
let stochD = [];

/* GainzAlgo V2 filter toggles */
let macdFilterEnabled = true;
let bbSqueezeFilterEnabled = false;
let adxFilterEnabled = false;
let stochFilterEnabled = false;

/* Profit-Direction Constraint filters */
let minConfluenceEnabled = true;
let minConfluenceValue   = 11;      /* min confluence score (0-16) to allow trade — raised to 11 to filter weak setups */
let doubleRetestEnabled  = false;   /* require 2 retests of breakout level */
let confirmBarEnabled    = true;    /* next candle after confirm must close in direction */
let divergenceFilterEnabled = true; /* RSI divergence at retest */
let adxHardGateEnabled   = false;   /* block when ADX < 20 (ranging) or > 50 (exhausted) */
let adxMaxThreshold      = 50;      /* upper ADX limit for exhausted trends */
let breakoutDistEnabled  = false;   /* reject retest if price too far from breakout */
let breakoutDistATR      = 3.0;     /* max distance in ATR multiples */
let timeDecayEnabled     = true;    /* max candles between breakout and retest */
let timeDecayCandles     = 20;      /* staleness threshold */
let consecutiveDirEnabled = true;   /* 2 of last 3 candles must close in trade direction */
let vwapFilterEnabled    = false;   /* price near/aligned with VWAP */
let stochCrossEnabled    = false;   /* stochastic K/D crossover from oversold/overbought */
let rangeSizeEnabled     = true;    /* opening range must be 0.5-3× ATR */
let rangeSizeMin         = 0.5;     /* min range size in ATR multiples */
let rangeSizeMax         = 3.0;     /* max range size in ATR multiples */
let hhhlEnabled          = true;    /* higher-high/higher-low structure check */
let followThroughEnabled = true;    /* post-breakout follow-through (next candle continues) */
let mtfStructureEnabled  = false;   /* improved MTF via EMA 200 proxy */
let retestCount          = 0;       /* track number of retests for double-retest filter */

/* Scalping mode (from MD: quick 5-10 pip profits on 1min/5min charts) */
let scalpingModeEnabled = false;

/* NY Open Range (9:30–9:35 AM EST) strategy */
let nyOpenRangeEnabled   = false;
let nyOpenRange          = null;   /* { high, low, startIdx, endIdx, startEpoch, endEpoch } */
let nyOpenRangeBreakout  = null;   /* { dir, candleIdx, level } */
let nyOpenRangeRetest    = null;   /* { candleIdx } */
let nyOpenRangeTrade     = null;   /* { entry, sl, tp, dir, rr, entryIdx, symbol, result } */
let nyOpenRangePhase     = "IDLE"; /* IDLE | WAITING | RANGE | BREAKOUT | RETEST | TRADE */
let nyOpenRangeTradeWins   = 0;   /* running win count */
let nyOpenRangeTradeLosses = 0;   /* running loss count */
let nyOpenRangeHistory   = [];    /* alert history for strategy alerts panel */
const NY_OPEN_RANGE_MAX_HISTORY = 20;
let _nyOpenRangeNotified = false;  /* prevent duplicate 9:30 notifications per session */
let _nyOpenRangeTimerInterval = null; /* check-clock interval */

/* ================= SESSION RANGES (Asian / London / NY) ================= */
let sessionRangesEnabled  = false;    /* master toggle */
let sessionRangeAsian     = null;     /* { high, low, startIdx, endIdx } */
let sessionRangeLondon    = null;     /* { high, low, startIdx, endIdx } */
let sessionRangeNY        = null;     /* { high, low, startIdx, endIdx } */
let asianRangeTight       = false;    /* true when Asian range < ASIAN_TIGHT_ATR_MULT × ATR */
let londonSweepSignal     = null;     /* null | { dir: "HIGH" | "LOW", candleIdx, price } */
let sessionRangeTrade     = null;     /* null | { entry, sl, tp, dir, rr, entryIdx, symbol } — computed on London sweep */
let sessionRangeTradeWins   = 0;     /* running win count for session range trades */
let sessionRangeTradeLosses = 0;     /* running loss count for session range trades */
let lastSessionRangeBuildDate = null; /* YYYY-MM-DD of last buildSessionRanges() call — detects day rollover */
let sessionRangeHistory   = [];      /* alert history for strategy alerts panel */
const SESSION_RANGE_MAX_HISTORY = 20;
const ASIAN_TIGHT_ATR_MULT = 1.0;    /* threshold: range < 1× ATR = "tight" */

/* Auto-apply recommended settings when symbol changes */
let autoApplyRecommended = true;

/* Lock checkboxes — prevent applyRecommendedSettings from overwriting timeframe / R:R */
let lockTimeframe = false;
let lockRR        = false;

/* Lock strategy filters — prevent applyRecommendedSettings from re-enabling
   any filter that the user has explicitly disabled (unchecked) */
let lockIndicatorFilters = false;

/* ================= STRATEGY 1: LIQUIDITY SWEEP (15m → 1m) ================= */
let liquiditySweepEnabled = false;       /* master toggle */
let liquiditySweepHistory = [];          /* alert history */
const LIQUIDITY_SWEEP_MAX_HISTORY = 30;
const LIQUIDITY_SWEEP_COOLDOWN = 10;     /* min candles between alerts (raised from 3 for 1s markets) */
const LIQUIDITY_SWEEP_MAX_SL_ATR = 1.5;  /* max SL distance as ATR multiple — caps runaway risk */
let lastLiquiditySweepIdx = -999;

/* ================= STRATEGY 2: STOP LOSS HUNT ================= */
let stopLossHuntEnabled = false;         /* master toggle */
let stopLossHuntHistory = [];            /* alert history */
const STOP_LOSS_HUNT_MAX_HISTORY = 30;
const STOP_LOSS_HUNT_COOLDOWN = 8;       /* raised from 3 for 1s markets */
const SLH_KEY_LEVEL_TOUCHES = 3;        /* min touches to define key S/R level */
const SLH_LEVEL_LOOKBACK = 50;          /* candles to scan for S/R */
const SLH_LEVEL_TOLERANCE_PCT = 0.001;  /* 0.1% tolerance for level matching */
let lastStopLossHuntIdx = -999;

/* ================= STRATEGY 3: FAILED PIN BAR (Fear/Greed) ================= */
let failedPinBarEnabled = false;         /* master toggle */
let failedPinBarHistory = [];            /* alert history */
const FAILED_PIN_BAR_MAX_HISTORY = 30;
const FAILED_PIN_BAR_COOLDOWN = 8;       /* raised from 3 for 1s markets */
const FPB_CONSECUTIVE_CANDLES = 3;       /* min consecutive candles for fear/greed */
const FPB_BODY_RATIO_MIN = 0.6;         /* min body/range for strong candle */
let lastFailedPinBarIdx = -999;

/* ================= STRATEGY 4: FIB GOLDEN ZONE SCALP ================= */
/**
 * 1-minute Fibonacci Golden Zone scalping strategy.
 * Detects micro-trend → break of structure → waits for price to retrace
 * into the 0.5–0.618 Fibonacci zone (the "Golden Zone") → enters in the
 * trend direction → exits at the previous swing low (downtrend) or swing
 * high (uptrend).  No indicators — pure price action + Fibonacci.
 */
let fibScalpEnabled = false;              /* master toggle */
let fibScalpHistory = [];                 /* alert history */
const FIB_SCALP_MAX_HISTORY = 30;
const FIB_SCALP_COOLDOWN = 3;            /* min candles between alerts */
const FIB_SCALP_SWING_LOOKBACK = 30;     /* candles to scan for swing points */
const FIB_SCALP_TREND_SWINGS = 3;        /* min swing points to confirm micro-trend */
const FIB_SCALP_MAX_CANDLES = 15;        /* timeout: close trade monitoring after N candles */
let lastFibScalpIdx = -999;

/* ================= STRATEGY 5: POWER OF 3 (ICT) ================= */
/**
 * Power of 3 (PO3) strategy – Accumulation → Manipulation → Expansion.
 *
 * Concept (ICT methodology):
 *   1. Mark the current 1-hour candle open price.
 *   2. Use the daily EMA trend (EMA 21 vs EMA 8) to define the day's bias:
 *      - Bullish day → look for BUY below the 1H open.
 *      - Bearish day → look for SELL above the 1H open.
 *   3. Accumulation: price consolidates near the 1H open.
 *   4. Manipulation: a 15-minute sell-side sweep below the 1H open (bullish)
 *      or a buy-side sweep above the 1H open (bearish).
 *   5. Expansion: a 5-minute market structure shift (MSS) with displacement
 *      (a strong body candle that leaves a Fair Value Gap – FVG).
 *   6. Entry: when price returns into the FVG.
 *   7. SL: below the manipulation low (bullish) / above the manipulation high (bearish).
 *   8. TP1: 1H candle high (bullish) / 1H candle low (bearish) + external liquidity.
 *   9. Partial at 1–2R, let the rest run.
 */
let po3Enabled = false;              /* master toggle */
let po3History = [];                 /* alert history */
const PO3_MAX_HISTORY = 30;
const PO3_COOLDOWN = 5;             /* min candles between alerts */
const PO3_MAX_CANDLES = 30;         /* timeout: close trade monitoring after N candles */
const PO3_SWEEP_LOOKBACK = 6;       /* candles to look back for manipulation sweep */
const PO3_FVG_MIN_ATR = 0.3;        /* min FVG gap size as fraction of ATR */
const PO3_MSS_BODY_PCT = 0.6;       /* displacement candle body must be ≥ 60% of range */
const PO3_ENTRY_MAX_AGE_SAFE = 1;   /* allows 1-candle lag after a touch (safer, less strict) */
const PO3_ENTRY_MAX_AGE_STRICT = 0; /* only current-touch candle is valid (strictest timing) */
let po3EntryMaxAge = PO3_ENTRY_MAX_AGE_SAFE;
let lastPo3Idx = -999;

/* ================= STRATEGY 8: GRID SCALPER MA ================= */
/**
 * Grid Scalper MA — two selectable signal modes:
 *   "price_vs_ma" : BUY when prev close < MA and current close > MA;
 *                   SELL when prev close > MA and current close < MA.
 *   "bos"         : BUY when current close breaks above a confirmed swing high;
 *                   SELL when current close breaks below a confirmed swing low.
 */
let gridScalperMAEnabled   = false;          /* master toggle */
let gridScalperMAStrategy  = "price_vs_ma";  /* "price_vs_ma" | "bos" */
let gridScalperMAPeriod    = 21;             /* MA period for Price vs MA mode */
let gridScalperMAHistory   = [];             /* alert history */
let lastGridScalperMAIdx   = -999;
let autoTradeGridScalperMA = true;
const GRID_SCALPER_MA_MAX_HISTORY = 30;
const GRID_SCALPER_MA_COOLDOWN    = 5;    /* min candles between signals */
const GRID_SCALPER_MA_BOS_LOOKBACK = 30;  /* candles to scan for swing points in BOS mode */
const GRID_SCALPER_MA_MAX_SL_ATR   = 2.0; /* max SL distance as ATR multiple */

/* ── Grid Scalper MA: Symbol-category profit (R:R) settings ──
 *  Volatility 1s (1HZ*) — fast tick action, tighter TP for rapid captures.
 *  Volatility Standard (R_*) — slower structure, wider TP for bigger moves.
 *  Default fallback for other asset classes keeps the original 2:1 R:R.          */
const GRID_SCALPER_MA_RR_VOL1S     = 1.5; /* Volatility 1s: quick 1.5:1 scalp */
const GRID_SCALPER_MA_RR_STANDARD  = 2.5; /* Volatility Standard: ride 2.5:1 */
const GRID_SCALPER_MA_RR_DEFAULT   = 2.0; /* all other symbols: balanced 2:1 */

/* ================= STRATEGY 9: FAIR VALUE GAP (FVG) ================= */
/**
 * Fair Value Gap (FVG) Strategy — Supply & Demand with FVG confluence.
 *
 * Concept (as described in the strategy guide):
 *   1. Spot a "big push" — 3+ consecutive strong directional candles (bodies ≥ 60%
 *      of range and range ≥ 0.5× ATR) that create obvious imbalances.
 *   2. Identify FVGs within the push: a 3-candle pattern where the middle candle
 *      moves so aggressively that candle[i].low > candle[i-2].high (bullish FVG)
 *      or candle[i].high < candle[i-2].low (bearish FVG).
 *   3. Mark the demand/supply zone: the origin candle BEFORE the big push started.
 *      This is the most powerful level — not the FVG itself.  The FVG signals that
 *      price will likely retrace to fill the imbalance, carrying it back to the zone.
 *   4. Fibonacci: measure from swing low to swing high.  Only enter when price is
 *      at a "discount" — below the 50% retracement level (bullish) or above it
 *      (bearish).  Anything below 50% = cheap, above 50% = premium.
 *   5. Confirmation: wait for a bullish/bearish engulfing pattern at the demand zone,
 *      indicating real buying/selling momentum at the origin level.
 *   6. Entry at the confirmation candle close.
 *   7. SL below the demand zone low (bullish) or above supply zone high (bearish)
 *      with a small ATR buffer.
 *   8. TP at the recent swing high (bullish) / swing low (bearish).
 *   9. Market structure filter: long-term EMA trend must agree with trade direction.
 */
let fvgStratEnabled  = false;           /* master toggle */
let fvgStratHistory  = [];              /* alert history */
let lastFvgStratIdx  = -999;
const FVG_STRAT_MAX_HISTORY  = 30;
const FVG_STRAT_COOLDOWN     = 8;       /* min candles between signals */
const FVG_STRAT_MAX_CANDLES  = 40;      /* trade monitoring timeout */
const FVG_PUSH_MIN_CANDLES   = 3;       /* min consecutive strong candles for a "big push" */
const FVG_PUSH_BODY_PCT      = 0.55;    /* body must be ≥ 55% of range to count as a strong push candle */
const FVG_PUSH_ATR_MIN       = 0.4;     /* range must be ≥ 0.4× ATR to count as strong */
const FVG_MIN_SIZE_ATR       = 0.2;     /* FVG gap must be ≥ this fraction of ATR */
const FVG_ZONE_ATR_BUFFER    = 0.15;    /* ATR buffer below/above demand/supply zone */
const FVG_LOOKBACK           = 60;      /* candles to scan for push + zone */
const FVG_FIB_DISCOUNT       = 0.5;     /* below this fib retracement level = discount */

/* ================= MTF TOP-DOWN STRATEGY (Strategy 11) ================= */
/*
 * Multi-Timeframe Top-Down approach:
 *   1. Synthesise "4H equivalent" bars from the current candle stream.
 *   2. computeMtfBias()     – HH/HL vs LH/LL structure → BULL | BEAR | NEUTRAL
 *   3. detectMtfSetup()     – 1H-equivalent consolidation + bias-aligned breakout
 *   4. detectMtfConfirmation() – current-TF retest of the broken level
 *   5. detectMtfTopDown()   – entry on pin-bar / engulfing / micro-BOS at the zone
 *   Entry  : close of the trigger candle
 *   SL     : wick extreme + 0.3 × ATR buffer
 *   TP     : 4H swing high (BULL) or swing low (BEAR), min 2:1 R:R
 */
let mtfTopDownEnabled   = false;    /* master toggle */
let mtfTopDownHistory   = [];       /* alert history */
let lastMtfTopDownIdx   = -999;     /* cooldown tracker */
let autoTradeMtfTopDown = true;     /* auto-trade sub-toggle */

const MTF_TOP_DOWN_COOLDOWN    = 5;   /* min candles between signals */
const MTF_TOP_DOWN_MAX_HISTORY = 30;  /* max stored alerts */
const MTF_TOP_DOWN_MAX_CANDLES = 60;  /* monitoring timeout (candles) */
const MTF_BIAS_TF_MULT         = 16;  /* ×current TF → "4H" synthesis ratio */
const MTF_SETUP_TF_MULT        = 4;   /* ×current TF → "1H" synthesis ratio */
const MTF_BIAS_LOOKBACK        = 6;   /* synthesised 4H bars for bias */
const MTF_SETUP_LOOKBACK       = 12;  /* synthesised 1H bars for setup range */
const MTF_MIN_RR               = 2.0; /* minimum acceptable R:R */
const MTF_SL_ATR_BUFFER        = 0.3; /* ATR buffer beyond wick for SL */
const MTF_RETEST_LOOKBACK      = 8;   /* current-TF candles to scan for retest */

/* ================= LIVE SCALP SCANNER ================= */
let liveScalpEnabled = false;       /* master toggle */
let liveScalpMinConf = 3;           /* min confluence out of 7 to show alert */
let liveScalpHistory = [];          /* recent scalp alerts: { dir, price, sl, tp, conf, reasons[], epoch, candleIdx } */
const LIVE_SCALP_MAX_HISTORY = 30;
const LIVE_SCALP_COOLDOWN_CANDLES = 3;  /* min candles between consecutive scalp alerts */
let lastScalpCandleIdx = -999;

/* ================= STRATEGY 12: ORDERBLOCK DETECTION ================= */
let orderblockEnabled  = false;       /* master toggle */
let orderblockHistory  = [];          /* alert history */
let lastOrderblockIdx  = -999;
let autoTradeOrderblock = true;

/* ================= FEATURE: SESSION HEATMAP (17) ================= */
let sessionHeatmapEnabled = false;    /* draw session colour bands on chart */

/* ================= FEATURE: CANDLE PATTERN ANNOTATIONS (6) ================= */
let candleAnnotationsEnabled = true;  /* draw labels above/below pattern candles */

/* ================= FEATURE: VOLUME PROFILE (9) ================= */
let volumeProfileEnabled = false;     /* range-based histogram on chart right edge */

/* ================= FEATURE: FIBONACCI EXTENSIONS (10) ================= */
let fibExtensionsEnabled = false;     /* draw 1.272/1.414/1.618/2.0/2.618 extension levels */

/* ================= FEATURE: BOS / ChoCH MARKERS (5) ================= */
let bosChochEnabled  = false;         /* draw BOS/ChoCH labels on chart */
let bosChochMarkers  = [];            /* [{ idx, type:"BOS"|"ChoCH", dir:"BULL"|"BEAR", price }] */

/* ================= FEATURE: DIVERGENCE VISUAL MARKERS (7) ================= */
let divergenceVisualEnabled = false;  /* draw divergence lines on price + RSI panel */
let divergenceMarkers = [];           /* [{ boIdx, rtIdx, dir, rsiBO, rsiRT, priceBO, priceRT }] */

/* ================= FEATURE: NAMED SETTINGS PROFILES (4) ================= */
const PROFILES_LS_KEY = "itguru_indicator_profiles";
let savedProfiles = {};               /* { name: settingsSnapshot } */

/* ================= FEATURE: SIGNAL NOTES (12) ================= */
const SIGNAL_NOTES_LS_KEY = "itguru_signal_notes";
let signalNotes = {};                 /* { signalId: noteText } */

/* ================= FEATURE: BACKTESTING ENGINE (1) ================= */
let backtestMode      = false;
let backtestIdx       = 0;
let backtestInterval  = null;
let backtestSpeedMs   = BACKTEST_DEFAULT_SPEED_MS;
let _backtestCandles  = [];

/* ================= FEATURE: MULTI-R PARTIAL EXIT LADDER (15) ================= */
let multiRLadderEnabled = false;
let multiRLadder   = JSON.parse(JSON.stringify(MULTI_R_LADDER_DEFAULT));
let multiRHitLevels = [];             /* indices of already-triggered ladder levels */

/* ================= FEATURE: ECONOMIC CALENDAR / NEWS PAUSE (11) ================= */
let newsPauseEnabled  = false;
let newsPauseMinutes  = NEWS_PAUSE_DEFAULT_MIN;
let newsEvents        = [];           /* [{ time, title, impact, currency }] */
let _newsCacheFetched = 0;

/* ================= FEATURE: ADAPTIVE CONFLUENCE WEIGHTING (13) ================= */
let adaptiveConfluenceEnabled = false;
let confluenceFactorStats = {};       /* { factorName: { wins, losses } } */

/* ================= FEATURE: SCANNER WATCHLIST (8) ================= */
let scannerEnabled  = false;
let scannerSymbols  = ["1HZ100V", "1HZ50V", "1HZ10V", "frxEURUSD", "frxGBPUSD"];

/* ================= UI REFS ================= */
const UI = {};
function initUI() {
  UI.symbolSelect   = document.getElementById("symbolSelect");
  UI.granSelect     = document.getElementById("granSelect");
  UI.riskInput      = document.getElementById("riskInput");
  UI.rewardInput    = document.getElementById("rewardInput");
  UI.connectBtn     = document.getElementById("connectBtn");
  UI.disconnectBtn  = document.getElementById("disconnectBtn");
  UI.resetSessionBtn = document.getElementById("resetSessionBtn");
  UI.wsStatus       = document.getElementById("wsStatus");
  UI.accountTypeBadge = document.getElementById("accountTypeBadge");
  UI.candleCount    = document.getElementById("candleCount");
  UI.livePrice      = document.getElementById("livePrice");
  UI.phaseLabel     = document.getElementById("phaseLabel");
  UI.rangeHigh      = document.getElementById("rangeHigh");
  UI.rangeLow       = document.getElementById("rangeLow");
  UI.breakoutDir    = document.getElementById("breakoutDir");
  UI.nextAction     = document.getElementById("nextAction");
  UI.retestStatus   = document.getElementById("retestStatus");
  UI.confirmStatus  = document.getElementById("confirmStatus");
  UI.entryPrice     = document.getElementById("entryPrice");
  UI.slPrice        = document.getElementById("slPrice");
  UI.tpPrice        = document.getElementById("tpPrice");
  UI.rrDisplay      = document.getElementById("rrDisplay");
  UI.dollarRisk     = document.getElementById("dollarRisk");
  UI.dollarReward   = document.getElementById("dollarReward");
  UI.positionSize   = document.getElementById("positionSize");
  UI.dollarRiskCard   = document.getElementById("dollarRiskCard");
  UI.dollarRewardCard = document.getElementById("dollarRewardCard");
  UI.positionSizeCard = document.getElementById("positionSizeCard");
  UI.positionSizeLabel = document.getElementById("positionSizeLabel");
  UI.pipsCard         = document.getElementById("pipsCard");
  UI.pipsValue        = document.getElementById("pipsValue");
  UI.accountSizeInput = document.getElementById("accountSizeInput");
  UI.riskPercentInput = document.getElementById("riskPercentInput");
  UI.autoTradeToggle        = document.getElementById("autoTradeToggle");
  UI.autoTradeScalpToggle   = document.getElementById("autoTradeScalpToggle");
  UI.autoTradeStrategyToggle = document.getElementById("autoTradeStrategyToggle");
  UI.autoTradeScalpOppositeToggle   = document.getElementById("autoTradeScalpOppositeToggle");
  UI.autoTradeStrategyOppositeToggle = document.getElementById("autoTradeStrategyOppositeToggle");
  /* Per-strategy auto-trade sub-toggles */
  UI.autoTradeLiquiditySweepToggle = document.getElementById("autoTradeLiquiditySweepToggle");
  UI.autoTradeStopLossHuntToggle   = document.getElementById("autoTradeStopLossHuntToggle");
  UI.autoTradeFailedPinBarToggle   = document.getElementById("autoTradeFailedPinBarToggle");
  UI.autoTradeFibScalpToggle       = document.getElementById("autoTradeFibScalpToggle");
  UI.autoTradePo3Toggle            = document.getElementById("autoTradePo3Toggle");
  UI.autoTradeNYOpenRangeToggle    = document.getElementById("autoTradeNYOpenRangeToggle");
  UI.autoTradeSessionRangeToggle   = document.getElementById("autoTradeSessionRangeToggle");
  UI.autoTradeStake         = document.getElementById("autoTradeStake");
  UI.autoTradeMaxStake      = document.getElementById("autoTradeMaxStake");
  UI.autoTradeMultiplier    = document.getElementById("autoTradeMultiplier");
  UI.maxConcurrentTrades    = document.getElementById("maxConcurrentTrades");
  UI.autoTradeSessionTP     = document.getElementById("autoTradeSessionTP");
  UI.autoTradeSessionSL     = document.getElementById("autoTradeSessionSL");
  UI.autoTradeBalanceSection = document.getElementById("autoTradeBalanceSection");
  UI.autoTradeBalanceValue   = document.getElementById("autoTradeBalanceValue");
  UI.autoTradePLValue        = document.getElementById("autoTradePLValue");
  UI.autoTradeCurrentStakeDisplay = document.getElementById("autoTradeCurrentStakeDisplay");
  UI.autoTradeHistoryList    = document.getElementById("autoTradeHistoryList");
  UI.autoTradeHistoryEmpty   = document.getElementById("autoTradeHistoryEmpty");
  UI.signalLog      = document.getElementById("signalLog");
  UI.canvas         = document.getElementById("mainChart");
  UI.ctx            = UI.canvas.getContext("2d");
  UI.uptimeDisplay  = document.getElementById("uptimeDisplay");
  UI.candleCountdown = document.getElementById("candleCountdown");

  /* Configurable parameter inputs */
  UI.appIdInput       = document.getElementById("appIdInput");
  UI.derivTokenInput  = document.getElementById("derivTokenInput");
  UI.rangeDuration    = document.getElementById("rangeDuration");
  UI.touchTolerance   = document.getElementById("touchTolerance");
  UI.dojiRatio        = document.getElementById("dojiRatio");
  UI.lookbackPeriod   = document.getElementById("lookbackPeriod");

  /* Stats */
  UI.signalWins       = document.getElementById("signalWins");
  UI.signalLosses     = document.getElementById("signalLosses");
  UI.signalWinRate    = document.getElementById("signalWinRate");
  UI.signalCount      = document.getElementById("signalCount");

  /* New indicator state displays */
  UI.emaFilterStatus    = document.getElementById("emaFilterStatus");
  UI.htfTrend           = document.getElementById("htfTrend");
  UI.atrDisplay         = document.getElementById("atrDisplay");
  UI.breakoutStrength   = document.getElementById("breakoutStrength");
  UI.trailingSLDisplay  = document.getElementById("trailingSLDisplay");
  UI.partialTpDisplay   = document.getElementById("partialTpDisplay");

  /* Strategy filter toggles */
  UI.autoResetToggle    = document.getElementById("autoResetToggle");
  UI.emaFilterToggle    = document.getElementById("emaFilterToggle");
  UI.htfFilterToggle    = document.getElementById("htfFilterToggle");
  UI.atrToleranceToggle = document.getElementById("atrToleranceToggle");
  UI.trailingStopToggle = document.getElementById("trailingStopToggle");
  UI.partialTpToggle    = document.getElementById("partialTpToggle");
  UI.falseBreakoutToggle = document.getElementById("falseBreakoutToggle");
  UI.minRRToggle         = document.getElementById("minRRToggle");
  UI.minRRInput          = document.getElementById("minRRInput");
  UI.pureTrailingToggle  = document.getElementById("pureTrailingToggle");
  UI.teslaScalingToggle  = document.getElementById("teslaScalingToggle");
  UI.teslaScalingPlan    = document.getElementById("teslaScalingPlan");

  /* New indicator state displays */
  UI.confluenceDisplay  = document.getElementById("confluenceDisplay");
  UI.srConfluenceDisplay = document.getElementById("srConfluenceDisplay");

  /* New filter UI refs */
  UI.rsiFilterToggle     = document.getElementById("rsiFilterToggle");
  UI.volumeSpikeToggle   = document.getElementById("volumeSpikeToggle");
  UI.sessionFilterToggle = document.getElementById("sessionFilterToggle");
  UI.sessionFilterMode   = document.getElementById("sessionFilterMode");
  UI.fibRetestToggle     = document.getElementById("fibRetestToggle");
  UI.autoApplyRecToggle  = document.getElementById("autoApplyRecToggle");
  UI.lockTimeframeToggle = document.getElementById("lockTimeframeToggle");
  UI.lockRRToggle        = document.getElementById("lockRRToggle");
  UI.lockIndicatorFiltersToggle = document.getElementById("lockIndicatorFiltersToggle");
  UI.rsiDisplay          = document.getElementById("rsiDisplay");
  UI.volumeSpikeDisplay  = document.getElementById("volumeSpikeDisplay");
  UI.sessionDisplay      = document.getElementById("sessionDisplay");
  UI.fibRetestDisplay    = document.getElementById("fibRetestDisplay");

  /* GainzAlgo V2 UI refs */
  UI.macdFilterToggle      = document.getElementById("macdFilterToggle");
  UI.bbSqueezeFilterToggle = document.getElementById("bbSqueezeFilterToggle");
  UI.adxFilterToggle       = document.getElementById("adxFilterToggle");
  UI.stochFilterToggle     = document.getElementById("stochFilterToggle");
  UI.macdDisplay           = document.getElementById("macdDisplay");
  UI.bbSqueezeDisplay      = document.getElementById("bbSqueezeDisplay");
  UI.adxDisplay            = document.getElementById("adxDisplay");
  UI.stochDisplay          = document.getElementById("stochDisplay");
  UI.volatilityRegime      = document.getElementById("volatilityRegime");
  UI.signalStrengthGauge   = document.getElementById("signalStrengthGauge");
  UI.signalStrengthLabel   = document.getElementById("signalStrengthLabel");

  /* Scalping mode */
  UI.scalpingModeToggle    = document.getElementById("scalpingModeToggle");
  UI.nyOpenRangeToggle     = document.getElementById("nyOpenRangeToggle");
  UI.toastContainer        = document.getElementById("toastContainer");

  /* Session Ranges UI refs */
  UI.sessionRangesToggle   = document.getElementById("sessionRangesToggle");
  UI.sessionRangeAsianDisplay  = document.getElementById("sessionRangeAsianDisplay");
  UI.sessionRangeLondonDisplay = document.getElementById("sessionRangeLondonDisplay");
  UI.sessionRangeNYDisplay     = document.getElementById("sessionRangeNYDisplay");
  UI.asianTightDisplay         = document.getElementById("asianTightDisplay");
  UI.londonSweepDisplay        = document.getElementById("londonSweepDisplay");
  UI.sessionRangeTradeDisplay  = document.getElementById("sessionRangeTradeDisplay");
  UI.sessionRangeEntryDisplay  = document.getElementById("sessionRangeEntryDisplay");
  UI.sessionRangeSLDisplay     = document.getElementById("sessionRangeSLDisplay");
  UI.sessionRangeTPDisplay     = document.getElementById("sessionRangeTPDisplay");
  UI.sessionRangeRRDisplay     = document.getElementById("sessionRangeRRDisplay");

  /* Profit-Direction Constraint UI refs */
  UI.minConfluenceToggle     = document.getElementById("minConfluenceToggle");
  UI.minConfluenceInput      = document.getElementById("minConfluenceInput");
  UI.doubleRetestToggle      = document.getElementById("doubleRetestToggle");
  UI.confirmBarToggle        = document.getElementById("confirmBarToggle");
  UI.divergenceFilterToggle  = document.getElementById("divergenceFilterToggle");
  UI.adxHardGateToggle       = document.getElementById("adxHardGateToggle");
  UI.adxMaxInput             = document.getElementById("adxMaxInput");
  UI.breakoutDistToggle      = document.getElementById("breakoutDistToggle");
  UI.breakoutDistInput       = document.getElementById("breakoutDistInput");
  UI.timeDecayToggle         = document.getElementById("timeDecayToggle");
  UI.timeDecayInput          = document.getElementById("timeDecayInput");
  UI.consecutiveDirToggle    = document.getElementById("consecutiveDirToggle");
  UI.vwapFilterToggle        = document.getElementById("vwapFilterToggle");
  UI.stochCrossToggle        = document.getElementById("stochCrossToggle");
  UI.rangeSizeToggle         = document.getElementById("rangeSizeToggle");
  UI.rangeSizeMinInput       = document.getElementById("rangeSizeMinInput");
  UI.rangeSizeMaxInput       = document.getElementById("rangeSizeMaxInput");
  UI.hhhlToggle              = document.getElementById("hhhlToggle");
  UI.followThroughToggle     = document.getElementById("followThroughToggle");
  UI.mtfStructureToggle      = document.getElementById("mtfStructureToggle");
  UI.revertSettingsBtn       = document.getElementById("revertSettingsBtn");

  /* Strategy 1: Liquidity Sweep */
  UI.liquiditySweepToggle  = document.getElementById("liquiditySweepToggle");
  UI.liquiditySweepAlertList = document.getElementById("liquiditySweepAlertList");
  UI.liquiditySweepCount   = document.getElementById("liquiditySweepCount");

  /* Strategy 2: Stop Loss Hunt */
  UI.stopLossHuntToggle    = document.getElementById("stopLossHuntToggle");
  UI.stopLossHuntAlertList = document.getElementById("stopLossHuntAlertList");
  UI.stopLossHuntCount     = document.getElementById("stopLossHuntCount");

  /* Strategy 3: Failed Pin Bar */
  UI.failedPinBarToggle    = document.getElementById("failedPinBarToggle");
  UI.failedPinBarAlertList = document.getElementById("failedPinBarAlertList");
  UI.failedPinBarCount     = document.getElementById("failedPinBarCount");

  /* Strategy 4: Fib Golden Zone Scalp */
  UI.fibScalpToggle        = document.getElementById("fibScalpToggle");
  UI.fibScalpAlertList     = document.getElementById("fibScalpAlertList");
  UI.fibScalpCount         = document.getElementById("fibScalpCount");

  /* Strategy 5: Power of 3 (ICT) */
  UI.po3Toggle             = document.getElementById("po3Toggle");
  UI.po3FreshnessMode      = document.getElementById("po3FreshnessMode");
  UI.po3AlertList          = document.getElementById("po3AlertList");
  UI.po3Count              = document.getElementById("po3Count");

  /* Strategy 8: Grid Scalper MA */
  UI.gridScalperMAToggle         = document.getElementById("gridScalperMAToggle");
  UI.gridScalperMAStrategySelect = document.getElementById("gridScalperMAStrategySelect");
  UI.gridScalperMAPeriodInput    = document.getElementById("gridScalperMAPeriodInput");
  UI.gridScalperMAAlertList      = document.getElementById("gridScalperMAAlertList");
  UI.gridScalperMAAlertCount     = document.getElementById("gridScalperMAAlertCount");
  UI.autoTradeGridScalperMAToggle = document.getElementById("autoTradeGridScalperMAToggle");

  /* Strategy 9: Fair Value Gap (FVG) */
  UI.fvgStratToggle        = document.getElementById("fvgStratToggle");
  UI.fvgStratAlertList     = document.getElementById("fvgStratAlertList");
  UI.fvgStratAlertCount    = document.getElementById("fvgStratAlertCount");
  UI.autoTradeFvgStratToggle = document.getElementById("autoTradeFvgStratToggle");

  /* Strategy 11: MTF Top-Down */
  UI.mtfTopDownToggle          = document.getElementById("mtfTopDownToggle");
  UI.mtfTopDownAlertList       = document.getElementById("mtfTopDownAlertList");
  UI.mtfTopDownAlertCount      = document.getElementById("mtfTopDownAlertCount");
  UI.autoTradeMtfTopDownToggle = document.getElementById("autoTradeMtfTopDownToggle");

  /* NY Open Range alerts */
  UI.nyOpenRangeAlertList  = document.getElementById("nyOpenRangeAlertList");
  UI.nyOpenRangeAlertCount = document.getElementById("nyOpenRangeAlertCount");

  /* Session Range alerts */
  UI.sessionRangeAlertList  = document.getElementById("sessionRangeAlertList");
  UI.sessionRangeAlertCount = document.getElementById("sessionRangeAlertCount");

  /* Strategy Alerts header total count badge */
  UI.strategyAlertTotalCount = document.getElementById("strategyAlertTotalCount");

  /* Live Scalp Scanner */
  UI.liveScalpToggle       = document.getElementById("liveScalpToggle");
  UI.liveScalpMinConf      = document.getElementById("liveScalpMinConf");
  UI.scalpAlertList        = document.getElementById("scalpAlertList");
  UI.scalpAlertBanner      = document.getElementById("scalpAlertBanner");
  UI.scalpAlertBannerText  = document.getElementById("scalpAlertBannerText");
  UI.scalpAlertCount       = document.getElementById("scalpAlertCount");

  /* Live Scalp Stats */
  UI.scalpStatsTotal       = document.getElementById("scalpStatsTotal");
  UI.scalpStatsWins        = document.getElementById("scalpStatsWins");
  UI.scalpStatsLosses      = document.getElementById("scalpStatsLosses");
  UI.scalpStatsWinRate     = document.getElementById("scalpStatsWinRate");
  UI.scalpStatsBull        = document.getElementById("scalpStatsBull");
  UI.scalpStatsBear        = document.getElementById("scalpStatsBear");
  UI.scalpStatsAvgConf     = document.getElementById("scalpStatsAvgConf");
  UI.scalpStatsBestConf    = document.getElementById("scalpStatsBestConf");
  UI.scalpStatsLastTime    = document.getElementById("scalpStatsLastTime");

  /* Live Signal Ticker Banner */
  UI.signalBanner      = document.getElementById("signalBanner");
  UI.signalBannerTrack = document.getElementById("signalBannerTrack");

  /* Live Scalp Ticker Banner */
  UI.scalpTickerBanner = document.getElementById("scalpTickerBanner");
  UI.scalpTickerTrack  = document.getElementById("scalpTickerTrack");

  /* Live Strategies Ticker Banner */
  UI.strategyTickerBanner = document.getElementById("strategyTickerBanner");
  UI.strategyTickerTrack  = document.getElementById("strategyTickerTrack");

  /* Tool buttons */
  UI.exportBtn        = document.getElementById("exportSignalsBtn");
  UI.themeToggleBtn   = document.getElementById("themeToggleBtn");
  UI.soundToggleBtn   = document.getElementById("soundToggleBtn");
  UI.notifToggleBtn   = document.getElementById("notifToggleBtn");
  UI.streamModeBtn    = document.getElementById("streamModeBtn");
  UI.emaToggle        = document.getElementById("emaToggle");

  /* Symbol nav */
  UI.prevSymbolBtn      = document.getElementById("prevSymbolBtn");
  UI.nextSymbolBtn      = document.getElementById("nextSymbolBtn");
  UI.currentSymbolLabel = document.getElementById("currentSymbolLabel");

  /* Recommended settings active badges */
  UI.recActive_timeframe    = document.getElementById("recActive_timeframe");
  UI.recActive_rr           = document.getElementById("recActive_rr");
  UI.recActive_range        = document.getElementById("recActive_range");
  UI.recActive_ema          = document.getElementById("recActive_ema");
  UI.recActive_htf          = document.getElementById("recActive_htf");
  UI.recActive_atr          = document.getElementById("recActive_atr");
  UI.recActive_trailing     = document.getElementById("recActive_trailing");
  UI.recActive_partialTp    = document.getElementById("recActive_partialTp");
  UI.recActive_falseBreakout = document.getElementById("recActive_falseBreakout");
  UI.recActive_minRR        = document.getElementById("recActive_minRR");
  UI.recActive_rsiFilter    = document.getElementById("recActive_rsiFilter");
  UI.recActive_volSpike     = document.getElementById("recActive_volSpike");
  UI.recActive_session      = document.getElementById("recActive_session");
  UI.recActive_fib          = document.getElementById("recActive_fib");
  UI.recActive_macd         = document.getElementById("recActive_macd");
  UI.recActive_bbSqueeze    = document.getElementById("recActive_bbSqueeze");
  UI.recActive_adx          = document.getElementById("recActive_adx");
  UI.recActive_stoch        = document.getElementById("recActive_stoch");

  /* Recommended settings dynamic "Rec" column badges */
  UI.recRec_timeframe     = document.getElementById("recRec_timeframe");
  UI.recRec_rr            = document.getElementById("recRec_rr");
  UI.recRec_range         = document.getElementById("recRec_range");
  UI.recRec_ema           = document.getElementById("recRec_ema");
  UI.recRec_htf           = document.getElementById("recRec_htf");
  UI.recRec_atr           = document.getElementById("recRec_atr");
  UI.recRec_trailing      = document.getElementById("recRec_trailing");
  UI.recRec_partialTp     = document.getElementById("recRec_partialTp");
  UI.recRec_falseBreakout = document.getElementById("recRec_falseBreakout");
  UI.recRec_minRR         = document.getElementById("recRec_minRR");
  UI.recRec_rsiFilter     = document.getElementById("recRec_rsiFilter");
  UI.recRec_volSpike      = document.getElementById("recRec_volSpike");
  UI.recRec_session       = document.getElementById("recRec_session");
  UI.recRec_fib           = document.getElementById("recRec_fib");
  UI.recRec_macd          = document.getElementById("recRec_macd");
  UI.recRec_bbSqueeze     = document.getElementById("recRec_bbSqueeze");
  UI.recRec_adx           = document.getElementById("recRec_adx");
  UI.recRec_stoch         = document.getElementById("recRec_stoch");
  UI.recMarketLabel       = document.getElementById("recMarketLabel");
  UI.recMarketSignals     = document.getElementById("recMarketSignals");
  UI.recSignalsList       = document.getElementById("recSignalsList");
  UI.recHintText          = document.getElementById("recHintText");

  /* Market type badge */
  UI.marketTypeBadge      = document.getElementById("marketTypeBadge");

  /* Login gate */
  UI.loginOverlay     = document.getElementById("loginOverlay");
  UI.loginBtn         = document.getElementById("loginBtn");
  UI.loginError       = document.getElementById("loginError");

  /* Telegram */
  UI.telegramBotToken       = document.getElementById("telegramBotToken");
  UI.telegramChatId         = document.getElementById("telegramChatId");
  UI.telegramAutoSendToggle = document.getElementById("telegramAutoSendToggle");
  UI.telegramScalpAutoSendToggle = document.getElementById("telegramScalpAutoSendToggle");
  UI.telegramOutcomeSendToggle   = document.getElementById("telegramOutcomeSendToggle");
  UI.telegramScalpOutcomeSendToggle = document.getElementById("telegramScalpOutcomeSendToggle");
  UI.telegramSessionRangeAutoSendToggle = document.getElementById("telegramSessionRangeAutoSendToggle");
  UI.telegramSessionRangeOutcomeSendToggle = document.getElementById("telegramSessionRangeOutcomeSendToggle");
  UI.telegramStrategyAutoSendToggle    = document.getElementById("telegramStrategyAutoSendToggle");
  UI.telegramStrategyOutcomeSendToggle = document.getElementById("telegramStrategyOutcomeSendToggle");
  UI.telegramProfitExitAlertToggle     = document.getElementById("telegramProfitExitAlertToggle");
  UI.telegramSendNowBtn     = document.getElementById("telegramSendNowBtn");
  UI.telegramSendScalpNowBtn    = document.getElementById("telegramSendScalpNowBtn");
  UI.telegramSendStrategyNowBtn = document.getElementById("telegramSendStrategyNowBtn");
  UI.telegramStatus         = document.getElementById("telegramStatus");

  /* Feature 2: Orderblock toggle */
  UI.orderblockToggle        = document.getElementById("orderblockToggle");
  UI.autoTradeOrderblockToggle = document.getElementById("autoTradeOrderblockToggle");

  /* Feature 17: Session heatmap */
  UI.sessionHeatmapToggle    = document.getElementById("sessionHeatmapToggle");

  /* Feature 6: Candle annotations */
  UI.candleAnnotationsToggle = document.getElementById("candleAnnotationsToggle");

  /* Feature 9: Volume profile */
  UI.volumeProfileToggle     = document.getElementById("volumeProfileToggle");

  /* Feature 10: Fib extensions */
  UI.fibExtensionsToggle     = document.getElementById("fibExtensionsToggle");

  /* Feature 5: BOS/ChoCH */
  UI.bosChochToggle          = document.getElementById("bosChochToggle");

  /* Feature 7: Divergence visual */
  UI.divergenceVisualToggle  = document.getElementById("divergenceVisualToggle");

  /* Feature 11: News pause */
  UI.newsPauseToggle         = document.getElementById("newsPauseToggle");
  UI.newsPauseMinutesInput   = document.getElementById("newsPauseMinutesInput");

  /* Feature 15: Multi-R ladder */
  UI.multiRLadderToggle      = document.getElementById("multiRLadderToggle");

  /* Feature 13: Adaptive confluence */
  UI.adaptiveConfluenceToggle = document.getElementById("adaptiveConfluenceToggle");

  /* Feature 1: Backtest */
  UI.backtestSpeedInput      = document.getElementById("backtestSpeedInput");

  /* Feature 8: Scanner */
  UI.scannerToggle           = document.getElementById("scannerToggle");
  UI.scannerSymbolPicker     = document.getElementById("scannerSymbolPicker");

  /* Public Market Feed panel */
  UI.publicFeedPanel     = document.getElementById("publicFeedPanel");
  UI.publicFeedStatus    = document.getElementById("publicFeedStatus");
  UI.pfSymbol            = document.getElementById("pfSymbol");
  UI.pfPrice             = document.getElementById("pfPrice");
  UI.pfLastUpdate        = document.getElementById("pfLastUpdate");
  UI.pfTickCount         = document.getElementById("pfTickCount");
  UI.startPublicFeedBtn  = document.getElementById("startPublicFeedBtn");
  UI.stopPublicFeedBtn   = document.getElementById("stopPublicFeedBtn");
  UI.autoStartFeedToggle = document.getElementById("autoStartFeedToggle");
}

/* ================= HELPERS ================= */
function fmt(v, d) {
  if (v == null) return "--";
  const n = Number(v);
  return isNaN(n) ? "--" : n.toFixed(d != null ? d : 2);
}

/**
 * Returns the correct number of decimal places to display a price for the
 * given symbol, matching the precision accepted by MT5 for that instrument.
 *
 * Logic:
 *   - For known forex pairs (pipSize ≤ 0.0001): d+1 (5-digit MT5 standard)
 *   - For metal commodities (XAU, XAG, XPT, XPD): exact pip decimal places
 *   - For forex pairs with pipSize > 0.0001 (e.g. JPY, 0.01): exact pip decimal places
 *   - For synthetics / unknown symbols without a pipSize: inferred from
 *     priceSample magnitude (≥10 000 → 2 dp, ≥1 000 → 3 dp, ≥100 → 4 dp, else 5 dp)
 *
 * @param {string}  symbol       – Deriv symbol identifier
 * @param {number}  [priceSample] – a representative price used as fallback for synthetics
 * @returns {number} number of decimal places
 */
function getSymbolDigits(symbol, priceSample) {
  const sp = getSymbolSpecs(symbol);
  if (sp && sp.pipSize) {
    const d = Math.round(-Math.log10(sp.pipSize));
    const isMetal = /^frx(XAU|XAG|XPT|XPD)/i.test(symbol || "") || /^XAUUSD/i.test(symbol || "");
    /* Standard forex pairs use 5-digit (fractional pip) precision on MT5 */
    if (!isMetal && sp.type === "forex" && sp.pipSize <= 0.0001) return d + 1;
    return d;
  }
  /* Synthetics / unknown: infer from price magnitude */
  if (priceSample != null && priceSample > 0) {
    if (priceSample >= 10000) return 2;
    if (priceSample >= 1000)  return 3;
    if (priceSample >= 100)   return 4;
    return 5;
  }
  return 5;
}

/**
 * Format a price value to the correct decimal places for the given symbol.
 * Uses getSymbolDigits() with the price itself as the fallback magnitude hint.
 *
 * @param {number} price  – the price to format
 * @param {string} symbol – Deriv symbol identifier
 * @returns {string}
 */
function fmtPrice(price, symbol) {
  if (price == null) return "--";
  const n = Number(price);
  if (isNaN(n)) return "--";
  const d = getSymbolDigits(symbol, n);
  return n.toFixed(d);
}

/**
 * Returns the recommended MT5 order type based on entry price vs current price.
 *
 * MT5 pending-order rules:
 *   BUY  STOP  → entry ABOVE current price
 *   BUY  LIMIT → entry BELOW  current price
 *   SELL STOP  → entry BELOW  current price
 *   SELL LIMIT → entry ABOVE  current price
 *
 * Returns null when there is no breakout or no price data.
 */
function getRecommendedOrderType() {
  if (!breakout) return null;
  const currentPrice = candles.length > 0 ? candles[candles.length - 1].close : null;
  if (currentPrice == null) return null;

  /* Use trade entry if available, otherwise fall back to breakout level */
  const entryLevel = trade ? trade.entry : breakout.level;

  if (breakout.dir === "BULL") {
    return entryLevel > currentPrice ? "BUY STOP" : "BUY LIMIT";
  }
  return entryLevel < currentPrice ? "SELL STOP" : "SELL LIMIT";
}

/* ── Public Feed Panel ── */
/**
 * Sync the #publicFeedPanel display to the current WebSocket state.
 * Called whenever wsStatus changes, on each tick, and during reconnects.
 *
 * @param {'disconnected'|'connecting'|'connected'|'reconnecting'|'error'} state
 * @param {object} [opts]  Optional overrides: { symbol, price }
 */
function updatePublicFeedPanel(state, opts = {}) {
  if (!UI.publicFeedStatus) return;

  const statusEl = UI.publicFeedStatus;

  switch (state) {
    case 'connected':
      statusEl.textContent = 'Connected ✅';
      statusEl.className   = 'public-feed-status connected';
      if (UI.startPublicFeedBtn) UI.startPublicFeedBtn.disabled = true;
      if (UI.stopPublicFeedBtn)  UI.stopPublicFeedBtn.disabled  = false;
      // Hide the "feed required" notice once connected
      if (UI.publicFeedPanel) UI.publicFeedPanel.classList.remove('pf-disconnected-state');
      break;
    case 'connecting':
      statusEl.textContent = 'Connecting…';
      statusEl.className   = 'public-feed-status connecting';
      if (UI.startPublicFeedBtn) UI.startPublicFeedBtn.disabled = true;
      if (UI.stopPublicFeedBtn)  UI.stopPublicFeedBtn.disabled  = true;
      if (UI.publicFeedPanel) UI.publicFeedPanel.classList.add('pf-disconnected-state');
      break;
    case 'reconnecting':
      statusEl.textContent = 'Reconnecting…';
      statusEl.className   = 'public-feed-status reconnecting';
      if (UI.startPublicFeedBtn) UI.startPublicFeedBtn.disabled = true;
      if (UI.stopPublicFeedBtn)  UI.stopPublicFeedBtn.disabled  = true;
      if (UI.publicFeedPanel) UI.publicFeedPanel.classList.add('pf-disconnected-state');
      break;
    case 'error':
      statusEl.textContent = 'Error ⚠';
      statusEl.className   = 'public-feed-status error';
      if (UI.startPublicFeedBtn) UI.startPublicFeedBtn.disabled = false;
      if (UI.stopPublicFeedBtn)  UI.stopPublicFeedBtn.disabled  = true;
      if (UI.publicFeedPanel) UI.publicFeedPanel.classList.add('pf-disconnected-state');
      break;
    default: // disconnected
      statusEl.textContent = 'Disconnected ❌';
      statusEl.className   = 'public-feed-status disconnected';
      if (UI.startPublicFeedBtn) UI.startPublicFeedBtn.disabled = false;
      if (UI.stopPublicFeedBtn)  UI.stopPublicFeedBtn.disabled  = true;
      if (UI.publicFeedPanel) UI.publicFeedPanel.classList.add('pf-disconnected-state');
      break;
  }

  // Update symbol / price if provided (comes from tick messages)
  if (opts.symbol != null && UI.pfSymbol)  UI.pfSymbol.textContent  = opts.symbol;
  if (opts.price  != null && UI.pfPrice)   UI.pfPrice.textContent   = opts.price;
}

/**
 * Record a tick arriving from the live feed and refresh the panel counters.
 * Call once per processed tick/OHLC message.
 *
 * @param {string} symbol
 * @param {string|number} price
 */
function recordPublicFeedTick(symbol, price) {
  publicFeedTickCount++;
  publicFeedLastUpdate = new Date();

  if (UI.pfTickCount)   UI.pfTickCount.textContent   = publicFeedTickCount.toLocaleString();
  if (UI.pfSymbol)      UI.pfSymbol.textContent      = symbol || '--';
  if (UI.pfPrice)       UI.pfPrice.textContent       = price  != null ? String(price) : '--';
  if (UI.pfLastUpdate)  UI.pfLastUpdate.textContent  = publicFeedLastUpdate.toLocaleTimeString();
}

function addLog(msg) {
  if (!UI.signalLog) return;
  const li = document.createElement("li");
  const now = new Date();
  /* Prefix with symbol when logging from a multi-panel context */
  const prefix = _multiPanelProcessing ? `[${_multiPanelProcessing}] ` : "";
  li.textContent = `[${now.toLocaleTimeString()}] ${prefix}${msg}`;
  UI.signalLog.prepend(li);
  while (UI.signalLog.children.length > 80) UI.signalLog.lastChild.remove();
  persistSignalLog();
}

function setPhase(newPhase) {
  const prevPhase = phase;
  phase = newPhase;

  /* Only update the main phase badge when NOT processing a non-focused panel */
  const isFocusedOrSingle = !_multiPanelProcessing || _multiPanelProcessing === focusedPanelSymbol;
  if (isFocusedOrSingle && UI.phaseLabel) {
    UI.phaseLabel.textContent = newPhase;
    UI.phaseLabel.className = "status-badge " + ({
      WAITING: "disabled", RANGE: "warning", BREAKOUT: "enabled",
      RETEST: "warning", INDECISION: "warning", CONFIRM: "enabled", TRADE: "bull"
    }[newPhase] || "disabled");
  }
  /* Play alert on meaningful phase transitions (live only, skip historical batch) */
  if (prevPhase !== newPhase && newPhase !== "WAITING" && !_historicalProcessing) {
    playPhaseAlert(newPhase);
    /* Send browser notification for focused panel or single mode */
    if (isFocusedOrSingle) sendPhaseNotification(newPhase);
    /* Also send notification for non-focused panels reaching TRADE (actionable) */
    if (!isFocusedOrSingle && newPhase === "TRADE") sendPhaseNotification(newPhase);
  }
  /* Auto-focus the panel that fired a TRADE signal so chart markup is visible.
     Only for live streaming signals — skip during historical batch processing. */
  if (prevPhase !== newPhase && newPhase === "TRADE" && _multiPanelProcessing && !_historicalProcessing) {
    const panelSymbol = _multiPanelProcessing;
    /* Defer focus until after savePanel() completes so panel state is up-to-date */
    const FOCUS_DELAY_MS = 50;
    setTimeout(() => {
      if (multiPanels.has(panelSymbol)) {
        focusPanel(panelSymbol);
        showToast("📈 TRADE Signal", `${getSymbolLabel(panelSymbol)} entered TRADE phase — chart focused`, "trade", 5000);
      }
    }, FOCUS_DELAY_MS);
  }

  /* Auto-send Telegram on TRADE phase — for ALL panels, not just focused.
     Only for live streaming signals — skip during historical batch processing. */
  if (prevPhase !== newPhase && newPhase === "TRADE" && !_historicalProcessing) {
    if (telegramAutoSend) {
      if (_multiPanelProcessing) {
        /* Multi-panel: use panel-specific Telegram send (mini-chart + panel state) */
        const panelSymbol = _multiPanelProcessing;
        const targetPanel = multiPanels.get(panelSymbol);
        if (targetPanel) targetPanel._tradeTelegramSent = true;
        addLog("📤 Telegram auto-send triggered — TRADE signal");
        setTimeout(() => sendPanelTelegramAlert(panelSymbol), CHART_RENDER_DELAY_MS);
      } else {
        /* Single-symbol mode: use main chart as before */
        addLog("📤 Telegram auto-send triggered — TRADE signal");
        setTimeout(() => sendTelegramAlert(), CHART_RENDER_DELAY_MS);
      }
    } else {
      /* Warn user that Telegram isn't configured when a TRADE fires */
      const { token, chatId } = getTelegramCredentials();
      if (!token || !chatId) {
        showToast("⚠️ Telegram Not Configured",
          "A TRADE signal fired but Telegram bot token / chat ID are not set. Configure in Settings → Telegram.",
          "warning", 8000);
      } else {
        showToast("ℹ️ Telegram Auto-Send Off",
          "A TRADE signal fired but Telegram auto-send is disabled. Enable it in Settings → Telegram.",
          "info", 6000);
      }
    }
  }
}

/* ================= SOUND & NOTIFICATIONS ================= */
function playPhaseAlert(phaseName) {
  if (!soundEnabled) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    const freqMap = {
      RANGE: 440, BREAKOUT: 660, RETEST: 550,
      INDECISION: 500, CONFIRM: 770, TRADE: 880
    };
    osc.frequency.value = freqMap[phaseName] || 440;
    osc.type = phaseName === "TRADE" ? "sine" : "triangle";
    gain.gain.value = 0.1;
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  } catch (e) { /* audio not available */ }
}

/**
 * Global notification throttle.  Prevents rapid-fire browser notifications
 * when multiple strategies / panels fire signals in quick succession.
 * Rules:
 *   1. At most NOTIFICATION_BURST_MAX notifications in any sliding
 *      NOTIFICATION_BURST_WINDOW_MS window.
 *   2. At least NOTIFICATION_COOLDOWN_MS between consecutive notifications.
 * Suppressed notifications are silently dropped (toast + sound still fire).
 */
function throttledNotification(title, body) {
  const now = Date.now();
  /* Prune timestamps outside the burst window */
  _notifTimestamps = _notifTimestamps.filter(t => now - t < NOTIFICATION_BURST_WINDOW_MS);

  /* Check cooldown since last notification */
  const lastNotifTime = _notifTimestamps[_notifTimestamps.length - 1];
  if (lastNotifTime && now - lastNotifTime < NOTIFICATION_COOLDOWN_MS) {
    return; /* too soon after the last notification */
  }
  /* Check burst limit */
  if (_notifTimestamps.length >= NOTIFICATION_BURST_MAX) {
    return; /* burst cap reached */
  }

  _notifTimestamps.push(now);
  new Notification(title, { body, icon: NOTIF_ICON });
}

function sendPhaseNotification(phaseName) {
  if (!notificationsEnabled || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  const symbol = _multiPanelProcessing || (UI.symbolSelect ? UI.symbolSelect.value : "");
  let body = `${symbol} moved to ${phaseName} phase`;
  /*
   * Append order-type hint for actionable phases:
   *   RETEST phase  = breakout just happened, waiting for retest → STOP orders
   *   INDECISION    = retest found, waiting for indecision       → LIMIT orders
   */
  const orderType = getRecommendedOrderType();
  if (orderType && (phaseName === "RETEST" || phaseName === "INDECISION")) {
    body += ` — ${orderType}`;
  }
  throttledNotification(`IT Guru Indicator: ${phaseName}`, body);
}

function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

/* ================= ON-SCREEN TOAST NOTIFICATIONS ================= */
/**
 * Show a non-blocking on-screen toast notification.
 * @param {string} title   – bold title text
 * @param {string} msg     – description text
 * @param {string} type    – "info" | "success" | "warning" | "trade"
 * @param {number} duration – auto-dismiss in ms (0 = manual dismiss only)
 */
function showToast(title, msg, type = "info", duration = 6000) {
  const container = UI.toastContainer || document.getElementById("toastContainer");
  if (!container) return;

  const iconMap = { info: "🔔", success: "✅", warning: "⚠️", trade: "📈" };
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;

  const iconSpan = document.createElement("span");
  iconSpan.className = "toast-icon";
  iconSpan.textContent = iconMap[type] || "🔔";

  const body = document.createElement("div");
  body.className = "toast-body";
  const titleDiv = document.createElement("div");
  titleDiv.className = "toast-title";
  titleDiv.textContent = title;
  const msgDiv = document.createElement("div");
  msgDiv.className = "toast-msg";
  msgDiv.textContent = msg;
  body.appendChild(titleDiv);
  body.appendChild(msgDiv);

  const closeBtn = document.createElement("button");
  closeBtn.className = "toast-close";
  closeBtn.setAttribute("aria-label", "Dismiss");
  closeBtn.textContent = "\u00D7";

  toast.appendChild(iconSpan);
  toast.appendChild(body);
  toast.appendChild(closeBtn);

  const dismiss = () => {
    toast.classList.add("toast-out");
    toast.addEventListener("animationend", () => toast.remove());
  };
  closeBtn.addEventListener("click", dismiss);
  container.appendChild(toast);

  /* Keep max 5 toasts on screen */
  while (container.children.length > 5) container.firstElementChild.remove();

  if (duration > 0) setTimeout(dismiss, duration);
}

/* ================= NY OPEN RANGE (9:30 AM EST) STRATEGY ================= */
/**
 * Convert current time to Eastern Time (EST/EDT-aware) using Intl.
 * Returns { hours, minutes } in ET.
 */
function getEasternTime() {
  const now = new Date();
  const etStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const parts = new Date(etStr);
  return { hours: parts.getHours(), minutes: parts.getMinutes(), seconds: parts.getSeconds() };
}

/**
 * Start the clock-checker interval that watches for 9:30 AM EST.
 * Fires a toast + browser notification when it's time.
 */
function startNyOpenRangeTimer() {
  if (_nyOpenRangeTimerInterval) return;
  _nyOpenRangeTimerInterval = setInterval(() => {
    if (!nyOpenRangeEnabled) return;
    const et = getEasternTime();
    /* Notify at 9:30 AM EST (once per day).
       Check the full minute window to avoid missing due to interval drift. */
    if (et.hours === 9 && et.minutes === 30 && !_nyOpenRangeNotified) {
      _nyOpenRangeNotified = true;
      nyOpenRangePhase = "RANGE";
      const sym = getActiveSymbol();
      showToast(
        "\uD83D\uDD64 9:30 AM EST \u2014 NY Open",
        `Market open! Analyzing ${sym} for the 9:30\u20139:35 opening range. Marking high & low\u2026`,
        "warning", 10000
      );
      sendPhaseNotification("NY_OPEN_RANGE");
      addLog("\uD83D\uDD64 NY Open Range: 9:30 AM EST reached \u2014 collecting 9:30\u20139:35 range");
      playPhaseAlert("RANGE");
      // Send Telegram notification for NY Open (only when auto-send is enabled)
      if (telegramAutoSend) {
        setTimeout(() => sendTelegramAlert(), CHART_RENDER_DELAY_MS);
      }
    }
    /* Reset notification flag after the window passes (after 9:36) so it can fire again tomorrow */
    if ((et.hours === 9 && et.minutes >= 36) || et.hours >= 10) {
      _nyOpenRangeNotified = false;
    }
  }, 5000);   /* check every 5 seconds */
}

function stopNyOpenRangeTimer() {
  if (_nyOpenRangeTimerInterval) {
    clearInterval(_nyOpenRangeTimerInterval);
    _nyOpenRangeTimerInterval = null;
  }
}

/**
 * Given candle data, determine if a candle falls within the 9:30–9:35 AM EST window.
 * Uses candle epoch (Unix seconds).
 */
function isInNyOpenWindow(epochSec) {
  const d = new Date(epochSec * 1000);
  const etStr = d.toLocaleString("en-US", { timeZone: "America/New_York" });
  const etDate = new Date(etStr);
  const h = etDate.getHours();
  const m = etDate.getMinutes();
  return (h === 9 && m >= 30 && m < 35);
}

/**
 * Build the NY Open Range from candle data (9:30–9:35 AM EST window).
 * Looks at all candles and finds those within the 5-min window.
 */
function buildNyOpenRange() {
  if (!nyOpenRangeEnabled || candles.length === 0) return;
  if (nyOpenRange) return;  /* already built */

  let high = -Infinity, low = Infinity;
  let startIdx = -1, endIdx = -1;
  let startEpoch = 0, endEpoch = 0;

  for (let i = 0; i < candles.length; i++) {
    if (isInNyOpenWindow(candles[i].epoch)) {
      if (startIdx < 0) {
        startIdx = i;
        startEpoch = candles[i].epoch;
      }
      if (candles[i].high > high) high = candles[i].high;
      if (candles[i].low < low)   low = candles[i].low;
      endIdx = i;
      endEpoch = candles[i].epoch;
    }
  }

  if (startIdx < 0 || high === -Infinity || candles.length === 0) return;

  /* Check if the window has closed (latest candle is past 9:35 AM EST) */
  const lastCandle = candles[candles.length - 1];
  if (!isInNyOpenWindow(lastCandle.epoch) && endIdx >= 0) {
    /* Window has passed — range is complete */
    nyOpenRange = { high, low, startIdx, endIdx, startEpoch, endEpoch };
    nyOpenRangePhase = "BREAKOUT";
    addLog(`🕤 NY Open Range set: High ${fmt(high, 4)}, Low ${fmt(low, 4)} (candles #${startIdx}–#${endIdx})`);
    showToast(
      "NY Open Range Set",
      `High: ${fmt(high, 4)} | Low: ${fmt(low, 4)} — Watching for breakout…`,
      "success", 8000
    );
  }
}

/**
 * Process a single candle through the NY Open Range strategy phases.
 * Called from processLatestCandle / processAllCandles alongside the main strategy.
 */
function processNyOpenRangeCandle(idx) {
  if (!nyOpenRangeEnabled || !nyOpenRange) return;
  const c = candles[idx];

  /* ---- PHASE: BREAKOUT — looking for candle whose entire body closes outside range ---- */
  if (nyOpenRangePhase === "BREAKOUT" && !nyOpenRangeBreakout) {
    if (idx <= nyOpenRange.endIdx) return;

    /* Require the entire candle body (both open AND close) to be outside the
       range — a wick poking out while the body stays inside does not count. */
    const bodyHigh = Math.max(c.open, c.close);
    const bodyLow  = Math.min(c.open, c.close);

    if (bodyLow > nyOpenRange.high) {
      nyOpenRangeBreakout = { dir: "BULL", candleIdx: idx, level: nyOpenRange.high };
      nyOpenRangePhase = "RETEST";
      addLog(`🕤 NY Open Range BULL breakout at #${idx}, body [${fmt(bodyLow, 4)}–${fmt(bodyHigh, 4)}] fully above high ${fmt(nyOpenRange.high, 4)}`);
      showToast("NY Range Breakout ▲", `Bullish breakout — waiting for retest…`, "info", 8000);
    } else if (bodyHigh < nyOpenRange.low) {
      nyOpenRangeBreakout = { dir: "BEAR", candleIdx: idx, level: nyOpenRange.low };
      nyOpenRangePhase = "RETEST";
      addLog(`🕤 NY Open Range BEAR breakout at #${idx}, body [${fmt(bodyLow, 4)}–${fmt(bodyHigh, 4)}] fully below low ${fmt(nyOpenRange.low, 4)}`);
      showToast("NY Range Breakout ▼", `Bearish breakout — waiting for retest…`, "info", 8000);
    }
    return;
  }

  /* ---- PHASE: RETEST — candle wicks back into range but does NOT close inside ---- */
  if (nyOpenRangePhase === "RETEST" && nyOpenRangeBreakout && !nyOpenRangeRetest) {
    if (idx <= nyOpenRangeBreakout.candleIdx) return;

    const rangeH = nyOpenRange.high;
    const rangeL = nyOpenRange.low;
    const dir    = nyOpenRangeBreakout.dir;

    let wicksIntoRange = false;
    let closedInsideRange = (c.close >= rangeL && c.close <= rangeH);

    if (dir === "BULL") {
      /* For bull: candle low must dip into the range (between rangeL and rangeH),
         but close must remain above the range high */
      wicksIntoRange = (c.low <= rangeH && c.low >= rangeL);
    } else {
      /* For bear: candle high must poke into the range (between rangeL and rangeH),
         but close must remain below the range low */
      wicksIntoRange = (c.high >= rangeL && c.high <= rangeH);
    }

    if (wicksIntoRange && !closedInsideRange) {
      /* Valid retest! */
      nyOpenRangeRetest = { candleIdx: idx };

      /* Min Confluence Gate — override any per-strategy hardcoded threshold when enabled */
      if (minConfluenceEnabled) {
        const confScore = computeConfluenceScore(dir, c.close, idx);
        if (confScore < minConfluenceValue) {
          addLog(`⚠ NY Open Range REJECTED — confluence ${confScore}/${minConfluenceValue} below minimum`);
          nyOpenRangeRetest = null;
          return;
        }
      }

      nyOpenRangePhase = "TRADE";

      /* Build the trade: SL at midpoint, TP at profit-optimized R:R */
      const midpoint = (rangeH + rangeL) / 2;
      const entry    = c.close;
      const sl       = midpoint;
      const risk     = Math.abs(entry - sl);
      const _profParams = getStrategyProfitParams();

      if (risk > 0) {
        const tp = dir === "BULL" ? entry + risk * _profParams.rrLiquiditySweep : entry - risk * _profParams.rrLiquiditySweep;
        const rr = _profParams.rrLiquiditySweep;
        nyOpenRangeTrade = { entry, sl, tp, dir, rr, entryIdx: idx, candleIdx: idx, symbol: getActiveSymbol(), result: "PENDING", epoch: c.epoch, type: "ny_open_range", _stratOutcomeSent: false, _sentViaTelegram: (telegramStrategyAutoSend && !_historicalProcessing) };

        /* Push to history for strategy alerts panel */
        nyOpenRangeHistory.unshift(nyOpenRangeTrade);
        if (nyOpenRangeHistory.length > NY_OPEN_RANGE_MAX_HISTORY) nyOpenRangeHistory.pop();

        addLog(`🕤 NY Open Range TRADE: ${dir} entry ${fmtPrice(entry, getActiveSymbol())}, SL ${fmtPrice(sl, getActiveSymbol())} (midpoint), TP ${fmtPrice(tp, getActiveSymbol())} (1:2 R:R)`);
        showToast(
          `NY Range Entry ${dir === "BULL" ? "▲ BUY" : "▼ SELL"}`,
          `Entry: ${fmtPrice(entry, getActiveSymbol())} | SL: ${fmtPrice(sl, getActiveSymbol())} | TP: ${fmtPrice(tp, getActiveSymbol())} | R:R 1:2`,
          "trade", 12000
        );
        playPhaseAlert("TRADE");
        sendPhaseNotification("TRADE");

        /* Telegram strategy alert */
        if (telegramStrategyAutoSend && !_historicalProcessing) {
          setTimeout(() => sendTelegramStrategyAlert(nyOpenRangeTrade), CHART_RENDER_DELAY_MS);
        }

        renderStrategyAlerts();

        /* Auto-trade: place a Deriv multiplier contract for NY Open Range */
        if (autoTradeStrategyEnabled && autoTradeNYOpenRange && !_historicalProcessing) {
          executeAutoTrade({ dir, entry, sl, tp, symbol: getActiveSymbol(), source: "strategy", strategyName: "nyOpenRange" });
        }
      }
    }
    return;
  }
}

/**
 * Reset NY Open Range state for a new session / day.
 */
function resetNyOpenRange() {
  nyOpenRange         = null;
  nyOpenRangeBreakout = null;
  nyOpenRangeRetest   = null;
  nyOpenRangeTrade    = null;
  nyOpenRangePhase    = nyOpenRangeEnabled ? "WAITING" : "IDLE";
}

/**
 * Monitor the NY Open Range trade on each candle tick.
 * Records WIN when TP is hit, LOSS when SL is hit.
 * Clears the trade (auto-reset) so the range can be re-used if needed.
 */
function monitorNyOpenRangeTradeOutcome(candle) {
  if (!nyOpenRangeEnabled || !nyOpenRangeTrade) return;
  if (nyOpenRangeTrade.result !== "PENDING") return;

  const t = nyOpenRangeTrade;

  /* Track 1R profit level and fire exit alert if price reverses to entry */
  if (_checkProfitExitAlert(t, candle, "NY Open Range")) {
    /* no `changed` flag needed here — not an array-based monitor */
  }

  let result = null;

  if (t.dir === "BULL") {
    const nySlHit = candle.low <= t.sl, nyTpHit = candle.high >= t.tp;
    if (nySlHit && nyTpHit)     result = resolveBothHit(t);
    else if (nySlHit)           result = "LOSS";
    else if (nyTpHit)           result = "WIN";
  } else {
    const nySlHit = candle.high >= t.sl, nyTpHit = candle.low <= t.tp;
    if (nySlHit && nyTpHit)     result = resolveBothHit(t);
    else if (nySlHit)           result = "LOSS";
    else if (nyTpHit)           result = "WIN";
  }

  if (!result) return;

  t.result = result;
  if (result === "WIN") nyOpenRangeTradeWins++;
  else                  nyOpenRangeTradeLosses++;

  const dirLabel = t.dir === "BULL" ? "BUY" : "SELL";
  const icon = result === "WIN" ? "✅" : "❌";
  addLog(`🕤 NY Open Range ${icon} ${result} — ${dirLabel} entry ${fmt(t.entry, 4)}, hit ${result === "WIN" ? "TP" : "SL"} @ ${fmt(result === "WIN" ? t.tp : t.sl, 4)} | W:${nyOpenRangeTradeWins} L:${nyOpenRangeTradeLosses}`);
  showToast(
    `NY Range ${result}`,
    `${dirLabel} trade hit ${result === "WIN" ? "TP" : "SL"} — Entry: ${fmt(t.entry, 4)}`,
    result === "WIN" ? "trade" : "warning", 8000
  );
  playPhaseAlert(result === "WIN" ? "TRADE" : "RANGE");

  /* Update the history entry result so the alerts panel shows the outcome */
  const histEntry = nyOpenRangeHistory.find(h => h === t);
  if (histEntry) {
    histEntry.result = result;
    /* Gated on _sentViaTelegram so historical signals do not generate outcome alerts. */
    if (!histEntry._stratOutcomeSent && histEntry._sentViaTelegram === true) {
      sendStrategyOutcomeTelegram(histEntry);
    }
  }
  renderStrategyAlerts();

  /* Auto-reset so the session can accept a new setup if the trade resolves early */
  nyOpenRangeTrade = null;
}

/* ================= SESSION RANGES (Asian / London / NY) ================= */

/**
 * Determine which trading session a candle belongs to based on its UTC hour.
 * Returns an object with boolean flags for each session.
 */
function getCandleSessionFlags(epochSec) {
  const d = new Date(epochSec * 1000);
  const hour = d.getUTCHours();
  return {
    asian:  hour >= SESSION_ASIAN.start  && hour < SESSION_ASIAN.end,
    london: hour >= SESSION_LONDON.start && hour < SESSION_LONDON.end,
    ny:     hour >= SESSION_NEW_YORK.start && hour < SESSION_NEW_YORK.end
  };
}

/**
 * Build session ranges (Asian, London, NY) from candle data.
 * Each range captures the high/low of candles that fall within the session's UTC hours.
 * Only builds ranges for today's date (based on the latest candle).
 */
function buildSessionRanges() {
  if (!sessionRangesEnabled || candles.length === 0) return;

  /* Determine "today" from the latest candle */
  const latestDate = new Date(candles[candles.length - 1].epoch * 1000);
  const todayUTC = latestDate.toISOString().slice(0, 10); /* YYYY-MM-DD */

  /* Trading-day rollover guard: this function only ever scans candles from
     "today" (see loop below), so once UTC date changes, stale ranges from
     the prior day (asian/london/ny highs+lows) as well as londonSweepSignal
     from the prior day must be cleared — otherwise detectLondonAsianSweep()'s
     `if (londonSweepSignal) return;` gate stays latched forever and no new
     sweep is ever detected again for this symbol/panel. Only clear when no
     trade is actively PENDING so an open position is never dropped mid-flight. */
  if (lastSessionRangeBuildDate !== null && lastSessionRangeBuildDate !== todayUTC) {
    if (!sessionRangeTrade || sessionRangeTrade.result !== "PENDING") {
      resetSessionRanges();
    }
  }
  lastSessionRangeBuildDate = todayUTC;

  let asianHigh = -Infinity, asianLow = Infinity, asianStart = -1, asianEnd = -1;
  let londonHigh = -Infinity, londonLow = Infinity, londonStart = -1, londonEnd = -1;
  let nyHigh = -Infinity, nyLow = Infinity, nyStart = -1, nyEnd = -1;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const d = new Date(c.epoch * 1000);
    const dateStr = d.toISOString().slice(0, 10);
    /* Only consider candles from today */
    if (dateStr !== todayUTC) continue;

    const flags = getCandleSessionFlags(c.epoch);

    if (flags.asian) {
      if (asianStart < 0) asianStart = i;
      asianEnd = i;
      if (c.high > asianHigh) asianHigh = c.high;
      if (c.low < asianLow)   asianLow = c.low;
    }
    if (flags.london) {
      if (londonStart < 0) londonStart = i;
      londonEnd = i;
      if (c.high > londonHigh) londonHigh = c.high;
      if (c.low < londonLow)   londonLow = c.low;
    }
    if (flags.ny) {
      if (nyStart < 0) nyStart = i;
      nyEnd = i;
      if (c.high > nyHigh) nyHigh = c.high;
      if (c.low < nyLow)   nyLow = c.low;
    }
  }

  /* Set ranges (only if we found candles for that session) */
  sessionRangeAsian  = asianStart  >= 0 && asianHigh  !== -Infinity
    ? { high: asianHigh,  low: asianLow,  startIdx: asianStart,  endIdx: asianEnd }  : null;
  sessionRangeLondon = londonStart >= 0 && londonHigh !== -Infinity
    ? { high: londonHigh, low: londonLow, startIdx: londonStart, endIdx: londonEnd } : null;
  sessionRangeNY     = nyStart     >= 0 && nyHigh     !== -Infinity
    ? { high: nyHigh,     low: nyLow,     startIdx: nyStart,     endIdx: nyEnd }     : null;

  /* Determine if Asian range is "tight" (< ATR threshold) */
  const wasTight = asianRangeTight;
  if (sessionRangeAsian && atrValue > 0) {
    const asianSize = sessionRangeAsian.high - sessionRangeAsian.low;
    asianRangeTight = asianSize < atrValue * ASIAN_TIGHT_ATR_MULT;
  } else {
    asianRangeTight = false;
  }

  /* Send Telegram alert on first detection of tight Asian range */
  if (asianRangeTight && !wasTight && telegramSessionRangeAutoSend && !_historicalProcessing) {
    const currentPanelSymbol = _multiPanelProcessing || null;
    setTimeout(() => sendTelegramSessionRangeAlert("TIGHT_ASIAN", currentPanelSymbol), CHART_RENDER_DELAY_MS);
  }
}

/**
 * Detect London session sweeping the Asian range high or low.
 * A "sweep" occurs when a London-session candle's wick exceeds the Asian high or low
 * but the candle body closes back inside the Asian range — a liquidity grab.
 * Also detects a clean break (close outside) as a sweep signal.
 */
function detectLondonAsianSweep() {
  if (!sessionRangesEnabled || !sessionRangeAsian || !sessionRangeLondon) return;
  if (londonSweepSignal) return; /* already detected for this session */

  const aH = sessionRangeAsian.high;
  const aL = sessionRangeAsian.low;

  /* Scan London candles after Asian range ends */
  const scanStart = Math.max(sessionRangeLondon.startIdx, sessionRangeAsian.endIdx + 1);
  const scanEnd   = Math.min(sessionRangeLondon.endIdx, candles.length - 1);
  if (scanStart > scanEnd) return;  /* no London candles past Asian range yet */

  for (let i = scanStart; i <= scanEnd; i++) {
    const c = candles[i];
    /* Check sweep of Asian HIGH — bearish reversal (SELL).
       A true liquidity grab requires the wick to exceed the Asian high but the
       candle to close back at or below it (rejection = bearish reversal signal).
       A clean close above the Asian high is a breakout, not a sweep. */
    if (c.high > aH && c.close <= aH) {
      londonSweepSignal = { dir: "HIGH", candleIdx: i, price: c.high };

      /* Compute trade levels: Entry at candle close, SL above the sweep wick,
         TP based on user-inputted R:R ratio below entry */
      const entry = c.close;
      const sl    = c.high;                        /* SL above the sweep wick */
      const risk  = Math.abs(sl - entry);
      if (risk > 0) {
        /* Min Confluence Gate — override any per-strategy hardcoded threshold when enabled */
        if (minConfluenceEnabled) {
          const confScore = computeConfluenceScore("BEAR", entry, i);
          if (confScore < minConfluenceValue) {
            addLog(`⚠ London Sweep SELL REJECTED — confluence ${confScore}/${minConfluenceValue} below minimum`);
            londonSweepSignal = null;
            return;
          }
        }

        const userRisk   = parseFloat(UI.riskInput   && UI.riskInput.value)   || 1;
        const userReward = parseFloat(UI.rewardInput  && UI.rewardInput.value) || 2;
        const rr  = userReward / userRisk;
        const tp  = entry - risk * rr;
        sessionRangeTrade = { entry, sl, tp, dir: "BEAR", rr, entryIdx: i, candleIdx: i, symbol: getActiveSymbol(), result: "PENDING", epoch: c.epoch, type: "session_range", _stratOutcomeSent: false, _sentViaTelegram: (telegramStrategyAutoSend && !_historicalProcessing) };

        /* Push to history for strategy alerts panel */
        sessionRangeHistory.unshift(sessionRangeTrade);
        if (sessionRangeHistory.length > SESSION_RANGE_MAX_HISTORY) sessionRangeHistory.pop();

        addLog(`🌍 London Sweep TRADE: SELL entry ${fmtPrice(entry, getActiveSymbol())}, SL ${fmtPrice(sl, getActiveSymbol())}, TP ${fmtPrice(tp, getActiveSymbol())} (1:${fmt(rr, 1)} R:R)`);
        showToast(
          "London Sweep ▼ SELL Signal",
          `Entry: ${fmtPrice(entry, getActiveSymbol())} | SL: ${fmtPrice(sl, getActiveSymbol())} | TP: ${fmtPrice(tp, getActiveSymbol())} | R:R 1:${fmt(rr, 1)}\nSwept Asian high ${fmtPrice(aH, getActiveSymbol())} — bearish reversal`,
          "trade", 12000
        );

        /* Auto-trade: place a Deriv multiplier contract for London Sweep SELL */
        if (autoTradeStrategyEnabled && autoTradeSessionRange && !_historicalProcessing) {
          executeAutoTrade({ dir: "BEAR", entry, sl, tp, symbol: getActiveSymbol(), source: "strategy", strategyName: "sessionRange" });
        }

        /* Telegram strategy alert */
        if (telegramStrategyAutoSend && !_historicalProcessing) {
          setTimeout(() => sendTelegramStrategyAlert(sessionRangeTrade), CHART_RENDER_DELAY_MS);
        }

        renderStrategyAlerts();
      } else {
        sessionRangeTrade = null;
        addLog(`🌍 London Sweep: Asian HIGH swept at candle #${i} (high ${fmt(c.high, 4)} > ${fmt(aH, 4)})`);
        showToast(
          "London Sweep ▲ Asian High",
          `Candle #${i} swept Asian high ${fmt(aH, 4)} — potential bearish reversal`,
          "warning", 8000
        );
      }
      if (telegramSessionRangeAutoSend && !_historicalProcessing) {
        const currentPanelSymbol = _multiPanelProcessing || null;
        setTimeout(() => sendTelegramSessionRangeAlert("LONDON_SWEEP", currentPanelSymbol), CHART_RENDER_DELAY_MS);
      }
      return;
    }
    /* Check sweep of Asian LOW — bullish reversal (BUY).
       A true liquidity grab requires the wick to dip below the Asian low but the
       candle to close back at or above it (rejection = bullish reversal signal).
       A clean close below the Asian low is a breakout, not a sweep. */
    if (c.low < aL && c.close >= aL) {
      londonSweepSignal = { dir: "LOW", candleIdx: i, price: c.low };

      /* Compute trade levels: Entry at candle close, SL below the sweep wick,
         TP based on user-inputted R:R ratio above entry */
      const entry = c.close;
      const sl    = c.low;                         /* SL below the sweep wick */
      const risk  = Math.abs(entry - sl);
      if (risk > 0) {
        /* Min Confluence Gate — override any per-strategy hardcoded threshold when enabled */
        if (minConfluenceEnabled) {
          const confScore = computeConfluenceScore("BULL", entry, i);
          if (confScore < minConfluenceValue) {
            addLog(`⚠ London Sweep BUY REJECTED — confluence ${confScore}/${minConfluenceValue} below minimum`);
            londonSweepSignal = null;
            return;
          }
        }

        const userRisk   = parseFloat(UI.riskInput   && UI.riskInput.value)   || 1;
        const userReward = parseFloat(UI.rewardInput  && UI.rewardInput.value) || 2;
        const rr  = userReward / userRisk;
        const tp  = entry + risk * rr;
        sessionRangeTrade = { entry, sl, tp, dir: "BULL", rr, entryIdx: i, candleIdx: i, symbol: getActiveSymbol(), result: "PENDING", epoch: c.epoch, type: "session_range", _stratOutcomeSent: false, _sentViaTelegram: (telegramStrategyAutoSend && !_historicalProcessing) };

        /* Push to history for strategy alerts panel */
        sessionRangeHistory.unshift(sessionRangeTrade);
        if (sessionRangeHistory.length > SESSION_RANGE_MAX_HISTORY) sessionRangeHistory.pop();

        addLog(`🌍 London Sweep TRADE: BUY entry ${fmtPrice(entry, getActiveSymbol())}, SL ${fmtPrice(sl, getActiveSymbol())}, TP ${fmtPrice(tp, getActiveSymbol())} (1:${fmt(rr, 1)} R:R)`);
        showToast(
          "London Sweep ▲ BUY Signal",
          `Entry: ${fmtPrice(entry, getActiveSymbol())} | SL: ${fmtPrice(sl, getActiveSymbol())} | TP: ${fmtPrice(tp, getActiveSymbol())} | R:R 1:${fmt(rr, 1)}\nSwept Asian low ${fmtPrice(aL, getActiveSymbol())} — bullish reversal`,
          "trade", 12000
        );

        /* Auto-trade: place a Deriv multiplier contract for London Sweep BUY */
        if (autoTradeStrategyEnabled && autoTradeSessionRange && !_historicalProcessing) {
          executeAutoTrade({ dir: "BULL", entry, sl, tp, symbol: getActiveSymbol(), source: "strategy", strategyName: "sessionRange" });
        }

        /* Telegram strategy alert */
        if (telegramStrategyAutoSend && !_historicalProcessing) {
          setTimeout(() => sendTelegramStrategyAlert(sessionRangeTrade), CHART_RENDER_DELAY_MS);
        }

        renderStrategyAlerts();
      } else {
        sessionRangeTrade = null;
        addLog(`🌍 London Sweep: Asian LOW swept at candle #${i} (low ${fmt(c.low, 4)} < ${fmt(aL, 4)})`);
        showToast(
          "London Sweep ▼ Asian Low",
          `Candle #${i} swept Asian low ${fmt(aL, 4)} — potential bullish reversal`,
          "warning", 8000
        );
      }
      if (telegramSessionRangeAutoSend && !_historicalProcessing) {
        const currentPanelSymbol = _multiPanelProcessing || null;
        setTimeout(() => sendTelegramSessionRangeAlert("LONDON_SWEEP", currentPanelSymbol), CHART_RENDER_DELAY_MS);
      }
      return;
    }
  }
}

/**
 * Reset all session range state.
 */
function resetSessionRanges() {
  sessionRangeAsian   = null;
  sessionRangeLondon  = null;
  sessionRangeNY      = null;
  asianRangeTight     = false;
  londonSweepSignal   = null;
  sessionRangeTrade   = null;
}

/**
 * Monitor session range trade outcome on each candle update.
 * Checks if price has hit SL or TP, records result, sends Telegram
 * outcome notification, and auto-resets so new signals can be detected.
 */
function monitorSessionRangeTradeOutcome(candle) {
  if (!sessionRangesEnabled || !sessionRangeTrade) return;
  if (sessionRangeTrade.result && sessionRangeTrade.result !== "PENDING") return;

  const srt = sessionRangeTrade;

  /* Track 1R profit level and fire exit alert if price reverses to entry */
  if (srt.result === "PENDING") {
    _checkProfitExitAlert(srt, candle, "Session Range");
  }

  let result = null;

  if (srt.dir === "BULL") {
    /* BUY trade: SL below entry, TP above entry */
    const srSlHit = candle.low <= srt.sl;
    const srTpHit = srt.tp !== null && srt.tp !== undefined && candle.high >= srt.tp;
    if (srSlHit && srTpHit)     result = resolveBothHit(srt);
    else if (srSlHit)           result = "LOSS";
    else if (srTpHit)           result = "WIN";
  } else {
    /* SELL trade: SL above entry, TP below entry */
    const srSlHit = candle.high >= srt.sl;
    const srTpHit = srt.tp !== null && srt.tp !== undefined && candle.low <= srt.tp;
    if (srSlHit && srTpHit)     result = resolveBothHit(srt);
    else if (srSlHit)           result = "LOSS";
    else if (srTpHit)           result = "WIN";
  }

  if (!result) return;

  /* Record outcome */
  if (result === "WIN") sessionRangeTradeWins++;
  else sessionRangeTradeLosses++;

  srt.result = result;

  const dirLabel = srt.dir === "BULL" ? "BUY" : "SELL";
  const icon = result === "WIN" ? "✅" : "❌";
  addLog(`🌍 Session Range ${icon} ${result} — ${dirLabel} entry ${fmt(srt.entry, 4)}, SL ${fmt(srt.sl, 4)}, TP ${fmt(srt.tp, 4)}`);
  showToast(
    `Session Range ${result}`,
    `${dirLabel} trade hit ${result === "WIN" ? "TP" : "SL"} — Entry: ${fmt(srt.entry, 4)}`,
    result === "WIN" ? "trade" : "warning", 8000
  );
  playPhaseAlert(result === "WIN" ? "TRADE" : "RANGE");

  /* Update the history entry and send Telegram outcome */
  const histEntry = sessionRangeHistory.find(h => h === srt);
  if (histEntry) {
    histEntry.result = result;
    /* Only send via the general strategy channel when the dedicated session-range
       outcome channel is off — if both are on, the dedicated send below is sufficient
       and prevents subscribers receiving two identical messages. (Bug #6 fix)
       Also gated on _sentViaTelegram so historical signals do not send. (Bug #12) */
    if (!histEntry._stratOutcomeSent && !telegramSessionRangeOutcomeSend && histEntry._sentViaTelegram === true) {
      sendStrategyOutcomeTelegram(histEntry);
    }
  }
  renderStrategyAlerts();

  /* Send dedicated session range outcome via the session-range Telegram channel */
  if (telegramSessionRangeOutcomeSend && !_historicalProcessing) {
    const resolvedTrade = { ...srt, result };
    const currentPanelSymbol = _multiPanelProcessing || null;
    setTimeout(() => sendSessionRangeOutcomeTelegram(resolvedTrade, currentPanelSymbol), 100);
  }

  /* Auto-reset: clear the trade so the session can continue.
     Keep londonSweepSignal set so detectLondonAsianSweep() won't
     re-detect the same sweep and loop alerts on every tick.
     londonSweepSignal is properly cleared at session boundaries
     via resetSessionRanges(). */
  sessionRangeTrade = null;
}

/**
 * Send session range trade outcome (WIN / LOSS) via Telegram.
 * @param {Object} resolvedTrade  — { entry, sl, tp, dir, rr, symbol, result }
 * @param {string|null} panelSymbol — if non-null, identifies multi-panel source
 */
async function sendSessionRangeOutcomeTelegram(resolvedTrade, panelSymbol) {
  if (!telegramSessionRangeOutcomeSend) return;
  if (resolvedTrade.result && !canSendTradeResolutionNotification(resolvedTrade, resolvedTrade.result)) return;

  /* Sync credentials from DOM */
  if (UI.telegramBotToken) telegramBotToken = UI.telegramBotToken.value;
  if (UI.telegramChatId) telegramChatId = UI.telegramChatId.value;

  try {
    const { token, chatId } = getTelegramCredentials();
    validateTelegramCredentials(token, chatId);
  } catch (err) {
    addLog(`📤 Session Range outcome Telegram skipped: ${err.message}`);
    return;
  }

  try {
    const sym = getSymbolLabel(resolvedTrade.symbol || panelSymbol || getActiveSymbol() || "");
    const activeSym = resolvedTrade.symbol || panelSymbol || getActiveSymbol() || "";
    const dir = resolvedTrade.dir === "BULL" ? "📈 BUY" : "📉 SELL";
    const result = resolvedTrade.result;
    const icon = result === "WIN" ? "✅" : "❌";
    const entryStr = resolvedTrade.entry != null ? fmtPrice(resolvedTrade.entry, activeSym) : "--";
    const slStr = resolvedTrade.sl != null ? fmtPrice(resolvedTrade.sl, activeSym) : "--";
    const tpStr = resolvedTrade.tp != null ? fmtPrice(resolvedTrade.tp, activeSym) : "--";
    const rrStr = resolvedTrade.rr != null ? "1:" + fmt(resolvedTrade.rr, 1) : "--";
    const risk = Math.abs(resolvedTrade.entry - resolvedTrade.sl);

    const lines = [];
    lines.push(`${icon} <b>Session Range ${result}</b> — ${dir} ${sym}`);
    lines.push("");
    lines.push(`<b>🌍 London Sweep Trade</b>`);
    lines.push(`<b>📍 Entry:</b> <code>${entryStr}</code>`);
    lines.push(`<b>🛑 SL:</b> <code>${slStr}</code>`);
    lines.push(`<b>🎯 TP:</b> <code>${tpStr}</code>`);
    lines.push(`<b>R:R:</b> ${rrStr}`);
    if (risk > 0) {
      lines.push(`<b>Risk (pips):</b> <code>${fmt(risk, 5)}</code>`);
    }

    /* Lot size / position sizing based on account amount */
    if (accountSize > 0 && riskPercent > 0 && resolvedTrade.entry != null && resolvedTrade.sl != null) {
      const tradeObj = { entry: resolvedTrade.entry, sl: resolvedTrade.sl, tp: resolvedTrade.tp, rr: resolvedTrade.rr || 0, symbol: resolvedTrade.symbol || getActiveSymbol() };
      const m = calcPositionMetrics(tradeObj);
      if (m) {
        lines.push(``);
        lines.push(`<b>📦 Lot Size:</b> ${fmt(m.lotSize, 2)}`);
        lines.push(`<b>💰 $ Risk:</b> $${fmt(m.dollarRisk, 2)}`);
        if (resolvedTrade.tp != null) lines.push(`<b>💰 $ Reward:</b> $${fmt(m.dollarReward, 2)}`);
        if (!m.isSynthetic) {
          lines.push(`<b>📏 Pips at Risk:</b> ${fmt(m.pips, 1)}`);
        }
      }
    }

    /* Win/loss tally */
    const totalW = sessionRangeTradeWins;
    const totalL = sessionRangeTradeLosses;
    const wr = (totalW + totalL) > 0 ? (totalW / (totalW + totalL) * 100).toFixed(1) + "%" : "N/A";
    lines.push("");
    lines.push(`🌍 <b>Session Range Record:</b> ${totalW}W / ${totalL}L (${wr} win rate)`);
    lines.push(`<i>${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC</i>`);

    await sendTelegramMessage(lines.join("\n"));
    addLog(`📤 Telegram: Session Range outcome (${result}) sent`);
  } catch (err) {
    addLog(`📤 Session Range outcome Telegram error: ${err.message}`);
  }
}

/* ================= TELEGRAM INTEGRATION ================= */

/**
 * Shared helper: render drawChart() on a high-res offscreen canvas and
 * return a Promise<Blob>.  Sets up canvas, mocks DPR, swaps UI refs,
 * calls drawChart(), then restores everything.
 */
function _renderChartToBlob() {
  return new Promise((resolve, reject) => {
    const EW = TELEGRAM_EXPORT_WIDTH;
    const EH = TELEGRAM_EXPORT_HEIGHT;

    const offscreen = document.createElement("canvas");
    offscreen.width  = EW;
    offscreen.height = EH;
    const offCtx = offscreen.getContext("2d");
    if (!offCtx) return reject(new Error("Canvas context unavailable"));

    /* Override getBoundingClientRect so drawChart() sees the export
       dimensions rather than 0×0 (the default for an unmounted element). */
    offscreen.getBoundingClientRect = () => ({
      x: 0, y: 0, top: 0, left: 0, right: EW, bottom: EH,
      width: EW, height: EH, toJSON() { return this; }
    });

    /* Freeze the width/height IDL attributes at EW×EH so that even if
       drawChart() assigns the same numeric value (which some browsers still
       treat as a resize+clear), the native setter is never called and the
       canvas bitmap is not wiped after we have drawn on it.  The context
       is cleared with ctx.clearRect() inside drawChart() anyway. */
    try {
      Object.defineProperty(offscreen, "width",  {
        get() { return EW; }, set() {}, configurable: true
      });
      Object.defineProperty(offscreen, "height", {
        get() { return EH; }, set() {}, configurable: true
      });
    } catch (e) {
      /* If the browser prevents overriding these IDL attributes the native
         setter may still run, but drawChart()'s getBoundingClientRect fallback
         (canvas.width / dpr) ensures the canvas is still sized correctly. */
      console.warn("_renderChartToBlob: could not freeze canvas dimensions:", e.message);
    }

    const origCanvas = UI.canvas;
    const origCtx    = UI.ctx;
    const origDpr    = window.devicePixelRatio;

    try {
      Object.defineProperty(window, "devicePixelRatio",
        { value: 1, writable: true, configurable: true });
    } catch (e) {
      /* Non-configurable in some environments — drawChart() handles this via
         the canvas.width/dpr fallback and getBoundingClientRect mock. */
      console.warn("_renderChartToBlob: could not mock devicePixelRatio:", e.message);
    }

    UI.canvas = offscreen;
    UI.ctx    = offCtx;

    try { drawChart(); } finally {
      UI.canvas = origCanvas;
      UI.ctx    = origCtx;
      try {
        Object.defineProperty(window, "devicePixelRatio",
          { value: origDpr, writable: true, configurable: true });
      } catch (_) { /* ignore restore failure */ }
    }

    offscreen.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error("Failed to capture chart screenshot"));
    }, "image/png");
  });
}

/**
 * Render the full main chart at high resolution on an offscreen canvas
 * and return a PNG Blob — used for crisp Telegram screenshots.
 */
function captureChartScreenshot() {
  return _renderChartToBlob();
}

/**
 * Build a formatted Telegram caption with all trade/setup info.
 * Uses Telegram HTML parse mode for formatting.
 */
function buildTelegramCaption() {
  const activeSym = getActiveSymbol() || "";
  const symbol = UI.symbolSelect
    ? (UI.symbolSelect.options[UI.symbolSelect.selectedIndex]
       ? UI.symbolSelect.options[UI.symbolSelect.selectedIndex].text
       : UI.symbolSelect.value)
    : "--";
  const gran = UI.granSelect ? UI.granSelect.value : "--";
  const tfLabel = TIMEFRAME_LABELS[gran] || gran + "s";
  const dir = breakout ? breakout.dir : "--";
  const orderType = getRecommendedOrderType() || "--";
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  let lines = [];
  lines.push(`<b>📊 IT Guru Signal</b>`);
  lines.push(``);
  lines.push(`<b>Symbol:</b> ${symbol}`);
  lines.push(`<b>Timeframe:</b> ${tfLabel}`);
  lines.push(`<b>Phase:</b> ${phase}`);
  lines.push(`<b>Direction:</b> ${dir === "BULL" ? "🟢 BULL (BUY)" : dir === "BEAR" ? "🔴 BEAR (SELL)" : dir}`);
  lines.push(`<b>Order Type:</b> ${orderType}`);

  if (trade) {
    lines.push(``);
    lines.push(`<b>📍 Entry:</b> <code>${fmtPrice(trade.entry, activeSym)}</code>`);
    lines.push(`<b>🛑 SL:</b> <code>${fmtPrice(trade.sl, activeSym)}</code>`);
    if (trade.tp != null && !pureTrailingEnabled) {
      lines.push(`<b>🎯 TP:</b> <code>${fmtPrice(trade.tp, activeSym)}</code>`);
    }
    if (trade.rr != null) {
      lines.push(`<b>R:R:</b> 1:${fmt(trade.rr, 1)}`);
    }
    if (accountSize > 0 && riskPercent > 0) {
      const m = calcPositionMetrics(trade);
      if (m) {
        lines.push(`<b>💰 $ Risk:</b> $${fmt(m.dollarRisk, 2)}`);
        if (trade.tp != null) lines.push(`<b>💰 $ Reward:</b> $${fmt(m.dollarReward, 2)}`);
        lines.push(`<b>📦 Lot Size:</b> ${fmt(m.lotSize, 2)}`);
        if (!m.isSynthetic) {
          lines.push(`<b>📏 Pips at Risk:</b> ${fmt(m.pips, 1)}`);
        }
      }
    }
    if (trailingSL != null && trailingStopEnabled) {
      lines.push(`<b>Trailing SL:</b> <code>${fmtPrice(trailingSL, activeSym)}</code>`);
    }
  }

  if (openingRange) {
    lines.push(``);
    lines.push(`<b>Range High:</b> <code>${fmtPrice(openingRange.high, activeSym)}</code>`);
    lines.push(`<b>Range Low:</b> <code>${fmtPrice(openingRange.low, activeSym)}</code>`);
  }

  /* Session Ranges context */
  if (sessionRangesEnabled && sessionRangeAsian) {
    lines.push(``);
    lines.push(`<b>🌍 Session Ranges:</b>`);
    lines.push(`  Asian: <code>${fmtPrice(sessionRangeAsian.high, activeSym)}</code> / <code>${fmtPrice(sessionRangeAsian.low, activeSym)}</code>${asianRangeTight ? " ⚡TIGHT" : ""}`);
    if (sessionRangeLondon) {
      lines.push(`  London: <code>${fmtPrice(sessionRangeLondon.high, activeSym)}</code> / <code>${fmtPrice(sessionRangeLondon.low, activeSym)}</code>`);
    }
    if (sessionRangeNY) {
      lines.push(`  NY: <code>${fmtPrice(sessionRangeNY.high, activeSym)}</code> / <code>${fmtPrice(sessionRangeNY.low, activeSym)}</code>`);
    }
    if (londonSweepSignal) {
      lines.push(`  Sweep: London ${londonSweepSignal.dir === "HIGH" ? "▲" : "▼"} Asian ${londonSweepSignal.dir} @ <code>${fmtPrice(londonSweepSignal.price, activeSym)}</code>`);
    }
  }

  lines.push(``);
  lines.push(`<b>Confluence:</b> ${confluenceScore}/16`);
  const regime = adxValue > 0 ? getVolatilityRegime() : "--";
  lines.push(`<b>Regime:</b> ${regime}`);
  if (breakout) {
    const str = getSignalStrength(confluenceScore);
    lines.push(`<b>Signal:</b> ${str.label}`);
  }

  /* Active filters summary */
  const filters = [];
  if (emaFilterEnabled) filters.push("EMA 8/21");
  if (htfFilterEnabled) filters.push("HTF Trend");
  if (atrToleranceEnabled) filters.push("ATR Tol.");
  if (trailingStopEnabled) filters.push("Trailing SL");
  if (partialTpEnabled) filters.push("Partial TP");
  if (falseBreakoutEnabled) filters.push("False BO");
  if (minRREnabled) filters.push(`Min R:R ${minRRValue}`);
  if (pureTrailingEnabled) filters.push("Pure Trail");
  if (rsiFilterEnabled) filters.push("RSI");
  if (volumeSpikeEnabled) filters.push("Vol. Spike");
  if (sessionFilterEnabled) filters.push(`Session (${sessionFilterMode})`);
  if (fibRetestEnabled) filters.push("Fib Retest");
  if (macdFilterEnabled) filters.push("MACD");
  if (bbSqueezeFilterEnabled) filters.push("BB Squeeze");
  if (adxFilterEnabled) filters.push("ADX");
  if (stochFilterEnabled) filters.push("Stochastic");
  if (scalpingModeEnabled) filters.push("Scalping");
  if (liveScalpEnabled) filters.push("Live Scalp Scanner");
  if (sessionRangesEnabled) filters.push("Session Ranges");
  if (liquiditySweepEnabled) filters.push("Liquidity Sweep");
  if (stopLossHuntEnabled) filters.push("Stop Loss Hunt");
  if (failedPinBarEnabled) filters.push("Failed Pin Bar");
  if (fibScalpEnabled) filters.push("Fib Golden Zone");
  if (po3Enabled) filters.push("Power of 3");
  if (fvgStratEnabled) filters.push("Fair Value Gap");
  if (mtfTopDownEnabled) filters.push("MTF Top-Down");
  if (gridScalperMAEnabled) filters.push(`Grid Scalper MA [${gridScalperMAStrategy === "bos" ? "BOS" : "Price vs MA"}]`);
  /* Profit-Direction Constraints */
  if (minConfluenceEnabled) filters.push(`Min Confluence ≥${minConfluenceValue}`);
  if (doubleRetestEnabled) filters.push("Double Retest");
  if (confirmBarEnabled) filters.push("Confirm Bar");
  if (divergenceFilterEnabled) filters.push("Divergence");
  if (adxHardGateEnabled) filters.push(`ADX Gate (20-${adxMaxThreshold})`);
  if (breakoutDistEnabled) filters.push(`BO Dist ≤${breakoutDistATR}×ATR`);
  if (timeDecayEnabled) filters.push(`Time Decay ≤${timeDecayCandles}`);
  if (consecutiveDirEnabled) filters.push("Consec. Dir");
  if (vwapFilterEnabled) filters.push("VWAP");
  if (stochCrossEnabled) filters.push("Stoch Cross");
  if (rangeSizeEnabled) filters.push(`Range ${rangeSizeMin}-${rangeSizeMax}×ATR`);
  if (hhhlEnabled) filters.push("HH/HL");
  if (followThroughEnabled) filters.push("Follow-Through");
  if (mtfStructureEnabled) filters.push("MTF (EMA200)");
  if (filters.length > 0) {
    lines.push(`<b>Filters:</b> ${filters.join(", ")}`);
  }

  lines.push(``);
  lines.push(`<i>${ts}</i>`);
  return lines.join("\n");
}

/**
 * Read fresh Telegram credentials from the DOM inputs.
 * Falls back to the in-memory variables if DOM unavailable.
 */
function getTelegramCredentials() {
  const token = (UI.telegramBotToken ? UI.telegramBotToken.value : telegramBotToken).trim();
  const chatId = (UI.telegramChatId ? UI.telegramChatId.value : telegramChatId).trim();
  return { token, chatId };
}

function withTimeout(promise, timeoutMs, timeoutError) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function captureTelegramScreenshot(panel = null) {
  const label = panel ? `panel ${panel.symbol || "chart"}` : "chart";
  const capturePromise = panel ? capturePanelScreenshot(panel) : captureChartScreenshot();
  try {
    return await withTimeout(
      capturePromise,
      TELEGRAM_SCREENSHOT_TIMEOUT_MS,
      new Error("Screenshot timed out")
    );
  } catch (err) {
    addLog(`📤 ${label} screenshot unavailable, sending text-only signal: ${err.message}`);
    return null;
  }
}

function ensureTelegramDeliveryHud() {
  if (telegramDeliveryHudEl || typeof document === "undefined") return;

  const el = document.createElement("div");
  const textEl = document.createElement("span");
  const resetBtn = document.createElement("button");
  el.id = "telegramDeliveryHud";
  el.setAttribute("aria-live", "polite");
  el.style.position = "fixed";
  el.style.right = "12px";
  el.style.bottom = "12px";
  el.style.zIndex = "99999";
  el.style.padding = "6px 10px";
  el.style.borderRadius = "10px";
  el.style.border = "1px solid rgba(148,163,184,0.45)";
  el.style.background = "rgba(2,6,23,0.82)";
  el.style.backdropFilter = "blur(6px)";
  el.style.color = "#e2e8f0";
  el.style.fontSize = "12px";
  el.style.fontWeight = "600";
  el.style.letterSpacing = "0.2px";
  el.style.pointerEvents = "auto";
  el.style.display = "flex";
  el.style.alignItems = "center";
  el.style.gap = "8px";
  el.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace";

  textEl.id = "telegramDeliveryHudText";

  resetBtn.type = "button";
  resetBtn.textContent = "Reset";
  resetBtn.title = "Reset Telegram delivery counters";
  resetBtn.style.pointerEvents = "auto";
  resetBtn.style.cursor = "pointer";
  resetBtn.style.border = "1px solid rgba(148,163,184,0.55)";
  resetBtn.style.background = "rgba(15,23,42,0.9)";
  resetBtn.style.color = "#cbd5e1";
  resetBtn.style.borderRadius = "6px";
  resetBtn.style.padding = "1px 6px";
  resetBtn.style.fontSize = "11px";
  resetBtn.style.fontWeight = "700";
  resetBtn.style.lineHeight = "1.3";
  resetBtn.addEventListener("click", () => {
    telegramDeliveryStats.queued = 0;
    telegramDeliveryStats.sent = 0;
    telegramDeliveryStats.failed = 0;
    updateTelegramDeliveryHud();
    addLog("📤 Telegram delivery counters reset");
  });

  el.appendChild(textEl);
  el.appendChild(resetBtn);

  telegramDeliveryHudEl = el;
  document.body.appendChild(el);
  updateTelegramDeliveryHud();
}

function updateTelegramDeliveryHud() {
  ensureTelegramDeliveryHud();
  if (!telegramDeliveryHudEl) return;
  const s = telegramDeliveryStats;
  const textEl = telegramDeliveryHudEl.querySelector("#telegramDeliveryHudText");
  if (textEl) {
    textEl.textContent = `TG Q:${s.queued} | S:${s.sent} | F:${s.failed}`;
  }
  telegramDeliveryHudEl.title = "Telegram delivery health: queued, sent, failed";
}

function recordTelegramDeliveryStat(kind, delta = 1) {
  if (!Object.prototype.hasOwnProperty.call(telegramDeliveryStats, kind)) return;
  telegramDeliveryStats[kind] += delta;
  if (telegramDeliveryStats[kind] < 0) telegramDeliveryStats[kind] = 0;
  updateTelegramDeliveryHud();
}

/**
 * Validate Telegram credentials and throw descriptive errors.
 */
function validateTelegramCredentials(token, chatId) {
  if (!token || !chatId) {
    throw new Error("Telegram Bot Token and Chat ID are required");
  }
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("Invalid Bot Token format (expected 123456:ABC-DEF…)");
  }
  if (!/^-?\d+$/.test(chatId)) {
    throw new Error("Invalid Chat ID format (expected a numeric ID)");
  }
}

/**
 * Build an Authorization header object for the Telegram proxy.
 * Returns the JWT Bearer token from ITGuruAuth if available.
 */
function telegramProxyHeaders(extra = {}) {
  const h = Object.assign({}, extra);
  if (typeof ITGuruAuth !== "undefined" && ITGuruAuth.getToken()) {
    h["Authorization"] = "Bearer " + ITGuruAuth.getToken();
  }
  return h;
}

/**
 * Send a photo (Blob) with caption to Telegram via Bot API.
 */
async function sendTelegramPhoto(blob, caption) {
  /* Check rate limit before making API call */
  if (!(await waitForApiCallSlot("telegram", 20000))) {
    throw new Error("Rate limit exceeded. Please wait before sending another message.");
  }

  const { token, chatId } = getTelegramCredentials();
  validateTelegramCredentials(token, chatId);

  /** Build the base FormData fields shared by both proxy and direct paths */
  function buildPhotoForm() {
    const f = new FormData();
    f.append("chat_id", chatId);
    f.append("photo", blob, "chart.png");
    f.append("caption", caption);
    f.append("parse_mode", "HTML");
    return f;
  }

  /* Try server-side proxy first (avoids CORS), fall back to direct API */
  let resp;
  let useDirectFallback = false;
  try {
    const form = buildPhotoForm();
    form.append("action", "sendPhoto");
    form.append("token", token);
    resp = await fetch(TELEGRAM_PROXY_URL, { method: "POST", headers: telegramProxyHeaders(), body: form });
    /* If proxy returns 401/403 (auth issue), fall back to direct API */
    if (resp.status === 401 || resp.status === 403) {
      useDirectFallback = true;
    }
  } catch (_proxyErr) {
    /* Proxy unreachable — try direct Telegram API as fallback */
    useDirectFallback = true;
  }
  if (useDirectFallback) {
    resp = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: buildPhotoForm() });
  }
  const data = await safeJson(resp);
  if (!data.ok) {
    recordTelegramDeliveryStat("failed", 1);
    throw new Error(data.description || "Telegram API error");
  }
  recordTelegramDeliveryStat("sent", 1);
  return data;
}

/**
 * Send a text-only message to Telegram via Bot API (HTML parse mode).
 */
async function sendTelegramMessage(text) {
  /* Check rate limit before making API call */
  if (!(await waitForApiCallSlot("telegram", 20000))) {
    throw new Error("Rate limit exceeded. Please wait before sending another message.");
  }

  const { token, chatId } = getTelegramCredentials();
  validateTelegramCredentials(token, chatId);

  const payload = { chat_id: chatId, text, parse_mode: "HTML" };

  /* Try server-side proxy first (avoids CORS), fall back to direct API */
  let resp;
  let useDirectFallback = false;
  try {
    resp = await fetch(TELEGRAM_PROXY_URL, {
      method: "POST",
      headers: telegramProxyHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ action: "sendMessage", token, payload })
    });
    /* If proxy returns 401/403 (auth issue), fall back to direct API */
    if (resp.status === 401 || resp.status === 403) {
      useDirectFallback = true;
    }
  } catch (_proxyErr) {
    useDirectFallback = true;
  }
  if (useDirectFallback) {
    resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  }
  const data = await safeJson(resp);
  if (!data.ok) {
    recordTelegramDeliveryStat("failed", 1);
    throw new Error(data.description || "Telegram API error");
  }
  recordTelegramDeliveryStat("sent", 1);
  return data;
}

/**
 * Send a Telegram alert when a trade hits the 1:1 partial TP level.
 * Applies to both the main breakout strategy and PO3 strategy.
 * Notifies the trader that the 1:1 level has been reached so they can consider
 * closing a portion of the position manually. The main strategy continues to
 * the original TP/SL without any automatic SL adjustment.
 * Uses the outcome Telegram toggle (telegramOutcomeSend) so no extra setting is needed.
 */
async function sendPartialTpTelegram(signal, partialLevel) {
  if (!partialTpEnabled) return;
  if (!telegramOutcomeSend) return;
  try {
    const activeSym = signal.symbol || getActiveSymbol() || "";
    const sym = getSymbolLabel(activeSym);
    const dir = signal.dir === "BULL" ? "📈 BUY" : "📉 SELL";
    const entryStr = signal.entry != null ? fmtPrice(signal.entry, activeSym) : "--";
    const tpStr    = signal.tp    != null ? fmtPrice(signal.tp, activeSym)    : "--";
    const slStr    = signal.sl    != null ? fmtPrice(signal.sl, activeSym)    : "--";
    const rrStr    = signal.rr    != null ? "1:" + signal.rr.toFixed(1)       : "--";
    const lvlStr   = partialLevel != null ? fmtPrice(partialLevel, activeSym) : "--";

    const lines = [];
    lines.push(`🔔 <b>Partial TP Hit — 1:1 Reached</b>`);
    lines.push(``);
    lines.push(`<b>Consider closing a portion of your position now to protect profits.</b>`);
    lines.push(`Trade continues to full TP with original SL intact.`);
    lines.push(``);
    lines.push(`${dir} ${sym}`);
    lines.push(`<b>📍 Entry:</b> <code>${entryStr}</code>`);
    lines.push(`<b>🔔 1:1 Level:</b> <code>${lvlStr}</code>`);
    lines.push(`<b>🎯 Full TP:</b> <code>${tpStr}</code>`);
    lines.push(`<b>🛑 SL:</b> <code>${slStr}</code>`);
    lines.push(`<b>R:R:</b> ${rrStr}`);
    lines.push(``);
    lines.push(`<i>Monitoring trade for full TP or SL exit…</i>`);
    lines.push(`<i>${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC</i>`);

    await sendTelegramMessage(lines.join("\n"));
    addLog(`📤 Telegram: partial TP alert (1:1) sent`);
  } catch (err) {
    addLog(`📤 Partial TP Telegram error: ${err.message}`);
  }
}

/**
 * Send a Telegram alert when price reaches a Tesla 3–6–9 level (T1=3R, T2=6R, T3=9R).
 * Uses the outcome Telegram toggle so no extra setting is needed.
 * @param {object} signal - the pending trade signal
 * @param {string} levelLabel - "T1 (3R)", "T2 (6R)", or "T3 (9R)"
 * @param {number} levelPrice - price at this level
 * @param {string} plan - "conservative" | "aggressive"
 */
async function sendTeslaLevelTelegram(signal, levelLabel, levelPrice, plan) {
  if (!teslaScalingEnabled) return;
  if (!telegramOutcomeSend) return;
  try {
    const activeSym = signal.symbol || getActiveSymbol() || "";
    const sym = getSymbolLabel(activeSym);
    const dir = signal.dir === "BULL" ? "📈 BUY" : "📉 SELL";
    const entryStr = signal.entry != null ? fmtPrice(signal.entry, activeSym) : "--";
    const slStr    = signal.sl    != null ? fmtPrice(signal.sl, activeSym)    : "--";
    const lvlStr   = fmtPrice(levelPrice, activeSym);
    const planLabel = plan === "aggressive" ? "Aggressive" : "Conservative";

    /* Determine position action for each level based on the chosen plan */
    const actions = {
      "T1 (3R)": plan === "conservative" ? "Close 50% of position" : "Close 25% of position",
      "T2 (6R)": plan === "conservative" ? "Close 30% of position" : "Close 35% of position",
      "T3 (9R)": plan === "conservative" ? "Close remaining 20%" : "Close 20% — trail the rest"
    };
    const action = actions[levelLabel] || "Review open position";

    const lines = [];
    lines.push(`⚡ <b>Tesla 3–6–9: ${levelLabel} Reached</b>`);
    lines.push(``);
    lines.push(`<b>Plan:</b> ${planLabel}`);
    lines.push(`<b>Action:</b> ${action}`);
    lines.push(``);
    lines.push(`${dir} ${sym}`);
    lines.push(`<b>📍 Entry:</b> <code>${entryStr}</code>`);
    lines.push(`<b>🎯 ${levelLabel} Level:</b> <code>${lvlStr}</code>`);
    lines.push(`<b>🛑 SL:</b> <code>${slStr}</code>`);
    lines.push(``);
    lines.push(`<i>${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC</i>`);

    await sendTelegramMessage(lines.join("\n"));
    addLog(`📤 Telegram: Tesla ${levelLabel} alert sent`);
  } catch (err) {
    addLog(`📤 Tesla level Telegram error: ${err.message}`);
  }
}
async function sendTradeOutcomeTelegram(signal) {
  if (!telegramOutcomeSend) return;
  if (signal._outcomeSent) return;
  /* Set the flag synchronously before the first await so that any re-entrant call
     (possible because JS is single-threaded but event-loop interleaving can occur
     between awaits) sees the flag and returns early without sending a duplicate. */
  signal._outcomeSent = true;
  try {
    const sym = getSymbolLabel(signal.symbol || "");
    const activeSym = signal.symbol || getActiveSymbol() || "";
    const dir = signal.dir === "BULL" ? "📈 BUY" : "📉 SELL";
    const result = signal.result;
    const icon = result === "WIN" ? "✅" : "❌";
    const entryStr = signal.entry != null ? fmtPrice(signal.entry, activeSym) : "--";
    const exitStr  = signal.exitPrice != null ? fmtPrice(signal.exitPrice, activeSym) : "--";
    const slStr = signal.sl != null ? fmtPrice(signal.sl, activeSym) : "--";
    const tpStr = signal.tp != null ? fmtPrice(signal.tp, activeSym) : "--";
    const rrStr = signal.rr != null ? "1:" + signal.rr.toFixed(1) : "--";
    const confScore = signal.confluenceScore != null ? signal.confluenceScore + "/16" : "--";
    const pattern = signal.confirmPattern || "--";

    const lines = [];
    lines.push(`${icon} <b>Trade ${result}</b> — ${dir} ${sym}`);
    lines.push("");
    lines.push(`<b>Pattern:</b> ${pattern}`);
    lines.push(`<b>Entry:</b> ${entryStr}`);
    lines.push(`<b>Exit:</b> ${exitStr}`);
    lines.push(`<b>SL:</b> ${slStr}`);
    lines.push(`<b>TP:</b> ${tpStr}`);
    lines.push(`<b>R:R:</b> ${rrStr}`);
    lines.push(`<b>Confluence:</b> ${confScore}`);
    if (signal.trailingSL != null) {
      lines.push(`<b>Trailing SL:</b> ${fmtPrice(signal.trailingSL, activeSym)}`);
    }
    if (signal.partialTpHit) {
      lines.push(`<b>Partial TP:</b> Hit at 1:1`);
    }
    /* Win/loss tally */
    const totalW = signalWins;
    const totalL = signalLosses;
    const wr = (totalW + totalL) > 0 ? (totalW / (totalW + totalL) * 100).toFixed(1) + "%" : "N/A";
    lines.push("");
    lines.push(`📊 <b>Record:</b> ${totalW}W / ${totalL}L (${wr} win rate)`);

    /* Opposite mode effectiveness from auto-trade history */
    const oppTrades = autoTradeHistory.filter(e => e.isOpposite && (e.result === "WIN" || e.result === "LOSS"));
    const normTrades = autoTradeHistory.filter(e => !e.isOpposite && (e.result === "WIN" || e.result === "LOSS"));
    if (oppTrades.length > 0 || normTrades.length > 0) {
      lines.push("");
      if (normTrades.length > 0) {
        const nw = normTrades.filter(e => e.result === "WIN").length;
        const nwr = (nw / normTrades.length * 100).toFixed(1);
        lines.push(`📈 <b>Normal Trades:</b> ${nw}W / ${normTrades.length - nw}L (${nwr}%)`);
      }
      if (oppTrades.length > 0) {
        const ow = oppTrades.filter(e => e.result === "WIN").length;
        const owr = (ow / oppTrades.length * 100).toFixed(1);
        lines.push(`🔄 <b>Opposite Trades:</b> ${ow}W / ${oppTrades.length - ow}L (${owr}%)`);
      }
    }

    lines.push(`<i>${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC</i>`);

    await sendTelegramMessage(lines.join("\n"));
    addLog(`📤 Telegram: trade outcome (${result}) sent`);
  } catch (err) {
    addLog(`📤 Telegram outcome error: ${err.message}`);
  }
}

/**
 * Test the Telegram connection by calling getMe and getChat.
 * Shows success/failure in the Telegram status area.
 */
async function testTelegramConnection() {
  if (UI.telegramStatus) {
    UI.telegramStatus.textContent = "Testing connection…";
    UI.telegramStatus.className = "hint telegram-status";
  }
  try {
    const { token, chatId } = getTelegramCredentials();
    validateTelegramCredentials(token, chatId);

    /* Verify the bot token — proxy first, direct fallback */
    let meResp;
    let meUseDirectFallback = false;
    try {
      meResp = await fetch(TELEGRAM_PROXY_URL, {
        method: "POST",
        headers: telegramProxyHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ action: "getMe", token, payload: {} })
      });
      if (meResp.status === 401 || meResp.status === 403) {
        meUseDirectFallback = true;
      }
    } catch (_proxyErr) {
      meUseDirectFallback = true;
    }
    if (meUseDirectFallback) {
      meResp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    }
    const meData = await safeJson(meResp);
    if (!meData.ok) throw new Error(meData.description || "Invalid bot token");

    /* Verify the chat ID is reachable — proxy first, direct fallback */
    let chatResp;
    let chatUseDirectFallback = false;
    try {
      chatResp = await fetch(TELEGRAM_PROXY_URL, {
        method: "POST",
        headers: telegramProxyHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ action: "getChat", token, payload: { chat_id: chatId } })
      });
      if (chatResp.status === 401 || chatResp.status === 403) {
        chatUseDirectFallback = true;
      }
    } catch (_proxyErr) {
      chatUseDirectFallback = true;
    }
    if (chatUseDirectFallback) {
      chatResp = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId })
      });
    }
    const chatData = await safeJson(chatResp);
    if (!chatData.ok) throw new Error(chatData.description || "Cannot reach chat");

    const botName = meData.result.first_name || meData.result.username;
    const chatTitle = chatData.result.title || chatData.result.first_name || chatId;
    const msg = `✅ Connected! Bot: ${botName} → Chat: ${chatTitle}`;
    addLog(`📤 ${msg}`);
    if (UI.telegramStatus) {
      UI.telegramStatus.textContent = msg;
      UI.telegramStatus.className = "hint telegram-status telegram-ok";
    }

    /* Sync variables and persist */
    telegramBotToken = token;
    telegramChatId = chatId;
    saveSettings();
  } catch (err) {
    const msg = `❌ ${err.message}`;
    addLog(`📤 Telegram test: ${err.message}`);
    if (UI.telegramStatus) {
      UI.telegramStatus.textContent = msg;
      UI.telegramStatus.className = "hint telegram-status telegram-err";
    }
  }
  setTimeout(() => {
    if (UI.telegramStatus) {
      UI.telegramStatus.textContent = "";
      UI.telegramStatus.className = "hint telegram-status";
    }
  }, TELEGRAM_STATUS_CLEAR_MS * 2);         /* longer display for test results */
}

/**
 * Capture chart + build caption and send to Telegram.
 * Shows status in the signal log and the Telegram status label.
 */
async function sendTelegramAlert() {
  /* Sync variables from DOM before sending */
  if (UI.telegramBotToken) telegramBotToken = UI.telegramBotToken.value;
  if (UI.telegramChatId) telegramChatId = UI.telegramChatId.value;

  /* In multi-panel mode, delegate to the panel-specific sender
     so the chart screenshot and caption always match the focused panel */
  if (focusedPanelSymbol && multiPanels.has(focusedPanelSymbol)) {
    return sendPanelTelegramAlert(focusedPanelSymbol);
  }

  if (UI.telegramStatus) UI.telegramStatus.textContent = "Sending…";
  try {
    const caption = buildTelegramCaption();
    const blob = await captureTelegramScreenshot();
    if (blob) {
      await sendTelegramPhoto(blob, caption);
    } else {
      await sendTelegramMessage(caption);
    }
    addLog("📤 Telegram alert sent successfully");
    if (UI.telegramStatus) {
      UI.telegramStatus.textContent = "✅ Sent!";
      UI.telegramStatus.className = "hint telegram-status telegram-ok";
    }
    /* Persist credentials on success */
    saveSettings();
  } catch (err) {
    addLog(`📤 Telegram error: ${err.message}`);
    showToast("❌ Telegram Error", err.message, "warning", 6000);
    if (UI.telegramStatus) {
      UI.telegramStatus.textContent = `❌ ${err.message}`;
      UI.telegramStatus.className = "hint telegram-status telegram-err";
    }
  }
  /* Clear status after 5 seconds */
  setTimeout(() => {
    if (UI.telegramStatus) {
      UI.telegramStatus.textContent = "";
      UI.telegramStatus.className = "hint telegram-status";
    }
  }, TELEGRAM_STATUS_CLEAR_MS);
}

/**
 * Send Telegram alert for a specific multi-panel symbol.
 * Activates the panel's state, captures its mini-chart screenshot,
 * builds a caption using the panel's data, and sends to Telegram.
 */
async function sendPanelTelegramAlert(symbol) {
  const p = multiPanels.get(symbol);
  if (!p) return;

  /* Sync credentials from DOM */
  if (UI.telegramBotToken) telegramBotToken = UI.telegramBotToken.value;
  if (UI.telegramChatId) telegramChatId = UI.telegramChatId.value;

  /* Build caption from panel state (without touching globals) */
  const caption = buildPanelTelegramCaption(p);

  /* Capture screenshot from the panel's mini-chart canvas */
  const blob = await captureTelegramScreenshot(p);

  if (UI.telegramStatus) UI.telegramStatus.textContent = `Sending ${getSymbolLabel(symbol)}…`;
  try {
    if (blob) {
      await sendTelegramPhoto(blob, caption);
    } else {
      await sendTelegramMessage(caption);
    }
    addLog(`📤 [${symbol}] Telegram alert sent — TRADE setup`);
    if (UI.telegramStatus) {
      UI.telegramStatus.textContent = `✅ Sent ${getSymbolLabel(symbol)}!`;
      UI.telegramStatus.className = "hint telegram-status telegram-ok";
    }
  } catch (err) {
    addLog(`📤 [${symbol}] Telegram error: ${err.message}`);
    showToast("❌ Telegram Error", `${getSymbolLabel(symbol)}: ${err.message}`, "warning", 6000);
    if (UI.telegramStatus) {
      UI.telegramStatus.textContent = `❌ ${getSymbolLabel(symbol)}: ${err.message}`;
      UI.telegramStatus.className = "hint telegram-status telegram-err";
    }
  }
  /* Clear status */
  setTimeout(() => {
    if (UI.telegramStatus) {
      UI.telegramStatus.textContent = "";
      UI.telegramStatus.className = "hint telegram-status";
    }
  }, TELEGRAM_STATUS_CLEAR_MS);
}

/**
 * Build Telegram caption from a panel's saved state (no globals needed).
 */
function buildPanelTelegramCaption(p) {
  const symLabel = getSymbolLabel(p.symbol);
  const gran = UI.granSelect ? UI.granSelect.value : "--";
  const tfLabel = TIMEFRAME_LABELS[gran] || gran + "s";
  const dir = p.breakout ? p.breakout.dir : "--";
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  /* Compute recommended order type from panel state */
  let orderType = "--";
  if (p.breakout && p.candles.length > 0) {
    const currentPrice = p.candles[p.candles.length - 1].close;
    const entryLevel = p.trade ? p.trade.entry : p.breakout.level;
    if (p.breakout.dir === "BULL") {
      orderType = entryLevel > currentPrice ? "BUY STOP" : "BUY LIMIT";
    } else {
      orderType = entryLevel < currentPrice ? "SELL STOP" : "SELL LIMIT";
    }
  }

  let lines = [];
  lines.push(`<b>📊 IT Guru Signal</b>`);
  lines.push(``);
  lines.push(`<b>Symbol:</b> ${symLabel}`);
  lines.push(`<b>Timeframe:</b> ${tfLabel}`);
  lines.push(`<b>Phase:</b> ${p.phase}`);
  lines.push(`<b>Direction:</b> ${dir === "BULL" ? "🟢 BULL (BUY)" : dir === "BEAR" ? "🔴 BEAR (SELL)" : dir}`);
  lines.push(`<b>Order Type:</b> ${orderType}`);

  if (p.trade) {
    lines.push(``);
    lines.push(`<b>📍 Entry:</b> <code>${fmtPrice(p.trade.entry, p.symbol)}</code>`);
    lines.push(`<b>🛑 SL:</b> <code>${fmtPrice(p.trade.sl, p.symbol)}</code>`);
    if (p.trade.tp != null && !p.filters.pureTrailingEnabled) {
      lines.push(`<b>🎯 TP:</b> <code>${fmtPrice(p.trade.tp, p.symbol)}</code>`);
    }
    if (p.trade.rr != null) {
      lines.push(`<b>R:R:</b> 1:${fmt(p.trade.rr, 1)}`);
    }
    if (accountSize > 0 && riskPercent > 0) {
      const m = calcPositionMetrics(p.trade);
      if (m) {
        lines.push(`<b>💰 $ Risk:</b> $${fmt(m.dollarRisk, 2)}`);
        if (p.trade.tp != null) lines.push(`<b>💰 $ Reward:</b> $${fmt(m.dollarReward, 2)}`);
        lines.push(`<b>📦 Lot Size:</b> ${fmt(m.lotSize, 2)}`);
        if (!m.isSynthetic) {
          lines.push(`<b>📏 Pips at Risk:</b> ${fmt(m.pips, 1)}`);
        }
      }
    }
    if (p.trailingSL != null && p.filters.trailingStopEnabled) {
      lines.push(`<b>Trailing SL:</b> <code>${fmtPrice(p.trailingSL, p.symbol)}</code>`);
    }
  }

  if (p.openingRange) {
    lines.push(``);
    lines.push(`<b>Range High:</b> <code>${fmtPrice(p.openingRange.high, p.symbol)}</code>`);
    lines.push(`<b>Range Low:</b> <code>${fmtPrice(p.openingRange.low, p.symbol)}</code>`);
  }

  /* Session Ranges context */
  if (sessionRangesEnabled && p.sessionRangeAsian) {
    lines.push(``);
    lines.push(`<b>🌍 Session Ranges:</b>`);
    lines.push(`  Asian: <code>${fmtPrice(p.sessionRangeAsian.high, p.symbol)}</code> / <code>${fmtPrice(p.sessionRangeAsian.low, p.symbol)}</code>${p.asianRangeTight ? " ⚡TIGHT" : ""}`);
    if (p.sessionRangeLondon) {
      lines.push(`  London: <code>${fmtPrice(p.sessionRangeLondon.high, p.symbol)}</code> / <code>${fmtPrice(p.sessionRangeLondon.low, p.symbol)}</code>`);
    }
    if (p.sessionRangeNY) {
      lines.push(`  NY: <code>${fmtPrice(p.sessionRangeNY.high, p.symbol)}</code> / <code>${fmtPrice(p.sessionRangeNY.low, p.symbol)}</code>`);
    }
    if (p.londonSweepSignal) {
      lines.push(`  Sweep: London ${p.londonSweepSignal.dir === "HIGH" ? "▲" : "▼"} Asian ${p.londonSweepSignal.dir} @ <code>${fmtPrice(p.londonSweepSignal.price, p.symbol)}</code>`);
    }
  }

  lines.push(``);
  lines.push(`<b>Confluence:</b> ${p.confluenceScore}/16`);

  /* Active filters summary from panel's per-symbol settings */
  const f = p.filters;
  const filters = [];
  if (f.emaFilterEnabled) filters.push("EMA 8/21");
  if (f.htfFilterEnabled) filters.push("HTF Trend");
  if (f.atrToleranceEnabled) filters.push("ATR Tol.");
  if (f.trailingStopEnabled) filters.push("Trailing SL");
  if (f.partialTpEnabled) filters.push("Partial TP");
  if (f.falseBreakoutEnabled) filters.push("False BO");
  if (f.minRREnabled) filters.push(`Min R:R ${f.minRRValue}`);
  if (f.pureTrailingEnabled) filters.push("Pure Trail");
  if (f.rsiFilterEnabled) filters.push("RSI");
  if (f.volumeSpikeEnabled) filters.push("Vol. Spike");
  if (f.sessionFilterEnabled) filters.push(`Session (${f.sessionFilterMode})`);
  if (f.fibRetestEnabled) filters.push("Fib Retest");
  if (f.macdFilterEnabled) filters.push("MACD");
  if (f.bbSqueezeFilterEnabled) filters.push("BB Squeeze");
  if (f.adxFilterEnabled) filters.push("ADX");
  if (f.stochFilterEnabled) filters.push("Stochastic");
  if (f.scalpingModeEnabled) filters.push("Scalping");
  if (sessionRangesEnabled) filters.push("Session Ranges");
  /* Profit-Direction Constraints */
  if (f.minConfluenceEnabled) filters.push(`Min Confluence ≥${f.minConfluenceValue}`);
  if (f.doubleRetestEnabled) filters.push("Double Retest");
  if (f.confirmBarEnabled) filters.push("Confirm Bar");
  if (f.divergenceFilterEnabled) filters.push("Divergence");
  if (f.adxHardGateEnabled) filters.push(`ADX Gate (20-${f.adxMaxThreshold})`);
  if (f.breakoutDistEnabled) filters.push(`BO Dist ≤${f.breakoutDistATR}×ATR`);
  if (f.timeDecayEnabled) filters.push(`Time Decay ≤${f.timeDecayCandles}`);
  if (f.consecutiveDirEnabled) filters.push("Consec. Dir");
  if (f.vwapFilterEnabled) filters.push("VWAP");
  if (f.stochCrossEnabled) filters.push("Stoch Cross");
  if (f.rangeSizeEnabled) filters.push(`Range ${f.rangeSizeMin}-${f.rangeSizeMax}×ATR`);
  if (f.hhhlEnabled) filters.push("HH/HL");
  if (f.followThroughEnabled) filters.push("Follow-Through");
  if (f.mtfStructureEnabled) filters.push("MTF (EMA200)");
  if (filters.length > 0) {
    lines.push(`<b>Filters:</b> ${filters.join(", ")}`);
  }

  lines.push(``);
  lines.push(`<i>${ts}</i>`);
  return lines.join("\n");
}

/**
 * Capture a full high-res chart for a multi-symbol panel.
 * Temporarily activates the panel data into globals, renders drawChart()
 * on a 1920×1080 offscreen canvas, then restores the previous state.
 */
function capturePanelScreenshot(p) {
  const snap = _snapshotChartGlobals();
  /* Also snapshot the symbol dropdown so the chart watermark matches this panel */
  const prevSymbolValue = UI.symbolSelect ? UI.symbolSelect.value : null;
  activatePanel(p);
  if (UI.symbolSelect) UI.symbolSelect.value = p.symbol;
  return _renderChartToBlob().finally(() => {
    _restoreChartGlobals(snap);
    if (UI.symbolSelect && prevSymbolValue !== null) UI.symbolSelect.value = prevSymbolValue;
  });
}

/* ---- Snapshot / restore globals that activatePanel touches ---- */
function _snapshotChartGlobals() {
  return {
    candles, rangeStartEpoch, openingRange, breakout,
    retestInfo, indecisionInfo, confirmInfo, trade, phase,
    monitoringTrade, emaFast, emaSlow, emaHTF,
    atrValue, atrValues, rsiValues,
    macdLine, macdSignal, macdHistogram,
    bbUpper, bbLower, bbMiddle, bbWidth,
    adxValue, adxDiPlus, adxDiMinus, stochK, stochD,
    trailingSL, partialTpHit, confluenceScore,
    signalHistory, signalWins, signalLosses,
    liveScalpHistory, lastScalpCandleIdx, ws,
    autoResetEnabled, emaFilterEnabled, htfFilterEnabled,
    atrToleranceEnabled, trailingStopEnabled, partialTpEnabled,
    falseBreakoutEnabled, minRREnabled, minRRValue, pureTrailingEnabled,
    rsiFilterEnabled, volumeSpikeEnabled, sessionFilterEnabled,
    sessionFilterMode, fibRetestEnabled,
    macdFilterEnabled, bbSqueezeFilterEnabled, adxFilterEnabled,
    stochFilterEnabled, scalpingModeEnabled, nyOpenRangeEnabled,
    nyOpenRange, nyOpenRangeBreakout, nyOpenRangeRetest,
    nyOpenRangeTrade, nyOpenRangePhase, RANGE_MINUTES,
    sessionRangesEnabled, sessionRangeAsian, sessionRangeLondon,
    sessionRangeNY, asianRangeTight, londonSweepSignal,
    sessionRangeTrade,
    sessionRangeTradeWins, sessionRangeTradeLosses
  };
}
function _restoreChartGlobals(s) {
  candles = s.candles; rangeStartEpoch = s.rangeStartEpoch;
  openingRange = s.openingRange; breakout = s.breakout;
  retestInfo = s.retestInfo; indecisionInfo = s.indecisionInfo;
  confirmInfo = s.confirmInfo; trade = s.trade; phase = s.phase;
  monitoringTrade = s.monitoringTrade;
  emaFast = s.emaFast; emaSlow = s.emaSlow; emaHTF = s.emaHTF;
  atrValue = s.atrValue; atrValues = s.atrValues; rsiValues = s.rsiValues;
  macdLine = s.macdLine; macdSignal = s.macdSignal; macdHistogram = s.macdHistogram;
  bbUpper = s.bbUpper; bbLower = s.bbLower; bbMiddle = s.bbMiddle; bbWidth = s.bbWidth;
  adxValue = s.adxValue; adxDiPlus = s.adxDiPlus; adxDiMinus = s.adxDiMinus;
  stochK = s.stochK; stochD = s.stochD;
  trailingSL = s.trailingSL; partialTpHit = s.partialTpHit;
  confluenceScore = s.confluenceScore;
  signalHistory = s.signalHistory; signalWins = s.signalWins; signalLosses = s.signalLosses;
  liveScalpHistory = s.liveScalpHistory; lastScalpCandleIdx = s.lastScalpCandleIdx;
  ws = s.ws;
  autoResetEnabled = s.autoResetEnabled; emaFilterEnabled = s.emaFilterEnabled;
  htfFilterEnabled = s.htfFilterEnabled; atrToleranceEnabled = s.atrToleranceEnabled;
  trailingStopEnabled = s.trailingStopEnabled; partialTpEnabled = s.partialTpEnabled;
  falseBreakoutEnabled = s.falseBreakoutEnabled; minRREnabled = s.minRREnabled;
  minRRValue = s.minRRValue; pureTrailingEnabled = s.pureTrailingEnabled;
  rsiFilterEnabled = s.rsiFilterEnabled; volumeSpikeEnabled = s.volumeSpikeEnabled;
  sessionFilterEnabled = s.sessionFilterEnabled; sessionFilterMode = s.sessionFilterMode;
  fibRetestEnabled = s.fibRetestEnabled;
  macdFilterEnabled = s.macdFilterEnabled; bbSqueezeFilterEnabled = s.bbSqueezeFilterEnabled;
  adxFilterEnabled = s.adxFilterEnabled; stochFilterEnabled = s.stochFilterEnabled;
  scalpingModeEnabled = s.scalpingModeEnabled; nyOpenRangeEnabled = s.nyOpenRangeEnabled;
  nyOpenRange = s.nyOpenRange; nyOpenRangeBreakout = s.nyOpenRangeBreakout;
  nyOpenRangeRetest = s.nyOpenRangeRetest; nyOpenRangeTrade = s.nyOpenRangeTrade;
  nyOpenRangePhase = s.nyOpenRangePhase; RANGE_MINUTES = s.RANGE_MINUTES;
  sessionRangesEnabled = s.sessionRangesEnabled;
  sessionRangeAsian = s.sessionRangeAsian; sessionRangeLondon = s.sessionRangeLondon;
  sessionRangeNY = s.sessionRangeNY; asianRangeTight = s.asianRangeTight;
  londonSweepSignal = s.londonSweepSignal;
  sessionRangeTrade = s.sessionRangeTrade;
  sessionRangeTradeWins = s.sessionRangeTradeWins;
  sessionRangeTradeLosses = s.sessionRangeTradeLosses;
}

/* ================= LOCALSTORAGE PERSISTENCE ================= */
const LS_PREFIX = "itguru_indicator_";

/** Show/hide the MA Period input row based on the selected signal strategy. */
function _updateGridScalperMAPeriodVisibility() {
  const row = document.getElementById("gridScalperMAPeriodRow");
  if (row) row.style.display = gridScalperMAStrategy === "price_vs_ma" ? "" : "none";
}

function _normalizePo3EntryMaxAge(value) {
  const n = parseInt(value, 10);
  return n === PO3_ENTRY_MAX_AGE_STRICT ? PO3_ENTRY_MAX_AGE_STRICT : PO3_ENTRY_MAX_AGE_SAFE;
}

function saveSettings() {
  try {
    const settings = {
      appId: APP_ID,
      symbol: UI.symbolSelect.value,
      granularity: UI.granSelect.value,
      risk: UI.riskInput.value,
      reward: UI.rewardInput.value,
      rangeDuration: RANGE_MINUTES,
      touchTolerance: LEVEL_TOUCH_TOLERANCE,
      dojiRatio: DOJI_BODY_RATIO,
      lookbackPeriod: SWING_LOOKBACK_PERIOD,
      soundEnabled,
      notificationsEnabled,
      theme: currentTheme,
      showEma: UI.emaToggle ? UI.emaToggle.checked : false,
      autoResetEnabled,
      emaFilterEnabled,
      htfFilterEnabled,
      atrToleranceEnabled,
      trailingStopEnabled,
      partialTpEnabled,
      falseBreakoutEnabled,
      minRREnabled,
      minRRValue,
      pureTrailingEnabled,
      rsiFilterEnabled,
      volumeSpikeEnabled,
      sessionFilterEnabled,
      sessionFilterMode,
      fibRetestEnabled,
      macdFilterEnabled,
      bbSqueezeFilterEnabled,
      adxFilterEnabled,
      stochFilterEnabled,
      scalpingModeEnabled,
      nyOpenRangeEnabled,
      sessionRangesEnabled,
      /* Profit-Direction Constraints */
      minConfluenceEnabled,
      minConfluenceValue,
      doubleRetestEnabled,
      confirmBarEnabled,
      divergenceFilterEnabled,
      adxHardGateEnabled,
      adxMaxThreshold,
      breakoutDistEnabled,
      breakoutDistATR,
      timeDecayEnabled,
      timeDecayCandles,
      consecutiveDirEnabled,
      vwapFilterEnabled,
      stochCrossEnabled,
      rangeSizeEnabled,
      rangeSizeMin,
      rangeSizeMax,
      hhhlEnabled,
      followThroughEnabled,
      mtfStructureEnabled,
      autoApplyRecommended,
      lockTimeframe,
      lockRR,
      lockIndicatorFilters,
      liveScalpEnabled,
      liveScalpMinConf,
      liquiditySweepEnabled,
      stopLossHuntEnabled,
      failedPinBarEnabled,
      fibScalpEnabled,
      po3Enabled,
      po3EntryMaxAge,
      telegramBotToken: _obfuscate(telegramBotToken),
      telegramChatId,
      telegramAutoSend,
      telegramScalpAutoSend,
      telegramOutcomeSend,
      telegramScalpOutcomeSend,
      telegramSessionRangeAutoSend,
      telegramSessionRangeOutcomeSend,
      telegramStrategyAutoSend,
      telegramStrategyOutcomeSend,
      telegramProfitExitAlertEnabled,
      accountSize,
      riskPercent,
      autoTradeEnabled,
      autoTradeScalpEnabled,
      autoTradeStrategyEnabled,
      autoTradeStake,
      autoTradeMaxStake,
      autoTradeSessionTP,
      autoTradeSessionSL,
      autoTradeMultiplier,
      maxConcurrentTrades,
      autoTradeScalpOpposite,
      autoTradeStrategyOpposite,
      autoTradeLiquiditySweep,
      autoTradeStopLossHunt,
      autoTradeFailedPinBar,
      autoTradeFibScalp,
      autoTradePo3,
      autoTradeNYOpenRange,
      autoTradeSessionRange,
      gridScalperMAEnabled,
      gridScalperMAStrategy,
      gridScalperMAPeriod,
      autoTradeGridScalperMA,
      fvgStratEnabled,
      autoTradeFvgStrat,
      teslaScalingEnabled,
      teslaScalingPlan,
      mtfTopDownEnabled,
      autoTradeMtfTopDown,
      /* Feature settings */
      orderblockEnabled,
      autoTradeOrderblock,
      sessionHeatmapEnabled,
      candleAnnotationsEnabled,
      volumeProfileEnabled,
      fibExtensionsEnabled,
      bosChochEnabled,
      divergenceVisualEnabled,
      newsPauseEnabled,
      newsPauseMinutes,
      multiRLadderEnabled,
      adaptiveConfluenceEnabled,
      scannerEnabled,
      scannerSymbols: JSON.stringify(scannerSymbols),
      backtestSpeedMs
    };
    localStorage.setItem(LS_PREFIX + "settings", JSON.stringify(settings));
  } catch (e) {
    console.warn("Failed to save settings to localStorage:", e.message);
    addLog("⚠️ Settings could not be saved (storage unavailable)");
  }
}

function restoreSettings() {
  try {
    const raw = localStorage.getItem(LS_PREFIX + "settings");
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.appId != null) {
      const parsed = parseInt(s.appId, 10);
      APP_ID = isNaN(parsed) || parsed <= 0 ? 120128 : parsed;
      updateWsUrl();
      if (UI.appIdInput) UI.appIdInput.value = APP_ID;
    }
    if (s.symbol && UI.symbolSelect) UI.symbolSelect.value = migrateSymbol(s.symbol);
    if (s.granularity && UI.granSelect) UI.granSelect.value = s.granularity;
    if (s.risk && UI.riskInput) UI.riskInput.value = s.risk;
    if (s.reward && UI.rewardInput) UI.rewardInput.value = s.reward;
    if (s.rangeDuration !== null && s.rangeDuration !== undefined) {
      RANGE_MINUTES = s.rangeDuration;
      if (UI.rangeDuration) UI.rangeDuration.value = s.rangeDuration;
    }
    if (s.touchTolerance !== null && s.touchTolerance !== undefined) {
      LEVEL_TOUCH_TOLERANCE = s.touchTolerance;
      if (UI.touchTolerance) UI.touchTolerance.value = (s.touchTolerance * 100).toFixed(0);
    }
    if (s.dojiRatio !== null && s.dojiRatio !== undefined) {
      DOJI_BODY_RATIO = s.dojiRatio;
      if (UI.dojiRatio) UI.dojiRatio.value = (s.dojiRatio * 100).toFixed(0);
    }
    if (s.lookbackPeriod !== null && s.lookbackPeriod !== undefined) {
      SWING_LOOKBACK_PERIOD = s.lookbackPeriod;
      if (UI.lookbackPeriod) UI.lookbackPeriod.value = s.lookbackPeriod;
    }
    if (s.soundEnabled != null) soundEnabled = s.soundEnabled;
    if (s.notificationsEnabled != null) notificationsEnabled = s.notificationsEnabled;
    if (s.theme === "light") { currentTheme = "light"; document.body.classList.add("light-theme"); }
    if (s.showEma && UI.emaToggle) UI.emaToggle.checked = true;

    /* Strategy filter toggles */
    if (s.autoResetEnabled != null) autoResetEnabled = s.autoResetEnabled;
    if (s.emaFilterEnabled != null) emaFilterEnabled = s.emaFilterEnabled;
    if (s.htfFilterEnabled != null) htfFilterEnabled = s.htfFilterEnabled;
    if (s.atrToleranceEnabled != null) atrToleranceEnabled = s.atrToleranceEnabled;
    if (s.trailingStopEnabled != null) trailingStopEnabled = s.trailingStopEnabled;
    if (s.partialTpEnabled != null) partialTpEnabled = s.partialTpEnabled;
    if (s.falseBreakoutEnabled != null) falseBreakoutEnabled = s.falseBreakoutEnabled;
    if (s.minRREnabled != null) minRREnabled = s.minRREnabled;
    if (s.minRRValue != null) minRRValue = s.minRRValue;
    if (s.pureTrailingEnabled != null) pureTrailingEnabled = s.pureTrailingEnabled;
    if (UI.autoResetToggle) UI.autoResetToggle.checked = autoResetEnabled;
    if (UI.emaFilterToggle) UI.emaFilterToggle.checked = emaFilterEnabled;
    if (UI.htfFilterToggle) UI.htfFilterToggle.checked = htfFilterEnabled;
    if (UI.atrToleranceToggle) UI.atrToleranceToggle.checked = atrToleranceEnabled;
    if (UI.trailingStopToggle) UI.trailingStopToggle.checked = trailingStopEnabled;
    if (UI.partialTpToggle) UI.partialTpToggle.checked = partialTpEnabled;
    if (UI.falseBreakoutToggle) UI.falseBreakoutToggle.checked = falseBreakoutEnabled;
    if (UI.minRRToggle) UI.minRRToggle.checked = minRREnabled;
    if (UI.minRRInput) UI.minRRInput.value = minRRValue;
    if (UI.pureTrailingToggle) UI.pureTrailingToggle.checked = pureTrailingEnabled;

    /* Tesla 3–6–9 Scaling Model */
    if (s.teslaScalingEnabled != null) teslaScalingEnabled = s.teslaScalingEnabled;
    if (s.teslaScalingPlan != null) teslaScalingPlan = s.teslaScalingPlan;
    if (UI.teslaScalingToggle) UI.teslaScalingToggle.checked = teslaScalingEnabled;
    if (UI.teslaScalingPlan) UI.teslaScalingPlan.value = teslaScalingPlan;

    /* New filter toggles */
    if (s.rsiFilterEnabled != null) rsiFilterEnabled = s.rsiFilterEnabled;
    if (s.volumeSpikeEnabled != null) volumeSpikeEnabled = s.volumeSpikeEnabled;
    if (s.sessionFilterEnabled != null) sessionFilterEnabled = s.sessionFilterEnabled;
    if (s.sessionFilterMode != null) sessionFilterMode = s.sessionFilterMode;
    if (s.fibRetestEnabled != null) fibRetestEnabled = s.fibRetestEnabled;
    if (UI.rsiFilterToggle) UI.rsiFilterToggle.checked = rsiFilterEnabled;
    if (UI.volumeSpikeToggle) UI.volumeSpikeToggle.checked = volumeSpikeEnabled;
    if (UI.sessionFilterToggle) UI.sessionFilterToggle.checked = sessionFilterEnabled;
    if (UI.sessionFilterMode) UI.sessionFilterMode.value = sessionFilterMode;
    if (UI.fibRetestToggle) UI.fibRetestToggle.checked = fibRetestEnabled;

    /* GainzAlgo V2 filter toggles */
    if (s.macdFilterEnabled != null) macdFilterEnabled = s.macdFilterEnabled;
    if (s.bbSqueezeFilterEnabled != null) bbSqueezeFilterEnabled = s.bbSqueezeFilterEnabled;
    if (s.adxFilterEnabled != null) adxFilterEnabled = s.adxFilterEnabled;
    if (s.stochFilterEnabled != null) stochFilterEnabled = s.stochFilterEnabled;
    if (UI.macdFilterToggle) UI.macdFilterToggle.checked = macdFilterEnabled;
    if (UI.bbSqueezeFilterToggle) UI.bbSqueezeFilterToggle.checked = bbSqueezeFilterEnabled;
    if (UI.adxFilterToggle) UI.adxFilterToggle.checked = adxFilterEnabled;
    if (UI.stochFilterToggle) UI.stochFilterToggle.checked = stochFilterEnabled;

    /* Scalping mode */
    if (s.scalpingModeEnabled != null) scalpingModeEnabled = s.scalpingModeEnabled;
    if (UI.scalpingModeToggle) UI.scalpingModeToggle.checked = scalpingModeEnabled;

    if (s.nyOpenRangeEnabled != null) nyOpenRangeEnabled = s.nyOpenRangeEnabled;
    if (UI.nyOpenRangeToggle) UI.nyOpenRangeToggle.checked = nyOpenRangeEnabled;

    /* Session Ranges */
    if (s.sessionRangesEnabled != null) sessionRangesEnabled = s.sessionRangesEnabled;
    if (UI.sessionRangesToggle) UI.sessionRangesToggle.checked = sessionRangesEnabled;

    /* Profit-Direction Constraint toggles */
    if (s.minConfluenceEnabled != null) minConfluenceEnabled = s.minConfluenceEnabled;
    if (s.minConfluenceValue != null) minConfluenceValue = s.minConfluenceValue;
    if (s.doubleRetestEnabled != null) doubleRetestEnabled = s.doubleRetestEnabled;
    if (s.confirmBarEnabled != null) confirmBarEnabled = s.confirmBarEnabled;
    if (s.divergenceFilterEnabled != null) divergenceFilterEnabled = s.divergenceFilterEnabled;
    if (s.adxHardGateEnabled != null) adxHardGateEnabled = s.adxHardGateEnabled;
    if (s.adxMaxThreshold != null) adxMaxThreshold = s.adxMaxThreshold;
    if (s.breakoutDistEnabled != null) breakoutDistEnabled = s.breakoutDistEnabled;
    if (s.breakoutDistATR != null) breakoutDistATR = s.breakoutDistATR;
    if (s.timeDecayEnabled != null) timeDecayEnabled = s.timeDecayEnabled;
    if (s.timeDecayCandles != null) timeDecayCandles = s.timeDecayCandles;
    if (s.consecutiveDirEnabled != null) consecutiveDirEnabled = s.consecutiveDirEnabled;
    if (s.vwapFilterEnabled != null) vwapFilterEnabled = s.vwapFilterEnabled;
    if (s.stochCrossEnabled != null) stochCrossEnabled = s.stochCrossEnabled;
    if (s.rangeSizeEnabled != null) rangeSizeEnabled = s.rangeSizeEnabled;
    if (s.rangeSizeMin != null) rangeSizeMin = s.rangeSizeMin;
    if (s.rangeSizeMax != null) rangeSizeMax = s.rangeSizeMax;
    if (s.hhhlEnabled != null) hhhlEnabled = s.hhhlEnabled;
    if (s.followThroughEnabled != null) followThroughEnabled = s.followThroughEnabled;
    if (s.mtfStructureEnabled != null) mtfStructureEnabled = s.mtfStructureEnabled;
    if (UI.minConfluenceToggle)    UI.minConfluenceToggle.checked    = minConfluenceEnabled;
    if (UI.minConfluenceInput)     UI.minConfluenceInput.value       = minConfluenceValue;
    if (UI.doubleRetestToggle)     UI.doubleRetestToggle.checked     = doubleRetestEnabled;
    if (UI.confirmBarToggle)       UI.confirmBarToggle.checked       = confirmBarEnabled;
    if (UI.divergenceFilterToggle) UI.divergenceFilterToggle.checked = divergenceFilterEnabled;
    if (UI.adxHardGateToggle)      UI.adxHardGateToggle.checked      = adxHardGateEnabled;
    if (UI.adxMaxInput)            UI.adxMaxInput.value              = adxMaxThreshold;
    if (UI.breakoutDistToggle)     UI.breakoutDistToggle.checked     = breakoutDistEnabled;
    if (UI.breakoutDistInput)      UI.breakoutDistInput.value        = breakoutDistATR;
    if (UI.timeDecayToggle)        UI.timeDecayToggle.checked        = timeDecayEnabled;
    if (UI.timeDecayInput)         UI.timeDecayInput.value           = timeDecayCandles;
    if (UI.consecutiveDirToggle)   UI.consecutiveDirToggle.checked   = consecutiveDirEnabled;
    if (UI.vwapFilterToggle)       UI.vwapFilterToggle.checked       = vwapFilterEnabled;
    if (UI.stochCrossToggle)       UI.stochCrossToggle.checked       = stochCrossEnabled;
    if (UI.rangeSizeToggle)        UI.rangeSizeToggle.checked        = rangeSizeEnabled;
    if (UI.rangeSizeMinInput)      UI.rangeSizeMinInput.value        = rangeSizeMin;
    if (UI.rangeSizeMaxInput)      UI.rangeSizeMaxInput.value        = rangeSizeMax;
    if (UI.hhhlToggle)             UI.hhhlToggle.checked             = hhhlEnabled;
    if (UI.followThroughToggle)    UI.followThroughToggle.checked    = followThroughEnabled;
    if (UI.mtfStructureToggle)     UI.mtfStructureToggle.checked     = mtfStructureEnabled;

    /* Live Scalp Scanner */
    if (s.liveScalpEnabled != null) liveScalpEnabled = s.liveScalpEnabled;
    if (s.liveScalpMinConf != null) liveScalpMinConf = s.liveScalpMinConf;
    if (UI.liveScalpToggle) UI.liveScalpToggle.checked = liveScalpEnabled;
    if (UI.liveScalpMinConf) UI.liveScalpMinConf.value = liveScalpMinConf;

    /* Strategy 1: Liquidity Sweep */
    if (s.liquiditySweepEnabled != null) liquiditySweepEnabled = s.liquiditySweepEnabled;
    if (UI.liquiditySweepToggle) UI.liquiditySweepToggle.checked = liquiditySweepEnabled;

    /* Strategy 2: Stop Loss Hunt */
    if (s.stopLossHuntEnabled != null) stopLossHuntEnabled = s.stopLossHuntEnabled;
    if (UI.stopLossHuntToggle) UI.stopLossHuntToggle.checked = stopLossHuntEnabled;

    /* Strategy 3: Failed Pin Bar */
    if (s.failedPinBarEnabled != null) failedPinBarEnabled = s.failedPinBarEnabled;
    if (UI.failedPinBarToggle) UI.failedPinBarToggle.checked = failedPinBarEnabled;

    /* Strategy 4: Fib Golden Zone Scalp */
    if (s.fibScalpEnabled != null) fibScalpEnabled = s.fibScalpEnabled;
    if (UI.fibScalpToggle) UI.fibScalpToggle.checked = fibScalpEnabled;

    /* Strategy 5: Power of 3 (ICT) */
    if (s.po3Enabled != null) po3Enabled = s.po3Enabled;
    if (s.po3EntryMaxAge != null) po3EntryMaxAge = _normalizePo3EntryMaxAge(s.po3EntryMaxAge);
    if (UI.po3Toggle) UI.po3Toggle.checked = po3Enabled;
    if (UI.po3FreshnessMode) UI.po3FreshnessMode.value = String(po3EntryMaxAge);

    /* Strategy 9: Fair Value Gap (FVG) */
    if (s.fvgStratEnabled != null) fvgStratEnabled = s.fvgStratEnabled;
    if (UI.fvgStratToggle) UI.fvgStratToggle.checked = fvgStratEnabled;
    if (s.autoTradeFvgStrat != null) autoTradeFvgStrat = s.autoTradeFvgStrat;
    if (UI.autoTradeFvgStratToggle) UI.autoTradeFvgStratToggle.checked = autoTradeFvgStrat;

    /* Strategy 11: MTF Top-Down */
    if (s.mtfTopDownEnabled != null) mtfTopDownEnabled = s.mtfTopDownEnabled;
    if (UI.mtfTopDownToggle) UI.mtfTopDownToggle.checked = mtfTopDownEnabled;
    if (s.autoTradeMtfTopDown != null) autoTradeMtfTopDown = s.autoTradeMtfTopDown;
    if (UI.autoTradeMtfTopDownToggle) UI.autoTradeMtfTopDownToggle.checked = autoTradeMtfTopDown;

    /* Auto-apply recommended */
    if (s.autoApplyRecommended != null) autoApplyRecommended = s.autoApplyRecommended;
    if (UI.autoApplyRecToggle) UI.autoApplyRecToggle.checked = autoApplyRecommended;

    /* Lock toggles */
    if (s.lockTimeframe != null) lockTimeframe = s.lockTimeframe;
    if (s.lockRR != null) lockRR = s.lockRR;
    if (s.lockIndicatorFilters != null) lockIndicatorFilters = s.lockIndicatorFilters;
    if (UI.lockTimeframeToggle) UI.lockTimeframeToggle.checked = lockTimeframe;
    if (UI.lockRRToggle) UI.lockRRToggle.checked = lockRR;
    if (UI.lockIndicatorFiltersToggle) UI.lockIndicatorFiltersToggle.checked = lockIndicatorFilters;

    /* Telegram settings */
    if (s.telegramBotToken != null) {
      telegramBotToken = _deobfuscate(s.telegramBotToken);
    }
    if (s.telegramChatId != null) telegramChatId = s.telegramChatId;
    if (s.telegramAutoSend != null) telegramAutoSend = s.telegramAutoSend;
    if (s.telegramScalpAutoSend != null) telegramScalpAutoSend = s.telegramScalpAutoSend;
    if (s.telegramOutcomeSend != null) telegramOutcomeSend = s.telegramOutcomeSend;
    if (s.telegramScalpOutcomeSend != null) telegramScalpOutcomeSend = s.telegramScalpOutcomeSend;
    if (s.telegramSessionRangeAutoSend != null) telegramSessionRangeAutoSend = s.telegramSessionRangeAutoSend;
    if (s.telegramSessionRangeOutcomeSend != null) telegramSessionRangeOutcomeSend = s.telegramSessionRangeOutcomeSend;
    if (s.telegramStrategyAutoSend != null) telegramStrategyAutoSend = s.telegramStrategyAutoSend;
    if (s.telegramStrategyOutcomeSend != null) telegramStrategyOutcomeSend = s.telegramStrategyOutcomeSend;
    if (s.telegramProfitExitAlertEnabled != null) telegramProfitExitAlertEnabled = s.telegramProfitExitAlertEnabled;
    if (UI.telegramBotToken) UI.telegramBotToken.value = telegramBotToken;
    if (UI.telegramChatId) UI.telegramChatId.value = telegramChatId;
    if (UI.telegramAutoSendToggle) UI.telegramAutoSendToggle.checked = telegramAutoSend;
    if (UI.telegramScalpAutoSendToggle) UI.telegramScalpAutoSendToggle.checked = telegramScalpAutoSend;
    if (UI.telegramOutcomeSendToggle) UI.telegramOutcomeSendToggle.checked = telegramOutcomeSend;
    if (UI.telegramScalpOutcomeSendToggle) UI.telegramScalpOutcomeSendToggle.checked = telegramScalpOutcomeSend;
    if (UI.telegramSessionRangeAutoSendToggle) UI.telegramSessionRangeAutoSendToggle.checked = telegramSessionRangeAutoSend;
    if (UI.telegramSessionRangeOutcomeSendToggle) UI.telegramSessionRangeOutcomeSendToggle.checked = telegramSessionRangeOutcomeSend;
    if (UI.telegramStrategyAutoSendToggle) UI.telegramStrategyAutoSendToggle.checked = telegramStrategyAutoSend;
    if (UI.telegramStrategyOutcomeSendToggle) UI.telegramStrategyOutcomeSendToggle.checked = telegramStrategyOutcomeSend;
    if (UI.telegramProfitExitAlertToggle) UI.telegramProfitExitAlertToggle.checked = telegramProfitExitAlertEnabled;

    /* Account sizing */
    if (s.accountSize != null) accountSize = s.accountSize;
    if (s.riskPercent != null) riskPercent = s.riskPercent;
    if (UI.accountSizeInput) UI.accountSizeInput.value = accountSize > 0 ? accountSize : "";
    if (UI.riskPercentInput) UI.riskPercentInput.value = riskPercent;

    /* Auto-trade */
    if (s.autoTradeEnabled != null) autoTradeEnabled = s.autoTradeEnabled;
    if (s.autoTradeScalpEnabled != null) autoTradeScalpEnabled = s.autoTradeScalpEnabled;
    if (s.autoTradeStrategyEnabled != null) autoTradeStrategyEnabled = s.autoTradeStrategyEnabled;
    if (s.autoTradeStake != null) autoTradeStake = s.autoTradeStake;
    if (s.autoTradeMaxStake != null) autoTradeMaxStake = s.autoTradeMaxStake;
    if (s.autoTradeSessionTP != null) autoTradeSessionTP = s.autoTradeSessionTP;
    if (s.autoTradeSessionSL != null) autoTradeSessionSL = s.autoTradeSessionSL;
    /* Initialise dynamic stake from restored base */
    autoTradeCurrentStake = Math.max(MIN_AUTO_TRADE_STAKE, parseFloat(autoTradeStake) || 1);
    if (s.autoTradeMultiplier != null) autoTradeMultiplier = s.autoTradeMultiplier;
    if (s.maxConcurrentTrades != null) {
      maxConcurrentTrades = Math.max(1, Math.min(MAX_CONCURRENT_TRADES_LIMIT, parseInt(s.maxConcurrentTrades, 10) || DEFAULT_MAX_CONCURRENT_TRADES));
    }
    if (UI.autoTradeToggle) UI.autoTradeToggle.checked = autoTradeEnabled;
    if (UI.autoTradeScalpToggle) UI.autoTradeScalpToggle.checked = autoTradeScalpEnabled;
    if (UI.autoTradeStrategyToggle) UI.autoTradeStrategyToggle.checked = autoTradeStrategyEnabled;
    if (UI.autoTradeStake) UI.autoTradeStake.value = autoTradeStake;
    if (UI.autoTradeMaxStake) UI.autoTradeMaxStake.value = autoTradeMaxStake > 0 ? autoTradeMaxStake : "";
    if (UI.autoTradeSessionTP) UI.autoTradeSessionTP.value = autoTradeSessionTP > 0 ? autoTradeSessionTP : "";
    if (UI.autoTradeSessionSL) UI.autoTradeSessionSL.value = autoTradeSessionSL > 0 ? autoTradeSessionSL : "";
    if (UI.autoTradeMultiplier) UI.autoTradeMultiplier.value = autoTradeMultiplier;
    if (UI.maxConcurrentTrades) UI.maxConcurrentTrades.value = maxConcurrentTrades;
    updateAutoTradeCurrentStakeUI();
    if (s.autoTradeScalpOpposite != null) autoTradeScalpOpposite = s.autoTradeScalpOpposite;
    if (s.autoTradeStrategyOpposite != null) autoTradeStrategyOpposite = s.autoTradeStrategyOpposite;
    if (UI.autoTradeScalpOppositeToggle) UI.autoTradeScalpOppositeToggle.checked = autoTradeScalpOpposite;
    if (UI.autoTradeStrategyOppositeToggle) UI.autoTradeStrategyOppositeToggle.checked = autoTradeStrategyOpposite;
    /* Per-strategy auto-trade sub-toggles */
    if (s.autoTradeLiquiditySweep != null) autoTradeLiquiditySweep = s.autoTradeLiquiditySweep;
    if (s.autoTradeStopLossHunt != null)   autoTradeStopLossHunt   = s.autoTradeStopLossHunt;
    if (s.autoTradeFailedPinBar != null)   autoTradeFailedPinBar   = s.autoTradeFailedPinBar;
    if (s.autoTradeFibScalp != null)       autoTradeFibScalp       = s.autoTradeFibScalp;
    if (s.autoTradePo3 != null)            autoTradePo3            = s.autoTradePo3;
    if (s.autoTradeNYOpenRange != null)    autoTradeNYOpenRange    = s.autoTradeNYOpenRange;
    if (s.autoTradeSessionRange != null)   autoTradeSessionRange   = s.autoTradeSessionRange;
    if (s.autoTradeGridScalperMA != null)  autoTradeGridScalperMA  = s.autoTradeGridScalperMA;
    if (UI.autoTradeLiquiditySweepToggle) UI.autoTradeLiquiditySweepToggle.checked = autoTradeLiquiditySweep;
    if (UI.autoTradeStopLossHuntToggle)   UI.autoTradeStopLossHuntToggle.checked   = autoTradeStopLossHunt;
    if (UI.autoTradeFailedPinBarToggle)   UI.autoTradeFailedPinBarToggle.checked   = autoTradeFailedPinBar;
    if (UI.autoTradeFibScalpToggle)       UI.autoTradeFibScalpToggle.checked       = autoTradeFibScalp;
    if (UI.autoTradePo3Toggle)            UI.autoTradePo3Toggle.checked            = autoTradePo3;
    if (UI.autoTradeNYOpenRangeToggle)    UI.autoTradeNYOpenRangeToggle.checked    = autoTradeNYOpenRange;
    if (UI.autoTradeSessionRangeToggle)   UI.autoTradeSessionRangeToggle.checked   = autoTradeSessionRange;
    if (UI.autoTradeGridScalperMAToggle)  UI.autoTradeGridScalperMAToggle.checked  = autoTradeGridScalperMA;

    /* Grid Scalper MA strategy */
    if (s.gridScalperMAEnabled != null)  gridScalperMAEnabled  = s.gridScalperMAEnabled;
    if (s.gridScalperMAStrategy != null) gridScalperMAStrategy = s.gridScalperMAStrategy;
    if (s.gridScalperMAPeriod != null)   gridScalperMAPeriod   = Math.max(2, parseInt(s.gridScalperMAPeriod, 10) || 21);
    if (UI.gridScalperMAToggle)          UI.gridScalperMAToggle.checked          = gridScalperMAEnabled;
    if (UI.gridScalperMAStrategySelect)  UI.gridScalperMAStrategySelect.value    = gridScalperMAStrategy;
    if (UI.gridScalperMAPeriodInput)     UI.gridScalperMAPeriodInput.value       = gridScalperMAPeriod;
    _updateGridScalperMAPeriodVisibility();

    /* Feature settings restore */
    if (s.orderblockEnabled != null)        orderblockEnabled        = s.orderblockEnabled;
    if (s.autoTradeOrderblock != null)      autoTradeOrderblock      = s.autoTradeOrderblock;
    if (s.sessionHeatmapEnabled != null)    sessionHeatmapEnabled    = s.sessionHeatmapEnabled;
    if (s.candleAnnotationsEnabled != null) candleAnnotationsEnabled = s.candleAnnotationsEnabled;
    if (s.volumeProfileEnabled != null)     volumeProfileEnabled     = s.volumeProfileEnabled;
    if (s.fibExtensionsEnabled != null)     fibExtensionsEnabled     = s.fibExtensionsEnabled;
    if (s.bosChochEnabled != null)          bosChochEnabled          = s.bosChochEnabled;
    if (s.divergenceVisualEnabled != null)  divergenceVisualEnabled  = s.divergenceVisualEnabled;
    if (s.newsPauseEnabled != null)         newsPauseEnabled         = s.newsPauseEnabled;
    if (s.newsPauseMinutes != null)         newsPauseMinutes         = s.newsPauseMinutes;
    if (s.multiRLadderEnabled != null)      multiRLadderEnabled      = s.multiRLadderEnabled;
    if (s.adaptiveConfluenceEnabled != null) adaptiveConfluenceEnabled = s.adaptiveConfluenceEnabled;
    if (s.scannerEnabled != null)           scannerEnabled           = s.scannerEnabled;
    if (s.scannerSymbols != null) {
      try { const arr = JSON.parse(s.scannerSymbols); if (Array.isArray(arr)) scannerSymbols = arr.map(migrateSymbol); } catch(e) {}
    }
    if (s.backtestSpeedMs != null) backtestSpeedMs = Math.max(BACKTEST_MIN_SPEED_MS, Math.min(BACKTEST_MAX_SPEED_MS, parseInt(s.backtestSpeedMs,10) || BACKTEST_DEFAULT_SPEED_MS));
    if (UI.orderblockToggle)          UI.orderblockToggle.checked          = orderblockEnabled;
    if (UI.autoTradeOrderblockToggle) UI.autoTradeOrderblockToggle.checked = autoTradeOrderblock;
    if (UI.sessionHeatmapToggle)      UI.sessionHeatmapToggle.checked      = sessionHeatmapEnabled;
    if (UI.candleAnnotationsToggle)   UI.candleAnnotationsToggle.checked   = candleAnnotationsEnabled;
    if (UI.volumeProfileToggle)       UI.volumeProfileToggle.checked       = volumeProfileEnabled;
    if (UI.fibExtensionsToggle)       UI.fibExtensionsToggle.checked       = fibExtensionsEnabled;
    if (UI.bosChochToggle)            UI.bosChochToggle.checked            = bosChochEnabled;
    if (UI.divergenceVisualToggle)    UI.divergenceVisualToggle.checked    = divergenceVisualEnabled;
    if (UI.newsPauseToggle)           UI.newsPauseToggle.checked           = newsPauseEnabled;
    if (UI.newsPauseMinutesInput)     UI.newsPauseMinutesInput.value       = newsPauseMinutes;
    if (UI.multiRLadderToggle)        UI.multiRLadderToggle.checked        = multiRLadderEnabled;
    if (UI.adaptiveConfluenceToggle)  UI.adaptiveConfluenceToggle.checked  = adaptiveConfluenceEnabled;
    if (UI.scannerToggle)             UI.scannerToggle.checked             = scannerEnabled;
    if (UI.scannerSymbolPicker) {
      const symSet = new Set(scannerSymbols);
      UI.scannerSymbolPicker.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = symSet.has(cb.dataset.symbol);
      });
      updateScannerSymbolCount();
    }
    if (UI.backtestSpeedInput)        UI.backtestSpeedInput.value          = backtestSpeedMs;

    /* Restore auto-trade history */
    restoreAutoTradeHistory();
    updateAutoTradeBalanceVisibility();
    updateStrategyBadges();
  } catch (e) { /* storage not available */ }
}

function persistSignalLog() {
  try {
    const items = [];
    if (UI.signalLog) {
      for (let i = 0; i < Math.min(UI.signalLog.children.length, 50); i++) {
        items.push(UI.signalLog.children[i].textContent);
      }
    }
    localStorage.setItem(LS_PREFIX + "signalLog", JSON.stringify(items));
  } catch (e) {
    console.warn("Failed to persist signal log:", e.message);
  }
}

function restoreSignalLog() {
  try {
    const raw = localStorage.getItem(LS_PREFIX + "signalLog");
    if (!raw || !UI.signalLog) return;
    const items = JSON.parse(raw);
    if (Array.isArray(items)) {
      items.reverse().forEach(text => {
        const li = document.createElement("li");
        li.textContent = text;
        UI.signalLog.prepend(li);
      });
    }
  } catch (e) {
    console.warn("Failed to restore signal log:", e.message);
  }
}

function persistSignalHistory() {
  try {
    /* Strip chartImage data URLs to avoid exceeding localStorage quota */
    const stripped = signalHistory.slice(-50).map(s => {
      if (!s || !s.chartImage) return s;
      const copy = Object.assign({}, s);
      delete copy.chartImage;
      return copy;
    });
    localStorage.setItem(LS_PREFIX + "signalHistory", JSON.stringify(stripped));
  } catch (e) {
    console.warn("Failed to persist signal history:", e.message);
  }
}

function restoreSignalHistory() {
  try {
    const raw = localStorage.getItem(LS_PREFIX + "signalHistory");
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      signalHistory = parsed;
      signalWins = signalHistory.filter(s => s && s.result === "WIN").length;
      signalLosses = signalHistory.filter(s => s && s.result === "LOSS").length;
      updateStatsUI();
    }
  } catch (e) {
    console.warn("Failed to restore signal history:", e.message);
  }
}

/* ================= STATS ================= */
function updateStatsUI() {
  /* For focused-panel-specific stats, skip non-focused panels */
  const isFocusedOrSingle = !_multiPanelProcessing || _multiPanelProcessing === focusedPanelSymbol;

  if (isFocusedOrSingle) {
    if (UI.signalWins) UI.signalWins.textContent = signalWins;
    if (UI.signalLosses) UI.signalLosses.textContent = signalLosses;
    const total = signalWins + signalLosses;
    if (UI.signalWinRate) UI.signalWinRate.textContent = total > 0 ? (signalWins / total * 100).toFixed(1) + "%" : "0%";
    updateStrategyWinRatesUI();
  }

  /* Always update aggregated signal count and banners (across all panels) */
  const allSignals = getAggregatedSignalHistory();
  if (UI.signalCount) UI.signalCount.textContent = allSignals.length;
  updateScalpStatsUI();
  renderSignalBanner();
  renderScalpTickerBanner();
  renderStrategyTickerBanner();

  /* Feature 3: Equity curve */
  drawEquityCurve();

  /* Feature 16: P&L breakdown */
  renderPLBreakdown();

  /* Feature 13: Adaptive confluence */
  if (adaptiveConfluenceEnabled) renderAdaptiveConfluenceTable();

  /* Feature 8: Scanner */
  if (scannerEnabled) updateScannerUI();
}

/**
 * Render the per-strategy win rate grid in the Stats panel.
 * Shows each active strategy's individual W / L / win-rate.
 */
function updateStrategyWinRatesUI() {
  const rows = [
    { id: "stratWR_breakout",       history: signalHistory,          label: "🔲 Breakout" },
    { id: "stratWR_liquiditySweep", history: liquiditySweepHistory,  label: "🌊 Liq. Sweep" },
    { id: "stratWR_stopLossHunt",   history: stopLossHuntHistory,    label: "🎯 SL Hunt" },
    { id: "stratWR_failedPinBar",   history: failedPinBarHistory,    label: "📌 Failed Pin Bar" },
    { id: "stratWR_fibScalp",       history: fibScalpHistory,        label: "📐 Fib Golden" },
    { id: "stratWR_po3",            history: po3History,             label: "⚡ Power of 3" },
    { id: "stratWR_nyOpenRange",    history: nyOpenRangeHistory,     label: "🕤 NY Open" },
    { id: "stratWR_sessionRange",   history: sessionRangeHistory,    label: "🌍 Session Rng" },
    { id: "stratWR_gridScalper",    history: gridScalperMAHistory,   label: "🔲 Grid Scalper" },
    { id: "stratWR_fvgStrat",       history: fvgStratHistory,        label: "🎯 FVG" },
    { id: "stratWR_liveScalp",      history: liveScalpHistory,       label: "⚡ Live Scalp" },
    { id: "stratWR_mtfTopDown",     history: mtfTopDownHistory,      label: "⏱ MTF Top-Down" },
    { id: "stratWR_orderblock",     history: orderblockHistory,      label: "🏦 Orderblock" }
  ];
  for (const r of rows) {
    const el = document.getElementById(r.id);
    if (!el) continue;
    const wins   = r.history.filter(s => s && s.result === "WIN").length;
    const losses = r.history.filter(s => s && s.result === "LOSS").length;
    const total  = wins + losses;
    if (total === 0) { el.innerHTML = ""; el.style.display = "none"; continue; }
    el.style.display = "";
    const rate = (wins / total * 100).toFixed(1) + "%";
    el.innerHTML = `<span class="strat-wr-name">${r.label}</span>`
      + `<span class="strat-wr-wins">${wins}</span>`
      + `<span class="strat-wr-losses">${losses}</span>`
      + `<span class="strat-wr-rate">${rate}</span>`;
  }
}


/* ---- Switch sidebar to a specific tab programmatically ---- */
function switchSidebarTab(tabId) {
  const tabs = document.querySelectorAll(".sidebar-tab");
  const panes = document.querySelectorAll(".tab-pane");
  tabs.forEach(t => { t.classList.remove("active"); t.setAttribute("aria-selected", "false"); });
  panes.forEach(p => p.classList.remove("active"));
  const targetTab = document.querySelector(`.sidebar-tab[data-tab="${tabId}"]`);
  const targetPane = document.getElementById(tabId);
  if (targetTab) { targetTab.classList.add("active"); targetTab.setAttribute("aria-selected", "true"); }
  if (targetPane) targetPane.classList.add("active");

  /* On mobile, ensure the panel content is open */
  const panelContent = document.getElementById("panelContent");
  if (panelContent && !panelContent.classList.contains("panel-open")) {
    panelContent.classList.add("panel-open");
  }
}

/* ---- Scroll to chart view (used by banner card clicks) ---- */
function scrollToChartView() {
  /* On mobile, close the sidebar panel so the chart is visible */
  const panelContent = document.getElementById("panelContent");
  if (panelContent && panelContent.classList.contains("panel-open")) {
    panelContent.classList.remove("panel-open");
  }

  /* Scroll the chart canvas into view, respecting reduced-motion preference */
  const chart = document.getElementById("mainChart");
  if (chart) {
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    chart.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "center" });
  }
}

/* ---- Handle signal card click from banner ---- */
function handleSignalCardClick(signal) {
  /* If multi-symbol, focus the panel for this signal's symbol */
  if (multiPanels.size > 0 && signal.symbol && multiPanels.has(signal.symbol)) {
    focusPanel(signal.symbol);
  }
  /* Scroll to chart view so the user can see the signal on the chart */
  scrollToChartView();
}

/* ---- Handle scalp card click from banner ---- */
function handleScalpCardClick(scalp) {
  const sym = scalp.symbol || getActiveSymbol();
  /* If multi-symbol, focus the panel for this scalp's symbol */
  if (multiPanels.size > 0 && sym && multiPanels.has(sym)) {
    focusPanel(sym);
  }
  /* Scroll to chart view so the user can see the scalp on the chart */
  scrollToChartView();
}

/* ---- Live Signal Ticker Banner ---- */
function renderSignalBanner() {
  if (!UI.signalBannerTrack) return;
  UI.signalBannerTrack.innerHTML = "";

  /* Aggregate signals from ALL panels (multi-symbol) or global (single) */
  const allSignals = getAggregatedSignalHistory();

  if (allSignals.length === 0) {
    const empty = document.createElement("span");
    empty.className = "signal-banner-empty";
    empty.textContent = "No signals yet — waiting for breakout setups…";
    UI.signalBannerTrack.appendChild(empty);
    return;
  }

  /* Newest first: multi-panel aggregated list is already sorted newest-first;
     single-symbol signalHistory is stored oldest-first so we reverse it */
  const sorted = multiPanels.size > 0 ? allSignals : allSignals.slice().reverse();
  const signals = sorted.slice(0, BANNER_DISPLAY_MAX);
  for (const s of signals) {
    const card = document.createElement("div");
    const resultLower = (s.result || "PENDING").toLowerCase();
    card.className = "signal-card" + (resultLower === "win" ? " signal-card-win" : resultLower === "loss" ? " signal-card-loss" : resultLower === "confirmed" ? " signal-card-confirmed" : "");

    const isBull = s.dir === "BULL";
    const dirLabel = isBull ? "▲" : "▼";
    const dirClass = isBull ? "bull" : "bear";
    const t = new Date(s.time);
    const ts = t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const sym = s.symbol || "--";
    const isConfirmed = resultLower === "confirmed";
    const entryStr = s.entry != null ? fmtPrice(s.entry, s.symbol) : "--";
    const slStr = s.sl != null ? fmtPrice(s.sl, s.symbol) : "--";
    const tpStr = s.tp != null ? fmtPrice(s.tp, s.symbol) : "--";
    const rrStr = s.rr != null ? "1:" + s.rr.toFixed(1) : "--";
    const confStr = s.confluenceScore != null ? s.confluenceScore + "/16" : "";
    const patternStr = s.confirmPattern || "";

    card.innerHTML =
      `<span class="signal-card-dir ${dirClass}">${dirLabel}</span>` +
      `<span class="signal-card-symbol">${sym}</span>` +
      (isConfirmed && patternStr
        ? `<span class="signal-card-pattern">${patternStr}</span>`
        : `<span class="signal-card-price">@ ${entryStr}</span>`) +
      (isConfirmed ? "" : `<span class="signal-card-levels">SL ${slStr} · TP ${tpStr}</span>`) +
      (isConfirmed ? "" : `<span class="signal-card-sep">·</span><span class="signal-card-rr">${rrStr}</span>`) +
      (confStr ? `<span class="signal-card-conf">⚡${confStr}</span>` : "") +
      `<span class="signal-card-time">${ts}</span>` +
      `<span class="signal-card-result ${resultLower}">${s.result || "PENDING"}</span>`;

    /* Feature 12: Signal note field — build programmatically (no innerHTML with user data) */
    const noteId = `sig_${s.time}_${sym}`;
    const existingNote = getSignalNote(noteId);
    const noteEl = document.createElement("div");
    noteEl.className = "signal-note-row";
    const noteInput = document.createElement("input");
    noteInput.type = "text";
    noteInput.className = "signal-note-input";
    noteInput.placeholder = "Add note…";
    noteInput.value = existingNote;
    noteInput.dataset.noteId = noteId;
    noteInput.title = "Trade journal note for this signal";
    noteInput.addEventListener("change", (e) => { saveSignalNote(noteId, e.target.value); });
    noteEl.appendChild(noteInput);

    card.title = isConfirmed
      ? `${isBull ? "BUY" : "SELL"} ${sym} — ${patternStr} confirmed\nAwaiting trade build…`
      : `Click to view details · ${isBull ? "BUY" : "SELL"} ${sym} @ ${entryStr}\nSL: ${slStr}  TP: ${tpStr}  R:R ${rrStr}\nConf: ${confStr || "N/A"}\nResult: ${s.result || "PENDING"}`;
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", `View ${isBull ? "BUY" : "SELL"} ${sym} signal details`);

    /* Clickable — focuses the panel and switches sidebar to State tab */
    card.addEventListener("click", () => handleSignalCardClick(s));
    card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleSignalCardClick(s); } });

    card.appendChild(noteEl);
    UI.signalBannerTrack.appendChild(card);
  }

  /* Auto-scroll to show the newest signal (leftmost) */
  UI.signalBannerTrack.scrollLeft = 0;
}

/* ---- Live Scalp Ticker Banner ---- */
function renderScalpTickerBanner() {
  if (!UI.scalpTickerTrack) return;
  UI.scalpTickerTrack.innerHTML = "";

  /* Aggregate scalp signals from ALL panels (multi-symbol) or global (single) */
  const allScalps = getAggregatedScalpHistory();

  if (allScalps.length === 0) {
    const empty = document.createElement("span");
    empty.className = "scalp-ticker-empty";
    empty.textContent = "No scalp signals yet — scanner active…";
    UI.scalpTickerTrack.appendChild(empty);
    return;
  }

  /* Render newest first (aggregated list is already newest-first) */
  const scalpLimit = Math.min(allScalps.length, BANNER_DISPLAY_MAX);
  for (let i = 0; i < scalpLimit; i++) {
    const s = allScalps[i];
    const card = document.createElement("div");
    const isBull = s.dir === "BULL";
    const resultLower = (s.result || "PENDING").toLowerCase();
    card.className = `scalp-card ${isBull ? "scalp-card-bull" : "scalp-card-bear"}${i === 0 ? " scalp-card-new" : ""}${resultLower === "win" ? " scalp-card-win" : resultLower === "loss" ? " scalp-card-loss" : ""}`;

    const dirLabel = isBull ? "▲" : "▼";
    const dirClass = isBull ? "bull" : "bear";
    const t = new Date(s.epoch * 1000);
    const ts = t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const sym = s.symbol || getActiveSymbol() || "--";
    const entryStr = fmtPrice(s.entry, s.symbol);
    const slStr = fmtPrice(s.sl, s.symbol);
    const tpStr = fmtPrice(s.tp, s.symbol);
    const rrStr = s.rr != null ? "1:" + s.rr.toFixed(1) : "--";
    const reasonsStr = s.reasons.slice(0, 2).join(" · ");

    const mkSpan = (cls, txt) => { const el = document.createElement("span"); el.className = cls; el.textContent = txt; return el; };
    card.appendChild(mkSpan("scalp-card-dir " + dirClass, dirLabel));
    card.appendChild(mkSpan("scalp-card-symbol", sym));
    card.appendChild(mkSpan("scalp-card-price", "@ " + entryStr));
    card.appendChild(mkSpan("scalp-card-levels", "SL " + slStr + " · TP " + tpStr));
    card.appendChild(mkSpan("scalp-card-sep", "·"));
    card.appendChild(mkSpan("scalp-card-rr", rrStr));
    card.appendChild(mkSpan("scalp-card-conf", s.conf + "/7"));
    card.appendChild(mkSpan("scalp-card-time", ts));
    card.appendChild(mkSpan("scalp-card-result " + resultLower, s.result || "PENDING"));
    if (reasonsStr) card.appendChild(mkSpan("scalp-card-reasons", reasonsStr));

    card.title = `Click to view details · ⚡ SCALP ${isBull ? "BUY" : "SELL"} ${sym} @ ${entryStr}\nSL: ${slStr}  TP: ${tpStr}  R:R ${rrStr}\nConfluence: ${s.conf}/7\nResult: ${s.result || "PENDING"}\n${s.reasons.join(", ")}`;
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", `View ${isBull ? "BUY" : "SELL"} ${sym} scalp details`);

    /* Clickable — focuses the panel and switches sidebar to State tab */
    card.addEventListener("click", () => handleScalpCardClick(s));
    card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleScalpCardClick(s); } });

    UI.scalpTickerTrack.appendChild(card);
  }

  /* Auto-scroll to show the newest scalp (leftmost) */
  UI.scalpTickerTrack.scrollLeft = 0;
}

/* ---- Handle strategy card click from banner ---- */
function handleStrategyCardClick(signal) {
  const sym = signal.symbol || getActiveSymbol();
  /* If multi-symbol, focus the panel for this signal's symbol */
  if (multiPanels.size > 0 && sym && multiPanels.has(sym)) {
    focusPanel(sym);
  }
  /* Scroll to chart view so the user can see the signal on the chart */
  scrollToChartView();
}

/* ---- Aggregate strategy signals from ALL panels (+ single-mode globals) ---- */
function getAggregatedStrategyHistory() {
  const histories = [
    { history: liquiditySweepHistory, label: "🌊 Liquidity Sweep" },
    { history: stopLossHuntHistory,   label: "🎯 Stop Loss Hunt" },
    { history: failedPinBarHistory,   label: "📌 Failed Pin Bar" },
    { history: fibScalpHistory,       label: "📐 Fib Golden Zone" },
    { history: po3History,            label: "⚡ Power of 3" },
    { history: nyOpenRangeHistory,    label: "🕤 NY Open Range" },
    { history: sessionRangeHistory,   label: "🌍 Session Range" },
    { history: gridScalperMAHistory,  label: "🔲 Grid Scalper MA" },
    { history: fvgStratHistory,       label: "🎯 Fair Value Gap" },
    { history: mtfTopDownHistory,     label: "⏱ MTF Top-Down" }
  ];

  if (multiPanels.size === 0) {
    /* Single-symbol mode: merge global strategy histories */
    const all = [];
    for (const { history, label } of histories) {
      for (const s of history) all.push(Object.assign({}, s, { _stratLabel: label }));
    }
    all.sort((a, b) => (b.epoch || 0) - (a.epoch || 0));
    return all;
  }

  /* Multi-symbol mode: aggregate from all panels */
  const all = [];
  for (const p of multiPanels.values()) {
    const panelHistories = [
      { history: p.liquiditySweepHistory || [], label: "🌊 Liquidity Sweep" },
      { history: p.stopLossHuntHistory   || [], label: "🎯 Stop Loss Hunt" },
      { history: p.failedPinBarHistory   || [], label: "📌 Failed Pin Bar" },
      { history: p.fibScalpHistory       || [], label: "📐 Fib Golden Zone" },
      { history: p.po3History            || [], label: "⚡ Power of 3" },
      { history: p.nyOpenRangeHistory    || [], label: "🕤 NY Open Range" },
      { history: p.sessionRangeHistory   || [], label: "🌍 Session Range" },
      { history: p.gridScalperMAHistory  || [], label: "🔲 Grid Scalper MA" },
      { history: p.fvgStratHistory       || [], label: "🎯 Fair Value Gap" },
      { history: p.mtfTopDownHistory     || [], label: "⏱ MTF Top-Down" }
    ];
    for (const { history, label } of panelHistories) {
      for (const s of history) all.push(Object.assign({}, s, { _stratLabel: label }));
    }
  }
  all.sort((a, b) => (b.epoch || 0) - (a.epoch || 0));
  return all;
}

/* ---- Live Strategies Ticker Banner ---- */
function renderStrategyTickerBanner() {
  if (!UI.strategyTickerTrack) return;
  UI.strategyTickerTrack.innerHTML = "";

  const allStrategies = getAggregatedStrategyHistory();

  if (allStrategies.length === 0) {
    const empty = document.createElement("span");
    empty.className = "strategy-ticker-empty";
    empty.textContent = "No strategy signals yet — scanners active…";
    UI.strategyTickerTrack.appendChild(empty);
    return;
  }

  /* Render newest first (aggregated list is already newest-first) */
  const stratLimit = Math.min(allStrategies.length, BANNER_DISPLAY_MAX);
  for (let i = 0; i < stratLimit; i++) {
    const s = allStrategies[i];
    const card = document.createElement("div");
    const isBull = s.dir === "BULL";
    const resultLower = (s.result || "PENDING").toLowerCase();
    card.className = `strategy-card ${isBull ? "strategy-card-bull" : "strategy-card-bear"}${i === 0 ? " strategy-card-new" : ""}${resultLower === "win" ? " strategy-card-win" : resultLower === "loss" ? " strategy-card-loss" : resultLower === "expired" ? " strategy-card-expired" : ""}`;

    const dirLabel = isBull ? "▲" : "▼";
    const dirClass = isBull ? "bull" : "bear";
    const t = new Date(s.epoch * 1000);
    const ts = t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const sym = s.symbol || getActiveSymbol() || "--";
    const entryStr = fmtPrice(s.entry, s.symbol);
    const slStr = fmtPrice(s.sl, s.symbol);
    const tpStr = fmtPrice(s.tp, s.symbol);
    const rrStr = s.rr != null ? "1:" + s.rr.toFixed(1) : "--";
    const typeLabel = s._stratLabel || s.type || "--";

    const mkSpan = (cls, txt) => { const el = document.createElement("span"); el.className = cls; el.textContent = txt; return el; };
    card.appendChild(mkSpan("strategy-card-dir " + dirClass, dirLabel));
    card.appendChild(mkSpan("strategy-card-symbol", sym));
    card.appendChild(mkSpan("strategy-card-type", typeLabel));
    card.appendChild(mkSpan("strategy-card-price", "@ " + entryStr));
    card.appendChild(mkSpan("strategy-card-levels", "SL " + slStr + " · TP " + tpStr));
    card.appendChild(mkSpan("strategy-card-sep", "·"));
    card.appendChild(mkSpan("strategy-card-rr", rrStr));
    card.appendChild(mkSpan("strategy-card-time", ts));
    card.appendChild(mkSpan("strategy-card-result " + resultLower, s.result || "PENDING"));

    card.title = `Click to view details · ${typeLabel} ${isBull ? "BUY" : "SELL"} ${sym} @ ${entryStr}\nSL: ${slStr}  TP: ${tpStr}  R:R ${rrStr}\nResult: ${s.result || "PENDING"}`;
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", `View ${isBull ? "BUY" : "SELL"} ${sym} ${typeLabel} details`);

    /* Clickable — focuses the panel and scrolls to chart */
    card.addEventListener("click", () => handleStrategyCardClick(s));
    card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleStrategyCardClick(s); } });

    UI.strategyTickerTrack.appendChild(card);
  }

  /* Auto-scroll to show the newest signal (leftmost) */
  UI.strategyTickerTrack.scrollLeft = 0;
}

/* ---- Live Scalp Stats ---- */
function updateScalpStatsUI() {
  /* Scalp stats now use aggregated data from all panels — no panel-focus guard needed */

  const h = getAggregatedScalpHistory();  /* newest-first, aggregated across all panels */
  const total = h.length;
  const wins  = h.filter(s => s.result === "WIN").length;
  const losses = h.filter(s => s.result === "LOSS").length;
  const resolved = wins + losses;
  const winRate = resolved > 0 ? (wins / resolved * 100).toFixed(1) + "%" : "0%";
  const bulls = h.filter(s => s.dir === "BULL").length;
  const bears = h.filter(s => s.dir === "BEAR").length;
  const avgConf = total > 0 ? (h.reduce((sum, s) => sum + s.conf, 0) / total).toFixed(1) : "0";
  const bestConf = total > 0 ? Math.max(...h.map(s => s.conf)) : 0;
  const lastTime = total > 0 ? new Date(h[0].epoch * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "--";

  if (UI.scalpStatsTotal)    UI.scalpStatsTotal.textContent    = total;
  if (UI.scalpStatsWins)     UI.scalpStatsWins.textContent     = wins;
  if (UI.scalpStatsLosses)   UI.scalpStatsLosses.textContent   = losses;
  if (UI.scalpStatsWinRate)  UI.scalpStatsWinRate.textContent  = winRate;
  if (UI.scalpStatsBull)     UI.scalpStatsBull.textContent     = bulls;
  if (UI.scalpStatsBear)     UI.scalpStatsBear.textContent     = bears;
  if (UI.scalpStatsAvgConf)  UI.scalpStatsAvgConf.textContent  = avgConf + "/7";
  if (UI.scalpStatsBestConf) UI.scalpStatsBestConf.textContent = bestConf + "/7";
  if (UI.scalpStatsLastTime) UI.scalpStatsLastTime.textContent = lastTime;
}

/* ================= EXPORT ================= */
function exportSignalsCSV() {
  const allSignals = getAggregatedSignalHistory();
  if (allSignals.length === 0) { alert("No signals to export."); return; }
  const headers = ["time", "symbol", "dir", "entry", "sl", "tp", "rr", "result", "lotSize", "pipsAtRisk", "stake", "emaAligned", "htfTrend", "breakoutStrength", "partialTpHit", "trailingSL", "confluenceScore", "srConfluence", "confirmPattern", "rsiAtRetest", "volumeSpike", "session", "fibLevel", "macdHist", "bbSqueeze", "adx", "stochK", "volatilityRegime", "scalpingMode", "note"];
  const rows = allSignals.map(s => {
    const noteId = `sig_${s.time}_${s.symbol || ""}`;
    const note = getSignalNote(noteId) || "";
    return headers.map(h => h === "note" ? `"${note.replace(/"/g, '""')}"` : `"${s[h] ?? ""}"`).join(",");
  });
  const csv = [headers.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `indicator_signals_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ================= PDF EXPORT (with chart screenshots) ================= */
function exportSignalsPDF() {
  const allSignals = getAggregatedSignalHistory();
  if (allSignals.length === 0) { alert("No signals to export."); return; }
  if (typeof window.jspdf === "undefined") { alert("PDF library not loaded. Please check your connection."); return; }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 10;

  allSignals.forEach((sig, idx) => {
    if (idx > 0) doc.addPage("a4", "landscape");

    /* ---- Header ---- */
    doc.setFillColor(15, 23, 42);
    doc.rect(0, 0, pageW, 18, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor(255, 255, 255);
    doc.text(`Signal ${idx + 1} / ${allSignals.length}`, margin, 12);
    doc.setFontSize(10);
    doc.text(`IT Guru – Breakout Retest Indicator`, pageW - margin, 12, { align: "right" });

    /* ---- Chart screenshot ---- */
    let chartBottom = 24;
    if (sig.chartImage) {
      try {
        const chartW = pageW - margin * 2;
        const chartH = (pageH - 70);
        doc.addImage(sig.chartImage, "PNG", margin, 22, chartW, chartH);
        chartBottom = 22 + chartH + 4;
      } catch (e) {
        doc.setFontSize(9);
        doc.setTextColor(150, 150, 150);
        doc.text("(Chart screenshot not available)", margin, 32);
        chartBottom = 38;
      }
    } else {
      doc.setFontSize(9);
      doc.setTextColor(150, 150, 150);
      doc.text("(No chart captured for this signal)", margin, 32);
      chartBottom = 38;
    }

    /* ---- Trade details table ---- */
    const detailY = Math.min(chartBottom, pageH - 40);
    doc.setFillColor(30, 41, 59);
    doc.rect(margin, detailY, pageW - margin * 2, 30, "F");

    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    const fields = [
      ["Time", sig.time || "--"],
      ["Symbol", sig.symbol || "--"],
      ["Dir", sig.dir || "--"],
      ["Entry", sig.entry ?? "--"],
      ["SL", sig.sl ?? "--"],
      ["TP", sig.tp ?? "--"],
      ["R:R", sig.rr ?? "--"],
      ["Result", sig.result || "--"],
      ["Confluence", sig.confluenceScore ?? "--"],
      ["Pattern", sig.confirmPattern || "--"]
    ];

    const colW = (pageW - margin * 2) / fields.length;
    fields.forEach(([label, val], i) => {
      const x = margin + i * colW + 2;
      doc.setTextColor(148, 163, 184);
      doc.text(label, x, detailY + 8);
      doc.setFont("helvetica", "normal");
      const resultColor = String(val) === "WIN" ? [34, 197, 94] : String(val) === "LOSS" ? [239, 68, 68] : [255, 255, 255];
      doc.setTextColor(...resultColor);
      doc.text(String(val), x, detailY + 15);
      doc.setFont("helvetica", "bold");
    });

    /* Second row of details */
    const row2Fields = [
      ["EMA", sig.emaAligned ?? "--"],
      ["HTF", sig.htfTrend || "--"],
      ["Strength", sig.breakoutStrength || "--"],
      ["RSI", sig.rsiAtRetest ?? "--"],
      ["Vol Spike", sig.volumeSpike ?? "--"],
      ["Session", sig.session || "--"],
      ["Fib", sig.fibLevel || "--"],
      ["S/R Conf", sig.srConfluence ?? "--"],
      ["Partial TP", sig.partialTpHit ?? "--"],
      ["Trail SL", sig.trailingSL ?? "--"]
    ];
    row2Fields.forEach(([label, val], i) => {
      const x = margin + i * colW + 2;
      doc.setTextColor(148, 163, 184);
      doc.text(label, x, detailY + 22);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(255, 255, 255);
      doc.text(String(val), x, detailY + 28);
      doc.setFont("helvetica", "bold");
    });
  });

  doc.save(`indicator_signals_${new Date().toISOString().slice(0, 10)}.pdf`);
}

/* ================= THEME ================= */
function toggleTheme() {
  currentTheme = currentTheme === "dark" ? "light" : "dark";
  document.body.classList.toggle("light-theme", currentTheme === "light");
  if (UI.themeToggleBtn) UI.themeToggleBtn.textContent = currentTheme === "dark" ? "☀️ Light" : "🌙 Dark";
  saveSettings();
  drawChart();
}

function initTheme() {
  if (currentTheme === "light") {
    document.body.classList.add("light-theme");
  }
  if (UI.themeToggleBtn) UI.themeToggleBtn.textContent = currentTheme === "dark" ? "☀️ Light" : "🌙 Dark";
}

/* ================= STREAM MODE ================= */
/** Apply or remove stream-mode visuals based on the current `streamMode` flag. */
function applyStreamMode() {
  document.body.classList.toggle("stream-mode", streamMode);
  if (UI.streamModeBtn) {
    UI.streamModeBtn.textContent = streamMode ? "🔴 LIVE" : "🎥";
    UI.streamModeBtn.title       = streamMode
      ? "Stream Mode ON – click to disable (Alt+S)"
      : "Stream Mode – hide sensitive info (Alt+S)";
    UI.streamModeBtn.classList.toggle("stream-active", streamMode);
  }
  /* Refresh account badge tooltip so loginid/balance appear or disappear immediately */
  if (_lastAuthorizeAcct) updateAccountBadge(_lastAuthorizeAcct);
}

function toggleStreamMode() {
  streamMode = !streamMode;
  localStorage.setItem(STREAM_MODE_KEY, JSON.stringify(streamMode));
  applyStreamMode();
}

/* ================= KEYBOARD SHORTCUTS ================= */
function initKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.key === "c") { e.preventDefault(); connect(); }
    if (e.altKey && e.key === "d") { e.preventDefault(); disconnect(); }
    if (e.altKey && e.key === "t") { e.preventDefault(); toggleTheme(); }
    if (e.altKey && e.key === "e") { e.preventDefault(); exportSignalsCSV(); }
    if (e.altKey && e.key === "p") { e.preventDefault(); exportSignalsPDF(); }
    if (e.altKey && e.key === "r") { e.preventDefault(); if (confirm("Reset session? This clears all signals, stats, and log.")) resetSession(); }
    if (e.altKey && e.key === "n") {
      e.preventDefault();
      notificationsEnabled = !notificationsEnabled;
      if (notificationsEnabled) requestNotificationPermission();
      if (UI.notifToggleBtn) UI.notifToggleBtn.textContent = notificationsEnabled ? "🔔 Notif ON" : "🔕 Notif OFF";
      saveSettings();
    }
    if (e.altKey && e.key === "s") { e.preventDefault(); toggleStreamMode(); }
  });
}

/* Granularity → human-readable label map (used for display + recommended settings) */
const GRAN_LABELS = { 60: "1 min", 120: "2 min", 180: "3 min", 300: "5 min", 600: "10 min", 900: "15 min", 1800: "30 min", 3600: "1 hour", 7200: "2 hours", 14400: "4 hours", 28800: "8 hours", 86400: "1 day" };

/** Formats a duration in minutes into a consistent human-readable label (e.g. "10 min", "1 hour", "8 hours"). */
function formatMinutes(m) {
  if (m < 60) return m + " min";
  const h = m / 60;
  if (Number.isInteger(h)) return h === 1 ? "1 hour" : h + " hours";
  const wh = Math.floor(h);
  const rm = m % 60;
  return (wh === 1 ? "1 hour" : wh + " hours") + " " + rm + " min";
}

/* Session filter mode → display label map */
const SESSION_MODE_LABELS = {
  london_ny: "London+NY ✅",
  london:    "London ✅",
  new_york:  "NY ✅",
  overlap:   "Overlap ✅",
  asian:     "Asian ✅"
};

/* ================= SYMBOL NAVIGATION ================= */
function cycleSymbol(dir) {
  if (!UI.symbolSelect) return;
  const opts = Array.from(UI.symbolSelect.options);
  const currentIdx = UI.symbolSelect.selectedIndex;
  let newIdx = currentIdx + dir;
  if (newIdx < 0) newIdx = opts.length - 1;
  if (newIdx >= opts.length) newIdx = 0;
  UI.symbolSelect.selectedIndex = newIdx;
  updateCurrentSymbolLabel();
  applyRecommendedSettings();
  saveSettings();
  debouncedReconnect();
}

function updateCurrentSymbolLabel() {
  if (!UI.currentSymbolLabel || !UI.symbolSelect) return;
  const opt = UI.symbolSelect.options[UI.symbolSelect.selectedIndex];
  UI.currentSymbolLabel.textContent = opt ? opt.text : "--";
}

/* ================= RECOMMENDED SETTINGS (DYNAMIC PER MARKET TYPE) ================= */
function setRecBadge(el, isActive, matchesRec, onLabel, offLabel) {
  if (!el) return;
  el.textContent = isActive ? (onLabel || "ON ✅") : (offLabel || "OFF");
  if (isActive && matchesRec) {
    el.className = "status-badge bull rec-badge-active";
  } else if (isActive && !matchesRec) {
    el.className = "status-badge warning rec-badge-active";
  } else {
    el.className = "status-badge disabled rec-badge-active";
  }
}

function setRecRecBadge(el, text, cssClass) {
  if (!el) return;
  el.textContent = text;
  el.className = cssClass || "status-badge bull rec-badge-rec";
}

/**
 * Returns market-type-specific recommended settings.
 * Each market type has different optimal configurations derived from the MD-file strategies.
 */
function getMarketRecommendations(symbol) {
  const sym = symbol || _multiPanelProcessing || (UI.symbolSelect ? UI.symbolSelect.value : "");
  const mtype = getMarketType(sym);
  switch (mtype) {
    case "boom":
      return {
        label: "📈 Boom Index — Spike Up Strategy",
        timeframe: { text: "1 min", gran: 60 },
        rr: { text: "1:2–1:3", minRR: 2 },
        range: { text: "10 min", minutes: 10 },
        ema: true,
        htf: true,
        atr: true,
        trailing: { rec: true, note: "Wide (2× ATR for spike momentum)" },
        partialTp: true,
        falseBreakout: true,
        minRR: { rec: true, value: "1:2 ✅" },
        rsi: true,
        volSpike: { rec: true, note: "Strong (2× mult for spike confirmation)" },
        session: { rec: false, note: "24/7 synthetic" },
        fib: true,
        macd: true,
        bbSqueeze: true,
        adx: true,
        stoch: false,
        signals: [
          "Pin bar rejection after upward spike (shooting star = exhaustion)",
          "Engulfing pattern after spike for power shift confirmation",
          "Inside bar false breakout (stop-hunt trap detection)",
          "Only BULL breakouts — spikes are upward on Boom",
          "Wider trailing stop (2× ATR) to ride spike momentum",
          "MACD histogram confirms spike momentum direction",
          "BB squeeze detects compression before spike expansion"
        ],
        hint: "Boom indices spike upward — trade ONLY in the spike direction (BULL). "
            + "Pin bar rejections after spikes signal exhaustion. "
            + "Inside bar false breakouts detect stop-hunts common on Boom. "
            + "Use wider trailing stop (2× ATR) to capture extended spike momentum. "
            + "Volume spike filter with higher multiplier confirms genuine spikes vs noise. "
            + "MACD histogram alignment confirms spike direction momentum. "
            + "Bollinger Band squeeze detects compression before spike expansion. "
            + "ADX confirms trending environment for spike follow-through. "
            + "Stochastic disabled — unreliable in rapid spike markets. "
            + "Session filter disabled — synthetic markets run 24/7."
      };
    case "crash":
      return {
        label: "📉 Crash Index — Spike Down Strategy",
        timeframe: { text: "1 min", gran: 60 },
        rr: { text: "1:2–1:3", minRR: 2 },
        range: { text: "10 min", minutes: 10 },
        ema: true,
        htf: true,
        atr: true,
        trailing: { rec: true, note: "Wide (2× ATR for spike momentum)" },
        partialTp: true,
        falseBreakout: true,
        minRR: { rec: true, value: "1:2 ✅" },
        rsi: true,
        volSpike: { rec: true, note: "Strong (2× mult for spike confirmation)" },
        session: { rec: false, note: "24/7 synthetic" },
        fib: true,
        macd: true,
        bbSqueeze: true,
        adx: true,
        stoch: false,
        signals: [
          "Pin bar rejection after downward spike (hammer = exhaustion)",
          "Engulfing pattern after spike for power shift confirmation",
          "Inside bar false breakout (stop-hunt trap detection)",
          "Only BEAR breakouts — spikes are downward on Crash",
          "Wider trailing stop (2× ATR) to ride spike momentum",
          "MACD histogram confirms spike momentum direction",
          "BB squeeze detects compression before spike expansion"
        ],
        hint: "Crash indices spike downward — trade ONLY in the spike direction (BEAR). "
            + "Pin bar rejections after spikes signal exhaustion. "
            + "Inside bar false breakouts detect stop-hunts common on Crash. "
            + "Use wider trailing stop (2× ATR) to capture extended spike momentum. "
            + "Volume spike filter with higher multiplier confirms genuine spikes vs noise. "
            + "MACD histogram alignment confirms spike direction momentum. "
            + "Bollinger Band squeeze detects compression before spike expansion. "
            + "ADX confirms trending environment for spike follow-through. "
            + "Stochastic disabled — unreliable in rapid spike markets. "
            + "Session filter disabled — synthetic markets run 24/7."
      };
    case "jump":
      return {
        label: "🦘 Jump Index — Gap & Impulse Strategy",
        timeframe: { text: "5–15 min", gran: 300 },
        rr: { text: "1:3+", minRR: 3 },
        range: { text: "15 min", minutes: 15 },
        ema: true,
        htf: true,
        atr: true,
        trailing: { rec: true, note: "Extra wide (2.5× ATR for jump volatility)" },
        partialTp: true,
        falseBreakout: true,
        minRR: { rec: true, value: "1:3 ✅" },
        rsi: false,
        volSpike: { rec: false, note: "Jumps are inherently volatile" },
        session: { rec: false, note: "24/7 synthetic" },
        fib: true,
        macd: false,
        bbSqueeze: true,
        adx: false,
        stoch: false,
        signals: [
          "Supply/Demand zone detection — jumps create powerful S&D zones",
          "Momentum impulse continuation after jump candle",
          "Gap-fill retest back to jump origin level",
          "Both BULL and BEAR breakouts — jumps go either direction",
          "Fibonacci 50%/61% retracement of jump range",
          "BB squeeze detects compression before jump release"
        ],
        hint: "Jump indices produce sudden price jumps in either direction. "
            + "5-minute timeframe recommended — smooths out chop between jumps for cleaner signals. "
            + "Jumps create strong supply/demand zones where price departed rapidly — "
            + "wait for price to return to these zones for high-probability entries. "
            + "Momentum impulse detection confirms continuation after a jump. "
            + "Extra-wide trailing stop (2.5× ATR) survives jump volatility. "
            + "RSI and volume spike filters disabled — jumps break normal readings. "
            + "Bollinger Band squeeze detects compression before jump release. "
            + "MACD, ADX, and Stochastic disabled — jumps are too erratic for lagging indicators. "
            + "Higher R:R target (1:3+) compensates for the erratic price action."
      };
    case "step":
      return {
        label: "🪜 Step Index — Trendline & MA Bounce Strategy",
        timeframe: { text: "5 min", gran: 300 },
        rr: { text: "1:2", minRR: 2 },
        range: { text: "20 min", minutes: 20 },
        ema: true,
        htf: true,
        atr: false,
        trailing: { rec: true, note: "Tight (1× ATR for small moves)" },
        partialTp: true,
        falseBreakout: true,
        minRR: { rec: true, value: "1:2 ✅" },
        rsi: true,
        volSpike: { rec: false, note: "Fixed steps — range is uniform" },
        session: { rec: false, note: "24/7 synthetic" },
        fib: true,
        macd: true,
        bbSqueeze: true,
        adx: true,
        stoch: true,
        signals: [
          "Trendline 3rd-touch entry — price respects trendlines cleanly",
          "EMA 8/21 dynamic S/R bounce for pullback entries",
          "Step momentum run detection (5+ consecutive steps)",
          "Inside bar pattern (consolidation before next run)",
          "Tight tolerances for precise level detection",
          "MACD confirms clean trend direction",
          "Stochastic pullback entries at S/R bounces"
        ],
        hint: "Step Index moves in fixed increments — the cleanest price action. "
            + "Trendline 3rd-touch strategy works best: draw trendline on 2 swing lows "
            + "(uptrend) or highs (downtrend), enter on touch 3+. "
            + "EMA 8/21 act as dynamic support/resistance for pullback entries. "
            + "Step momentum runs (5+ consecutive steps) confirm strong trends. "
            + "Volume spike filter disabled — fixed-step moves have uniform range. "
            + "Longer opening range (20 min) captures the orderly structure. "
            + "Tight trailing stop (1× ATR) suits the small, precise movements. "
            + "All V2 indicators work well — clean step action produces reliable MACD, "
            + "BB squeeze, ADX trending, and Stochastic pullback signals."
      };
    case "dailyreset":
      return {
        label: "📅 Daily Reset — Trend Follow Strategy",
        timeframe: { text: "15 min–1 hour", gran: 900 },
        rr: { text: "1:2–1:3", minRR: 2 },
        range: { text: "45 min", minutes: 45 },
        ema: true,
        htf: true,
        atr: true,
        trailing: { rec: true, note: "Standard (1.5× ATR)" },
        partialTp: true,
        falseBreakout: true,
        minRR: { rec: true, value: "1:2 ✅" },
        rsi: true,
        volSpike: { rec: true, note: "Confirms genuine breakout vs noise" },
        session: { rec: false, note: "24/7 synthetic" },
        fib: true,
        macd: true,
        bbSqueeze: true,
        adx: true,
        stoch: true,
        signals: [
          "Bull Market trends upward, Bear Market trends downward — resets daily",
          "Trade in the natural direction: BULL for Bull Market, BEAR for Bear Market",
          "EMA alignment confirms daily trend direction",
          "MACD histogram confirms momentum in the trending direction",
          "ADX confirms trending environment",
          "Pullback entries using pin bar / engulfing at EMA support"
        ],
        hint: "Daily Reset indices trend in one direction and reset daily. "
            + "Bull Market trends upward, Bear Market trends downward. "
            + "Trade in the natural trend direction for highest probability. "
            + "15-minute timeframe recommended — intraday TFs (15M–1H) make sense since holding overnight is meaningless. "
            + "EMA alignment and ADX confirm the trending regime. "
            + "Use pullback entries at EMA support/resistance. "
            + "All standard indicators work well in these smooth trending conditions."
      };
    case "dex":
      return {
        label: "📰 DEX Index — News Spike Strategy",
        timeframe: { text: "5–15 min", gran: 300 },
        rr: { text: "1:2–1:3", minRR: 2 },
        range: { text: "15 min", minutes: 15 },
        ema: true,
        htf: true,
        atr: true,
        trailing: { rec: true, note: "Wide (2× ATR for spike momentum)" },
        partialTp: true,
        falseBreakout: true,
        minRR: { rec: true, value: "1:2 ✅" },
        rsi: true,
        volSpike: { rec: true, note: "Strong (1.8× mult for spike confirmation)" },
        session: { rec: false, note: "24/7 synthetic" },
        fib: true,
        macd: true,
        bbSqueeze: true,
        adx: true,
        stoch: false,
        signals: [
          "DEX UP variants spike upward, DEX DN variants spike downward",
          "Spike-aware: uses same logic as Boom/Crash for spike detection",
          "Pin bar rejection after spike signals exhaustion",
          "Engulfing pattern after spike for power shift confirmation",
          "Volume spike filter confirms genuine spikes vs small noise",
          "BB squeeze detects compression before spike expansion"
        ],
        hint: "DEX indices simulate news-event spikes. UP variants spike upward, DN variants spike downward. "
            + "5-minute timeframe recommended — balances signal quality for directional spike detection. "
            + "Similar to Boom/Crash but with news-event-like frequency. "
            + "Trade in the spike direction for highest probability. "
            + "Wide trailing stop (2× ATR) captures extended spike momentum. "
            + "Strong volume spike filter separates real spikes from noise. "
            + "Stochastic disabled — unreliable in rapid spike markets. "
            + "Session filter disabled — synthetic markets run 24/7."
      };
    case "driftswitch":
      return {
        label: "🔄 Drift Switch — Regime Trend Strategy",
        timeframe: { text: "5 min", gran: 300 },
        rr: { text: "1:2", minRR: 2 },
        range: { text: "15 min", minutes: 15 },
        ema: true,
        htf: true,
        atr: true,
        trailing: { rec: true, note: "Standard (1.5× ATR)" },
        partialTp: true,
        falseBreakout: true,
        minRR: { rec: true, value: "1:2 ✅" },
        rsi: true,
        volSpike: { rec: false, note: "Smooth regime shifts — volume not meaningful" },
        session: { rec: false, note: "24/7 synthetic" },
        fib: true,
        macd: true,
        bbSqueeze: true,
        adx: true,
        stoch: true,
        signals: [
          "Regime switches between bullish, bearish, and sideways every 10/20/30 min",
          "EMA crossover confirms regime change direction",
          "ADX rising confirms new trending regime has started",
          "MACD histogram shift confirms momentum change",
          "Pin bar at regime transition marks reversal entry",
          "All indicators work well within a stable regime"
        ],
        hint: "Drift Switch indices alternate between bullish, bearish, and sideways regimes "
            + "at regular intervals (10, 20, or 30 minutes depending on DSI variant). "
            + "EMA crossovers are highly reliable here — they confirm regime direction. "
            + "ADX confirms when a new trending regime has started (rising ADX). "
            + "MACD histogram shifts align with regime changes. "
            + "Trade in the direction of the current regime — avoid sideways regimes. "
            + "Volume spike filter disabled — regime transitions are smooth, not spiked. "
            + "All standard indicators produce reliable signals within a stable regime."
      };
    case "volatility": {
      /* Split: Volatility 1s (1HZ*) vs Standard (R_*) */
      const isVol1s = /^1HZ/i.test(sym);
      if (isVol1s) {
        return {
          label: "⚡ Volatility (1s) — Fast Breakout Strategy",
          timeframe: { text: "1–5 min", gran: 60 },
          rr: { text: "1:2", minRR: 2 },
          range: { text: "10 min", minutes: 10 },
          ema: true,
          htf: true,
          atr: true,
          trailing: { rec: true, note: "1.5× ATR standard" },
          partialTp: true,
          falseBreakout: true,
          minRR: { rec: true, value: "1:2 ✅" },
          rsi: true,
          volSpike: { rec: true, note: "Standard 1.5× average range" },
          session: { rec: false, note: "24/7 synthetic" },
          fib: true,
          macd: true,
          bbSqueeze: true,
          adx: true,
          stoch: true,
          signals: [
            "Opening range breakout with conviction on 1-minute candles",
            "Retest + indecision + engulfing confirmation",
            "Pin bar and morning/evening star at retest",
            "Inside bar breakout for clean continuation",
            "Fast tick-based action — 1M candles capture rapid movements",
            "MACD momentum confirmation at breakout",
            "BB squeeze preceding breakout for volatility expansion"
          ],
          hint: "Volatility 1s indices generate candles every second — 1-minute timeframe is recommended "
              + "for capturing rapid price movements without excessive noise. "
              + "Short opening range (10 min) adapts to fast-forming consolidation. "
              + "All standard filters apply — EMA, HTF, ATR tolerance, trailing stop. "
              + "Session filter disabled — synthetic markets run 24/7. "
              + "Confluence score (0-16) gauges overall setup quality."
        };
      }
      /* Volatility Standard (R_10, R_25, R_50, R_75, R_100) */
      return {
        label: "⚡ Volatility (Standard) — Breakout Strategy",
        timeframe: { text: "5–15 min", gran: 300 },
        rr: { text: "1:2–1:3", minRR: 2 },
        range: { text: "15 min", minutes: 15 },
        ema: true,
        htf: true,
        atr: true,
        trailing: { rec: true, note: "1.5× ATR standard" },
        partialTp: true,
        falseBreakout: true,
        minRR: { rec: true, value: "1:2 ✅" },
        rsi: true,
        volSpike: { rec: true, note: "Standard 1.5× average range" },
        session: { rec: false, note: "24/7 synthetic" },
        fib: true,
        macd: true,
        bbSqueeze: true,
        adx: true,
        stoch: true,
        signals: [
          "Opening range breakout with conviction on 5-minute candles",
          "Retest + indecision + engulfing confirmation",
          "Pin bar and morning/evening star at retest",
          "Inside bar breakout for clean continuation",
          "S/R confluence and Fibonacci retracement alignment",
          "MACD momentum confirmation at breakout",
          "BB squeeze preceding breakout for volatility expansion"
        ],
        hint: "Standard Volatility indices move slower than 1s variants — 5-minute timeframe "
            + "gives cleaner breakout signals with less noise. "
            + "15-minute opening range captures orderly consolidation structure. "
            + "All standard filters apply — EMA, HTF, ATR tolerance, trailing stop. "
            + "Session filter disabled — synthetic markets run 24/7. "
            + "Confluence score (0-16) gauges overall setup quality."
      };
    }
    case "forex": {
      /* Split: Forex Majors vs Crosses vs Exotics */
      const IS_FOREX_EXOTIC = /frxUSD(MXN|NOK|SEK|SGD|ZAR|PLN|TRY|HKD)/i;
      const IS_FOREX_MAJOR  = /frx(EURUSD|GBPUSD|USDJPY|USDCHF|AUDUSD|USDCAD|NZDUSD)/i;
      if (IS_FOREX_EXOTIC.test(sym)) {
        return {
          label: "🌍 Forex Exotic — Daily Price Action Strategy",
          timeframe: { text: "4 hours", gran: 14400 },
          rr: { text: "1:3+", minRR: 3 },
          range: { text: "8 hours (2 candles)", minutes: 480 },
          ema: true,
          htf: true,
          atr: true,
          trailing: { rec: true, note: "Wide (2× ATR for exotic volatility)" },
          partialTp: true,
          falseBreakout: true,
          minRR: { rec: true, value: "1:3 ✅" },
          rsi: true,
          volSpike: { rec: true, note: "Standard 1.5× average range" },
          session: { rec: true, note: "London+NY ✅" },
          fib: true,
          macd: true,
          bbSqueeze: true,
          adx: true,
          stoch: false,
          signals: [
            "Pin bar rejection at key S/R on 4H chart — MD: 'only 4H or Daily'",
            "Engulfing pattern at support/resistance for power shift",
            "Inside bar breakout at key level for continuation",
            "Top-down analysis: Weekly → Daily → 4H for entry",
            "S/R confluence and Fibonacci retracement alignment",
            "London+NY session filter — highest liquidity reduces exotic spread impact",
            "Higher R:R target (1:3+) compensates for wider exotic spreads"
          ],
          hint: "Exotic forex pairs have much wider spreads — the MD strategies warn to focus on low-spread pairs. "
              + "If trading exotics, use 4H timeframe minimum to reduce spread impact per trade. "
              + "MD: 'Price action works on bigger time frames — trading on the 5-minute chart will lose you money.' "
              + "Top-down analysis required: Weekly chart for major S/R → Daily for structure → 4H for entries. "
              + "Higher R:R target (1:3+) ensures potential profit outweighs the wider spread cost. "
              + "Wide trailing stop (2× ATR) accommodates exotic pair volatility. "
              + "London+NY session filter is critical — exotic spreads widen dramatically outside peak hours. "
              + "Stochastic disabled — less reliable on exotic pairs due to erratic movements."
        };
      }
      if (IS_FOREX_MAJOR.test(sym)) {
        return {
          label: "💱 Forex Major — 4H Price Action Strategy",
          timeframe: { text: "4 hours", gran: 14400 },
          rr: { text: "1:2–1:3", minRR: 2 },
          range: { text: "8 hours (2 candles)", minutes: 480 },
          ema: true,
          htf: true,
          atr: true,
          trailing: { rec: true, note: "1.5× ATR standard" },
          partialTp: true,
          falseBreakout: true,
          minRR: { rec: true, value: "1:2 ✅" },
          rsi: true,
          volSpike: { rec: true, note: "Standard 1.5× average range" },
          session: { rec: true, note: "London+NY ✅" },
          fib: true,
          macd: true,
          bbSqueeze: true,
          adx: true,
          stoch: true,
          signals: [
            "Pin bar rejection at key S/R on 4H chart — MD: 'only 4H or Daily'",
            "Engulfing pattern with trend at MA bounce — MD: '21 and 8 SMA on Daily and 4H'",
            "Inside bar breakout at key level — MD: 'Daily and 4H, not 5-minute'",
            "Top-down analysis: Weekly → Daily → 4H for entry",
            "Supply/demand zones — MD: 'Daily and 4H zones are most powerful'",
            "Trendline 3rd-touch entry — MD: '4H and Daily time frames only'",
            "Fibonacci retracement confluence at key levels"
          ],
          hint: "MD Strategy: 'Primary time frames for price action: 1H, 4H, and Daily.' "
              + "MD: 'Price action works on bigger time frames. Trading pin bars on the 5-minute chart will lose you money.' "
              + "4H recommended for entry signals — pin bars, engulfing bars, inside bars all require 4H minimum per MD. "
              + "Top-down analysis: start with Weekly chart for major S/R, move to Daily for structure, 4H for entries. "
              + "MD: '4H and Daily time frames only — never use smaller time frames' for trendlines. "
              + "Focus on EUR/USD and GBP/USD — MD specifically recommends these for lower spreads. "
              + "London+NY session filter ensures trading during highest-liquidity hours. "
              + "MD: 'If you trade price action based on a single time frame, you will end up losing your entire account.'"
        };
      }
      /* Forex Crosses (EUR/GBP, EUR/JPY, GBP/JPY, etc.) */
      return {
        label: "💱 Forex Cross — 4H Price Action Strategy",
        timeframe: { text: "4 hours", gran: 14400 },
        rr: { text: "1:2–1:3", minRR: 2 },
        range: { text: "8 hours (2 candles)", minutes: 480 },
        ema: true,
        htf: true,
        atr: true,
        trailing: { rec: true, note: "1.5× ATR standard" },
        partialTp: true,
        falseBreakout: true,
        minRR: { rec: true, value: "1:2 ✅" },
        rsi: true,
        volSpike: { rec: true, note: "Standard 1.5× average range" },
        session: { rec: true, note: "London+NY ✅" },
        fib: true,
        macd: true,
        bbSqueeze: true,
        adx: true,
        stoch: true,
        signals: [
          "Pin bar rejection at key S/R on 4H chart — MD: 'only 4H or Daily'",
          "Engulfing pattern with trend at MA bounce — MD: '21 and 8 SMA on Daily and 4H'",
          "Inside bar breakout at key level — MD: 'Daily and 4H, not 5-minute'",
          "Top-down analysis: Weekly → Daily → 4H for entry",
          "Trendline 3rd-touch entry — MD: '4H and Daily time frames only'",
          "S/R confluence and Fibonacci retracement alignment",
          "Cross pairs have wider spreads than majors — 4H reduces noise impact"
        ],
        hint: "Forex cross pairs follow the same MD price action rules as majors. "
            + "MD: 'Primary time frames for price action: 1H, 4H, and Daily.' "
            + "4H recommended — same rules apply: pin bars, engulfing, inside bars require 4H minimum. "
            + "Cross pairs have slightly wider spreads than majors — bigger timeframe reduces spread impact. "
            + "Top-down analysis required: Weekly → Daily → 4H for entries. "
            + "London+NY session filter ensures best liquidity. "
            + "All standard indicators work well on 4H cross pair charts."
      };
    }
    case "commodity": {
      /* Sub-branch: all XAUUSD variants (frxXAUUSD, XAUUSDmicro, XAUUSD.s) */
      const IS_GOLD = /^(frxXAUUSD|XAUUSD)/i.test(sym);
      if (IS_GOLD) {
        const isMicro = /micro/i.test(sym);
        return {
          label: isMicro ? "🥇 Gold Micro — 1H Session Scalp Strategy" : "🥇 Gold Spot — 1H Session Strategy",
          timeframe: { text: "1 hour", gran: 3600 },
          rr: { text: "1:2–1:3", minRR: 2 },
          range: { text: "4 hours (1 candle)", minutes: 240 },
          ema: true,
          htf: true,
          atr: true,
          trailing: { rec: true, note: "Standard (1.5× ATR)" },
          partialTp: true,
          falseBreakout: true,
          minRR: { rec: true, value: "1:2 ✅" },
          rsi: true,
          volSpike: { rec: true, note: "Standard 1.5× average range" },
          session: { rec: true, note: "London+NY ✅" },
          fib: true,
          macd: true,
          bbSqueeze: true,
          adx: true,
          stoch: false,
          signals: [
            "Pin bar rejection at key S/R on 1H chart — reference Daily for major zones",
            "Engulfing pattern at supply/demand zone for power shift",
            "London and NY session breakouts — highest gold liquidity windows",
            "Supply/demand zones — gold respects Daily and 4H zones powerfully",
            "Fibonacci 50%/61% retracement of London session range",
            "MACD momentum confirmation at breakout",
            isMicro
              ? "Micro contract (10 oz/lot) — reduced risk per pip, ideal for tighter SL placements"
              : "Spot contract (100 oz/lot) — standard gold risk/lot sizing applies"
          ],
          hint: (isMicro
            ? "XAUUSDmicro is a micro gold contract (10 oz/lot vs standard 100 oz/lot). "
              + "Smaller lot size allows more precise position sizing with lower margin. "
            : "XAUUSD.s is spot gold (100 oz/lot) — identical analysis to standard XAU/USD. ")
            + "1H timeframe balances gold's intraday volatility with clean signal formation. "
            + "Gold is strongly driven by London and NY sessions — enable the session filter. "
            + "Supply/demand zones from Daily/4H charts are highly respected by gold price. "
            + "Fibonacci retracements work well on gold's structured London/NY session swings. "
            + "MACD and ADX confirm trend direction before entry. "
            + "Stochastic disabled — gold's sharp momentum moves make it unreliable. "
            + "London+NY session filter is essential — gold spreads widen sharply outside peak hours."
        };
      }
      return {
        label: "🥇 Commodity — 4H Breakout Strategy",
        timeframe: { text: "4 hours", gran: 14400 },
        rr: { text: "1:2–1:3", minRR: 2 },
        range: { text: "8 hours (2 candles)", minutes: 480 },
        ema: true,
        htf: true,
        atr: true,
        trailing: { rec: true, note: "1.5× ATR standard" },
        partialTp: true,
        falseBreakout: true,
        minRR: { rec: true, value: "1:2 ✅" },
        rsi: true,
        volSpike: { rec: true, note: "Standard 1.5× average range" },
        session: { rec: true, note: "London+NY ✅" },
        fib: true,
        macd: true,
        bbSqueeze: true,
        adx: true,
        stoch: true,
        signals: [
          "Pin bar rejection at key S/R on 4H chart — MD: 'only 4H or Daily'",
          "Engulfing pattern at support/resistance for power shift",
          "Inside bar breakout at key level for continuation",
          "Top-down analysis: Weekly → Daily → 4H for entry",
          "Supply/demand zones — MD: 'Daily and 4H zones are most powerful'",
          "S/R confluence and Fibonacci retracement alignment",
          "MACD momentum confirmation at breakout"
        ],
        hint: "Commodities (Gold, Silver, Platinum, Palladium) have high volatility — "
            + "the MD strategies recommend bigger timeframes to reduce noise. "
            + "MD: 'Price action works on bigger time frames.' "
            + "4H recommended for entry signals — same price action rules as forex. "
            + "Top-down analysis: Weekly chart for major S/R → Daily for structure → 4H for entries. "
            + "London+NY session filter essential — commodity spreads widen outside peak hours. "
            + "All standard indicators work well on 4H commodity charts."
      };
    }
    default:
      return {
        label: "⚡ Breakout Strategy",
        timeframe: { text: "5 min", gran: 300 },
        rr: { text: "1:2–1:3", minRR: 2 },
        range: { text: "15 min", minutes: 15 },
        ema: true,
        htf: true,
        atr: true,
        trailing: { rec: true, note: "1.5× ATR standard" },
        partialTp: true,
        falseBreakout: true,
        minRR: { rec: true, value: "1:2 ✅" },
        rsi: true,
        volSpike: { rec: true, note: "Standard 1.5× average range" },
        session: { rec: false, note: "24/7 synthetic" },
        fib: true,
        macd: true,
        bbSqueeze: true,
        adx: true,
        stoch: true,
        signals: [
          "Opening range breakout with conviction",
          "Retest + indecision + engulfing confirmation",
          "Pin bar and morning/evening star at retest",
          "Inside bar breakout for clean continuation",
          "S/R confluence and Fibonacci retracement alignment",
          "MACD momentum confirmation at breakout",
          "BB squeeze preceding breakout for volatility expansion"
        ],
        hint: "Standard breakout strategy — EMA 8/21 + HTF (EMA 100) filters remove counter-trend noise. "
            + "ATR tolerance adapts retest detection to volatility. "
            + "Trailing stop locks in profits on extended moves. "
            + "Partial TP at 1:1 alerts to consider securing gains — trade continues to full TP. "
            + "False breakout filter prevents entering on fake-outs. "
            + "Min R:R gate ensures every trade has at least 1:2 risk-reward. "
            + "Confluence score (0-16) gauges overall setup quality."
      };
  }
}

function updateRecommendedSettings() {
  const rec = getMarketRecommendations();

  /* Update market type label */
  if (UI.recMarketLabel) {
    UI.recMarketLabel.textContent = rec.label;
  }

  /* Update market type badge in status bar */
  if (UI.marketTypeBadge) {
    const tuning = getMarketTuning();
    UI.marketTypeBadge.textContent = tuning.label;
    const badgeClasses = {
      boom: "status-badge bull",
      crash: "status-badge bear",
      jump: "status-badge warning",
      step: "status-badge enabled",
      rangebreak: "status-badge enabled",
      dailyreset: "status-badge enabled",
      dex: "status-badge warning",
      driftswitch: "status-badge enabled"
    };
    UI.marketTypeBadge.className = "chip-value " + (badgeClasses[getMarketType()] || "env-label");
  }

  /* ---- Dynamic "Rec" column ---- */
  setRecRecBadge(UI.recRec_timeframe, rec.timeframe.text, "status-badge warning rec-badge-rec");
  setRecRecBadge(UI.recRec_rr, rec.rr.text, "status-badge warning rec-badge-rec");
  setRecRecBadge(UI.recRec_range, rec.range.text, "status-badge warning rec-badge-rec");
  setRecRecBadge(UI.recRec_ema, rec.ema ? "ON ✅" : "OFF", rec.ema ? "status-badge bull rec-badge-rec" : "status-badge disabled rec-badge-rec");
  setRecRecBadge(UI.recRec_htf, rec.htf ? "ON ✅" : "OFF", rec.htf ? "status-badge bull rec-badge-rec" : "status-badge disabled rec-badge-rec");
  setRecRecBadge(UI.recRec_atr, rec.atr ? "ON ✅" : "OFF", rec.atr ? "status-badge bull rec-badge-rec" : "status-badge disabled rec-badge-rec");
  setRecRecBadge(UI.recRec_trailing, rec.trailing.rec ? "ON ✅" : "OFF", rec.trailing.rec ? "status-badge bull rec-badge-rec" : "status-badge disabled rec-badge-rec");
  setRecRecBadge(UI.recRec_partialTp, rec.partialTp ? "ON ✅" : "OFF", rec.partialTp ? "status-badge bull rec-badge-rec" : "status-badge disabled rec-badge-rec");
  setRecRecBadge(UI.recRec_falseBreakout, rec.falseBreakout ? "ON ✅" : "OFF", rec.falseBreakout ? "status-badge bull rec-badge-rec" : "status-badge disabled rec-badge-rec");
  setRecRecBadge(UI.recRec_minRR, rec.minRR.value, rec.minRR.rec ? "status-badge bull rec-badge-rec" : "status-badge disabled rec-badge-rec");
  setRecRecBadge(UI.recRec_rsiFilter, rec.rsi ? "ON ✅" : "OFF", rec.rsi ? "status-badge bull rec-badge-rec" : "status-badge disabled rec-badge-rec");
  setRecRecBadge(UI.recRec_volSpike, rec.volSpike.rec ? "ON ✅" : "OFF", rec.volSpike.rec ? "status-badge bull rec-badge-rec" : "status-badge disabled rec-badge-rec");
  setRecRecBadge(UI.recRec_session, rec.session.rec ? rec.session.note : "OFF", rec.session.rec ? "status-badge bull rec-badge-rec" : "status-badge disabled rec-badge-rec");
  setRecRecBadge(UI.recRec_fib, rec.fib ? "ON ✅" : "OFF", rec.fib ? "status-badge bull rec-badge-rec" : "status-badge disabled rec-badge-rec");
  setRecRecBadge(UI.recRec_macd, rec.macd ? "ON ✅" : "OFF", rec.macd ? "status-badge bull rec-badge-rec" : "status-badge disabled rec-badge-rec");
  setRecRecBadge(UI.recRec_bbSqueeze, rec.bbSqueeze ? "ON ✅" : "OFF", rec.bbSqueeze ? "status-badge bull rec-badge-rec" : "status-badge disabled rec-badge-rec");
  setRecRecBadge(UI.recRec_adx, rec.adx ? "ON ✅" : "OFF", rec.adx ? "status-badge bull rec-badge-rec" : "status-badge disabled rec-badge-rec");
  setRecRecBadge(UI.recRec_stoch, rec.stoch ? "ON ✅" : "OFF", rec.stoch ? "status-badge bull rec-badge-rec" : "status-badge disabled rec-badge-rec");

  /* ---- Dynamic "Active" column ---- */
  /* Timeframe: compare against market-type recommendation */
  if (UI.recActive_timeframe && UI.granSelect) {
    const gran = parseInt(UI.granSelect.value, 10);
    UI.recActive_timeframe.textContent = GRAN_LABELS[gran] || formatMinutes(Math.round(gran / 60));
    if (gran === rec.timeframe.gran) {
      UI.recActive_timeframe.className = "status-badge bull rec-badge-active";
    } else {
      UI.recActive_timeframe.className = "status-badge warning rec-badge-active";
    }
  }

  /* R:R: compare against market-type recommendation */
  if (UI.recActive_rr && UI.riskInput && UI.rewardInput) {
    const risk   = parseFloat(UI.riskInput.value)   || 1;
    const reward = parseFloat(UI.rewardInput.value) || 1;
    const rr = reward / risk;
    UI.recActive_rr.textContent = `1:${reward}`;
    if (rr >= rec.rr.minRR) {
      UI.recActive_rr.className = "status-badge bull rec-badge-active";
    } else {
      UI.recActive_rr.className = "status-badge warning rec-badge-active";
    }
  }

  /* Opening Range: compare against market-type recommendation */
  if (UI.recActive_range && UI.rangeDuration) {
    const rm = parseInt(UI.rangeDuration.value, 10) || RANGE_MINUTES;
    UI.recActive_range.textContent = formatMinutes(rm);
    if (rm === rec.range.minutes) {
      UI.recActive_range.className = "status-badge bull rec-badge-active";
    } else {
      UI.recActive_range.className = "status-badge warning rec-badge-active";
    }
  }

  /* Boolean toggle filters — compare against market-type-specific recommendations */
  setRecBadge(UI.recActive_ema,           emaFilterEnabled,     rec.ema);
  setRecBadge(UI.recActive_htf,           htfFilterEnabled,     rec.htf);
  setRecBadge(UI.recActive_atr,           atrToleranceEnabled,  rec.atr);
  setRecBadge(UI.recActive_trailing,      trailingStopEnabled,  rec.trailing.rec);
  setRecBadge(UI.recActive_partialTp,     partialTpEnabled,     rec.partialTp);
  setRecBadge(UI.recActive_falseBreakout, falseBreakoutEnabled, rec.falseBreakout);
  setRecBadge(UI.recActive_rsiFilter,     rsiFilterEnabled,     rec.rsi);
  setRecBadge(UI.recActive_volSpike,      volumeSpikeEnabled,   rec.volSpike.rec);
  setRecBadge(UI.recActive_fib,           fibRetestEnabled,     rec.fib);
  setRecBadge(UI.recActive_macd,          macdFilterEnabled,    rec.macd);
  setRecBadge(UI.recActive_bbSqueeze,     bbSqueezeFilterEnabled, rec.bbSqueeze);
  setRecBadge(UI.recActive_adx,           adxFilterEnabled,     rec.adx);
  setRecBadge(UI.recActive_stoch,         stochFilterEnabled,   rec.stoch);

  /* Min R:R: market-type-aware */
  if (UI.recActive_minRR) {
    const on = minRREnabled;
    const val = minRRValue;
    if (on) {
      UI.recActive_minRR.textContent = `1:${val} ✅`;
      UI.recActive_minRR.className = val >= rec.rr.minRR ? "status-badge bull rec-badge-active" : "status-badge warning rec-badge-active";
    } else {
      UI.recActive_minRR.textContent = "OFF";
      UI.recActive_minRR.className = "status-badge disabled rec-badge-active";
    }
  }

  /* Session filter: market-type-aware */
  if (UI.recActive_session) {
    if (sessionFilterEnabled) {
      UI.recActive_session.textContent = SESSION_MODE_LABELS[sessionFilterMode] || sessionFilterMode;
      UI.recActive_session.className = rec.session.rec
        ? (sessionFilterMode === "london_ny" ? "status-badge bull rec-badge-active" : "status-badge warning rec-badge-active")
        : "status-badge warning rec-badge-active";
    } else {
      UI.recActive_session.textContent = "OFF";
      /* If rec says OFF (synthetic 24/7), then OFF is correct → green */
      UI.recActive_session.className = rec.session.rec ? "status-badge disabled rec-badge-active" : "status-badge bull rec-badge-active";
    }
  }

  /* ---- Key Signals panel ---- */
  if (UI.recMarketSignals && UI.recSignalsList) {
    UI.recMarketSignals.style.display = "block";
    UI.recSignalsList.innerHTML = "";
    for (const sig of rec.signals) {
      const li = document.createElement("li");
      li.textContent = sig;
      UI.recSignalsList.appendChild(li);
    }
  }

  /* ---- Hint text ---- */
  if (UI.recHintText) {
    UI.recHintText.textContent = "";
    const strong = document.createElement("strong");
    strong.textContent = "Why:";
    UI.recHintText.appendChild(strong);
    UI.recHintText.appendChild(document.createTextNode(" " + rec.hint));
  }
}

/**
 * Applies the market-type-specific recommended settings to all strategy filters,
 * timeframe, R:R, opening range, session mode, and min R:R value.
 * Called automatically when auto-apply is enabled and the symbol changes.
 */
function applyRecommendedSettings() {
  const rec = getMarketRecommendations();

  /* Timeframe — skip if locked */
  if (!lockTimeframe && UI.granSelect) UI.granSelect.value = rec.timeframe.gran;

  /* R:R — set reward to recommended minRR (risk stays at 1) — skip if locked */
  if (!lockRR && UI.rewardInput) UI.rewardInput.value = rec.rr.minRR;

  /* Opening range */
  RANGE_MINUTES = rec.range.minutes;
  if (UI.rangeDuration) UI.rangeDuration.value = rec.range.minutes;

  /* Boolean strategy filter toggles — skip if filters are locked (keep user's disabled state) */
  if (!lockIndicatorFilters) {
    emaFilterEnabled     = rec.ema;
    htfFilterEnabled     = rec.htf;
    atrToleranceEnabled  = rec.atr;
    trailingStopEnabled  = rec.trailing.rec;
    partialTpEnabled     = rec.partialTp;
    falseBreakoutEnabled = rec.falseBreakout;
    rsiFilterEnabled     = rec.rsi;
    volumeSpikeEnabled   = rec.volSpike.rec;
    fibRetestEnabled     = rec.fib;
    sessionFilterEnabled = rec.session.rec;

    /* GainzAlgo V2 filter toggles */
    macdFilterEnabled      = rec.macd;
    bbSqueezeFilterEnabled = rec.bbSqueeze;
    adxFilterEnabled       = rec.adx;
    stochFilterEnabled     = rec.stoch;

    /* Min R:R — skip value update if R:R is locked */
    minRREnabled = rec.minRR.rec;
    if (!lockRR) minRRValue = rec.rr.minRR;

    /* Session mode — if recommended, default to london_ny for forex/commodity */
    if (rec.session.rec) {
      sessionFilterMode = "london_ny";
      if (UI.sessionFilterMode) UI.sessionFilterMode.value = sessionFilterMode;
    }

    /* Sync UI checkboxes */
    if (UI.emaFilterToggle)     UI.emaFilterToggle.checked     = emaFilterEnabled;
    if (UI.htfFilterToggle)     UI.htfFilterToggle.checked     = htfFilterEnabled;
    if (UI.atrToleranceToggle)  UI.atrToleranceToggle.checked  = atrToleranceEnabled;
    if (UI.trailingStopToggle)  UI.trailingStopToggle.checked  = trailingStopEnabled;
    if (UI.partialTpToggle)     UI.partialTpToggle.checked     = partialTpEnabled;
    if (UI.falseBreakoutToggle) UI.falseBreakoutToggle.checked = falseBreakoutEnabled;
    if (UI.minRRToggle)         UI.minRRToggle.checked         = minRREnabled;
    if (UI.minRRInput)          UI.minRRInput.value            = minRRValue;
    if (UI.rsiFilterToggle)     UI.rsiFilterToggle.checked     = rsiFilterEnabled;
    if (UI.volumeSpikeToggle)   UI.volumeSpikeToggle.checked   = volumeSpikeEnabled;
    if (UI.sessionFilterToggle) UI.sessionFilterToggle.checked = sessionFilterEnabled;
    if (UI.fibRetestToggle)     UI.fibRetestToggle.checked     = fibRetestEnabled;
    if (UI.macdFilterToggle)      UI.macdFilterToggle.checked      = macdFilterEnabled;
    if (UI.bbSqueezeFilterToggle) UI.bbSqueezeFilterToggle.checked = bbSqueezeFilterEnabled;
    if (UI.adxFilterToggle)       UI.adxFilterToggle.checked       = adxFilterEnabled;
    if (UI.stochFilterToggle)     UI.stochFilterToggle.checked     = stochFilterEnabled;
  } else {
    /* Filters are locked — only update the R/R value (not state) if R/R isn't also locked */
    if (!lockRR) minRRValue = rec.rr.minRR;
    if (UI.minRRInput) UI.minRRInput.value = minRRValue;
  }

  /* Persist + refresh UI */
  saveSettings();
  updateRecommendedSettings();
  updateStateUI();
}

/* ================= INDICATOR STATE ================= */
function resetIndicator() {
  candles = [];
  rangeStartEpoch = null;
  openingRange = null;
  breakout = null;
  retestInfo = null;
  indecisionInfo = null;
  confirmInfo = null;
  trade = null;
  monitoringTrade = false;
  /* Note: do NOT clear per-symbol autoTradeSlots here — resetIndicator is
     called during reconnect, and we need pending contract IDs to survive
     so we can re-subscribe after re-authorization. */
  emaFast = [];
  emaSlow = [];
  emaHTF  = [];
  atrValue  = 0;
  atrValues = [];
  rsiValues = [];
  macdLine = []; macdSignal = []; macdHistogram = [];
  bbUpper = []; bbLower = []; bbMiddle = []; bbWidth = [];
  adxValue = 0; adxDiPlus = 0; adxDiMinus = 0;
  stochK = []; stochD = [];
  emaMTF = []; vwapValues = [];
  retestCount = 0;
  trailingSL   = null;
  partialTpHit = false;
  teslaT1Hit = false;
  teslaT2Hit = false;
  teslaT3Hit = false;
  teslaBEHit = false;
  resetNyOpenRange();
  setPhase("WAITING");
  updateStateUI();
}

/**
 * Full session reset: clears all indicator state, signal history, stats,
 * signal log, and persisted session data. Keeps settings/filters intact.
 * Use when the user wants to start fresh without changing symbol/timeframe.
 */
function resetSession() {
  /* Reset core indicator state */
  resetIndicator();

  /* Clear signal history & stats */
  signalHistory = [];
  signalWins = 0;
  signalLosses = 0;
  updateStatsUI();

  /* Clear live scalp history */
  liveScalpHistory = [];
  lastScalpCandleIdx = -999;
  renderScalpAlerts();
  updateScalpStatsUI();
  renderScalpTickerBanner();
  renderStrategyTickerBanner();
  if (UI.scalpAlertBanner) UI.scalpAlertBanner.classList.remove("scalp-banner-show");

  /* Clear session range trade stats */
  sessionRangeTradeWins = 0;
  sessionRangeTradeLosses = 0;

  /* Clear signal log UI */
  if (UI.signalLog) UI.signalLog.innerHTML = "";

  /* Clear status bar win rate */
  const statusBarWR = document.getElementById("statusBarWinRate");
  if (statusBarWR) statusBarWR.textContent = "0%";

  /* Clear persisted session data (keep settings) */
  try {
    localStorage.removeItem(LS_PREFIX + "signalLog");
    localStorage.removeItem(LS_PREFIX + "signalHistory");
    localStorage.removeItem(LS_PREFIX + "autoTradeHistory");
    localStorage.removeItem(LS_PREFIX + "autoTradePL");
  } catch (e) { /* storage not available */ }

  /* Reset auto-trade history */
  autoTradeHistory = [];
  autoTradePL = 0;
  /* Reset dynamic stake management state */
  autoTradeCurrentStake = Math.max(MIN_AUTO_TRADE_STAKE, parseFloat(autoTradeStake) || 1);
  autoTradeWinStreak = 0;
  autoTradeLossCount = 0;
  autoTradeHalted = false;
  updateAutoTradeCurrentStakeUI();
  /* Reset session start balance so P/L recalculates from this point */
  sessionStartBalance = autoTradeBalance;
  renderAutoTradeHistory();
  updateAutoTradePLUI();

  /* Redraw chart (cleared state) */
  drawChart();

  addLog("Session reset — all stats and signals cleared.");
}

function updateStateUI() {
  /* Skip main sidebar updates when processing a non-focused multi-panel */
  if (_multiPanelProcessing && _multiPanelProcessing !== focusedPanelSymbol) return;

  if (UI.candleCount) UI.candleCount.textContent = candles.length;
  if (UI.rangeHigh)   UI.rangeHigh.textContent   = openingRange ? fmt(openingRange.high, 4) : "--";
  if (UI.rangeLow)    UI.rangeLow.textContent     = openingRange ? fmt(openingRange.low, 4) : "--";

  if (UI.breakoutDir) {
    if (breakout) {
      UI.breakoutDir.textContent = breakout.dir;
      UI.breakoutDir.className = "status-badge " + (breakout.dir === "BULL" ? "bull" : "bear");
    } else {
      UI.breakoutDir.textContent = "NONE";
      UI.breakoutDir.className = "status-badge disabled";
    }
  }

  if (UI.retestStatus) UI.retestStatus.textContent  = retestInfo  ? `Candle #${retestInfo.candleIdx}` : "--";
  if (UI.confirmStatus) UI.confirmStatus.textContent = confirmInfo ? `Candle #${confirmInfo.candleIdx}` : "--";

  /* Next Action: recommended order type based on trade type */
  if (UI.nextAction) {
    const orderType = getRecommendedOrderType();
    if (orderType) {
      UI.nextAction.textContent = orderType;
      UI.nextAction.className = "status-badge " + (breakout.dir === "BULL" ? "bull" : "bear");
    } else {
      UI.nextAction.textContent = "--";
      UI.nextAction.className = "status-badge disabled";
    }
  }

  /* EMA filter status */
  if (UI.emaFilterStatus) {
    if (!emaFilterEnabled) {
      UI.emaFilterStatus.textContent = "OFF";
      UI.emaFilterStatus.className = "env-label";
    } else if (breakout) {
      const aligned = isEmaAligned(breakout.dir);
      UI.emaFilterStatus.textContent = aligned ? "ALIGNED ✅" : "BLOCKED ❌";
      UI.emaFilterStatus.className = "status-badge " + (aligned ? "bull" : "bear");
    } else {
      UI.emaFilterStatus.textContent = "WAITING";
      UI.emaFilterStatus.className = "env-label";
    }
  }

  /* HTF Trend */
  if (UI.htfTrend) {
    const trend = getHTFTrend();
    UI.htfTrend.textContent = trend;
    UI.htfTrend.className = "status-badge " + ({
      BULL: "bull", BEAR: "bear", FLAT: "disabled"
    }[trend] || "disabled");
  }

  /* ATR display */
  if (UI.atrDisplay) {
    UI.atrDisplay.textContent = atrValue > 0 ? fmt(atrValue, 4) : "--";
  }

  /* Breakout strength */
  if (UI.breakoutStrength) {
    if (breakout && breakout.candleIdx < candles.length && atrValue > 0) {
      const bc = candles[breakout.candleIdx];
      const candleRange = bc.high - bc.low;
      const bodySize = Math.abs(bc.close - bc.open);
      const strong = candleRange >= atrValue * 0.8 && bodySize >= candleRange * 0.6;
      UI.breakoutStrength.textContent = strong ? "STRONG" : "WEAK";
      UI.breakoutStrength.className = "status-badge " + (strong ? "bull" : "warning");
    } else {
      UI.breakoutStrength.textContent = "--";
      UI.breakoutStrength.className = "env-label";
    }
  }

  /* Confluence score */
  if (UI.confluenceDisplay) {
    if (breakout) {
      confluenceScore = computeConfluenceScore();
      const strength = getSignalStrength(confluenceScore);
      UI.confluenceDisplay.textContent = `${confluenceScore} / 16`;
      UI.confluenceDisplay.className = "status-badge " + strength.cls;
    } else {
      confluenceScore = 0;
      UI.confluenceDisplay.textContent = "--";
      UI.confluenceDisplay.className = "env-label";
    }
  }

  /* S/R Confluence */
  if (UI.srConfluenceDisplay) {
    if (breakout) {
      const hasSR = hasSRConfluence(breakout.level);
      UI.srConfluenceDisplay.textContent = hasSR ? "YES ✅" : "NO";
      UI.srConfluenceDisplay.className = "status-badge " + (hasSR ? "bull" : "disabled");
    } else {
      UI.srConfluenceDisplay.textContent = "--";
      UI.srConfluenceDisplay.className = "env-label";
    }
  }

  /* RSI display */
  if (UI.rsiDisplay) {
    const rsi = getCurrentRSI();
    if (rsi != null) {
      UI.rsiDisplay.textContent = fmt(rsi, 1);
      if (rsi <= 30) UI.rsiDisplay.className = "status-badge bull";
      else if (rsi >= 70) UI.rsiDisplay.className = "status-badge bear";
      else UI.rsiDisplay.className = "env-label";
    } else {
      UI.rsiDisplay.textContent = "--";
      UI.rsiDisplay.className = "env-label";
    }
  }

  /* Volume spike display */
  if (UI.volumeSpikeDisplay) {
    if (breakout && breakout.candleIdx < candles.length) {
      const spike = hasVolumeSpikeOnBreakout(breakout.candleIdx);
      UI.volumeSpikeDisplay.textContent = spike ? "YES ✅" : "NO";
      UI.volumeSpikeDisplay.className = "status-badge " + (spike ? "bull" : "disabled");
    } else {
      UI.volumeSpikeDisplay.textContent = "--";
      UI.volumeSpikeDisplay.className = "env-label";
    }
  }

  /* Session display */
  if (UI.sessionDisplay) {
    const sessionName = getActiveSessionName();
    const inSession = isWithinActiveSession();
    UI.sessionDisplay.textContent = sessionName + (sessionFilterEnabled ? (inSession ? " ✅" : " ❌") : "");
    UI.sessionDisplay.className = sessionFilterEnabled
      ? ("status-badge " + (inSession ? "bull" : "bear"))
      : "env-label";
  }

  /* Session Ranges display */
  if (UI.sessionRangeAsianDisplay) {
    if (sessionRangesEnabled && sessionRangeAsian) {
      UI.sessionRangeAsianDisplay.textContent = `H:${fmt(sessionRangeAsian.high, 4)} L:${fmt(sessionRangeAsian.low, 4)}`;
      UI.sessionRangeAsianDisplay.className = "status-badge disabled";
    } else {
      UI.sessionRangeAsianDisplay.textContent = sessionRangesEnabled ? "WAITING" : "OFF";
      UI.sessionRangeAsianDisplay.className = "env-label";
    }
  }
  if (UI.asianTightDisplay) {
    if (sessionRangesEnabled && sessionRangeAsian) {
      UI.asianTightDisplay.textContent = asianRangeTight ? "TIGHT ⚡" : "WIDE";
      UI.asianTightDisplay.className = "status-badge " + (asianRangeTight ? "warning" : "disabled");
    } else {
      UI.asianTightDisplay.textContent = "--";
      UI.asianTightDisplay.className = "env-label";
    }
  }
  if (UI.sessionRangeLondonDisplay) {
    if (sessionRangesEnabled && sessionRangeLondon) {
      UI.sessionRangeLondonDisplay.textContent = `H:${fmt(sessionRangeLondon.high, 4)} L:${fmt(sessionRangeLondon.low, 4)}`;
      UI.sessionRangeLondonDisplay.className = "status-badge disabled";
    } else {
      UI.sessionRangeLondonDisplay.textContent = sessionRangesEnabled ? "WAITING" : "OFF";
      UI.sessionRangeLondonDisplay.className = "env-label";
    }
  }
  if (UI.sessionRangeNYDisplay) {
    if (sessionRangesEnabled && sessionRangeNY) {
      UI.sessionRangeNYDisplay.textContent = `H:${fmt(sessionRangeNY.high, 4)} L:${fmt(sessionRangeNY.low, 4)}`;
      UI.sessionRangeNYDisplay.className = "status-badge disabled";
    } else {
      UI.sessionRangeNYDisplay.textContent = sessionRangesEnabled ? "WAITING" : "OFF";
      UI.sessionRangeNYDisplay.className = "env-label";
    }
  }
  if (UI.londonSweepDisplay) {
    if (sessionRangesEnabled && londonSweepSignal) {
      const sweepLabel = londonSweepSignal.dir === "HIGH"
        ? `SWEPT HIGH ▲ @${fmt(londonSweepSignal.price, 4)}`
        : `SWEPT LOW ▼ @${fmt(londonSweepSignal.price, 4)}`;
      UI.londonSweepDisplay.textContent = sweepLabel;
      UI.londonSweepDisplay.className = "status-badge " + (londonSweepSignal.dir === "HIGH" ? "bear" : "bull");
    } else {
      UI.londonSweepDisplay.textContent = sessionRangesEnabled ? "NONE" : "OFF";
      UI.londonSweepDisplay.className = "env-label";
    }
  }

  /* Session Range Trade levels display (Entry / SL / TP / R:R) */
  if (UI.sessionRangeTradeDisplay) {
    if (sessionRangesEnabled && sessionRangeTrade) {
      const dirLabel = sessionRangeTrade.dir === "BULL" ? "▲ BUY" : "▼ SELL";
      UI.sessionRangeTradeDisplay.textContent = dirLabel;
      UI.sessionRangeTradeDisplay.className = "status-badge " + (sessionRangeTrade.dir === "BULL" ? "bull" : "bear");
    } else {
      UI.sessionRangeTradeDisplay.textContent = sessionRangesEnabled ? "NONE" : "OFF";
      UI.sessionRangeTradeDisplay.className = "env-label";
    }
  }
  if (UI.sessionRangeEntryDisplay) {
    UI.sessionRangeEntryDisplay.textContent = sessionRangesEnabled && sessionRangeTrade
      ? fmtPrice(sessionRangeTrade.entry, sessionRangeTrade.symbol || getActiveSymbol()) : "--";
    UI.sessionRangeEntryDisplay.className = sessionRangeTrade ? "status-badge disabled" : "env-label";
  }
  if (UI.sessionRangeSLDisplay) {
    UI.sessionRangeSLDisplay.textContent = sessionRangesEnabled && sessionRangeTrade
      ? fmtPrice(sessionRangeTrade.sl, sessionRangeTrade.symbol || getActiveSymbol()) : "--";
    UI.sessionRangeSLDisplay.className = sessionRangeTrade ? "status-badge bear" : "env-label";
  }
  if (UI.sessionRangeTPDisplay) {
    UI.sessionRangeTPDisplay.textContent = sessionRangesEnabled && sessionRangeTrade
      ? fmtPrice(sessionRangeTrade.tp, sessionRangeTrade.symbol || getActiveSymbol()) : "--";
    UI.sessionRangeTPDisplay.className = sessionRangeTrade ? "status-badge bull" : "env-label";
  }
  if (UI.sessionRangeRRDisplay) {
    UI.sessionRangeRRDisplay.textContent = sessionRangesEnabled && sessionRangeTrade
      ? `1:${fmt(sessionRangeTrade.rr, 1)}` : "--";
    UI.sessionRangeRRDisplay.className = sessionRangeTrade ? "status-badge disabled" : "env-label";
  }

  /* Fibonacci retest display */
  if (UI.fibRetestDisplay) {
    if (breakout) {
      const fibResult = getFibRetestLevel(breakout.level);
      if (fibResult) {
        UI.fibRetestDisplay.textContent = `${(fibResult.ratio * 100).toFixed(1)}% ✅`;
        UI.fibRetestDisplay.className = "status-badge bull";
      } else {
        UI.fibRetestDisplay.textContent = "NO";
        UI.fibRetestDisplay.className = "status-badge disabled";
      }
    } else {
      UI.fibRetestDisplay.textContent = "--";
      UI.fibRetestDisplay.className = "env-label";
    }
  }

  /* MACD display */
  if (UI.macdDisplay) {
    const hist = getCurrentMACD();
    if (hist != null) {
      UI.macdDisplay.textContent = fmt(hist, 5);
      UI.macdDisplay.className = "status-badge " + (hist > 0 ? "bull" : hist < 0 ? "bear" : "disabled");
    } else {
      UI.macdDisplay.textContent = "--";
      UI.macdDisplay.className = "env-label";
    }
  }

  /* Bollinger Bands squeeze display */
  if (UI.bbSqueezeDisplay) {
    if (bbWidth.length > 0 && bbWidth[bbWidth.length - 1] != null) {
      const squeeze = isBBSqueeze();
      UI.bbSqueezeDisplay.textContent = squeeze ? "SQUEEZE ⚡" : "NORMAL";
      UI.bbSqueezeDisplay.className = "status-badge " + (squeeze ? "warning" : "disabled");
    } else {
      UI.bbSqueezeDisplay.textContent = "--";
      UI.bbSqueezeDisplay.className = "env-label";
    }
  }

  /* ADX display */
  if (UI.adxDisplay) {
    if (adxValue > 0) {
      const regime = getVolatilityRegime();
      UI.adxDisplay.textContent = `${fmt(adxValue, 1)} (${regime})`;
      UI.adxDisplay.className = "status-badge " + (regime === "TRENDING" ? "bull" : regime === "RANGING" ? "bear" : "warning");
    } else {
      UI.adxDisplay.textContent = "--";
      UI.adxDisplay.className = "env-label";
    }
  }

  /* Stochastic display */
  if (UI.stochDisplay) {
    const k = getCurrentStoch();
    if (k != null) {
      UI.stochDisplay.textContent = fmt(k, 1);
      if (k <= STOCH_OVERSOLD) UI.stochDisplay.className = "status-badge bull";
      else if (k >= STOCH_OVERBOUGHT) UI.stochDisplay.className = "status-badge bear";
      else UI.stochDisplay.className = "env-label";
    } else {
      UI.stochDisplay.textContent = "--";
      UI.stochDisplay.className = "env-label";
    }
  }

  /* Volatility Regime */
  if (UI.volatilityRegime) {
    if (adxValue > 0) {
      const regime = getVolatilityRegime();
      UI.volatilityRegime.textContent = regime;
      UI.volatilityRegime.className = "status-badge " + (regime === "TRENDING" ? "bull" : regime === "RANGING" ? "bear" : "warning");
    } else {
      UI.volatilityRegime.textContent = "--";
      UI.volatilityRegime.className = "env-label";
    }
  }

  /* Signal Strength Gauge */
  if (UI.signalStrengthGauge && UI.signalStrengthLabel) {
    if (breakout) {
      const str = getSignalStrength(confluenceScore);
      UI.signalStrengthLabel.textContent = str.label;
      UI.signalStrengthLabel.className = "status-badge " + str.cls;
      UI.signalStrengthGauge.style.width = str.pct + "%";
      UI.signalStrengthGauge.className = "gauge-fill gauge-" + str.cls;
    } else {
      UI.signalStrengthLabel.textContent = "--";
      UI.signalStrengthLabel.className = "env-label";
      UI.signalStrengthGauge.style.width = "0%";
      UI.signalStrengthGauge.className = "gauge-fill";
    }
  }

  /* Trailing SL */
  if (UI.trailingSLDisplay) {
    UI.trailingSLDisplay.textContent = trailingSL != null ? fmt(trailingSL, 4) : "--";
  }

  /* Partial TP */
  if (UI.partialTpDisplay) {
    if (!partialTpEnabled) {
      UI.partialTpDisplay.textContent = "OFF";
    } else {
      UI.partialTpDisplay.textContent = partialTpHit ? "HIT ✅" : "--";
    }
  }

  if (trade) {
    const activeSym = getActiveSymbol();
    if (UI.entryPrice) UI.entryPrice.textContent = fmtPrice(trade.entry, activeSym);
    if (UI.slPrice) UI.slPrice.textContent    = fmtPrice(trade.sl, activeSym);
    if (UI.tpPrice) UI.tpPrice.textContent    = trade.tp != null ? fmtPrice(trade.tp, activeSym) : "TRAILING";
    if (UI.rrDisplay) UI.rrDisplay.textContent  = `1 : ${fmt(trade.rr, 1)}`;

    /* Account-based $ Risk / $ Reward / Position Size */
    const m = calcPositionMetrics(trade);
    const acctActive = m != null;
    if (UI.dollarRiskCard) UI.dollarRiskCard.style.display = acctActive ? "" : "none";
    if (UI.dollarRewardCard) UI.dollarRewardCard.style.display = acctActive ? "" : "none";
    if (UI.positionSizeCard) UI.positionSizeCard.style.display = acctActive ? "" : "none";
    if (UI.pipsCard) UI.pipsCard.style.display = (acctActive && !m.isSynthetic) ? "" : "none";
    if (acctActive) {
      if (UI.dollarRisk) UI.dollarRisk.textContent = `$${fmt(m.dollarRisk, 2)}`;
      if (UI.dollarReward) UI.dollarReward.textContent = trade.tp != null ? `$${fmt(m.dollarReward, 2)}` : "TRAILING";
      /* Always show Lot Size (MT5) */
      if (UI.positionSizeLabel) UI.positionSizeLabel.textContent = "Lot Size";
      if (UI.positionSize) {
        UI.positionSize.textContent = fmt(m.lotSize, 2);
      }
      if (!m.isSynthetic && UI.pipsValue) {
        UI.pipsValue.textContent = `${fmt(m.pips, 1)} pips`;
      }
    }
  } else {
    if (UI.entryPrice) UI.entryPrice.textContent = "--";
    if (UI.slPrice) UI.slPrice.textContent    = "--";
    if (UI.tpPrice) UI.tpPrice.textContent    = "--";
    if (UI.rrDisplay) UI.rrDisplay.textContent  = "--";
    /* Hide account cards when no trade */
    if (UI.dollarRiskCard) UI.dollarRiskCard.style.display = "none";
    if (UI.dollarRewardCard) UI.dollarRewardCard.style.display = "none";
    if (UI.positionSizeCard) UI.positionSizeCard.style.display = "none";
    if (UI.pipsCard) UI.pipsCard.style.display = "none";
    if (UI.dollarRisk) UI.dollarRisk.textContent = "--";
    if (UI.dollarReward) UI.dollarReward.textContent = "--";
    if (UI.positionSize) UI.positionSize.textContent = "--";
    if (UI.pipsValue) UI.pipsValue.textContent = "--";
  }

  /* Update recommended settings active state */
  updateRecommendedSettings();
}

/* ================= CONNECTION UPTIME ================= */
function startUptimeTimer() {
  connectTime = Date.now();
  if (uptimeInterval) clearInterval(uptimeInterval);
  uptimeInterval = setInterval(updateUptime, 1000);
  updateUptime();
}

function stopUptimeTimer() {
  connectTime = null;
  if (uptimeInterval) clearInterval(uptimeInterval);
  uptimeInterval = null;
  if (UI.uptimeDisplay) UI.uptimeDisplay.textContent = "--";
}

function updateUptime() {
  if (!connectTime || !UI.uptimeDisplay) return;
  const elapsed = Math.floor((Date.now() - connectTime) / 1000);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  UI.uptimeDisplay.textContent = `${m}m ${s.toString().padStart(2, "0")}s`;
}

/* ================= CANDLE COUNTDOWN TIMER ================= */
function startCandleCountdown() {
  stopCandleCountdown();
  candleCountdownInterval = setInterval(updateCandleCountdown, 1000);
  updateCandleCountdown();
}

function stopCandleCountdown() {
  if (candleCountdownInterval) {
    clearInterval(candleCountdownInterval);
    candleCountdownInterval = null;
  }
  if (UI.candleCountdown) {
    UI.candleCountdown.textContent = "--";
    UI.candleCountdown.className = "countdown-badge";
  }
}

function updateCandleCountdown() {
  if (!UI.candleCountdown || candles.length === 0) return;

  const gran = parseInt(UI.granSelect.value, 10);
  const lastCandle = candles[candles.length - 1];
  const candleEndEpoch = lastCandle.epoch + gran;
  const nowEpoch = Math.floor(Date.now() / 1000);
  const remaining = candleEndEpoch - nowEpoch;

  if (remaining <= 0) {
    UI.candleCountdown.textContent = "0s";
    UI.candleCountdown.className = "countdown-badge countdown-urgent";
    return;
  }

  const hrs = Math.floor(remaining / 3600);
  const min = Math.floor((remaining % 3600) / 60);
  const sec = remaining % 60;

  if (hrs > 0) {
    UI.candleCountdown.textContent = `${hrs}h ${min.toString().padStart(2, "0")}m ${sec.toString().padStart(2, "0")}s`;
  } else if (min > 0) {
    UI.candleCountdown.textContent = `${min}m ${sec.toString().padStart(2, "0")}s`;
  } else {
    UI.candleCountdown.textContent = `${sec}s`;
  }

  /* Add urgent class when under 10 seconds */
  UI.candleCountdown.className = remaining <= 10
    ? "countdown-badge countdown-urgent"
    : "countdown-badge";
}

/* ================= PING / KEEPALIVE ================= */
function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ ping: 1 }));
    }
    /* Keep the authenticated trading connection alive too */
    if (authWs && authWs.readyState === WebSocket.OPEN) {
      authWs.send(JSON.stringify({ ping: 1 }));
    }
  }, PING_INTERVAL_MS);
}

function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

/* ================= STREAM WATCHDOG ================= */
/**
 * Monitors whether OHLC/candle data is flowing on the main WebSocket.
 * If no candle data arrives within STREAM_WATCHDOG_TIMEOUT_MS (2 min),
 * force-closes the connection which triggers the auto-reconnect logic.
 */
function startStreamWatchdog() {
  stopStreamWatchdog();
  streamWatchdogTimer = setTimeout(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      addLog("⚠️ Stream watchdog: no candle data for 2 min – force-closing connection");
      ws.close(); /* triggers onclose → scheduleReconnect */
    }
  }, STREAM_WATCHDOG_TIMEOUT_MS);
}

function resetStreamWatchdog() {
  if (streamWatchdogTimer) startStreamWatchdog();
}

function stopStreamWatchdog() {
  if (streamWatchdogTimer) {
    clearTimeout(streamWatchdogTimer);
    streamWatchdogTimer = null;
  }
}

/**
 * Panel-level watchdog: monitors candle flow on each multi-panel WebSocket.
 * Force-closes and auto-reconnects the panel if silent for 2 min.
 */
function startPanelWatchdog(p) {
  stopPanelWatchdog(p);
  p._watchdogTimer = setTimeout(() => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      addLog(`⚠️ [Multi] ${p.symbol} stream watchdog: no candle data for 2 min – force-closing`);
      p.ws.close(); /* triggers panel onclose → auto-reconnect */
    }
  }, STREAM_WATCHDOG_TIMEOUT_MS);
}

function resetPanelWatchdog(p) {
  if (p._watchdogTimer) startPanelWatchdog(p);
}

function stopPanelWatchdog(p) {
  if (p._watchdogTimer) {
    clearTimeout(p._watchdogTimer);
    p._watchdogTimer = null;
  }
}

/* ================= ACCOUNT / AUTH HELPERS ================= */

/** Send a candles subscription request on a WebSocket */
function subscribeCandles(socket, symbol, gran) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    ticks_history: symbol,
    adjust_start_time: 1,
    count: 100,
    end: "latest",
    granularity: gran,
    style: "candles",
    subscribe: 1
  }));
}

/** Update the account type badge in the status bar */
function updateAccountBadge(acct) {
  if (!UI.accountTypeBadge) return;
  if (acct) _lastAuthorizeAcct = acct;
  if (!acct) {
    UI.accountTypeBadge.textContent = "NO AUTH";
    UI.accountTypeBadge.className = "status-badge disabled";
    UI.accountTypeBadge.title = "Not authorized – using public data feed";
    return;
  }
  const isReal = !acct.is_virtual;
  UI.accountTypeBadge.textContent = isReal ? `REAL (${acct.currency})` : `DEMO (${acct.currency})`;
  UI.accountTypeBadge.className = isReal ? "status-badge enabled" : "status-badge caution";
  UI.accountTypeBadge.title = streamMode
    ? "Account authorized"
    : `${acct.loginid} – Balance: ${acct.currency} ${acct.balance}`;
}

/* ================= WEBSOCKET ================= */
function connect() {
  if (ws && ws.readyState <= 1) return;
  intentionalClose = false;
  reconnectAttempts = 0;
  resetIndicator();

  const symbol = resolveFeedSymbol(UI.symbolSelect.value);
  if (symbol !== UI.symbolSelect.value) UI.symbolSelect.value = symbol;
  const gran   = parseInt(UI.granSelect.value, 10);
  addLog(`📈 Selected symbol: ${symbol} (${getMarketType(symbol)} market, ${STEP_INDEX_LABELS[symbol] || getSymbolLabel(symbol)}), granularity ${gran}s`);

  /* ── Public market-data feed (no auth token required) ── */
  ws = new WebSocket(PUBLIC_WS_URL);
  const thisWs = ws; /* capture reference to detect stale handlers */

  ws.onopen = () => {
    if (thisWs !== ws) return; /* stale connection */
    UI.wsStatus.textContent = "CONNECTED";
    UI.wsStatus.className = "status-badge enabled";
    UI.connectBtn.disabled = true;
    UI.disconnectBtn.disabled = false;
    reconnectAttempts = 0;
    publicFeedTickCount = 0;
    if (UI.pfTickCount)  UI.pfTickCount.textContent  = '0';
    if (UI.pfLastUpdate) UI.pfLastUpdate.textContent = '--';
    updatePublicFeedPanel('connected');
    startUptimeTimer();
    startPing();
    startStreamWatchdog();

    /* Notify user that the public feed is active */
    showToast("📡 Public Feed Active", "Connected to Deriv public market feed. Indicators are now active.", "success", 5000);

    /* Start NY Open Range timer if enabled */
    if (nyOpenRangeEnabled) startNyOpenRangeTimer();

    /* Subscribe to market data directly — no auth required on the public feed */
    addLog(`Connected to public feed – subscribing to ${symbol} (${gran}s candles)`);
    subscribeCandles(thisWs, symbol, gran);

    /* Also open the authenticated trading connection if a token is set */
    connectAuthWs(symbol);
  };

  ws.onmessage = (evt) => {
    if (thisWs !== ws) return; /* stale connection */
    const msg = JSON.parse(evt.data);

    /* Ignore ping/pong responses */
    if (msg.msg_type === "ping" || msg.msg_type === "pong") return;

    if (msg.error) {
      addLog(`Feed error [${msg.error.code || "?"}] for ${symbol}: ${msg.error.message}`);
      return;
    }

    /* Historical batch */
    if (msg.candles) {
      resetStreamWatchdog();
      candles = msg.candles.map(c => ({
        open: +c.open, high: +c.high, low: +c.low, close: +c.close, epoch: c.epoch
      }));
      if (candles.length > 0) rangeStartEpoch = candles[0].epoch;
      if (candles.length > 0) {
        addLog(`📊 ${symbol}: received ${candles.length} historical candles (first ${fmt(candles[0].close, 2)} @ ${candles[0].epoch}, last ${fmt(candles[candles.length - 1].close, 2)} @ ${candles[candles.length - 1].epoch})`);
      } else {
        addLog(`⚠️ ${symbol}: historical candle request returned 0 candles — no data to compute indicators`);
      }
      computeEMAs();
      processAllCandles();
      logIndicatorSnapshot(symbol);
      drawChart();
      startCandleCountdown();
    }

    /* Streaming OHLC */
    if (msg.ohlc) {
      resetStreamWatchdog();
      const o = msg.ohlc;
      const c = {
        open: +o.open, high: +o.high, low: +o.low, close: +o.close, epoch: +o.open_time
      };

          /* Track public feed tick count and last-update time */
          recordPublicFeedTick(o.symbol || getActiveSymbol(), fmt(c.close, 4));

          const isNewCandle = !(candles.length > 0 && candles[candles.length - 1].epoch === c.epoch);
          if (candles.length > 0 && candles[candles.length - 1].epoch === c.epoch) {
        candles[candles.length - 1] = c;
      } else {
        candles.push(c);
        if (candles.length > MAX_CANDLE_HISTORY) {
          const removed = candles.length - MAX_CANDLE_HISTORY;
          candles = candles.slice(removed);
          adjustIndicesAfterSlice(removed);
        }
      }

      if (!rangeStartEpoch && candles.length > 0) rangeStartEpoch = candles[0].epoch;

      if (UI.livePrice) UI.livePrice.textContent = fmt(c.close, 4);

      computeEMAs();
      computeATR();
      computeRSI();
      computeMACD();
      computeBollingerBands();
      computeADX();
      computeStochastic();
      computeEMA200();
      computeVWAP();
      if (isNewCandle && getMarketType(symbol) === "step") {
        logIndicatorSnapshot(symbol);
      }
      processLatestCandle();
      processLiveScalp();
      processCustomStrategies();
      monitorTradeOutcome(c);
      monitorScalpOutcomes(c);
      monitorCustomStrategyOutcomes(c);
      monitorSessionRangeTradeOutcome(c);
      monitorNyOpenRangeTradeOutcome(c);
      /* Feature 5: update BOS/ChoCH markers on each new candle */
      if (bosChochEnabled) detectBosChoch();
      drawChart();
    }
  };

  ws.onclose = () => {
    if (thisWs !== ws) return; /* stale connection – don't touch current state */
    stopPing();
    stopStreamWatchdog();
    stopCandleCountdown();
    UI.wsStatus.textContent = "DISCONNECTED";
    UI.wsStatus.className = "status-badge disabled";
    UI.connectBtn.disabled = false;
    UI.disconnectBtn.disabled = true;
    updatePublicFeedPanel(intentionalClose ? 'disconnected' : 'reconnecting');
    stopUptimeTimer();
    addLog("WebSocket closed");

    /* Reset per-symbol auto-trade slots on disconnect — but preserve
       contract IDs for reconnect if this was an unintentional close. */
    for (const [sym, slot] of autoTradeSlots.entries()) {
      if (slot.contractId && !intentionalClose) {
        slot.pendingContractId = slot.contractId;
        addLog(`📌 Preserving contract ${slot.contractId} for re-subscribe after reconnect (${sym})`);
      }
      /* Clear all active trade timers */
      for (const t of slot.activeTrades) {
        if (t.pendingTimer) { clearTimeout(t.pendingTimer); t.pendingTimer = null; }
      }
      slot.activeTrades = [];
      slot.inProgress = false;
      slot.contractId = null;
    }

    if (intentionalClose) {
      /* Intentional disconnect — resolve any stuck PENDING entries */
      for (const [sym, slot] of autoTradeSlots.entries()) {
        clearAutoTradePendingTimeout(sym);
        slot.pendingContractId = null;
      }
      for (const e of autoTradeHistory) {
        if (e.result === "PENDING") {
          e.result = "CANCELLED";
          e.profit = 0;
        }
      }
    }
    /* If unintentional close, leave PENDING entries and the pending timeout
       running — they will be resolved after reconnect via re-subscribe,
       or time out via the pending timer as a safety net. */
    recalcAutoTradePL();
    renderAutoTradeHistory();
    updateAutoTradePLUI();
    persistAutoTradeHistory();

    /* Nullify so connect() guard doesn't block reconnection */
    ws = null;

    /* Auto-reconnect if not intentional */
    if (!intentionalClose) {
      scheduleReconnect();
    }
  };

  ws.onerror = (evt) => {
    if (thisWs !== ws) return; /* stale connection */
    const errorMsg = evt.message || evt.reason || "connection failed";
    addLog("WebSocket error: " + errorMsg);
    console.error("WebSocket error details:", evt);
    
    /* Show user-friendly error notification */
    if (!intentionalClose) {
      showToast("Connection Error", "WebSocket connection failed. Reconnecting...", "warning", TOAST_WARNING_DURATION_MS);
    }
  };
}

function disconnect() {
  intentionalClose = true;
  authorized = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (chartRedrawTimer) { cancelAnimationFrame(chartRedrawTimer); chartRedrawTimer = null; }
  chartRedrawPending = false;
  stopPing();
  stopStreamWatchdog();
  stopCandleCountdown();
  stopUptimeTimer();
  stopNyOpenRangeTimer();
  updateAccountBadge(null);
  /* Clear all per-symbol auto-trade slots */
  for (const [sym, slot] of autoTradeSlots.entries()) {
    clearAutoTradePendingTimeout(sym);
    for (const t of slot.activeTrades) {
      if (t.pendingTimer) { clearTimeout(t.pendingTimer); t.pendingTimer = null; }
    }
    slot.activeTrades = [];
    slot.inProgress = false;
    slot.contractId = null;
    slot.pendingContractId = null;
  }

  /* Resolve any stuck PENDING entries on intentional disconnect */
  for (const e of autoTradeHistory) {
    if (e.result === "PENDING") {
      e.result = "CANCELLED";
      e.profit = 0;
    }
  }
  recalcAutoTradePL();
  renderAutoTradeHistory();
  updateAutoTradePLUI();
  persistAutoTradeHistory();

  if (ws) {
    /* Detach handlers so the closing socket can't interfere with future state */
    const dyingWs = ws;
    ws = null;
    dyingWs.onopen = dyingWs.onmessage = dyingWs.onclose = dyingWs.onerror = null;

    /* Clean up active subscriptions before closing */
    try {
      if (dyingWs.readyState === WebSocket.OPEN) {
        dyingWs.send(JSON.stringify({ forget_all: "candles" }));
        dyingWs.send(JSON.stringify({ forget_all: "ticks" }));
      }
    } catch (e) { /* ignore send errors during teardown */ }

    dyingWs.close();
  }

  /* Close the authenticated trading connection too */
  if (authWs) {
    const dyingAuth = authWs;
    authWs = null;
    dyingAuth.onopen = dyingAuth.onmessage = dyingAuth.onclose = dyingAuth.onerror = null;
    try {
      if (dyingAuth.readyState === WebSocket.OPEN) {
        dyingAuth.send(JSON.stringify({ forget_all: "balance" }));
      }
    } catch (e) { /* ignore */ }
    dyingAuth.close();
  }

  /* Update UI so the connect button is re-enabled (onclose won't fire
     because handlers were detached above) */
  UI.wsStatus.textContent = "DISCONNECTED";
  UI.wsStatus.className = "status-badge disabled";
  UI.connectBtn.disabled = false;
  UI.disconnectBtn.disabled = true;
  updatePublicFeedPanel('disconnected');
  addLog("Disconnected");
}

/**
 * Open the authenticated WebSocket for trading actions (authorize / buy / sell / balance).
 * Called after the public feed connects successfully when a Deriv token is stored.
 * Market data (charts, indicators) always comes from the public feed — this channel
 * is strictly for account-bound operations.
 *
 * @param {string} symbol — currently-selected symbol (used for multiplier pre-fetch)
 */
function connectAuthWs(symbol) {
  const token = sessionStorage.getItem(DERIV_TOKEN_KEY) || "";
  if (!token) return; /* no token — trading disabled, public-feed-only mode */

  if (authWs && authWs.readyState <= 1) return; /* already connecting or open */

  authWs = new WebSocket(AUTH_WS_URL);
  const thisAuthWs = authWs;

  authWs.onopen = () => {
    if (thisAuthWs !== authWs) return;
    addLog("Authorizing Deriv account for trading…");
    thisAuthWs.send(JSON.stringify({ authorize: token }));
  };

  authWs.onmessage = (evt) => {
    if (thisAuthWs !== authWs) return;
    const msg = JSON.parse(evt.data);

    if (msg.msg_type === "ping" || msg.msg_type === "pong") return;

    if (msg.error) {
      /* Delegate trade-related errors first */
      if (handleAutoTradeMessage(msg, thisAuthWs)) return;
      addLog("Auth error: " + msg.error.message);
      if (msg.msg_type === "authorize") {
        addLog("⚠ Authorization failed – trading disabled (market data still active)");
        authorized = false;
        updateAccountBadge(null);
      }
      return;
    }

    /* ── Authorize response ── */
    if (msg.msg_type === "authorize") {
      authorized = true;
      const acct = msg.authorize;
      const isReal = !acct.is_virtual;
      updateAccountBadge(acct);
      addLog(streamMode
        ? `✅ Authorized (${isReal ? "REAL" : "DEMO"})`
        : `✅ Authorized as ${acct.loginid} (${isReal ? "REAL" : "DEMO"}) – ${acct.currency} ${acct.balance}`);
      if (!isReal) {
        addLog("⚠ Demo account – switch to a real account token for live trading");
      }
      autoTradeBalance = parseFloat(acct.balance) || null;
      if (sessionStartBalance == null) sessionStartBalance = autoTradeBalance;
      updateAutoTradeBalanceUI();
      updateAutoTradeBalanceVisibility();
      thisAuthWs.send(JSON.stringify({ balance: 1, subscribe: 1 }));
      autoUpdateMultiplier(symbol);
      /* Re-subscribe to any in-flight contracts that survived a reconnect */
      for (const [sym, slot] of autoTradeSlots.entries()) {
        if (slot.pendingContractId) {
          addLog(`🔄 Re-subscribing to contract ${slot.pendingContractId} after reconnect (${sym})…`);
          slot.contractId = slot.pendingContractId;
          slot.inProgress = true;
          slot.pendingContractId = null;
          thisAuthWs.send(JSON.stringify({
            proposal_open_contract: 1,
            contract_id: slot.contractId,
            subscribe: 1,
            passthrough: { auto_trade: true, source: "reconnect", tradeSymbol: sym }
          }));
          startAutoTradePendingTimeout(sym, thisAuthWs);
        }
      }
      return;
    }

    /* Delegate proposal / buy / POC / balance to the shared handler */
    handleAutoTradeMessage(msg, thisAuthWs);
  };

  authWs.onclose = () => {
    if (thisAuthWs !== authWs) return;
    if (!intentionalClose) {
      /* Preserve contract IDs so we can re-subscribe on reconnect */
      for (const [sym, slot] of autoTradeSlots.entries()) {
        if (slot.contractId) {
          slot.pendingContractId = slot.contractId;
          addLog(`📌 Preserving contract ${slot.contractId} for re-subscribe after auth reconnect (${sym})`);
        }
      }
    }
    authorized = false;
    authWs = null;
    updateAccountBadge(null);
    addLog("Auth WebSocket closed" + (intentionalClose ? "" : " — will reconnect with next market feed cycle"));
  };

  authWs.onerror = (evt) => {
    if (thisAuthWs !== authWs) return;
    addLog("Auth WebSocket error: " + (evt.message || "connection failed"));
  };
}

function scheduleReconnect() {
  if (intentionalClose) return;
  
  const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts), RECONNECT_MAX_DELAY);
  reconnectAttempts++;
  
  /* Cap reconnect attempts and provide user feedback */
  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    addLog("⚠️ Max reconnection attempts reached. Please check your connection and click Connect.");
    UI.wsStatus.textContent = "FAILED";
    UI.wsStatus.className = "status-badge error";
    showToast("Connection Failed", "Unable to reconnect after multiple attempts. Please try again manually.", "error", TOAST_ERROR_DURATION_MS);
    return;
  }
  
  addLog(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${reconnectAttempts})...`);
  UI.wsStatus.textContent = "RECONNECTING";
  UI.wsStatus.className = "status-badge warning";
  updatePublicFeedPanel('reconnecting');
  
  reconnectTimer = setTimeout(() => {
    if (!intentionalClose) {
      try {
        connect();
      } catch (err) {
        console.error("Reconnection error:", err);
        addLog(`Reconnection failed: ${err.message}`);
        scheduleReconnect(); /* Try again with exponential backoff */
      }
    }
  }, delay);
}

function debouncedReconnect() {
  if (reconnectDebounceTimer) clearTimeout(reconnectDebounceTimer);
  reconnectDebounceTimer = setTimeout(() => {
    disconnect();
    setTimeout(connect, 100);
  }, RECONNECT_DEBOUNCE_MS);
}

function adjustIndicesAfterSlice(removed) {
  if (openingRange) {
    openingRange.startIdx = Math.max(0, openingRange.startIdx - removed);
    openingRange.endIdx   = Math.max(0, openingRange.endIdx - removed);
  }
  if (breakout) breakout.candleIdx = Math.max(0, breakout.candleIdx - removed);
  if (retestInfo) retestInfo.candleIdx = Math.max(0, retestInfo.candleIdx - removed);
  if (indecisionInfo) indecisionInfo.candleIdx = Math.max(0, indecisionInfo.candleIdx - removed);
  if (confirmInfo) confirmInfo.candleIdx = Math.max(0, confirmInfo.candleIdx - removed);

  /* Adjust strategy signal indices and cooldown trackers */
  lastLiquiditySweepIdx = Math.max(-999, lastLiquiditySweepIdx - removed);
  lastStopLossHuntIdx   = Math.max(-999, lastStopLossHuntIdx - removed);
  lastFailedPinBarIdx   = Math.max(-999, lastFailedPinBarIdx - removed);
  lastFibScalpIdx       = Math.max(-999, lastFibScalpIdx - removed);
  lastPo3Idx            = Math.max(-999, lastPo3Idx - removed);
  lastGridScalperMAIdx  = Math.max(-999, lastGridScalperMAIdx - removed);
  lastScalpCandleIdx    = Math.max(-999, lastScalpCandleIdx - removed);
  lastMtfTopDownIdx     = Math.max(-999, lastMtfTopDownIdx - removed);

  for (const h of [liquiditySweepHistory, stopLossHuntHistory, failedPinBarHistory, fibScalpHistory, po3History, gridScalperMAHistory, liveScalpHistory, nyOpenRangeHistory, sessionRangeHistory, mtfTopDownHistory]) {
    for (const s of h) {
      if (s.candleIdx != null) s.candleIdx = Math.max(0, s.candleIdx - removed);
    }
  }
}

/* ================= EMA COMPUTATION ================= */
function computeEMAs() {
  const closes = candles.map(c => c.close);
  emaFast = computeEMA(closes, EMA_FAST_PERIOD);
  emaSlow = computeEMA(closes, EMA_SLOW_PERIOD);
  emaHTF  = computeEMA(closes, HTF_EMA_PERIOD);
}

/**
 * Requirement #10: detailed per-symbol indicator logging for Step Index (and
 * other) markets. Logs the latest computed value of each indicator so failures
 * are visible in the signal log instead of silently skipping.
 */
function logIndicatorSnapshot(symbol) {
  try {
    const last = (a) => (Array.isArray(a) && a.length) ? a[a.length - 1] : null;
    const f = (v, d = 4) => (v == null || isNaN(v)) ? "--" : fmt(v, d);
    addLog(
      `📈 ${symbol} indicators — ` +
      `RSI:${f(last(rsiValues), 1)} MACD:${f(last(macdHistogram), 4)} ` +
      `EMA${EMA_FAST_PERIOD}:${f(last(emaFast))} EMA${EMA_SLOW_PERIOD}:${f(last(emaSlow))} ` +
      `BB[${f(last(bbLower))}/${f(last(bbMiddle))}/${f(last(bbUpper))}] ` +
      `ATR:${f(atrValue)} ADX:${f(adxValue, 1)} ` +
      `Stoch%K:${f(last(stochK), 1)} %D:${f(last(stochD), 1)} ` +
      `VWAP:${f(last(vwapValues))}`
    );
  } catch (e) {
    addLog(`⚠️ ${symbol} indicator snapshot failed: ${e.message}`);
  }
}

function computeEMA(data, period) {
  if (!data || data.length === 0 || period <= 0) return [];
  const result = [];
  const multiplier = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    if (i < period) {
      sum += data[i];
      if (i === period - 1) {
        result.push(period > 0 ? sum / period : 0);
      } else {
        result.push(null);
      }
    } else {
      const ema = (data[i] - result[i - 1]) * multiplier + result[i - 1];
      result.push(ema);
    }
  }
  return result;
}

/**
 * Compute a Simple Moving Average over an array of values.
 * Returns an array of the same length; positions before period-1 are null.
 */
function computeSMA(data, period) {
  if (!data || data.length === 0 || period <= 0) return [];
  const result = [];
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i];
    if (i >= period) sum -= data[i - period];
    result.push(i >= period - 1 ? sum / period : null);
  }
  return result;
}

/* ================= ATR COMPUTATION ================= */
function computeATR() {
  if (!candles || candles.length < 2) { atrValue = 0; atrValues = []; return; }
  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    if (!c || !prev) continue;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    );
    trueRanges.push(tr);
  }
  /* Simple moving average for initial ATR, then EMA-smooth */
  atrValues = [];
  if (trueRanges.length < ATR_PERIOD) {
    const avg = trueRanges.length > 0 ? trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length : 0;
    atrValue = avg;
    atrValues = trueRanges.map(() => avg);
    return;
  }
  let sum = 0;
  for (let i = 0; i < ATR_PERIOD; i++) sum += trueRanges[i];
  let prevATR = ATR_PERIOD > 0 ? sum / ATR_PERIOD : 0;
  for (let i = 0; i < trueRanges.length; i++) {
    if (i < ATR_PERIOD) {
      atrValues.push(i === ATR_PERIOD - 1 ? prevATR : null);
    } else {
      prevATR = ATR_PERIOD > 0 ? (prevATR * (ATR_PERIOD - 1) + trueRanges[i]) / ATR_PERIOD : 0;
      atrValues.push(prevATR);
    }
  }
  atrValue = prevATR;
}

/* ================= RSI COMPUTATION ================= */
function computeRSI() {
  if (!candles || candles.length < RSI_PERIOD + 1) { rsiValues = []; return; }
  const closes = candles.map(c => c && c.close != null ? c.close : 0);
  rsiValues = [];

  let gains = 0, losses = 0;
  for (let i = 1; i <= RSI_PERIOD; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  let avgGain = RSI_PERIOD > 0 ? gains / RSI_PERIOD : 0;
  let avgLoss = RSI_PERIOD > 0 ? losses / RSI_PERIOD : 0;

  for (let i = 0; i < RSI_PERIOD; i++) rsiValues.push(null);

  /* When avgLoss is 0 all movement was up → RSI = 100 */
  rsiValues.push(avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss)));

  for (let i = RSI_PERIOD + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = RSI_PERIOD > 0 ? (avgGain * (RSI_PERIOD - 1) + gain) / RSI_PERIOD : 0;
    avgLoss = RSI_PERIOD > 0 ? (avgLoss * (RSI_PERIOD - 1) + loss) / RSI_PERIOD : 0;
    rsiValues.push(avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss)));
  }
}

function getCurrentRSI() {
  if (rsiValues.length === 0) return null;
  return rsiValues[rsiValues.length - 1];
}

/* ================= MACD COMPUTATION ================= */
function computeMACD() {
  const closes = candles.map(c => c.close);
  if (closes.length < MACD_SLOW) { macdLine = []; macdSignal = []; macdHistogram = []; return; }
  const emaFastArr = computeEMA(closes, MACD_FAST);
  const emaSlowArr = computeEMA(closes, MACD_SLOW);
  macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    if (emaFastArr[i] != null && emaSlowArr[i] != null) {
      macdLine.push(emaFastArr[i] - emaSlowArr[i]);
    } else {
      macdLine.push(null);
    }
  }
  const validMACD = macdLine.filter(v => v != null);
  if (validMACD.length < MACD_SIGNAL_PERIOD) { macdSignal = []; macdHistogram = []; return; }
  macdSignal = computeEMA(macdLine.map(v => v ?? 0), MACD_SIGNAL_PERIOD);
  /* Fix: null out signal where MACD was null */
  for (let i = 0; i < macdLine.length; i++) {
    if (macdLine[i] == null) macdSignal[i] = null;
  }
  macdHistogram = [];
  for (let i = 0; i < macdLine.length; i++) {
    if (macdLine[i] != null && macdSignal[i] != null) {
      macdHistogram.push(macdLine[i] - macdSignal[i]);
    } else {
      macdHistogram.push(null);
    }
  }
}

function getCurrentMACD() {
  if (macdHistogram.length === 0) return null;
  return macdHistogram[macdHistogram.length - 1];
}

function isMACDAligned(dir) {
  if (!macdFilterEnabled) return true;
  const hist = getCurrentMACD();
  if (hist == null) return true;
  return dir === "BULL" ? hist > 0 : hist < 0;
}

/* ================= BOLLINGER BANDS COMPUTATION ================= */
function computeBollingerBands() {
  if (!candles || candles.length < BB_PERIOD) {
    bbUpper = []; bbLower = []; bbMiddle = []; bbWidth = [];
    return;
  }
  const closes = candles.map(c => c && c.close != null ? c.close : 0);
  bbUpper = []; bbLower = []; bbMiddle = []; bbWidth = [];
  
  for (let i = 0; i < closes.length; i++) {
    if (i < BB_PERIOD - 1) {
      bbUpper.push(null); bbLower.push(null); bbMiddle.push(null); bbWidth.push(null);
      continue;
    }
    const slice = closes.slice(i - BB_PERIOD + 1, i + 1);
    const mean = BB_PERIOD > 0 ? slice.reduce((a, b) => a + b, 0) / BB_PERIOD : 0;
    const variance = BB_PERIOD > 0 ? slice.reduce((a, v) => a + (v - mean) ** 2, 0) / BB_PERIOD : 0;
    const stdDev = Math.sqrt(variance);
    bbMiddle.push(mean);
    bbUpper.push(mean + BB_STD_DEV * stdDev);
    bbLower.push(mean - BB_STD_DEV * stdDev);
    bbWidth.push(bbUpper[i] - bbLower[i]);
  }
}

function isBBSqueeze() {
  if (bbWidth.length < BB_PERIOD * 2) return false;
  const validWidths = bbWidth.filter(w => w != null);
  if (validWidths.length < BB_PERIOD) return false;
  const current = validWidths[validWidths.length - 1];
  const avgWidth = validWidths.slice(-BB_PERIOD * 2).reduce((a, b) => a + b, 0) / Math.min(validWidths.length, BB_PERIOD * 2);
  return current < avgWidth * BB_SQUEEZE_THRESHOLD;
}

function getBBPosition() {
  if (candles.length === 0 || bbUpper.length === 0) return null;
  const i = candles.length - 1;
  if (bbUpper[i] == null || bbLower[i] == null) return null;
  const price = candles[i].close;
  const width = bbUpper[i] - bbLower[i];
  if (width <= 0) return null;
  return (price - bbLower[i]) / width;  /* 0 = at lower band, 1 = at upper band */
}

/* ================= ADX COMPUTATION ================= */
function computeADX() {
  adxValue = 0; adxDiPlus = 0; adxDiMinus = 0;
  if (candles.length < ADX_PERIOD * 2 + 1) return;
  const trArr = [], dpArr = [], dmArr = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const upMove = c.high - p.high;
    const downMove = p.low - c.low;
    dpArr.push(upMove > downMove && upMove > 0 ? upMove : 0);
    dmArr.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trArr.push(tr);
  }
  /* Wilder smoothing */
  let atr14 = 0, smoothDP = 0, smoothDM = 0;
  for (let i = 0; i < ADX_PERIOD; i++) { atr14 += trArr[i]; smoothDP += dpArr[i]; smoothDM += dmArr[i]; }
  const dxArr = [];
  for (let i = ADX_PERIOD; i < trArr.length; i++) {
    atr14 = atr14 - atr14 / ADX_PERIOD + trArr[i];
    smoothDP = smoothDP - smoothDP / ADX_PERIOD + dpArr[i];
    smoothDM = smoothDM - smoothDM / ADX_PERIOD + dmArr[i];
    const diP = atr14 > 0 ? (smoothDP / atr14) * 100 : 0;
    const diM = atr14 > 0 ? (smoothDM / atr14) * 100 : 0;
    const diSum = diP + diM;
    const dx = diSum > 0 ? Math.abs(diP - diM) / diSum * 100 : 0;
    dxArr.push({ dx, diP, diM });
  }
  if (dxArr.length < ADX_PERIOD) return;
  let adxSmooth = 0;
  for (let i = 0; i < ADX_PERIOD; i++) adxSmooth += dxArr[i].dx;
  adxSmooth /= ADX_PERIOD;
  for (let i = ADX_PERIOD; i < dxArr.length; i++) {
    adxSmooth = (adxSmooth * (ADX_PERIOD - 1) + dxArr[i].dx) / ADX_PERIOD;
  }
  adxValue = adxSmooth;
  const last = dxArr[dxArr.length - 1];
  adxDiPlus = last.diP;
  adxDiMinus = last.diM;
}

function getVolatilityRegime() {
  if (adxValue >= ADX_TRENDING_THRESHOLD) return "TRENDING";
  if (adxValue < ADX_RANGING_THRESHOLD) return "RANGING";
  return "TRANSITIONING";
}

function isADXFavorable() {
  if (!adxFilterEnabled) return true;
  return adxValue >= ADX_RANGING_THRESHOLD;  /* block signals in ranging markets */
}

/* ================= STOCHASTIC COMPUTATION ================= */
function computeStochastic() {
  stochK = []; stochD = [];
  if (candles.length < STOCH_K_PERIOD + STOCH_SMOOTH) return;
  /* Raw %K */
  const rawK = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < STOCH_K_PERIOD - 1) { rawK.push(null); continue; }
    const slice = candles.slice(i - STOCH_K_PERIOD + 1, i + 1);
    const hh = Math.max(...slice.map(c => c.high));
    const ll = Math.min(...slice.map(c => c.low));
    const range = hh - ll;
    rawK.push(range > 0 ? ((candles[i].close - ll) / range) * 100 : 50);
  }
  /* Smooth %K with SMA */
  for (let i = 0; i < rawK.length; i++) {
    if (rawK[i] == null || i < STOCH_K_PERIOD - 1 + STOCH_SMOOTH - 1) { stochK.push(null); continue; }
    let sum = 0;
    for (let j = i - STOCH_SMOOTH + 1; j <= i; j++) sum += (rawK[j] ?? 0);
    stochK.push(sum / STOCH_SMOOTH);
  }
  /* %D = SMA of %K */
  for (let i = 0; i < stochK.length; i++) {
    if (stochK[i] == null || i < stochK.length - 1 && stochK.filter((v, idx) => idx <= i && v != null).length < STOCH_D_PERIOD) {
      stochD.push(null); continue;
    }
    const validBefore = [];
    for (let j = Math.max(0, i - STOCH_D_PERIOD + 1); j <= i; j++) {
      if (stochK[j] != null) validBefore.push(stochK[j]);
    }
    stochD.push(validBefore.length >= STOCH_D_PERIOD ? validBefore.slice(-STOCH_D_PERIOD).reduce((a, b) => a + b, 0) / STOCH_D_PERIOD : null);
  }
}

function getCurrentStoch() {
  if (stochK.length === 0) return null;
  return stochK[stochK.length - 1];
}

function isStochFavorable(dir) {
  if (!stochFilterEnabled) return true;
  const k = getCurrentStoch();
  if (k == null) return true;
  /* For BULL: stoch should be coming from oversold (room to rise) */
  if (dir === "BULL") return k <= STOCH_OVERBOUGHT;  /* not already overbought */
  /* For BEAR: stoch should be coming from overbought (room to fall) */
  if (dir === "BEAR") return k >= STOCH_OVERSOLD;  /* not already oversold */
  return true;
}

/* ================= PROFIT-DIRECTION CONSTRAINT FILTERS ================= */

/* Compute EMA 200 for MTF structure */
function computeEMA200() {
  emaMTF = [];
  if (candles.length === 0) return;
  const k = 2 / (MTF_EMA_PERIOD + 1);
  let ema = candles[0].close;
  emaMTF.push(ema);
  for (let i = 1; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
    emaMTF.push(ema);
  }
}

/* Compute VWAP approximation (rolling typical price × range weighted average).
 * Uses candle range as volume proxy since synthetic indices don't provide real volume data. */
function computeVWAP() {
  vwapValues = [];
  if (candles.length === 0) return;
  let cumTPxVol = 0;
  let cumVol = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tp = (c.high + c.low + c.close) / 3;
    const vol = c.high - c.low;  /* range as volume proxy for synthetics */
    cumTPxVol += tp * (vol || 1);
    cumVol += (vol || 1);
    vwapValues.push(cumVol > 0 ? cumTPxVol / cumVol : tp);
  }
}

/* 1. Min Confluence Gate — applied after trade is built (main strategy) or before signal fires (secondary strategies) */
function isConfluenceSufficient(overrideDir, overrideLevel, overrideCandleIdx) {
  if (!minConfluenceEnabled) return true;
  const score = computeConfluenceScore(overrideDir, overrideLevel, overrideCandleIdx);
  return score >= minConfluenceValue;
}

/* 2. Double Retest — track retest count */
function isDoubleRetestSatisfied() {
  if (!doubleRetestEnabled) return true;
  return retestCount >= 2;
}

/* 3. Confirmation Bar — check if candle at idx closed in trade direction */
function isConfirmBarValid(idx) {
  if (!confirmBarEnabled) return true;
  if (idx >= candles.length || !breakout) return true;
  const c = candles[idx];
  if (breakout.dir === "BULL") return c.close > c.open;  /* bullish close */
  if (breakout.dir === "BEAR") return c.close < c.open;  /* bearish close */
  return true;
}

/* 4. Momentum Divergence — detect RSI divergence at retest */
function hasMomentumDivergence(dir) {
  if (!divergenceFilterEnabled) return true;
  if (rsiValues.length < 10 || !breakout || !retestInfo) return true;

  /* Find RSI at breakout and at retest */
  const boIdx = breakout.candleIdx;
  const rtIdx = retestInfo.candleIdx;
  if (boIdx >= rsiValues.length || rtIdx >= rsiValues.length) return true;
  const rsiBO = rsiValues[boIdx];
  const rsRT = rsiValues[rtIdx];
  if (rsiBO == null || rsRT == null) return true;

  const priceBO = candles[boIdx].close;
  const pricRT = candles[rtIdx].close;

  if (dir === "BULL") {
    /* Bullish divergence: price makes lower low but RSI makes higher low */
    return pricRT <= priceBO ? rsRT > rsiBO : true;
  }
  if (dir === "BEAR") {
    /* Bearish divergence: price makes higher high but RSI makes lower high */
    return pricRT >= priceBO ? rsRT < rsiBO : true;
  }
  return true;
}

/* 5. ADX Hard Gate — block when ADX < 20 or > max threshold */
function isADXInRange() {
  if (!adxHardGateEnabled) return true;
  if (adxValue <= 0) return true;  /* no data yet */
  return adxValue >= ADX_RANGING_THRESHOLD && adxValue <= adxMaxThreshold;
}

/* 6. Breakout Distance — reject if retest too far from breakout level */
function isBreakoutDistanceOK(idx) {
  if (!breakoutDistEnabled) return true;
  if (!breakout || atrValue <= 0) return true;
  const price = candles[idx].close;
  const dist = Math.abs(price - breakout.level);
  return dist <= breakoutDistATR * atrValue;
}

/* 7. Time Decay — reject if too many candles between breakout and current */
function isTimeDecayOK(idx) {
  if (!timeDecayEnabled) return true;
  if (!breakout) return true;
  return (idx - breakout.candleIdx) <= timeDecayCandles;
}

/* 8. Consecutive Direction — 2 of last 3 candles close in trade direction */
function hasConsecutiveDirection(idx, dir) {
  if (!consecutiveDirEnabled) return true;
  if (idx < 2) return true;
  let count = 0;
  for (let i = Math.max(0, idx - 2); i <= idx; i++) {
    const c = candles[i];
    if (dir === "BULL" && c.close > c.open) count++;
    if (dir === "BEAR" && c.close < c.open) count++;
  }
  return count >= 2;
}

/* 9. VWAP Alignment — price near/above VWAP for BULL, near/below for BEAR */
function isVWAPAligned(dir) {
  if (!vwapFilterEnabled) return true;
  if (vwapValues.length === 0 || candles.length === 0) return true;
  const vwap = vwapValues[vwapValues.length - 1];
  const price = candles[candles.length - 1].close;
  if (vwap === null || vwap === undefined) return true;
  /* Allow within 0.5 ATR of VWAP as "near" */
  const tolerance = atrValue > 0 ? atrValue * VWAP_ATR_TOLERANCE : Math.abs(price * VWAP_PRICE_TOLERANCE_PCT);
  if (dir === "BULL") return price >= vwap - tolerance;
  if (dir === "BEAR") return price <= vwap + tolerance;
  return true;
}

/* 10. Stochastic Crossover — K crossing D from oversold/overbought */
function hasStochCrossover(dir) {
  if (!stochCrossEnabled) return true;
  if (stochK.length < 2 || stochD.length < 2) return true;
  const kNow  = stochK[stochK.length - 1];
  const kPrev = stochK[stochK.length - 2];
  const dNow  = stochD[stochD.length - 1];
  const dPrev = stochD[stochD.length - 2];
  if (kNow == null || kPrev == null || dNow == null || dPrev == null) return true;
  if (dir === "BULL") {
    /* K crosses above D from below, and coming from oversold zone */
    return kPrev <= dPrev && kNow > dNow && kPrev <= STOCH_OVERSOLD + STOCH_CROSSOVER_BUFFER;
  }
  if (dir === "BEAR") {
    /* K crosses below D from above, and coming from overbought zone */
    return kPrev >= dPrev && kNow < dNow && kPrev >= STOCH_OVERBOUGHT - STOCH_CROSSOVER_BUFFER;
  }
  return true;
}

/* 11. Opening Range Size — range must be within min-max ATR multiples */
function isRangeSizeOK() {
  if (!rangeSizeEnabled) return true;
  if (!openingRange || atrValue <= 0) return true;
  const rangeSize = openingRange.high - openingRange.low;
  const ratio = rangeSize / atrValue;
  return ratio >= rangeSizeMin && ratio <= rangeSizeMax;
}

/* 12. Higher-High / Higher-Low Structure Check */
function hasHHHLStructure(dir) {
  if (!hhhlEnabled) return true;
  if (candles.length < HHHL_LOOKBACK_PERIOD) return true;
  /* Look at last N candles for swing structure */
  const lookback = Math.min(candles.length, HHHL_LOOKBACK_PERIOD);
  const start = candles.length - lookback;
  const highs = [];
  const lows = [];
  /* Find mini swing points (local extremes) */
  for (let i = start + 1; i < candles.length - 1; i++) {
    if (candles[i].high > candles[i - 1].high && candles[i].high > candles[i + 1].high) {
      highs.push(candles[i].high);
    }
    if (candles[i].low < candles[i - 1].low && candles[i].low < candles[i + 1].low) {
      lows.push(candles[i].low);
    }
  }
  if (highs.length < 2 || lows.length < 2) return true;  /* not enough data */
  if (dir === "BULL") {
    /* Higher highs and higher lows */
    const hhOK = highs[highs.length - 1] > highs[highs.length - 2];
    const hlOK = lows[lows.length - 1] > lows[lows.length - 2];
    return hhOK && hlOK;
  }
  if (dir === "BEAR") {
    /* Lower highs and lower lows */
    const lhOK = highs[highs.length - 1] < highs[highs.length - 2];
    const llOK = lows[lows.length - 1] < lows[lows.length - 2];
    return lhOK && llOK;
  }
  return true;
}

/* 13. Post-Breakout Follow-Through — next candle after breakout continues in direction */
function hasFollowThrough() {
  if (!followThroughEnabled) return true;
  if (!breakout || breakout.candleIdx + 1 >= candles.length) return true;
  const nextCandle = candles[breakout.candleIdx + 1];
  if (breakout.dir === "BULL") return nextCandle.close > nextCandle.open;
  if (breakout.dir === "BEAR") return nextCandle.close < nextCandle.open;
  return true;
}

/* 14. MTF Structure — EMA 200 alignment */
function isMTFStructureAligned(dir) {
  if (!mtfStructureEnabled) return true;
  if (emaMTF.length === 0 || candles.length === 0) return true;
  const ema200 = emaMTF[emaMTF.length - 1];
  const price = candles[candles.length - 1].close;
  if (ema200 === null || ema200 === undefined) return true;
  if (dir === "BULL") return price > ema200;
  if (dir === "BEAR") return price < ema200;
  return true;
}

/* ---- Revert all settings to defaults ---- */
function revertAllSettings() {
  /* API default */
  APP_ID = 120128;
  updateWsUrl();

  /* Core filter defaults */
  autoResetEnabled     = true;
  emaFilterEnabled     = false;
  htfFilterEnabled     = false;
  atrToleranceEnabled  = false;
  trailingStopEnabled  = false;
  partialTpEnabled     = false;
  falseBreakoutEnabled = false;
  minRREnabled         = false;
  minRRValue           = 2.0;
  pureTrailingEnabled  = false;
  teslaScalingEnabled  = false;
  teslaScalingPlan     = "conservative";

  /* Advanced signal defaults */
  rsiFilterEnabled     = false;
  volumeSpikeEnabled   = false;
  sessionFilterEnabled = false;
  sessionFilterMode    = "london_ny";
  fibRetestEnabled     = false;

  /* GainzAlgo V2 defaults */
  macdFilterEnabled      = false;
  bbSqueezeFilterEnabled = false;
  adxFilterEnabled       = false;
  stochFilterEnabled     = false;

  /* Profit-Direction Constraint defaults */
  minConfluenceEnabled    = false;
  minConfluenceValue      = 6;
  doubleRetestEnabled     = false;
  confirmBarEnabled       = false;
  divergenceFilterEnabled = false;
  adxHardGateEnabled      = false;
  adxMaxThreshold         = 50;
  breakoutDistEnabled     = false;
  breakoutDistATR         = 3.0;
  timeDecayEnabled        = false;
  timeDecayCandles        = 20;
  consecutiveDirEnabled   = false;
  vwapFilterEnabled       = false;
  stochCrossEnabled       = false;
  rangeSizeEnabled        = false;
  rangeSizeMin            = 0.5;
  rangeSizeMax            = 3.0;
  hhhlEnabled             = false;
  followThroughEnabled    = false;
  mtfStructureEnabled     = false;

  /* Scalping & misc */
  scalpingModeEnabled  = false;
  nyOpenRangeEnabled   = false;
  sessionRangesEnabled = false;
  autoApplyRecommended = true;
  lockTimeframe = false;
  lockRR        = false;
  liquiditySweepEnabled = false;
  stopLossHuntEnabled   = false;
  failedPinBarEnabled   = false;
  fibScalpEnabled       = false;
  po3Enabled            = false;
  po3EntryMaxAge        = PO3_ENTRY_MAX_AGE_SAFE;
  gridScalperMAEnabled  = false;
  gridScalperMAStrategy = "price_vs_ma";
  gridScalperMAPeriod   = 21;
  fvgStratEnabled       = false;
  mtfTopDownEnabled     = false;
  RANGE_MINUTES           = 15;
  LEVEL_TOUCH_TOLERANCE   = 0.15;
  DOJI_BODY_RATIO         = 0.2;
  SWING_LOOKBACK_PERIOD   = 35;

  /* Sync all UI elements */
  if (UI.appIdInput)             UI.appIdInput.value               = APP_ID;
  if (UI.autoResetToggle)        UI.autoResetToggle.checked        = autoResetEnabled;
  if (UI.emaFilterToggle)        UI.emaFilterToggle.checked        = emaFilterEnabled;
  if (UI.htfFilterToggle)        UI.htfFilterToggle.checked        = htfFilterEnabled;
  if (UI.atrToleranceToggle)     UI.atrToleranceToggle.checked     = atrToleranceEnabled;
  if (UI.trailingStopToggle)     UI.trailingStopToggle.checked     = trailingStopEnabled;
  if (UI.partialTpToggle)        UI.partialTpToggle.checked        = partialTpEnabled;
  if (UI.falseBreakoutToggle)    UI.falseBreakoutToggle.checked    = falseBreakoutEnabled;
  if (UI.minRRToggle)            UI.minRRToggle.checked            = minRREnabled;
  if (UI.minRRInput)             UI.minRRInput.value               = minRRValue;
  if (UI.pureTrailingToggle)     UI.pureTrailingToggle.checked     = pureTrailingEnabled;
  if (UI.teslaScalingToggle)     UI.teslaScalingToggle.checked     = teslaScalingEnabled;
  if (UI.teslaScalingPlan)       UI.teslaScalingPlan.value         = teslaScalingPlan;
  if (UI.rsiFilterToggle)        UI.rsiFilterToggle.checked        = rsiFilterEnabled;
  if (UI.volumeSpikeToggle)      UI.volumeSpikeToggle.checked      = volumeSpikeEnabled;
  if (UI.sessionFilterToggle)    UI.sessionFilterToggle.checked    = sessionFilterEnabled;
  if (UI.sessionFilterMode)      UI.sessionFilterMode.value        = sessionFilterMode;
  if (UI.fibRetestToggle)        UI.fibRetestToggle.checked        = fibRetestEnabled;
  if (UI.macdFilterToggle)       UI.macdFilterToggle.checked       = macdFilterEnabled;
  if (UI.bbSqueezeFilterToggle)  UI.bbSqueezeFilterToggle.checked  = bbSqueezeFilterEnabled;
  if (UI.adxFilterToggle)        UI.adxFilterToggle.checked        = adxFilterEnabled;
  if (UI.stochFilterToggle)      UI.stochFilterToggle.checked      = stochFilterEnabled;
  if (UI.scalpingModeToggle)     UI.scalpingModeToggle.checked     = scalpingModeEnabled;
  if (UI.nyOpenRangeToggle)      UI.nyOpenRangeToggle.checked      = nyOpenRangeEnabled;
  if (UI.sessionRangesToggle)    UI.sessionRangesToggle.checked    = sessionRangesEnabled;
  if (UI.autoApplyRecToggle)     UI.autoApplyRecToggle.checked     = autoApplyRecommended;
  if (UI.lockTimeframeToggle)    UI.lockTimeframeToggle.checked    = lockTimeframe;
  if (UI.lockRRToggle)           UI.lockRRToggle.checked           = lockRR;
  if (UI.lockIndicatorFiltersToggle) UI.lockIndicatorFiltersToggle.checked = lockIndicatorFilters;
  if (UI.liquiditySweepToggle)   UI.liquiditySweepToggle.checked   = liquiditySweepEnabled;
  if (UI.stopLossHuntToggle)     UI.stopLossHuntToggle.checked     = stopLossHuntEnabled;
  if (UI.failedPinBarToggle)     UI.failedPinBarToggle.checked     = failedPinBarEnabled;
  if (UI.fibScalpToggle)         UI.fibScalpToggle.checked         = fibScalpEnabled;
  if (UI.po3Toggle)              UI.po3Toggle.checked              = po3Enabled;
  if (UI.po3FreshnessMode)       UI.po3FreshnessMode.value         = String(po3EntryMaxAge);
  if (UI.gridScalperMAToggle)        UI.gridScalperMAToggle.checked        = gridScalperMAEnabled;
  if (UI.gridScalperMAStrategySelect) UI.gridScalperMAStrategySelect.value = gridScalperMAStrategy;
  if (UI.gridScalperMAPeriodInput)   UI.gridScalperMAPeriodInput.value     = gridScalperMAPeriod;
  _updateGridScalperMAPeriodVisibility();
  if (UI.fvgStratToggle)         UI.fvgStratToggle.checked         = fvgStratEnabled;
  if (UI.mtfTopDownToggle)       UI.mtfTopDownToggle.checked       = mtfTopDownEnabled;
  if (UI.minConfluenceToggle)    UI.minConfluenceToggle.checked    = minConfluenceEnabled;
  if (UI.minConfluenceInput)     UI.minConfluenceInput.value       = minConfluenceValue;
  if (UI.doubleRetestToggle)     UI.doubleRetestToggle.checked     = doubleRetestEnabled;
  if (UI.confirmBarToggle)       UI.confirmBarToggle.checked       = confirmBarEnabled;
  if (UI.divergenceFilterToggle) UI.divergenceFilterToggle.checked = divergenceFilterEnabled;
  if (UI.adxHardGateToggle)      UI.adxHardGateToggle.checked      = adxHardGateEnabled;
  if (UI.adxMaxInput)            UI.adxMaxInput.value              = adxMaxThreshold;
  if (UI.breakoutDistToggle)     UI.breakoutDistToggle.checked     = breakoutDistEnabled;
  if (UI.breakoutDistInput)      UI.breakoutDistInput.value        = breakoutDistATR;
  if (UI.timeDecayToggle)        UI.timeDecayToggle.checked        = timeDecayEnabled;
  if (UI.timeDecayInput)         UI.timeDecayInput.value           = timeDecayCandles;
  if (UI.consecutiveDirToggle)   UI.consecutiveDirToggle.checked   = consecutiveDirEnabled;
  if (UI.vwapFilterToggle)       UI.vwapFilterToggle.checked       = vwapFilterEnabled;
  if (UI.stochCrossToggle)       UI.stochCrossToggle.checked       = stochCrossEnabled;
  if (UI.rangeSizeToggle)        UI.rangeSizeToggle.checked        = rangeSizeEnabled;
  if (UI.rangeSizeMinInput)      UI.rangeSizeMinInput.value        = rangeSizeMin;
  if (UI.rangeSizeMaxInput)      UI.rangeSizeMaxInput.value        = rangeSizeMax;
  if (UI.hhhlToggle)             UI.hhhlToggle.checked             = hhhlEnabled;
  if (UI.followThroughToggle)    UI.followThroughToggle.checked    = followThroughEnabled;
  if (UI.mtfStructureToggle)     UI.mtfStructureToggle.checked     = mtfStructureEnabled;

  /* Advanced parameter UI sync */
  if (UI.rangeDuration)  UI.rangeDuration.value  = RANGE_MINUTES;
  if (UI.touchTolerance) UI.touchTolerance.value = (LEVEL_TOUCH_TOLERANCE * 100).toFixed(0);
  if (UI.dojiRatio)      UI.dojiRatio.value      = (DOJI_BODY_RATIO * 100).toFixed(0);
  if (UI.lookbackPeriod) UI.lookbackPeriod.value = SWING_LOOKBACK_PERIOD;

  saveSettings();
  updateStateUI();
  updateRecommendedSettings();
  addLog("🔄 All settings reverted to defaults");
}

/* ================= SIGNAL STRENGTH GAUGE ================= */
function getSignalStrength(score) {
  if (score >= 13) return { label: "EXCELLENT", cls: "bull", pct: 100 };
  if (score >= 10) return { label: "STRONG", cls: "bull", pct: 80 };
  if (score >= 7)  return { label: "MODERATE", cls: "warning", pct: 60 };
  if (score >= 4)  return { label: "WEAK", cls: "bear", pct: 40 };
  return { label: "VERY WEAK", cls: "disabled", pct: 20 };
}

/* ================= STRATEGY 1: LIQUIDITY SWEEP (15m → 1m) ================= */
/**
 * Detect a liquidity sweep pattern:
 * 1. Take the high and low of a "reference" candle as the range.
 * 2. If the next candle breaks the range (high or low) but closes back inside → signal.
 *
 * On a 15m chart this identifies the sweep; the same logic works on 1m using
 * the 15m candle's high/low as the range for tighter entries.
 *
 * Returns null or { dir, entry, sl, tp, range, candleIdx, epoch, symbol, result }
 */
function detectLiquiditySweep() {
  if (!liquiditySweepEnabled) return null;

  /* One-at-a-time: skip detection while any signal is still PENDING */
  if (liquiditySweepHistory.some(s => s.result === "PENDING")) return null;

  const len = candles.length;
  if (len < 3) return null;

  const idx = len - 1;
  if (idx - lastLiquiditySweepIdx < LIQUIDITY_SWEEP_COOLDOWN) return null;

  /* Use candle at idx-1 as the "range" candle, idx as the sweep candle */
  const rangeCandle = candles[idx - 1];
  const sweepCandle = candles[idx];

  const rangeHigh = rangeCandle.high;
  const rangeLow  = rangeCandle.low;

  let dir = null;

  /* Bullish sweep: candle breaks below the range low but closes back inside */
  if (sweepCandle.low < rangeLow && sweepCandle.close >= rangeLow && sweepCandle.close <= rangeHigh) {
    dir = "BULL";
  }
  /* Bearish sweep: candle breaks above the range high but closes back inside */
  if (sweepCandle.high > rangeHigh && sweepCandle.close <= rangeHigh && sweepCandle.close >= rangeLow) {
    /* If both directions triggered, pick the one with more extreme wick */
    if (dir === "BULL") {
      const bearWick = sweepCandle.high - rangeHigh;
      const bullWick = rangeLow - sweepCandle.low;
      dir = bearWick > bullWick ? "BEAR" : "BULL";
    } else {
      dir = "BEAR";
    }
  }

  if (!dir) return null;

  /* ── EMA trend filter: reject signals that fight the short-term trend ── */
  if (emaFast.length >= idx && emaSlow.length >= idx) {
    const ef = emaFast[emaFast.length - 1];
    const es = emaSlow[emaSlow.length - 1];
    if (ef != null && es != null) {
      /* BULL signal requires EMA 8 ≥ EMA 21 (not in a clear downtrend) */
      if (dir === "BULL" && ef < es) return null;
      /* BEAR signal requires EMA 8 ≤ EMA 21 (not in a clear uptrend) */
      if (dir === "BEAR" && ef > es) return null;
    }
  }

  /* ── Compute entry / SL / TP with ATR-capped risk ── */
  const entry = sweepCandle.close;
  const rangeSize = rangeHigh - rangeLow;
  const atr = atrValue > 0 ? atrValue : rangeSize;
  const _profParams = getStrategyProfitParams();

  /* SL: pick the closer-to-entry reference (tighter stop) from range vs sweep candle */
  const slBuffer = atr * 0.1 * _profParams.slBufferMult;
  let sl;
  if (dir === "BULL") {
    sl = Math.max(rangeLow, sweepCandle.low) - slBuffer;
  } else {
    sl = Math.min(rangeHigh, sweepCandle.high) + slBuffer;
  }

  let risk = Math.abs(entry - sl);

  /* Cap SL distance to prevent runaway risk when entry drifts far from range */
  const maxRisk = atr * LIQUIDITY_SWEEP_MAX_SL_ATR;
  if (risk > maxRisk) {
    sl = dir === "BULL" ? entry - maxRisk : entry + maxRisk;
    risk = maxRisk;
  }

  /* Reject if risk is negligible (likely noise) */
  if (risk < atr * 0.05) return null;

  /* R:R target — profit-optimized per symbol type */
  const rrTarget = _profParams.rrLiquiditySweep;
  const tp = dir === "BULL" ? entry + risk * rrTarget : entry - risk * rrTarget;
  const rr = risk > 0 ? (Math.abs(tp - entry) / risk) : 0;

  return {
    dir, entry, sl, tp, rr,
    range: { high: rangeHigh, low: rangeLow },
    candleIdx: idx,
    epoch: sweepCandle.epoch,
    symbol: getActiveSymbol(),
    result: "PENDING",
    type: "liquidity_sweep"
  };
}

/**
 * Run the liquidity sweep scanner and handle alerting.
 */
function processLiquiditySweep() {
  const signal = detectLiquiditySweep();
  if (!signal) return;

  /* Min Confluence Gate — override any per-strategy hardcoded threshold when enabled */
  if (minConfluenceEnabled) {
    const confScore = computeConfluenceScore(signal.dir, signal.entry, signal.candleIdx);
    if (confScore < minConfluenceValue) {
      addLog(`⚠ Liquidity Sweep REJECTED — confluence ${confScore}/${minConfluenceValue} below minimum`);
      return;
    }
  }

  lastLiquiditySweepIdx = signal.candleIdx;

  signal._stratOutcomeSent = false;  /* track whether Telegram outcome was sent */
  signal._sentViaTelegram  = (telegramStrategyAutoSend && !_historicalProcessing); /* true when entry alert was Telegram-sent */
  liquiditySweepHistory.unshift(signal);
  if (liquiditySweepHistory.length > LIQUIDITY_SWEEP_MAX_HISTORY) liquiditySweepHistory.pop();

  /* Audio alert */
  playStrategyAlert(signal.dir);

  /* Log */
  const symbol = getActiveSymbol() || "--";
  addLog(`🌊 LIQUIDITY SWEEP ${signal.dir === "BULL" ? "▲ BUY" : "▼ SELL"} — ${symbol} @ ${fmtPrice(signal.entry, symbol)} | Range [${fmtPrice(signal.range.low, symbol)}–${fmtPrice(signal.range.high, symbol)}] | SL ${fmtPrice(signal.sl, symbol)} | TP ${fmtPrice(signal.tp, symbol)}`);

  showToast(
    `Liquidity Sweep ${signal.dir === "BULL" ? "▲ BUY" : "▼ SELL"}`,
    `${symbol} @ ${fmtPrice(signal.entry, symbol)} | SL: ${fmtPrice(signal.sl, symbol)} | TP: ${fmtPrice(signal.tp, symbol)}`,
    "trade", 10000
  );

  /* Browser notification */
  if (notificationsEnabled && "Notification" in window && Notification.permission === "granted") {
    const body = `🌊 ${signal.dir} Liquidity Sweep — ${symbol} @ ${fmtPrice(signal.entry, symbol)}\nSL: ${fmtPrice(signal.sl, symbol)} | TP: ${fmtPrice(signal.tp, symbol)}`;
    throttledNotification("IT Guru: Liquidity Sweep!", body);
  }

  /* Telegram alert (delayed to let canvas redraw first) */
  if (telegramStrategyAutoSend) {
    setTimeout(() => sendTelegramStrategyAlert(signal), CHART_RENDER_DELAY_MS);
  }

  renderStrategyAlerts();

  /* Auto-trade: place a Deriv multiplier contract for the liquidity sweep */
  if (autoTradeStrategyEnabled && autoTradeLiquiditySweep && !_historicalProcessing) {
    executeAutoTrade({ dir: signal.dir, entry: signal.entry, sl: signal.sl, tp: signal.tp, symbol: signal.symbol || symbol, source: "strategy", strategyName: "liquiditySweep" });
  }
}

/**
 * Monitor pending liquidity sweep signals for SL/TP outcome.
 */
function monitorLiquiditySweepOutcomes(candle) {
  if (!liquiditySweepEnabled) return;
  let changed = false;
  for (const s of liquiditySweepHistory) {
    if (s.result !== "PENDING") continue;
    const elapsed = (candles.length - 1) - s.candleIdx;
    /* Safety: resolve signals with corrupted/future candleIdx (e.g. after candle slicing) or timeout after 30 candles */
    if (elapsed < 0 || elapsed >= 30) { /* stale/corrupted index or timeout — SL not hit, signal expired */
      s.result = "EXPIRED";
      addLog(`🌊 Liquidity Sweep EXPIRED (timeout) — ${s.symbol || ""} @ ${fmt(candle.close, 4)} (SL not hit)`);
      changed = true; continue;
    }
    if (s.dir === "BULL") {
      /* Track 1R profit level and fire exit alert if price reverses to entry */
      if (_checkProfitExitAlert(s, candle, "Liquidity Sweep")) changed = true;
      const lsSlHit = candle.low <= s.sl, lsTpHit = candle.high >= s.tp;
      if (lsSlHit && lsTpHit) { s.result = resolveBothHit(s); addLog(`🌊 Liquidity Sweep ${s.result} — both levels hit, ${s.result === "WIN" ? "TP" : "SL"} closer`); changed = true; }
      else if (lsSlHit) { s.result = "LOSS"; addLog(`🌊 Liquidity Sweep LOSS — hit SL @ ${fmt(s.sl, 4)}`); changed = true; }
      else if (lsTpHit) { s.result = "WIN"; addLog(`🌊 Liquidity Sweep WIN — hit TP @ ${fmt(s.tp, 4)}`); changed = true; }
    } else {
      /* Track 1R profit level and fire exit alert if price reverses to entry */
      if (_checkProfitExitAlert(s, candle, "Liquidity Sweep")) changed = true;
      const lsSlHit = candle.high >= s.sl, lsTpHit = candle.low <= s.tp;
      if (lsSlHit && lsTpHit) { s.result = resolveBothHit(s); addLog(`🌊 Liquidity Sweep ${s.result} — both levels hit, ${s.result === "WIN" ? "TP" : "SL"} closer`); changed = true; }
      else if (lsSlHit) { s.result = "LOSS"; addLog(`🌊 Liquidity Sweep LOSS — hit SL @ ${fmt(s.sl, 4)}`); changed = true; }
      else if (lsTpHit) { s.result = "WIN"; addLog(`🌊 Liquidity Sweep WIN — hit TP @ ${fmt(s.tp, 4)}`); changed = true; }
    }
  }
  if (changed) {
    renderStrategyAlerts();
    /* Send Telegram outcome for each newly resolved signal.
       Gated on _sentViaTelegram so historical signals do not generate outcome alerts. */
    for (const s of liquiditySweepHistory) {
      if ((s.result === "WIN" || s.result === "LOSS" || s.result === "EXPIRED") && !s._stratOutcomeSent && s._sentViaTelegram === true) {
        sendStrategyOutcomeTelegram(s);
      }
    }
    /* One-at-a-time: allow the next trade after the cooldown period elapses.
       Previously this was set to -999, which bypassed the cooldown entirely and
       caused rapid-fire re-entry loops when signals kept hitting SL. */
    lastLiquiditySweepIdx = candles.length - 1;
    addLog("🌊 Range signal resolved — scanning for next trade…");
  }
}

/* ================= STRATEGY 2: STOP LOSS HUNT ================= */
/**
 * Find key support/resistance levels from recent candles.
 * A key level is a price zone touched at least SLH_KEY_LEVEL_TOUCHES times.
 * Returns array of { level, touches, type: "support"|"resistance" }.
 */
function findKeyLevels() {
  const len = candles.length;
  const lookback = Math.min(SLH_LEVEL_LOOKBACK, len);
  if (lookback < 5) return [];

  /* Collect swing highs and lows */
  const pivots = [];
  for (let i = len - lookback; i < len; i++) {
    const c = candles[i];
    pivots.push({ price: c.high, type: "resistance" });
    pivots.push({ price: c.low,  type: "support" });
  }

  /* Cluster pivots into levels */
  const levels = [];
  const tolerance = candles[len - 1].close * SLH_LEVEL_TOLERANCE_PCT;

  for (const p of pivots) {
    let found = false;
    for (const l of levels) {
      if (Math.abs(p.price - l.level) <= tolerance) {
        l.touches++;
        l.level = (l.level * (l.touches - 1) + p.price) / l.touches; /* running average */
        if (p.type === "support") l.supportCount++;
        else l.resistanceCount++;
        found = true;
        break;
      }
    }
    if (!found) {
      levels.push({
        level: p.price,
        touches: 1,
        supportCount: p.type === "support" ? 1 : 0,
        resistanceCount: p.type === "resistance" ? 1 : 0
      });
    }
  }

  /* Only return levels with enough touches */
  return levels
    .filter(l => l.touches >= SLH_KEY_LEVEL_TOUCHES)
    .map(l => ({
      level: l.level,
      touches: l.touches,
      type: l.supportCount >= l.resistanceCount ? "support" : "resistance"
    }))
    .sort((a, b) => b.touches - a.touches);
}

/**
 * Detect a stop loss hunt pattern:
 * 1. Identify a key S/R level tested multiple times.
 * 2. Price breaks below support (or above resistance) but closes back inside.
 * 3. Entry at close of the stop hunt candle.
 *
 * Returns null or { dir, entry, sl, tp, level, candleIdx, epoch, symbol, result }
 */
function detectStopLossHunt() {
  if (!stopLossHuntEnabled) return null;
  const len = candles.length;
  if (len < 5) return null;

  const idx = len - 1;
  if (idx - lastStopLossHuntIdx < STOP_LOSS_HUNT_COOLDOWN) return null;

  const c = candles[idx];
  const keyLevels = findKeyLevels();
  if (keyLevels.length === 0) return null;

  const atr = atrValue > 0 ? atrValue : (c.high - c.low);
  const tolerance = atr * 0.2;
  const _profParams = getStrategyProfitParams();

  for (const kl of keyLevels) {
    /* Support hunt: price breaks below support but closes back above */
    if (kl.type === "support") {
      if (c.low < kl.level - tolerance && c.close > kl.level) {
        const entry = c.close;
        const sl = c.low - tolerance * 0.5 * _profParams.slBufferMult;
        const risk = Math.abs(entry - sl);
        const tp = entry + risk * _profParams.rrStopLossHunt;

        return {
          dir: "BULL", entry, sl, tp,
          rr: risk > 0 ? Math.abs(tp - entry) / risk : 0,
          level: kl,
          candleIdx: idx, epoch: c.epoch,
          symbol: getActiveSymbol(),
          result: "PENDING",
          type: "stop_loss_hunt"
        };
      }
    }

    /* Resistance hunt: price breaks above resistance but closes back below */
    if (kl.type === "resistance") {
      if (c.high > kl.level + tolerance && c.close < kl.level) {
        const entry = c.close;
        const sl = c.high + tolerance * 0.5 * _profParams.slBufferMult;
        const risk = Math.abs(entry - sl);
        const tp = entry - risk * _profParams.rrStopLossHunt;

        return {
          dir: "BEAR", entry, sl, tp,
          rr: risk > 0 ? Math.abs(tp - entry) / risk : 0,
          level: kl,
          candleIdx: idx, epoch: c.epoch,
          symbol: getActiveSymbol(),
          result: "PENDING",
          type: "stop_loss_hunt"
        };
      }
    }
  }

  return null;
}

/**
 * Run the stop loss hunt scanner and handle alerting.
 */
function processStopLossHunt() {
  const signal = detectStopLossHunt();
  if (!signal) return;

  /* Min Confluence Gate — override any per-strategy hardcoded threshold when enabled */
  if (minConfluenceEnabled) {
    const confScore = computeConfluenceScore(signal.dir, signal.entry, signal.candleIdx);
    if (confScore < minConfluenceValue) {
      addLog(`⚠ Stop Loss Hunt REJECTED — confluence ${confScore}/${minConfluenceValue} below minimum`);
      return;
    }
  }

  lastStopLossHuntIdx = signal.candleIdx;

  /* Check for "stop hunt of stop hunters" — re-entry if previous was stopped out */
  const levelTol = signal.level.level * SLH_LEVEL_TOLERANCE_PCT;
  const prevStopped = stopLossHuntHistory.find(s => s.result === "LOSS" && Math.abs(s.level.level - signal.level.level) <= levelTol);
  const reEntry = !!prevStopped;

  signal._stratOutcomeSent = false;  /* track whether Telegram outcome was sent */
  signal._sentViaTelegram  = (telegramStrategyAutoSend && !_historicalProcessing); /* true when entry alert was Telegram-sent */
  stopLossHuntHistory.unshift(signal);
  if (stopLossHuntHistory.length > STOP_LOSS_HUNT_MAX_HISTORY) stopLossHuntHistory.pop();

  playStrategyAlert(signal.dir);

  const symbol = getActiveSymbol() || "--";
  const reLabel = reEntry ? " (RE-ENTRY — stop hunt of stop hunters)" : "";
  addLog(`🎯 STOP LOSS HUNT ${signal.dir === "BULL" ? "▲ BUY" : "▼ SELL"}${reLabel} — ${symbol} @ ${fmtPrice(signal.entry, symbol)} | Level ${fmtPrice(signal.level.level, symbol)} (${signal.level.touches} touches) | SL ${fmtPrice(signal.sl, symbol)} | TP ${fmtPrice(signal.tp, symbol)}`);

  showToast(
    `Stop Loss Hunt ${signal.dir === "BULL" ? "▲ BUY" : "▼ SELL"}${reLabel}`,
    `${symbol} @ ${fmtPrice(signal.entry, symbol)} | SL: ${fmtPrice(signal.sl, symbol)} | TP: ${fmtPrice(signal.tp, symbol)}`,
    "trade", 10000
  );

  if (notificationsEnabled && "Notification" in window && Notification.permission === "granted") {
    const body = `🎯 ${signal.dir} Stop Loss Hunt${reLabel} — ${symbol} @ ${fmtPrice(signal.entry, symbol)}\nLevel: ${fmtPrice(signal.level.level, symbol)} | SL: ${fmtPrice(signal.sl, symbol)} | TP: ${fmtPrice(signal.tp, symbol)}`;
    throttledNotification("IT Guru: Stop Loss Hunt!", body);
  }

  /* Telegram alert (delayed to let canvas redraw first) */
  if (telegramStrategyAutoSend) {
    setTimeout(() => sendTelegramStrategyAlert(signal), CHART_RENDER_DELAY_MS);
  }

  renderStrategyAlerts();

  /* Auto-trade: place a Deriv multiplier contract for the stop loss hunt */
  if (autoTradeStrategyEnabled && autoTradeStopLossHunt && !_historicalProcessing) {
    executeAutoTrade({ dir: signal.dir, entry: signal.entry, sl: signal.sl, tp: signal.tp, symbol: signal.symbol || symbol, source: "strategy", strategyName: "stopLossHunt" });
  }
}

/**
 * Monitor pending stop loss hunt signals for SL/TP outcome.
 */
function monitorStopLossHuntOutcomes(candle) {
  if (!stopLossHuntEnabled) return;
  let changed = false;
  for (const s of stopLossHuntHistory) {
    if (s.result !== "PENDING") continue;
    const elapsed = (candles.length - 1) - s.candleIdx;
    if (elapsed < 0 || elapsed >= 30) {
      s.result = "EXPIRED";
      addLog(`🎯 Stop Loss Hunt EXPIRED (timeout) — ${s.symbol || ""} @ ${fmt(candle.close, 4)} (SL not hit)`);
      changed = true; continue;
    }
    if (s.dir === "BULL") {
      /* Track 1R profit level and fire exit alert if price reverses to entry */
      if (_checkProfitExitAlert(s, candle, "Stop Loss Hunt")) changed = true;
      const slhSlHit = candle.low <= s.sl, slhTpHit = candle.high >= s.tp;
      if (slhSlHit && slhTpHit) { s.result = resolveBothHit(s); addLog(`🎯 Stop Loss Hunt ${s.result} — both levels hit, ${s.result === "WIN" ? "TP" : "SL"} closer`); changed = true; }
      else if (slhSlHit) { s.result = "LOSS"; addLog(`🎯 Stop Loss Hunt LOSS — hit SL @ ${fmt(s.sl, 4)}`); changed = true; }
      else if (slhTpHit) { s.result = "WIN"; addLog(`🎯 Stop Loss Hunt WIN — hit TP @ ${fmt(s.tp, 4)}`); changed = true; }
    } else {
      /* Track 1R profit level and fire exit alert if price reverses to entry */
      if (_checkProfitExitAlert(s, candle, "Stop Loss Hunt")) changed = true;
      const slhSlHit = candle.high >= s.sl, slhTpHit = candle.low <= s.tp;
      if (slhSlHit && slhTpHit) { s.result = resolveBothHit(s); addLog(`🎯 Stop Loss Hunt ${s.result} — both levels hit, ${s.result === "WIN" ? "TP" : "SL"} closer`); changed = true; }
      else if (slhSlHit) { s.result = "LOSS"; addLog(`🎯 Stop Loss Hunt LOSS — hit SL @ ${fmt(s.sl, 4)}`); changed = true; }
      else if (slhTpHit) { s.result = "WIN"; addLog(`🎯 Stop Loss Hunt WIN — hit TP @ ${fmt(s.tp, 4)}`); changed = true; }
    }
  }
  if (changed) {
    renderStrategyAlerts();
    /* Send Telegram outcome for each newly resolved signal.
       Gated on _sentViaTelegram so historical signals do not generate outcome alerts. */
    for (const s of stopLossHuntHistory) {
      if ((s.result === "WIN" || s.result === "LOSS" || s.result === "EXPIRED") && !s._stratOutcomeSent && s._sentViaTelegram === true) {
        sendStrategyOutcomeTelegram(s);
      }
    }
  }
}

/* ================= STRATEGY 3: FAILED PIN BAR (Fear/Greed) ================= */
/**
 * Detect the market state: consecutive strong bearish candles = fear,
 * consecutive strong bullish candles = greed.
 * Returns "fear" | "greed" | null.
 */
function detectFearGreedState(idx) {
  if (idx < FPB_CONSECUTIVE_CANDLES) return null;

  let bullCount = 0;
  let bearCount = 0;

  for (let i = idx - FPB_CONSECUTIVE_CANDLES; i < idx; i++) {
    const c = candles[i];
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low;
    if (range <= 0) continue;

    const bodyRatio = body / range;
    if (bodyRatio < FPB_BODY_RATIO_MIN) continue; /* not a strong candle */

    if (c.close > c.open) bullCount++;
    else bearCount++;
  }

  if (bearCount >= FPB_CONSECUTIVE_CANDLES) return "fear";
  if (bullCount >= FPB_CONSECUTIVE_CANDLES) return "greed";
  return null;
}

/**
 * Detect a failed pin bar pattern in fear/greed:
 * 1. Identify market state (fear = consecutive bearish, greed = consecutive bullish).
 * 2. Spot a pin bar against the dominant emotion on the current candle set.
 * 3. Wait for the pin bar to be broken (next candle breaks the pin bar).
 * 4. Enter at the close of the candle that breaks the pin bar.
 *
 * Returns null or { dir, entry, sl, tp, state, candleIdx, epoch, symbol, result }
 */
function detectFailedPinBar() {
  if (!failedPinBarEnabled) return null;
  const len = candles.length;
  if (len < FPB_CONSECUTIVE_CANDLES + 2) return null;

  const idx = len - 1;
  if (idx - lastFailedPinBarIdx < FAILED_PIN_BAR_COOLDOWN) return null;

  const breakCandle = candles[idx];       /* candle that breaks the pin bar */
  const pinBarCandle = candles[idx - 1];  /* the pin bar itself */

  /* Check market state BEFORE the pin bar (using candles before it) */
  const state = detectFearGreedState(idx - 1);
  if (!state) return null;

  /* Detect pin bar against the dominant emotion */
  const pinBody = Math.abs(pinBarCandle.close - pinBarCandle.open);
  const pinRange = pinBarCandle.high - pinBarCandle.low;
  if (pinRange <= 0 || pinBody <= 0) return null;
  const pinBodyRatio = pinBody / pinRange;

  /* Pin bar should have small body relative to range */
  if (pinBodyRatio > 0.4) return null;

  const upperWick = pinBarCandle.high - Math.max(pinBarCandle.open, pinBarCandle.close);
  const lowerWick = Math.min(pinBarCandle.open, pinBarCandle.close) - pinBarCandle.low;

  let pinDir = null;

  if (state === "fear") {
    /* In fear (bearish), look for bullish pin bar (long lower wick) */
    if (lowerWick > pinBody * 2 && lowerWick > upperWick * 1.5) {
      pinDir = "BULL"; /* bullish pin bar against fear */
    }
  } else if (state === "greed") {
    /* In greed (bullish), look for bearish pin bar (long upper wick) */
    if (upperWick > pinBody * 2 && upperWick > lowerWick * 1.5) {
      pinDir = "BEAR"; /* bearish pin bar against greed */
    }
  }

  if (!pinDir) return null;

  /* Now check if the break candle "fails" the pin bar by breaking it
     in the direction of the original momentum (continuing fear/greed) */
  let pinBarBroken = false;
  let dir = null;

  if (pinDir === "BULL" && state === "fear") {
    /* Pin bar was bullish (against fear). Failure = break below the pin bar low.
       Trade direction = BEAR (momentum continues) → BUT the strategy says
       "enter at the close of the candle that breaks the pin bar" which means
       we enter in the direction of the break. Actually the strategy says the
       pin bar FAILS, meaning price continues in the original fear direction.
       So we enter BEAR (with momentum). */
    if (breakCandle.close < pinBarCandle.low) {
      pinBarBroken = true;
      dir = "BEAR"; /* momentum continues down */
    }
  } else if (pinDir === "BEAR" && state === "greed") {
    /* Pin bar was bearish (against greed). Failure = break above the pin bar high.
       Entry = BULL (momentum continues up). */
    if (breakCandle.close > pinBarCandle.high) {
      pinBarBroken = true;
      dir = "BULL"; /* momentum continues up */
    }
  }

  if (!pinBarBroken || !dir) return null;

  /* Compute entry / SL / TP */
  const entry = breakCandle.close;
  const atr = atrValue > 0 ? atrValue : pinRange;
  const _profParams = getStrategyProfitParams();

  /* SL: beyond the pin bar (the opposite extreme) */
  const slBuffer = atr * 0.1 * _profParams.slBufferMult;
  const sl = dir === "BULL" ? pinBarCandle.low - slBuffer : pinBarCandle.high + slBuffer;
  const risk = Math.abs(entry - sl);
  /* TP: profit-optimized R:R (momentum direction for fast pips) */
  const tp = dir === "BULL" ? entry + risk * _profParams.rrFailedPinBar : entry - risk * _profParams.rrFailedPinBar;
  const rr = risk > 0 ? Math.abs(tp - entry) / risk : 0;

  return {
    dir, entry, sl, tp, rr, state,
    pinBarIdx: idx - 1,
    candleIdx: idx,
    epoch: breakCandle.epoch,
    symbol: getActiveSymbol(),
    result: "PENDING",
    type: "failed_pin_bar"
  };
}

/**
 * Run the failed pin bar scanner and handle alerting.
 */
function processFailedPinBar() {
  /* Keep one active failed-pin-bar setup at a time to avoid overlapping
     trades while the current setup is still pending outcome (SL/TP). */
  if (failedPinBarHistory.some(s => s.result === "PENDING")) return;

  const signal = detectFailedPinBar();
  if (!signal) return;

  /* Min Confluence Gate — override any per-strategy hardcoded threshold when enabled */
  if (minConfluenceEnabled) {
    const confScore = computeConfluenceScore(signal.dir, signal.entry, signal.candleIdx);
    if (confScore < minConfluenceValue) {
      addLog(`⚠ Failed Pin Bar REJECTED — confluence ${confScore}/${minConfluenceValue} below minimum`);
      return;
    }
  }

  lastFailedPinBarIdx = signal.candleIdx;

  signal._stratOutcomeSent = false;  /* track whether Telegram outcome was sent */
  signal._sentViaTelegram  = (telegramStrategyAutoSend && !_historicalProcessing); /* true when entry alert was Telegram-sent */
  failedPinBarHistory.unshift(signal);
  if (failedPinBarHistory.length > FAILED_PIN_BAR_MAX_HISTORY) failedPinBarHistory.pop();

  playStrategyAlert(signal.dir);

  const symbol = getActiveSymbol() || "--";
  const stateEmoji = signal.state === "fear" ? "😱" : "🤑";
  addLog(`${stateEmoji} FAILED PIN BAR ${signal.dir === "BULL" ? "▲ BUY" : "▼ SELL"} — ${symbol} @ ${fmtPrice(signal.entry, symbol)} | State: ${signal.state.toUpperCase()} | SL ${fmtPrice(signal.sl, symbol)} | TP ${fmtPrice(signal.tp, symbol)}`);

  showToast(
    `Failed Pin Bar ${signal.dir === "BULL" ? "▲ BUY" : "▼ SELL"}`,
    `${symbol} @ ${fmtPrice(signal.entry, symbol)} | ${signal.state.toUpperCase()} | SL: ${fmtPrice(signal.sl, symbol)} | TP: ${fmtPrice(signal.tp, symbol)}`,
    "trade", 10000
  );

  if (notificationsEnabled && "Notification" in window && Notification.permission === "granted") {
    const body = `${stateEmoji} ${signal.dir} Failed Pin Bar — ${symbol} @ ${fmtPrice(signal.entry, symbol)}\nState: ${signal.state.toUpperCase()} | SL: ${fmtPrice(signal.sl, symbol)} | TP: ${fmtPrice(signal.tp, symbol)}`;
    throttledNotification("IT Guru: Failed Pin Bar!", body);
  }

  /* Telegram alert (delayed to let canvas redraw first) */
  if (telegramStrategyAutoSend) {
    setTimeout(() => sendTelegramStrategyAlert(signal), CHART_RENDER_DELAY_MS);
  }

  renderStrategyAlerts();

  /* Auto-trade: place a Deriv multiplier contract for the failed pin bar */
  if (autoTradeStrategyEnabled && autoTradeFailedPinBar && !_historicalProcessing) {
    executeAutoTrade({ dir: signal.dir, entry: signal.entry, sl: signal.sl, tp: signal.tp, symbol: signal.symbol || symbol, source: "strategy", strategyName: "failedPinBar" });
  }
}

/**
 * Monitor pending failed pin bar signals for SL/TP outcome.
 */
function monitorFailedPinBarOutcomes(candle) {
  if (!failedPinBarEnabled) return;
  let changed = false;
  for (const s of failedPinBarHistory) {
    if (s.result !== "PENDING") continue;
    const elapsed = (candles.length - 1) - s.candleIdx;
    if (elapsed < 0 || elapsed >= 20) { /* shorter timeout — scalp-style; also resolves stale indices */
      s.result = "EXPIRED";
      addLog(`${s.state === "fear" ? "😱" : "🤑"} Failed Pin Bar EXPIRED (timeout) — ${s.symbol || ""} @ ${fmt(candle.close, 4)} (SL not hit)`);
      changed = true; continue;
    }
    if (s.dir === "BULL") {
      const em = s.state === "fear" ? "😱" : "🤑";
      /* Track 1R profit level and fire exit alert if price reverses to entry */
      if (_checkProfitExitAlert(s, candle, "Failed Pin Bar")) changed = true;
      const fpbSlHit = candle.low <= s.sl, fpbTpHit = candle.high >= s.tp;
      if (fpbSlHit && fpbTpHit) { s.result = resolveBothHit(s); addLog(`${em} Failed Pin Bar ${s.result} — both levels hit, ${s.result === "WIN" ? "TP" : "SL"} closer`); changed = true; }
      else if (fpbSlHit) { s.result = "LOSS"; addLog(`${em} Failed Pin Bar LOSS — hit SL @ ${fmt(s.sl, 4)}`); changed = true; }
      else if (fpbTpHit) { s.result = "WIN"; addLog(`${em} Failed Pin Bar WIN — hit TP @ ${fmt(s.tp, 4)}`); changed = true; }
    } else {
      const em = s.state === "fear" ? "😱" : "🤑";
      /* Track 1R profit level and fire exit alert if price reverses to entry */
      if (_checkProfitExitAlert(s, candle, "Failed Pin Bar")) changed = true;
      const fpbSlHit = candle.high >= s.sl, fpbTpHit = candle.low <= s.tp;
      if (fpbSlHit && fpbTpHit) { s.result = resolveBothHit(s); addLog(`${em} Failed Pin Bar ${s.result} — both levels hit, ${s.result === "WIN" ? "TP" : "SL"} closer`); changed = true; }
      else if (fpbSlHit) { s.result = "LOSS"; addLog(`${em} Failed Pin Bar LOSS — hit SL @ ${fmt(s.sl, 4)}`); changed = true; }
      else if (fpbTpHit) { s.result = "WIN"; addLog(`${em} Failed Pin Bar WIN — hit TP @ ${fmt(s.tp, 4)}`); changed = true; }
    }
  }
  if (changed) {
    renderStrategyAlerts();
    /* Send Telegram outcome for each newly resolved signal.
       Gated on _sentViaTelegram so historical signals do not generate outcome alerts. */
    for (const s of failedPinBarHistory) {
      if ((s.result === "WIN" || s.result === "LOSS" || s.result === "EXPIRED") && !s._stratOutcomeSent && s._sentViaTelegram === true) {
        sendStrategyOutcomeTelegram(s);
      }
    }
  }
}

/* ================= STRATEGY 4: FIB GOLDEN ZONE SCALP ================= */
/**
 * Detect a Fibonacci Golden Zone scalp setup on the 1-minute chart.
 *
 * Steps:
 *   1. Identify a micro-trend using recent swing points:
 *      - Uptrend: at least 2 consecutive higher lows
 *      - Downtrend: at least 2 consecutive lower highs
 *   2. Detect a break of structure (BOS):
 *      - Uptrend BOS: price breaks above the most recent swing high
 *      - Downtrend BOS: price breaks below the most recent swing low
 *   3. Draw Fibonacci retracement from the swing that started the impulse
 *      to the BOS extreme.
 *   4. Wait for price to retrace into the 0.5–0.618 zone (Golden Zone).
 *   5. Enter in the trend direction.
 *   6. TP at the previous swing low (downtrend) or swing high (uptrend).
 *   7. SL just beyond the 0.786 Fibonacci level.
 *
 * Returns null or { dir, entry, sl, tp, rr, fibHigh, fibLow, goldenHigh,
 *                    goldenLow, candleIdx, epoch, symbol, result, type }
 */
function detectFibScalp() {
  if (!fibScalpEnabled) return null;

  /* One-at-a-time: skip detection while any signal is still PENDING */
  if (fibScalpHistory.some(s => s.result === "PENDING")) return null;

  const len = candles.length;
  if (len < 10) return null;

  const idx = len - 1;
  if (idx - lastFibScalpIdx < FIB_SCALP_COOLDOWN) return null;

  const c = candles[idx];

  /* --- Collect recent swing highs and swing lows --- */
  const lookbackStart = Math.max(0, idx - FIB_SCALP_SWING_LOOKBACK);
  const swingHighs = [];  /* { idx, price } most recent first */
  const swingLows  = [];

  for (let i = idx - 1; i >= lookbackStart; i--) {
    if (isTrueSwingHigh(i)) swingHighs.push({ idx: i, price: candles[i].high });
    if (isTrueSwingLow(i))  swingLows.push({ idx: i, price: candles[i].low });
  }

  /* Need enough swing points for structure analysis */
  if (swingHighs.length < 2 || swingLows.length < 2) return null;

  /* --- Detect micro-trend using FIB_SCALP_TREND_SWINGS consecutive points --- */
  let trendDir = null;

  /* Uptrend: consecutive higher lows */
  if (swingLows.length >= FIB_SCALP_TREND_SWINGS) {
    let isUptrend = true;
    for (let i = 0; i < FIB_SCALP_TREND_SWINGS - 1; i++) {
      if (swingLows[i].price <= swingLows[i + 1].price) { isUptrend = false; break; }
    }
    if (isUptrend) trendDir = "BULL";
  }
  /* Downtrend: consecutive lower highs */
  if (swingHighs.length >= FIB_SCALP_TREND_SWINGS) {
    let isDowntrend = true;
    for (let i = 0; i < FIB_SCALP_TREND_SWINGS - 1; i++) {
      if (swingHighs[i].price >= swingHighs[i + 1].price) { isDowntrend = false; break; }
    }
    if (isDowntrend) {
      /* If both directions qualify, pick the one with the most recent swing */
      if (trendDir === "BULL") {
        trendDir = swingHighs[0].idx > swingLows[0].idx ? "BEAR" : "BULL";
      } else {
        trendDir = "BEAR";
      }
    }
  }

  if (!trendDir) return null;

  /* --- Detect break of structure (BOS) --- */
  let fibLow, fibHigh, bosConfirmed = false;
  let targetPrice;  /* TP target: previous swing low (bear) or swing high (bull) */

  if (trendDir === "BULL") {
    /* BOS: current or recent candle closed above the most recent swing high */
    const recentSH = swingHighs[0];
    /* The impulse runs from the most recent swing low up to the BOS level */
    const recentSL = swingLows[0];

    /* BOS must be recent (within last few candles) */
    let bosCandle = null;
    for (let i = idx; i >= Math.max(recentSH.idx + 1, idx - 5); i--) {
      if (candles[i].close > recentSH.price) { bosCandle = candles[i]; break; }
    }
    if (!bosCandle) return null;

    bosConfirmed = true;
    /* Fib from the swing low (start of impulse) to the BOS high */
    fibLow  = recentSL.price;
    fibHigh = bosCandle.high;

    /* TP = the swing high before the most recent one (prior resistance), or the BOS high */
    targetPrice = recentSH.price;
    if (swingHighs.length >= 2) {
      /* Use the prior swing high (the one before the BOS level), if higher */
      const priorSH = swingHighs[1].price;
      if (priorSH > fibHigh) targetPrice = priorSH;
      else targetPrice = fibHigh;
    }
  } else {
    /* BEAR: BOS below the most recent swing low */
    const recentSL = swingLows[0];
    const recentSH = swingHighs[0];

    let bosCandle = null;
    for (let i = idx; i >= Math.max(recentSL.idx + 1, idx - 5); i--) {
      if (candles[i].close < recentSL.price) { bosCandle = candles[i]; break; }
    }
    if (!bosCandle) return null;

    bosConfirmed = true;
    /* Fib from the swing high (start of impulse) down to the BOS low */
    fibHigh = recentSH.price;
    fibLow  = bosCandle.low;

    /* TP = the prior swing low (the one before the BOS level), or the BOS low */
    targetPrice = recentSL.price;
    if (swingLows.length >= 2) {
      const priorSL = swingLows[1].price;
      if (priorSL < fibLow) targetPrice = priorSL;
      else targetPrice = fibLow;
    }
  }

  if (!bosConfirmed) return null;

  /* --- Calculate Golden Zone (0.5 – 0.618 retracement) --- */
  const fibRange = fibHigh - fibLow;
  if (fibRange <= 0) return null;

  let goldenHigh, goldenLow;
  if (trendDir === "BULL") {
    /* Retracement pulls back down from the high */
    goldenHigh = fibHigh - fibRange * 0.5;
    goldenLow  = fibHigh - fibRange * 0.618;
  } else {
    /* Retracement pulls back up from the low */
    goldenLow  = fibLow + fibRange * 0.5;
    goldenHigh = fibLow + fibRange * 0.618;
  }

  /* --- Check if current price is in the Golden Zone --- */
  const price = c.close;
  const inGoldenZone = price >= Math.min(goldenLow, goldenHigh)
                    && price <= Math.max(goldenLow, goldenHigh);

  if (!inGoldenZone) return null;

  /* --- Compute entry / SL / TP --- */
  const entry = price;
  let sl, tp;

  if (trendDir === "BULL") {
    /* SL just below the 0.786 retracement (beyond the golden zone for protection) */
    sl = fibHigh - fibRange * 0.786;
    /* Add a small ATR buffer for safety */
    if (atrValue > 0) sl -= atrValue * 0.15;
    /* TP at the previous BOS high or next swing high */
    tp = targetPrice;
    /* Ensure TP is above entry */
    if (tp <= entry) tp = entry + fibRange * 0.5;
  } else {
    /* SL just above the 0.786 retracement */
    sl = fibLow + fibRange * 0.786;
    if (atrValue > 0) sl += atrValue * 0.15;
    /* TP at the previous BOS low or next swing low */
    tp = targetPrice;
    /* Ensure TP is below entry */
    if (tp >= entry) tp = entry - fibRange * 0.5;
  }

  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  const rr = risk > 0 ? reward / risk : 0;

  /* Reject if R:R is too low */
  if (rr < 1.0) return null;

  return {
    dir: trendDir,
    entry, sl, tp, rr,
    fibHigh, fibLow,
    goldenHigh, goldenLow,
    candleIdx: idx,
    epoch: c.epoch,
    symbol: getActiveSymbol(),
    result: "PENDING",
    type: "fib_scalp"
  };
}

/**
 * Run the Fib Golden Zone scalp scanner and handle alerting.
 */
function processFibScalp() {
  const signal = detectFibScalp();
  if (!signal) return;

  /* Min Confluence Gate — override any per-strategy hardcoded threshold when enabled */
  if (minConfluenceEnabled) {
    const confScore = computeConfluenceScore(signal.dir, signal.entry, signal.candleIdx);
    if (confScore < minConfluenceValue) {
      addLog(`⚠ Fib Golden Zone REJECTED — confluence ${confScore}/${minConfluenceValue} below minimum`);
      return;
    }
  }

  lastFibScalpIdx = signal.candleIdx;

  signal._stratOutcomeSent = false;
  signal._sentViaTelegram  = (telegramStrategyAutoSend && !_historicalProcessing); /* true when entry alert was Telegram-sent */
  fibScalpHistory.unshift(signal);
  if (fibScalpHistory.length > FIB_SCALP_MAX_HISTORY) fibScalpHistory.pop();

  /* Audio alert */
  playStrategyAlert(signal.dir);

  /* Log */
  const symbol = getActiveSymbol() || "--";
  addLog(`📐 FIB GOLDEN ZONE ${signal.dir === "BULL" ? "▲ BUY" : "▼ SELL"} — ${symbol} @ ${fmtPrice(signal.entry, symbol)} | Golden Zone [${fmtPrice(signal.goldenLow, symbol)}–${fmtPrice(signal.goldenHigh, symbol)}] | SL ${fmtPrice(signal.sl, symbol)} | TP ${fmtPrice(signal.tp, symbol)} | R:R 1:${fmt(signal.rr, 1)}`);

  showToast(
    `Fib Golden Zone ${signal.dir === "BULL" ? "▲ BUY" : "▼ SELL"}`,
    `${symbol} @ ${fmtPrice(signal.entry, symbol)} | SL: ${fmtPrice(signal.sl, symbol)} | TP: ${fmtPrice(signal.tp, symbol)} | R:R 1:${fmt(signal.rr, 1)}`,
    "trade", 10000
  );

  /* Browser notification */
  if (notificationsEnabled && "Notification" in window && Notification.permission === "granted") {
    const body = `📐 ${signal.dir} Fib Golden Zone — ${symbol} @ ${fmtPrice(signal.entry, symbol)}\nGolden Zone: ${fmtPrice(signal.goldenLow, symbol)}–${fmtPrice(signal.goldenHigh, symbol)}\nSL: ${fmtPrice(signal.sl, symbol)} | TP: ${fmtPrice(signal.tp, symbol)}`;
    throttledNotification("IT Guru: Fib Golden Zone Scalp!", body);
  }

  /* Telegram alert */
  if (telegramStrategyAutoSend) {
    setTimeout(() => sendTelegramStrategyAlert(signal), CHART_RENDER_DELAY_MS);
  }

  renderStrategyAlerts();

  /* Auto-trade: place a Deriv multiplier contract for the fib scalp */
  if (autoTradeStrategyEnabled && autoTradeFibScalp && !_historicalProcessing) {
    executeAutoTrade({ dir: signal.dir, entry: signal.entry, sl: signal.sl, tp: signal.tp, symbol: signal.symbol || symbol, source: "strategy", strategyName: "fibScalp" });
  }
}

/**
 * Monitor pending Fib Golden Zone scalp signals for SL/TP outcome.
 */
function monitorFibScalpOutcomes(candle) {
  if (!fibScalpEnabled) return;
  let changed = false;
  for (const s of fibScalpHistory) {
    if (s.result !== "PENDING") continue;
    const elapsed = (candles.length - 1) - s.candleIdx;

    /* Timeout after FIB_SCALP_MAX_CANDLES or stale index */
    if (elapsed < 0 || elapsed >= FIB_SCALP_MAX_CANDLES) {
      s.result = "EXPIRED";
      addLog(`📐 Fib Golden Zone EXPIRED (timeout ${FIB_SCALP_MAX_CANDLES} candles) — ${s.symbol || ""} @ ${fmt(candle.close, 4)} (SL not hit)`);
      changed = true; continue;
    }

    /* Check SL / TP */
    if (s.dir === "BULL") {
      /* Track 1R profit level and fire exit alert if price reverses to entry */
      if (_checkProfitExitAlert(s, candle, "Fib Golden Zone")) changed = true;
      const fibSlHit = candle.low <= s.sl, fibTpHit = candle.high >= s.tp;
      if (fibSlHit && fibTpHit) { s.result = resolveBothHit(s); addLog(`📐 Fib Golden Zone ${s.result} — both levels hit, ${s.result === "WIN" ? "TP" : "SL"} closer`); changed = true; }
      else if (fibSlHit) { s.result = "LOSS"; addLog(`📐 Fib Golden Zone LOSS — hit SL @ ${fmt(s.sl, 4)}`); changed = true; }
      else if (fibTpHit) { s.result = "WIN"; addLog(`📐 Fib Golden Zone WIN — hit TP @ ${fmt(s.tp, 4)}`); changed = true; }
    } else {
      /* Track 1R profit level and fire exit alert if price reverses to entry */
      if (_checkProfitExitAlert(s, candle, "Fib Golden Zone")) changed = true;
      const fibSlHit = candle.high >= s.sl, fibTpHit = candle.low <= s.tp;
      if (fibSlHit && fibTpHit) { s.result = resolveBothHit(s); addLog(`📐 Fib Golden Zone ${s.result} — both levels hit, ${s.result === "WIN" ? "TP" : "SL"} closer`); changed = true; }
      else if (fibSlHit) { s.result = "LOSS"; addLog(`📐 Fib Golden Zone LOSS — hit SL @ ${fmt(s.sl, 4)}`); changed = true; }
      else if (fibTpHit) { s.result = "WIN"; addLog(`📐 Fib Golden Zone WIN — hit TP @ ${fmt(s.tp, 4)}`); changed = true; }
    }

    /* If momentum stalls (price stuck near entry for several candles), expire the signal */
    if (s.result === "PENDING" && elapsed >= 8) {
      const stalledRange = atrValue > 0 ? atrValue * 0.3 : Math.abs(s.tp - s.entry) * 0.1;
      if (Math.abs(candle.close - s.entry) < stalledRange) {
        s.result = "EXPIRED";
        addLog(`📐 Fib Golden Zone EXPIRED (momentum stalled) — ${s.symbol || ""} @ ${fmt(candle.close, 4)} (SL not hit)`);
        changed = true;
      }
    }
  }
  if (changed) {
    renderStrategyAlerts();
    /* Send Telegram outcome for each newly resolved signal.
       Gated on _sentViaTelegram so historical signals do not generate outcome alerts. */
    for (const s of fibScalpHistory) {
      if ((s.result === "WIN" || s.result === "LOSS" || s.result === "EXPIRED") && !s._stratOutcomeSent && s._sentViaTelegram === true) {
        sendStrategyOutcomeTelegram(s);
      }
    }
    /* Allow next trade after cooldown elapses (not immediately) */
    lastFibScalpIdx = candles.length - 1;
    addLog("📐 Fib Golden Zone signal resolved — scanning for next trade…");
  }
}

/* ================= STRATEGY 5: POWER OF 3 (ICT) ================= */
/**
 * Detect a Power of 3 (ICT) setup.
 *
 * Steps:
 *   1. Determine daily bias using EMA 8/21 (or EMA 100 for longer trend):
 *      - Bullish: EMA 8 > EMA 21 → look for buys below the 1H open.
 *      - Bearish: EMA 8 < EMA 21 → look for sells above the 1H open.
 *   2. Compute the 1-hour opening price (the open of the current hourly candle
 *      based on epoch timestamps).
 *   3. Manipulation phase: detect a sell-side liquidity sweep — price sweeps
 *      below the 1H open by at least 0.3× ATR (bullish), or a buy-side sweep
 *      above the 1H open (bearish) within the last PO3_SWEEP_LOOKBACK candles.
 *   4. Market Structure Shift (MSS): after the sweep, a displacement candle
 *      (body ≥ PO3_MSS_BODY_PCT of range, and range ≥ 0.5× ATR) closes back
 *      above the 1H open (bullish) or below (bearish). This candle should
 *      leave a Fair Value Gap (FVG) with the candle two bars before.
 *   5. Entry: price retraces into the FVG (between the prior candle's close
 *      and the displacement candle's open, i.e. the gap zone).
 *   6. SL: below the manipulation low (bullish) / above the manipulation high (bearish).
 *   7. TP: the 1H candle high (bullish) / 1H candle low (bearish) + external liquidity.
 *
 * Returns null or { dir, entry, sl, tp, rr, oneHourOpen, sweepPrice, fvgHigh,
 *                    fvgLow, candleIdx, epoch, symbol, result, type }
 */
function detectPowerOf3() {
  if (!po3Enabled) return null;

  /* One-at-a-time: skip detection while any signal is still PENDING */
  if (po3History.some(s => s.result === "PENDING")) return null;

  const len = candles.length;
  if (len < 20) return null;

  const idx = len - 1;
  if (idx - lastPo3Idx < PO3_COOLDOWN) return null;

  const c = candles[idx];

  /* Require sufficient indicator data */
  if (emaFast.length <= idx || emaSlow.length <= idx) return null;
  if (atrValue <= 0) return null;

  /* --- Step 1: Determine daily bias from EMA 8/21 alignment --- */
  const emaF = emaFast[idx];
  const emaS = emaSlow[idx];
  /* Use EMA 100 (HTF proxy) as additional trend confirmation if available */
  const emaH = emaHTF.length > idx ? emaHTF[idx] : null;
  let dailyBias = null;

  if (emaF > emaS) dailyBias = "BULL";
  else if (emaF < emaS) dailyBias = "BEAR";

  /* Optional: strengthen bias with HTF trend — if HTF disagrees, skip */
  if (emaH != null) {
    if (dailyBias === "BULL" && c.close < emaH) return null; /* price below EMA100 — bias conflict */
    if (dailyBias === "BEAR" && c.close > emaH) return null;
  }

  if (!dailyBias) return null;

  /* --- Step 2: Compute the 1-hour opening price --- */
  /* Find the candle that started the current 1-hour block.
     We compute the start-of-hour epoch for the current candle, then walk
     back to find the first candle at or after that epoch. */
  const currentEpoch = c.epoch;
  const hourStart = currentEpoch - (currentEpoch % 3600);  /* floor to the start of the hour */

  let oneHourOpenPrice = null;
  let oneHourHighPrice = -Infinity;
  let oneHourLowPrice  = Infinity;
  let oneHourOpenIdx   = -1;

  for (let i = 0; i < len; i++) {
    if (candles[i].epoch >= hourStart) {
      oneHourOpenPrice = candles[i].open;
      oneHourOpenIdx = i;
      break;
    }
  }
  if (oneHourOpenPrice == null) return null;

  /* Compute the 1H candle high and low for the current hour */
  for (let i = oneHourOpenIdx; i < len; i++) {
    if (candles[i].high > oneHourHighPrice) oneHourHighPrice = candles[i].high;
    if (candles[i].low < oneHourLowPrice)   oneHourLowPrice = candles[i].low;
  }

  /* Ensure we have enough candles within this hour for the phases */
  if (idx - oneHourOpenIdx < 3) return null;

  /* --- Step 3: Manipulation phase — liquidity sweep --- */
  /* Bullish: look for a candle that swept below the 1H open then reversed.
     Bearish: look for a candle that swept above the 1H open then reversed. */
  let sweepCandle = null;
  let sweepIdx = -1;
  let sweepPrice = null;
  const sweepStart = Math.max(oneHourOpenIdx + 1, idx - PO3_SWEEP_LOOKBACK);

  if (dailyBias === "BULL") {
    /* Sell-side sweep: candle low goes below 1H open by at least PO3_FVG_MIN_ATR × ATR */
    for (let i = sweepStart; i < idx; i++) {
      if (candles[i].low < oneHourOpenPrice - atrValue * PO3_FVG_MIN_ATR) {
        /* Verify it's a sweep (wick below, close can be anywhere) */
        if (!sweepCandle || candles[i].low < sweepCandle.low) {
          sweepCandle = candles[i];
          sweepIdx = i;
          sweepPrice = candles[i].low;
        }
      }
    }
  } else {
    /* Buy-side sweep: candle high goes above 1H open */
    for (let i = sweepStart; i < idx; i++) {
      if (candles[i].high > oneHourOpenPrice + atrValue * PO3_FVG_MIN_ATR) {
        if (!sweepCandle || candles[i].high > sweepCandle.high) {
          sweepCandle = candles[i];
          sweepIdx = i;
          sweepPrice = candles[i].high;
        }
      }
    }
  }

  if (!sweepCandle) return null;  /* No manipulation detected */

  /* --- Step 4: Market Structure Shift (MSS) with displacement after the sweep --- */
  /* Look for a displacement candle AFTER the sweep that shifts structure back
     in the direction of the daily bias. */
  let mssCandle = null;
  let mssIdx = -1;
  let fvgHigh = null;
  let fvgLow  = null;

  for (let i = sweepIdx + 1; i <= idx; i++) {
    const mc = candles[i];
    const body = Math.abs(mc.close - mc.open);
    const range = mc.high - mc.low;

    /* Displacement: strong body candle (body ≥ PO3_MSS_BODY_PCT of range, range ≥ 0.5 ATR) */
    if (range < atrValue * 0.5) continue;
    if (body < range * PO3_MSS_BODY_PCT) continue;

    if (dailyBias === "BULL") {
      /* Bullish MSS: strong bullish candle that closes above 1H open */
      if (mc.close <= mc.open) continue;  /* must be bullish candle */
      if (mc.close <= oneHourOpenPrice) continue;  /* must reclaim 1H open */

      /* Check for Fair Value Gap (FVG):
         A bullish FVG exists when candle[i].low > candle[i-2].high
         (there's a gap between the body of 2 candles ago and current) */
      if (i >= 2) {
        const twoBack = candles[i - 2];
        if (mc.low > twoBack.high) {
          /* True FVG — gap between candle[i-2] high and candle[i] low */
          fvgHigh = mc.low;
          fvgLow  = twoBack.high;
          mssCandle = mc;
          mssIdx = i;
          break;
        }
        /* Relaxed FVG: use the displacement candle open as upper bound */
        if (mc.open > twoBack.high) {
          fvgHigh = mc.open;
          fvgLow  = twoBack.high;
          mssCandle = mc;
          mssIdx = i;
          break;
        }
      }
    } else {
      /* Bearish MSS: strong bearish candle that closes below 1H open */
      if (mc.close >= mc.open) continue;  /* must be bearish candle */
      if (mc.close >= oneHourOpenPrice) continue;  /* must break below 1H open */

      /* Bearish FVG: candle[i].high < candle[i-2].low */
      if (i >= 2) {
        const twoBack = candles[i - 2];
        if (mc.high < twoBack.low) {
          fvgLow  = mc.high;
          fvgHigh = twoBack.low;
          mssCandle = mc;
          mssIdx = i;
          break;
        }
        /* Relaxed FVG */
        if (mc.open < twoBack.low) {
          fvgLow  = mc.open;
          fvgHigh = twoBack.low;
          mssCandle = mc;
          mssIdx = i;
          break;
        }
      }
    }
  }

  if (!mssCandle || fvgHigh == null || fvgLow == null) return null;

  /* Ensure FVG has meaningful size */
  const fvgSize = Math.abs(fvgHigh - fvgLow);
  if (fvgSize < atrValue * PO3_FVG_MIN_ATR * 0.5) return null;

  /* --- Step 5: Entry — price returns into the FVG --- */
  /*
   Keep alerts timely: only signal if the most recent FVG touch is fresh.
   This prevents stale PO3 alerts that appear long after the retrace,
   when price is already close to TP.
  */
  let entryTouchIdx = -1;
  const fvgTop = Math.max(fvgHigh, fvgLow);
  const fvgBottom = Math.min(fvgHigh, fvgLow);

  for (let i = mssIdx + 1; i <= idx; i++) {
    const ec = candles[i];
    if (ec.low <= fvgTop && ec.high >= fvgBottom) {
      entryTouchIdx = i;
    }
  }

  if (entryTouchIdx < 0) return null;
  if (idx - entryTouchIdx > po3EntryMaxAge) return null;

  /* --- Step 6: Compute entry / SL / TP --- */
  /* Entry anchored to a realistic fill inside the FVG zone */
  const entryTouch = candles[entryTouchIdx];
  const fvgMid = (fvgTop + fvgBottom) / 2;
  const entryClose = entryTouch.close;
  const entry = (entryClose >= fvgBottom && entryClose <= fvgTop)
    ? entryClose
    : fvgMid;

  let sl, tp;
  const _profParams = getStrategyProfitParams();
  if (dailyBias === "BULL") {
    /* SL below the manipulation low with small ATR buffer */
    sl = sweepPrice - atrValue * 0.15 * _profParams.slBufferMult;
    /* TP at the 1H high or above — external liquidity */
    tp = oneHourHighPrice;
    /* If 1H high is too close, extend TP by profit-optimized R:R */
    const risk = Math.abs(entry - sl);
    if (tp <= entry + risk * 0.5) tp = entry + risk * _profParams.rrPO3Fallback;
  } else {
    /* SL above the manipulation high */
    sl = sweepPrice + atrValue * 0.15 * _profParams.slBufferMult;
    /* TP at the 1H low — external liquidity */
    tp = oneHourLowPrice;
    const risk = Math.abs(sl - entry);
    if (tp >= entry - risk * 0.5) tp = entry - risk * _profParams.rrPO3Fallback;
  }

  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  const rr = risk > 0 ? reward / risk : 0;

  /* Reject if R:R is below 1.0 */
  if (rr < 1.0) return null;

  /* --- Guard: reject if risk is negligible (SL ≈ entry) --- */
  if (risk < atrValue * 0.05) return null;

  /* --- Guard: reject stale signals where price already reached 1R or TP --- *
   * If the current candle has already moved past the 1:1 profit level,
   * the signal is too late — sending a notification at this point would
   * arrive alongside a win/partial-TP notification on the very same tick. */
  if (dailyBias === "BULL") {
    const oneRLevel = entry + risk;
    if (c.high >= oneRLevel || c.high >= tp) return null;
  } else {
    const oneRLevel = entry - risk;
    if (c.low <= oneRLevel || c.low <= tp) return null;
  }

  return {
    dir: dailyBias,
    entry, sl, tp, rr,
    _origSl: sl,            /* preserve original SL for partial TP distance calc */
    partialTpHit: false,    /* true when price hit 1R profit (1:1 alert fired) */
    oneHourOpen: oneHourOpenPrice,
    sweepPrice,
    fvgHigh: fvgTop,
    fvgLow: fvgBottom,
    candleIdx: idx,
    epoch: c.epoch,
    symbol: getActiveSymbol(),
    result: "PENDING",
    type: "power_of_3"
  };
}

/**
 * Run the Power of 3 scanner and handle alerting.
 */
function processPowerOf3() {
  const signal = detectPowerOf3();
  if (!signal) return;

  /* Min Confluence Gate — override any per-strategy hardcoded threshold when enabled */
  if (minConfluenceEnabled) {
    const confScore = computeConfluenceScore(signal.dir, signal.entry, signal.candleIdx);
    if (confScore < minConfluenceValue) {
      addLog(`⚠ Power of 3 REJECTED — confluence ${confScore}/${minConfluenceValue} below minimum`);
      return;
    }
  }

  lastPo3Idx = signal.candleIdx;

  signal._stratOutcomeSent = false;
  signal._sentViaTelegram  = (telegramStrategyAutoSend && !_historicalProcessing); /* true when entry alert was Telegram-sent */
  po3History.unshift(signal);
  if (po3History.length > PO3_MAX_HISTORY) po3History.pop();

  /* Audio alert */
  playStrategyAlert(signal.dir);

  /* Log */
  const symbol = getActiveSymbol() || "--";
  addLog(`⚡ PO3 ${signal.dir === "BULL" ? "▲ BUY" : "▼ SELL"} — ${symbol} @ ${fmtPrice(signal.entry, symbol)} | 1H Open ${fmtPrice(signal.oneHourOpen, symbol)} | Sweep ${fmtPrice(signal.sweepPrice, symbol)} | FVG [${fmtPrice(signal.fvgLow, symbol)}–${fmtPrice(signal.fvgHigh, symbol)}] | SL ${fmtPrice(signal.sl, symbol)} | TP ${fmtPrice(signal.tp, symbol)} | R:R 1:${fmt(signal.rr, 1)}`);

  showToast(
    `Power of 3 ${signal.dir === "BULL" ? "▲ BUY" : "▼ SELL"}`,
    `${symbol} @ ${fmtPrice(signal.entry, symbol)} | 1H Open: ${fmtPrice(signal.oneHourOpen, symbol)} | SL: ${fmtPrice(signal.sl, symbol)} | TP: ${fmtPrice(signal.tp, symbol)} | R:R 1:${fmt(signal.rr, 1)}`,
    "trade", 10000
  );

  /* Browser notification */
  if (notificationsEnabled && "Notification" in window && Notification.permission === "granted") {
    const body = `⚡ ${signal.dir} Power of 3 — ${symbol} @ ${fmtPrice(signal.entry, symbol)}\n1H Open: ${fmtPrice(signal.oneHourOpen, symbol)} | Sweep: ${fmtPrice(signal.sweepPrice, symbol)}\nFVG: ${fmtPrice(signal.fvgLow, symbol)}–${fmtPrice(signal.fvgHigh, symbol)}\nSL: ${fmtPrice(signal.sl, symbol)} | TP: ${fmtPrice(signal.tp, symbol)}`;
    throttledNotification("IT Guru: Power of 3 Signal!", body);
  }

  /* Telegram alert */
  if (telegramStrategyAutoSend) {
    setTimeout(() => sendTelegramStrategyAlert(signal), CHART_RENDER_DELAY_MS);
  }

  renderStrategyAlerts();

  /* Auto-trade: place a Deriv multiplier contract for PO3 */
  if (autoTradeStrategyEnabled && autoTradePo3 && !_historicalProcessing) {
    executeAutoTrade({ dir: signal.dir, entry: signal.entry, sl: signal.sl, tp: signal.tp, symbol: signal.symbol || symbol, source: "strategy", strategyName: "po3" });
  }
}

/**
 * Monitor pending Power of 3 signals for SL/TP outcome.
 * Includes partial TP at 1R: when price reaches 1× risk profit, the SL
 * moves to breakeven (entry) and partialTpHit is flagged. The trade then
 * runs freely to full TP — "Partial at 1–2R, let the rest run."
 */
function monitorPo3Outcomes(candle) {
  if (!po3Enabled) return;
  let changed = false;
  for (const s of po3History) {
    if (s.result !== "PENDING") continue;
    const elapsed = (candles.length - 1) - s.candleIdx;

    /* Timeout after PO3_MAX_CANDLES or stale index */
    if (elapsed < 0 || elapsed >= PO3_MAX_CANDLES) {
      s.result = "EXPIRED";
      addLog(`⚡ PO3 EXPIRED (timeout ${PO3_MAX_CANDLES} candles) — ${s.symbol || ""} @ ${fmt(candle.close, 4)} (SL not hit)`);
      changed = true; continue;
    }

    /* Partial TP at 1R: when price moves 1× risk in our favour, slide SL to
       breakeven (entry).  This locks in the partial profit and removes risk
       for the remainder of the trade that runs to full TP.
       The `continue` is intentional: defer SL/TP check to the next tick so
       that the newly-moved breakeven SL (not the original SL) governs.
       Only active when partialTpEnabled is ON — mirrors the main-strategy gate. */
    if (partialTpEnabled && !s.partialTpHit) {
      const origSl = s._origSl;
      const risk = Math.abs(s.entry - origSl);
      const partialLevel = s.dir === "BULL" ? s.entry + risk : s.entry - risk;
      const partialHit   = s.dir === "BULL" ? candle.high >= partialLevel : candle.low <= partialLevel;
      if (partialHit) {
        s.partialTpHit = true;
        s._reached1R = true;  /* also mark for profit exit alert tracking */
        s.sl = s.entry;  /* slide SL to breakeven */
        addLog(`⚡ PO3 Partial TP hit (1R) — SL moved to breakeven @ ${fmtPrice(s.entry, s.symbol)}, running to full TP ${fmtPrice(s.tp, s.symbol)}`);
        showToast(
          `PO3 Partial TP ✓`,
          `1R hit — SL → breakeven @ ${fmtPrice(s.entry, s.symbol)} | Full TP @ ${fmtPrice(s.tp, s.symbol)}`,
          "info", 6000
        );
        sendPartialTpTelegram(s, partialLevel);
        changed = true;
        continue;  /* re-evaluate on next candle with breakeven SL in place */
      }
    }

    /* 1R profit tracking (when partial TP is disabled) + profit exit alert */
    if (_checkProfitExitAlert(s, candle, "Power of 3")) changed = true;

    /* Check SL / TP */
    if (s.dir === "BULL") {
      const po3SlHit = candle.low <= s.sl, po3TpHit = candle.high >= s.tp;
      if (po3SlHit && po3TpHit) {
        /* Both levels hit: partial TP already locked profit, or use distance comparison */
        s.result = resolveBothHit(s);
        const lbl = s.result === "WIN" ? (s.partialTpHit ? "hit TP after partial TP" : "TP closer") : "SL closer";
        addLog(`⚡ PO3 ${s.result} — both levels hit (${lbl})`);
        changed = true;
      } else if (po3SlHit) {
        /* SL hit: count as LOSS regardless of whether partial TP was taken.
           A breakeven exit (SL at entry after partial TP) means no profit on the
           remaining position — win rate only counts trades that hit the full TP. */
        s.result = "LOSS";
        const exitNote = s.partialTpHit ? " (breakeven — stopped at entry after partial TP)" : "";
        addLog(`⚡ PO3 LOSS — hit SL @ ${fmtPrice(s.sl, s.symbol)}${exitNote}`);
        changed = true;
      } else if (po3TpHit) { s.result = "WIN"; addLog(`⚡ PO3 WIN — hit TP @ ${fmtPrice(s.tp, s.symbol)}`); changed = true; }
    } else {
      const po3SlHit = candle.high >= s.sl, po3TpHit = candle.low <= s.tp;
      if (po3SlHit && po3TpHit) {
        s.result = resolveBothHit(s);
        const lbl = s.result === "WIN" ? (s.partialTpHit ? "hit TP after partial TP" : "TP closer") : "SL closer";
        addLog(`⚡ PO3 ${s.result} — both levels hit (${lbl})`);
        changed = true;
      } else if (po3SlHit) {
        s.result = "LOSS";
        const exitNote = s.partialTpHit ? " (breakeven — stopped at entry after partial TP)" : "";
        addLog(`⚡ PO3 LOSS — hit SL @ ${fmtPrice(s.sl, s.symbol)}${exitNote}`);
        changed = true;
      } else if (po3TpHit) { s.result = "WIN"; addLog(`⚡ PO3 WIN — hit TP @ ${fmtPrice(s.tp, s.symbol)}`); changed = true; }
    }
  }
  if (changed) {
    let resolved = false;
    renderStrategyAlerts();
    /* Send Telegram outcome for each newly resolved signal.
       PO3 is the only strategy with partial TP (which sets changed=true without
       fully resolving). _po3Resolved tracks first resolution so the cooldown reset
       and "resolved" log fire exactly once, independently of Telegram state.
       Other strategies (liquiditySweep, stopLossHunt, etc.) reset their cooldown
       unconditionally on every changed event, so they don't need this flag. */
    for (const s of po3History) {
      if (s.result === "WIN" || s.result === "LOSS") {
        if (!s._po3Resolved) { s._po3Resolved = true; resolved = true; }
        /* Gated on _sentViaTelegram so historical signals do not generate outcome alerts. */
        if (!s._stratOutcomeSent && s._sentViaTelegram === true) { sendStrategyOutcomeTelegram(s); }
      } else if (s.result === "EXPIRED") {
        if (!s._stratOutcomeSent && s._sentViaTelegram === true) { sendStrategyOutcomeTelegram(s); }
      }
    }
    /* Only reset cooldown when trade fully resolves (not on partial TP) */
    if (resolved) {
      lastPo3Idx = candles.length - 1;
      addLog("⚡ PO3 signal resolved — scanning for next trade…");
    }
  }
}

/* ================= SHARED STRATEGY HELPERS ================= */
/**
 * Track whether a trade has reached 1× risk in profit (1R) and fire a Telegram
 * profit exit alert when price subsequently reverses back to the entry price.
 *
 * Uses `s._origSl` when present (e.g. PO3 with partial TP) for an accurate risk
 * calculation that is unaffected by any SL movements made during the trade.
 *
 * Note: For PO3 when `partialTpEnabled` is true, `s._reached1R` is set
 * alongside `s.partialTpHit` in `monitorPo3Outcomes` before this helper is
 * called, so the helper's own 1R detection step is skipped and the reversal
 * check proceeds directly.  For all other strategies, this helper manages the
 * full lifecycle of `s._reached1R` and `s._profitExitAlertSent`.
 *
 * Mutates `s._reached1R` and `s._profitExitAlertSent` as side effects.
 *
 * @param {Object} s          - trade signal with { dir, entry, sl, _origSl? }
 * @param {Object} candle     - current OHLC candle
 * @param {string} stratLabel - human-readable strategy name used in the alert
 * @returns {boolean}         - true if the alert was fired this tick
 */
function _checkProfitExitAlert(s, candle, stratLabel) {
  const origSl = s._origSl != null ? s._origSl : s.sl;
  if (!s._reached1R) {
    const risk = Math.abs(s.entry - origSl);
    if (risk > 0) {
      const reached = s.dir === "BULL" ? candle.high >= s.entry + risk : candle.low <= s.entry - risk;
      if (reached) s._reached1R = true;
    }
  }
  if (s._reached1R && !s._profitExitAlertSent && telegramProfitExitAlertEnabled && s._sentViaTelegram === true && !_historicalProcessing) {
    const atEntry = s.dir === "BULL" ? candle.close <= s.entry : candle.close >= s.entry;
    if (atEntry) {
      s._profitExitAlertSent = true;
      addLog(`${stratLabel}: price returned to entry after 1R — profit exit alert`);
      showToast("⚠️ Protect Profit", `${stratLabel} reached 1R but reversed to entry — consider exiting`, "warning", 8000);
      sendProfitExitAlertTelegram(s, stratLabel);
      return true;
    }
  }
  return false;
}

/**
 * Audio alert for the 3 custom strategies (triple beep).
 */
function playStrategyAlert(dir) {
  if (!soundEnabled) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const freq = dir === "BULL" ? 900 : 700;
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = "triangle";
      gain.gain.value = 0.12;
      osc.start(ctx.currentTime + i * 0.18);
      osc.stop(ctx.currentTime + i * 0.18 + 0.1);
    }
  } catch (e) { /* audio not available */ }
}

/**
 * Render all strategy alert lists (liquidity sweep, stop loss hunt, failed pin bar).
 */
function renderStrategyAlerts() {
  /* Liquidity Sweep */
  _renderAlertList(UI.liquiditySweepAlertList, UI.liquiditySweepCount, liquiditySweepHistory, "🌊", "Liquidity Sweep");
  /* Stop Loss Hunt */
  _renderAlertList(UI.stopLossHuntAlertList, UI.stopLossHuntCount, stopLossHuntHistory, "🎯", "Stop Loss Hunt");
  /* Failed Pin Bar */
  _renderAlertList(UI.failedPinBarAlertList, UI.failedPinBarCount, failedPinBarHistory, "📌", "Failed Pin Bar");
  /* Fib Golden Zone Scalp */
  _renderAlertList(UI.fibScalpAlertList, UI.fibScalpCount, fibScalpHistory, "📐", "Fib Golden Zone");
  /* Power of 3 (ICT) */
  _renderAlertList(UI.po3AlertList, UI.po3Count, po3History, "⚡", "Power of 3");
  /* NY Open Range */
  _renderAlertList(UI.nyOpenRangeAlertList, UI.nyOpenRangeAlertCount, nyOpenRangeHistory, "🕤", "NY Open Range");
  /* Session Range (London Sweep) */
  _renderAlertList(UI.sessionRangeAlertList, UI.sessionRangeAlertCount, sessionRangeHistory, "🌍", "Session Range");
  /* Grid Scalper MA */
  _renderAlertList(UI.gridScalperMAAlertList, UI.gridScalperMAAlertCount, gridScalperMAHistory, "🔲", "Grid Scalper MA");
  /* Fair Value Gap (FVG) */
  _renderAlertList(UI.fvgStratAlertList, UI.fvgStratAlertCount, fvgStratHistory, "🎯", "Fair Value Gap");
  /* MTF Top-Down */
  _renderAlertList(UI.mtfTopDownAlertList, UI.mtfTopDownAlertCount, mtfTopDownHistory, "⏱", "MTF Top-Down");
  /* Update the header badge with the total count across all strategies */
  const totalCount = liquiditySweepHistory.length + stopLossHuntHistory.length
    + failedPinBarHistory.length + fibScalpHistory.length + po3History.length
    + nyOpenRangeHistory.length + sessionRangeHistory.length + gridScalperMAHistory.length
    + fvgStratHistory.length + mtfTopDownHistory.length;
  if (UI.strategyAlertTotalCount) UI.strategyAlertTotalCount.textContent = totalCount;
  /* Update the strategies ticker banner */
  renderStrategyTickerBanner();
  /* Refresh per-strategy win rate grid */
  updateStrategyWinRatesUI();
}

function _renderAlertList(listEl, countEl, history, emoji, label) {
  if (!listEl) return;
  listEl.innerHTML = "";
  if (countEl) countEl.textContent = history.length;

  for (const s of history) {
    const li = document.createElement("li");
    li.className = "scalp-alert-item"; /* reuse existing scalp alert styling */
    const dirIcon = s.dir === "BULL" ? "▲" : "▼";
    const dirColor = s.dir === "BULL" ? "#22c55e" : "#ef4444";
    const resultBadge = s.result === "WIN" ? ' <span style="color:#22c55e;">WIN ✓</span>'
                      : s.result === "LOSS" ? ' <span style="color:#ef4444;">LOSS ✗</span>'
                      : s.result === "EXPIRED" ? ' <span style="color:#f59e0b;">EXPIRED ⏱</span>'
                      : ' <span style="color:#94a3b8;">PENDING…</span>';
    const ts = new Date(s.epoch * 1000).toLocaleTimeString();
    li.innerHTML = `<span style="color:${dirColor};font-weight:700;">${emoji} ${dirIcon} ${s.dir}</span> `
                 + `<span style="opacity:0.7;">${s.symbol || "--"}</span> `
                 + `@ <b>${fmt(s.entry, 4)}</b> `
                 + `| SL ${fmt(s.sl, 4)} | TP ${fmt(s.tp, 4)}`
                 + resultBadge
                 + ` <small style="opacity:0.5;">${ts}</small>`;
    listEl.appendChild(li);
  }
}

/* ================= STRATEGY 8: GRID SCALPER MA ================= */
/**
 * Detect a Grid Scalper MA signal.
 *
 * Two modes (controlled by gridScalperMAStrategy):
 *   "price_vs_ma" – BUY when previous close crosses above the SMA; SELL when crosses below.
 *   "bos"         – BUY when current close breaks above the most recent confirmed swing high;
 *                   SELL when current close breaks below the most recent confirmed swing low.
 *
 * Returns null or { dir, entry, sl, tp, rr, candleIdx, epoch, symbol, result, mode }
 */
function detectGridScalperMA() {
  if (!gridScalperMAEnabled) return null;

  /* One-at-a-time: skip while any signal is still PENDING */
  if (gridScalperMAHistory.some(s => s.result === "PENDING")) return null;

  const len = candles.length;
  if (len < Math.max(gridScalperMAPeriod + 2, GRID_SCALPER_MA_BOS_LOOKBACK + 2)) return null;

  const idx = len - 1;
  if (idx - lastGridScalperMAIdx < GRID_SCALPER_MA_COOLDOWN) return null;

  const closes = candles.map(c => c.close);
  let dir = null;
  let breakLevel = null; /* used in BOS mode for logging */

  if (gridScalperMAStrategy === "price_vs_ma") {
    /* ── Price vs MA crossover ── */
    const maValues = computeSMA(closes, gridScalperMAPeriod);
    const prevClose = closes[idx - 1];
    const currClose = closes[idx];
    const prevMA = maValues[idx - 1];
    const currMA = maValues[idx];

    if (prevMA == null || currMA == null) return null;

    if (prevClose < prevMA && currClose > currMA) {
      dir = "BULL";
    } else if (prevClose > prevMA && currClose < currMA) {
      dir = "BEAR";
    }
  } else {
    /* ── BOS (Break of Structure) ── */
    const lookback = Math.max(0, idx - GRID_SCALPER_MA_BOS_LOOKBACK);
    let latestSwingHigh = null;  /* { idx, price } */
    let latestSwingLow  = null;

    /* Find the most recent confirmed swing high and low within lookback */
    for (let i = idx - SWING_NEIGHBOR_BARS - 1; i >= lookback + SWING_NEIGHBOR_BARS; i--) {
      if (latestSwingHigh === null && isTrueSwingHigh(i)) {
        latestSwingHigh = { idx: i, price: candles[i].high };
      }
      if (latestSwingLow === null && isTrueSwingLow(i)) {
        latestSwingLow = { idx: i, price: candles[i].low };
      }
      if (latestSwingHigh !== null && latestSwingLow !== null) break;
    }

    const currClose = closes[idx];

    if (latestSwingHigh && currClose > latestSwingHigh.price) {
      dir = "BULL";
      breakLevel = latestSwingHigh.price;
    } else if (latestSwingLow && currClose < latestSwingLow.price) {
      dir = "BEAR";
      breakLevel = latestSwingLow.price;
    }
  }

  if (!dir) return null;

  /* ── Compute SL using structural swing points ── */
  const atr = atrValue > 0 ? atrValue : (candles[idx].high - candles[idx].low);
  const slBuffer = atr * 0.15;
  const entry = candles[idx].close;

  let sl;
  if (dir === "BULL") {
    const swingLow = findSwingLow(idx);
    sl = swingLow - slBuffer;
    /* Ensure SL is below entry */
    if (sl >= entry) sl = entry - atr;
  } else {
    const swingHigh = findSwingHigh(idx);
    sl = swingHigh + slBuffer;
    /* Ensure SL is above entry */
    if (sl <= entry) sl = entry + atr;
  }

  let risk = Math.abs(entry - sl);
  const maxRisk = atr * GRID_SCALPER_MA_MAX_SL_ATR;
  if (risk > maxRisk) {
    sl = dir === "BULL" ? entry - maxRisk : entry + maxRisk;
    risk = maxRisk;
  }
  if (risk < atr * 0.05) return null;

  /* ── TP: symbol-aware R:R for optimised profits ── */
  const sym = getActiveSymbol() || "";
  let rrMultiplier = GRID_SCALPER_MA_RR_DEFAULT;
  let volCategory  = "default";
  if (/^1HZ/i.test(sym))     { rrMultiplier = GRID_SCALPER_MA_RR_VOL1S;    volCategory = "vol1s"; }
  else if (/^R_/i.test(sym)) { rrMultiplier = GRID_SCALPER_MA_RR_STANDARD; volCategory = "standard"; }

  const tp = dir === "BULL" ? entry + risk * rrMultiplier : entry - risk * rrMultiplier;
  const rr = risk > 0 ? (Math.abs(tp - entry) / risk) : 0;

  return {
    dir, entry, sl, tp, rr,
    candleIdx: idx,
    epoch: candles[idx].epoch,
    symbol: sym,
    result: "PENDING",
    type: "grid_scalper_ma",
    mode: gridScalperMAStrategy,
    volCategory,
    breakLevel
  };
}

/**
 * Run the Grid Scalper MA scanner and handle alerting.
 */
function processGridScalperMA() {
  const signal = detectGridScalperMA();
  if (!signal) return;

  lastGridScalperMAIdx = signal.candleIdx;

  signal._stratOutcomeSent = false;
  signal._sentViaTelegram  = (telegramStrategyAutoSend && !_historicalProcessing);
  gridScalperMAHistory.unshift(signal);
  if (gridScalperMAHistory.length > GRID_SCALPER_MA_MAX_HISTORY) gridScalperMAHistory.pop();

  playStrategyAlert(signal.dir);

  const sym = getActiveSymbol() || "--";
  const modeLabel = signal.mode === "bos" ? "BOS" : "Price vs MA";
  addLog(`🔲 GRID SCALPER MA [${modeLabel}] ${signal.dir === "BULL" ? "▲ BUY" : "▼ SELL"} — ${sym} @ ${fmt(signal.entry, 4)} | SL ${fmt(signal.sl, 4)} | TP ${fmt(signal.tp, 4)}`);

  showToast(
    `Grid Scalper MA ${signal.dir === "BULL" ? "▲ BUY" : "▼ SELL"} [${modeLabel}]`,
    `${sym} @ ${fmt(signal.entry, 4)} | SL: ${fmt(signal.sl, 4)} | TP: ${fmt(signal.tp, 4)}`,
    "trade", 10000
  );

  if (notificationsEnabled && "Notification" in window && Notification.permission === "granted") {
    const body = `🔲 ${signal.dir} Grid Scalper MA [${modeLabel}] — ${sym} @ ${fmt(signal.entry, 4)}\nSL: ${fmt(signal.sl, 4)} | TP: ${fmt(signal.tp, 4)}`;
    throttledNotification("IT Guru: Grid Scalper MA!", body);
  }

  if (telegramStrategyAutoSend) {
    setTimeout(() => sendTelegramStrategyAlert(signal), CHART_RENDER_DELAY_MS);
  }

  renderStrategyAlerts();

  if (autoTradeStrategyEnabled && autoTradeGridScalperMA && !_historicalProcessing) {
    executeAutoTrade({ dir: signal.dir, entry: signal.entry, sl: signal.sl, tp: signal.tp, symbol: signal.symbol || sym, source: "strategy", strategyName: "gridScalperMA" });
  }
}

/**
 * Monitor pending Grid Scalper MA signals for SL/TP outcome.
 */
function monitorGridScalperMAOutcomes(candle) {
  if (!gridScalperMAEnabled) return;
  let changed = false;
  for (const s of gridScalperMAHistory) {
    if (s.result !== "PENDING") continue;
    const elapsed = (candles.length - 1) - s.candleIdx;
    if (elapsed < 0 || elapsed >= 50) {
      s.result = "EXPIRED";
      addLog(`🔲 Grid Scalper MA EXPIRED — ${s.symbol || ""} @ ${fmt(candle.close, 4)}`);
      changed = true; continue;
    }
    if (s.dir === "BULL") {
      if (_checkProfitExitAlert(s, candle, "Grid Scalper MA")) changed = true;
      const gsSlHit = candle.low <= s.sl, gsTpHit = candle.high >= s.tp;
      if (gsSlHit && gsTpHit) { s.result = resolveBothHit(s); addLog(`🔲 Grid Scalper MA ${s.result} — both levels hit, ${s.result === "WIN" ? "TP" : "SL"} closer`); changed = true; }
      else if (gsSlHit)  { s.result = "LOSS"; addLog(`🔲 Grid Scalper MA LOSS — hit SL @ ${fmt(s.sl, 4)}`); changed = true; }
      else if (gsTpHit) { s.result = "WIN";  addLog(`🔲 Grid Scalper MA WIN — hit TP @ ${fmt(s.tp, 4)}`); changed = true; }
    } else {
      if (_checkProfitExitAlert(s, candle, "Grid Scalper MA")) changed = true;
      const gsSlHit = candle.high >= s.sl, gsTpHit = candle.low <= s.tp;
      if (gsSlHit && gsTpHit) { s.result = resolveBothHit(s); addLog(`🔲 Grid Scalper MA ${s.result} — both levels hit, ${s.result === "WIN" ? "TP" : "SL"} closer`); changed = true; }
      else if (gsSlHit) { s.result = "LOSS"; addLog(`🔲 Grid Scalper MA LOSS — hit SL @ ${fmt(s.sl, 4)}`); changed = true; }
      else if (gsTpHit) { s.result = "WIN";  addLog(`🔲 Grid Scalper MA WIN — hit TP @ ${fmt(s.tp, 4)}`); changed = true; }
    }
  }
  if (changed) {
    renderStrategyAlerts();
    /* Gated on _sentViaTelegram so historical signals do not generate outcome alerts. */
    for (const s of gridScalperMAHistory) {
      if ((s.result === "WIN" || s.result === "LOSS" || s.result === "EXPIRED") && !s._stratOutcomeSent && s._sentViaTelegram === true) {
        sendStrategyOutcomeTelegram(s);
      }
    }
    lastGridScalperMAIdx = candles.length - 1;
    addLog("🔲 Grid Scalper MA signal resolved — scanning for next trade…");
  }
}

/**
 * ================= STRATEGY 9: FAIR VALUE GAP (FVG) DETECTION =================
 *
 * Detects high-probability demand/supply zone trades using:
 *  1. "Big push" identification (3+ consecutive strong directional candles).
 *  2. FVG detection within the push to confirm the imbalance.
 *  3. Origin zone = candle BEFORE the push (the most powerful level).
 *  4. Fibonacci 50% discount filter — only enter when price is at a discount.
 *  5. Bullish/bearish engulfing confirmation at the origin zone.
 *  6. Long-term EMA trend alignment to avoid counter-trend entries.
 *
 * Returns null or a trade signal object.
 */
function detectFVGStrat() {
  if (!fvgStratEnabled) return null;

  /* One-at-a-time: skip detection while a signal is still PENDING */
  if (fvgStratHistory.some(s => s.result === "PENDING")) return null;

  const len = candles.length;
  if (len < FVG_LOOKBACK + 5) return null;

  const idx = len - 1;
  if (idx - lastFvgStratIdx < FVG_STRAT_COOLDOWN) return null;

  /* Need indicator data */
  if (atrValue <= 0) return null;
  const c = candles[idx];
  const p = candles[idx - 1];  /* previous candle (for engulfing check) */
  if (!c || !p) return null;

  /* ---- EMA trend filter (long-term direction must agree) ---- */
  const emaF = emaFast.length > idx ? emaFast[idx] : null;
  const emaS = emaSlow.length > idx ? emaSlow[idx] : null;

  /* ---- Scan lookback for a "big push" ---- */
  /* We need to find a block of 3+ consecutive strong-body candles in one direction */
  const lookbackStart = Math.max(1, idx - FVG_LOOKBACK);
  let pushFound    = false;
  let pushDir      = null;   /* "BULL" | "BEAR" */
  let pushStart    = -1;     /* index of first push candle */
  let pushEnd      = -1;     /* index of last push candle */
  let originIdx    = -1;     /* index of the candle BEFORE the push (demand/supply zone) */

  for (let i = lookbackStart; i <= idx - FVG_PUSH_MIN_CANDLES - 1; i++) {
    /* Count consecutive strong candles starting at i */
    let consecutive = 0;
    let dir = null;
    for (let j = i; j <= idx - 2; j++) {
      const cv = candles[j];
      const range = cv.high - cv.low;
      if (range <= 0) break;
      const body = Math.abs(cv.close - cv.open);
      const bodyPct = body / range;
      const isBull = cv.close > cv.open;
      const isBear = cv.close < cv.open;
      if (bodyPct < FVG_PUSH_BODY_PCT) break;
      if (range < atrValue * FVG_PUSH_ATR_MIN) break;
      if (dir === null) dir = isBull ? "BULL" : (isBear ? "BEAR" : null);
      if (!dir) break;
      if (dir === "BULL" && !isBull) break;
      if (dir === "BEAR" && !isBear) break;
      consecutive++;
      if (consecutive >= FVG_PUSH_MIN_CANDLES) {
        pushFound = true;
        pushDir   = dir;
        pushStart = i;
        pushEnd   = j;
        /* Don't break — find the longest / most recent push */
      }
    }
  }

  if (!pushFound) return null;

  /* Use EMA trend to filter direction of trade:
     For BULL trade: EMA 8 should be >= EMA 21 (or at least neutral).
     For BEAR trade: EMA 8 should be <= EMA 21. */
  if (emaF != null && emaS != null) {
    if (pushDir === "BULL" && emaF < emaS) return null;
    if (pushDir === "BEAR" && emaF > emaS) return null;
  }

  /* originIdx is the candle immediately BEFORE the push starts */
  originIdx = pushStart - 1;
  if (originIdx < 0) return null;

  const originCandle = candles[originIdx];

  /* ---- Find a Fair Value Gap (FVG) within the push ---- */
  let fvgHigh = null;
  let fvgLow  = null;
  for (let i = pushStart + 1; i <= pushEnd; i++) {
    if (i < 2) continue;
    const ci = candles[i];
    const ciMinus2 = candles[i - 2];
    if (!ci || !ciMinus2) continue;
    if (pushDir === "BULL") {
      /* Bullish FVG: gap between i-2 high and i low */
      if (ci.low > ciMinus2.high) {
        const gapSize = ci.low - ciMinus2.high;
        if (gapSize >= atrValue * FVG_MIN_SIZE_ATR) {
          fvgHigh = ci.low;
          fvgLow  = ciMinus2.high;
        }
      }
    } else {
      /* Bearish FVG: gap between i-2 low and i high */
      if (ci.high < ciMinus2.low) {
        const gapSize = ciMinus2.low - ci.high;
        if (gapSize >= atrValue * FVG_MIN_SIZE_ATR) {
          fvgLow  = ci.high;
          fvgHigh = ciMinus2.low;
        }
      }
    }
  }
  /* FVG is desirable but not required — the origin zone is the primary entry level */

  /* ---- Determine demand / supply zone from origin candle ---- */
  let demandZoneHigh, demandZoneLow;
  if (pushDir === "BULL") {
    /* Demand zone: the origin (red candle before push) — use full body range */
    demandZoneHigh = Math.max(originCandle.open, originCandle.close);
    demandZoneLow  = Math.min(originCandle.open, originCandle.close);
  } else {
    /* Supply zone: the origin (green candle before push) */
    demandZoneHigh = Math.max(originCandle.open, originCandle.close);
    demandZoneLow  = Math.min(originCandle.open, originCandle.close);
  }

  /* Make zone at least 0.3× ATR wide */
  const minZoneSize = atrValue * 0.3;
  if (demandZoneHigh - demandZoneLow < minZoneSize) {
    const mid = (demandZoneHigh + demandZoneLow) / 2;
    demandZoneHigh = mid + minZoneSize / 2;
    demandZoneLow  = mid - minZoneSize / 2;
  }

  /* ---- Fibonacci retracement: swing low to swing high ---- */
  /* Find swing high (max high after push start) and swing low (min low before push start) */
  let swingLow  = Infinity;
  let swingHigh = -Infinity;
  const fibScanStart = Math.max(0, originIdx - 10);
  for (let i = fibScanStart; i <= pushEnd; i++) {
    if (candles[i].low  < swingLow)  swingLow  = candles[i].low;
    if (candles[i].high > swingHigh) swingHigh = candles[i].high;
  }
  /* Include any candles after the push up to current */
  for (let i = pushEnd + 1; i <= idx; i++) {
    if (candles[i].high > swingHigh) swingHigh = candles[i].high;
  }

  if (swingHigh === swingLow || swingHigh <= swingLow) return null;
  const fibRange = swingHigh - swingLow;

  /* Fibonacci 50% level */
  const fib50Level = pushDir === "BULL"
    ? swingHigh - fibRange * FVG_FIB_DISCOUNT   /* 50% retracement from high */
    : swingLow  + fibRange * FVG_FIB_DISCOUNT;  /* 50% retracement from low */

  /* Current price must be at a discount (below 50% for BULL, above 50% for BEAR) */
  if (pushDir === "BULL" && c.close > fib50Level) return null;
  if (pushDir === "BEAR" && c.close < fib50Level) return null;

  /* ---- Price must have retraced into the demand/supply zone ---- */
  const zoneTop    = Math.max(demandZoneHigh, demandZoneLow);
  const zoneBottom = Math.min(demandZoneHigh, demandZoneLow);
  /* Allow a small ATR tolerance for the price to be near the zone */
  const zoneTolerance = atrValue * 0.5;

  const inZone = pushDir === "BULL"
    ? (c.low <= zoneTop + zoneTolerance && c.close >= zoneBottom - zoneTolerance)
    : (c.high >= zoneBottom - zoneTolerance && c.close <= zoneTop + zoneTolerance);

  if (!inZone) return null;

  /* Price must not have broken through the zone (still relevant) */
  if (pushDir === "BULL" && c.close < zoneBottom - atrValue * 0.5) return null;
  if (pushDir === "BEAR" && c.close > zoneTop + atrValue * 0.5) return null;

  /* ---- Entry Confirmation: bullish/bearish engulfing at the zone ---- */
  /* p = previous candle, c = current candle */
  let confirmed = false;
  if (pushDir === "BULL") {
    /* Bullish engulfing: previous bearish + current bullish that engulfs */
    const pBearish = p.close < p.open;
    const cBullish = c.close > c.open;
    const engulfs  = c.close > p.open && c.open < p.close;
    if (pBearish && cBullish && engulfs) confirmed = true;

    /* Also accept a strong bullish close at/above zone top with decent body */
    if (!confirmed) {
      const cBody = c.close - c.open;
      const cRange = c.high - c.low;
      if (cBullish && cRange > 0 && cBody / cRange >= 0.5 && c.close >= zoneBottom) confirmed = true;
    }
  } else {
    /* Bearish engulfing: previous bullish + current bearish that engulfs */
    const pBullish = p.close > p.open;
    const cBearish = c.close < c.open;
    const engulfs  = c.close < p.open && c.open > p.close;
    if (pBullish && cBearish && engulfs) confirmed = true;

    if (!confirmed) {
      const cBody = c.open - c.close;
      const cRange = c.high - c.low;
      if (cBearish && cRange > 0 && cBody / cRange >= 0.5 && c.close <= zoneTop) confirmed = true;
    }
  }

  if (!confirmed) return null;

  /* ---- Build trade ---- */
  const entry = c.close;
  let sl, tp;
  const _profParams = getStrategyProfitParams();

  if (pushDir === "BULL") {
    /* SL: below demand zone low with ATR buffer */
    sl = zoneBottom - atrValue * FVG_ZONE_ATR_BUFFER * _profParams.slBufferMult;
    /* TP: swing high (the push high) + small extension */
    tp = swingHigh;
    /* Extend TP if too close — profit-optimized R:R fallback */
    const risk = Math.abs(entry - sl);
    if (tp <= entry + risk * 0.8) tp = entry + risk * _profParams.rrFVGFallback;
  } else {
    /* SL: above supply zone high with ATR buffer */
    sl = zoneTop + atrValue * FVG_ZONE_ATR_BUFFER * _profParams.slBufferMult;
    /* TP: swing low */
    tp = swingLow;
    const risk = Math.abs(sl - entry);
    if (tp >= entry - risk * 0.8) tp = entry - risk * _profParams.rrFVGFallback;
  }

  const risk   = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  if (risk <= 0) return null;
  const rr = reward / risk;

  /* Reject if R:R below 1.5 */
  if (rr < 1.5) return null;

  /* Compute the fib level ratio at current price for display */
  const fibLevel = pushDir === "BULL"
    ? (swingHigh - entry) / fibRange
    : (entry - swingLow) / fibRange;

  return {
    dir: pushDir,
    entry, sl, tp, rr,
    demandZoneHigh: zoneTop,
    demandZoneLow:  zoneBottom,
    fvgHigh: (fvgHigh != null && fvgLow != null) ? Math.max(fvgHigh, fvgLow) : (fvgHigh != null ? fvgHigh : fvgLow),
    fvgLow:  (fvgHigh != null && fvgLow != null) ? Math.min(fvgHigh, fvgLow) : (fvgLow  != null ? fvgLow  : fvgHigh),
    fibLevel,
    swingHigh,
    swingLow,
    pushStart,
    pushEnd,
    candleIdx: idx,
    epoch: c.epoch,
    symbol: getActiveSymbol(),
    result: "PENDING",
    type: "fvg_strat"
  };
}

/**
 * Run the FVG strategy scanner and handle alerting.
 */
function processFVGStrat() {
  const signal = detectFVGStrat();
  if (!signal) return;

  /* Min Confluence Gate */
  if (minConfluenceEnabled) {
    const confScore = computeConfluenceScore(signal.dir, signal.entry, signal.candleIdx);
    if (confScore < minConfluenceValue) {
      addLog(`⚠ FVG Strategy REJECTED — confluence ${confScore}/${minConfluenceValue} below minimum`);
      return;
    }
  }

  lastFvgStratIdx = signal.candleIdx;

  signal._stratOutcomeSent = false;
  signal._sentViaTelegram  = (telegramStrategyAutoSend && !_historicalProcessing);
  fvgStratHistory.unshift(signal);
  if (fvgStratHistory.length > FVG_STRAT_MAX_HISTORY) fvgStratHistory.pop();

  /* Audio alert */
  playStrategyAlert(signal.dir);

  /* Log */
  const symbol = getActiveSymbol() || "--";
  addLog(`🎯 FVG ${signal.dir === "BULL" ? "▲ BUY" : "▼ SELL"} — ${symbol} @ ${fmtPrice(signal.entry, symbol)} | Zone [${fmtPrice(signal.demandZoneLow, symbol)}–${fmtPrice(signal.demandZoneHigh, symbol)}] | SL ${fmtPrice(signal.sl, symbol)} | TP ${fmtPrice(signal.tp, symbol)} | R:R 1:${fmt(signal.rr, 1)} | Fib ${fmt(signal.fibLevel * 100, 0)}%`);

  showToast(
    `Fair Value Gap ${signal.dir === "BULL" ? "▲ BUY" : "▼ SELL"}`,
    `${symbol} @ ${fmtPrice(signal.entry, symbol)} | Zone: ${fmtPrice(signal.demandZoneLow, symbol)}–${fmtPrice(signal.demandZoneHigh, symbol)} | SL: ${fmtPrice(signal.sl, symbol)} | TP: ${fmtPrice(signal.tp, symbol)} | R:R 1:${fmt(signal.rr, 1)}`,
    "trade", 10000
  );

  /* Browser notification */
  if (notificationsEnabled && "Notification" in window && Notification.permission === "granted") {
    const body = `🎯 ${signal.dir} Fair Value Gap — ${symbol} @ ${fmtPrice(signal.entry, symbol)}\nZone: [${fmtPrice(signal.demandZoneLow, symbol)}–${fmtPrice(signal.demandZoneHigh, symbol)}]\nSL: ${fmtPrice(signal.sl, symbol)} | TP: ${fmtPrice(signal.tp, symbol)} | Fib: ${fmt(signal.fibLevel * 100, 0)}%`;
    throttledNotification("IT Guru: FVG Signal!", body);
  }

  /* Telegram alert */
  if (telegramStrategyAutoSend) {
    setTimeout(() => sendTelegramStrategyAlert(signal), CHART_RENDER_DELAY_MS);
  }

  renderStrategyAlerts();

  /* Auto-trade */
  if (autoTradeStrategyEnabled && autoTradeFvgStrat && !_historicalProcessing) {
    executeAutoTrade({ dir: signal.dir, entry: signal.entry, sl: signal.sl, tp: signal.tp, symbol: signal.symbol || symbol, source: "strategy", strategyName: "fvgStrat" });
  }
}

/**
 * Monitor pending FVG strategy signals for SL/TP outcome.
 */
function monitorFVGStratOutcomes(candle) {
  if (!fvgStratEnabled) return;
  let changed = false;
  for (const s of fvgStratHistory) {
    if (s.result !== "PENDING") continue;
    const elapsed = (candles.length - 1) - s.candleIdx;

    if (elapsed < 0 || elapsed >= FVG_STRAT_MAX_CANDLES) {
      s.result = "EXPIRED";
      addLog(`🎯 FVG EXPIRED (timeout ${FVG_STRAT_MAX_CANDLES} candles) — ${s.symbol || ""}`);
      changed = true; continue;
    }

    if (_checkProfitExitAlert(s, candle, "Fair Value Gap")) changed = true;

    if (s.dir === "BULL") {
      const slHit = candle.low <= s.sl, tpHit = candle.high >= s.tp;
      if (slHit && tpHit) { s.result = resolveBothHit(s); addLog(`🎯 FVG ${s.result} — both levels hit`); changed = true; }
      else if (slHit)     { s.result = "LOSS"; addLog(`🎯 FVG LOSS — hit SL @ ${fmtPrice(s.sl, s.symbol)}`); changed = true; }
      else if (tpHit)     { s.result = "WIN";  addLog(`🎯 FVG WIN — hit TP @ ${fmtPrice(s.tp, s.symbol)}`); changed = true; }
    } else {
      const slHit = candle.high >= s.sl, tpHit = candle.low <= s.tp;
      if (slHit && tpHit) { s.result = resolveBothHit(s); addLog(`🎯 FVG ${s.result} — both levels hit`); changed = true; }
      else if (slHit)     { s.result = "LOSS"; addLog(`🎯 FVG LOSS — hit SL @ ${fmtPrice(s.sl, s.symbol)}`); changed = true; }
      else if (tpHit)     { s.result = "WIN";  addLog(`🎯 FVG WIN — hit TP @ ${fmtPrice(s.tp, s.symbol)}`); changed = true; }
    }
  }
  if (changed) {
    renderStrategyAlerts();
    /* Gated on _sentViaTelegram so historical signals do not generate outcome alerts. */
    for (const s of fvgStratHistory) {
      if ((s.result === "WIN" || s.result === "LOSS" || s.result === "EXPIRED") && !s._stratOutcomeSent && s._sentViaTelegram === true) {
        sendStrategyOutcomeTelegram(s);
      }
    }
    lastFvgStratIdx = candles.length - 1;
    addLog("🎯 FVG signal resolved — scanning for next trade…");
  }
}

/**
 * Process all custom strategies. Called from the main candle pipeline.
 */
function processCustomStrategies() {
  processLiquiditySweep();
  processStopLossHunt();
  processFailedPinBar();
  processFibScalp();
  processPowerOf3();
  processGridScalperMA();
  processFVGStrat();
  processMtfTopDown();
  /* Feature 2: Orderblock (Strategy 12) */
  if (orderblockEnabled && candles.length > 0) detectOrderblockStrategy(candles.length - 1);
}

/**
 * Monitor all custom strategy outcomes. Called from the main candle pipeline.
 */
function monitorCustomStrategyOutcomes(candle) {
  monitorLiquiditySweepOutcomes(candle);
  monitorStopLossHuntOutcomes(candle);
  monitorFailedPinBarOutcomes(candle);
  monitorFibScalpOutcomes(candle);
  monitorPo3Outcomes(candle);
  monitorGridScalperMAOutcomes(candle);
  monitorFVGStratOutcomes(candle);
  monitorMtfTopDownOutcomes(candle);
  /* Feature 2: Orderblock */
  monitorOrderblockOutcomes(candles.length - 1);
  /* Feature 15: Multi-R ladder */
  monitorMultiRLadder(candles.length - 1);
}

/* ================= MTF TOP-DOWN STRATEGY (Strategy 11) ================= */

/**
 * Synthesise higher-timeframe candles by grouping `ratio` consecutive base
 * candles into a single OHLC bar.  Uses the global `candles` array.
 */
function synthesizeTfCandles(ratio) {
  if (!candles || candles.length < ratio || ratio < 2) return candles ? candles.slice() : [];
  const result = [];
  for (let i = 0; i + ratio <= candles.length; i += ratio) {
    const group = candles.slice(i, i + ratio);
    result.push({
      epoch: group[0].epoch,
      open:  group[0].open,
      high:  Math.max(...group.map(c => c.high)),
      low:   Math.min(...group.map(c => c.low)),
      close: group[group.length - 1].close
    });
  }
  return result;
}

/**
 * Determine the higher-timeframe directional bias from the synthesised "4H"
 * candle set.  Compares average highs and lows across first vs second half
 * of the MTF_BIAS_LOOKBACK window.
 *
 * @returns {"BULL"|"BEAR"|"NEUTRAL"}
 */
function computeMtfBias() {
  const biasBars = synthesizeTfCandles(MTF_BIAS_TF_MULT);
  if (biasBars.length < MTF_BIAS_LOOKBACK + 2) return "NEUTRAL";

  const slice = biasBars.slice(-MTF_BIAS_LOOKBACK);
  const highs  = slice.map(c => c.high);
  const lows   = slice.map(c => c.low);
  const n   = highs.length;
  const mid = Math.floor(n / 2);
  if (mid === 0 || mid >= n) return "NEUTRAL"; /* guard against edge cases */

  const avgHighFirst  = highs.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
  const avgHighSecond = highs.slice(mid).reduce((a, b) => a + b, 0) / (n - mid);
  const avgLowFirst   = lows.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
  const avgLowSecond  = lows.slice(mid).reduce((a, b) => a + b, 0) / (n - mid);

  const risingHighs  = avgHighSecond > avgHighFirst;
  const risingLows   = avgLowSecond  > avgLowFirst;
  const fallingHighs = avgHighSecond < avgHighFirst;
  const fallingLows  = avgLowSecond  < avgLowFirst;

  if (risingHighs && risingLows)   return "BULL";
  if (fallingHighs && fallingLows) return "BEAR";
  return "NEUTRAL";
}

/**
 * Detect a 1H-equivalent setup: price consolidates then breaks out in the
 * direction of the 4H bias.
 *
 * @returns {{ dir, level, rangeHigh, rangeLow }|null}
 */
function detectMtfSetup() {
  const bias = computeMtfBias();
  if (bias === "NEUTRAL") return null;

  const setupBars = synthesizeTfCandles(MTF_SETUP_TF_MULT);
  if (setupBars.length < MTF_SETUP_LOOKBACK + 2) return null;

  /* Consolidation range: all but last two bars */
  const rangeBars = setupBars.slice(-MTF_SETUP_LOOKBACK - 2, -2);
  const rangeHigh = Math.max(...rangeBars.map(c => c.high));
  const rangeLow  = Math.min(...rangeBars.map(c => c.low));
  if (rangeHigh <= rangeLow) return null;

  const last = setupBars[setupBars.length - 1];

  if (bias === "BULL" && last.close > rangeHigh) {
    return { dir: "BULL", level: rangeHigh, rangeHigh, rangeLow };
  }
  if (bias === "BEAR" && last.close < rangeLow) {
    return { dir: "BEAR", level: rangeLow, rangeHigh, rangeLow };
  }
  return null;
}

/**
 * Detect a current-TF retest of the 1H broken level.
 * A retest: price returns within ATR tolerance of the level then closes
 * back on the breakout side.
 *
 * @returns {{ dir, level, retestCandleIdx }|null}
 */
function detectMtfConfirmation() {
  const setup = detectMtfSetup();
  if (!setup) return null;

  const len = candles.length;
  if (len < 5) return null;

  const { dir, level } = setup;
  const tolerance = atrValue > 0 ? atrValue * 0.5 : level * 0.002;

  const scanStart = Math.max(0, len - 1 - MTF_RETEST_LOOKBACK);
  for (let i = scanStart; i < len - 1; i++) {
    const c = candles[i];
    if (!c) continue;
    if (dir === "BULL") {
      if (c.low <= level + tolerance && c.close >= level) {
        return { dir, level, retestCandleIdx: i };
      }
    } else {
      if (c.high >= level - tolerance && c.close <= level) {
        return { dir, level, retestCandleIdx: i };
      }
    }
  }
  return null;
}

/**
 * Main MTF Top-Down signal detector.
 * Looks for a pin bar, engulfing candle, or micro break-of-structure at the
 * confirmed retest zone.
 *
 * @returns {Object|null}
 */
function detectMtfTopDown() {
  if (!mtfTopDownEnabled) return null;
  if (!candles || candles.length < 20) return null;

  const idx = candles.length - 1;

  /* Cooldown */
  if (idx - lastMtfTopDownIdx < MTF_TOP_DOWN_COOLDOWN) return null;
  /* One pending at a time */
  if (mtfTopDownHistory.some(s => s.result === "PENDING")) return null;

  const confirmation = detectMtfConfirmation();
  if (!confirmation) return null;

  const { dir, level, retestCandleIdx } = confirmation;

  /* Only act within 3 candles of the confirmed retest */
  if (idx - retestCandleIdx > 3) return null;

  const c    = candles[idx];
  const prev = candles[idx - 1];
  if (!c || !prev) return null;

  const hasPinBar     = isPinBar(c, dir);
  const hasBullEngulf = dir === "BULL" && isBullishEngulfing(prev, c);
  const hasBearEngulf = dir === "BEAR" && isBearishEngulfing(prev, c);
  /* Micro BOS: current close surpasses the previous candle on the breakout side */
  const microBosBull  = dir === "BULL" && c.close > prev.high && c.close > c.open;
  const microBosBear  = dir === "BEAR" && c.close < prev.low  && c.close < c.open;

  if (!hasPinBar && !hasBullEngulf && !hasBearEngulf && !microBosBull && !microBosBear) return null;

  const patternType = hasPinBar ? "pin_bar"
    : (hasBullEngulf || hasBearEngulf) ? "engulfing"
    : "micro_bos";

  const entry    = c.close;
  const slBuffer = atrValue * MTF_SL_ATR_BUFFER;
  const _profParams = getStrategyProfitParams();
  const _mtfRR = _profParams.rrMTFMin;

  /* Pre-compute the 4H synthesised slice once for both TP directions */
  const biasSlice = synthesizeTfCandles(MTF_BIAS_TF_MULT).slice(-MTF_BIAS_LOOKBACK);
  let sl, tp;

  if (dir === "BULL") {
    sl = c.low - slBuffer * _profParams.slBufferMult;
    tp = biasSlice.length > 0
      ? Math.max(...biasSlice.map(b => b.high))
      : entry + Math.abs(entry - sl) * _mtfRR;
  } else {
    sl = c.high + slBuffer * _profParams.slBufferMult;
    tp = biasSlice.length > 0
      ? Math.min(...biasSlice.map(b => b.low))
      : entry - Math.abs(sl - entry) * _mtfRR;
  }

  const risk = Math.abs(entry - sl);
  if (risk <= 0) return null;

  /* Guarantee minimum R:R — profit-optimized per symbol */
  if (Math.abs(tp - entry) / risk < _mtfRR) {
    tp = dir === "BULL" ? entry + risk * _mtfRR : entry - risk * _mtfRR;
  }
  const rr = Math.abs(tp - entry) / risk;

  return {
    dir, entry, sl, tp, rr, level, retestCandleIdx,
    mtfBias: computeMtfBias(),
    patternType,
    candleIdx: idx,
    epoch:  c.epoch,
    symbol: getActiveSymbol(),
    result: "PENDING",
    type:   "mtf_top_down"
  };
}

/**
 * Run the MTF Top-Down scanner and handle all alerting.
 */
function processMtfTopDown() {
  const signal = detectMtfTopDown();
  if (!signal) return;

  /* Min Confluence Gate */
  if (minConfluenceEnabled) {
    const confScore = computeConfluenceScore(signal.dir, signal.entry, signal.candleIdx);
    if (confScore < minConfluenceValue) {
      addLog("\u26a0 MTF Top-Down REJECTED \u2014 confluence " + confScore + "/" + minConfluenceValue + " below minimum");
      return;
    }
  }

  lastMtfTopDownIdx = signal.candleIdx;
  signal._stratOutcomeSent = false;
  signal._sentViaTelegram  = (telegramStrategyAutoSend && !_historicalProcessing);
  mtfTopDownHistory.unshift(signal);
  if (mtfTopDownHistory.length > MTF_TOP_DOWN_MAX_HISTORY) mtfTopDownHistory.pop();

  playStrategyAlert(signal.dir);

  const sym = getActiveSymbol() || "--";
  const patLabel = signal.patternType === "pin_bar" ? "Pin Bar"
    : signal.patternType === "engulfing" ? "Engulfing"
    : "Micro BOS";
  const dirArrow = signal.dir === "BULL" ? "\u25b2 BUY" : "\u25bc SELL";
  addLog("\u23f1 MTF Top-Down " + dirArrow + " \u2014 " + sym + " @ " + fmtPrice(signal.entry, sym)
    + " | Bias: " + signal.mtfBias + " | Pattern: " + patLabel
    + " | Level: " + fmtPrice(signal.level, sym)
    + " | SL " + fmtPrice(signal.sl, sym)
    + " | TP " + fmtPrice(signal.tp, sym)
    + " | R:R 1:" + fmt(signal.rr, 1));

  showToast(
    "MTF Top-Down " + dirArrow,
    sym + " @ " + fmtPrice(signal.entry, sym)
      + " | " + signal.mtfBias + " bias | " + patLabel
      + " at " + fmtPrice(signal.level, sym)
      + " | SL: " + fmtPrice(signal.sl, sym)
      + " | TP: " + fmtPrice(signal.tp, sym)
      + " | R:R 1:" + fmt(signal.rr, 1),
    "trade", 10000
  );

  if (notificationsEnabled && "Notification" in window && Notification.permission === "granted") {
    const body = "\u23f1 " + signal.dir + " MTF Top-Down \u2014 " + sym
      + " @ " + fmtPrice(signal.entry, sym)
      + "\nBias: " + signal.mtfBias + " | Pattern: " + patLabel
      + "\nLevel: " + fmtPrice(signal.level, sym)
      + "\nSL: " + fmtPrice(signal.sl, sym) + " | TP: " + fmtPrice(signal.tp, sym);
    throttledNotification("IT Guru: MTF Top-Down Signal!", body);
  }

  if (telegramStrategyAutoSend) {
    setTimeout(function() { sendTelegramStrategyAlert(signal); }, CHART_RENDER_DELAY_MS);
  }

  renderStrategyAlerts();

  if (autoTradeStrategyEnabled && autoTradeMtfTopDown && !_historicalProcessing) {
    executeAutoTrade({ dir: signal.dir, entry: signal.entry, sl: signal.sl, tp: signal.tp,
      symbol: signal.symbol || sym, source: "strategy", strategyName: "mtfTopDown" });
  }
}

/**
 * Monitor pending MTF Top-Down signals for SL/TP outcome.
 */
function monitorMtfTopDownOutcomes(candle) {
  if (!mtfTopDownEnabled) return;
  let changed = false;
  for (const s of mtfTopDownHistory) {
    if (s.result !== "PENDING") continue;
    const elapsed = (candles.length - 1) - s.candleIdx;

    if (elapsed < 0 || elapsed >= MTF_TOP_DOWN_MAX_CANDLES) {
      s.result = "EXPIRED";
      changed = true;
      addLog("\u23f1 MTF Top-Down EXPIRED (timeout " + MTF_TOP_DOWN_MAX_CANDLES + " candles) \u2014 " + (s.symbol || ""));
      continue;
    }

    if (s.dir === "BULL") {
      if (candle.high >= s.tp) {
        s.result = "WIN"; changed = true;
        addLog("\u23f1 MTF Top-Down \u2705 WIN \u2014 " + (s.symbol || "") + " @ " + fmtPrice(s.tp, s.symbol));
        if (telegramStrategyOutcomeSend && !s._stratOutcomeSent && s._sentViaTelegram === true) sendStrategyOutcomeTelegram(s);
      } else if (candle.low <= s.sl) {
        s.result = "LOSS"; changed = true;
        addLog("\u23f1 MTF Top-Down \u274c LOSS \u2014 " + (s.symbol || "") + " @ " + fmtPrice(s.sl, s.symbol));
        if (telegramStrategyOutcomeSend && !s._stratOutcomeSent && s._sentViaTelegram === true) sendStrategyOutcomeTelegram(s);
      }
    } else {
      if (candle.low <= s.tp) {
        s.result = "WIN"; changed = true;
        addLog("\u23f1 MTF Top-Down \u2705 WIN \u2014 " + (s.symbol || "") + " @ " + fmtPrice(s.tp, s.symbol));
        if (telegramStrategyOutcomeSend && !s._stratOutcomeSent && s._sentViaTelegram === true) sendStrategyOutcomeTelegram(s);
      } else if (candle.high >= s.sl) {
        s.result = "LOSS"; changed = true;
        addLog("\u23f1 MTF Top-Down \u274c LOSS \u2014 " + (s.symbol || "") + " @ " + fmtPrice(s.sl, s.symbol));
        if (telegramStrategyOutcomeSend && !s._stratOutcomeSent && s._sentViaTelegram === true) sendStrategyOutcomeTelegram(s);
      }
    }
  }
  if (changed) {
    /* Send EXPIRED notifications (WIN/LOSS are sent inline above). */
    for (const s of mtfTopDownHistory) {
      if (s.result === "EXPIRED" && !s._stratOutcomeSent && s._sentViaTelegram === true) {
        sendStrategyOutcomeTelegram(s);
      }
    }
    renderStrategyAlerts();
  }
}

/* ================= LIVE SCALP SCANNER ================= */
/**
 * Scans the latest candles for high-probability scalp setups using multi-
 * indicator confluence.  Runs on every candle update when liveScalpEnabled
 * is true.  A scalp is "legit" when >= liveScalpMinConf conditions agree.
 *
 * Confluence criteria (max 7):
 *   1. EMA Momentum   – EMA 8 > EMA 21 (BULL) or EMA 8 < EMA 21 (BEAR)
 *   2. RSI Zone        – RSI ≤ 40 bounce rising → BULL;
 *                        RSI ≥ 60 reject falling → BEAR
 *   3. MACD Momentum   – MACD histogram positive & growing (BULL) or negative & growing (BEAR),
 *                        OR histogram just flipped sign
 *   4. Stochastic Cross – %K crosses %D upward from < 25 (BULL) or downward from > 75 (BEAR)
 *   5. Bollinger Bounce – Price touches/pierces lower band then closes inside (BULL),
 *                        or upper band bounce (BEAR)
 *   6. Candle Pattern   – Bullish/bearish engulfing, pin bar, or doji reversal at EMAs
 *   7. ADX Trend        – ADX ≥ 20 confirms enough directional movement for a scalp
 *
 * Returns null or { dir, conf, reasons[], entry, sl, tp }
 */
function detectLiveScalp() {
  if (!liveScalpEnabled) return null;
  const len = candles.length;
  if (len < 3) return null;

  const idx = len - 1;
  const c   = candles[idx];
  const p   = candles[idx - 1];  /* previous candle */

  /* Enforce cooldown – don't spam alerts on consecutive candles */
  if (idx - lastScalpCandleIdx < LIVE_SCALP_COOLDOWN_CANDLES) return null;

  /* ---- Gather indicator values at current candle ---- */
  const emaF = emaFast.length > idx ? emaFast[idx] : null;
  const emaS = emaSlow.length > idx ? emaSlow[idx] : null;
  const rsiVal  = rsiValues.length > idx ? rsiValues[idx] : null;
  const rsiPrev = rsiValues.length > idx - 1 && idx > 0 ? rsiValues[idx - 1] : null;
  const macdH   = macdHistogram.length > idx ? macdHistogram[idx] : null;
  const macdHP  = macdHistogram.length > idx - 1 && idx > 0 ? macdHistogram[idx - 1] : null;
  const sK      = stochK.length > idx ? stochK[idx] : null;
  const sKP     = stochK.length > idx - 1 && idx > 0 ? stochK[idx - 1] : null;
  const sD      = stochD.length > idx ? stochD[idx] : null;
  const sDP     = stochD.length > idx - 1 && idx > 0 ? stochD[idx - 1] : null;
  const bbUp    = bbUpper.length > idx ? bbUpper[idx] : null;
  const bbLo    = bbLower.length > idx ? bbLower[idx] : null;
  const atrVal  = atrValue;

  /* ---- Score BULL and BEAR separately, pick the stronger ---- */
  const bullReasons = [];
  const bearReasons = [];

  /* 1. EMA Momentum */
  if (emaF != null && emaS != null) {
    if (emaF > emaS && c.close > emaF) bullReasons.push("EMA 8>21 ✓");
    if (emaF < emaS && c.close < emaF) bearReasons.push("EMA 8<21 ✓");
  }

  /* 2. RSI Zone (reversal-based for scalps) */
  if (rsiVal != null && rsiPrev != null) {
    if (rsiVal <= 40 && rsiVal > rsiPrev) bullReasons.push(`RSI ${rsiVal.toFixed(0)} bounce ✓`);
    if (rsiVal >= 60 && rsiVal < rsiPrev) bearReasons.push(`RSI ${rsiVal.toFixed(0)} reject ✓`);
  }

  /* 3. MACD Momentum (one point max — flip is strongest, then growing momentum) */
  if (macdH != null && macdHP != null) {
    if (macdH > 0 && macdHP <= 0) bullReasons.push("MACD flip +ve ✓");
    else if (macdH > 0 && macdH > macdHP) bullReasons.push("MACD momentum ↑ ✓");
    if (macdH < 0 && macdHP >= 0) bearReasons.push("MACD flip −ve ✓");
    else if (macdH < 0 && macdH < macdHP) bearReasons.push("MACD momentum ↓ ✓");
  }

  /* 4. Stochastic cross in extreme zone */
  if (sK != null && sD != null && sKP != null && sDP != null) {
    if (sKP <= sDP && sK > sD && sK < 30) bullReasons.push(`Stoch cross ↑ ${sK.toFixed(0)} ✓`);
    if (sKP >= sDP && sK < sD && sK > 70) bearReasons.push(`Stoch cross ↓ ${sK.toFixed(0)} ✓`);
  }

  /* 5. Bollinger Band bounce */
  if (bbLo != null && bbUp != null) {
    if (p.low <= bbLo && c.close > bbLo) bullReasons.push("BB lower bounce ✓");
    if (p.high >= bbUp && c.close < bbUp) bearReasons.push("BB upper bounce ✓");
  }

  /* 6. Candle pattern at/near EMA or recent S/R */
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  const pBody = Math.abs(p.close - p.open);
  if (range > 0) {
    const isBullEngulf = c.close > c.open && p.close < p.open && body > pBody * 1.1 && c.close > p.open;
    const isBearEngulf = c.close < c.open && p.close > p.open && body > pBody * 1.1 && c.close < p.open;
    const isPinBarBull = c.close > c.open && (c.open - c.low) > body * 2 && (c.high - c.close) < body * 0.5;
    const isPinBarBear = c.close < c.open && (c.high - c.open) > body * 2 && (c.close - c.low) < body * 0.5;

    if (isBullEngulf) bullReasons.push("Bullish engulfing ✓");
    if (isBearEngulf) bearReasons.push("Bearish engulfing ✓");
    if (isPinBarBull) bullReasons.push("Bull pin bar ✓");
    if (isPinBarBear) bearReasons.push("Bear pin bar ✓");
  }

  /* 7. ADX trend strength (shared — benefits whichever side has momentum) */
  if (adxValue >= ADX_RANGING_THRESHOLD) {
    if (adxDiPlus > adxDiMinus) bullReasons.push(`ADX ${adxValue.toFixed(0)} DI+ ✓`);
    if (adxDiMinus > adxDiPlus) bearReasons.push(`ADX ${adxValue.toFixed(0)} DI− ✓`);
  }

  /* ---- Pick dominant direction ---- */
  const bullConf = bullReasons.length;
  const bearConf = bearReasons.length;
  const minConf  = liveScalpMinConf;

  let dir, conf, reasons;
  if (bullConf >= minConf && bullConf >= bearConf) {
    dir = "BULL"; conf = bullConf; reasons = bullReasons;
  } else if (bearConf >= minConf) {
    dir = "BEAR"; conf = bearConf; reasons = bearReasons;
  } else {
    return null;  /* not enough confluence */
  }

  /* ---- Compute entry / SL / TP using ATR ---- */
  const entry = c.close;
  const atr = atrVal > 0 ? atrVal : range;
  const slDist = atr * 0.75;  /* tight scalp SL: 0.75× ATR */
  const tpDist = atr * 1.0;   /* quick TP: 1× ATR → 1.33:1 R:R (1.0/0.75) */

  const sl = dir === "BULL" ? entry - slDist : entry + slDist;
  const tp = dir === "BULL" ? entry + tpDist : entry - tpDist;
  const rr = slDist > 0 ? tpDist / slDist : 0;

  return { dir, conf, reasons, entry, sl, tp, rr, epoch: c.epoch, candleIdx: idx, symbol: getActiveSymbol(), result: "PENDING" };
}

/**
 * Run the live scalp scanner and handle alerting.
 * Called from the main tick processing pipeline.
 */
function processLiveScalp() {
  const scalp = detectLiveScalp();
  if (!scalp) return;

  lastScalpCandleIdx = scalp.candleIdx;

  /* Store in history */
  liveScalpHistory.unshift(scalp);
  if (liveScalpHistory.length > LIVE_SCALP_MAX_HISTORY) liveScalpHistory.pop();

  /* Audio alert — distinct double-beep for scalps */
  playScalpAlert(scalp.dir);

  /* Browser notification */
  sendScalpNotification(scalp);

  /* Telegram alert (delayed to let canvas redraw first) */
  if (telegramScalpAutoSend) {
    setTimeout(() => sendTelegramScalpAlert(scalp), CHART_RENDER_DELAY_MS);
  }

  /* Update UI */
  renderScalpAlerts();
  updateScalpStatsUI();
  showScalpBanner(scalp);
  renderScalpTickerBanner();

  /* Log to signal log */
  const symbol = getActiveSymbol() || "--";
  addLog(`⚡ SCALP ${scalp.dir === "BULL" ? "▲ BUY" : "▼ SELL"} — ${symbol} @ ${fmt(scalp.entry, 4)} | Confluence ${scalp.conf}/7 | ${scalp.reasons.join(", ")}`);

  /* Auto-trade: place a Deriv multiplier contract for the scalp */
  if (autoTradeScalpEnabled && !_historicalProcessing) {
    executeAutoTrade({ dir: scalp.dir, entry: scalp.entry, sl: scalp.sl, tp: scalp.tp, symbol: scalp.symbol || symbol, source: "scalp" });
  }
}

/**
 * Monitor all PENDING scalps in liveScalpHistory for SL/TP outcome.
 * Called on every candle update (same pipeline as monitorTradeOutcome).
 * Uses a max-candle timeout (same as SCALP_MAX_CANDLES) for time-based exit.
 */

/**
 * Determine whether SL or TP was hit on a given candle for a scalp entry.
 * Returns { slHit, tpHit }.
 */
function checkScalpSLTP(s, candle) {
  if (s.dir === "BULL") {
    return { slHit: candle.low <= s.sl, tpHit: candle.high >= s.tp };
  }
  return { slHit: candle.high >= s.sl, tpHit: candle.low <= s.tp };
}

/**
 * When both SL and TP are breached in the same candle, resolve the outcome
 * by comparing distances from entry.  The closer level is assumed to have
 * been reached first.  On equal distance (1:1 R:R) the trade is marked WIN
 * since the TP was reachable at the same range as the SL.
 */
function resolveScalpBothHit(s) {
  const slDist = Math.abs(s.entry - s.sl);
  const tpDist = Math.abs(s.tp - s.entry);
  return tpDist <= slDist ? "WIN" : "LOSS";
}

/**
 * Generic "both SL and TP hit in same candle" resolver for all strategies.
 * When `partialTpHit` is set the 1:1 alert has already fired and partial profit
 * has been noted — the trade is always a WIN in that case since reaching the TP
 * is considered the primary outcome.  Otherwise falls back to distance comparison:
 * the level closer to entry is assumed to have been hit first.
 */
function resolveBothHit(s) {
  if (s.partialTpHit === true) return "WIN";
  return resolveScalpBothHit(s);
}

function monitorScalpOutcomes(candle) {
  if (!liveScalpEnabled) return;
  let changed = false;
  for (const s of liveScalpHistory) {
    if (s.result !== "PENDING") continue;

    /* Time-based exit: if enough candles have passed since the scalp entry */
    if (s.candleIdx !== null && s.candleIdx !== undefined) {
      const elapsed = (candles.length - 1) - s.candleIdx;
      if (elapsed >= SCALP_MAX_CANDLES) {
        /* Even on timeout, check if SL or TP was hit on this final candle */
        const { slHit, tpHit } = checkScalpSLTP(s, candle);
        if (tpHit && slHit) {
          s.result = resolveScalpBothHit(s);
        } else if (tpHit) {
          s.result = "WIN";
        } else if (slHit) {
          s.result = "LOSS";
        } else {
          /* Neither SL nor TP hit — fall back to close vs entry */
          const inProfit = (s.dir === "BULL" && candle.close > s.entry) ||
                           (s.dir === "BEAR" && candle.close < s.entry);
          s.result = inProfit ? "WIN" : "LOSS";
        }
        addLog(`⚡ Scalp ${s.result} (timeout ${SCALP_MAX_CANDLES} candles) — ${s.dir} ${s.symbol || ""} exit @ ${fmt(candle.close, 4)}`);
        changed = true;
        continue;
      }
    }

    /* Check SL / TP hit.
       When both SL and TP are hit within the same candle we compare the
       distance from the entry to each level — the closer level is assumed
       to have been reached first.  This avoids the old "SL always wins"
       bias that inflated the loss count. */
    const { slHit, tpHit } = checkScalpSLTP(s, candle);
    if (slHit && tpHit) {
      s.result = resolveScalpBothHit(s);
      addLog(`⚡ Scalp ${s.result} — ${s.symbol || ""} hit ${s.result === "WIN" ? "TP" : "SL"} @ ${fmt(s.result === "WIN" ? s.tp : s.sl, 4)} (both levels breached, ${s.result === "WIN" ? "TP" : "SL"} closer)`);
      changed = true;
    } else if (slHit) {
      s.result = "LOSS";
      addLog(`⚡ Scalp LOSS — ${s.symbol || ""} hit SL @ ${fmt(s.sl, 4)}`);
      changed = true;
    } else if (tpHit) {
      s.result = "WIN";
      addLog(`⚡ Scalp WIN — ${s.symbol || ""} hit TP @ ${fmt(s.tp, 4)}`);
      changed = true;
    }
  }
  if (changed) {
    updateScalpStatsUI();
    renderScalpTickerBanner();
    /* Send Telegram outcome for each newly resolved scalp */
    for (const s of liveScalpHistory) {
      if (s.result === "WIN" || s.result === "LOSS") {
        if (!s._outcomeSent) {
          s._outcomeSent = true;
          sendScalpOutcomeTelegram(s);
        }
      }
    }
  }
}

function playScalpAlert(dir) {
  if (!soundEnabled) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const freq = dir === "BULL" ? 1000 : 800;
    /* Double beep for urgency */
    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = "sine";
      gain.gain.value = 0.15;
      osc.start(ctx.currentTime + i * 0.2);
      osc.stop(ctx.currentTime + i * 0.2 + 0.12);
    }
  } catch (e) { /* audio not available */ }
}

function sendScalpNotification(scalp) {
  if (!notificationsEnabled || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  const symbol = getActiveSymbol() || "--";
  const body = `⚡ ${scalp.dir} SCALP — ${symbol} @ ${fmt(scalp.entry, 4)}\nConfluence: ${scalp.conf}/7\n${scalp.reasons.slice(0, 3).join(" · ")}`;
  throttledNotification("IT Guru: Live Scalp Alert!", body);
}

/**
 * Build a formatted Telegram caption for a live scalp alert.
 * Uses Telegram HTML parse mode.
 */
function buildScalpTelegramCaption(scalp) {
  const symbol = scalp.symbol || getActiveSymbol() || "--";
  const symLabel = getSymbolLabel ? getSymbolLabel(symbol) : symbol;
  const gran = UI.granSelect ? UI.granSelect.value : "--";
  const tfLabel = TIMEFRAME_LABELS[gran] || gran + "s";
  const ts = new Date(scalp.epoch * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const dirEmoji = scalp.dir === "BULL" ? "🟢" : "🔴";
  const dirLabel = scalp.dir === "BULL" ? "BUY" : "SELL";

  const lines = [];
  lines.push(`<b>⚡ Live Scalp Alert</b>`);
  lines.push(``);
  lines.push(`<b>Symbol:</b> ${symLabel}`);
  lines.push(`<b>Timeframe:</b> ${tfLabel}`);
  lines.push(`<b>Direction:</b> ${dirEmoji} ${scalp.dir} (${dirLabel})`);

  /* Indicate if opposite mode will reverse this signal for auto-trading */
  if (autoTradeScalpOpposite) {
    const oppDir = scalp.dir === "BULL" ? "BEAR" : "BULL";
    const oppLabel = oppDir === "BULL" ? "BUY" : "SELL";
    const oppEmoji = oppDir === "BULL" ? "🟢" : "🔴";
    lines.push(`<b>🔄 Opposite Mode:</b> Signal ${scalp.dir} → Trading ${oppEmoji} ${oppDir} (${oppLabel})`);
  }

  lines.push(``);
  lines.push(`<b>📍 Entry:</b> <code>${fmtPrice(scalp.entry, symbol)}</code>`);
  lines.push(`<b>🛑 SL:</b> <code>${fmtPrice(scalp.sl, symbol)}</code>`);
  lines.push(`<b>🎯 TP:</b> <code>${fmtPrice(scalp.tp, symbol)}</code>`);
  if (scalp.rr != null) {
    lines.push(`<b>R:R:</b> 1:${fmt(scalp.rr, 1)}`);
  }
  lines.push(``);
  lines.push(`<b>Confluence:</b> ${scalp.conf}/7`);
  lines.push(`<b>Reasons:</b> ${scalp.reasons.join(", ")}`);

  /* Position sizing if available */
  if (accountSize > 0 && riskPercent > 0 && scalp.entry != null && scalp.sl != null) {
    const tradeObj = { entry: scalp.entry, sl: scalp.sl, tp: scalp.tp, rr: scalp.rr || 0, symbol };
    const m = calcPositionMetrics(tradeObj);
    if (m) {
      lines.push(``);
      lines.push(`<b>💰 $ Risk:</b> $${fmt(m.dollarRisk, 2)}`);
      if (scalp.tp != null) lines.push(`<b>💰 $ Reward:</b> $${fmt(m.dollarReward, 2)}`);
      lines.push(`<b>📦 Lot Size:</b> ${fmt(m.lotSize, 2)}`);
      if (!m.isSynthetic) {
        lines.push(`<b>📏 Pips at Risk:</b> ${fmt(m.pips, 1)}`);
      }
    }
  }

  lines.push(``);
  lines.push(`<i>${ts}</i>`);
  return lines.join("\n");
}

/**
 * Send a live scalp alert to Telegram with chart screenshot.
 */
async function sendTelegramScalpAlert(scalp, force = false) {
  if (!telegramScalpAutoSend && !force) return;

  /* Sync credentials from DOM */
  if (UI.telegramBotToken) telegramBotToken = UI.telegramBotToken.value;
  if (UI.telegramChatId) telegramChatId = UI.telegramChatId.value;

  /* Check credentials are available */
  try {
    const { token, chatId } = getTelegramCredentials();
    validateTelegramCredentials(token, chatId);
  } catch (err) {
    addLog(`📤 Scalp Telegram skipped: ${err.message}`);
    return;
  }

  if (UI.telegramStatus) UI.telegramStatus.textContent = "Sending scalp…";
  const caption = buildScalpTelegramCaption(scalp);
  try {
    /* In multi-panel mode, capture the correct panel's chart (not whatever is currently in globals) */
    const panel = (scalp.symbol && multiPanels.has(scalp.symbol)) ? multiPanels.get(scalp.symbol) : null;
    const blob = await captureTelegramScreenshot(panel);
    if (blob) {
      await sendTelegramPhoto(blob, caption);
    } else {
      await sendTelegramMessage(caption);
    }
    addLog("📤 Scalp Telegram alert sent successfully");
    if (UI.telegramStatus) {
      UI.telegramStatus.textContent = "✅ Scalp sent!";
      UI.telegramStatus.className = "hint telegram-status telegram-ok";
    }
  } catch (err) {
    addLog(`📤 Scalp Telegram error: ${err.message}`);
    if (UI.telegramStatus) {
      UI.telegramStatus.textContent = `❌ Scalp: ${err.message}`;
      UI.telegramStatus.className = "hint telegram-status telegram-err";
    }
  }
  setTimeout(() => {
    if (UI.telegramStatus) {
      UI.telegramStatus.textContent = "";
      UI.telegramStatus.className = "hint telegram-status";
    }
  }, TELEGRAM_STATUS_CLEAR_MS);
}

/**
 * Send scalp outcome (WIN / LOSS) via Telegram when enabled.
 * Called from monitorScalpOutcomes after a scalp resolves.
 */
async function sendScalpOutcomeTelegram(scalp) {
  if (!telegramScalpOutcomeSend) return;

  /* Sync credentials from DOM */
  if (UI.telegramBotToken) telegramBotToken = UI.telegramBotToken.value;
  if (UI.telegramChatId) telegramChatId = UI.telegramChatId.value;

  try {
    const { token, chatId } = getTelegramCredentials();
    validateTelegramCredentials(token, chatId);
  } catch (err) {
    addLog(`📤 Scalp outcome Telegram skipped: ${err.message}`);
    return;
  }

  try {
    const sym = getSymbolLabel(scalp.symbol || getActiveSymbol() || "");
    const activeSym = scalp.symbol || getActiveSymbol() || "";
    const dir = scalp.dir === "BULL" ? "📈 BUY" : "📉 SELL";
    const result = scalp.result;
    const icon = result === "WIN" ? "✅" : "❌";
    const entryStr = scalp.entry != null ? fmtPrice(scalp.entry, activeSym) : "--";
    const slStr = scalp.sl != null ? fmtPrice(scalp.sl, activeSym) : "--";
    const tpStr = scalp.tp != null ? fmtPrice(scalp.tp, activeSym) : "--";
    const rrStr = scalp.rr != null ? "1:" + fmt(scalp.rr, 1) : "--";
    const confScore = scalp.conf != null ? scalp.conf + "/7" : "--";
    const reasons = scalp.reasons ? scalp.reasons.join(", ") : "--";

    const lines = [];
    lines.push(`${icon} <b>Scalp ${result}</b> — ${dir} ${sym}`);
    lines.push("");
    lines.push(`<b>📍 Entry:</b> ${entryStr}`);
    lines.push(`<b>🛑 SL:</b> ${slStr}`);
    lines.push(`<b>🎯 TP:</b> ${tpStr}`);
    lines.push(`<b>R:R:</b> ${rrStr}`);
    lines.push(`<b>Confluence:</b> ${confScore}`);
    lines.push(`<b>Reasons:</b> ${reasons}`);

    /* Scalp win/loss tally */
    const h = getAggregatedScalpHistory();
    const totalW = h.filter(s => s.result === "WIN").length;
    const totalL = h.filter(s => s.result === "LOSS").length;
    const wr = (totalW + totalL) > 0 ? (totalW / (totalW + totalL) * 100).toFixed(1) + "%" : "N/A";
    lines.push("");
    lines.push(`📊 <b>Scalp Record:</b> ${totalW}W / ${totalL}L (${wr} win rate)`);

    /* Opposite mode effectiveness from auto-trade history */
    const oppTrades = autoTradeHistory.filter(e => e.isOpposite && e.source === "scalp" && (e.result === "WIN" || e.result === "LOSS"));
    const normTrades = autoTradeHistory.filter(e => !e.isOpposite && e.source === "scalp" && (e.result === "WIN" || e.result === "LOSS"));
    if (oppTrades.length > 0 || normTrades.length > 0) {
      lines.push("");
      if (normTrades.length > 0) {
        const nw = normTrades.filter(e => e.result === "WIN").length;
        const nwr = (nw / normTrades.length * 100).toFixed(1);
        lines.push(`📈 <b>Normal:</b> ${nw}W / ${normTrades.length - nw}L (${nwr}%)`);
      }
      if (oppTrades.length > 0) {
        const ow = oppTrades.filter(e => e.result === "WIN").length;
        const owr = (ow / oppTrades.length * 100).toFixed(1);
        lines.push(`🔄 <b>Opposite:</b> ${ow}W / ${oppTrades.length - ow}L (${owr}%)`);
      }
    }

    lines.push(`<i>${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC</i>`);

    await sendTelegramMessage(lines.join("\n"));
    addLog(`📤 Telegram: scalp outcome (${result}) sent`);
  } catch (err) {
    addLog(`📤 Scalp outcome Telegram error: ${err.message}`);
  }
}

/* ================= TELEGRAM: CUSTOM STRATEGY ALERTS (Liquidity Sweep, Stop Loss Hunt, Failed Pin Bar) ================= */

/**
 * Build a formatted Telegram message for a custom strategy signal.
 * Includes direction, entry, SL/TP, R:R, lot size (based on account amount), and symbol.
 * Uses Telegram HTML parse mode.
 */
function buildStrategyTelegramCaption(signal) {
  const symbol = signal.symbol || getActiveSymbol() || "--";
  const symLabel = getSymbolLabel ? getSymbolLabel(symbol) : symbol;
  const gran = UI.granSelect ? UI.granSelect.value : "--";
  const tfLabel = TIMEFRAME_LABELS[gran] || gran + "s";
  const ts = signal.epoch
    ? new Date(signal.epoch * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC"
    : new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const dirEmoji = signal.dir === "BULL" ? "🟢" : "🔴";
  const dirArrow = signal.dir === "BULL" ? "▲" : "▼";
  const dirLabel = signal.dir === "BULL" ? "BUY" : "SELL";

  /* Strategy-specific emoji and label */
  let stratEmoji = "📊";
  let stratLabel = "Strategy Signal";
  if (signal.type === "liquidity_sweep") {
    stratEmoji = "🌊";
    stratLabel = "Liquidity Sweep";
  } else if (signal.type === "stop_loss_hunt") {
    stratEmoji = "🎯";
    stratLabel = "Stop Loss Hunt";
  } else if (signal.type === "failed_pin_bar") {
    stratEmoji = "📌";
    stratLabel = "Failed Pin Bar";
  } else if (signal.type === "fib_scalp") {
    stratEmoji = "📐";
    stratLabel = "Fib Golden Zone Scalp";
  } else if (signal.type === "ny_open_range") {
    stratEmoji = "🕤";
    stratLabel = "NY Open Range (9:30 AM EST)";
  } else if (signal.type === "session_range") {
    stratEmoji = "🌍";
    stratLabel = "Session Range (London Sweep)";
  } else if (signal.type === "grid_scalper_ma") {
    stratEmoji = "🔲";
    const modeLabel = signal.mode === "bos" ? "BOS" : "Price vs MA";
    stratLabel = `Grid Scalper MA [${modeLabel}]`;
  } else if (signal.type === "fvg_strat") {
    stratEmoji = "🎯";
    stratLabel = "Fair Value Gap";
  } else if (signal.type === "mtf_top_down") {
    stratEmoji = "⏱";
    stratLabel = "MTF Top-Down";
  }

  const lines = [];
  lines.push(`<b>${stratEmoji} ${stratLabel} Alert</b>`);
  lines.push(``);
  lines.push(`<b>Symbol:</b> ${symLabel}`);
  lines.push(`<b>Timeframe:</b> ${tfLabel}`);
  lines.push(`<b>Direction:</b> ${dirEmoji} ${dirArrow} ${signal.dir} (${dirLabel})`);

  /* Indicate if opposite mode will reverse this signal for auto-trading.
     For Grid Scalper MA the strategy's own Opposite Mode toggle
     (gridScalperMAOppositeEnabled) must also flip the alert, not only the
     auto-trade opposite toggle. */
  const gsOppositeOn = signal.type === "grid_scalper_ma" &&
    typeof gridScalperMAOppositeEnabled !== "undefined" && gridScalperMAOppositeEnabled;
  if (autoTradeStrategyOpposite || gsOppositeOn) {
    const oppDir = signal.dir === "BULL" ? "BEAR" : "BULL";
    const oppLabel = oppDir === "BULL" ? "BUY" : "SELL";
    const oppEmoji = oppDir === "BULL" ? "🟢" : "🔴";
    lines.push(`<b>🔄 Opposite Mode:</b> Signal ${signal.dir} → Trading ${oppEmoji} ${oppDir} (${oppLabel})`);
  }

  lines.push(``);
  lines.push(`<b>📍 Entry:</b> <code>${fmtPrice(signal.entry, symbol)}</code>`);
  lines.push(`<b>🛑 SL:</b> <code>${fmtPrice(signal.sl, symbol)}</code>`);
  lines.push(`<b>🎯 TP:</b> <code>${fmtPrice(signal.tp, symbol)}</code>`);
  if (signal.rr != null) {
    lines.push(`<b>R:R:</b> 1:${fmt(signal.rr, 1)}`);
  }

  /* Show opposite signal details when Grid Scalper opposite mode is active */
  if ((autoTradeStrategyOpposite || gsOppositeOn) && signal.type === "grid_scalper_ma") {
    const oppDir = signal.dir === "BULL" ? "BEAR" : "BULL";
    const risk = Math.abs(signal.entry - signal.sl);
    const oppSl = oppDir === "BULL" ? signal.entry - risk : signal.entry + risk;
    const oppTp = oppDir === "BULL" ? signal.entry + risk * (signal.rr || 2) : signal.entry - risk * (signal.rr || 2);
    const oppDirLabel = oppDir === "BULL" ? "🟢 BUY" : "🔴 SELL";
    lines.push(``);
    lines.push(`<b>━━━ Opposite Signal ━━━</b>`);
    lines.push(`<b>Direction:</b> ${oppDirLabel}`);
    lines.push(`<b>📍 Entry:</b> <code>${fmtPrice(signal.entry, symbol)}</code>`);
    lines.push(`<b>🛑 SL:</b> <code>${fmtPrice(oppSl, symbol)}</code>`);
    lines.push(`<b>🎯 TP:</b> <code>${fmtPrice(oppTp, symbol)}</code>`);
    lines.push(`<b>R:R:</b> 1:${fmt(signal.rr || 2, 1)}`);
  }

  /* Strategy-specific details */
  if (signal.type === "liquidity_sweep" && signal.range) {
    lines.push(``);
    lines.push(`<b>Range:</b> [${fmtPrice(signal.range.low, symbol)} – ${fmtPrice(signal.range.high, symbol)}]`);
  }
  if (signal.type === "stop_loss_hunt" && signal.level) {
    lines.push(``);
    lines.push(`<b>Key Level:</b> ${fmtPrice(signal.level.level, symbol)} (${signal.level.touches} touches)`);
  }
  if (signal.type === "failed_pin_bar" && signal.state) {
    lines.push(``);
    lines.push(`<b>State:</b> ${signal.state === "fear" ? "😱 FEAR" : "🤑 GREED"}`);
  }
  if (signal.type === "fib_scalp" && signal.goldenLow != null) {
    lines.push(``);
    lines.push(`<b>Golden Zone:</b> [${fmtPrice(signal.goldenLow, symbol)} – ${fmtPrice(signal.goldenHigh, symbol)}]`);
    lines.push(`<b>Fib Range:</b> [${fmtPrice(signal.fibLow, symbol)} – ${fmtPrice(signal.fibHigh, symbol)}]`);
  }
  if (signal.type === "grid_scalper_ma") {
    lines.push(``);
    const modeLabel = signal.mode === "bos" ? "BOS (Break of Structure)" : `Price vs MA (SMA ${gridScalperMAPeriod})`;
    lines.push(`<b>Mode:</b> ${modeLabel}`);
    if (signal.mode === "bos" && signal.breakLevel != null) {
      lines.push(`<b>Break Level:</b> ${fmt(signal.breakLevel, 4)}`);
    }
  }
  if (signal.type === "fvg_strat") {
    lines.push(``);
    if (signal.demandZoneHigh != null) {
      lines.push(`<b>📦 Demand/Supply Zone:</b> [${fmtPrice(signal.demandZoneLow, symbol)} – ${fmtPrice(signal.demandZoneHigh, symbol)}]`);
    }
    if (signal.fvgHigh != null) {
      lines.push(`<b>📊 FVG:</b> [${fmtPrice(signal.fvgLow, symbol)} – ${fmtPrice(signal.fvgHigh, symbol)}]`);
    }
    if (signal.fibLevel != null) {
      lines.push(`<b>📐 Fib Level:</b> ${fmt(signal.fibLevel * 100, 0)}% (discount zone ≤ ${fmt(FVG_FIB_DISCOUNT * 100, 0)}%)`);
    }
  }
  if (signal.type === "mtf_top_down") {
    lines.push(``);
    if (signal.mtfBias) {
      const biasEmoji = signal.mtfBias === "BULL" ? "📈" : signal.mtfBias === "BEAR" ? "📉" : "➡️";
      lines.push(`<b>${biasEmoji} HTF Bias:</b> ${signal.mtfBias}`);
    }
    if (signal.level != null) {
      lines.push(`<b>🎯 Key Level:</b> <code>${fmtPrice(signal.level, symbol)}</code>`);
    }
    if (signal.patternType) {
      const pLabel = signal.patternType === "pin_bar" ? "Pin Bar" : signal.patternType === "engulfing" ? "Engulfing" : "Micro BOS";
      lines.push(`<b>🕯 Entry Pattern:</b> ${pLabel}`);
    }
  }
  if (accountSize > 0 && riskPercent > 0 && signal.entry != null && signal.sl != null) {
    const tradeObj = { entry: signal.entry, sl: signal.sl, tp: signal.tp, rr: signal.rr || 0, symbol };
    const m = calcPositionMetrics(tradeObj);
    if (m) {
      lines.push(``);
      lines.push(`<b>💰 $ Risk:</b> $${fmt(m.dollarRisk, 2)}`);
      if (signal.tp != null) lines.push(`<b>💰 $ Reward:</b> $${fmt(m.dollarReward, 2)}`);
      lines.push(`<b>📦 Lot Size:</b> ${fmt(m.lotSize, 2)}`);
      if (!m.isSynthetic) {
        lines.push(`<b>📏 Pips at Risk:</b> ${fmt(m.pips, 1)}`);
      }
      lines.push(`<b>📐 Account:</b> $${fmt(accountSize, 2)} (${fmt(riskPercent, 1)}% risk)`);
    }
  }

  lines.push(``);
  lines.push(`<i>${ts}</i>`);
  return lines.join("\n");
}

/**
 * Send a custom strategy alert to Telegram with chart screenshot.
 * Called from processLiquiditySweep, processStopLossHunt, processFailedPinBar.
 */
async function sendTelegramStrategyAlert(signal, force = false) {
  if (!telegramStrategyAutoSend && !force) return;

  /* Sync credentials from DOM */
  if (UI.telegramBotToken) telegramBotToken = UI.telegramBotToken.value;
  if (UI.telegramChatId) telegramChatId = UI.telegramChatId.value;

  /* Check credentials are available */
  try {
    const { token, chatId } = getTelegramCredentials();
    validateTelegramCredentials(token, chatId);
  } catch (err) {
    addLog(`📤 Strategy Telegram skipped: ${err.message}`);
    return;
  }

  if (UI.telegramStatus) UI.telegramStatus.textContent = "Sending strategy alert…";
  const caption = buildStrategyTelegramCaption(signal);
  try {
    /* In multi-panel mode, capture the correct panel's chart */
    const panel = (signal.symbol && multiPanels.has(signal.symbol)) ? multiPanels.get(signal.symbol) : null;
    const blob = await captureTelegramScreenshot(panel);
    if (blob) {
      await sendTelegramPhoto(blob, caption);
    } else {
      await sendTelegramMessage(caption);
    }
    addLog(`📤 Strategy Telegram alert sent (${signal.type})`);
    if (UI.telegramStatus) {
      UI.telegramStatus.textContent = "✅ Strategy alert sent!";
      UI.telegramStatus.className = "hint telegram-status telegram-ok";
    }
  } catch (err) {
    addLog(`📤 Strategy Telegram error: ${err.message}`);
    if (UI.telegramStatus) {
      UI.telegramStatus.textContent = `❌ Strategy: ${err.message}`;
      UI.telegramStatus.className = "hint telegram-status telegram-err";
    }
  }
  setTimeout(() => {
    if (UI.telegramStatus) {
      UI.telegramStatus.textContent = "";
      UI.telegramStatus.className = "hint telegram-status";
    }
  }, TELEGRAM_STATUS_CLEAR_MS);
}

/**
 * Centralized WIN/LOSS/EXPIRED resolution-notification deduplication.
 * Every trade-resolution notification sender must consult this guard before
 * dispatching so the same trade_id + resolution_type combination can never
 * fire more than once. (Duplicate trade notification fix)
 */
const _tradeResolutionNotificationKeys = new Set();
function tradeResolutionNotificationKey(signal, resolutionType) {
  const tradeId = (signal && (signal.tradeId || signal.signalId)) ||
    `${(signal && signal.type) || "trade"}_${(signal && signal.symbol) || ""}_${signal && signal.candleIdx != null ? signal.candleIdx : (signal && signal.entryIdx)}_${(signal && signal.epoch) || ""}`;
  return `${tradeId}::${resolutionType}`;
}
function canSendTradeResolutionNotification(signal, resolutionType) {
  const key = tradeResolutionNotificationKey(signal, resolutionType);
  if (_tradeResolutionNotificationKeys.has(key)) {
    addLog(`[TRADE] Duplicate notification prevented (${key})`);
    return false;
  }
  _tradeResolutionNotificationKeys.add(key);
  addLog(`[TRADE] Resolution notification queued (${key})`);
  return true;
}

/**
 * Send strategy outcome (WIN / LOSS) via Telegram when enabled.
 * Called from monitorLiquiditySweepOutcomes, monitorStopLossHuntOutcomes,
 * monitorFailedPinBarOutcomes after a signal resolves.
 */
async function sendStrategyOutcomeTelegram(signal) {
  if (!telegramStrategyOutcomeSend) return;
  if (signal.result && !canSendTradeResolutionNotification(signal, signal.result)) return;

  /* Sync credentials from DOM and validate BEFORE marking the signal as sent,
     so that a bad-credential failure leaves _stratOutcomeSent = false and allows
     a retry once credentials are corrected. (Bug #5 fix) */
  if (UI.telegramBotToken) telegramBotToken = UI.telegramBotToken.value;
  if (UI.telegramChatId) telegramChatId = UI.telegramChatId.value;

  try {
    const { token, chatId } = getTelegramCredentials();
    validateTelegramCredentials(token, chatId);
  } catch (err) {
    addLog(`📤 Strategy outcome Telegram skipped: ${err.message}`);
    return;
  }

  /* Credentials are valid — mark sent now (before await) to prevent concurrent
     duplicate sends in the same JS event loop turn. */
  signal._stratOutcomeSent = true;

  const result = signal.result;
  const activeSym = signal.symbol || getActiveSymbol() || "";
  const sym = getSymbolLabel(activeSym);
  const dir = signal.dir === "BULL" ? "📈 BUY" : "📉 SELL";

  /* Strategy-specific emoji and label */
  let stratEmoji = "📊";
  let stratLabel = "Strategy";
  if (signal.type === "liquidity_sweep") { stratEmoji = "🌊"; stratLabel = "Liquidity Sweep"; }
  else if (signal.type === "stop_loss_hunt") { stratEmoji = "🎯"; stratLabel = "Stop Loss Hunt"; }
  else if (signal.type === "failed_pin_bar") { stratEmoji = "📌"; stratLabel = "Failed Pin Bar"; }
  else if (signal.type === "fib_scalp") { stratEmoji = "📐"; stratLabel = "Fib Golden Zone"; }
  else if (signal.type === "grid_scalper_ma") {
    stratEmoji = "🔲";
    stratLabel = `Grid Scalper MA [${signal.mode === "bos" ? "BOS" : "Price vs MA"}]`;
  }
  else if (signal.type === "fvg_strat") { stratEmoji = "🎯"; stratLabel = "Fair Value Gap"; }
  else if (signal.type === "mtf_top_down") { stratEmoji = "⏱"; stratLabel = "MTF Top-Down"; }
  else if (signal.type === "ny_open_range") { stratEmoji = "🕤"; stratLabel = "NY Open Range"; }
  else if (signal.type === "session_range") { stratEmoji = "🌍"; stratLabel = "Session Range"; }
  else if (signal.type === "power_of_3") { stratEmoji = "⚡"; stratLabel = "Power of 3"; }

  /* ── EXPIRED: distinct short message, no statistics block ── */
  if (result === "EXPIRED") {
    try {
      const entryStr = signal.entry != null ? fmtPrice(signal.entry, activeSym) : "--";
      const slStr    = signal.sl    != null ? fmtPrice(signal.sl, activeSym)    : "--";
      const tpStr    = signal.tp    != null ? fmtPrice(signal.tp, activeSym)    : "--";
      const rrStr    = signal.rr    != null ? "1:" + fmt(signal.rr, 1)          : "--";
      const lines = [];
      lines.push(`⏱ <b>${stratLabel} — Trade Expired</b> — ${dir} ${sym}`);
      lines.push("");
      lines.push(`Setup timed out — no TP or SL was hit.`);
      lines.push(`<b>📍 Entry:</b> ${entryStr}`);
      lines.push(`<b>🛑 SL:</b> ${slStr}`);
      lines.push(`<b>🎯 TP:</b> ${tpStr}`);
      lines.push(`<b>R:R:</b> ${rrStr}`);
      lines.push(`<i>${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC</i>`);
      await sendTelegramMessage(lines.join("\n"));
      addLog(`📤 Telegram: ${stratLabel} EXPIRED notification sent`);
    } catch (err) {
      addLog(`📤 Strategy expired Telegram error: ${err.message}`);
    }
    return;
  }

  /* ── WIN / LOSS ── */
  try {
    const icon = result === "WIN" ? "✅" : "❌";
    const entryStr = signal.entry != null ? fmtPrice(signal.entry, activeSym) : "--";
    /* Derive exit price: explicit value takes priority; fall back to TP (WIN) or SL (LOSS). */
    const rawExit = signal.exitPrice != null ? signal.exitPrice
      : result === "WIN" ? signal.tp
      : signal.sl;
    const exitStr  = rawExit  != null ? fmtPrice(rawExit, activeSym)  : "--";
    const slStr    = signal.sl != null ? fmtPrice(signal.sl, activeSym) : "--";
    const tpStr    = signal.tp != null ? fmtPrice(signal.tp, activeSym) : "--";
    const rrStr    = signal.rr != null ? "1:" + fmt(signal.rr, 1) : "--";

    const lines = [];
    lines.push(`${icon} <b>${stratLabel} ${result}</b> — ${dir} ${sym}`);
    lines.push("");
    lines.push(`<b>📍 Entry:</b> ${entryStr}`);
    lines.push(`<b>🏁 Exit:</b> ${exitStr}`);
    lines.push(`<b>🛑 SL:</b> ${slStr}`);
    lines.push(`<b>🎯 TP:</b> ${tpStr}`);
    lines.push(`<b>R:R:</b> ${rrStr}`);

    if (signal.type === "failed_pin_bar" && signal.state) {
      lines.push(`<b>State:</b> ${signal.state === "fear" ? "😱 FEAR" : "🤑 GREED"}`);
    }
    if (signal.type === "fib_scalp" && signal.goldenLow != null) {
      lines.push(`<b>Golden Zone:</b> [${fmtPrice(signal.goldenLow, activeSym)} – ${fmtPrice(signal.goldenHigh, activeSym)}]`);
    }
    /* Partial TP info for PO3 and any strategy that sets partialTpHit (Bug #8) */
    if (signal.partialTpHit) {
      lines.push(`<b>🔔 Partial TP:</b> Hit at 1:1 (SL moved to breakeven)`);
    }

    /* Lot size / position sizing based on account amount */
    if (accountSize > 0 && riskPercent > 0 && signal.entry != null && signal.sl != null) {
      const tradeObj = { entry: signal.entry, sl: signal.sl, tp: signal.tp, rr: signal.rr || 0, symbol: signal.symbol || getActiveSymbol() };
      const m = calcPositionMetrics(tradeObj);
      if (m) {
        lines.push(``);
        lines.push(`<b>📦 Lot Size:</b> ${fmt(m.lotSize, 2)}`);
        lines.push(`<b>💰 $ Risk:</b> $${fmt(m.dollarRisk, 2)}`);
        if (signal.tp != null) lines.push(`<b>💰 $ Reward:</b> $${fmt(m.dollarReward, 2)}`);
        if (!m.isSynthetic) {
          lines.push(`<b>📏 Pips at Risk:</b> ${fmt(m.pips, 1)}`);
        }
      }
    }

    /* Win/loss tally across ALL strategy histories — exclude EXPIRED signals */
    let totalW = 0, totalL = 0;
    const allStratHistories = [
      liquiditySweepHistory, stopLossHuntHistory, failedPinBarHistory,
      po3History, fibScalpHistory, gridScalperMAHistory,
      nyOpenRangeHistory, sessionRangeHistory, fvgStratHistory
    ];
    /* Per-strategy breakdown for this specific strategy.
       Note: this function is only called for secondary strategies — the main breakout
       strategy uses sendTradeOutcomeTelegram(), so signal.type for breakout signals is
       undefined and thisHistory will correctly be null (no per-strategy row shown). */
    let thisW = 0, thisL = 0;
    const thisHistory = signal.type === "liquidity_sweep" ? liquiditySweepHistory
      : signal.type === "stop_loss_hunt" ? stopLossHuntHistory
      : signal.type === "failed_pin_bar" ? failedPinBarHistory
      : signal.type === "fib_scalp" ? fibScalpHistory
      : signal.type === "grid_scalper_ma" ? gridScalperMAHistory
      : signal.type === "ny_open_range" ? nyOpenRangeHistory
      : signal.type === "session_range" ? sessionRangeHistory
      : signal.type === "power_of_3" ? po3History
      : signal.type === "fvg_strat" ? fvgStratHistory : null;
    for (const h of allStratHistories) {
      const isThis = h === thisHistory;
      for (const s of h) {
        if (s.result === "WIN") { totalW++; if (isThis) thisW++; }
        else if (s.result === "LOSS") { totalL++; if (isThis) thisL++; }
        /* EXPIRED signals are intentionally excluded — SL was not hit */
      }
    }
    const wr = (totalW + totalL) > 0 ? (totalW / (totalW + totalL) * 100).toFixed(1) + "%" : "N/A";
    lines.push("");
    /* Show this strategy's own record first, then combined */
    if (thisHistory && (thisW + thisL) > 0) {
      const thisWr = (thisW / (thisW + thisL) * 100).toFixed(1) + "%";
      lines.push(`${stratEmoji} <b>${stratLabel} Record:</b> ${thisW}W / ${thisL}L (${thisWr})`);
    }
    if (totalW + totalL > (thisW + thisL)) {
      lines.push(`📊 <b>All Strategies Combined:</b> ${totalW}W / ${totalL}L (${wr} win rate)`);
    } else {
      lines.push(`${stratEmoji} <b>Strategy Record:</b> ${totalW}W / ${totalL}L (${wr} win rate)`);
    }

    /* Opposite mode effectiveness from auto-trade history */
    const oppTrades = autoTradeHistory.filter(e => e.isOpposite && (e.result === "WIN" || e.result === "LOSS"));
    const normTrades = autoTradeHistory.filter(e => !e.isOpposite && (e.result === "WIN" || e.result === "LOSS"));
    if (oppTrades.length > 0 || normTrades.length > 0) {
      lines.push("");
      if (normTrades.length > 0) {
        const nw = normTrades.filter(e => e.result === "WIN").length;
        const nwr = (nw / normTrades.length * 100).toFixed(1);
        lines.push(`📈 <b>Normal Trades:</b> ${nw}W / ${normTrades.length - nw}L (${nwr}%)`);
      }
      if (oppTrades.length > 0) {
        const ow = oppTrades.filter(e => e.result === "WIN").length;
        const owr = (ow / oppTrades.length * 100).toFixed(1);
        lines.push(`🔄 <b>Opposite Trades:</b> ${ow}W / ${oppTrades.length - ow}L (${owr}%)`);
      }
    }

    lines.push(`<i>${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC</i>`);

    await sendTelegramMessage(lines.join("\n"));
    addLog(`📤 Telegram: ${stratLabel} outcome (${result}) sent`);
  } catch (err) {
    addLog(`📤 Strategy outcome Telegram error: ${err.message}`);
  }
}

/**
 * Send a profit exit alert via Telegram when a trade that reached 1:1 profit
 * reverses back to the entry level, warning the trader to protect gains.
 * @param {Object} signal   — trade signal with { dir, entry, sl, tp, rr, symbol, type }
 * @param {string} stratLabel — human-readable strategy name (e.g. "Liquidity Sweep")
 */
async function sendProfitExitAlertTelegram(signal, stratLabel) {
  if (!telegramProfitExitAlertEnabled) return;

  /* Sync credentials from DOM */
  if (UI.telegramBotToken) telegramBotToken = UI.telegramBotToken.value;
  if (UI.telegramChatId) telegramChatId = UI.telegramChatId.value;

  try {
    const { token, chatId } = getTelegramCredentials();
    validateTelegramCredentials(token, chatId);
  } catch (err) {
    addLog(`📤 Profit exit alert Telegram skipped: ${err.message}`);
    return;
  }

  try {
    const sym = getSymbolLabel(signal.symbol || getActiveSymbol() || "");
    const activeSym = signal.symbol || getActiveSymbol() || "";
    const dir = signal.dir === "BULL" ? "📈 BUY" : "📉 SELL";
    const entryStr = signal.entry != null ? fmtPrice(signal.entry, activeSym) : "--";
    const slStr    = signal.sl    != null ? fmtPrice(signal.sl, activeSym)    : "--";
    const tpStr    = signal.tp    != null ? fmtPrice(signal.tp, activeSym)    : "--";
    const rrStr    = signal.rr    != null ? "1:" + fmt(signal.rr, 1) : "--";

    const origSl = signal._origSl != null ? signal._origSl : signal.sl;
    const risk   = origSl != null && signal.entry != null ? Math.abs(signal.entry - origSl) : null;

    const lines = [];
    lines.push(`⚠️ <b>Exit with Profit — ${stratLabel}</b>`);
    lines.push(``);
    lines.push(`Trade reached <b>1:1 profit</b> but price has reversed back to entry.`);
    lines.push(`Consider closing now to protect your gains before it turns into a loss.`);
    lines.push(``);
    lines.push(`${dir} ${sym}`);
    lines.push(`<b>📍 Entry:</b> <code>${entryStr}</code>`);
    lines.push(`<b>🛑 SL:</b> <code>${slStr}</code>`);
    lines.push(`<b>🎯 TP:</b> <code>${tpStr}</code>`);
    lines.push(`<b>R:R:</b> ${rrStr}`);
    if (risk != null && risk > 0) {
      const oneRStr = signal.dir === "BULL"
        ? fmtPrice(signal.entry + risk, activeSym)
        : fmtPrice(signal.entry - risk, activeSym);
      lines.push(`<b>1R level hit:</b> <code>${oneRStr}</code>`);
    }
    lines.push(``);
    lines.push(`<i>${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC</i>`);

    await sendTelegramMessage(lines.join("\n"));
    addLog(`📤 Telegram: Profit exit alert sent for ${stratLabel}`);
  } catch (err) {
    addLog(`📤 Profit exit alert Telegram error: ${err.message}`);
  }
}

/**
 * Build a Telegram caption for session range signals (tight Asian range / London sweep).
 * @param {"TIGHT_ASIAN"|"LONDON_SWEEP"} signalType
 */
function buildSessionRangeTelegramCaption(signalType) {
  const activeSym = getActiveSymbol() || "";
  const symbol = UI.symbolSelect
    ? (UI.symbolSelect.options[UI.symbolSelect.selectedIndex]
       ? UI.symbolSelect.options[UI.symbolSelect.selectedIndex].text
       : UI.symbolSelect.value)
    : "--";
  const gran = UI.granSelect ? UI.granSelect.value : "--";
  const tfLabel = TIMEFRAME_LABELS[gran] || gran + "s";
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  const lines = [];

  if (signalType === "LONDON_SWEEP") {
    const dir = londonSweepSignal ? londonSweepSignal.dir : "--";
    const sweepEmoji = dir === "HIGH" ? "▲" : "▼";
    const reversal = dir === "HIGH" ? "bearish" : "bullish";
    lines.push(`<b>🌍 London Sweep ${sweepEmoji} Asian ${dir}</b>`);
    lines.push(``);
    lines.push(`<b>Symbol:</b> ${symbol}`);
    lines.push(`<b>Timeframe:</b> ${tfLabel}`);
    lines.push(``);
    if (sessionRangeAsian) {
      lines.push(`<b>Asian Range:</b>`);
      lines.push(`  High: <code>${fmtPrice(sessionRangeAsian.high, activeSym)}</code>`);
      lines.push(`  Low: <code>${fmtPrice(sessionRangeAsian.low, activeSym)}</code>`);
      const rangeSize = sessionRangeAsian.high - sessionRangeAsian.low;
      lines.push(`  Size: <code>${fmtPrice(rangeSize, activeSym)}</code>${asianRangeTight ? " ⚡ TIGHT" : ""}`);
    }
    if (londonSweepSignal) {
      lines.push(``);
      lines.push(`<b>Sweep Price:</b> <code>${fmtPrice(londonSweepSignal.price, activeSym)}</code>`);
      lines.push(`<b>Signal:</b> Potential ${reversal} reversal`);
    }
    if (sessionRangeTrade) {
      const trDir = sessionRangeTrade.dir === "BULL" ? "📈 BUY" : "📉 SELL";
      lines.push(``);
      lines.push(`<b>🎯 Trade Setup:</b> ${trDir}`);
      lines.push(`<b>📍 Entry:</b> <code>${fmtPrice(sessionRangeTrade.entry, activeSym)}</code>`);
      lines.push(`<b>🛑 SL:</b> <code>${fmtPrice(sessionRangeTrade.sl, activeSym)}</code>`);
      lines.push(`<b>🎯 TP:</b> <code>${fmtPrice(sessionRangeTrade.tp, activeSym)}</code>`);
      lines.push(`<b>R:R:</b> 1:${fmt(sessionRangeTrade.rr, 1)}`);
      const trRisk = Math.abs(sessionRangeTrade.entry - sessionRangeTrade.sl);
      if (trRisk > 0) {
        lines.push(`<b>Risk (pips):</b> <code>${fmtPrice(trRisk, activeSym)}</code>`);
      }
    }
    if (sessionRangeLondon) {
      lines.push(``);
      lines.push(`<b>London Range:</b>`);
      lines.push(`  High: <code>${fmtPrice(sessionRangeLondon.high, activeSym)}</code>`);
      lines.push(`  Low: <code>${fmtPrice(sessionRangeLondon.low, activeSym)}</code>`);
    }
  } else {
    /* TIGHT_ASIAN */
    lines.push(`<b>⚡ Tight Asian Range Detected</b>`);
    lines.push(``);
    lines.push(`<b>Symbol:</b> ${symbol}`);
    lines.push(`<b>Timeframe:</b> ${tfLabel}`);
    lines.push(``);
    if (sessionRangeAsian) {
      lines.push(`<b>Asian Range:</b>`);
      lines.push(`  High: <code>${fmtPrice(sessionRangeAsian.high, activeSym)}</code>`);
      lines.push(`  Low: <code>${fmtPrice(sessionRangeAsian.low, activeSym)}</code>`);
      const rangeSize = sessionRangeAsian.high - sessionRangeAsian.low;
      lines.push(`  Size: <code>${fmtPrice(rangeSize, activeSym)}</code>`);
      if (atrValue > 0) {
        lines.push(`  ATR: <code>${fmtPrice(atrValue, activeSym)}</code>`);
        lines.push(`  Ratio: ${fmt(rangeSize / atrValue, 2)}× ATR (< ${ASIAN_TIGHT_ATR_MULT}×)`);
      }
    }
    lines.push(``);
    lines.push(`<b>Signal:</b> Compression likely to expand during London session`);
  }

  if (sessionRangeNY) {
    lines.push(``);
    lines.push(`<b>NY Range:</b>`);
    lines.push(`  High: <code>${fmtPrice(sessionRangeNY.high, activeSym)}</code>`);
    lines.push(`  Low: <code>${fmtPrice(sessionRangeNY.low, activeSym)}</code>`);
  }

  lines.push(``);
  lines.push(`<i>${ts}</i>`);
  return lines.join("\n");
}

/**
 * Send a session range signal to Telegram with chart screenshot.
 * @param {"TIGHT_ASIAN"|"LONDON_SWEEP"} signalType
 * @param {string|null} panelSymbol  — if non-null, capture this panel's chart instead of the main chart
 */
async function sendTelegramSessionRangeAlert(signalType, panelSymbol) {
  if (!telegramSessionRangeAutoSend) return;

  /* Sync credentials from DOM */
  if (UI.telegramBotToken) telegramBotToken = UI.telegramBotToken.value;
  if (UI.telegramChatId) telegramChatId = UI.telegramChatId.value;

  /* Check credentials are available */
  try {
    const { token, chatId } = getTelegramCredentials();
    validateTelegramCredentials(token, chatId);
  } catch (err) {
    addLog(`📤 Session Range Telegram skipped: ${err.message}`);
    return;
  }

  const symLabel = panelSymbol ? getSymbolLabel(panelSymbol) : "";
  if (UI.telegramStatus) UI.telegramStatus.textContent = `Sending session range${symLabel ? " " + symLabel : ""}…`;
  try {
    /* In multi-panel mode, capture the correct panel's chart */
    const p = panelSymbol ? multiPanels.get(panelSymbol) : null;
    const blob = await captureTelegramScreenshot(p || null);
    /* Build caption — if in multi-panel mode, temporarily activate panel globals
       so the caption reads the correct session range data for this panel */
    let caption;
    if (p) {
      const snap = _snapshotChartGlobals();
      activatePanel(p);
      caption = buildSessionRangeTelegramCaption(signalType);
      _restoreChartGlobals(snap);
    } else {
      caption = buildSessionRangeTelegramCaption(signalType);
    }
    if (blob) {
      await sendTelegramPhoto(blob, caption);
    } else {
      await sendTelegramMessage(caption);
    }
    addLog(`📤 Session Range Telegram alert sent — ${signalType}${symLabel ? " [" + symLabel + "]" : ""}`);
    if (UI.telegramStatus) {
      UI.telegramStatus.textContent = `✅ Session range sent!${symLabel ? " (" + symLabel + ")" : ""}`;
      UI.telegramStatus.className = "hint telegram-status telegram-ok";
    }
  } catch (err) {
    addLog(`📤 Session Range Telegram error: ${err.message}`);
    if (UI.telegramStatus) {
      UI.telegramStatus.textContent = `❌ Session: ${err.message}`;
      UI.telegramStatus.className = "hint telegram-status telegram-err";
    }
  }
  setTimeout(() => {
    if (UI.telegramStatus) {
      UI.telegramStatus.textContent = "";
      UI.telegramStatus.className = "hint telegram-status";
    }
  }, TELEGRAM_STATUS_CLEAR_MS);
}

function renderScalpAlerts() {
  if (!UI.scalpAlertList) return;
  UI.scalpAlertList.innerHTML = "";
  const allScalps = getAggregatedScalpHistory();
  for (const s of allScalps) {
    const li = document.createElement("li");
    li.className = "scalp-alert-item " + (s.dir === "BULL" ? "scalp-bull" : "scalp-bear");
    const t = new Date(s.epoch * 1000);
    const ts = t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    li.innerHTML =
      `<span class="scalp-dir">${s.dir === "BULL" ? "▲ BUY" : "▼ SELL"}</span>` +
      (s.symbol ? `<span class="scalp-symbol">${s.symbol}</span>` : "") +
      `<span class="scalp-price">@ ${fmtPrice(s.entry, s.symbol)}</span>` +
      `<span class="scalp-conf">${s.conf}/7</span>` +
      `<span class="scalp-time">${ts}</span>` +
      `<div class="scalp-reasons">${s.reasons.join(" · ")}</div>` +
      `<div class="scalp-levels">SL: ${fmtPrice(s.sl, s.symbol)} &nbsp;|&nbsp; TP: ${fmtPrice(s.tp, s.symbol)}</div>`;
    UI.scalpAlertList.appendChild(li);
  }
  if (UI.scalpAlertCount) UI.scalpAlertCount.textContent = allScalps.length;
}

function showScalpBanner(scalp) {
  if (!UI.scalpAlertBanner) return;
  const symRaw = getActiveSymbol() || "--";
  const symbol = UI.symbolSelect ? (UI.symbolSelect.options[UI.symbolSelect.selectedIndex]?.text || symRaw) : symRaw;
  const dirLabel = scalp.dir === "BULL" ? "▲ BUY" : "▼ SELL";
  UI.scalpAlertBannerText.textContent = `⚡ SCALP ${dirLabel}  ${symbol}  @ ${fmt(scalp.entry, 4)}  —  Conf ${scalp.conf}/7  —  ${scalp.reasons.slice(0, 3).join(" · ")}`;
  UI.scalpAlertBanner.className = "scalp-banner scalp-banner-show " + (scalp.dir === "BULL" ? "scalp-banner-bull" : "scalp-banner-bear");
  /* Auto-hide after 12 seconds */
  clearTimeout(UI.scalpAlertBanner._hideTimer);
  UI.scalpAlertBanner._hideTimer = setTimeout(() => {
    if (UI.scalpAlertBanner) UI.scalpAlertBanner.classList.remove("scalp-banner-show");
  }, 12000);
}

/* ================= EMA TREND FILTER ================= */
/**
 * Returns true if the EMA 8/21 crossover aligns with the given breakout direction.
 * If emaFilterEnabled is off, always returns true.
 */
function isEmaAligned(dir) {
  if (!emaFilterEnabled) return true;
  const lastFast = emaFast.length > 0 ? emaFast[emaFast.length - 1] : null;
  const lastSlow = emaSlow.length > 0 ? emaSlow[emaSlow.length - 1] : null;
  if (lastFast == null || lastSlow == null) return true; /* not enough data */
  if (dir === "BULL") return lastFast > lastSlow;
  if (dir === "BEAR") return lastFast < lastSlow;
  return true;
}

/* ================= HTF TREND (EMA 100 PROXY) ================= */
/**
 * Returns the higher-timeframe trend direction based on EMA 100.
 * Price above EMA 100 = BULL, below = BEAR, within 0.1% = FLAT.
 */
function getHTFTrend() {
  const lastHTF = emaHTF.length > 0 ? emaHTF[emaHTF.length - 1] : null;
  const lastPrice = candles.length > 0 ? candles[candles.length - 1].close : null;
  if (lastHTF == null || lastPrice == null) return "FLAT";
  if (lastPrice > lastHTF * 1.001) return "BULL";
  if (lastPrice < lastHTF * 0.999) return "BEAR";
  return "FLAT";
}

/**
 * Returns true if the HTF trend agrees with the breakout direction.
 * If htfFilterEnabled is off, always returns true.
 * "FLAT" trend allows both directions.
 */
function isHTFAligned(dir) {
  if (!htfFilterEnabled) return true;
  const trend = getHTFTrend();
  if (trend === "FLAT") return true;
  return trend === dir;
}

/* ================= RSI AT RETEST ================= */
/**
 * Returns true if the RSI confirms the pullback has room to reverse.
 * For BULL retest: RSI should be ≤ RSI_RETEST_BULL_MAX (pulled back enough).
 * For BEAR retest: RSI should be ≥ RSI_RETEST_BEAR_MIN (bounced enough).
 * If rsiFilterEnabled is off, always returns true.
 */
function isRSIFavorable(dir) {
  if (!rsiFilterEnabled) return true;
  if (rsiValues.length === 0) return true;
  const currentRSI = rsiValues[rsiValues.length - 1];
  if (currentRSI == null) return true;
  if (dir === "BULL") return currentRSI <= RSI_RETEST_BULL_MAX;
  if (dir === "BEAR") return currentRSI >= RSI_RETEST_BEAR_MIN;
  return true;
}

/* ================= VOLUME SPIKE ON BREAKOUT ================= */
/**
 * Checks if the breakout candle has a significantly larger range than
 * the average of recent candles, serving as a volume/momentum proxy.
 * Synthetic indices have no tick volume, so range is the best proxy.
 * If volumeSpikeEnabled is off, always returns true.
 * @param {number} candleIdx - index of the breakout candle in the candles array
 */
function hasVolumeSpikeOnBreakout(candleIdx) {
  if (!volumeSpikeEnabled) return true;
  if (candleIdx < 0 || candleIdx >= candles.length) return true;
  const startIdx = Math.max(0, candleIdx - VOLUME_SPIKE_LOOKBACK);
  if (startIdx >= candleIdx) return true;
  let sumRange = 0;
  let count = 0;
  for (let i = startIdx; i < candleIdx; i++) {
    sumRange += candles[i].high - candles[i].low;
    count++;
  }
  if (count === 0) return true;
  const avgRange = sumRange / count;
  if (avgRange <= 0) return true;
  const tuning = getMarketTuning();
  const effectiveMult = VOLUME_SPIKE_MULT * tuning.volumeSpikeMult;
  const breakoutRange = candles[candleIdx].high - candles[candleIdx].low;
  return breakoutRange >= avgRange * effectiveMult;
}

/* ================= SESSION FILTER ================= */
/**
 * Returns true if the current UTC hour falls within the active trading session.
 * Sessions help avoid low-liquidity periods that produce noisy signals.
 * If sessionFilterEnabled is off, always returns true.
 */
function isWithinActiveSession() {
  if (!sessionFilterEnabled) return true;
  const hour = new Date().getUTCHours();
  switch (sessionFilterMode) {
    case "london":
      return hour >= SESSION_LONDON.start && hour < SESSION_LONDON.end;
    case "new_york":
      return hour >= SESSION_NEW_YORK.start && hour < SESSION_NEW_YORK.end;
    case "overlap":
      /* Overlap = intersection of London and New York sessions */
      return hour >= Math.max(SESSION_LONDON.start, SESSION_NEW_YORK.start) &&
             hour < Math.min(SESSION_LONDON.end, SESSION_NEW_YORK.end);
    case "asian":
      return hour >= SESSION_ASIAN.start && hour < SESSION_ASIAN.end;
    case "london_ny":
    default:
      return (hour >= SESSION_LONDON.start && hour < SESSION_LONDON.end) ||
             (hour >= SESSION_NEW_YORK.start && hour < SESSION_NEW_YORK.end);
  }
}

function getActiveSessionName() {
  const hour = new Date().getUTCHours();
  const sessions = [];
  if (hour >= SESSION_LONDON.start && hour < SESSION_LONDON.end) sessions.push("London");
  if (hour >= SESSION_NEW_YORK.start && hour < SESSION_NEW_YORK.end) sessions.push("NY");
  if (hour >= SESSION_ASIAN.start && hour < SESSION_ASIAN.end) sessions.push("Asian");
  return sessions.length > 0 ? sessions.join("/") : "Off-Hours";
}

/* ================= FIBONACCI AT RETEST ================= */
/**
 * Finds the nearest Fibonacci retracement level to a price level.
 * Uses the swing from the lookback period before/including the opening range.
 * Returns { level, ratio, from } if within tolerance, or null.
 */
function getFibRetestLevel(level) {
  if (!fibRetestEnabled || !openingRange) return null;
  const lookbackEnd = Math.min(openingRange.endIdx, candles.length - 1);
  const lookbackStart = Math.max(0, lookbackEnd - SWING_LOOKBACK_PERIOD);
  if (lookbackEnd < lookbackStart) return null;

  let swingHigh = -Infinity, swingLow = Infinity;
  for (let i = lookbackStart; i <= lookbackEnd; i++) {
    if (candles[i].high > swingHigh) swingHigh = candles[i].high;
    if (candles[i].low < swingLow) swingLow = candles[i].low;
  }

  const swingRange = swingHigh - swingLow;
  if (swingRange <= 0) return null;
  const tolerance = atrValue > 0
    ? atrValue * FIB_TOLERANCE_ATR_MULT
    : swingRange * 0.02;

  for (const fib of FIB_LEVELS) {
    const fibFromHigh = swingHigh - swingRange * fib;
    if (Math.abs(level - fibFromHigh) <= tolerance) {
      return { level: fibFromHigh, ratio: fib, from: "high" };
    }
    const fibFromLow = swingLow + swingRange * fib;
    if (Math.abs(level - fibFromLow) <= tolerance) {
      return { level: fibFromLow, ratio: fib, from: "low" };
    }
  }
  return null;
}

function hasFibConfluence(level) {
  return getFibRetestLevel(level) !== null;
}

/* ================= BREAKOUT STRENGTH (VOLUME PROXY) ================= */
/**
 * Checks breakout conviction by comparing candle range AND body size to ATR.
 * A strong breakout candle should have:
 *   - range >= 80% of ATR
 *   - body (|close-open|) >= 60% of candle range (strong directional move)
 * When ATR data is unavailable, returns true (no filter).
 */
function hasBreakoutConviction(candle) {
  if (atrValue <= 0) return true;
  const tuning = getMarketTuning();
  const candleRange = candle.high - candle.low;
  const bodySize = Math.abs(candle.close - candle.open);
  const rangeOk = candleRange >= atrValue * 0.8 * tuning.breakoutConvictionMult;
  const bodyOk = candleRange > 0 ? bodySize >= candleRange * 0.6 : false;
  return rangeOk && bodyOk;
}

/* ================= PIN BAR / HAMMER / SHOOTING STAR ================= */
/**
 * Detects pin bar patterns (hammer for bullish, shooting star for bearish).
 * A pin bar has a small body and a long tail (shadow) in the rejection direction.
 * The tail must be >= PIN_BAR_TAIL_RATIO × the body length.
 * @param {object} c - candle object
 * @param {string|null} dir - if provided, only detect pin bars in that direction
 * @returns {boolean}
 */
function isPinBar(c, dir) {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (range === 0) return false;
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;

  /* Hammer / bullish pin bar: long lower wick, small body at top */
  if (!dir || dir === "BULL") {
    if (lowerWick >= body * PIN_BAR_TAIL_RATIO && lowerWick > upperWick * PIN_BAR_WICK_DOMINANCE) {
      return true;
    }
  }
  /* Shooting star / bearish pin bar: long upper wick, small body at bottom */
  if (!dir || dir === "BEAR") {
    if (upperWick >= body * PIN_BAR_TAIL_RATIO && upperWick > lowerWick * PIN_BAR_WICK_DOMINANCE) {
      return true;
    }
  }
  return false;
}

/* ================= INSIDE BAR DETECTION ================= */
/**
 * Returns true if 'curr' candle is completely contained within 'prev' candle range.
 * The inside bar indicates consolidation/indecision before a breakout.
 */
function isInsideBar(prev, curr) {
  if (!prev || !curr) return false;
  return curr.high <= prev.high && curr.low >= prev.low;
}

/**
 * Returns true if 'curr' breaks out of the inside bar 'mother' in the given direction.
 */
function isInsideBarBreakout(mother, curr, dir) {
  if (!mother || !curr) return false;
  if (dir === "BULL") return curr.close > mother.high;
  if (dir === "BEAR") return curr.close < mother.low;
  return false;
}

/* ================= MORNING STAR / EVENING STAR ================= */
/**
 * Morning Star: 3-candle bullish reversal.
 *   c1 = large bearish, c2 = small-bodied (star), c3 = large bullish closing into c1.
 */
function isMorningStar(c1, c2, c3) {
  if (!c1 || !c2 || !c3) return false;
  const c1Body = c1.close - c1.open;
  const c2Body = Math.abs(c2.close - c2.open);
  const c3Body = c3.close - c3.open;
  const c1Range = c1.high - c1.low;

  if (c1Body >= 0) return false;              /* c1 must be bearish */
  if (c3Body <= 0) return false;              /* c3 must be bullish */
  if (c1Range === 0) return false;
  if (c2Body / c1Range > STAR_BODY_RATIO) return false;  /* c2 must be small relative to c1 */
  /* c3 should close well into c1's body (at least 50%) */
  const c1MidBody = (c1.open + c1.close) / 2;
  return c3.close >= c1MidBody;
}

/**
 * Evening Star: 3-candle bearish reversal.
 *   c1 = large bullish, c2 = small-bodied (star), c3 = large bearish closing into c1.
 */
function isEveningStar(c1, c2, c3) {
  if (!c1 || !c2 || !c3) return false;
  const c1Body = c1.close - c1.open;
  const c2Body = Math.abs(c2.close - c2.open);
  const c3Body = c3.close - c3.open;
  const c1Range = c1.high - c1.low;

  if (c1Body <= 0) return false;              /* c1 must be bullish */
  if (c3Body >= 0) return false;              /* c3 must be bearish */
  if (c1Range === 0) return false;
  if (c2Body / c1Range > STAR_BODY_RATIO) return false;  /* c2 must be small relative to c1 */
  /* c3 should close well into c1's body (at least 50%) */
  const c1MidBody = (c1.open + c1.close) / 2;
  return c3.close <= c1MidBody;
}

/* ================= PIERCING LINE / DARK CLOUD COVER ================= */
/**
 * Piercing Line (bullish): 2-candle reversal at bottom.
 *   c1 = bearish, c2 = bullish opening below c1 low, closing above midpoint of c1 body.
 * From FOREX_MILLIONAIRE_365_DAYS: Listed among the 7 powerful reversal patterns.
 */
function isPiercingLine(prev, curr) {
  if (!prev || !curr) return false;
  const prevBody = prev.close - prev.open;
  const currBody = curr.close - curr.open;
  if (prevBody >= 0 || currBody <= 0) return false;  /* prev bearish, curr bullish */
  const prevMid = (prev.open + prev.close) / 2;      /* midpoint of prev body */
  /* curr opens below prev low, closes above midpoint but not above prev open (not engulfing) */
  return curr.open <= prev.low && curr.close >= prevMid && curr.close < prev.open;
}

/**
 * Dark Cloud Cover (bearish): 2-candle reversal at top.
 *   c1 = bullish, c2 = bearish opening above c1 high, closing below midpoint of c1 body.
 * From FOREX_MILLIONAIRE_365_DAYS: Listed among the 7 powerful reversal patterns.
 */
function isDarkCloudCover(prev, curr) {
  if (!prev || !curr) return false;
  const prevBody = prev.close - prev.open;
  const currBody = curr.close - curr.open;
  if (prevBody <= 0 || currBody >= 0) return false;  /* prev bullish, curr bearish */
  const prevMid = (prev.open + prev.close) / 2;      /* midpoint of prev body */
  /* curr opens above prev high, closes below midpoint but not below prev open (not engulfing) */
  return curr.open >= prev.high && curr.close <= prevMid && curr.close > prev.open;
}

/* ================= DRAGONFLY / GRAVESTONE DOJI ================= */
/**
 * Dragonfly Doji: long lower shadow, no upper shadow, open ≈ close ≈ high.
 * Bullish reversal at bottom of downtrend.
 * From FOREX_MILLIONAIRE_365_DAYS: "Sellers pushed down, buyers pushed back up."
 */
function isDragonflyDoji(c) {
  if (!c) return false;
  const range = c.high - c.low;
  if (range === 0) return false;
  const body = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  return (body / range < DOJI_BODY_RATIO) && (lowerWick / range > 0.6) && (upperWick / range < 0.1);
}

/**
 * Gravestone Doji: long upper shadow, no lower shadow, open ≈ close ≈ low.
 * Bearish reversal at top of uptrend.
 * From FOREX_MILLIONAIRE_365_DAYS: "Buyers pushed up, sellers pushed back down."
 */
function isGravestoneDoji(c) {
  if (!c) return false;
  const range = c.high - c.low;
  if (range === 0) return false;
  const body = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  return (body / range < DOJI_BODY_RATIO) && (upperWick / range > 0.6) && (lowerWick / range < 0.1);
}

/* ================= TWEEZERS TOPS & BOTTOMS ================= */
/**
 * Tweezers: Two candles with matching highs (tops) or matching lows (bottoms).
 * From FOREX_MILLIONAIRE_365_DAYS: "Market tested level twice and was rejected."
 *
 * Returns "top" | "bottom" | null.
 */
function isTweezers(prev, curr) {
  if (!prev || !curr) return null;
  const tolerance = Math.max(prev.high, curr.high) * TWEEZERS_TOLERANCE_PCT;

  /* Tweezers Top: matching highs, prev bullish + curr bearish */
  if (Math.abs(prev.high - curr.high) <= tolerance) {
    if (prev.close > prev.open && curr.close < curr.open) return "top";
  }
  /* Tweezers Bottom: matching lows, prev bearish + curr bullish */
  if (Math.abs(prev.low - curr.low) <= tolerance) {
    if (prev.close < prev.open && curr.close > curr.open) return "bottom";
  }
  return null;
}

/* ================= RAILWAY TRACK (2-Candle Reversal) ================= */
/**
 * Railway Track: Two consecutive candles of nearly equal body length but
 * opposite direction — a sharp reversal signal.
 * From TRENDLINE_TRADING_STRATEGY.md: Listed as the 7th powerful reversal
 * candlestick pattern alongside doji, engulfing, piercing/dark cloud,
 * harami, hammer/shooting star, and spinning top.
 *
 * Bullish Railway Track: bearish candle followed by bullish candle of similar size.
 * Bearish Railway Track: bullish candle followed by bearish candle of similar size.
 * Bodies must be ≥ 60% of each candle's range (strong conviction candles)
 * and body sizes within 30% of each other.
 *
 * Returns "bull" | "bear" | null.
 */
const RAILWAY_BODY_RANGE_MIN = 0.6;   /* min body/range ratio for each candle */
const RAILWAY_BODY_SIZE_TOL  = 0.30;  /* max difference ratio between body sizes */

function isRailwayTrack(prev, curr) {
  if (!prev || !curr) return null;
  const prevRange = prev.high - prev.low;
  const currRange = curr.high - curr.low;
  if (prevRange === 0 || currRange === 0) return null;
  const prevBody = prev.close - prev.open;          /* signed */
  const currBody = curr.close - curr.open;          /* signed */
  const absPrevBody = Math.abs(prevBody);
  const absCurrBody = Math.abs(currBody);
  /* Both candles must have strong bodies */
  if (absPrevBody / prevRange < RAILWAY_BODY_RANGE_MIN) return null;
  if (absCurrBody / currRange < RAILWAY_BODY_RANGE_MIN) return null;
  /* Opposite direction */
  if (prevBody * currBody >= 0) return null;         /* same sign = not opposite */
  /* Similar body size (within tolerance) */
  const maxBody = Math.max(absPrevBody, absCurrBody);
  if (maxBody === 0) return null;
  if (Math.abs(absPrevBody - absCurrBody) / maxBody > RAILWAY_BODY_SIZE_TOL) return null;
  /* Bullish: prev bearish, curr bullish; Bearish: prev bullish, curr bearish */
  return currBody > 0 ? "bull" : "bear";
}

/* ================= SPIKE REJECTION STRATEGY (Boom/Crash/DEX) ================= */
/**
 * MD-file strategy: Pin Bar Rejection after Spike.
 * From FOREX_MILLIONAIRE_365_DAYS: "Longer tail = more powerful signal" and
 * pin bars at key levels (S/R) are the highest-probability reversal signals.
 *
 * For Boom indices: after an upward spike, look for bearish pin bars
 * (shooting stars) at the spike high → signals spike exhaustion / pullback.
 * For Crash indices: after a downward spike, look for bullish pin bars
 * (hammers) at the spike low → signals spike exhaustion / bounce.
 * For DEX indices: same spike-aware logic — UP variants spike up, DN spike down.
 *
 * Returns { detected, type, dir } or null.
 */
function detectSpikeRejection(idx) {
  const mtype = getMarketType();
  if (mtype !== "boom" && mtype !== "crash" && mtype !== "dex") return null;
  if (idx < 2 || idx >= candles.length) return null;

  const prev = candles[idx - 1];
  const curr = candles[idx];

  /* Determine spike direction based on market type */
  let checkBullSpike = false;
  let checkBearSpike = false;
  if (mtype === "boom") {
    checkBullSpike = true;
  } else if (mtype === "crash") {
    checkBearSpike = true;
  } else if (mtype === "dex") {
    /* DEX UP variants spike up, DEX DN variants spike down */
    const sym = _multiPanelProcessing || (UI.symbolSelect ? UI.symbolSelect.value : "");
    if (/UP$/i.test(sym)) checkBullSpike = true;
    else if (/DN$/i.test(sym)) checkBearSpike = true;
    else { checkBullSpike = true; checkBearSpike = true; }  /* unknown DEX variant: check both directions */
  }

  /* Check if previous candle was a spike */
  if (checkBullSpike && isSpikeCandle(prev, "BULL")) {
    const label = mtype === "dex" ? "DEX UP" : "Boom";
    /* After bullish spike, look for bearish pin bar (shooting star) = rejection */
    if (isPinBar(curr, "BEAR")) {
      return { detected: true, type: "spike_rejection_pinbar", dir: "BEAR",
               desc: `Bearish pin bar after ${label} spike — exhaustion signal` };
    }
    /* Or a bearish engulfing of the spike = power shift */
    if (isBearishEngulfing(prev, curr)) {
      return { detected: true, type: "spike_rejection_engulfing", dir: "BEAR",
               desc: `Bearish engulfing after ${label} spike — sellers taking control` };
    }
  }

  if (checkBearSpike && isSpikeCandle(prev, "BEAR")) {
    const label = mtype === "dex" ? "DEX DN" : "Crash";
    /* After bearish spike, look for bullish pin bar (hammer) = rejection */
    if (isPinBar(curr, "BULL")) {
      return { detected: true, type: "spike_rejection_pinbar", dir: "BULL",
               desc: `Bullish pin bar after ${label} spike — exhaustion signal` };
    }
    /* Or a bullish engulfing of the spike = power shift */
    if (isBullishEngulfing(prev, curr)) {
      return { detected: true, type: "spike_rejection_engulfing", dir: "BULL",
               desc: `Bullish engulfing after ${label} spike — buyers taking control` };
    }
  }

  return null;
}

/* ================= INSIDE BAR FALSE BREAKOUT (Boom/Crash) ================= */
/**
 * MD-file strategy: Inside Bar False Breakout.
 * From FOREX_MILLIONAIRE_365_DAYS: "One of the most powerful price action strategies"
 * and "Banks and institutions use stop-hunting strategies to create liquidity."
 *
 * Detects when price breaks out of an inside bar pattern then quickly reverses
 * back inside the mother bar range — a trap/stop-hunt signal.
 * Especially powerful on Boom/Crash where spikes create false breakouts.
 *
 * Returns { detected, dir, motherIdx } or null.
 */
function detectInsideBarFalseBreakout(idx) {
  if (idx < 3 || idx >= candles.length) return null;

  /* Look back up to 3 candles for an inside bar + false breakout sequence */
  for (let i = idx - 2; i >= Math.max(0, idx - 4); i--) {
    const mother = candles[i];
    const child = candles[i + 1];
    if (!isInsideBar(mother, child)) continue;

    /* Check candles after the inside bar for false breakout + reversal */
    for (let j = i + 2; j <= idx; j++) {
      const breakoutCandle = candles[j];
      const motherMid = (mother.high + mother.low) / 2;
      /* Bullish false breakout: broke below mother.low then closed back inside upper half */
      if (breakoutCandle.low < mother.low && breakoutCandle.close > motherMid && breakoutCandle.close <= mother.high) {
        return { detected: true, dir: "BULL", motherIdx: i,
                 desc: "Inside bar false breakout (bear trap) — bullish reversal" };
      }
      /* Bearish false breakout: broke above mother.high then closed back inside lower half */
      if (breakoutCandle.high > mother.high && breakoutCandle.close < motherMid && breakoutCandle.close >= mother.low) {
        return { detected: true, dir: "BEAR", motherIdx: i,
                 desc: "Inside bar false breakout (bull trap) — bearish reversal" };
      }
    }
  }
  return null;
}

/* ================= DRIFT SWITCH REGIME DETECTION ================= */
/**
 * Drift Switch indices alternate between bullish, bearish, and sideways regimes.
 * Detect the current regime via EMA 8/21 crossover:
 *   - EMA 8 > EMA 21 → bullish regime
 *   - EMA 8 < EMA 21 → bearish regime
 * Also detect recent regime switches (crossover in last N candles).
 *
 * Returns { regime, recentSwitch, desc } or null if insufficient data.
 */
const DRIFT_SWITCH_LOOKBACK = 10; /* candles to check for recent EMA crossover */

function detectDriftSwitchRegime() {
  if (emaFast.length < 2 || emaSlow.length < 2) return null;
  const lastFast = emaFast[emaFast.length - 1];
  const lastSlow = emaSlow[emaSlow.length - 1];
  if (lastFast == null || lastSlow == null) return null;

  const regime = lastFast > lastSlow ? "BULL" : lastFast < lastSlow ? "BEAR" : "FLAT";

  /* Check for recent EMA crossover (regime switch) */
  let recentSwitch = false;
  const checkLen = Math.min(DRIFT_SWITCH_LOOKBACK, emaFast.length - 1, emaSlow.length - 1);
  for (let i = 1; i <= checkLen; i++) {
    const fi = emaFast[emaFast.length - 1 - i];
    const si = emaSlow[emaSlow.length - 1 - i];
    if (fi == null || si == null) continue;
    /* Previous was opposite? → crossover happened */
    if ((regime === "BULL" && fi < si) || (regime === "BEAR" && fi > si)) {
      recentSwitch = true;
      break;
    }
  }

  const desc = recentSwitch
    ? `Drift Switch regime switch to ${regime} detected (EMA 8/${regime === "BULL" ? ">" : "<"} EMA 21 crossover)`
    : `Drift Switch in ${regime} regime (EMA 8 ${regime === "BULL" ? ">" : "<"} EMA 21)`;
  return { regime, recentSwitch, desc };
}

/* ================= DAILY RESET PREFERRED DIRECTION ================= */
/**
 * Daily Reset indices have a natural trend direction:
 *   - RDBULL → trending BULL (up)
 *   - RDBEAR → trending BEAR (down)
 * Returns "BULL" | "BEAR" | null.
 */
function getDailyResetPreferredDir() {
  const sym = _multiPanelProcessing || (UI.symbolSelect ? UI.symbolSelect.value : "");
  if (/^RDBULL/i.test(sym)) return "BULL";
  if (/^RDBEAR/i.test(sym)) return "BEAR";
  return null;
}

/* ================= SUPPLY/DEMAND ZONE DETECTION (Jump Indices) ================= */
/**
 * MD-file strategy: Supply & Demand Zones.
 * From FOREX_MILLIONAIRE_365_DAYS: Quality S&D zones have
 * "Quick, strong departure from zone" — exactly what Jump candles produce.
 *
 * Scans recent candles for zones where price departed rapidly (jump candle),
 * then checks if current price has returned to that zone.
 * Returns { zone, type } or null.
 */
const SD_ZONE_LOOKBACK = 30;
const SD_ZONE_TOUCH_TOLERANCE = 0.5; /* ATR multiplier for zone proximity */

function detectSupplyDemandZone(idx) {
  if (idx < 2 || idx >= candles.length || atrValue <= 0) return null;
  const currentPrice = candles[idx].close;
  const tolerance = atrValue * SD_ZONE_TOUCH_TOLERANCE;
  const lookbackStart = Math.max(0, idx - SD_ZONE_LOOKBACK);

  for (let i = lookbackStart; i < idx - 1; i++) {
    if (!isJumpCandle(i)) continue;
    const jumpC = candles[i];
    const body = jumpC.close - jumpC.open;

    if (body > 0) {
      /* Bullish jump → created a demand zone at the jump's low area */
      const demandZoneTop = Math.min(jumpC.open, jumpC.close);
      const demandZoneBot = jumpC.low;
      if (currentPrice >= demandZoneBot - tolerance && currentPrice <= demandZoneTop + tolerance) {
        return { zone: { top: demandZoneTop, bottom: demandZoneBot }, type: "demand",
                 desc: "Price returning to demand zone from bullish jump — buy opportunity" };
      }
    } else if (body < 0) {
      /* Bearish jump → created a supply zone at the jump's high area */
      const supplyZoneBot = Math.max(jumpC.open, jumpC.close);
      const supplyZoneTop = jumpC.high;
      if (currentPrice >= supplyZoneBot - tolerance && currentPrice <= supplyZoneTop + tolerance) {
        return { zone: { top: supplyZoneTop, bottom: supplyZoneBot }, type: "supply",
                 desc: "Price returning to supply zone from bearish jump — sell opportunity" };
      }
    }
  }
  return null;
}

/* ================= MOMENTUM IMPULSE DETECTION (Jump Indices) ================= */
/**
 * MD-file strategy: Momentum / Impulsive Move.
 * From FOREX_MILLIONAIRE_365_DAYS: "Best place to buy is at beginning of impulsive move."
 *
 * Detects the start of an impulsive move by looking for:
 * 1. A jump/gap candle (the impulse trigger)
 * 2. Followed by continuation in the same direction (momentum confirmation)
 * Returns { dir, strength } or null.
 */
function detectMomentumImpulse(idx) {
  if (idx < 3 || idx >= candles.length) return null;

  /* Check if the previous 2-3 candles show impulse pattern */
  for (let start = idx - 2; start >= Math.max(0, idx - 3); start--) {
    if (!isJumpCandle(start)) continue;
    const jumpDir = candles[start].close > candles[start].open ? "BULL" : "BEAR";

    /* Check subsequent candles continue in the same direction */
    let continuation = 0;
    for (let j = start + 1; j <= idx; j++) {
      const dir = candles[j].close > candles[j].open ? "BULL" : "BEAR";
      if (dir === jumpDir) continuation++;
    }

    if (continuation >= 1) {
      return { dir: jumpDir, strength: continuation,
               desc: `Momentum impulse ${jumpDir} — ${continuation + 1} candles in same direction after jump` };
    }
  }
  return null;
}

/* ================= TRENDLINE TOUCH (Step Index) ================= */
/**
 * MD-file strategy: Trendline Third-Touch Entry.
 * From TRENDLINE_TRADING_STRATEGY: "You enter on point 3, 4, 5 after the pullback"
 * and "Only wait for the third touch before considering trendline valid."
 *
 * For Step Index's orderly movement, we detect swing lows (uptrend) or
 * swing highs (downtrend) that align on a trendline, and count touches.
 * Returns { dir, touches, slope } or null when ≥ 3 touches found.
 */
const TRENDLINE_MIN_TOUCHES = 3;
const TRENDLINE_TOLERANCE_ATR = 0.3;

function detectTrendlineTouch(idx) {
  if (idx < 10 || idx >= candles.length || atrValue <= 0) return null;
  const tolerance = atrValue * TRENDLINE_TOLERANCE_ATR;
  const lookback = Math.max(0, idx - 40);

  /* Collect recent swing lows for uptrend trendline */
  const swingLows = [];
  for (let i = lookback + SWING_NEIGHBOR_BARS; i <= idx - SWING_NEIGHBOR_BARS; i++) {
    if (isTrueSwingLow(i)) swingLows.push({ idx: i, price: candles[i].low });
  }

  /* Collect recent swing highs for downtrend trendline */
  const swingHighs = [];
  for (let i = lookback + SWING_NEIGHBOR_BARS; i <= idx - SWING_NEIGHBOR_BARS; i++) {
    if (isTrueSwingHigh(i)) swingHighs.push({ idx: i, price: candles[i].high });
  }

  /* Check ascending trendline (connect swing lows) — bullish */
  if (swingLows.length >= 2) {
    const first = swingLows[0];
    const last = swingLows[swingLows.length - 1];
    if (last.idx !== first.idx) {
      const slope = (last.price - first.price) / (last.idx - first.idx);
      if (slope > 0) {
        let touches = 0;
        for (const sw of swingLows) {
          const expected = first.price + slope * (sw.idx - first.idx);
          if (Math.abs(sw.price - expected) <= tolerance) touches++;
        }
        /* Check if current candle is near the trendline */
        const expectedNow = first.price + slope * (idx - first.idx);
        const currentLow = candles[idx].low;
        if (touches >= TRENDLINE_MIN_TOUCHES && Math.abs(currentLow - expectedNow) <= tolerance) {
          return { dir: "BULL", touches, slope,
                   desc: `Ascending trendline touch #${touches} — buy on pullback to support` };
        }
      }
    }
  }

  /* Check descending trendline (connect swing highs) — bearish */
  if (swingHighs.length >= 2) {
    const first = swingHighs[0];
    const last = swingHighs[swingHighs.length - 1];
    if (last.idx !== first.idx) {
      const slope = (last.price - first.price) / (last.idx - first.idx);
      if (slope < 0) {
        let touches = 0;
        for (const sw of swingHighs) {
          const expected = first.price + slope * (sw.idx - first.idx);
          if (Math.abs(sw.price - expected) <= tolerance) touches++;
        }
        const expectedNow = first.price + slope * (idx - first.idx);
        const currentHigh = candles[idx].high;
        if (touches >= TRENDLINE_MIN_TOUCHES && Math.abs(currentHigh - expectedNow) <= tolerance) {
          return { dir: "BEAR", touches, slope,
                   desc: `Descending trendline touch #${touches} — sell on pullback to resistance` };
        }
      }
    }
  }

  return null;
}

/* ================= DYNAMIC MA SUPPORT/RESISTANCE (Step Index) ================= */
/**
 * MD-file strategy: Moving Average (8 & 21 SMA) as Dynamic S/R.
 * From FOREX_MILLIONAIRE_365_DAYS: MA acts as "dynamic support" (uptrend) or
 * "dynamic resistance" (downtrend). "Very important factor of confluence."
 *
 * Checks if price is bouncing off EMA 8 or EMA 21.
 * Returns { level, ema, dir } or null.
 */
function detectMABounce(idx) {
  if (idx < 1 || idx >= candles.length) return null;
  if (emaFast.length <= idx || emaSlow.length <= idx) return null;
  const fast = emaFast[idx];
  const slow = emaSlow[idx];
  if (fast == null || slow == null) return null;

  const c = candles[idx];
  const tolerance = atrValue > 0 ? atrValue * 0.3 : (c.high - c.low) * 0.5;

  /* In uptrend (fast > slow): look for price bouncing off EMA as support */
  if (fast > slow) {
    if (c.low <= fast + tolerance && c.close > fast) {
      return { level: fast, ema: "EMA8", dir: "BULL",
               desc: "Price bouncing off EMA 8 support — bullish continuation" };
    }
    if (c.low <= slow + tolerance && c.close > slow) {
      return { level: slow, ema: "EMA21", dir: "BULL",
               desc: "Price bouncing off EMA 21 support — bullish continuation" };
    }
  }

  /* In downtrend (fast < slow): look for price rejected by EMA as resistance */
  if (fast < slow) {
    if (c.high >= fast - tolerance && c.close < fast) {
      return { level: fast, ema: "EMA8", dir: "BEAR",
               desc: "Price rejected at EMA 8 resistance — bearish continuation" };
    }
    if (c.high >= slow - tolerance && c.close < slow) {
      return { level: slow, ema: "EMA21", dir: "BEAR",
               desc: "Price rejected at EMA 21 resistance — bearish continuation" };
    }
  }

  return null;
}

/* ================= S/R CONFLUENCE CHECK ================= */
/**
 * Checks if the breakout level coincides with a recent swing high or swing low,
 * providing double support/resistance confirmation.
 * Returns true if the level is within ATR tolerance of a recent swing point.
 */
function hasSRConfluence(level) {
  if (level == null || candles.length < SWING_LOOKBACK_PERIOD) return false;
  const tolerance = atrValue > 0 ? atrValue * SR_CONFLUENCE_ATR_MULT : Math.abs(level * SR_CONFLUENCE_PRICE_PCT);
  const lookbackStart = Math.max(0, candles.length - SWING_LOOKBACK_PERIOD);

  /* Check for true swing highs/lows near the level */
  for (let i = lookbackStart + SWING_NEIGHBOR_BARS; i < candles.length - SWING_NEIGHBOR_BARS; i++) {
    if (isTrueSwingHigh(i) && Math.abs(candles[i].high - level) <= tolerance) return true;
    if (isTrueSwingLow(i) && Math.abs(candles[i].low - level) <= tolerance) return true;
  }

  return false;
}

/* ================= FALSE BREAKOUT DETECTION ================= */
/**
 * After a breakout is detected, check if the next FALSE_BREAKOUT_CANDLES candles
 * have all closed back inside the opening range, invalidating the breakout.
 * Returns true if the breakout appears false.
 */
function isFalseBreakout(currentIdx) {
  if (!falseBreakoutEnabled || !breakout || !openingRange) return false;
  /* Need at least FALSE_BREAKOUT_CANDLES after breakout to judge */
  const checkStart = breakout.candleIdx + 1;
  const checkEnd = Math.min(checkStart + FALSE_BREAKOUT_CANDLES, candles.length);
  if (currentIdx < checkStart + FALSE_BREAKOUT_CANDLES - 1) return false;

  let allInside = true;
  for (let i = checkStart; i < checkEnd; i++) {
    const c = candles[i];
    if (c.close > openingRange.high || c.close < openingRange.low) {
      allInside = false;
      break;
    }
  }
  return allInside;
}

/* ================= CONFLUENCE SCORE ================= */
/**
 * Computes a quality score for the current setup based on multiple factors.
 * Base factors (0-9): EMA, HTF, breakout strength, pin/inside bar at retest,
 * S/R confluence, RSI, volume spike, active session, Fibonacci.
 * Market-type bonus (+1-3): spike rejection / S&D zone / trendline / MA bounce,
 * preferred direction alignment (Boom/Crash), step run / jump impulse.
 * Maximum possible varies by market type (9-12).
 */
function computeConfluenceScore(overrideDir, overrideLevel, overrideCandleIdx) {
  /* When called without args: use main breakout context (full state available).
     When called with args (secondary strategies): use the provided direction,
     level, and candle index instead of breakout/retestInfo state. */
  const dir   = overrideDir   !== undefined ? overrideDir   : (breakout ? breakout.dir   : null);
  const level = overrideLevel !== undefined ? overrideLevel : (breakout ? breakout.level : null);
  if (!dir) return 0;
  /* hasBoCtx: true only when called with no args (main strategy — full breakout state available) */
  const hasBoCtx = overrideDir === undefined && overrideLevel === undefined && overrideCandleIdx === undefined && !!breakout;

  let score = 0;

  /* Factor 1: EMA alignment */
  const lastFast = emaFast.length > 0 ? emaFast[emaFast.length - 1] : null;
  const lastSlow = emaSlow.length > 0 ? emaSlow[emaSlow.length - 1] : null;
  if (lastFast != null && lastSlow != null) {
    if ((dir === "BULL" && lastFast > lastSlow) ||
        (dir === "BEAR" && lastFast < lastSlow)) {
      score++;
    }
  }

  /* Factor 2: HTF trend alignment (only counts if actually aligned, not just FLAT) */
  const htf = getHTFTrend();
  if (htf === dir) score++;

  /* Factor 3: Strong breakout candle (main strategy context only) */
  if (hasBoCtx && breakout.strong) score++;

  /* Factor 4: Pin bar, inside bar, dragonfly/gravestone doji, tweezers, or railway track at retest
     (main strategy context only — requires retestInfo from the breakout state machine) */
  if (hasBoCtx && retestInfo && retestInfo.candleIdx < candles.length) {
    const rc = candles[retestInfo.candleIdx];
    const prevRC = retestInfo.candleIdx > 0 ? candles[retestInfo.candleIdx - 1] : null;
    if (isPinBar(rc, dir) || (prevRC && isInsideBar(prevRC, rc)) ||
        (dir === "BULL" && isDragonflyDoji(rc)) ||
        (dir === "BEAR" && isGravestoneDoji(rc)) ||
        (prevRC && isTweezers(prevRC, rc)) ||
        (prevRC && isRailwayTrack(prevRC, rc))) {
      score++;
    }
  }

  /* Factor 5: S/R confluence */
  if (level != null && hasSRConfluence(level)) score++;

  /* Factor 5b: Extra confirmation pattern quality (main strategy context only) */
  if (hasBoCtx && confirmInfo && confirmInfo.pattern) {
    const p = confirmInfo.pattern;
    if (p === "piercing line" || p === "dark cloud cover" ||
        p === "tweezers bottom" || p === "tweezers top" ||
        p === "dragonfly doji" || p === "gravestone doji" ||
        p === "railway track (bullish)" || p === "railway track (bearish)") {
      score++;
    }
  }

  /* Factor 6: RSI favorable */
  if (rsiValues.length > 0) {
    const rsi = rsiValues[rsiValues.length - 1];
    if (rsi != null) {
      if ((dir === "BULL" && rsi <= RSI_RETEST_BULL_MAX) ||
          (dir === "BEAR" && rsi >= RSI_RETEST_BEAR_MIN)) {
        score++;
      }
    }
  }

  /* Factor 7: Volume spike — use breakout candle for main strategy, signal candle for secondary */
  {
    const vIdx = hasBoCtx ? breakout.candleIdx : (overrideCandleIdx !== undefined ? overrideCandleIdx : candles.length - 1);
    if (vIdx >= 0 && vIdx < candles.length && hasVolumeSpikeOnBreakout(vIdx)) score++;
  }

  /* Factor 8: Within active trading session */
  if (isWithinActiveSession()) score++;

  /* Factor 9: Fibonacci confluence at key level */
  if (level != null && hasFibConfluence(level)) score++;

  /* Factor 10: Market-type-specific signal confluence */
  const mtype = getMarketType();
  const lastIdx = candles.length - 1;

  if (mtype === "boom" || mtype === "crash" || mtype === "dex") {
    /* Spike rejection or inside bar false breakout at current position */
    const spikeRej = detectSpikeRejection(lastIdx);
    const ibFalse = detectInsideBarFalseBreakout(lastIdx);
    if ((spikeRej && spikeRej.dir === dir) || (ibFalse && ibFalse.dir === dir)) {
      score++;
    }
  } else if (mtype === "jump") {
    const sdZone = detectSupplyDemandZone(lastIdx);
    const impulse = detectMomentumImpulse(lastIdx);
    if ((sdZone && ((sdZone.type === "demand" && dir === "BULL") ||
                    (sdZone.type === "supply" && dir === "BEAR"))) ||
        (impulse && impulse.dir === dir)) {
      score++;
    }
  } else if (mtype === "step") {
    const tlTouch = detectTrendlineTouch(lastIdx);
    const maBounce = detectMABounce(lastIdx);
    if ((tlTouch && tlTouch.dir === dir) || (maBounce && maBounce.dir === dir)) {
      score++;
    }
  } else if (mtype === "dailyreset") {
    /* Daily Reset: breakout aligned with natural trend direction (RDBULL→BULL, RDBEAR→BEAR) */
    const drPref = getDailyResetPreferredDir();
    if (drPref && drPref === dir) {
      score++;
    }
  } else if (mtype === "driftswitch") {
    /* Drift Switch: breakout aligned with current EMA crossover regime */
    const dsRegime = detectDriftSwitchRegime();
    if (dsRegime && dsRegime.regime === dir) {
      score++;
    }
  }

  /* Factor 11: Preferred direction alignment for Boom/Crash/DEX/DriftSwitch */
  const tuning = getMarketTuning();
  if (tuning.preferredDir && tuning.preferredDir === dir) {
    score++;
  }
  /* DEX direction preference from UP/DN variant (not in tuning.preferredDir which is null) */
  if (mtype === "dex") {
    const sym = _multiPanelProcessing || (UI.symbolSelect ? UI.symbolSelect.value : "");
    if ((/UP$/i.test(sym) && dir === "BULL") ||
        (/DN$/i.test(sym) && dir === "BEAR")) {
      score++;
    }
  }
  /* Drift Switch: recent regime switch bonus (fresh crossover = strong signal) */
  if (mtype === "driftswitch") {
    const dsRegime = detectDriftSwitchRegime();
    if (dsRegime && dsRegime.recentSwitch && dsRegime.regime === dir) {
      score++;
    }
  }

  /* Factor 12: Step run momentum or Jump impulse confirmation */
  if (mtype === "step") {
    const run = getStepRunLength();
    if ((dir === "BULL" && run >= STEP_RUN_THRESHOLD) ||
        (dir === "BEAR" && run <= -STEP_RUN_THRESHOLD)) {
      score++;
    }
  } else if (mtype === "jump") {
    const impulse = detectMomentumImpulse(lastIdx);
    if (impulse && impulse.dir === dir && impulse.strength >= 2) {
      score++;
    }
  }

  /* Factor 13 (GainzAlgo V2): MACD histogram alignment */
  {
    const hist = getCurrentMACD();
    if (hist != null) {
      if ((dir === "BULL" && hist > 0) || (dir === "BEAR" && hist < 0)) score++;
    }
  }

  /* Factor 14 (GainzAlgo V2): Bollinger Band squeeze preceding breakout */
  if (isBBSqueeze()) score++;

  /* Factor 15 (GainzAlgo V2): ADX trending confirmation */
  if (adxValue >= ADX_TRENDING_THRESHOLD) score++;

  /* Factor 16 (GainzAlgo V2): Stochastic momentum alignment */
  {
    const k = getCurrentStoch();
    if (k != null) {
      if ((dir === "BULL" && k <= 50) || (dir === "BEAR" && k >= 50)) score++;
    }
  }

  return score;
}

/* ================= STRATEGY LOGIC ================= */

function processAllCandles() {
  _historicalProcessing = true;
  openingRange = null;
  breakout = null;
  retestInfo = null;
  indecisionInfo = null;
  confirmInfo = null;
  trade = null;
  trailingSL   = null;
  partialTpHit = false;
  teslaT1Hit = false;
  teslaT2Hit = false;
  teslaT3Hit = false;
  teslaBEHit = false;
  retestCount  = 0;
  setPhase("WAITING");

  /* Reset NY Open Range for full reprocessing */
  resetNyOpenRange();

  /* Reset Session Ranges for full reprocessing */
  resetSessionRanges();

  if (candles.length === 0) return;
  rangeStartEpoch = candles[0].epoch;
  computeATR();
  computeRSI();
  computeMACD();
  computeBollingerBands();
  computeADX();
  computeStochastic();
  computeEMA200();
  computeVWAP();

  buildOpeningRange();

  if (openingRange) {
    for (let i = openingRange.endIdx + 1; i < candles.length; i++) {
      processCandle(i);
      if (trade) break;
    }
  }

  /* NY Open Range: build range and process all candles through it */
  if (nyOpenRangeEnabled) {
    buildNyOpenRange();
    if (nyOpenRange) {
      for (let i = nyOpenRange.endIdx + 1; i < candles.length; i++) {
        processNyOpenRangeCandle(i);
        if (nyOpenRangeTrade) break;
      }
    }
  }

  /* Session Ranges: build ranges and detect London sweep */
  if (sessionRangesEnabled) {
    buildSessionRanges();
    detectLondonAsianSweep();
  }

  updateStateUI();
  _historicalProcessing = false;
}

function processLatestCandle() {
  /* When monitoring a resolved trade with auto-reset, skip the short-circuit */
  if (phase === "TRADE" && !monitoringTrade && autoResetEnabled) {
    resetForNextSetup();
    addLog("Auto-reset: scanning for new setup...");
  }

  /* Session Ranges: rebuild ranges and check for London sweep on each candle.
     Always runs before any phase-based early return so sweeps are never missed
     while the main indicator is in TRADE, WAITING, or RANGE phases. */
  if (sessionRangesEnabled) {
    buildSessionRanges();
    detectLondonAsianSweep();
  }

  if (phase === "TRADE") { updateStateUI(); return; }

  if (phase === "WAITING" || phase === "RANGE") {
    buildOpeningRange();
    /* If still in WAITING/RANGE, nothing more to do */
    if (phase === "WAITING" || phase === "RANGE") {
      /* NY Open Range: try to build / advance on each candle */
      if (nyOpenRangeEnabled) {
        buildNyOpenRange();
        if (nyOpenRange && nyOpenRangePhase !== "TRADE") {
          processNyOpenRangeCandle(candles.length - 1);
        }
      }
      updateStateUI();
      return;
    }
    /* Range just completed → process all post-range candles so we catch
       breakouts (and subsequent phases) that formed while we were in RANGE. */
    if (openingRange) {
      for (let i = openingRange.endIdx + 1; i < candles.length; i++) {
        processCandle(i);
        if (trade) break;
      }
    }
    updateStateUI();
    return;
  }

  const idx = candles.length - 1;

  /* Allow multiple phase transitions on the same candle (e.g. retest candle
     that is also indecision).  Cap the loop to avoid infinite spins.
     TRADE is the terminal phase — once a trade is built, stop advancing. */
  let prevPhase = phase;
  const MAX_ADVANCES = 5;
  for (let attempt = 0; attempt < MAX_ADVANCES; attempt++) {
    processCandle(idx);
    if (phase === prevPhase || phase === "TRADE") break;
    prevPhase = phase;
  }

  /* NY Open Range: advance on latest candle (runs alongside main strategy) */
  if (nyOpenRangeEnabled) {
    buildNyOpenRange();
    if (nyOpenRange && nyOpenRangePhase !== "TRADE") {
      processNyOpenRangeCandle(idx);
    }
  }

  updateStateUI();
}

/**
 * Reset indicator state for next setup while keeping candle data and signal history.
 * Starts a new opening range from the latest candle epoch.
 */
function resetForNextSetup() {
  openingRange   = null;
  breakout       = null;
  retestInfo     = null;
  indecisionInfo = null;
  confirmInfo    = null;
  trade          = null;
  trailingSL     = null;
  partialTpHit   = false;
  retestCount    = 0;
  /* Reset NY Open Range alongside main strategy */
  resetNyOpenRange();
  /* Reset Session Ranges alongside main strategy */
  resetSessionRanges();
  /* Start new range from the latest candle */
  rangeStartEpoch = candles.length > 0 ? candles[candles.length - 1].epoch : null;
  setPhase("RANGE");
  updateStateUI();
}

function buildOpeningRange() {
  if (!rangeStartEpoch || candles.length === 0) return;

  /* Scalping mode uses a shorter opening range (from MD: 5min) */
  const effectiveRangeMin = scalpingModeEnabled ? SCALP_RANGE_MINUTES : RANGE_MINUTES;
  const rangeEndEpoch = rangeStartEpoch + effectiveRangeMin * 60;
  let high = -Infinity, low = Infinity;
  let startIdx = 0, endIdx = 0;

  for (let i = 0; i < candles.length; i++) {
    if (candles[i].epoch > rangeEndEpoch) break;
    if (candles[i].high > high) high = candles[i].high;
    if (candles[i].low < low)   low = candles[i].low;
    endIdx = i;
  }

  if (high === -Infinity || candles.length === 0) return;

  openingRange = { high, low, startIdx, endIdx };

  const lastEpoch = candles[candles.length - 1].epoch;
  if (lastEpoch <= rangeEndEpoch) {
    setPhase("RANGE");
  } else if (!breakout) {
    setPhase("BREAKOUT");
  }
}

/* ================= MARKET-TYPE LOGGING HELPERS ================= */
/**
 * Logs market-type-specific context when a breakout is detected.
 * Provides traders with actionable insights based on the instrument type.
 */
function logMarketTypeContext(idx, dir) {
  const mtype = getMarketType();
  const tuning = getMarketTuning();

  if (mtype === "boom") {
    if (dir === "BULL") {
      addLog(`📈 BOOM INDEX: Breakout aligned with spike direction — high probability`);
    }
    if (isSpikeCandle(candles[idx], dir)) {
      addLog(`⚡ Spike candle detected — characteristic Boom upward spike`);
    }
  } else if (mtype === "crash") {
    if (dir === "BEAR") {
      addLog(`📉 CRASH INDEX: Breakout aligned with spike direction — high probability`);
    }
    if (isSpikeCandle(candles[idx], dir)) {
      addLog(`⚡ Spike candle detected — characteristic Crash downward spike`);
    }
  } else if (mtype === "jump") {
    if (isJumpCandle(idx)) {
      addLog(`🦘 JUMP INDEX: Jump/gap candle detected — watch for momentum continuation`);
    }
    const sdZone = detectSupplyDemandZone(idx);
    if (sdZone) {
      addLog(`📍 ${sdZone.desc}`);
    }
  } else if (mtype === "step") {
    const run = getStepRunLength();
    if (Math.abs(run) >= STEP_RUN_THRESHOLD) {
      addLog(`🪜 STEP INDEX: ${Math.abs(run)}-step momentum run ${run > 0 ? "UP" : "DOWN"}`);
    }
    const tlTouch = detectTrendlineTouch(idx);
    if (tlTouch) {
      addLog(`📐 ${tlTouch.desc}`);
    }
  } else if (mtype === "dex") {
    const sym = _multiPanelProcessing || (UI.symbolSelect ? UI.symbolSelect.value : "");
    const isDexUp = /UP$/i.test(sym);
    const isDexDn = /DN$/i.test(sym);
    if (isDexUp && dir === "BULL") {
      addLog(`📰 DEX UP: Breakout aligned with spike-up direction — high probability`);
    } else if (isDexDn && dir === "BEAR") {
      addLog(`📰 DEX DN: Breakout aligned with spike-down direction — high probability`);
    }
    if (isSpikeCandle(candles[idx], dir)) {
      addLog(`⚡ DEX spike candle detected — news-event-like impulse`);
    }
  } else if (mtype === "driftswitch") {
    const dsRegime = detectDriftSwitchRegime();
    if (dsRegime) {
      addLog(`🔄 ${dsRegime.desc}`);
      if (dsRegime.regime === dir) {
        addLog(`✅ DRIFT SWITCH: Breakout ${dir} aligned with ${dsRegime.regime} regime`);
      } else {
        addLog(`⚠ DRIFT SWITCH: Breakout ${dir} against ${dsRegime.regime} regime — caution`);
      }
    } else {
      addLog(`🔄 DRIFT SWITCH: Breakout ${dir} — confirm regime alignment before entry`);
    }
  } else if (mtype === "dailyreset") {
    const drPref = getDailyResetPreferredDir();
    if (drPref) {
      if (drPref === dir) {
        addLog(`📅 DAILY RESET: Breakout ${dir} aligned with natural trend — high probability`);
      } else {
        addLog(`⚠ DAILY RESET: Breakout ${dir} against natural ${drPref} trend — counter-trend, caution`);
      }
    }
  }
}

/**
 * Logs market-type-specific signals at retest for extra context.
 */
function logMarketTypeSignals(idx) {
  const mtype = getMarketType();

  if (mtype === "boom" || mtype === "crash" || mtype === "dex") {
    const spikeRej = detectSpikeRejection(idx);
    if (spikeRej) addLog(`✅ ${spikeRej.desc}`);
    const ibFalse = detectInsideBarFalseBreakout(idx);
    if (ibFalse) addLog(`✅ ${ibFalse.desc}`);
  } else if (mtype === "jump") {
    const sdZone = detectSupplyDemandZone(idx);
    if (sdZone) addLog(`✅ ${sdZone.desc}`);
    const impulse = detectMomentumImpulse(idx);
    if (impulse) addLog(`✅ ${impulse.desc}`);
  } else if (mtype === "step") {
    const maBounce = detectMABounce(idx);
    if (maBounce) addLog(`✅ ${maBounce.desc}`);
    const tlTouch = detectTrendlineTouch(idx);
    if (tlTouch) addLog(`✅ ${tlTouch.desc}`);
  } else if (mtype === "dailyreset") {
    const drPref = getDailyResetPreferredDir();
    if (drPref) {
      addLog(`📅 Daily Reset natural trend: ${drPref} — ${drPref === (breakout ? breakout.dir : "") ? "aligned ✅" : "counter-trend ⚠"}`);
    }
  } else if (mtype === "driftswitch") {
    const dsRegime = detectDriftSwitchRegime();
    if (dsRegime) {
      addLog(`🔄 ${dsRegime.desc}`);
      if (breakout && dsRegime.regime === breakout.dir) {
        addLog(`✅ Breakout aligned with Drift Switch ${dsRegime.regime} regime`);
      } else if (breakout) {
        addLog(`⚠ Breakout AGAINST Drift Switch ${dsRegime.regime} regime — caution`);
      }
    }
  }
}

function processCandle(idx) {
  if (!openingRange) return;
  const c = candles[idx];
  const tuning = getMarketTuning();

  /* PHASE: looking for breakout */
  if (!breakout) {
    /* Opening range size filter — too narrow = noise, too wide = risky */
    if (!isRangeSizeOK()) {
      return;  /* silently skip — range size is checked once */
    }
    /* ADX Hard Gate — block in ranging or exhausted markets */
    if (!isADXInRange()) {
      return;  /* silently skip — ADX checked each candle */
    }
    /* Market-type direction filter: Boom prefers BULL, Crash prefers BEAR.
       Counter-trend breakouts on spike markets are much less reliable. */
    if (c.close > openingRange.high) {
      if (tuning.preferredDir === "BEAR") {
        addLog(`Bullish breakout at #${idx} BLOCKED — Crash index prefers BEAR direction`);
        return;
      }
      /* Apply EMA filter */
      if (!isEmaAligned("BULL")) {
        addLog(`Bullish breakout at #${idx} BLOCKED by EMA filter (EMA8 < EMA21)`);
        return;
      }
      /* Apply HTF trend filter */
      if (!isHTFAligned("BULL")) {
        addLog(`Bullish breakout at #${idx} BLOCKED by HTF trend filter`);
        return;
      }
      /* Apply MTF structure (EMA 200) */
      if (!isMTFStructureAligned("BULL")) {
        addLog(`Bullish breakout at #${idx} BLOCKED by MTF structure (price below EMA 200)`);
        return;
      }
      /* Apply HH/HL structure check */
      if (!hasHHHLStructure("BULL")) {
        addLog(`Bullish breakout at #${idx} BLOCKED by HH/HL structure (no higher-highs/higher-lows)`);
        return;
      }
      /* Apply session filter */
      if (!isWithinActiveSession()) {
        addLog(`Bullish breakout at #${idx} BLOCKED by session filter (${getActiveSessionName()})`);
        return;
      }
      /* Log breakout strength (volume proxy) */
      const conviction = hasBreakoutConviction(c);
      /* Apply volume spike filter */
      const volumeSpike = hasVolumeSpikeOnBreakout(idx);
      if (!volumeSpike) {
        addLog(`Bullish breakout at #${idx} BLOCKED by volume spike filter (candle range too small)`);
        return;
      }
      breakout = { dir: "BULL", candleIdx: idx, level: openingRange.high, strong: conviction, volumeSpike };
      retestCount = 0;  /* reset retest counter for double-retest filter */
      setPhase("RETEST");
      addLog(`BULLISH breakout at candle #${idx}, level ${fmt(openingRange.high, 4)}${conviction ? " (STRONG)" : " (WEAK)"}${volumeSpike ? " 📈 Vol Spike" : ""}`);
      /* Log market-type-specific context */
      logMarketTypeContext(idx, "BULL");
      addLog(`Next action: ${getRecommendedOrderType() || "BUY"} — ride the breakout momentum`);
    } else if (c.close < openingRange.low) {
      if (tuning.preferredDir === "BULL") {
        addLog(`Bearish breakout at #${idx} BLOCKED — Boom index prefers BULL direction`);
        return;
      }
      /* Apply EMA filter */
      if (!isEmaAligned("BEAR")) {
        addLog(`Bearish breakout at #${idx} BLOCKED by EMA filter (EMA8 > EMA21)`);
        return;
      }
      /* Apply HTF trend filter */
      if (!isHTFAligned("BEAR")) {
        addLog(`Bearish breakout at #${idx} BLOCKED by HTF trend filter`);
        return;
      }
      /* Apply MTF structure (EMA 200) */
      if (!isMTFStructureAligned("BEAR")) {
        addLog(`Bearish breakout at #${idx} BLOCKED by MTF structure (price above EMA 200)`);
        return;
      }
      /* Apply HH/HL structure check */
      if (!hasHHHLStructure("BEAR")) {
        addLog(`Bearish breakout at #${idx} BLOCKED by HH/HL structure (no lower-highs/lower-lows)`);
        return;
      }
      /* Apply session filter */
      if (!isWithinActiveSession()) {
        addLog(`Bearish breakout at #${idx} BLOCKED by session filter (${getActiveSessionName()})`);
        return;
      }
      const conviction = hasBreakoutConviction(c);
      /* Apply volume spike filter */
      const volumeSpike = hasVolumeSpikeOnBreakout(idx);
      if (!volumeSpike) {
        addLog(`Bearish breakout at #${idx} BLOCKED by volume spike filter (candle range too small)`);
        return;
      }
      breakout = { dir: "BEAR", candleIdx: idx, level: openingRange.low, strong: conviction, volumeSpike };
      retestCount = 0;  /* reset retest counter for double-retest filter */
      setPhase("RETEST");
      addLog(`BEARISH breakout at candle #${idx}, level ${fmt(openingRange.low, 4)}${conviction ? " (STRONG)" : " (WEAK)"}${volumeSpike ? " 📈 Vol Spike" : ""}`);
      logMarketTypeContext(idx, "BEAR");
      addLog(`Next action: ${getRecommendedOrderType() || "SELL"} — ride the breakout momentum`);
    }
    return;
  }

  /* FALSE BREAKOUT DETECTION: invalidate if price returns inside range */
  if (!retestInfo && isFalseBreakout(idx)) {
    addLog(`⚠ FALSE BREAKOUT detected — ${FALSE_BREAKOUT_CANDLES} candles closed back inside range. Resetting.`);
    breakout = null;
    setPhase("BREAKOUT");
    return;
  }

  /* PHASE: looking for retest */
  if (!retestInfo) {
    if (idx <= breakout.candleIdx) return;
    /* Post-breakout follow-through check */
    if (!hasFollowThrough()) {
      addLog(`Breakout at #${breakout.candleIdx} INVALIDATED — no follow-through (next candle reversed)`);
      breakout = null;
      setPhase("BREAKOUT");
      return;
    }
    /* Time decay — setup too stale */
    if (!isTimeDecayOK(idx)) {
      addLog(`⏳ Time decay: ${idx - breakout.candleIdx} candles since breakout (max ${timeDecayCandles}) — resetting`);
      breakout = null;
      setPhase("BREAKOUT");
      return;
    }
    /* Breakout distance check */
    if (!isBreakoutDistanceOK(idx)) {
      addLog(`📏 Breakout distance: price too far from level (>${breakoutDistATR}× ATR) — skipping retest`);
      return;
    }
    const touches = touchesLevel(c, breakout.level);
    if (touches) {
      /* Track retest count for double-retest filter */
      retestCount++;
      if (!isDoubleRetestSatisfied()) {
        addLog(`Retest #${retestCount} at #${idx} — waiting for double retest (need ${2 - retestCount} more)`);
        return;  /* don't set retestInfo yet; wait for 2nd touch */
      }
      /* Apply RSI filter at retest */
      if (!isRSIFavorable(breakout.dir)) {
        const rsi = getCurrentRSI();
        addLog(`Retest at #${idx} — RSI ${fmt(rsi, 1)} not favorable for ${breakout.dir} (skipping)`);
        return;
      }
      /* Apply momentum divergence filter */
      if (!hasMomentumDivergence(breakout.dir)) {
        addLog(`Retest at #${idx} BLOCKED by divergence filter — no favorable RSI divergence`);
        return;
      }
      retestInfo = { candleIdx: idx };
      setPhase("INDECISION");
      /* Feature 7: build divergence visual markers on retest */
      if (divergenceVisualEnabled) buildDivergenceMarkers();
      addLog(`Retest detected at candle #${idx}${retestCount > 1 ? ` (retest #${retestCount})` : ""}`);
      /* Log RSI at retest */
      const rsi = getCurrentRSI();
      if (rsi != null) {
        addLog(`RSI at retest: ${fmt(rsi, 1)}${rsi <= 30 ? " (oversold)" : rsi >= 70 ? " (overbought)" : ""}`);
      }
      /* Log S/R confluence if present */
      if (hasSRConfluence(breakout.level)) {
        addLog("✅ S/R confluence: breakout level aligns with recent swing point");
      }
      /* Log Fibonacci confluence if present */
      const fibResult = getFibRetestLevel(breakout.level);
      if (fibResult) {
        addLog(`✅ Fibonacci confluence: retest near ${(fibResult.ratio * 100).toFixed(1)}% level`);
      }
      /* Log market-type-specific signals at retest */
      logMarketTypeSignals(idx);
      addLog(`Pullback trade: ${getRecommendedOrderType() || (breakout.dir === "BULL" ? "BUY LIMIT" : "SELL LIMIT")} at retest level`);
    }
    return;
  }

  /* PHASE: looking for indecision */
  if (!indecisionInfo) {
    /* Allow the retest candle itself to also be indecision */
    if (idx < retestInfo.candleIdx) return;
    if (isIndecision(c, idx)) {
      indecisionInfo = { candleIdx: idx };
      setPhase("CONFIRM");
      /* Describe what type of indecision was detected */
      let indecisionType = "doji/spinning-top";
      if (breakout && isPinBar(c, breakout.dir)) indecisionType = "pin bar";
      else if (idx > 0 && isInsideBar(candles[idx - 1], c)) indecisionType = "inside bar";
      if (idx === retestInfo.candleIdx) {
        addLog(`Retest candle #${idx} is also indecision (${indecisionType})`);
      } else {
        addLog(`Indecision candle at #${idx} (${indecisionType})`);
      }
    }
    return;
  }

  /* PHASE: looking for confirmation (engulfing / morning-evening star / inside bar breakout / market-type patterns) */
  if (!confirmInfo) {
    if (idx <= indecisionInfo.candleIdx) return;
    const prev = candles[idx - 1];
    let confirmed = false;
    let confirmPattern = "";

    /* Classic engulfing pattern */
    if (breakout.dir === "BULL" && isBullishEngulfing(prev, c)) {
      confirmed = true;
      confirmPattern = "bullish engulfing";
    } else if (breakout.dir === "BEAR" && isBearishEngulfing(prev, c)) {
      confirmed = true;
      confirmPattern = "bearish engulfing";
    }

    /* Morning Star / Evening Star (3-candle pattern) */
    if (!confirmed && idx >= 2) {
      const c1 = candles[idx - 2];
      const c2 = candles[idx - 1];
      if (breakout.dir === "BULL" && isMorningStar(c1, c2, c)) {
        confirmed = true;
        confirmPattern = "morning star";
      } else if (breakout.dir === "BEAR" && isEveningStar(c1, c2, c)) {
        confirmed = true;
        confirmPattern = "evening star";
      }
    }

    /* Inside bar breakout: if indecision was an inside bar, breakout of mother confirms */
    if (!confirmed && indecisionInfo.candleIdx > 0) {
      const mother = candles[indecisionInfo.candleIdx - 1];
      const indecisionCandle = candles[indecisionInfo.candleIdx];
      if (isInsideBar(mother, indecisionCandle) && isInsideBarBreakout(mother, c, breakout.dir)) {
        confirmed = true;
        confirmPattern = "inside bar breakout";
      }
    }

    /* Piercing Line / Dark Cloud Cover (2-candle reversal from MD files) */
    if (!confirmed) {
      if (breakout.dir === "BULL" && isPiercingLine(prev, c)) {
        confirmed = true;
        confirmPattern = "piercing line";
      } else if (breakout.dir === "BEAR" && isDarkCloudCover(prev, c)) {
        confirmed = true;
        confirmPattern = "dark cloud cover";
      }
    }

    /* Dragonfly / Gravestone Doji confirmation (directional doji from MD files) */
    if (!confirmed) {
      if (breakout.dir === "BULL" && isDragonflyDoji(c)) {
        confirmed = true;
        confirmPattern = "dragonfly doji";
      } else if (breakout.dir === "BEAR" && isGravestoneDoji(c)) {
        confirmed = true;
        confirmPattern = "gravestone doji";
      }
    }

    /* Tweezers Tops & Bottoms (double-test rejection from MD files) */
    if (!confirmed) {
      const tweezersType = isTweezers(prev, c);
      if (tweezersType === "bottom" && breakout.dir === "BULL") {
        confirmed = true;
        confirmPattern = "tweezers bottom";
      } else if (tweezersType === "top" && breakout.dir === "BEAR") {
        confirmed = true;
        confirmPattern = "tweezers top";
      }
    }

    /* Railway Track (sharp 2-candle reversal from TRENDLINE_TRADING_STRATEGY.md) */
    if (!confirmed) {
      const rtType = isRailwayTrack(prev, c);
      if (rtType === "bull" && breakout.dir === "BULL") {
        confirmed = true;
        confirmPattern = "railway track (bullish)";
      } else if (rtType === "bear" && breakout.dir === "BEAR") {
        confirmed = true;
        confirmPattern = "railway track (bearish)";
      }
    }

    /* ---- Market-type-specific confirmation patterns (from MD files) ---- */
    const mtype = getMarketType();

    /* Boom/Crash/DEX: Spike rejection (pin bar or engulfing after spike) confirms reversal.
       From FOREX_MILLIONAIRE_365_DAYS: Pin bar + key level = high probability. */
    if (!confirmed && (mtype === "boom" || mtype === "crash" || mtype === "dex")) {
      const spikeRej = detectSpikeRejection(idx);
      if (spikeRej && spikeRej.dir === breakout.dir) {
        confirmed = true;
        confirmPattern = spikeRej.type === "spike_rejection_pinbar"
          ? "spike rejection pin bar" : "spike rejection engulfing";
      }
      /* Inside bar false breakout (stop-hunt trap) as confirmation */
      if (!confirmed) {
        const ibFalse = detectInsideBarFalseBreakout(idx);
        if (ibFalse && ibFalse.dir === breakout.dir) {
          confirmed = true;
          confirmPattern = "inside bar false breakout (trap)";
        }
      }
    }

    /* Jump: Momentum impulse or S&D zone return as confirmation.
       From FOREX_MILLIONAIRE_365_DAYS: "Best place to buy is at beginning of impulsive move." */
    if (!confirmed && mtype === "jump") {
      const impulse = detectMomentumImpulse(idx);
      if (impulse && impulse.dir === breakout.dir) {
        confirmed = true;
        confirmPattern = "momentum impulse";
      }
      if (!confirmed) {
        const sdZone = detectSupplyDemandZone(idx);
        if (sdZone) {
          if ((sdZone.type === "demand" && breakout.dir === "BULL") ||
              (sdZone.type === "supply" && breakout.dir === "BEAR")) {
            confirmed = true;
            confirmPattern = sdZone.type + " zone return";
          }
        }
      }
    }

    /* Step: Trendline touch or MA bounce as confirmation.
       From TRENDLINE_TRADING_STRATEGY: "Enter on point 3, 4, 5 after pullback." */
    if (!confirmed && mtype === "step") {
      const tlTouch = detectTrendlineTouch(idx);
      if (tlTouch && tlTouch.dir === breakout.dir) {
        confirmed = true;
        confirmPattern = `trendline touch #${tlTouch.touches}`;
      }
      if (!confirmed) {
        const maBounce = detectMABounce(idx);
        if (maBounce && maBounce.dir === breakout.dir) {
          confirmed = true;
          confirmPattern = `${maBounce.ema} bounce`;
        }
      }
      /* Step run momentum confirmation */
      if (!confirmed) {
        const run = getStepRunLength();
        if ((breakout.dir === "BULL" && run >= STEP_RUN_THRESHOLD) ||
            (breakout.dir === "BEAR" && run <= -STEP_RUN_THRESHOLD)) {
          confirmed = true;
          confirmPattern = `step momentum run (${Math.abs(run)} steps)`;
        }
      }
    }

    /* Drift Switch: EMA crossover regime alignment as confirmation */
    if (!confirmed && mtype === "driftswitch") {
      const dsRegime = detectDriftSwitchRegime();
      if (dsRegime && dsRegime.regime === breakout.dir) {
        confirmed = true;
        confirmPattern = dsRegime.recentSwitch
          ? `drift switch regime switch (${dsRegime.regime})`
          : `drift switch regime aligned (${dsRegime.regime})`;
      }
    }

    /* Daily Reset: natural trend alignment as confirmation */
    if (!confirmed && mtype === "dailyreset") {
      const drPref = getDailyResetPreferredDir();
      if (drPref && drPref === breakout.dir) {
        confirmed = true;
        confirmPattern = `daily reset trend aligned (${drPref})`;
      }
    }

    if (confirmed) {
      /* Apply consecutive direction filter */
      if (!hasConsecutiveDirection(idx, breakout.dir)) {
        addLog(`${confirmPattern} at #${idx} BLOCKED — consecutive direction filter (momentum not aligned)`);
        confirmed = false;
      }
      /* Apply VWAP alignment filter */
      if (confirmed && !isVWAPAligned(breakout.dir)) {
        addLog(`${confirmPattern} at #${idx} BLOCKED — VWAP filter (price wrong side of VWAP)`);
        confirmed = false;
      }
      /* Apply stochastic crossover filter */
      if (confirmed && !hasStochCrossover(breakout.dir)) {
        addLog(`${confirmPattern} at #${idx} BLOCKED — stochastic crossover filter (no K/D cross)`);
        confirmed = false;
      }
      /* Apply confirmation bar filter (next candle must close in direction) */
      if (confirmed && !isConfirmBarValid(idx)) {
        addLog(`${confirmPattern} at #${idx} BLOCKED — confirm bar filter (candle didn't close in ${breakout.dir} direction)`);
        confirmed = false;
      }
    }

    if (confirmed) {
      confirmInfo = { candleIdx: idx, pattern: confirmPattern };
      /* Record a CONFIRMED signal immediately so it appears in the Live Signals banner */
      recordConfirmedSignal(confirmPattern);
      addLog(`${confirmPattern} confirmed at #${idx}`);
      buildTrade(c, idx);
      if (trade) {
        /* Apply min confluence gate — check after trade is built so score is accurate */
        confluenceScore = computeConfluenceScore();
        if (!isConfluenceSufficient()) {
          addLog(`⚠ Trade REJECTED — confluence ${confluenceScore}/${minConfluenceValue} below minimum`);
          trade = null;
          confirmInfo = null;
          return;
        }
        setPhase("TRADE");
        /* Feature 15: reset multi-R hit levels for new trade */
        multiRHitLevels = [];
        addLog(`${confirmPattern} at #${idx} — TRADE ENTRY`);
        /* Confluence score was already computed for the min gate check above */
        addLog(`Confluence score: ${confluenceScore}`);
        recordSignal(confirmPattern);
      }
    }
    return;
  }
}

/* ---- Level touch detection (with optional ATR-based tolerance) ---- */
function touchesLevel(candle, level) {
  const tuning = getMarketTuning();
  let tolerance;
  if (atrToleranceEnabled && atrValue > 0) {
    /* retestToleranceMult replaces the default 0.5 factor, not multiplied on top */
    tolerance = atrValue * 0.5 * tuning.retestToleranceMult;
  } else {
    tolerance = (candle.high - candle.low) * LEVEL_TOUCH_TOLERANCE * tuning.retestToleranceMult;
  }
  return candle.low - tolerance <= level && candle.high + tolerance >= level;
}

/* ---- Indecision candle detection ---- */
function isIndecision(c, idx) {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (range === 0) return true;
  const bodyRatio = body / range;

  /* Classic doji */
  if (bodyRatio < DOJI_BODY_RATIO) return true;

  /* Spinning top */
  if (bodyRatio < SPINNING_TOP_BODY_RATIO) {
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    if (upperWick > 0 && lowerWick > 0) return true;
  }

  /* Pin bar / hammer / shooting star at retest zone */
  if (breakout && isPinBar(c, breakout.dir)) return true;

  /* Dragonfly / Gravestone doji (directional indecision from MD files) */
  if (isDragonflyDoji(c) || isGravestoneDoji(c)) return true;

  /* Inside bar: current candle contained within previous candle */
  if (idx != null && idx > 0 && idx < candles.length) {
    const prev = candles[idx - 1];
    if (isInsideBar(prev, c)) return true;
  }

  return false;
}

/* ---- Engulfing pattern detection ---- */
function isBullishEngulfing(prev, curr) {
  if (!prev || !curr) return false;
  const currBody = curr.close - curr.open;
  return currBody > 0 &&
    curr.close > Math.max(prev.open, prev.close) &&
    curr.open <= Math.min(prev.open, prev.close);
}

function isBearishEngulfing(prev, curr) {
  if (!prev || !curr) return false;
  const currBody = curr.close - curr.open;
  return currBody < 0 &&
    curr.close < Math.min(prev.open, prev.close) &&
    curr.open >= Math.max(prev.open, prev.close);
}

/* ---- Trade setup builder ---- */
function buildTrade(confirmCandle, confirmIdx) {
  /* Feature 11: News pause gate — block new trades during high-impact events */
  const pauseEvent = getNewsPauseEvent();
  if (pauseEvent) {
    addLog(`⛔ Trade BLOCKED by News Pause: ${pauseEvent.currency} ${pauseEvent.title} within ±${newsPauseMinutes}min window`);
    showToast("News Pause Active", `Trading paused for: ${pauseEvent.currency} ${pauseEvent.title}`, "warning", 8000);
    return;
  }

  const riskVal   = parseFloat(UI.riskInput.value);
  const rewardVal = parseFloat(UI.rewardInput.value);
  const riskUnits  = (!isNaN(riskVal) && riskVal > 0) ? riskVal : 1;
  const rewardUnits = (!isNaN(rewardVal) && rewardVal > 0) ? rewardVal : 1;
  /* Scalping mode: cap R:R at SCALP_RR_TARGET for quick profits (from MD: 5-10 pip profits) */
  const rr = scalpingModeEnabled ? Math.min(rewardUnits / riskUnits, SCALP_RR_TARGET) : rewardUnits / riskUnits;

  /* ---- Resolve the retest/indecision zone candles for precise SL placement ----
   * Using the lowest point of the retest + indecision zone (BULL) or the highest
   * point (BEAR) with a small ATR buffer gives a structurally meaningful stop that
   * invalidates the setup exactly when price breaks through the zone.  This is
   * significantly tighter than a 35-candle swing look-back and reduces initial
   * risk without sacrificing structural validity.  Fall back to the swing-based SL
   * when retestInfo / indecisionInfo is unavailable (e.g. historical re-processing
   * edge cases). */
  const rtCandle = retestInfo    && retestInfo.candleIdx    < candles.length ? candles[retestInfo.candleIdx]    : null;
  const inCandle = indecisionInfo && indecisionInfo.candleIdx < candles.length ? candles[indecisionInfo.candleIdx] : null;

  if (breakout.dir === "BULL") {
    const entry = confirmCandle.close;

    /* SL anchor: lowest low of the retest/indecision zone; fall back to swing */
    const zoneLows = [rtCandle, inCandle].filter(Boolean).map(c => c.low);
    const slAnchor = zoneLows.length > 0 ? Math.min(...zoneLows) : findSwingLow(confirmIdx);
    const sl = slAnchor - atrValue * 0.3;  /* 0.3 ATR buffer below zone — tighter than 0.5×swing */

    const risk = entry - sl;
    if (risk <= 0) return;
    const tp = pureTrailingEnabled ? null : entry + risk * rr;
    const actualRR = pureTrailingEnabled ? rr : (tp - entry) / risk;

    /* Min R:R gate: reject trade if R:R is below minimum */
    if (minRREnabled && actualRR < minRRValue) {
      addLog(`⚠ Trade REJECTED — R:R ${fmt(actualRR, 1)} below minimum ${fmt(minRRValue, 1)}`);
      return;
    }
    trade = { entry, sl, tp, dir: "BULL", rr: actualRR, scalpingMode: scalpingModeEnabled, entryIdx: confirmIdx, symbol: getActiveSymbol() };
  } else {
    const entry = confirmCandle.close;

    /* SL anchor: highest high of the retest/indecision zone; fall back to swing */
    const zoneHighs = [rtCandle, inCandle].filter(Boolean).map(c => c.high);
    const slAnchor = zoneHighs.length > 0 ? Math.max(...zoneHighs) : findSwingHigh(confirmIdx);
    const sl = slAnchor + atrValue * 0.3;  /* 0.3 ATR buffer above zone — tighter than 0.5×swing */

    const risk = sl - entry;
    if (risk <= 0) return;
    const tp = pureTrailingEnabled ? null : entry - risk * rr;
    const actualRR = pureTrailingEnabled ? rr : (entry - tp) / risk;

    /* Min R:R gate: reject trade if R:R is below minimum */
    if (minRREnabled && actualRR < minRRValue) {
      addLog(`⚠ Trade REJECTED — R:R ${fmt(actualRR, 1)} below minimum ${fmt(minRRValue, 1)}`);
      return;
    }
    trade = { entry, sl, tp, dir: "BEAR", rr: actualRR, scalpingMode: scalpingModeEnabled, entryIdx: confirmIdx, symbol: getActiveSymbol() };
  }

  if (scalpingModeEnabled) {
    addLog(`⚡ SCALPING MODE — quick TP at R:R ${fmt(rr, 1)}, max ${SCALP_MAX_CANDLES} candles`);
  }

  /* Reset trailing/partial state for new trade */
  trailingSL   = null;
  partialTpHit = false;
  teslaT1Hit = false;
  teslaT2Hit = false;
  teslaT3Hit = false;
  teslaBEHit = false;
}

/* ---- True swing point detection ---- */
/**
 * A true swing low is a candle whose low is lower than the lows of
 * SWING_NEIGHBOR_BARS candles on each side.
 */
function isTrueSwingLow(idx) {
  const n = SWING_NEIGHBOR_BARS;
  if (idx - n < 0 || idx + n >= candles.length) return false;
  const low = candles[idx].low;
  for (let i = idx - n; i <= idx + n; i++) {
    if (i === idx) continue;
    if (candles[i].low <= low) return false;
  }
  return true;
}

function isTrueSwingHigh(idx) {
  const n = SWING_NEIGHBOR_BARS;
  if (idx - n < 0 || idx + n >= candles.length) return false;
  const high = candles[idx].high;
  for (let i = idx - n; i <= idx + n; i++) {
    if (i === idx) continue;
    if (candles[i].high >= high) return false;
  }
  return true;
}

function findSwingLow(upToIdx) {
  /* Scalping mode uses tighter lookback for closer SL (from MD: minimize risk) */
  const effectiveLookback = scalpingModeEnabled ? SCALP_LOOKBACK : SWING_LOOKBACK_PERIOD;
  const lookback = Math.max(0, upToIdx - effectiveLookback);

  /* Try true swing point first (scan from most recent backwards) */
  for (let i = upToIdx - SWING_NEIGHBOR_BARS; i >= lookback + SWING_NEIGHBOR_BARS; i--) {
    if (isTrueSwingLow(i)) return candles[i].low;
  }

  /* Fallback to simple min in lookback window */
  let low = Infinity;
  for (let i = lookback; i <= upToIdx; i++) {
    if (candles[i].low < low) low = candles[i].low;
  }
  return low;
}

function findSwingHigh(upToIdx) {
  /* Scalping mode uses tighter lookback for closer SL (from MD: minimize risk) */
  const effectiveLookback = scalpingModeEnabled ? SCALP_LOOKBACK : SWING_LOOKBACK_PERIOD;
  const lookback = Math.max(0, upToIdx - effectiveLookback);

  /* Try true swing point first (scan from most recent backwards) */
  for (let i = upToIdx - SWING_NEIGHBOR_BARS; i >= lookback + SWING_NEIGHBOR_BARS; i--) {
    if (isTrueSwingHigh(i)) return candles[i].high;
  }

  /* Fallback to simple max in lookback window */
  let high = -Infinity;
  for (let i = lookback; i <= upToIdx; i++) {
    if (candles[i].high > high) high = candles[i].high;
  }
  return high;
}

/* ================= WIN/LOSS TRACKING ================= */

/* Record a lightweight "CONFIRMED" signal as soon as the confirmation pattern fires,
   before the trade is built. This makes the signal visible in the Live Signals banner
   at the confirmed stage. If a trade is subsequently built and passes all gates,
   recordSignal() upgrades this entry to "PENDING" with full trade details. */
function recordConfirmedSignal(confirmPattern) {
  const pattern = confirmPattern || "engulfing";
  const sym = _multiPanelProcessing || UI.symbolSelect.value;
  const signal = {
    time: new Date().toISOString(),
    symbol: sym,
    dir: breakout ? breakout.dir : null,
    entry: null,
    sl: null,
    tp: null,
    rr: null,
    result: "CONFIRMED",
    emaAligned: emaFilterEnabled && breakout ? isEmaAligned(breakout.dir) : null,
    htfTrend: getHTFTrend(),
    breakoutStrength: (breakout && breakout.strong) ? "STRONG" : "WEAK",
    partialTpHit: false,
    trailingSL: null,
    confluenceScore: null,
    srConfluence: breakout ? hasSRConfluence(breakout.level) : false,
    confirmPattern: pattern,
    rsiAtRetest: getCurrentRSI(),
    volumeSpike: breakout ? (breakout.volumeSpike != null ? breakout.volumeSpike : hasVolumeSpikeOnBreakout(breakout.candleIdx)) : null,
    session: getActiveSessionName(),
    fibLevel: null,
    macdHist: getCurrentMACD(),
    bbSqueeze: isBBSqueeze(),
    adx: adxValue > 0 ? +fmt(adxValue, 1) : null,
    stochK: getCurrentStoch() != null ? +fmt(getCurrentStoch(), 1) : null,
    volatilityRegime: adxValue > 0 ? getVolatilityRegime() : null,
    scalpingMode: scalpingModeEnabled,
    lotSize: null,
    pipsAtRisk: null,
    stake: null
  };
  signalHistory.push(signal);
  if (signalHistory.length > SIGNAL_HISTORY_MAX) signalHistory.shift();
  persistSignalHistory();
  updateStatsUI();
  updateSignalBanners();
}

function recordSignal(confirmPattern) {
  if (!trade) return;
  const pattern = confirmPattern || "engulfing";
  const fibResult = breakout ? getFibRetestLevel(breakout.level) : null;

  /* Try to upgrade the last CONFIRMED signal instead of creating a duplicate.
     Verify symbol matches to avoid upgrading a signal from a different panel. */
  const currentSymbol = _multiPanelProcessing || UI.symbolSelect.value;
  const lastIdx = signalHistory.length - 1;
  const lastConfirmed = lastIdx >= 0
    && signalHistory[lastIdx].result === "CONFIRMED"
    && signalHistory[lastIdx].symbol === currentSymbol
    ? signalHistory[lastIdx] : null;

  const signal = lastConfirmed || {};
  if (!lastConfirmed) signal.time = new Date().toISOString();
  signal.symbol = currentSymbol;
  signal.dir = trade.dir;
  signal.entry = trade.entry;
  signal.sl = trade.sl;
  signal.tp = trade.tp;
  signal.rr = trade.rr;
  signal.result = "PENDING";
  signal.emaAligned = emaFilterEnabled ? isEmaAligned(trade.dir) : null;
  signal.htfTrend = getHTFTrend();
  signal.breakoutStrength = (breakout && breakout.strong) ? "STRONG" : "WEAK";
  signal.partialTpHit = false;
  signal.trailingSL = null;
  signal.confluenceScore = computeConfluenceScore();
  signal.srConfluence = breakout ? hasSRConfluence(breakout.level) : false;
  signal.confirmPattern = pattern;
  signal.rsiAtRetest = getCurrentRSI();
  signal.volumeSpike = breakout ? (breakout.volumeSpike != null ? breakout.volumeSpike : hasVolumeSpikeOnBreakout(breakout.candleIdx)) : null;
  signal.session = getActiveSessionName();
  signal.fibLevel = fibResult ? (fibResult.ratio * 100).toFixed(1) + "%" : null;
  signal.macdHist = getCurrentMACD();
  signal.bbSqueeze = isBBSqueeze();
  signal.adx = adxValue > 0 ? +fmt(adxValue, 1) : null;
  signal.stochK = getCurrentStoch() != null ? +fmt(getCurrentStoch(), 1) : null;
  signal.volatilityRegime = adxValue > 0 ? getVolatilityRegime() : null;
  signal.scalpingMode = scalpingModeEnabled;
  signal.lotSize = null;
  signal.pipsAtRisk = null;
  signal.stake = null;

  /* Populate lot-size fields from account sizing */
  if (accountSize > 0 && riskPercent > 0) {
    const pm = calcPositionMetrics(trade);
    if (pm) {
      signal.lotSize    = pm.lotSize;
      signal.pipsAtRisk = pm.isSynthetic ? null : pm.pips;
      signal.stake      = null;  /* deprecated — using lot size for MT5 */
    }
  }
  if (!lastConfirmed) {
    signalHistory.push(signal);
    if (signalHistory.length > SIGNAL_HISTORY_MAX) signalHistory.shift();
  }
  /* Capture chart screenshot as data URL for PDF export */
  try {
    if (UI.canvas) signal.chartImage = UI.canvas.toDataURL("image/png");
  } catch (e) { /* canvas tainted or unavailable */ }
  monitoringTrade = true;
  persistSignalHistory();
  updateStatsUI();

  /* Auto-trade: place a Deriv contract when the toggle is enabled */
  if (autoTradeEnabled && !_historicalProcessing) {
    executeAutoTrade({ dir: trade.dir, entry: trade.entry, sl: trade.sl, tp: trade.tp, symbol: trade.symbol || getActiveSymbol(), source: "breakout" });
  }
}

/* ================= AUTO-TRADE SHARED MESSAGE HANDLER ================= */
/**
 * Handle auto-trade related WS messages (proposal, buy, POC, errors).
 * Called from BOTH the main WS onmessage and each multi-panel WS onmessage.
 *
 * @param {Object}    msg     — parsed WS message
 * @param {WebSocket} msgWs   — the WebSocket this message arrived on
 * @returns {boolean} true if the message was consumed (caller should return)
 */
function handleAutoTradeMessage(msg, msgWs) {

  /* ---- Error handling for auto-trade messages ---- */
  if (msg.error) {
    const pt = msg.passthrough || {};
    const tradeSymbol = pt.tradeSymbol || null;
    const isAutoTradeByPassthrough = pt.auto_trade;
    /* Match POC errors by contract ID */
    const isAutoTradeByContractId = msg.msg_type === "proposal_open_contract" &&
      findSlotByContractId(msg.echo_req && msg.echo_req.contract_id);
    /* Fallback: any proposal/buy error while there's a slot in-flight for the
       symbol embedded in passthrough */
    const slotForSymbol = tradeSymbol ? autoTradeSlots.get(tradeSymbol) : null;
    const isAutoTradeByInProgress = slotForSymbol && slotForSymbol.inProgress &&
      (msg.msg_type === "proposal" || msg.msg_type === "buy");

    if (isAutoTradeByPassthrough || isAutoTradeByContractId || isAutoTradeByInProgress) {
      const sym = tradeSymbol ||
        (isAutoTradeByContractId && isAutoTradeByContractId.symbol) || "?";
      const slot = tradeSymbol ? getAutoTradeSlot(tradeSymbol) :
        (isAutoTradeByContractId ? isAutoTradeByContractId.slot : null);
      const tradeId = msg.passthrough && msg.passthrough.tradeId;
      addLog(`⚠ [${sym}] Auto-trade error (${msg.msg_type}): ${msg.error.message}`);
      if (slot) {
        /* Remove the specific trade from activeTrades if tradeId is available */
        if (tradeId) {
          removeActiveTrade(sym, tradeId);
        } else {
          slot.inProgress = false;
        }
        slot.consecutiveErrors++;
        if (slot.consecutiveErrors >= AUTO_TRADE_MAX_CONSECUTIVE_ERRORS) {
          addLog(`🛑 Auto-trade paused — ${slot.consecutiveErrors} consecutive errors on ${sym}. Disable and re-enable to resume.`);
          autoTradeEnabled = false;
          autoTradeScalpEnabled = false;
          autoTradeStrategyEnabled = false;
          if (UI.autoTradeToggle)         UI.autoTradeToggle.checked = false;
          if (UI.autoTradeScalpToggle)    UI.autoTradeScalpToggle.checked = false;
          if (UI.autoTradeStrategyToggle) UI.autoTradeStrategyToggle.checked = false;
          slot.consecutiveErrors = 0;
        }
        if (!tradeId) {
          slot.contractId = null;
          slot.pendingContractId = null;
          clearAutoTradePendingTimeout(sym);
        }
      }
      resolveAutoTradeHistoryEntry(0, "ERROR", tradeSymbol);
      return true;
    }
    return false; /* not an auto-trade error — let caller handle */
  }

  /* ---- Proposal response → buy ---- */
  if (msg.msg_type === "proposal" && msg.passthrough && msg.passthrough.auto_trade) {
    const tradeSymbol = msg.passthrough.tradeSymbol;
    const tradeId = msg.passthrough.tradeId;
    const slot = tradeSymbol ? getAutoTradeSlot(tradeSymbol) : null;
    if (!slot || !slot.inProgress) {
      addLog(`⚠ Auto-trade proposal received but trade was cancelled — ignoring (${tradeSymbol || "?"})`);
      return true;
    }
    const proposal = msg.proposal || {};
    if (!proposal.id) {
      addLog(`⚠ [${tradeSymbol}] Auto-trade proposal missing ID — cannot buy`);
      if (tradeId) {
        removeActiveTrade(tradeSymbol, tradeId);
      } else {
        slot.inProgress = false;
        clearAutoTradePendingTimeout(tradeSymbol);
      }
      resolveAutoTradeHistoryEntry(0, "ERROR", tradeSymbol);
      return true;
    }
    const src = msg.passthrough.source || "breakout";
    const label = autoTradeSourceLabel(src, msg.passthrough.strategyName);
    addLog(`🤖 ${label} auto-trade: buying contract — ask $${proposal.ask_price} (${tradeSymbol})`);
    slot.consecutiveErrors = 0;  /* successful proposal — reset error counter */
    msgWs.send(JSON.stringify({
      buy: proposal.id,
      price: proposal.ask_price,
      passthrough: { auto_trade: true, source: src, strategyName: msg.passthrough.strategyName || null, tradeSymbol, tradeId }
    }));
    return true;
  }

  /* ---- Buy response ---- */
  if (msg.msg_type === "buy" && msg.passthrough && msg.passthrough.auto_trade) {
    const b = msg.buy;
    const tradeSymbol = msg.passthrough.tradeSymbol;
    const tradeId = msg.passthrough.tradeId;
    const slot = tradeSymbol ? getAutoTradeSlot(tradeSymbol) : null;
    const src = msg.passthrough.source || "breakout";
    const label = autoTradeSourceLabel(src, msg.passthrough.strategyName);
    const cid = String(b.contract_id);
    if (slot) {
      slot.contractId = cid;
      /* Update the specific trade entry with the contract ID */
      const tradeEntry = tradeId ? findTradeByTradeId(tradeSymbol, tradeId) : null;
      if (tradeEntry) {
        tradeEntry.contractId = cid;
        /* Clear the short proposal timeout and start the longer pending timeout */
        if (tradeEntry.pendingTimer) {
          clearTimeout(tradeEntry.pendingTimer);
          tradeEntry.pendingTimer = null;
        }
      }
    }
    addLog(`✅ ${label} auto-trade: contract purchased — ID ${b.contract_id}, paid $${b.buy_price} (${tradeSymbol})`);
    msgWs.send(JSON.stringify({
      proposal_open_contract: 1,
      contract_id: b.contract_id,
      subscribe: 1,
      passthrough: { auto_trade: true, source: src, strategyName: msg.passthrough.strategyName || null, tradeSymbol, tradeId }
    }));
    /* Start timeout to detect hung contracts (multiplier contracts can stay open for a long time) */
    if (tradeSymbol) startAutoTradePendingTimeout(tradeSymbol, msgWs, tradeId);
    return true;
  }

  /* ---- Proposal Open Contract (POC) updates ---- */
  if (msg.msg_type === "proposal_open_contract") {
    const poc = msg.proposal_open_contract;
    const pt = msg.passthrough || {};
    const tradeSymbol = pt.tradeSymbol || null;
    const tradeId = pt.tradeId || null;

    /* Match by passthrough OR by contract ID lookup */
    const hasPassthrough = pt.auto_trade;
    const byContractId = poc && findSlotByContractId(poc.contract_id);
    if (hasPassthrough || byContractId) {
      const sym = tradeSymbol || (byContractId && byContractId.symbol) || "?";
      const slot = tradeSymbol ? getAutoTradeSlot(tradeSymbol) :
        (byContractId ? byContractId.slot : null);
      if (!slot) return true; /* matched but no slot — nothing to update */

      const isSold = (poc && poc.is_sold) || (poc && poc.status === "sold");
      if (isSold && slot) {
        const profit = parseFloat(poc.profit) || 0;
        const won = profit > 0;
        const src = pt.source || "breakout";
        const label = autoTradeSourceLabel(src, pt.strategyName);
        addLog(`🤖 ${label} auto-trade result: ${won ? "WIN ✅" : "LOSS ❌"} — profit $${fmt(profit, 2)} (${sym})`);
        /* Remove the specific trade from activeTrades */
        const resolveTradeId = tradeId || (byContractId && byContractId.tradeEntry && byContractId.tradeEntry.tradeId);
        if (resolveTradeId) {
          removeActiveTrade(sym, resolveTradeId);
        } else {
          /* Fallback: remove by contractId match */
          const cid = poc && String(poc.contract_id);
          const matchEntry = slot.activeTrades.find(t => String(t.contractId) === cid);
          if (matchEntry) {
            removeActiveTrade(sym, matchEntry.tradeId);
          } else {
            slot.inProgress = false;
            slot.contractId = null;
            slot.pendingContractId = null;
          }
        }
        clearAutoTradePendingTimeout(sym, tradeId);
        resolveAutoTradeHistoryEntry(profit, won ? "WIN" : "LOSS", sym);
        /* Request a fresh balance in case the balance subscription missed
           the update (e.g. brief disconnect during contract settlement). */
        if (msgWs && msgWs.readyState === WebSocket.OPEN) {
          msgWs.send(JSON.stringify({ balance: 1, subscribe: 1 }));
        }
      }
      return true;
    }
  }

  /* ---- Balance stream ---- */
  if (msg.msg_type === "balance") {
    const bal = msg.balance;
    if (bal && bal.balance != null) {
      autoTradeBalance = parseFloat(bal.balance);
      if (sessionStartBalance == null) sessionStartBalance = autoTradeBalance;
      updateAutoTradeBalanceUI();
      updateAutoTradePLUI();
    }
    return true;
  }

  return false; /* message not consumed */
}

/* ================= AUTO-TRADE EXECUTION ================= */
/**
 * Place a multiplier trade on Deriv with SL/TP.
 *
 * @param {Object} signal - { dir, entry, sl, tp, symbol, source }
 *   dir    – "BULL" or "BEAR"
 *   entry  – entry price (used for SL/TP distance calc)
 *   sl     – stop-loss price
 *   tp     – take-profit price (may be null for pure trailing)
 *   symbol – Deriv symbol string
 *   source – "breakout" | "scalp" | "strategy" (for logging)
 *
 * Uses MULTUP/MULTDOWN contracts with limit_order.stop_loss and
 * limit_order.take_profit expressed as absolute distance from entry.
 */
function autoTradeSourceLabel(source, strategyName) {
  if (source === "scalp") return "⚡ Scalp";
  if (source === "strategy") {
    const STRAT_LABELS = {
      liquiditySweep: "🌊 Liquidity Sweep",
      stopLossHunt:   "🎯 Stop Loss Hunt",
      failedPinBar:   "📌 Failed Pin Bar",
      fibScalp:       "📐 Fib Golden Zone",
      po3:            "⚡ Power of 3",
      nyOpenRange:    "🕤 NY Open Range",
      sessionRange:   "🌍 Session Range",
      gridScalperMA:  "🔲 Grid Scalper MA"
    };
    return STRAT_LABELS[strategyName] || "📊 Strategy";
  }
  return "📈 Breakout";
}

function executeAutoTrade(signal) {
  /* Block if session TP/SL has been hit */
  if (autoTradeHalted) {
    addLog("⛔ Auto-trade blocked — session limit hit (reset session to resume)");
    return;
  }

  /* Route trade through the authenticated WebSocket — the public feed carries
     market data only (charts/indicators), never trade execution messages. */
  const tradeWs = authWs;
  if (!tradeWs || tradeWs.readyState !== WebSocket.OPEN) {
    addLog("⚠ Auto-trade skipped — auth WebSocket not connected (set Deriv token in Settings)");
    return;
  }
  if (!authorized) {
    addLog("⚠ Auto-trade skipped — not authorized (set Deriv token in Settings)");
    return;
  }
  if (!signal || !signal.dir || (signal.dir !== "BULL" && signal.dir !== "BEAR")) {
    addLog("⚠ Auto-trade skipped — invalid signal direction");
    return;
  }

  const symbol = signal.symbol || getActiveSymbol();
  const slot = getAutoTradeSlot(symbol);

  /* Allow multiple concurrent trades up to maxConcurrentTrades per symbol */
  const activeCount = slot.activeTrades.length;
  if (activeCount >= maxConcurrentTrades) {
    addLog(`⚠ Auto-trade skipped — max concurrent trades (${maxConcurrentTrades}) reached for ${symbol} (${activeCount} active)`);
    return;
  }

  /* Block if a multiplier fetch is in progress for this symbol */
  if (slot.fetchingMultiplier) {
    addLog(`⚠ Auto-trade skipped — fetching multiplier data for ${symbol}`);
    return;
  }

  /* Apply opposite mode: reverse direction for scalp / strategy if enabled */
  let effectiveDir = signal.dir;
  if (signal.source === "scalp" && autoTradeScalpOpposite) {
    effectiveDir = signal.dir === "BULL" ? "BEAR" : "BULL";
    addLog(`🔄 Opposite mode (Scalp): reversed ${signal.dir} → ${effectiveDir}`);
  } else if (signal.source === "strategy" && autoTradeStrategyOpposite) {
    effectiveDir = signal.dir === "BULL" ? "BEAR" : "BULL";
    addLog(`🔄 Opposite mode (Strategy): reversed ${signal.dir} → ${effectiveDir}`);
  }

  /* When opposite mode flips direction, recompute SL/TP by mirroring the
     original risk/reward *distances* around the entry rather than naively
     swapping the SL/TP price levels. A naive swap turns the original
     reward distance into the new risk and the original risk distance into
     the new reward — inverting the R:R ratio (e.g. a 1:2 setup becomes a
     2:1 setup), which is why opposite-mode trades were risking more than
     they stood to gain. Mirroring preserves the original risk and reward
     amounts, just reflected onto the opposite side of the entry. */
  let tradeSl = signal.sl;
  let tradeTp = signal.tp;
  if (effectiveDir !== signal.dir && tradeSl != null && tradeTp != null && signal.entry != null) {
    const riskDist = Math.abs(signal.entry - signal.sl);
    const rewardDist = Math.abs(signal.tp - signal.entry);
    if (effectiveDir === "BULL") {
      tradeSl = signal.entry - riskDist;
      tradeTp = signal.entry + rewardDist;
    } else {
      tradeSl = signal.entry + riskDist;
      tradeTp = signal.entry - rewardDist;
    }
  }

  const contractType = effectiveDir === "BULL" ? "MULTUP" : "MULTDOWN";
  /* Use the dynamic current stake (compounds on wins, resets on losses) */
  const stake = Math.max(MIN_AUTO_TRADE_STAKE, autoTradeCurrentStake);

  /* Validate multiplier against known valid values for this symbol.
     Check order: API cache → hardcoded fallback map → if neither exists,
     attempt an async fetch and retry.  This guarantees the multiplier
     is always valid before the proposal is sent. */
  let multiplier = parseInt(autoTradeMultiplier, 10) || DEFAULT_AUTO_TRADE_MULTIPLIER;
  const knownValid = getValidMultipliersForSymbol(symbol);

  if (knownValid && knownValid.length > 0) {
    /* We have valid values — correct the multiplier if needed */
    if (!knownValid.includes(multiplier)) {
      const corrected = pickBestMultiplier(knownValid, multiplier);
      addLog(`⚠ Multiplier ×${multiplier} invalid for ${symbol} — corrected to ×${corrected} (valid: ${knownValid.join(", ")})`);
      multiplier = corrected;
      autoTradeMultiplier = corrected;
      if (UI.autoTradeMultiplier) UI.autoTradeMultiplier.value = corrected;
      saveSettings();
    }
  } else {
    /* No cached or fallback data yet — try fetching from API before trading */
    addLog(`⏳ Fetching valid multipliers for ${symbol} before placing trade…`);
    slot.fetchingMultiplier = true;
    fetchValidMultipliers(symbol).then(apiValid => {
      slot.fetchingMultiplier = false;
      if (!apiValid || apiValid.length === 0) {
        addLog(`⚠ Could not fetch valid multipliers for ${symbol} — skipping trade`);
        return;
      }
      if (!apiValid.includes(multiplier)) {
        const corrected = pickBestMultiplier(apiValid, multiplier);
        autoTradeMultiplier = corrected;
        if (UI.autoTradeMultiplier) UI.autoTradeMultiplier.value = corrected;
        saveSettings();
      }
      /* Re-invoke with the (now-cached) data */
      executeAutoTrade(signal);
    }).catch(err => {
      slot.fetchingMultiplier = false;
      addLog(`⚠ Failed to fetch multipliers for ${symbol}: ${err.message || err}`);
    });
    return;
  }

  const label = autoTradeSourceLabel(signal.source, signal.strategyName);

  /* Build limit_order with SL and optional TP (distance from entry in USD).
     Dollar value formula: priceDist × multiplier × stake / entry
     When the raw SL value falls below Deriv's minimum, scale BOTH SL and TP
     proportionally so the strategy's R:R ratio (e.g. 1:2) is preserved. */
  const limitOrder = {};
  if (signal.entry != null) {
    let slVal = null;
    let tpVal = null;
    if (tradeSl != null) {
      const slDist = Math.abs(signal.entry - tradeSl);
      if (slDist > 0) slVal = slDist * multiplier * stake / signal.entry;
    }
    if (tradeTp != null) {
      const tpDist = Math.abs(tradeTp - signal.entry);
      if (tpDist > 0) tpVal = tpDist * multiplier * stake / signal.entry;
    }
    /* If the raw SL dollar value is below Deriv's minimum, scale both SL and TP
       by the same factor to keep the intended R:R ratio intact. */
    if (slVal !== null && slVal < MIN_LIMIT_ORDER_AMOUNT) {
      const scale = MIN_LIMIT_ORDER_AMOUNT / slVal;
      slVal *= scale;
      if (tpVal !== null) tpVal *= scale;
      addLog(`ℹ️ ${tpVal !== null ? "SL/TP" : "SL"} scaled ×${fmt(scale, 2)} to meet $${MIN_LIMIT_ORDER_AMOUNT} minimum (preserving R:R ratio)`);
    }
    if (slVal !== null) limitOrder.stop_loss = +fmt(slVal, 2);
    if (tpVal !== null) limitOrder.take_profit = +fmt(Math.max(tpVal, MIN_LIMIT_ORDER_AMOUNT), 2);
  }

  slot.inProgress = true;
  /* Generate unique trade ID for concurrent trade tracking (counter + timestamp = guaranteed unique) */
  const tradeId = `${symbol}_${Date.now()}_${++_autoTradeIdCounter}`;
  const tradeEntry = { tradeId, contractId: null, startTime: Date.now(), pendingTimer: null };
  slot.activeTrades.push(tradeEntry);

  const slLog = limitOrder.stop_loss != null ? ` SL $${limitOrder.stop_loss}` : "";
  const tpLog = limitOrder.take_profit != null ? ` TP $${limitOrder.take_profit}` : "";
  const oppositeTag = (effectiveDir !== signal.dir) ? " [OPPOSITE]" : "";
  addLog(`🤖 ${label} auto-trade: ${contractType} on ${symbol} — $${fmt(stake, 2)} ×${multiplier}${slLog}${tpLog}${oppositeTag}` + (maxConcurrentTrades > 1 ? ` [${slot.activeTrades.length}/${maxConcurrentTrades}]` : ""));

  /* Record pending trade in history */
  const isOpposite = (effectiveDir !== signal.dir);
  addAutoTradeHistoryEntry({ source: signal.source, strategyName: signal.strategyName, type: contractType, symbol, profit: null, result: "PENDING", originalDir: signal.dir, tradedDir: effectiveDir, isOpposite });

  const payload = {
    proposal: 1,
    amount: stake,
    basis: "stake",
    contract_type: contractType,
    currency: "USD",
    symbol,
    multiplier,
    passthrough: { auto_trade: true, source: signal.source || "breakout", strategyName: signal.strategyName || null, tradeSymbol: symbol, tradeId }
  };
  if (Object.keys(limitOrder).length > 0) payload.limit_order = limitOrder;

  tradeWs.send(JSON.stringify(payload));

  /* Start a short safety timeout for the proposal → buy window.
     If the buy doesn't happen within AUTO_TRADE_PROPOSAL_TIMEOUT_MS
     (e.g. the proposal errors out without triggering our error handler,
     or the WS drops silently), this ensures the trade is cleaned up
     instead of staying PENDING forever and blocking all future trades.
     Once the buy succeeds, the buy handler replaces this with the
     longer AUTO_TRADE_PENDING_TIMEOUT_MS via startAutoTradePendingTimeout(). */
  tradeEntry.pendingTimer = setTimeout(() => {
    tradeEntry.pendingTimer = null;
    if (tradeEntry.contractId) return;   /* buy succeeded — longer timeout running */
    addLog(`⚠ [${symbol}] Auto-trade proposal/buy timed out — cleaning up`);
    removeActiveTrade(symbol, tradeId);
    resolveAutoTradeHistoryEntry(0, "CANCELLED", symbol);
  }, AUTO_TRADE_PROPOSAL_TIMEOUT_MS);
}

/* ================= AUTO-TRADE HISTORY & BALANCE HELPERS ================= */

/** Clear the pending-trade timeout timer for a specific symbol slot or trade.
 *  @param {string} symbol — the symbol
 *  @param {string} [tradeId] — if provided, only clear the timer for this specific trade */
function clearAutoTradePendingTimeout(symbol, tradeId) {
  if (symbol) {
    const slot = autoTradeSlots.get(symbol);
    if (slot) {
      if (tradeId) {
        /* Clear timer for a specific trade entry */
        const entry = slot.activeTrades.find(t => t.tradeId === tradeId);
        if (entry && entry.pendingTimer) {
          clearTimeout(entry.pendingTimer);
          entry.pendingTimer = null;
        }
      } else if (slot.pendingTimer) {
        clearTimeout(slot.pendingTimer);
        slot.pendingTimer = null;
      }
    }
  }
  /* Legacy global fallback for callers that don't pass symbol */
  if (autoTradePendingTimer) {
    clearTimeout(autoTradePendingTimer);
    autoTradePendingTimer = null;
  }
}

/** Start a timeout that resolves a stuck PENDING trade after AUTO_TRADE_PENDING_TIMEOUT_MS.
 *  If the contract hasn't resolved by then, we attempt a one-shot status query;
 *  if the WS is not available, mark it as CANCELLED.
 *  @param {string} symbol — the symbol whose slot to use
 *  @param {WebSocket} [tradeWs] — the WS connection to use for the status query
 *  @param {string} [tradeId] — if provided, timeout is for a specific concurrent trade */
function startAutoTradePendingTimeout(symbol, tradeWs, tradeId) {
  const slot = getAutoTradeSlot(symbol);
  const wsRef = tradeWs || authWs;
  const tradeEntry = tradeId ? findTradeByTradeId(symbol, tradeId) : null;

  if (tradeEntry) {
    /* Per-trade timeout for concurrent mode */
    if (tradeEntry.pendingTimer) {
      clearTimeout(tradeEntry.pendingTimer);
      tradeEntry.pendingTimer = null;
    }
    tradeEntry.pendingTimer = setTimeout(() => {
      tradeEntry.pendingTimer = null;
      /* Check if this trade is still active */
      if (!slot.activeTrades.includes(tradeEntry)) return;

      /* Try one-shot query before giving up */
      if (wsRef && wsRef.readyState === WebSocket.OPEN && tradeEntry.contractId) {
        addLog(`⏰ [${symbol}] Pending trade timeout — querying contract ${tradeEntry.contractId} status…`);
        wsRef.send(JSON.stringify({
          proposal_open_contract: 1,
          contract_id: tradeEntry.contractId,
          passthrough: { auto_trade: true, source: "timeout_query", tradeSymbol: symbol, tradeId }
        }));
        /* Give the one-shot query 15 seconds to resolve, then force-cancel */
        tradeEntry.pendingTimer = setTimeout(() => {
          tradeEntry.pendingTimer = null;
          if (!slot.activeTrades.includes(tradeEntry)) return;
          addLog(`⚠ [${symbol}] Contract ${tradeEntry.contractId} did not resolve after timeout — marking as cancelled`);
          removeActiveTrade(symbol, tradeId);
          resolveAutoTradeHistoryEntry(0, "CANCELLED", symbol);
        }, AUTO_TRADE_QUERY_TIMEOUT_MS);
      } else {
        addLog(`⚠ [${symbol}] Pending trade timeout — no active connection to query contract status, marking as cancelled`);
        removeActiveTrade(symbol, tradeId);
        resolveAutoTradeHistoryEntry(0, "CANCELLED", symbol);
      }
    }, AUTO_TRADE_PENDING_TIMEOUT_MS);
  } else {
    /* Legacy single-trade timeout */
    clearAutoTradePendingTimeout(symbol);
    slot.pendingTimer = setTimeout(() => {
      slot.pendingTimer = null;
      if (!slot.inProgress) return; /* already resolved */

      /* Try one-shot query before giving up */
      if (wsRef && wsRef.readyState === WebSocket.OPEN && slot.contractId) {
        addLog(`⏰ [${symbol}] Pending trade timeout — querying contract ${slot.contractId} status…`);
        wsRef.send(JSON.stringify({
          proposal_open_contract: 1,
          contract_id: slot.contractId,
          passthrough: { auto_trade: true, source: "timeout_query", tradeSymbol: symbol }
        }));
        /* Give the one-shot query 15 seconds to resolve, then force-cancel */
        slot.pendingTimer = setTimeout(() => {
          slot.pendingTimer = null;
          if (!slot.inProgress) return;
          addLog(`⚠ [${symbol}] Contract ${slot.contractId} did not resolve after timeout — marking as cancelled`);
          slot.inProgress = false;
          slot.contractId = null;
          slot.pendingContractId = null;
          resolveAutoTradeHistoryEntry(0, "CANCELLED", symbol);
        }, AUTO_TRADE_QUERY_TIMEOUT_MS);
      } else {
        addLog(`⚠ [${symbol}] Pending trade timeout — no active connection to query contract status, marking as cancelled`);
        slot.inProgress = false;
        slot.contractId = null;
        slot.pendingContractId = null;
        resolveAutoTradeHistoryEntry(0, "CANCELLED", symbol);
      }
    }, AUTO_TRADE_PENDING_TIMEOUT_MS);
  }
}

/** Recompute cumulative P/L from actual trade history entries.
 *  This is the source-of-truth — we never rely on an incrementally
 *  accumulated value that can drift due to bugs or interruptions. */
function recalcAutoTradePL() {
  autoTradePL = autoTradeHistory.reduce((sum, e) => {
    if ((e.result === "WIN" || e.result === "LOSS") && typeof e.profit === "number") {
      return sum + e.profit;
    }
    return sum;
  }, 0);
}

/** Add a new entry to the auto-trade history array and re-render. */
function addAutoTradeHistoryEntry({ source, strategyName, type, symbol, profit, result, originalDir, tradedDir, isOpposite }) {
  const entry = {
    time: Date.now(),
    source: source || "breakout",
    strategyName: strategyName || null,
    type,
    symbol: symbol || "--",
    profit: profit != null ? profit : null,
    result: result || "PENDING",
    originalDir: originalDir || null,
    tradedDir: tradedDir || null,
    isOpposite: !!isOpposite
  };
  autoTradeHistory.unshift(entry);
  /* Cap history to 100 entries */
  if (autoTradeHistory.length > MAX_AUTO_TRADE_HISTORY) autoTradeHistory.length = MAX_AUTO_TRADE_HISTORY;
  renderAutoTradeHistory();
  persistAutoTradeHistory();
}

/** Resolve the most recent PENDING entry with profit and result.
 *  @param {number} profit
 *  @param {string} result — "WIN" | "LOSS" | "ERROR" | "CANCELLED"
 *  @param {string} [symbol] — if provided, only resolve a PENDING entry for this symbol */
function resolveAutoTradeHistoryEntry(profit, result, symbol) {
  const pending = symbol
    ? autoTradeHistory.find(e => e.result === "PENDING" && e.symbol === symbol)
    : autoTradeHistory.find(e => e.result === "PENDING");
  if (!pending) return;  /* nothing to resolve */
  pending.profit = profit;
  pending.result = result;
  /* Recompute P/L from all entries (prevents incremental drift) */
  recalcAutoTradePL();

  /* ── Stake management (mirrors bot.js handleResult logic) ── */
  const baseStake = Math.max(MIN_AUTO_TRADE_STAKE, parseFloat(autoTradeStake) || 1);
  if (result === "WIN") {
    autoTradeLossCount = 0;
    autoTradeWinStreak++;
    /* Pyramid up only after consecutive wins (controlled compounding) */
    if (autoTradeWinStreak >= AUTO_TRADE_WIN_STREAK_MIN) {
      const maxStake = (autoTradeMaxStake > 0 && autoTradeMaxStake >= baseStake)
        ? autoTradeMaxStake
        : baseStake * 4;  /* soft cap at 4× base when no explicit max set */
      autoTradeCurrentStake = Math.min(
        +(autoTradeCurrentStake * AUTO_TRADE_STAKE_SCALE).toFixed(2),
        maxStake
      );
      addLog(`📈 Auto-trade stake compounded → $${fmt(autoTradeCurrentStake, 2)} (${autoTradeWinStreak} consecutive wins)`);
    }
  } else if (result === "LOSS") {
    autoTradeWinStreak = 0;
    autoTradeLossCount++;
    autoTradeCurrentStake = baseStake;  /* reset to base stake on every loss */
    addLog(`🔁 Auto-trade stake reset to $${fmt(baseStake, 2)} after loss`);
    /* Loss cluster protection — pause after N consecutive losses */
    if (autoTradeLossCount >= AUTO_TRADE_MAX_LOSSES) {
      autoTradeHalted = true;
      addLog(`🛑 Auto-trade paused — ${AUTO_TRADE_MAX_LOSSES} consecutive losses reached. Reset session to resume.`);
    }
  }
  updateAutoTradeCurrentStakeUI();

  /* ── Session TP / SL check ── */
  checkAutoTradeSessionLimits();

  renderAutoTradeHistory();
  updateAutoTradePLUI();
  persistAutoTradeHistory();
}

/** Check session-level TP/SL — stop all auto-trading when cumulative P/L hits either limit. */
function checkAutoTradeSessionLimits() {
  if (autoTradeHalted) return;
  const tp = parseFloat(autoTradeSessionTP) || 0;
  const sl = parseFloat(autoTradeSessionSL) || 0;
  if (tp > 0 && autoTradePL >= tp) {
    autoTradeHalted = true;
    addLog(`✅ Auto-trade Session TP $${fmt(tp, 2)} reached — auto-trading halted. Reset session to resume.`);
  } else if (sl > 0 && autoTradePL <= -sl) {
    autoTradeHalted = true;
    addLog(`🛑 Auto-trade Session SL $${fmt(sl, 2)} reached — auto-trading halted. Reset session to resume.`);
  }
}

/** Update the live "current stake" display in the auto-trade panel. */
function updateAutoTradeCurrentStakeUI() {
  if (UI.autoTradeCurrentStakeDisplay) {
    UI.autoTradeCurrentStakeDisplay.textContent = `$${fmt(autoTradeCurrentStake, 2)}`;
    UI.autoTradeCurrentStakeDisplay.style.color =
      autoTradeCurrentStake > (parseFloat(autoTradeStake) || 1)
        ? "var(--success)" : "";
  }
}

/** Render the auto-trade history list in the DOM. */
function renderAutoTradeHistory() {
  if (!UI.autoTradeHistoryList || !UI.autoTradeHistoryEmpty) return;
  UI.autoTradeHistoryList.innerHTML = "";
  if (autoTradeHistory.length === 0) {
    UI.autoTradeHistoryEmpty.style.display = "";
    return;
  }
  UI.autoTradeHistoryEmpty.style.display = "none";
  for (const e of autoTradeHistory) {
    const li = document.createElement("li");
    const srcLabel = autoTradeSourceLabel(e.source, e.strategyName);
    const isBull = e.type === "MULTUP";
    const timeStr = new Date(e.time).toLocaleTimeString();

    let profitClass = "pending";
    let profitText = "⏳ Pending";
    if (e.result === "WIN") { profitClass = "win"; profitText = `+$${fmt(e.profit, 2)}`; }
    else if (e.result === "LOSS") { profitClass = "loss"; profitText = `−$${fmt(Math.abs(e.profit), 2)}`; }
    else if (e.result === "ERROR") { profitClass = "error"; profitText = "⚠ Error"; }
    else if (e.result === "CANCELLED") { profitClass = "cancelled"; profitText = "✖ Cancelled"; }

    /* Show opposite mode info: original signal → actual trade */
    let oppositeInfo = "";
    if (e.isOpposite && e.originalDir && e.tradedDir) {
      oppositeInfo = `<span class="at-opposite" title="Original signal: ${e.originalDir}, Traded: ${e.tradedDir}">🔄 ${e.originalDir}→${e.tradedDir}</span>`;
    }

    li.innerHTML =
      `<span class="at-source">${srcLabel}</span>` +
      `<span class="at-type ${isBull ? "bull" : "bear"}">${e.type}</span>` +
      oppositeInfo +
      `<span class="at-profit ${profitClass}">${profitText}</span>` +
      `<span class="at-time">${timeStr}</span>`;
    UI.autoTradeHistoryList.appendChild(li);
  }

  /* Render opposite mode effectiveness summary */
  renderOppositeModeSummary();
}

/**
 * Render opposite mode effectiveness summary.
 * Shows win rate for trades taken with opposite mode vs normal mode.
 */
function renderOppositeModeSummary() {
  const container = document.getElementById("oppositeModeSummary");
  if (!container) return;

  const oppTrades = autoTradeHistory.filter(e => e.isOpposite && (e.result === "WIN" || e.result === "LOSS"));
  const normalTrades = autoTradeHistory.filter(e => !e.isOpposite && (e.result === "WIN" || e.result === "LOSS"));

  if (oppTrades.length === 0 && normalTrades.length === 0) {
    container.innerHTML = "";
    container.style.display = "none";
    return;
  }

  container.style.display = "";

  const oppWins = oppTrades.filter(e => e.result === "WIN").length;
  const oppLosses = oppTrades.filter(e => e.result === "LOSS").length;
  const oppWR = oppTrades.length > 0 ? (oppWins / oppTrades.length * 100).toFixed(1) : "0.0";
  const oppPL = oppTrades.reduce((sum, e) => sum + (e.profit || 0), 0);

  const normWins = normalTrades.filter(e => e.result === "WIN").length;
  const normLosses = normalTrades.filter(e => e.result === "LOSS").length;
  const normWR = normalTrades.length > 0 ? (normWins / normalTrades.length * 100).toFixed(1) : "0.0";
  const normPL = normalTrades.reduce((sum, e) => sum + (e.profit || 0), 0);

  let html = `<div class="opposite-summary">`;
  html += `<div class="opposite-summary-title">📊 Signal Accuracy</div>`;
  if (normalTrades.length > 0) {
    html += `<div class="opposite-row"><span class="opp-label">Normal:</span> <span>${normWins}W / ${normLosses}L</span> <span class="opp-wr">${normWR}%</span> <span class="${normPL >= 0 ? 'opp-profit' : 'opp-loss'}">${normPL >= 0 ? '+' : ''}$${fmt(normPL, 2)}</span></div>`;
  }
  if (oppTrades.length > 0) {
    html += `<div class="opposite-row"><span class="opp-label">🔄 Opposite:</span> <span>${oppWins}W / ${oppLosses}L</span> <span class="opp-wr">${oppWR}%</span> <span class="${oppPL >= 0 ? 'opp-profit' : 'opp-loss'}">${oppPL >= 0 ? '+' : ''}$${fmt(oppPL, 2)}</span></div>`;
  }
  html += `</div>`;
  container.innerHTML = html;
}

/** Update the balance display value. */
function updateAutoTradeBalanceUI() {
  if (UI.autoTradeBalanceValue) {
    UI.autoTradeBalanceValue.textContent =
      autoTradeBalance != null ? `$${fmt(autoTradeBalance, 2)}` : "---";
  }
}

/** Update the P/L display value. */
function updateAutoTradePLUI() {
  if (UI.autoTradePLValue) {
    /* Use auto-trade history P/L if any trades have completed; otherwise show
       a live session P/L computed from balance changes so the display updates
       in real-time even before the first auto-trade resolves. */
    const hasCompletedTrades = autoTradeHistory.some(e => e.result === "WIN" || e.result === "LOSS");
    let displayPL = autoTradePL;
    if (!hasCompletedTrades && sessionStartBalance != null && autoTradeBalance != null) {
      displayPL = autoTradeBalance - sessionStartBalance;
    }
    const prefix = displayPL >= 0 ? "+$" : "−$";
    UI.autoTradePLValue.textContent = `${prefix}${fmt(Math.abs(displayPL), 2)}`;
    UI.autoTradePLValue.style.color =
      displayPL > 0 ? "var(--success)" :
      displayPL < 0 ? "var(--danger)" : "";
  }
}

/** Show/hide the balance section.
 *  Visible whenever the user is authorized (so they always see their balance
 *  and live session P/L) OR when any auto-trade toggle is on. */
function updateAutoTradeBalanceVisibility() {
  if (!UI.autoTradeBalanceSection) return;
  const anyEnabled = autoTradeEnabled || autoTradeScalpEnabled || autoTradeStrategyEnabled;
  /* Show balance section whenever authorized OR any auto-trade toggle is on */
  UI.autoTradeBalanceSection.style.display = (authorized || anyEnabled) ? "" : "none";
}

/** Persist auto-trade history to localStorage. */
function persistAutoTradeHistory() {
  try {
    localStorage.setItem(LS_PREFIX + "autoTradeHistory", JSON.stringify(autoTradeHistory));
    localStorage.setItem(LS_PREFIX + "autoTradePL", JSON.stringify(autoTradePL));
  } catch (e) { /* storage not available */ }
}

/** Restore auto-trade history from localStorage. */
function restoreAutoTradeHistory() {
  try {
    const raw = localStorage.getItem(LS_PREFIX + "autoTradeHistory");
    if (raw) {
      const parsed = JSON.parse(raw);
      autoTradeHistory = Array.isArray(parsed) ? parsed : [];
    }

    /* Clean up stale PENDING entries from previous sessions.
       If the page was closed/crashed without a proper WS close, PENDING
       entries may still be lingering. Mark them CANCELLED since the
       contract subscription is lost and we can't track them anymore. */
    let hadStale = false;
    for (const e of autoTradeHistory) {
      if (e.result === "PENDING") {
        e.result = "CANCELLED";
        e.profit = 0;
        hadStale = true;
      }
    }

    /* Always recompute P/L from actual history entries (self-healing).
       The stored autoTradePL value may have drifted due to bugs or
       interrupted sessions — the history entries are the source of truth. */
    recalcAutoTradePL();

    renderAutoTradeHistory();
    updateAutoTradePLUI();

    /* Persist cleaned-up state if we fixed stale entries */
    if (hadStale) persistAutoTradeHistory();
  } catch (e) { /* storage not available */ }
}

function monitorTradeOutcome(candle) {
  if (!monitoringTrade || !trade) return;
  const pending = signalHistory.find(s => s.result === "PENDING");
  if (!pending) { monitoringTrade = false; return; }

  const effectiveSL = trailingSL != null ? trailingSL : trade.sl;

  /* ---- Partial TP at 1:1 ---- */
  if (partialTpEnabled && !partialTpHit) {
    const risk = Math.abs(trade.entry - trade.sl);
    if (trade.dir === "BULL") {
      const partialLevel = trade.entry + risk; /* 1:1 reward */
      if (candle.high >= partialLevel) {
        partialTpHit = true;
        addLog(`Partial TP hit at 1:1 (${fmt(partialLevel, 4)}) — alert only, trade continues to full TP`);
        pending.partialTpHit = true;
        showToast("🔔 Partial TP Hit", `1:1 reached (${fmt(partialLevel, 4)}) — profits noted, trade continues to full TP`, "trade", 8000);
        sendPartialTpTelegram(pending, partialLevel);
        /* Defer SL/TP check to next candle to avoid dual-resolution on the
           same candle that triggered the partial TP alert. */
        return;
      }
    } else {
      const partialLevel = trade.entry - risk; /* 1:1 reward */
      if (candle.low <= partialLevel) {
        partialTpHit = true;
        addLog(`Partial TP hit at 1:1 (${fmt(partialLevel, 4)}) — alert only, trade continues to full TP`);
        pending.partialTpHit = true;
        showToast("🔔 Partial TP Hit", `1:1 reached (${fmt(partialLevel, 4)}) — profits noted, trade continues to full TP`, "trade", 8000);
        sendPartialTpTelegram(pending, partialLevel);
        /* Defer SL/TP check to next candle — same reasoning as BULL case above. */
        return;
      }
    }
  }

  /* ---- Tesla 3–6–9 Scaling Model ---- */
  if (teslaScalingEnabled) {
    const risk = Math.abs(trade.entry - trade.sl);
    const isBull = trade.dir === "BULL";

    /* Slide SL to breakeven at the plan's configured trigger:
       Conservative = +1R, Aggressive = +2R. */
    if (!teslaBEHit) {
      const beTrigger = teslaScalingPlan === "aggressive"
        ? TESLA_AGGRESSIVE_BE_TRIGGER
        : TESLA_CONSERVATIVE_BE_TRIGGER;
      const beLevel = isBull ? trade.entry + risk * beTrigger : trade.entry - risk * beTrigger;
      const beHit   = isBull ? candle.high >= beLevel : candle.low <= beLevel;
      if (beHit) {
        teslaBEHit = true;
        trade.sl = trade.entry;  /* slide SL to breakeven */
        /* Advance trailing SL to breakeven if it would regress below it */
        if (trailingSL != null) {
          trailingSL = isBull
            ? Math.max(trailingSL, trade.entry)
            : Math.min(trailingSL, trade.entry);
        }
        const beLabel = `+${beTrigger}R (${teslaScalingPlan} BE)`;
        addLog(`⚡ Tesla 3–6–9: SL moved to breakeven @ ${fmtPrice(trade.entry, pending.symbol)} at ${beLabel}`);
        showToast("⚡ Tesla BE", `SL locked at breakeven (${beLabel}) — running to T1 (3R)`, "info", 6000);
      }
    }

    /* T1 = 3R — first partial exit.
       Returns early to defer SL/TP resolution to the next candle; this prevents
       a simultaneous TP/SL hit on the same candle from overriding the scaling alert. */
    if (!teslaT1Hit) {
      const t1Level = isBull ? trade.entry + risk * TESLA_T1_R : trade.entry - risk * TESLA_T1_R;
      const t1Hit   = isBull ? candle.high >= t1Level : candle.low <= t1Level;
      if (t1Hit) {
        teslaT1Hit = true;
        pending.teslaT1Hit = true;
        const action = teslaScalingPlan === "conservative" ? "Close 50% of position" : "Close 25% of position";
        addLog(`⚡ Tesla 3–6–9: T1 (3R) reached @ ${fmtPrice(t1Level, pending.symbol)} — ${action}`);
        showToast("⚡ Tesla T1 (3R) ✓", `${action} | Next: T2 at ${TESLA_T2_R}R`, "trade", 8000);
        sendTeslaLevelTelegram(pending, "T1 (3R)", t1Level, teslaScalingPlan);
        return;
      }
    }

    /* T2 = 6R — second partial exit */
    if (teslaT1Hit && !teslaT2Hit) {
      const t2Level = isBull ? trade.entry + risk * TESLA_T2_R : trade.entry - risk * TESLA_T2_R;
      const t2Hit   = isBull ? candle.high >= t2Level : candle.low <= t2Level;
      if (t2Hit) {
        teslaT2Hit = true;
        pending.teslaT2Hit = true;
        const action = teslaScalingPlan === "conservative" ? "Close 30% of position" : "Close 35% of position";
        addLog(`⚡ Tesla 3–6–9: T2 (6R) reached @ ${fmtPrice(t2Level, pending.symbol)} — ${action}`);
        showToast("⚡ Tesla T2 (6R) ✓", `${action} | Next: T3 at ${TESLA_T3_R}R`, "trade", 8000);
        sendTeslaLevelTelegram(pending, "T2 (6R)", t2Level, teslaScalingPlan);
        return;
      }
    }

    /* T3 = 9R — final exit */
    if (teslaT1Hit && teslaT2Hit && !teslaT3Hit) {
      const t3Level = isBull ? trade.entry + risk * TESLA_T3_R : trade.entry - risk * TESLA_T3_R;
      const t3Hit   = isBull ? candle.high >= t3Level : candle.low <= t3Level;
      if (t3Hit) {
        teslaT3Hit = true;
        pending.teslaT3Hit = true;
        const action = teslaScalingPlan === "conservative" ? "Close remaining 20% — full exit" : "Close 20% — trail the rest";
        addLog(`⚡ Tesla 3–6–9: T3 (9R) reached @ ${fmtPrice(t3Level, pending.symbol)} — ${action}`);
        showToast("⚡ Tesla T3 (9R) ✓", `${action}`, "trade", 10000);
        sendTeslaLevelTelegram(pending, "T3 (9R)", t3Level, teslaScalingPlan);
        return;
      }
    }
  }

  /* ---- Trailing stop (ATR-based) ---- */
  if (trailingStopEnabled && atrValue > 0) {
    /* Scalping mode uses a tighter trailing stop (from MD: take profit quickly / move SL tighter) */
    const trailMult = (trade.scalpingMode) ? SCALP_TRAILING_ATR_MULT : TRAILING_STOP_ATR_MULT;
    if (trade.dir === "BULL") {
      const newTrail = candle.high - atrValue * trailMult;
      /* Only activate/advance trail when it strictly improves (is higher than) the effective SL.
         This intentionally prevents the trail from initialising below the original SL — the
         trailing stop only engages once price has moved far enough in profit that the ATR-based
         level exceeds the original SL.  Until that point checkSL falls back to trade.sl,
         ensuring the original hard stop is always honoured. */
      if (newTrail > effectiveSL) {
        trailingSL = newTrail;
      }
    } else {
      const newTrail = candle.low + atrValue * trailMult;
      /* Only activate/advance trail when it strictly improves (is lower than) the effective SL. */
      if (newTrail < effectiveSL) {
        trailingSL = newTrail;
      }
    }
    pending.trailingSL = trailingSL;
  }

  /* ---- Scalping max-candle timeout ---- */
  if (trade.scalpingMode && trade.entryIdx != null) {
    const candlesSinceEntry = candles.length - 1 - trade.entryIdx;
    if (candlesSinceEntry >= SCALP_MAX_CANDLES) {
      /* Time-based exit: close at current price (market close) */
      const exitPrice = candle.close;
      const inProfit = (trade.dir === "BULL" && exitPrice >= trade.entry) ||
                       (trade.dir === "BEAR" && exitPrice <= trade.entry);
      pending.result = inProfit ? "WIN" : "LOSS";
      pending.exitPrice = exitPrice;
      if (inProfit) signalWins++; else signalLosses++;
      addLog(`⏱ Scalp TIMEOUT (${SCALP_MAX_CANDLES} candles) — exit at ${fmt(exitPrice, 4)} → ${pending.result}`);
      monitoringTrade = false;
      persistSignalHistory();
      updateStatsUI();
      playPhaseAlert(inProfit ? "TRADE" : "RANGE");
      sendTradeOutcomeTelegram(pending);
      return;
    }
  }

  /* ---- Check SL / TP outcome ---- */
  const checkSL = trailingSL != null ? trailingSL : trade.sl;
  let resolved = false;

  if (trade.dir === "BULL") {
    const slHit = candle.low <= checkSL;
    const tpHit = !pureTrailingEnabled && trade.tp != null && candle.high >= trade.tp;
    if (slHit && tpHit) {
      /* Both levels hit in same candle — closer level was hit first */
      pending.result = checkSL > trade.entry ? "WIN" : resolveBothHit({ entry: trade.entry, sl: checkSL, tp: trade.tp, partialTpHit: partialTpHit === true });
      pending.exitPrice = pending.result === "WIN" ? trade.tp : checkSL;
      if (pending.result === "WIN") signalWins++; else signalLosses++;
      resolved = true;
      addLog(`Signal ${pending.result} — both levels hit (${pending.result === "WIN" ? "TP/breakeven" : "SL"} closer)`);
    } else if (slHit) {
      /* SL hit: only count as WIN if stop locked in genuine profit (strictly above entry). */
      if (checkSL > trade.entry) {
        pending.result = "WIN";
        pending.exitPrice = checkSL;
        signalWins++;
        resolved = true;
        addLog(`Signal WIN — trailing stop hit at ${fmt(checkSL, 4)} (above entry, profit locked${partialTpHit ? " after partial TP alert" : ""})`);
      } else {
        pending.result = "LOSS";
        pending.exitPrice = checkSL;
        signalLosses++;
        resolved = true;
        const exitNote = trailingSL != null ? " (trailing)" : "";
        addLog(`Signal LOSS — price hit SL at ${fmt(checkSL, 4)}${exitNote}`);
      }
    } else if (tpHit) {
      pending.result = "WIN";
      pending.exitPrice = trade.tp;
      signalWins++;
      resolved = true;
      addLog(`Signal WIN — price hit TP at ${fmt(trade.tp, 4)}`);
    }
  } else {
    const slHit = candle.high >= checkSL;
    const tpHit = !pureTrailingEnabled && trade.tp != null && candle.low <= trade.tp;
    if (slHit && tpHit) {
      pending.result = checkSL < trade.entry ? "WIN" : resolveBothHit({ entry: trade.entry, sl: checkSL, tp: trade.tp, partialTpHit: partialTpHit === true });
      pending.exitPrice = pending.result === "WIN" ? trade.tp : checkSL;
      if (pending.result === "WIN") signalWins++; else signalLosses++;
      resolved = true;
      addLog(`Signal ${pending.result} — both levels hit (${pending.result === "WIN" ? "TP/breakeven" : "SL"} closer)`);
    } else if (slHit) {
      if (checkSL < trade.entry) {
        pending.result = "WIN";
        pending.exitPrice = checkSL;
        signalWins++;
        resolved = true;
        addLog(`Signal WIN — trailing stop hit at ${fmt(checkSL, 4)} (below entry, profit locked${partialTpHit ? " after partial TP alert" : ""})`);
      } else {
        pending.result = "LOSS";
        pending.exitPrice = checkSL;
        signalLosses++;
        resolved = true;
        const exitNote = trailingSL != null ? " (trailing)" : "";
        addLog(`Signal LOSS — price hit SL at ${fmt(checkSL, 4)}${exitNote}`);
      }
    } else if (tpHit) {
      pending.result = "WIN";
      pending.exitPrice = trade.tp;
      signalWins++;
      resolved = true;
      addLog(`Signal WIN — price hit TP at ${fmt(trade.tp, 4)}`);
    }
  }

  if (resolved) {
    monitoringTrade = false;
    persistSignalHistory();
    updateStatsUI();
    playPhaseAlert(pending.result === "WIN" ? "TRADE" : "RANGE");
    sendTradeOutcomeTelegram(pending);
    /* Feature 13: record confluence factor outcome for adaptive weighting */
    if (adaptiveConfluenceEnabled && pending._confFactors) {
      recordConfluenceOutcome(pending._confFactors, pending.result);
    }
  }
}

/* ================= CHART DRAWING ================= */

function getColors() {
  const isLight = currentTheme === "light";
  return {
    bg:            isLight ? "#f8fafc" : "#0a0f1e",
    grid:          isLight ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.04)",
    gridText:      "#64748b",
    bullCandle:    "#22c55e",
    bearCandle:    "#ef4444",
    wick:          "#94a3b8",
    rangeFill:     "rgba(59,130,246,0.12)",
    rangeBorder:   "#3b82f6",
    breakoutBull:  "rgba(34,197,94,0.18)",
    breakoutBear:  "rgba(239,68,68,0.18)",
    breakoutBullBorder: "#22c55e",
    breakoutBearBorder: "#ef4444",
    retest:        "rgba(251,191,36,0.25)",
    retestBorder:  "#fbbf24",
    confirm:       "rgba(168,85,247,0.25)",
    confirmBorder: "#a855f7",
    entryLine:     "#38bdf8",
    slLine:        "#ef4444",
    tpLine:        "#22c55e",
    crosshairText: isLight ? "#1e293b" : "#e5e7eb",
    emaFast:       "#f59e0b",
    emaSlow:       "#8b5cf6",
    emaHTF:        "#06b6d4",    /* cyan for HTF EMA 100 */
    trailingSL:    "#f97316",    /* orange for trailing stop */
    breakoutHighLine: "#22c55e", /* green for breakout high level */
    breakoutLowLine:  "#ef4444"  /* red for breakout low level */
  };
}

/* ===============================================================
   FEATURE IMPLEMENTATIONS (17 enhancements)
   =============================================================== */

/* ---- Feature 2: Strategy 12 — Orderblock Detection ---- */
function detectOrderblockStrategy(idx) {
  if (!orderblockEnabled) return;
  if (idx < ORDERBLOCK_LOOKBACK + 3) return;
  if (idx - lastOrderblockIdx < ORDERBLOCK_COOLDOWN) return;
  if (atrValue <= 0) return;
  const c = candles[idx];
  if (!c) return;

  for (let impStart = idx - 1; impStart >= Math.max(1, idx - ORDERBLOCK_IMPULSE_LOOKBACK); impStart--) {
    const impulseLen = idx - impStart + 1;
    if (impulseLen < 3) continue;
    let bullCount = 0, bearCount = 0, strongCount = 0, totalMove = 0;
    for (let j = impStart; j <= idx; j++) {
      const ic = candles[j]; if (!ic) break;
      const body = Math.abs(ic.close - ic.open);
      const rng  = ic.high - ic.low;
      if (ic.close > ic.open) bullCount++; else bearCount++;
      if (rng > 0 && body / rng >= 0.50) strongCount++;
      totalMove += rng;
    }
    const dir = bullCount >= Math.ceil(impulseLen * ORDERBLOCK_IMPULSE_DOMINANCE)  ? "BULL"
              : bearCount >= Math.ceil(impulseLen * ORDERBLOCK_IMPULSE_DOMINANCE)  ? "BEAR" : null;
    if (!dir) continue;
    if (strongCount < Math.ceil(impulseLen * ORDERBLOCK_STRONG_CANDLE_RATIO)) continue;
    if (totalMove < ORDERBLOCK_MIN_IMPULSE_ATR * atrValue) continue;

    /* Last opposing candle before impulse start = orderblock */
    let obIdx = impStart - 1;
    while (obIdx >= Math.max(0, impStart - 5)) {
      const oc = candles[obIdx]; if (!oc) break;
      if (dir === "BULL" && oc.close < oc.open) break;
      if (dir === "BEAR" && oc.close > oc.open) break;
      obIdx--;
    }
    if (obIdx < 0) continue;
    const obCandle = candles[obIdx];
    if (!obCandle) continue;

    /* Current price must be retesting the OB zone */
    const zoneTol = atrValue * ORDERBLOCK_ZONE_TOLERANCE_ATR;
    const inZone = c.close >= obCandle.low - zoneTol && c.close <= obCandle.high + zoneTol;
    if (!inZone) continue;

    if (minConfluenceEnabled) {
      if (computeConfluenceScore(dir, c.close, idx) < minConfluenceValue) continue;
    }

    const sl = dir === "BULL" ? obCandle.low  - atrValue * ORDERBLOCK_SL_BUFFER_ATR * getStrategyProfitParams().slBufferMult
                              : obCandle.high + atrValue * ORDERBLOCK_SL_BUFFER_ATR * getStrategyProfitParams().slBufferMult;
    const risk = Math.abs(c.close - sl);
    if (risk <= 0 || risk > ORDERBLOCK_MAX_SL_ATR * atrValue) continue;
    const rr = getStrategyProfitParams().rrLiquiditySweep;
    const tp = dir === "BULL" ? c.close + risk * rr : c.close - risk * rr;

    const signal = {
      dir, entry: c.close, sl, tp, rr,
      obHigh: obCandle.high, obLow: obCandle.low, obIdx, candleIdx: idx,
      symbol: getActiveSymbol(), epoch: c.epoch,
      type: "orderblock", result: "PENDING", strategyName: "orderblock",
      _stratOutcomeSent: false,
      _sentViaTelegram: (telegramStrategyAutoSend && !_historicalProcessing)
    };
    orderblockHistory.unshift(signal);
    if (orderblockHistory.length > ORDERBLOCK_MAX_HISTORY) orderblockHistory.pop();
    lastOrderblockIdx = idx;

    addLog(`🏦 Orderblock ${dir} @ #${idx}: OB [${fmt(obCandle.low,4)}–${fmt(obCandle.high,4)}] entry ${fmt(c.close,4)} SL ${fmt(sl,4)} TP ${fmt(tp,4)}`);
    showToast(`🏦 Orderblock ${dir === "BULL" ? "▲" : "▼"}`, `Entry ${fmt(c.close,4)} | SL ${fmt(sl,4)} | TP ${fmt(tp,4)}`, "info", 8000);
    if (!_historicalProcessing) {
      addStrategyTickerItem({ dir, type: "orderblock", label: `🏦 OB ${dir}`, entry: c.close, epoch: c.epoch });
      if (telegramStrategyAutoSend) setTimeout(() => sendStrategyTelegramAlert(signal), CHART_RENDER_DELAY_MS);
    }
    if (autoTradeStrategyEnabled && autoTradeOrderblock) triggerAutoTrade(signal, "orderblock");
    updateStrategyBadges();
    drawChart();
    break;
  }
}

function monitorOrderblockOutcomes(idx) {
  if (!orderblockEnabled || orderblockHistory.length === 0) return;
  for (const s of orderblockHistory) {
    if (s.result !== "PENDING") continue;
    if (s.candleIdx >= idx) continue;
    const c = candles[idx]; if (!c) continue;
    let result = null;
    if (s.dir === "BULL") { if (c.high >= s.tp) result = "WIN"; if (c.low  <= s.sl) result = "LOSS"; }
    else                  { if (c.low  <= s.tp) result = "WIN"; if (c.high >= s.sl) result = "LOSS"; }
    if (result) {
      s.result = result;
      addLog(`🏦 Orderblock ${s.dir} → ${result} (#${idx})`);
      if (!_historicalProcessing && telegramStrategyOutcomeSend && !s._stratOutcomeSent) {
        s._stratOutcomeSent = true;
        sendStrategyOutcomeTelegram(s);
      }
      if (adaptiveConfluenceEnabled) recordConfluenceOutcome(s._confFactors || [], result);
      updateStatsUI();
    }
  }
}

/* ---- Feature 5: BOS / ChoCH Detection ---- */
function detectBosChoch() {
  if (!bosChochEnabled || candles.length < 20) { bosChochMarkers = []; return; }
  bosChochMarkers = [];
  const lookback = Math.min(candles.length, 100);
  const start = candles.length - lookback;
  const swingDetectionPeriod = 3; /* candles on each side required to confirm a swing point */
  const swingHighs = [], swingLows = [];
  for (let i = start + swingDetectionPeriod; i < candles.length - swingDetectionPeriod; i++) {
    const c = candles[i];
    let isH = true, isL = true;
    for (let k = 1; k <= swingDetectionPeriod; k++) {
      if (candles[i-k].high >= c.high || candles[i+k].high >= c.high) isH = false;
      if (candles[i-k].low  <= c.low  || candles[i+k].low  <= c.low)  isL = false;
    }
    if (isH) swingHighs.push({ idx: i, price: c.high });
    if (isL) swingLows.push({ idx: i, price: c.low });
  }
  if (swingHighs.length < 2 || swingLows.length < 2) return;
  const inUptrend   = swingHighs[swingHighs.length-1].price > swingHighs[swingHighs.length-2].price
                   && swingLows[swingLows.length-1].price   > swingLows[swingLows.length-2].price;
  const inDowntrend = swingHighs[swingHighs.length-1].price < swingHighs[swingHighs.length-2].price
                   && swingLows[swingLows.length-1].price   < swingLows[swingLows.length-2].price;
  for (let i = Math.max(start, candles.length - 40); i < candles.length; i++) {
    const c = candles[i];
    const lastSH = swingHighs[swingHighs.length - 1];
    const lastSL = swingLows[swingLows.length - 1];
    if (lastSH.idx < i && c.close > lastSH.price && !bosChochMarkers.find(m => m.idx === i && m.dir === "BULL")) {
      bosChochMarkers.push({ idx: i, type: inUptrend ? "BOS" : "ChoCH", dir: "BULL", price: lastSH.price });
    }
    if (lastSL.idx < i && c.close < lastSL.price && !bosChochMarkers.find(m => m.idx === i && m.dir === "BEAR")) {
      bosChochMarkers.push({ idx: i, type: inDowntrend ? "BOS" : "ChoCH", dir: "BEAR", price: lastSL.price });
    }
  }
  if (bosChochMarkers.length > 6) bosChochMarkers = bosChochMarkers.slice(-6);
}

/* ---- Feature 7: Divergence visual marker builder ---- */
function buildDivergenceMarkers() {
  divergenceMarkers = [];
  if (!divergenceVisualEnabled || !breakout || !retestInfo) return;
  if (rsiValues.length < 10) return;
  const boIdx = breakout.candleIdx, rtIdx = retestInfo.candleIdx;
  if (boIdx >= rsiValues.length || rtIdx >= rsiValues.length) return;
  const rsiBO = rsiValues[boIdx], rsiRT = rsiValues[rtIdx];
  if (rsiBO == null || rsiRT == null) return;
  divergenceMarkers.push({
    boIdx, rtIdx, dir: breakout.dir,
    rsiBO, rsiRT,
    priceBO: candles[boIdx].close,
    priceRT: candles[rtIdx].close
  });
}

/* ---- Feature 4: Named Settings Profiles ---- */

/**
 * Return Authorization headers for the profiles API.
 * Falls back gracefully when ITGuruAuth is not available.
 */
function profileApiHeaders() {
  const h = { "Content-Type": "application/json" };
  if (typeof ITGuruAuth !== "undefined" && ITGuruAuth.getToken()) {
    h["Authorization"] = "Bearer " + ITGuruAuth.getToken();
  }
  return h;
}

/**
 * Fetch a profiles API URL, automatically retrying with .php extension on 404
 * (for hosts without mod_rewrite URL rewriting).
 */
async function profileApiFetch(url, options = {}) {
  const opts = { ...options, headers: Object.assign(profileApiHeaders(), options.headers || {}) };
  let resp = await fetch(url, opts);
  if (resp.status === 404) {
    const phpUrl = url.includes("?") ? url.replace("?", ".php?") : url + ".php";
    resp = await fetch(phpUrl, opts);
  }
  return resp;
}

/**
 * Fetch profiles from the server and merge them into savedProfiles.
 * Own profiles and admin-assigned profiles are both included.
 * Falls back to localStorage-only when the user is not logged in or
 * the request fails.
 */
async function loadProfiles() {
  /* Always restore localStorage first so profiles are available immediately */
  try {
    const raw = localStorage.getItem(PROFILES_LS_KEY);
    if (raw) savedProfiles = JSON.parse(raw);
  } catch(e) { savedProfiles = {}; }

  /* Skip server sync when not logged in */
  if (typeof ITGuruAuth === "undefined" || !ITGuruAuth.isLoggedIn()) {
    renderProfilesList();
    return;
  }

  try {
    const resp = await profileApiFetch(PROFILES_API_URL);
    if (!resp.ok) return;

    const data = await resp.json();

    /* Merge server profiles into savedProfiles.
       Server profiles carry an id; assigned profiles are marked read-only. */
    const merged = Object.assign({}, savedProfiles);

    for (const p of (data.own || [])) {
      merged[p.name] = Object.assign({}, p.settings || {}, {
        _serverId: p.id,
        _readOnly: false,
      });
    }
    for (const p of (data.assigned || [])) {
      merged[p.name] = Object.assign({}, p.settings || {}, {
        _serverId: p.id,
        _readOnly: true,
        _assignedBy: p.assigned_by_username || "admin",
      });
    }

    savedProfiles = merged;
    _persistProfiles();
    renderProfilesList();
  } catch(e) {
    /* Non-fatal — continue with localStorage profiles */
    addLog("⚠️ Could not load profiles from server");
  }
}

function _persistProfiles() {
  try { localStorage.setItem(PROFILES_LS_KEY, JSON.stringify(savedProfiles)); }
  catch(e) { addLog("⚠️ Could not save profiles to storage"); }
}

async function saveProfile(name) {
  if (!name || !name.trim()) return;
  const trimmed = name.trim();
  try {
    const raw = localStorage.getItem(LS_PREFIX + "settings");
    const settings = raw ? JSON.parse(raw) : {};

    /* Preserve server metadata if profile already exists */
    const existing  = savedProfiles[trimmed] || {};
    const serverId  = existing._serverId || null;
    const isReadOnly = existing._readOnly || false;

    if (isReadOnly) {
      showToast("Read-only Profile", `"${trimmed}" was assigned by ${existing._assignedBy || "admin"} and cannot be overwritten.`, "warning", 4000);
      return;
    }

    savedProfiles[trimmed] = Object.assign({}, settings, serverId ? { _serverId: serverId, _readOnly: false } : {});
    _persistProfiles();
    renderProfilesList();
    addLog(`💾 Profile saved: "${trimmed}"`);
    showToast("Profile Saved", `"${trimmed}" saved successfully.`, "success", 3000);

    /* Sync to server if logged in */
    if (typeof ITGuruAuth === "undefined" || !ITGuruAuth.isLoggedIn()) {
      addLog("ℹ️ Profile synced locally only (not logged in)");
      showToast("Saved Locally Only", `"${trimmed}" is available on this browser, but sign in to make it appear in Admin Profile Management.`, "warning", 5000);
      return;
    }

    try {
      const body = { name: trimmed, settings };
      if (serverId) body.id = serverId;

      const resp = await profileApiFetch(PROFILES_API_URL, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      const result = await resp.json();
      if (result.id) {
        savedProfiles[trimmed]._serverId = result.id;
        _persistProfiles();
      }
    } catch(e) {
      addLog(`⚠️ Profile could not be synced to server: ${e.message || e}`);
      showToast("Server Sync Failed", `"${trimmed}" was saved locally only, so it may not appear in Admin Profile Management yet.`, "warning", 6000);
    }
  } catch(e) { addLog("⚠️ Profile save failed"); }
}

function loadProfile(name) {
  if (!name || !savedProfiles[name]) return;
  try {
    /* Strip internal metadata before restoring settings */
    const snapshot = Object.assign({}, savedProfiles[name]);
    delete snapshot._serverId;
    delete snapshot._readOnly;
    delete snapshot._assignedBy;

    localStorage.setItem(LS_PREFIX + "settings", JSON.stringify(snapshot));
    restoreSettings();
    addLog(`📂 Profile loaded: "${name}"`);
    showToast("Profile Loaded", `"${name}" applied. Reconnect to use new settings.`, "info", 5000);
  } catch(e) { addLog("⚠️ Profile load failed"); }
}

async function deleteProfile(name) {
  if (!name || !savedProfiles[name]) return;
  const profile   = savedProfiles[name];
  const isReadOnly = profile._readOnly || false;
  const serverId  = profile._serverId  || null;

  if (isReadOnly) {
    showToast("Read-only Profile", `"${name}" was assigned by admin and cannot be deleted.`, "warning", 4000);
    return;
  }

  delete savedProfiles[name];
  _persistProfiles();
  renderProfilesList();
  addLog(`🗑 Profile deleted: "${name}"`);

  /* Remove from server if it has a server id */
  if (serverId && typeof ITGuruAuth !== "undefined" && ITGuruAuth.isLoggedIn()) {
    try {
      await profileApiFetch(PROFILES_API_URL + "?id=" + serverId, { method: "DELETE" });
    } catch(e) {
      addLog("⚠️ Profile could not be removed from server");
    }
  }
}

function renderProfilesList() {
  const list = document.getElementById("profilesList");
  if (!list) return;
  list.innerHTML = "";
  const names = Object.keys(savedProfiles);
  if (names.length === 0) {
    list.innerHTML = '<span class="hint" style="font-size:0.75rem;opacity:0.6;">No saved profiles</span>';
    return;
  }
  for (const name of names) {
    const profile   = savedProfiles[name] || {};
    const isReadOnly = profile._readOnly  || false;
    const assignedBy = profile._assignedBy || "admin";

    const row = document.createElement("div");
    row.className = "profile-row";
    if (isReadOnly) row.classList.add("profile-row-assigned");

    const nameSpan = document.createElement("span");
    nameSpan.className = "profile-name";
    nameSpan.textContent = name;
    if (isReadOnly) {
      const badge = document.createElement("span");
      badge.className = "profile-badge-admin";
      badge.title     = `Assigned by ${assignedBy}`;
      badge.textContent = "📌";
      nameSpan.appendChild(badge);
    }

    const loadBtn = document.createElement("button");
    loadBtn.className = "profile-btn profile-btn-load";
    loadBtn.textContent = "Load";
    loadBtn.addEventListener("click", () => loadProfile(name));

    row.appendChild(nameSpan);
    row.appendChild(loadBtn);

    if (!isReadOnly) {
      const delBtn = document.createElement("button");
      delBtn.className = "profile-btn profile-btn-del";
      delBtn.textContent = "✕";
      delBtn.addEventListener("click", () => { if (confirm(`Delete profile "${name}"?`)) deleteProfile(name); });
      row.appendChild(delBtn);
    }

    list.appendChild(row);
  }
}

/* ---- Feature 12: Signal Notes ---- */
function loadSignalNotes() {
  try {
    const raw = localStorage.getItem(SIGNAL_NOTES_LS_KEY);
    if (raw) signalNotes = JSON.parse(raw);
  } catch(e) { signalNotes = {}; }
}
function saveSignalNote(id, note) {
  if (!id) return;
  if (note && note.trim()) signalNotes[id] = note.trim();
  else delete signalNotes[id];
  try { localStorage.setItem(SIGNAL_NOTES_LS_KEY, JSON.stringify(signalNotes)); }
  catch(e) {}
}
function getSignalNote(id) { return signalNotes[id] || ""; }

/* ---- Feature 3: Equity Curve Chart ---- */
function drawEquityCurve() {
  const canvas = document.getElementById("equityCurveCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const W = rect.width  || 280;
  const H = rect.height || 100;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = currentTheme === "light" ? "#f8fafc" : "#0f172a";
  ctx.fillRect(0, 0, W, H);

  const resolved = autoTradeHistory.filter(e => (e.result === "WIN" || e.result === "LOSS") && typeof e.profit === "number");
  if (resolved.length < 2) {
    ctx.fillStyle = currentTheme === "light" ? "#94a3b8" : "#64748b";
    ctx.font = "11px Arial";
    ctx.textAlign = "center";
    ctx.fillText("Not enough trade data yet", W / 2, H / 2);
    return;
  }
  const pl = [];
  let cumPL = 0;
  for (const e of resolved) { cumPL += e.profit; pl.push(cumPL); }
  const maxPL = Math.max(...pl, 0);
  const minPL = Math.min(...pl, 0);
  const range = (maxPL - minPL) || 1;
  const mL = 6, mR = 6, mT = 10, mB = 24;
  const cW = W - mL - mR, cH = H - mT - mB;
  const xOf = i => mL + (i / (pl.length - 1)) * cW;
  const yOf = v => mT + (1 - (v - minPL) / range) * cH;
  const zy = yOf(0);
  ctx.strokeStyle = "rgba(148,163,184,0.2)";
  ctx.lineWidth = 0.5;
  ctx.setLineDash([3,3]);
  ctx.beginPath(); ctx.moveTo(mL, zy); ctx.lineTo(W - mR, zy); ctx.stroke();
  ctx.setLineDash([]);
  const lastPL = pl[pl.length - 1];
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < pl.length; i++) { const x = xOf(i), y = yOf(pl[i]); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
  ctx.strokeStyle = lastPL >= 0 ? "#22c55e" : "#ef4444";
  ctx.stroke();
  ctx.lineTo(xOf(pl.length-1), zy); ctx.lineTo(xOf(0), zy); ctx.closePath();
  const grad = ctx.createLinearGradient(0, mT, 0, mT + cH);
  if (lastPL >= 0) { grad.addColorStop(0, "rgba(34,197,94,0.22)"); grad.addColorStop(1, "rgba(34,197,94,0.01)"); }
  else             { grad.addColorStop(0, "rgba(239,68,68,0.01)");  grad.addColorStop(1, "rgba(239,68,68,0.18)"); }
  ctx.fillStyle = grad; ctx.fill();
  ctx.font = "bold 10px Arial"; ctx.textAlign = "right";
  ctx.fillStyle = lastPL >= 0 ? "#22c55e" : "#ef4444";
  ctx.fillText(`$${lastPL >= 0 ? "+" : ""}${fmt(lastPL, 2)}`, W - mR - 2, mT + 12);
  /* Metrics */
  let peak = 0, maxDD = 0, totalWin = 0, totalLoss = 0, wins = 0, losses = 0;
  for (const v of pl) { if (v > peak) peak = v; const dd = peak - v; if (dd > maxDD) maxDD = dd; }
  for (const e of resolved) { if (e.profit > 0) { totalWin += e.profit; wins++; } else { totalLoss += Math.abs(e.profit); losses++; } }
  const pf       = totalLoss > 0 ? totalWin / totalLoss : Infinity;
  const winRate  = resolved.length > 0 ? wins / resolved.length : 0;
  const avgWin   = wins   > 0 ? totalWin  / wins   : 0;
  const avgLoss  = losses > 0 ? totalLoss / losses : 0;
  const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;
  ctx.font = "8.5px Arial"; ctx.textAlign = "left";
  ctx.fillStyle = currentTheme === "light" ? "#64748b" : "#94a3b8";
  ctx.fillText(`DD:$${fmt(maxDD,2)}`, mL,       H - 6);
  ctx.fillText(`PF:${pf === Infinity ? "∞" : fmt(pf,2)}`, mL + 75,  H - 6);
  ctx.fillText(`E:${expectancy >= 0 ? "+" : ""}$${fmt(expectancy,2)}`, mL + 145, H - 6);
}

/* ---- Feature 16: P&L Breakdown ---- */
function renderPLBreakdown() {
  const container = document.getElementById("plBreakdownTable");
  if (!container) return;
  const byStrategy = {}, bySymbol = {};
  for (const e of autoTradeHistory) {
    if (e.result !== "WIN" && e.result !== "LOSS") continue;
    const profit = typeof e.profit === "number" ? e.profit : 0;
    const stratKey = e.strategyName || e.source || "breakout";
    if (!byStrategy[stratKey]) byStrategy[stratKey] = { wins: 0, losses: 0, pl: 0 };
    if (e.result === "WIN") byStrategy[stratKey].wins++; else byStrategy[stratKey].losses++;
    byStrategy[stratKey].pl += profit;
    const sym = e.symbol || "N/A";
    if (!bySymbol[sym]) bySymbol[sym] = { wins: 0, losses: 0, pl: 0 };
    if (e.result === "WIN") bySymbol[sym].wins++; else bySymbol[sym].losses++;
    bySymbol[sym].pl += profit;
  }
  const makeTable = (title, data) => {
    const keys = Object.keys(data);
    if (keys.length === 0) return "";
    const rows = keys.map(k => {
      const s = data[k];
      const total = s.wins + s.losses;
      const wr = total > 0 ? Math.round(s.wins / total * 100) : 0;
      const plColor = s.pl >= 0 ? "#22c55e" : "#ef4444";
      const label = k.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      return `<div class="pl-breakdown-row"><span class="pl-breakdown-name">${label}</span><span>${s.wins}</span><span>${s.losses}</span><span>${wr}%</span><span style="color:${plColor};font-weight:600">${s.pl >= 0 ? "+" : ""}$${fmt(s.pl,2)}</span></div>`;
    }).join("");
    return `<div class="pl-breakdown-group"><div class="pl-breakdown-heading">${title}</div><div class="pl-breakdown-header"><span></span><span>W</span><span>L</span><span>Win%</span><span>P/L</span></div>${rows}</div>`;
  };
  const html = makeTable("By Strategy", byStrategy) + makeTable("By Symbol", bySymbol);
  container.innerHTML = html || '<span class="hint" style="font-size:0.75rem;opacity:0.6;">No completed auto-trades yet</span>';
}

/* ---- Feature 13: Adaptive Confluence Weighting ---- */
function recordConfluenceOutcome(factors, result) {
  if (!adaptiveConfluenceEnabled || !factors || !factors.length) return;
  for (const factor of factors) {
    if (!confluenceFactorStats[factor]) confluenceFactorStats[factor] = { wins: 0, losses: 0 };
    if (result === "WIN")  confluenceFactorStats[factor].wins++;
    if (result === "LOSS") confluenceFactorStats[factor].losses++;
  }
  try { localStorage.setItem(LS_PREFIX + "confStats", JSON.stringify(confluenceFactorStats)); } catch(e) {}
}
function loadConfluenceStats() {
  try {
    const raw = localStorage.getItem(LS_PREFIX + "confStats");
    if (raw) confluenceFactorStats = JSON.parse(raw);
  } catch(e) { confluenceFactorStats = {}; }
}
function getConfluenceFactorWeight(factor) {
  const stats = confluenceFactorStats[factor];
  if (!stats) return 0.5;
  const total = stats.wins + stats.losses;
  if (total < CONF_WEIGHT_MIN_SAMPLES) return 0.5;
  return stats.wins / total;
}
function renderAdaptiveConfluenceTable() {
  const container = document.getElementById("adaptiveConfluenceTable");
  if (!container) return;
  const factors = Object.keys(confluenceFactorStats);
  if (factors.length === 0) {
    container.innerHTML = '<span class="hint" style="font-size:0.75rem;opacity:0.6;">No data yet — updates after 10+ trades per factor</span>';
    return;
  }
  const strongPct = Math.round((typeof CONF_ADAPTIVE_STRONG_WEIGHT !== "undefined" ? CONF_ADAPTIVE_STRONG_WEIGHT : 0.60) * 100);
  /* Baseline: overall win rate across all recorded factor outcomes */
  let baseWins = 0, baseTotal = 0;
  for (const f of factors) {
    const s = confluenceFactorStats[f];
    baseWins  += s.wins;
    baseTotal += s.wins + s.losses;
  }
  const baseline = baseTotal > 0 ? baseWins / baseTotal : null;
  /* Build rows: rated (≥ min samples) sorted by win rate desc, unrated at bottom */
  const rows = factors.map(f => {
    const s = confluenceFactorStats[f];
    const total = s.wins + s.losses;
    const rated = total >= CONF_WEIGHT_MIN_SAMPLES;
    const rate  = total > 0 ? s.wins / total : 0;
    return { name: f, total, rated, rate };
  });
  rows.sort((a, b) => (b.rated - a.rated) || (b.rate - a.rate) || (b.total - a.total));
  const proven = rows.filter(r => r.rated && r.rate * 100 >= strongPct);
  const summary = proven.length > 0
    ? `<div class="conf-weight-summary">🏆 Proven winners: ${proven.map(r => `<b>${r.name}</b> (${Math.round(r.rate * 100)}%, ${r.total})`).join(", ")}</div>`
    : `<div class="conf-weight-summary conf-weight-summary-empty">🏆 No proven winners yet (need ≥${strongPct}% win rate on ${CONF_WEIGHT_MIN_SAMPLES}+ trades)</div>`;
  container.innerHTML = summary + rows.map(r => {
    const ratePct = Math.round(r.rate * 100);
    const badge = !r.rated               ? '<span class="conf-weight-badge" style="color:#94a3b8;">⚪ Unrated</span>'
                : ratePct >= strongPct   ? '<span class="conf-weight-badge" style="color:#22c55e;">🟢 Proven</span>'
                : ratePct >= 40          ? '<span class="conf-weight-badge" style="color:#f59e0b;">🟡 Neutral</span>'
                :                          '<span class="conf-weight-badge" style="color:#ef4444;">🔴 Losing</span>';
    let deltaHtml = "";
    if (r.rated && baseline != null) {
      const delta = Math.round((r.rate - baseline) * 100);
      const deltaColor = delta > 0 ? "#22c55e" : delta < 0 ? "#ef4444" : "#94a3b8";
      deltaHtml = ` <span style="color:${deltaColor};" title="Edge vs ${Math.round(baseline * 100)}% baseline">${delta >= 0 ? "+" : ""}${delta}%</span>`;
    } else if (!r.rated) {
      deltaHtml = ` <span style="opacity:0.5;">collecting data (${r.total}/${CONF_WEIGHT_MIN_SAMPLES})</span>`;
    }
    const rateLabel = r.total > 0 ? `${ratePct}% (${r.total})` : "-- (0)";
    const barPct = Math.round(getConfluenceFactorWeight(r.name) * 100);
    const barColor = barPct >= strongPct ? "#22c55e" : barPct >= 40 ? "#f59e0b" : "#ef4444";
    return `<div class="conf-weight-row"><span class="conf-weight-name">${badge} ${r.name}</span><span class="conf-weight-wr">${rateLabel}${deltaHtml}</span><div class="conf-weight-bar-bg"><div class="conf-weight-bar" style="width:${barPct}%;background:${barColor}"></div></div></div>`;
  }).join("");
}

/* ---- Feature 1: Backtesting Engine ---- */
function startBacktest() {
  if (backtestMode) stopBacktest();
  if (candles.length < 10) {
    showToast("Backtest Error", "Need at least 10 candles. Connect and load data first.", "warning", 5000);
    return;
  }
  _backtestCandles = candles.slice();
  backtestIdx = 0;
  backtestMode = true;
  multiRHitLevels = [];
  resetIndicator();
  addLog(`🔁 Backtest started: ${_backtestCandles.length} candles @ ${backtestSpeedMs}ms/step`);
  showToast("Backtest Started", `Replaying ${_backtestCandles.length} candles at ${backtestSpeedMs}ms/step.`, "info", 5000);
  updateBacktestUI();
  backtestInterval = setInterval(() => {
    if (backtestIdx >= _backtestCandles.length) { stopBacktest(); return; }
    candles = _backtestCandles.slice(0, backtestIdx + 1);
    _historicalProcessing = true;
    try { processAllCandles(); } finally { _historicalProcessing = false; }
    backtestIdx++;
    const pct = Math.round(backtestIdx / _backtestCandles.length * 100);
    const el = document.getElementById("backtestProgress");
    if (el) el.value = pct;
    const lbl = document.getElementById("backtestProgressLabel");
    if (lbl) lbl.textContent = `${pct}%  (${backtestIdx} / ${_backtestCandles.length})`;
    drawChart();
    updateStatsUI();
  }, backtestSpeedMs);
}
function stopBacktest() {
  if (backtestInterval) { clearInterval(backtestInterval); backtestInterval = null; }
  backtestMode = false;
  if (_backtestCandles.length > 0) { candles = _backtestCandles.slice(); _backtestCandles = []; }
  addLog("🔁 Backtest stopped");
  updateBacktestUI();
  drawChart();
  updateStatsUI();
}
function updateBacktestUI() {
  const startBtn = document.getElementById("backtestStartBtn");
  const stopBtn  = document.getElementById("backtestStopBtn");
  if (startBtn) startBtn.disabled = backtestMode;
  if (stopBtn)  stopBtn.disabled  = !backtestMode;
  const statusEl = document.getElementById("backtestStatus");
  if (statusEl) statusEl.textContent = backtestMode ? `Running… (${backtestIdx} / ${_backtestCandles.length})` : "Idle";
}

/* ---- Feature 15: Multi-R Partial Exit Ladder ---- */
function monitorMultiRLadder(idx) {
  if (!multiRLadderEnabled || !trade || multiRLadder.length === 0) return;
  const c = candles[idx]; if (!c) return;
  const risk = Math.abs(trade.entry - trade.sl); if (risk <= 0) return;
  for (let li = 0; li < multiRLadder.length; li++) {
    if (multiRHitLevels.includes(li)) continue;
    const level = multiRLadder[li];
    const target = trade.dir === "BULL" ? trade.entry + risk * level.r : trade.entry - risk * level.r;
    const hit = trade.dir === "BULL" ? c.high >= target : c.low <= target;
    if (!hit) continue;
    multiRHitLevels.push(li);
    const isLast = (li === multiRLadder.length - 1);
    addLog(`📊 Multi-R ${level.r}R hit → exit ${level.pct}% @ ${fmt(target,4)}${isLast ? " (FULL EXIT)" : " (partial, SL → BE)"}`);
    showToast(`📊 ${level.r}R Target Hit`, `Exit ${level.pct}% at ${fmt(target,4)}`, isLast ? "trade" : "success", 6000);
    if (isLast) {
      trade = null; multiRHitLevels = [];
      setPhase("WAITING"); drawChart();
    } else if (li === 0 && trade) {
      trade.sl = trade.entry;
      addLog("📊 Multi-R: SL moved to breakeven");
      drawChart();
    }
  }
}

/* ---- Feature 11: Economic Calendar / News Pause ---- */
async function fetchNewsCalendar() {
  const now = Date.now();
  if (now - _newsCacheFetched < NEWS_CACHE_EXPIRY_MS && newsEvents.length > 0) return;
  try {
    const res = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json",
      { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const data = await res.json();
    if (!Array.isArray(data)) return;
    newsEvents = data
      .filter(e => e.impact === "High")
      .map(e => ({ time: new Date(e.date).getTime(), title: e.title || "", currency: e.country || "", impact: e.impact || "" }))
      .filter(e => !isNaN(e.time));
    _newsCacheFetched = now;
    addLog(`📅 News calendar: ${newsEvents.length} high-impact events loaded`);
    drawChart();
  } catch(e) {
    console.info("News calendar fetch skipped:", e.message);
    addLog("📅 News calendar: fetch failed (optional feature — check network access)");
  }
}
function getNewsPauseEvent() {
  if (!newsPauseEnabled || newsEvents.length === 0) return null;
  const now = Date.now();
  const window = newsPauseMinutes * 60 * 1000;
  return newsEvents.find(ev => Math.abs(now - ev.time) <= window) || null;
}

/* ---- Feature 8: Multi-Symbol Scanner ---- */
function updateScannerSymbolCount() {
  const el = document.getElementById("scannerSymbolCount");
  if (el) el.textContent = `${scannerSymbols.length} symbol${scannerSymbols.length !== 1 ? "s" : ""} selected`;
}

function updateScannerUI() {
  if (!scannerEnabled) return;
  const grid = document.getElementById("scannerGrid");
  if (!grid) return;
  grid.innerHTML = "";
  if (scannerSymbols.length === 0) {
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = "No symbols configured";
    grid.appendChild(hint);
    return;
  }
  for (const sym of scannerSymbols) {
    const panel = multiPanels.get(sym);
    const ph    = panel ? (panel.state && panel.state.phase ? panel.state.phase : "WAITING") : "WAITING";
    const badgeClass = { TRADE: "enabled", BREAKOUT: "warning", RETEST: "warning", CONFIRM: "enabled" }[ph] || "disabled";
    const cell = document.createElement("div");
    cell.className = `scanner-cell ${badgeClass.toLowerCase()}-cell`;
    const symSpan = document.createElement("span");
    symSpan.className = "scanner-symbol";
    symSpan.textContent = sym;
    const phSpan = document.createElement("span");
    phSpan.className = `scanner-phase status-badge ${badgeClass}`;
    phSpan.textContent = ph;
    cell.appendChild(symSpan);
    cell.appendChild(phSpan);
    grid.appendChild(cell);
  }
}

function drawChart() {
  const canvas = UI.canvas;
  const ctx = UI.ctx;
  if (!canvas || !ctx) return;

  const COLORS = getColors();

  /* High-DPI support.
     Fall back to the canvas's own pixel dimensions when getBoundingClientRect
     returns zero — this happens for unmounted offscreen canvases used during
     Telegram export where the element is never added to the DOM. */
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const W = rect.width  || canvas.width  / dpr;
  const H = rect.height || canvas.height / dpr;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, W, H);

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  /* ---- Watermark: signal/symbol name in chart background ---- */
  {
    const sel = UI.symbolSelect;
    const symbolLabel = sel ? (sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : sel.value) : "";
    if (symbolLabel) {
      ctx.save();
      ctx.globalAlpha = 0.07;
      ctx.fillStyle = currentTheme === "light" ? "#000" : "#fff";
      const wmFontSize = Math.max(28, Math.min(W * 0.06, 60));
      ctx.font = `bold ${wmFontSize}px Arial`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(symbolLabel, W / 2, H / 2 - wmFontSize * 0.4);
      /* Show phase/signal direction beneath symbol name */
      const signalLine = trade
        ? `${trade.dir === "BULL" ? "▲ BUY" : "▼ SELL"} SIGNAL`
        : phase;
      ctx.font = `bold ${wmFontSize * 0.55}px Arial`;
      ctx.fillText(signalLine, W / 2, H / 2 + wmFontSize * 0.45);
      ctx.restore();
    }
  }

  if (candles.length < 2) return;

  const marginLeft = 10, marginRight = 60, marginTop = 20, marginBottom = 30;
  const chartW = W - marginLeft - marginRight;
  const chartH = H - marginTop - marginBottom;

  /* Price range */
  let priceHigh = -Infinity, priceLow = Infinity;
  for (const c of candles) {
    if (c.high > priceHigh) priceHigh = c.high;
    if (c.low < priceLow)  priceLow = c.low;
  }
  if (trade) {
    if (trade.tp != null) {
      if (trade.tp > priceHigh) priceHigh = trade.tp;
      if (trade.tp < priceLow)  priceLow = trade.tp;
    }
    if (trade.sl > priceHigh) priceHigh = trade.sl;
    if (trade.sl < priceLow)  priceLow = trade.sl;
  }
  /* Include NY Open Range trade levels in price range */
  if (nyOpenRangeTrade) {
    if (nyOpenRangeTrade.tp != null) {
      if (nyOpenRangeTrade.tp > priceHigh) priceHigh = nyOpenRangeTrade.tp;
      if (nyOpenRangeTrade.tp < priceLow)  priceLow = nyOpenRangeTrade.tp;
    }
    if (nyOpenRangeTrade.sl > priceHigh) priceHigh = nyOpenRangeTrade.sl;
    if (nyOpenRangeTrade.sl < priceLow)  priceLow = nyOpenRangeTrade.sl;
  }
  const pricePad = (priceHigh - priceLow) * CHART_PRICE_PADDING;
  priceHigh += pricePad;
  priceLow  -= pricePad;
  const priceRange = priceHigh - priceLow || 1;

  const candleW = Math.max(2, chartW / candles.length - 1);

  function xOf(i) { return marginLeft + (i / candles.length) * chartW + candleW / 2; }
  function yOf(price) { return marginTop + (1 - (price - priceLow) / priceRange) * chartH; }

  drawGrid(ctx, marginLeft, marginTop, chartW, chartH, priceLow, priceHigh, W, COLORS);

  /* ---- Opening Range highlight ---- */
  if (openingRange) {
    const x1 = xOf(openingRange.startIdx) - candleW / 2 - 2;
    const x2 = xOf(openingRange.endIdx) + candleW / 2 + 2;
    const y1 = yOf(openingRange.high);
    const y2 = yOf(openingRange.low);

    let fillColor = COLORS.rangeFill;
    let borderColor = COLORS.rangeBorder;
    if (breakout) {
      fillColor   = breakout.dir === "BULL" ? COLORS.breakoutBull : COLORS.breakoutBear;
      borderColor = breakout.dir === "BULL" ? COLORS.breakoutBullBorder : COLORS.breakoutBearBorder;
    }

    const rangeExtendX = breakout ? W - marginRight : x2;
    ctx.fillStyle = fillColor;
    ctx.fillRect(x1, y1, rangeExtendX - x1, y2 - y1);
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x1, y1, rangeExtendX - x1, y2 - y1);
    ctx.setLineDash([]);

    ctx.fillStyle = borderColor;
    ctx.font = "bold 10px Arial";
    const rangeLabel = scalpingModeEnabled ? `${SCALP_RANGE_MINUTES}-MIN SCALP RANGE` : `${RANGE_MINUTES}-MIN RANGE`;
    ctx.fillText(rangeLabel, x1 + 4, y1 - 4);

    /* ---- Breakout High / Low horizontal lines ---- */
    drawHLine(ctx, y1, marginLeft, W - marginRight, COLORS.breakoutHighLine, "HIGH " + fmt(openingRange.high, 4), W, marginRight);
    drawHLine(ctx, y2, marginLeft, W - marginRight, COLORS.breakoutLowLine,  "LOW " + fmt(openingRange.low, 4), W, marginRight);
  }

  /* ---- NY Open Range highlight (9:30–9:35 AM EST) ---- */
  if (nyOpenRange && nyOpenRangeEnabled) {
    const nx1 = xOf(nyOpenRange.startIdx) - candleW / 2 - 2;
    const nx2 = xOf(nyOpenRange.endIdx) + candleW / 2 + 2;
    const ny1 = yOf(nyOpenRange.high);
    const ny2 = yOf(nyOpenRange.low);

    let nFill = "rgba(168,85,247,0.10)";    /* purple tint */
    let nBorder = "rgba(168,85,247,0.60)";
    if (nyOpenRangeBreakout) {
      nFill   = nyOpenRangeBreakout.dir === "BULL" ? "rgba(16,185,129,0.10)" : "rgba(244,63,94,0.10)";
      nBorder = nyOpenRangeBreakout.dir === "BULL" ? "rgba(16,185,129,0.60)" : "rgba(244,63,94,0.60)";
    }

    const nExtendX = nyOpenRangeBreakout ? W - marginRight : nx2;
    ctx.fillStyle = nFill;
    ctx.fillRect(nx1, ny1, nExtendX - nx1, ny2 - ny1);
    ctx.strokeStyle = nBorder;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 3]);
    ctx.strokeRect(nx1, ny1, nExtendX - nx1, ny2 - ny1);
    ctx.setLineDash([]);

    /* Midpoint line (SL reference) */
    const midY = yOf((nyOpenRange.high + nyOpenRange.low) / 2);
    ctx.strokeStyle = "rgba(168,85,247,0.40)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(nx1, midY);
    ctx.lineTo(nExtendX, midY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = nBorder;
    ctx.font = "bold 10px Arial";
    ctx.fillText("9:30 AM EST RANGE", nx1 + 4, ny1 - 4);

    /* Draw NY Open Range trade levels (entry / SL / TP) */
    if (nyOpenRangeTrade) {
      const nt = nyOpenRangeTrade;
      /* Entry line */
      const entryY = yOf(nt.entry);
      ctx.strokeStyle = "#a855f7";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(xOf(nt.entryIdx), entryY);
      ctx.lineTo(W - marginRight, entryY);
      ctx.stroke();
      ctx.fillStyle = "#a855f7";
      ctx.font = "bold 10px Arial";
      ctx.textAlign = "right";
      ctx.fillText(`ENTRY ${fmt(nt.entry, 4)}`, W - marginRight - 4, entryY - 4);

      /* SL line */
      const slY = yOf(nt.sl);
      ctx.strokeStyle = COLORS.sl || "#f43f5e";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(xOf(nt.entryIdx), slY);
      ctx.lineTo(W - marginRight, slY);
      ctx.stroke();
      ctx.fillStyle = COLORS.sl || "#f43f5e";
      ctx.fillText(`SL ${fmtPrice(nt.sl, getActiveSymbol())} (mid)`, W - marginRight - 4, slY - 4);

      /* TP line */
      if (nt.tp != null) {
        const tpY = yOf(nt.tp);
        ctx.strokeStyle = COLORS.tp || "#10b981";
        ctx.beginPath();
        ctx.moveTo(xOf(nt.entryIdx), tpY);
        ctx.lineTo(W - marginRight, tpY);
        ctx.stroke();
        ctx.fillStyle = COLORS.tp || "#10b981";
        ctx.fillText(`TP ${fmtPrice(nt.tp, getActiveSymbol())} (1:2)`, W - marginRight - 4, tpY - 4);
      }

      ctx.setLineDash([]);
      ctx.textAlign = "left";
    }
  }

  /* ---- Session Ranges (Asian / London / NY) highlight ---- */
  if (sessionRangesEnabled) {
    const sessionRangeConfigs = [
      { range: sessionRangeAsian,  label: "ASIAN",  fill: "rgba(255,191,0,0.06)",  border: "rgba(255,191,0,0.45)" },
      { range: sessionRangeLondon, label: "LONDON", fill: "rgba(59,130,246,0.06)", border: "rgba(59,130,246,0.45)" },
      { range: sessionRangeNY,     label: "NY",     fill: "rgba(168,85,247,0.06)", border: "rgba(168,85,247,0.45)" }
    ];
    for (const cfg of sessionRangeConfigs) {
      if (!cfg.range) continue;
      const sx1 = xOf(cfg.range.startIdx) - candleW / 2 - 2;
      const sx2 = xOf(cfg.range.endIdx) + candleW / 2 + 2;
      const sy1 = yOf(cfg.range.high);
      const sy2 = yOf(cfg.range.low);
      ctx.fillStyle = cfg.fill;
      ctx.fillRect(sx1, sy1, sx2 - sx1, sy2 - sy1);
      ctx.strokeStyle = cfg.border;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(sx1, sy1, sx2 - sx1, sy2 - sy1);
      ctx.setLineDash([]);
      ctx.fillStyle = cfg.border;
      ctx.font = "bold 9px Arial";
      ctx.fillText(cfg.label + " RANGE", sx1 + 3, sy1 - 3);
    }

    /* Asian "tight" badge on chart */
    if (sessionRangeAsian && asianRangeTight) {
      const ax = xOf(sessionRangeAsian.startIdx) - candleW / 2;
      const amidY = yOf((sessionRangeAsian.high + sessionRangeAsian.low) / 2);
      ctx.fillStyle = "rgba(255,191,0,0.85)";
      ctx.font = "bold 10px Arial";
      ctx.fillText("⚡ TIGHT", ax + 3, amidY + 3);
    }

    /* London sweep arrow marker on chart */
    if (londonSweepSignal && londonSweepSignal.candleIdx < candles.length) {
      const lsx = xOf(londonSweepSignal.candleIdx);
      const lsy = yOf(londonSweepSignal.price);
      ctx.fillStyle = londonSweepSignal.dir === "HIGH" ? "rgba(244,63,94,0.90)" : "rgba(16,185,129,0.90)";
      ctx.font = "bold 11px Arial";
      ctx.textAlign = "center";
      const sweepArrow = londonSweepSignal.dir === "HIGH" ? "▼ SWEEP" : "▲ SWEEP";
      ctx.fillText(sweepArrow, lsx, londonSweepSignal.dir === "HIGH" ? lsy - 8 : lsy + 14);
      ctx.textAlign = "left";
    }

    /* Session Range Trade levels (Entry / SL / TP) drawn on chart */
    if (sessionRangeTrade && sessionRangeTrade.entryIdx < candles.length) {
      const srt = sessionRangeTrade;
      const srtStartX = xOf(srt.entryIdx);

      /* Entry line */
      const srtEntryY = yOf(srt.entry);
      ctx.strokeStyle = COLORS.entryLine || "#a855f7";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(srtStartX, srtEntryY);
      ctx.lineTo(W - marginRight, srtEntryY);
      ctx.stroke();
      ctx.fillStyle = COLORS.entryLine || "#a855f7";
      ctx.font = "bold 10px Arial";
      ctx.textAlign = "right";
      ctx.fillText(`ENTRY ${fmtPrice(srt.entry, srt.symbol || getActiveSymbol())}`, W - marginRight - 4, srtEntryY - 4);

      /* SL line */
      const srtSlY = yOf(srt.sl);
      ctx.strokeStyle = COLORS.sl || "#f43f5e";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(srtStartX, srtSlY);
      ctx.lineTo(W - marginRight, srtSlY);
      ctx.stroke();
      ctx.fillStyle = COLORS.sl || "#f43f5e";
      ctx.fillText(`SL ${fmtPrice(srt.sl, srt.symbol || getActiveSymbol())}`, W - marginRight - 4, srtSlY - 4);

      /* TP line */
      if (srt.tp != null) {
        const srtTpY = yOf(srt.tp);
        ctx.strokeStyle = COLORS.tp || "#10b981";
        ctx.beginPath();
        ctx.moveTo(srtStartX, srtTpY);
        ctx.lineTo(W - marginRight, srtTpY);
        ctx.stroke();
        ctx.fillStyle = COLORS.tp || "#10b981";
        ctx.fillText(`TP ${fmtPrice(srt.tp, srt.symbol || getActiveSymbol())} (1:${fmt(srt.rr, 1)})`, W - marginRight - 4, srtTpY - 4);
      }

      ctx.setLineDash([]);
      ctx.textAlign = "left";
    }
  }

  /* ---- Breakout candle box ---- */
  if (breakout && breakout.candleIdx < candles.length) {
    const bc = candles[breakout.candleIdx];
    const bx = xOf(breakout.candleIdx);
    const bx1 = bx - candleW / 2 - 4;
    const by1 = yOf(bc.high) - 4;
    const bw = candleW + 8;
    const bh = yOf(bc.low) - yOf(bc.high) + 8;

    const boxColor = breakout.dir === "BULL" ? COLORS.breakoutBullBorder : COLORS.breakoutBearBorder;
    ctx.strokeStyle = boxColor;
    ctx.lineWidth = 2;
    ctx.strokeRect(bx1, by1, bw, bh);
    ctx.fillStyle = boxColor;
    ctx.font = "bold 10px Arial";
    ctx.fillText("BREAKOUT", bx1, by1 - 4);

    /* Show recommended order type below the breakout label */
    const orderType = getRecommendedOrderType();
    if (orderType) {
      ctx.font = "bold 9px Arial";
      ctx.fillText("→ " + orderType, bx1, by1 + bh + 14);
    }
  }

  /* ---- Retest zone highlight ---- */
  if (retestInfo && retestInfo.candleIdx < candles.length) {
    const rc = candles[retestInfo.candleIdx];
    const rx = xOf(retestInfo.candleIdx);
    const rx1 = rx - candleW / 2 - 3;
    const ry1 = yOf(rc.high) - 3;
    const rw = candleW + 6;
    const rh = yOf(rc.low) - yOf(rc.high) + 6;

    ctx.fillStyle = COLORS.retest;
    ctx.fillRect(rx1, ry1, rw, rh);
    ctx.strokeStyle = COLORS.retestBorder;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rx1, ry1, rw, rh);
    ctx.fillStyle = COLORS.retestBorder;
    ctx.font = "bold 10px Arial";
    ctx.fillText("RETEST", rx1, ry1 - 3);

    /* Show pullback order type below the retest label */
    const retestOrderType = getRecommendedOrderType();
    if (retestOrderType) {
      ctx.font = "bold 9px Arial";
      ctx.fillText("→ " + retestOrderType, rx1, ry1 + rh + 14);
    }
  }

  /* ---- Indecision candle marker ---- */
  if (indecisionInfo && indecisionInfo.candleIdx < candles.length) {
    const ic = candles[indecisionInfo.candleIdx];
    const ix = xOf(indecisionInfo.candleIdx);
    ctx.fillStyle = "rgba(251,191,36,0.7)";
    ctx.font = "bold 11px Arial";
    ctx.textAlign = "center";
    ctx.fillText("⏸", ix, yOf(ic.high) - 8);
    ctx.textAlign = "left";
  }

  /* ---- Confirmation candle highlight ---- */
  if (confirmInfo && confirmInfo.candleIdx < candles.length) {
    const cc = candles[confirmInfo.candleIdx];
    const cx = xOf(confirmInfo.candleIdx);
    const cx1 = cx - candleW / 2 - 3;
    const cy1 = yOf(cc.high) - 3;
    const cw = candleW + 6;
    const ch = yOf(cc.low) - yOf(cc.high) + 6;

    ctx.fillStyle = COLORS.confirm;
    ctx.fillRect(cx1, cy1, cw, ch);
    ctx.strokeStyle = COLORS.confirmBorder;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(cx1, cy1, cw, ch);
    ctx.fillStyle = COLORS.confirmBorder;
    ctx.font = "bold 10px Arial";
    ctx.fillText("CONFIRM", cx1, cy1 - 3);
  }

  /* ---- Feature 17: Session Heatmap — coloured bands on chart timeline ---- */
  if (sessionHeatmapEnabled && candles.length > 0) {
    const sessions = [
      { label: "Asian",   start: 0,  end: 9,  color: "rgba(59,130,246,0.06)"  },
      { label: "London",  start: 7,  end: 16, color: "rgba(16,185,129,0.07)" },
      { label: "NY",      start: 12, end: 21, color: "rgba(249,115,22,0.06)"  },
      { label: "Overlap", start: 12, end: 16, color: "rgba(234,179,8,0.08)"   }
    ];
    ctx.save();
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const hr = new Date(c.epoch * 1000).getUTCHours();
      let bandColor = null;
      if (hr >= 12 && hr < 16) bandColor = "rgba(234,179,8,0.08)";       /* overlap – highest priority */
      else if (hr >= 12 && hr < 21) bandColor = "rgba(249,115,22,0.06)"; /* NY */
      else if (hr >= 7  && hr < 16) bandColor = "rgba(16,185,129,0.07)"; /* London */
      else if (hr >= 0  && hr < 9)  bandColor = "rgba(59,130,246,0.06)"; /* Asian */
      if (!bandColor) continue;
      const bx = xOf(i) - candleW / 2;
      ctx.fillStyle = bandColor;
      ctx.fillRect(bx, marginTop, candleW, chartH);
    }
    /* Session legend in bottom-right of chart */
    const legendItems = [
      { label: "Asian",   color: "rgba(59,130,246,0.5)"  },
      { label: "London",  color: "rgba(16,185,129,0.5)" },
      { label: "NY",      color: "rgba(249,115,22,0.5)"  },
      { label: "Overlap", color: "rgba(234,179,8,0.7)"   }
    ];
    ctx.font = "8px Arial";
    let lx = marginLeft + 6;
    const ly = marginTop + chartH - 8;
    for (const li of legendItems) {
      ctx.fillStyle = li.color;
      ctx.fillRect(lx, ly - 6, 10, 8);
      ctx.fillStyle = currentTheme === "light" ? "#334155" : "#94a3b8";
      ctx.fillText(li.label, lx + 12, ly);
      lx += ctx.measureText(li.label).width + 22;
    }
    ctx.restore();
  }

  /* ---- Feature 11: News event vertical lines on chart ---- */
  if (newsEvents.length > 0 && candles.length > 0) {
    const firstEpoch = candles[0].epoch * 1000;
    const lastEpoch  = candles[candles.length - 1].epoch * 1000;
    ctx.save();
    for (const ev of newsEvents) {
      if (ev.time < firstEpoch - 3600000 || ev.time > lastEpoch + 3600000) continue;
      /* Find nearest candle */
      const evSec = ev.time / 1000;
      let nearest = 0;
      for (let i = 1; i < candles.length; i++) {
        if (Math.abs(candles[i].epoch - evSec) < Math.abs(candles[nearest].epoch - evSec)) nearest = i;
      }
      const nx = xOf(nearest);
      ctx.strokeStyle = "rgba(239,68,68,0.55)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(nx, marginTop);
      ctx.lineTo(nx, marginTop + chartH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = "bold 8px Arial";
      ctx.fillStyle = "rgba(239,68,68,0.9)";
      ctx.textAlign = "center";
      ctx.fillText("📅", nx, marginTop + 10);
      const isCurrent = Math.abs(Date.now() - ev.time) <= newsPauseMinutes * 60000;
      if (isCurrent) {
        ctx.fillStyle = "rgba(239,68,68,0.85)";
        ctx.font = "bold 8px Arial";
        const evLabel = (ev.currency || "") + " " + (ev.title || "").substring(0, 15);
        ctx.fillText(evLabel, nx, marginTop + 20);
      }
    }
    ctx.textAlign = "left";
    ctx.restore();
  }

  /* ---- Draw candles ---- */
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const x = xOf(i);
    const isBull = c.close >= c.open;
    const color = isBull ? COLORS.bullCandle : COLORS.bearCandle;

    ctx.strokeStyle = COLORS.wick;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yOf(c.high));
    ctx.lineTo(x, yOf(c.low));
    ctx.stroke();

    const bodyTop = yOf(Math.max(c.open, c.close));
    const bodyBot = yOf(Math.min(c.open, c.close));
    const bodyH = Math.max(1, bodyBot - bodyTop);

    ctx.fillStyle = color;
    ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyH);
  }

  /* ---- Feature 6: Candle pattern annotations ---- */
  if (candleAnnotationsEnabled && candles.length > 2) {
    ctx.save();
    for (let i = 2; i < candles.length; i++) {
      const c  = candles[i];
      const cp = candles[i - 1];
      const cp2 = candles[i - 2];
      const x  = xOf(i);
      let label = null, labelColor = "#fbbf24", above = true;
      const body   = Math.abs(c.close - c.open);
      const rng    = c.high - c.low;
      const upTail = c.close >= c.open ? rng - (c.close - c.open) - (c.high - c.close) : rng - (c.open - c.close) - (c.high - c.open);
      const dnTail = c.close >= c.open ? c.open - c.low : c.close - c.low;
      /* Doji */
      if (rng > 0 && body / rng < DOJI_BODY_RATIO) { label = "⊙"; labelColor = "#94a3b8"; above = true; }
      /* Pin bar / Hammer */
      else if (body > 0 && dnTail >= PIN_BAR_TAIL_RATIO * body && (rng - dnTail - body) < body) { label = "🔨"; labelColor = c.close >= c.open ? "#22c55e" : "#ef4444"; above = false; }
      /* Shooting star */
      else if (body > 0 && (c.high - Math.max(c.open, c.close)) >= PIN_BAR_TAIL_RATIO * body) { label = "⭐"; labelColor = "#ef4444"; above = true; }
      /* Bullish engulfing */
      else if (c.close > c.open && cp.close < cp.open && c.close > cp.open && c.open < cp.close) { label = "▲"; labelColor = "#22c55e"; above = false; }
      /* Bearish engulfing */
      else if (c.close < c.open && cp.close > cp.open && c.close < cp.open && c.open > cp.close) { label = "▼"; labelColor = "#ef4444"; above = true; }
      /* Inside bar */
      else if (c.high < cp.high && c.low > cp.low) { label = "IB"; labelColor = "#a78bfa"; above = false; }
      if (!label) continue;
      ctx.font = label.length > 2 ? "bold 9px Arial" : "bold 11px Arial";
      ctx.fillStyle = labelColor;
      ctx.textAlign = "center";
      ctx.globalAlpha = 0.85;
      const labelY = above ? yOf(c.high) - 10 : yOf(c.low) + 14;
      ctx.fillText(label, x, labelY);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = "left";
    ctx.restore();
  }

  /* ---- EMA overlays ---- */
  const showEma = UI.emaToggle ? UI.emaToggle.checked : false;
  if (showEma) {
    drawEMALine(ctx, emaFast, xOf, yOf, COLORS.emaFast);
    drawEMALine(ctx, emaSlow, xOf, yOf, COLORS.emaSlow);
    /* Draw HTF EMA (long period) as a thicker, semi-transparent line */
    if (emaHTF.length > 0) {
      ctx.globalAlpha = 0.5;
      drawEMALine(ctx, emaHTF, xOf, yOf, COLORS.emaHTF || "#06b6d4");
      ctx.globalAlpha = 1;
    }
  }

    /* Bollinger Bands overlay */
    if (bbUpper.length > 0) {
      ctx.globalAlpha = 0.3;
      drawEMALine(ctx, bbUpper, xOf, yOf, "#a78bfa");
      drawEMALine(ctx, bbLower, xOf, yOf, "#a78bfa");
      ctx.globalAlpha = 0.15;
      drawEMALine(ctx, bbMiddle, xOf, yOf, "#a78bfa");
      ctx.globalAlpha = 1;
      /* Fill between bands */
      ctx.fillStyle = "rgba(167,139,250,0.04)";
      ctx.beginPath();
      let bbStarted = false;
      for (let i = 0; i < bbUpper.length; i++) {
        if (bbUpper[i] == null) continue;
        const x = xOf(i);
        if (!bbStarted) { ctx.moveTo(x, yOf(bbUpper[i])); bbStarted = true; }
        else ctx.lineTo(x, yOf(bbUpper[i]));
      }
      for (let i = bbLower.length - 1; i >= 0; i--) {
        if (bbLower[i] == null) continue;
        ctx.lineTo(xOf(i), yOf(bbLower[i]));
      }
      ctx.closePath();
      ctx.fill();
    }

  /* ---- Trade levels: Entry / SL / TP ---- */
  if (trade) {
    const activeSym = getActiveSymbol();
    drawHLine(ctx, yOf(trade.entry), marginLeft, W - marginRight, COLORS.entryLine, "ENTRY " + fmtPrice(trade.entry, activeSym), W, marginRight);
    drawHLine(ctx, yOf(trade.sl),    marginLeft, W - marginRight, COLORS.slLine,    "SL " + fmtPrice(trade.sl, activeSym), W, marginRight);
    if (trade.tp != null) {
      drawHLine(ctx, yOf(trade.tp), marginLeft, W - marginRight, COLORS.tpLine, "TP " + fmtPrice(trade.tp, activeSym), W, marginRight);
    }

    /* Trailing SL line (if different from original SL) */
    if (trailingSL != null && trailingSL !== trade.sl) {
      drawHLine(ctx, yOf(trailingSL), marginLeft, W - marginRight, COLORS.trailingSL || "#f97316", "TRAIL " + fmtPrice(trailingSL, activeSym), W, marginRight);
    }

    /* Partial TP line at 1:1 level */
    if (partialTpEnabled) {
      const risk = Math.abs(trade.entry - trade.sl);
      const partialLevel = trade.dir === "BULL" ? trade.entry + risk : trade.entry - risk;
      const partialColor = partialTpHit ? "rgba(34,197,94,0.5)" : "rgba(168,85,247,0.4)";
      drawHLine(ctx, yOf(partialLevel), marginLeft, W - marginRight, partialColor, "1:1 " + fmtPrice(partialLevel, activeSym), W, marginRight);
    }

    /* Tesla 3–6–9 level lines: T1 (3R), T2 (6R), T3 (9R) */
    if (teslaScalingEnabled) {
      const risk = Math.abs(trade.entry - trade.sl);
      const isBull = trade.dir === "BULL";
      const teslaLevels = [
        { r: TESLA_T1_R, label: "T1", hit: teslaT1Hit },
        { r: TESLA_T2_R, label: "T2", hit: teslaT2Hit },
        { r: TESLA_T3_R, label: "T3", hit: teslaT3Hit }
      ];
      for (const { r, label, hit } of teslaLevels) {
        const lvlPrice = isBull ? trade.entry + risk * r : trade.entry - risk * r;
        const lvlColor = hit ? "rgba(251,191,36,0.7)" : "rgba(251,191,36,0.35)";
        drawHLine(ctx, yOf(lvlPrice), marginLeft, W - marginRight, lvlColor,
          `${label} ${r}R ${fmtPrice(lvlPrice, activeSym)}${hit ? " ✓" : ""}`, W, marginRight);
      }
    }

    const entryY = yOf(trade.entry);
    const slY    = yOf(trade.sl);

    /* Risk zone shading */
    const riskTop = Math.min(entryY, slY);
    const riskH   = Math.abs(slY - entryY);
    ctx.fillStyle = "rgba(239,68,68,0.08)";
    ctx.fillRect(marginLeft, riskTop, chartW, riskH);

    /* Reward zone shading (only if TP exists) */
    if (trade.tp != null) {
      const tpY    = yOf(trade.tp);
      const rewTop = Math.min(entryY, tpY);
      const rewH   = Math.abs(tpY - entryY);
      ctx.fillStyle = "rgba(34,197,94,0.08)";
      ctx.fillRect(marginLeft, rewTop, chartW, rewH);
    }

    ctx.fillStyle = COLORS.entryLine;
    ctx.font = "bold 12px Arial";
    ctx.textAlign = "right";
    let rrLabel = pureTrailingEnabled ? "PURE TRAILING" : `R:R  1 : ${fmt(trade.rr, 1)}`;
    if (!pureTrailingEnabled) {
      const m = calcPositionMetrics(trade);
      if (m) {
        rrLabel += m.isSynthetic
          ? `  ($${fmt(m.dollarRisk, 2)} → $${fmt(m.dollarReward, 2)} | ${fmt(m.lotSize, 2)} lots)`
          : `  ($${fmt(m.dollarRisk, 2)} → $${fmt(m.dollarReward, 2)} | ${fmt(m.lotSize, 2)} lots | ${fmt(m.pips, 1)} pips)`;
      }
    }
    ctx.fillText(rrLabel, W - marginRight - 6, entryY - 6);
    ctx.textAlign = "left";
  }

  /* ---- Live price line ---- */
  if (candles.length > 0) {
    const lastCandle = candles[candles.length - 1];
    const liveP = lastCandle.close;
    const liveY = yOf(liveP);
    const isBull = lastCandle.close >= lastCandle.open;
    const livePriceColor = isBull ? "#22c55e" : "#ef4444";

    /* Dashed horizontal line across chart */
    ctx.strokeStyle = livePriceColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(marginLeft, liveY);
    ctx.lineTo(W - marginRight, liveY);
    ctx.stroke();
    ctx.setLineDash([]);

    /* Price label badge on right edge */
    const priceText = fmt(liveP, 4);
    ctx.font = "bold 11px Arial";
    const tw = ctx.measureText(priceText).width + 10;
    ctx.fillStyle = livePriceColor;
    ctx.fillRect(W - marginRight, liveY - 8, tw + 4, 16);
    ctx.fillStyle = "#fff";
    ctx.fillText(priceText, W - marginRight + 5, liveY + 4);

    /* Candle countdown badge on chart (top-right corner) */
    {
      const gran = parseInt(UI.granSelect.value, 10);
      const candleEndEpoch = lastCandle.epoch + gran;
      const nowEpoch = Math.floor(Date.now() / 1000);
      const remaining = Math.max(0, candleEndEpoch - nowEpoch);
      const cHrs = Math.floor(remaining / 3600);
      const cMin = Math.floor((remaining % 3600) / 60);
      const cSec = remaining % 60;
      const cdText = cHrs > 0
        ? `⏱ ${cHrs}h ${cMin.toString().padStart(2, "0")}m ${cSec.toString().padStart(2, "0")}s`
        : cMin > 0
          ? `⏱ ${cMin}m ${cSec.toString().padStart(2, "0")}s`
          : `⏱ ${cSec}s`;
      ctx.save();
      ctx.font = "bold 11px Arial";
      const cdTW = ctx.measureText(cdText).width + 12;
      const cdX = W - marginRight - cdTW - 4;
      const cdY = marginTop + 6;
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = remaining <= 10 ? "#ef4444" : "#3b82f6";
      ctx.beginPath();
      ctx.moveTo(cdX + 4, cdY);
      ctx.lineTo(cdX + cdTW - 4, cdY);
      ctx.quadraticCurveTo(cdX + cdTW, cdY, cdX + cdTW, cdY + 4);
      ctx.lineTo(cdX + cdTW, cdY + 16);
      ctx.quadraticCurveTo(cdX + cdTW, cdY + 20, cdX + cdTW - 4, cdY + 20);
      ctx.lineTo(cdX + 4, cdY + 20);
      ctx.quadraticCurveTo(cdX, cdY + 20, cdX, cdY + 16);
      ctx.lineTo(cdX, cdY + 4);
      ctx.quadraticCurveTo(cdX, cdY, cdX + 4, cdY);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#fff";
      ctx.fillText(cdText, cdX + 6, cdY + 14);
      ctx.restore();
    }
  }

  /* ---- Signal price badge (prominent display when trade is active) ---- */
  if (trade) {
    const sel = UI.symbolSelect;
    const symbolLabel = sel ? (sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : sel.value) : "";
    const sigDir = trade.dir === "BULL" ? "▲ BUY" : "▼ SELL";
    const sigColor = trade.dir === "BULL" ? "#22c55e" : "#ef4444";
    const sigText = `${sigDir}  ${symbolLabel}  @  ${fmtPrice(trade.entry, getActiveSymbol())}`;

    ctx.save();
    ctx.font = "bold 13px Arial";
    const sigTW = ctx.measureText(sigText).width + 20;
    const sigX = marginLeft + 6;
    const sigY = marginTop + 6;
    const sigH = 24;

    /* Badge background */
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = currentTheme === "light" ? "#fff" : "#1e293b";
    ctx.beginPath();
    ctx.moveTo(sigX + 4, sigY);
    ctx.lineTo(sigX + sigTW - 4, sigY);
    ctx.quadraticCurveTo(sigX + sigTW, sigY, sigX + sigTW, sigY + 4);
    ctx.lineTo(sigX + sigTW, sigY + sigH - 4);
    ctx.quadraticCurveTo(sigX + sigTW, sigY + sigH, sigX + sigTW - 4, sigY + sigH);
    ctx.lineTo(sigX + 4, sigY + sigH);
    ctx.quadraticCurveTo(sigX, sigY + sigH, sigX, sigY + sigH - 4);
    ctx.lineTo(sigX, sigY + 4);
    ctx.quadraticCurveTo(sigX, sigY, sigX + 4, sigY);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = sigColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;

    /* Badge text */
    ctx.fillStyle = sigColor;
    ctx.textAlign = "left";
    ctx.fillText(sigText, sigX + 10, sigY + sigH / 2 + 4);
    ctx.restore();
  }

  /* ---- Live Scalp Markers on Chart ---- */
  if (liveScalpEnabled && liveScalpHistory.length > 0) {
    for (const s of liveScalpHistory) {
      /* Only draw scalps that fall within the visible candle range */
      if (s.candleIdx < 0 || s.candleIdx >= candles.length) continue;
      const sx = xOf(s.candleIdx);
      const sy = yOf(s.entry);
      const sc = candles[s.candleIdx];
      if (!sc) continue;

      const isBull = s.dir === "BULL";
      const arrowColor = isBull ? "#22c55e" : "#ef4444";
      const arrowY = isBull ? yOf(sc.low) + 14 : yOf(sc.high) - 14;

      /* Arrow marker */
      ctx.save();
      ctx.font = "bold 16px Arial";
      ctx.textAlign = "center";
      ctx.fillStyle = arrowColor;
      ctx.shadowColor = arrowColor;
      ctx.shadowBlur = 6;
      ctx.fillText(isBull ? "▲" : "▼", sx, arrowY);
      ctx.shadowBlur = 0;

      /* Small confluence badge above/below the arrow */
      const badgeY = isBull ? arrowY + 12 : arrowY - 8;
      ctx.font = "bold 9px Arial";
      ctx.globalAlpha = 0.9;
      const badgeText = `${s.conf}/7`;
      const btw = ctx.measureText(badgeText).width + 6;
      ctx.fillStyle = arrowColor;
      const bx = sx - btw / 2;
      const by = badgeY - 4;
      /* Rounded rect */
      ctx.beginPath();
      ctx.moveTo(bx + 3, by);
      ctx.lineTo(bx + btw - 3, by);
      ctx.quadraticCurveTo(bx + btw, by, bx + btw, by + 3);
      ctx.lineTo(bx + btw, by + 10);
      ctx.quadraticCurveTo(bx + btw, by + 13, bx + btw - 3, by + 13);
      ctx.lineTo(bx + 3, by + 13);
      ctx.quadraticCurveTo(bx, by + 13, bx, by + 10);
      ctx.lineTo(bx, by + 3);
      ctx.quadraticCurveTo(bx, by, bx + 3, by);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.fillText(badgeText, sx, badgeY + 6);
      ctx.globalAlpha = 1;

      /* Dashed SL/TP level lines (short, local to the scalp candle) */
      const lineStartX = Math.max(marginLeft, sx - candleW * 4);
      const lineEndX   = Math.min(W - marginRight, sx + candleW * 4);
      ctx.setLineDash([2, 2]);
      ctx.lineWidth = 1;
      /* SL */
      ctx.strokeStyle = "rgba(239,68,68,0.5)";
      ctx.beginPath();
      ctx.moveTo(lineStartX, yOf(s.sl));
      ctx.lineTo(lineEndX, yOf(s.sl));
      ctx.stroke();
      /* TP */
      ctx.strokeStyle = "rgba(34,197,94,0.5)";
      ctx.beginPath();
      ctx.moveTo(lineStartX, yOf(s.tp));
      ctx.lineTo(lineEndX, yOf(s.tp));
      ctx.stroke();
      ctx.setLineDash([]);

      /* Result badge (WIN/LOSS) next to the scalp marker */
      if (s.result === "WIN" || s.result === "LOSS") {
        const rColor = s.result === "WIN" ? "rgba(16,185,129,0.9)" : "rgba(244,63,94,0.9)";
        const rText = s.result;
        ctx.font = "bold 8px Arial";
        const rw = ctx.measureText(rText).width + 6;
        const rx = sx + 10;
        const ry = sy - 6;
        ctx.fillStyle = rColor;
        ctx.beginPath();
        ctx.moveTo(rx + 3, ry);
        ctx.lineTo(rx + rw - 3, ry);
        ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + 3);
        ctx.lineTo(rx + rw, ry + 10);
        ctx.quadraticCurveTo(rx + rw, ry + 13, rx + rw - 3, ry + 13);
        ctx.lineTo(rx + 3, ry + 13);
        ctx.quadraticCurveTo(rx, ry + 13, rx, ry + 10);
        ctx.lineTo(rx, ry + 3);
        ctx.quadraticCurveTo(rx, ry, rx + 3, ry);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.fillText(rText, rx + rw / 2, ry + 10);
      }

      ctx.restore();
    }
  }

  /* ---- Custom Strategy Markers on Chart (Liquidity Sweep, Stop Loss Hunt, Failed Pin Bar, Fib Golden Zone, Power of 3) ---- */
  const customStratHistories = [
    { history: liquiditySweepHistory, enabled: liquiditySweepEnabled, emoji: "🌊", color: "#3b82f6" },
    { history: stopLossHuntHistory,   enabled: stopLossHuntEnabled,   emoji: "🎯", color: "#f59e0b" },
    { history: failedPinBarHistory,   enabled: failedPinBarEnabled,   emoji: "📌", color: "#a855f7" },
    { history: fibScalpHistory,       enabled: fibScalpEnabled,       emoji: "📐", color: "#10b981" },
    { history: po3History,            enabled: po3Enabled,            emoji: "⚡", color: "#06b6d4" },
    { history: nyOpenRangeHistory,    enabled: nyOpenRangeEnabled,    emoji: "🕤", color: "#f97316" },
    { history: sessionRangeHistory,   enabled: sessionRangesEnabled,  emoji: "🌍", color: "#8b5cf6" },
    { history: gridScalperMAHistory,  enabled: gridScalperMAEnabled,  emoji: "🔲", color: "#e11d48" },
    { history: fvgStratHistory,       enabled: fvgStratEnabled,       emoji: "🎯", color: "#f59e0b" },
    { history: mtfTopDownHistory,     enabled: mtfTopDownEnabled,     emoji: "⏱", color: "#6366f1" }
  ];
  for (const strat of customStratHistories) {
    if (!strat.enabled || strat.history.length === 0) continue;
    for (const s of strat.history) {
      if (s.candleIdx < 0 || s.candleIdx >= candles.length) continue;
      const sx = xOf(s.candleIdx);
      const sy = yOf(s.entry);
      const sc = candles[s.candleIdx];
      if (!sc) continue;

      const isBull = s.dir === "BULL";
      const arrowColor = isBull ? "#22c55e" : "#ef4444";
      const arrowY = isBull ? yOf(sc.low) + 18 : yOf(sc.high) - 18;

      ctx.save();
      /* Strategy-colored circle behind the emoji */
      ctx.beginPath();
      ctx.arc(sx, arrowY - 4, 8, 0, Math.PI * 2);
      ctx.fillStyle = strat.color + "33"; /* 20% opacity */
      ctx.fill();
      ctx.strokeStyle = strat.color;
      ctx.lineWidth = 1;
      ctx.stroke();

      /* Arrow */
      ctx.font = "bold 14px Arial";
      ctx.textAlign = "center";
      ctx.fillStyle = arrowColor;
      ctx.shadowColor = arrowColor;
      ctx.shadowBlur = 5;
      ctx.fillText(isBull ? "▲" : "▼", sx, arrowY);
      ctx.shadowBlur = 0;

      /* SL/TP lines */
      const lineStartX = Math.max(marginLeft, sx - candleW * 3);
      const lineEndX   = Math.min(W - marginRight, sx + candleW * 3);
      ctx.setLineDash([2, 2]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(239,68,68,0.4)";
      ctx.beginPath();
      ctx.moveTo(lineStartX, yOf(s.sl));
      ctx.lineTo(lineEndX, yOf(s.sl));
      ctx.stroke();
      ctx.strokeStyle = "rgba(34,197,94,0.4)";
      ctx.beginPath();
      ctx.moveTo(lineStartX, yOf(s.tp));
      ctx.lineTo(lineEndX, yOf(s.tp));
      ctx.stroke();
      ctx.setLineDash([]);

      /* Result badge */
      if (s.result === "WIN" || s.result === "LOSS") {
        const rColor = s.result === "WIN" ? "rgba(16,185,129,0.9)" : "rgba(244,63,94,0.9)";
        const rText = s.result;
        ctx.font = "bold 8px Arial";
        const rw = ctx.measureText(rText).width + 6;
        const rx = sx + 10;
        const ry = sy - 6;
        ctx.fillStyle = rColor;
        ctx.beginPath();
        ctx.moveTo(rx + 3, ry);
        ctx.lineTo(rx + rw - 3, ry);
        ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + 3);
        ctx.lineTo(rx + rw, ry + 10);
        ctx.quadraticCurveTo(rx + rw, ry + 13, rx + rw - 3, ry + 13);
        ctx.lineTo(rx + 3, ry + 13);
        ctx.quadraticCurveTo(rx, ry + 13, rx, ry + 10);
        ctx.lineTo(rx, ry + 3);
        ctx.quadraticCurveTo(rx, ry, rx + 3, ry);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.fillText(rText, rx + rw / 2, ry + 10);
      }

      ctx.restore();
    }
  }

  /* ---- Power of 3: FVG zone + 1H Open line on Chart ---- */
  if (po3Enabled && po3History.length > 0) {
    for (const s of po3History) {
      if (s.candleIdx < 0 || s.candleIdx >= candles.length) continue;
      if (s.fvgHigh == null || s.fvgLow == null) continue;

      const sx = xOf(s.candleIdx);
      const fvgTopY    = yOf(s.fvgHigh);
      const fvgBottomY = yOf(s.fvgLow);

      ctx.save();

      /* FVG zone (shaded rectangle) */
      const fvgStartX = Math.max(marginLeft, sx - candleW * 5);
      const fvgEndX   = Math.min(W - marginRight, sx + candleW * 5);
      ctx.fillStyle = s.dir === "BULL"
        ? "rgba(6,182,212,0.12)"   /* cyan-ish for bullish FVG */
        : "rgba(244,114,182,0.12)"; /* pink-ish for bearish FVG */
      ctx.fillRect(fvgStartX, fvgTopY, fvgEndX - fvgStartX, fvgBottomY - fvgTopY);

      /* FVG zone border */
      ctx.strokeStyle = s.dir === "BULL" ? "#06b6d4" : "#f472b6";
      ctx.lineWidth = 0.8;
      ctx.setLineDash([3, 2]);
      ctx.strokeRect(fvgStartX, fvgTopY, fvgEndX - fvgStartX, fvgBottomY - fvgTopY);
      ctx.setLineDash([]);

      /* FVG label */
      ctx.font = "bold 8px Arial";
      ctx.fillStyle = s.dir === "BULL" ? "#06b6d4" : "#f472b6";
      ctx.textAlign = "left";
      ctx.fillText("FVG", fvgStartX + 2, fvgTopY - 2);

      /* 1H Open level (dashed horizontal line spanning chart) */
      if (s.oneHourOpen != null) {
        const ohY = yOf(s.oneHourOpen);
        ctx.strokeStyle = "rgba(251,191,36,0.5)"; /* amber */
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(fvgStartX, ohY);
        ctx.lineTo(fvgEndX, ohY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = "bold 7px Arial";
        ctx.fillStyle = "rgba(251,191,36,0.8)";
        ctx.fillText("1H Open", fvgStartX + 2, ohY - 3);
      }

      ctx.restore();
    }
  }

  /* ---- Fair Value Gap Strategy: Demand/Supply zone + FVG zone on Chart ---- */
  if (fvgStratEnabled && fvgStratHistory.length > 0) {
    for (const s of fvgStratHistory) {
      if (s.candleIdx < 0 || s.candleIdx >= candles.length) continue;
      if (s.demandZoneHigh == null) continue;

      const sx = xOf(s.candleIdx);
      const zoneStartX = Math.max(marginLeft, sx - candleW * 8);
      const zoneEndX   = Math.min(W - marginRight, sx + candleW * 8);

      ctx.save();

      /* Demand / Supply zone (shaded rectangle) */
      const zTopY    = yOf(s.demandZoneHigh);
      const zBottomY = yOf(s.demandZoneLow);
      ctx.fillStyle = s.dir === "BULL"
        ? "rgba(34,197,94,0.10)"    /* green for demand */
        : "rgba(239,68,68,0.10)";   /* red for supply */
      ctx.fillRect(zoneStartX, zTopY, zoneEndX - zoneStartX, zBottomY - zTopY);
      ctx.strokeStyle = s.dir === "BULL" ? "#22c55e" : "#ef4444";
      ctx.lineWidth = 0.8;
      ctx.setLineDash([3, 2]);
      ctx.strokeRect(zoneStartX, zTopY, zoneEndX - zoneStartX, zBottomY - zTopY);
      ctx.setLineDash([]);
      ctx.font = "bold 7px Arial";
      ctx.fillStyle = s.dir === "BULL" ? "#22c55e" : "#ef4444";
      ctx.textAlign = "left";
      ctx.fillText(s.dir === "BULL" ? "Demand" : "Supply", zoneStartX + 2, zTopY - 2);

      /* FVG zone */
      if (s.fvgHigh != null) {
        const fvgTopY    = yOf(s.fvgHigh);
        const fvgBottomY = yOf(s.fvgLow);
        ctx.fillStyle = "rgba(251,191,36,0.10)";
        ctx.fillRect(zoneStartX, fvgTopY, zoneEndX - zoneStartX, fvgBottomY - fvgTopY);
        ctx.strokeStyle = "rgba(251,191,36,0.5)";
        ctx.lineWidth = 0.6;
        ctx.setLineDash([2, 2]);
        ctx.strokeRect(zoneStartX, fvgTopY, zoneEndX - zoneStartX, fvgBottomY - fvgTopY);
        ctx.setLineDash([]);
        ctx.font = "bold 7px Arial";
        ctx.fillStyle = "rgba(251,191,36,0.9)";
        ctx.fillText("FVG", zoneStartX + 2, fvgTopY - 2);
      }

      ctx.restore();
    }
  }

  /* ---- Feature 2: Orderblock zones on chart ---- */
  if (orderblockEnabled && orderblockHistory.length > 0) {
    for (const s of orderblockHistory) {
      if (s.candleIdx < 0 || s.candleIdx >= candles.length) continue;
      const sx = xOf(s.candleIdx);
      const zStartX = Math.max(marginLeft, sx - candleW * 10);
      const zEndX   = Math.min(W - marginRight, sx + candleW * 10);
      ctx.save();
      const zTopY    = yOf(s.obHigh);
      const zBotY    = yOf(s.obLow);
      ctx.fillStyle = s.dir === "BULL" ? "rgba(59,130,246,0.10)" : "rgba(168,85,247,0.10)";
      ctx.fillRect(zStartX, zTopY, zEndX - zStartX, zBotY - zTopY);
      ctx.strokeStyle = s.dir === "BULL" ? "#3b82f6" : "#a855f7";
      ctx.lineWidth = 0.8;
      ctx.setLineDash([3,2]);
      ctx.strokeRect(zStartX, zTopY, zEndX - zStartX, zBotY - zTopY);
      ctx.setLineDash([]);
      ctx.font = "bold 8px Arial";
      ctx.fillStyle = s.dir === "BULL" ? "#3b82f6" : "#a855f7";
      ctx.textAlign = "left";
      ctx.fillText("OB", zStartX + 2, zTopY - 2);
      ctx.restore();
    }
  }

  /* ---- Feature 5: BOS / ChoCH markers ---- */
  if (bosChochEnabled && bosChochMarkers.length > 0) {
    ctx.save();
    for (const m of bosChochMarkers) {
      if (m.idx < 0 || m.idx >= candles.length) continue;
      const mx = xOf(m.idx);
      const myPrice = m.price;
      const my = yOf(myPrice);
      const isBull = m.dir === "BULL";
      const labelColor = m.type === "BOS" ? (isBull ? "#22c55e" : "#ef4444") : "#f59e0b";
      /* Horizontal dashed line at the broken level */
      ctx.strokeStyle = labelColor;
      ctx.lineWidth = 0.8;
      ctx.setLineDash([4,3]);
      ctx.beginPath();
      ctx.moveTo(Math.max(marginLeft, mx - candleW * 10), my);
      ctx.lineTo(Math.min(W - marginRight, mx + candleW * 2), my);
      ctx.stroke();
      ctx.setLineDash([]);
      /* Label badge */
      ctx.font = "bold 9px Arial";
      const ltext = m.type;
      const ltw = ctx.measureText(ltext).width + 6;
      ctx.globalAlpha = 0.88;
      ctx.fillStyle = labelColor;
      ctx.fillRect(mx - ltw / 2, my - (isBull ? 18 : 4), ltw, 13);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.fillText(ltext, mx, my - (isBull ? 8 : 14));
      ctx.globalAlpha = 1;
      ctx.textAlign = "left";
    }
    ctx.restore();
  }

  /* ---- Feature 10: Fibonacci Extension levels ---- */
  if (fibExtensionsEnabled && breakout && retestInfo && trade) {
    const swingLow  = breakout.dir === "BULL" ? breakout.level : retestInfo.candleIdx >= 0 ? candles[retestInfo.candleIdx].low  : null;
    const swingHigh = breakout.dir === "BEAR" ? breakout.level : retestInfo.candleIdx >= 0 ? candles[retestInfo.candleIdx].high : null;
    const move = breakout.dir === "BULL"
      ? (swingLow != null && swingHigh != null ? Math.abs(trade.entry - breakout.level) : null)
      : (swingLow != null && swingHigh != null ? Math.abs(trade.entry - breakout.level) : null);
    if (move != null && move > 0) {
      ctx.save();
      for (const ext of FIB_EXTENSIONS) {
        const extPrice = breakout.dir === "BULL"
          ? breakout.level + move * ext
          : breakout.level - move * ext;
        const ey = yOf(extPrice);
        if (ey < marginTop || ey > marginTop + chartH) continue;
        const opacity = ext <= 1.618 ? 0.7 : 0.4;
        ctx.strokeStyle = `rgba(251,191,36,${opacity})`;
        ctx.lineWidth = 0.8;
        ctx.setLineDash([3,3]);
        ctx.beginPath();
        ctx.moveTo(marginLeft, ey);
        ctx.lineTo(W - marginRight, ey);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = "bold 8px Arial";
        ctx.fillStyle = `rgba(251,191,36,${opacity + 0.2})`;
        ctx.textAlign = "right";
        const activeSym = getActiveSymbol();
        ctx.fillText(`${ext}  ${fmtPrice(extPrice, activeSym)}`, W - marginRight - 4, ey - 2);
      }
      ctx.textAlign = "left";
      ctx.restore();
    }
  }

  /* ---- Feature 9: Volume Profile (range-based histogram) ---- */
  if (volumeProfileEnabled && candles.length > 0) {
    const buckets = 30;
    const counts = new Array(buckets).fill(0);
    const pMin = Math.min(...candles.map(c => c.low));
    const pMax = Math.max(...candles.map(c => c.high));
    const pRange = (pMax - pMin) || 1;
    for (const c of candles) {
      const mid = (c.high + c.low) / 2;
      const bucket = Math.min(buckets - 1, Math.floor((mid - pMin) / pRange * buckets));
      counts[bucket]++;
    }
    const maxCount = Math.max(...counts, 1);
    const vpWidth = Math.min(60, chartW * 0.08);
    const vpX = W - marginRight - vpWidth - 2;
    ctx.save();
    ctx.globalAlpha = 0.35;
    for (let b = 0; b < buckets; b++) {
      const bPrice = pMin + (b / buckets) * pRange;
      const bY = yOf(bPrice + pRange / buckets / 2);
      const barW = (counts[b] / maxCount) * vpWidth;
      const barH = Math.max(1, (chartH / buckets) * 0.85);
      const intensity = counts[b] / maxCount;
      ctx.fillStyle = `rgb(${Math.round(59 + 186 * intensity)},${Math.round(130 - 60 * intensity)},246)`;
      ctx.fillRect(vpX + vpWidth - barW, bY - barH / 2, barW, barH);
    }
    ctx.globalAlpha = 0.6;
    ctx.font = "7px Arial";
    ctx.fillStyle = currentTheme === "light" ? "#334155" : "#94a3b8";
    ctx.textAlign = "left";
    ctx.fillText("Vol", vpX + 1, marginTop + 12);
    ctx.globalAlpha = 1;
    ctx.textAlign = "left";
    ctx.restore();
  }

  /* ---- Feature 7: RSI Divergence Visual Markers ---- */
  if (divergenceVisualEnabled && divergenceMarkers.length > 0) {
    for (const dm of divergenceMarkers) {
      if (dm.boIdx >= candles.length || dm.rtIdx >= candles.length) continue;
      const bx = xOf(dm.boIdx), rx = xOf(dm.rtIdx);
      const by = yOf(dm.priceBO), ry = yOf(dm.priceRT);
      ctx.save();
      ctx.strokeStyle = dm.dir === "BULL" ? "#22c55e" : "#ef4444";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4,3]);
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(rx, ry);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = "bold 8px Arial";
      ctx.textAlign = "center";
      ctx.fillStyle = dm.dir === "BULL" ? "#22c55e" : "#ef4444";
      const midX = (bx + rx) / 2;
      const midY = (by + ry) / 2 - 8;
      ctx.fillText(`RSI div`, midX, midY);
      ctx.textAlign = "left";
      ctx.restore();
    }
  }

  /* ---- Crosshair + OHLC tooltip ---- */
  if (chartMouseActive && chartMouseX >= marginLeft && chartMouseX <= W - marginRight
      && chartMouseY >= marginTop && chartMouseY <= marginTop + chartH) {

    /* Vertical crosshair line */
    ctx.strokeStyle = COLORS.crosshairText;
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 0.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(chartMouseX, marginTop);
    ctx.lineTo(chartMouseX, marginTop + chartH);
    ctx.stroke();

    /* Horizontal crosshair line */
    ctx.beginPath();
    ctx.moveTo(marginLeft, chartMouseY);
    ctx.lineTo(W - marginRight, chartMouseY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    /* Price label on right axis at crosshair Y */
    const crossPrice = priceLow + (1 - (chartMouseY - marginTop) / chartH) * priceRange;
    const cpText = fmt(crossPrice, 4);
    ctx.font = "bold 10px Arial";
    const cpTW = ctx.measureText(cpText).width + 8;
    ctx.fillStyle = currentTheme === "light" ? "#334155" : "#e2e8f0";
    ctx.fillRect(W - marginRight, chartMouseY - 7, cpTW + 2, 14);
    ctx.fillStyle = currentTheme === "light" ? "#fff" : "#0f172a";
    ctx.fillText(cpText, W - marginRight + 4, chartMouseY + 3);

    /* Find nearest candle index */
    const hoveredIdx = Math.min(candles.length - 1, Math.max(0, Math.round(((chartMouseX - marginLeft) / chartW) * (candles.length - 1))));
    if (hoveredIdx >= 0 && hoveredIdx < candles.length) {
      const hc = candles[hoveredIdx];

      /* Highlight hovered candle with vertical bar */
      const hx = xOf(hoveredIdx);
      ctx.fillStyle = currentTheme === "light" ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.04)";
      ctx.fillRect(hx - candleW / 2 - 2, marginTop, candleW + 4, chartH);

      /* OHLC tooltip box */
      const isBull = hc.close >= hc.open;
      const d = new Date(hc.epoch * 1000);
      const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const dateStr = d.toLocaleDateString([], { month: "short", day: "numeric" });
      const lines = [
        `${dateStr}  ${timeStr}`,
        `O: ${fmt(hc.open, 4)}`,
        `H: ${fmt(hc.high, 4)}`,
        `L: ${fmt(hc.low, 4)}`,
        `C: ${fmt(hc.close, 4)}`
      ];

      ctx.font = "11px 'JetBrains Mono', monospace";
      const lineH = 16;
      const tooltipPad = 8;
      let maxLineW = 0;
      for (const l of lines) {
        const lw = ctx.measureText(l).width;
        if (lw > maxLineW) maxLineW = lw;
      }
      const tooltipW = maxLineW + tooltipPad * 2;
      const tooltipH = lines.length * lineH + tooltipPad * 2;

      /* Position tooltip - flip side if near edge */
      let tx = chartMouseX + 14;
      let ty = chartMouseY - tooltipH / 2;
      if (tx + tooltipW > W - marginRight) tx = chartMouseX - tooltipW - 14;
      if (ty < marginTop) ty = marginTop;
      if (ty + tooltipH > marginTop + chartH) ty = marginTop + chartH - tooltipH;

      /* Draw tooltip background */
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = currentTheme === "light" ? "#fff" : "#1e293b";
      ctx.beginPath();
      const tr = 4;
      ctx.moveTo(tx + tr, ty);
      ctx.lineTo(tx + tooltipW - tr, ty);
      ctx.quadraticCurveTo(tx + tooltipW, ty, tx + tooltipW, ty + tr);
      ctx.lineTo(tx + tooltipW, ty + tooltipH - tr);
      ctx.quadraticCurveTo(tx + tooltipW, ty + tooltipH, tx + tooltipW - tr, ty + tooltipH);
      ctx.lineTo(tx + tr, ty + tooltipH);
      ctx.quadraticCurveTo(tx, ty + tooltipH, tx, ty + tooltipH - tr);
      ctx.lineTo(tx, ty + tr);
      ctx.quadraticCurveTo(tx, ty, tx + tr, ty);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = isBull ? "#22c55e" : "#ef4444";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;

      /* Draw tooltip text */
      ctx.fillStyle = currentTheme === "light" ? "#334155" : "#cbd5e1";
      ctx.textAlign = "left";
      for (let li = 0; li < lines.length; li++) {
        /* First line (date) in muted color, OHLC in theme color */
        if (li === 0) {
          ctx.fillStyle = currentTheme === "light" ? "#94a3b8" : "#64748b";
        } else {
          ctx.fillStyle = currentTheme === "light" ? "#334155" : "#cbd5e1";
        }
        ctx.fillText(lines[li], tx + tooltipPad, ty + tooltipPad + (li + 1) * lineH - 3);
      }
    }
  }
}

/**
 * Debounced version of drawChart for non-critical redraws.
 * Use this for mouse movements, window resizes, and other frequent events.
 * Critical updates (new candle data) should still call drawChart() directly.
 */
function debouncedDrawChart() {
  if (chartRedrawPending) return;
  chartRedrawPending = true;
  
  if (chartRedrawTimer) {
    cancelAnimationFrame(chartRedrawTimer);
  }
  
  chartRedrawTimer = requestAnimationFrame(() => {
    chartRedrawPending = false;
    drawChart();
  });
}

function drawEMALine(ctx, emaData, xOf, yOf, color) {
  if (!emaData || emaData.length === 0) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < emaData.length; i++) {
    if (emaData[i] == null) continue;
    const x = xOf(i);
    const y = yOf(emaData[i]);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawGrid(ctx, ml, mt, cw, ch, pLow, pHigh, W, COLORS) {
  const steps = 6;
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.fillStyle = COLORS.gridText;
  ctx.font = "10px Arial";
  ctx.textAlign = "right";

  /* Horizontal price grid */
  for (let i = 0; i <= steps; i++) {
    const y = mt + (i / steps) * ch;
    const price = pHigh - (i / steps) * (pHigh - pLow);
    ctx.beginPath();
    ctx.moveTo(ml, y);
    ctx.lineTo(ml + cw, y);
    ctx.stroke();
    ctx.fillText(fmt(price, 4), W - 4, y + 3);
  }

  /* Vertical time grid (4 evenly-spaced lines) */
  const vSteps = 4;
  ctx.textAlign = "center";
  for (let i = 1; i < vSteps; i++) {
    const x = ml + (i / vSteps) * cw;
    ctx.beginPath();
    ctx.moveTo(x, mt);
    ctx.lineTo(x, mt + ch);
    ctx.stroke();
  }

  ctx.textAlign = "left";
}

function drawHLine(ctx, y, x1, x2, color, label, W, mr) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = color;
  ctx.font = "bold 10px Arial";
  const tw = ctx.measureText(label).width + 8;
  ctx.globalAlpha = 0.85;
  ctx.fillRect(x2 + 2, y - 7, tw, 14);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#fff";
  ctx.fillText(label, x2 + 6, y + 3);
}

/* ================= PARAMETER SYNC ================= */
function syncConfigFromUI() {
  if (UI.rangeDuration) {
    const v = parseInt(UI.rangeDuration.value, 10);
    if (!isNaN(v) && v > 0) {
      RANGE_MINUTES = v;
    } else {
      addLog("⚠️ Invalid range duration. Must be at least 1 minute.");
      UI.rangeDuration.value = RANGE_MINUTES; /* Reset to valid value */
    }
  }
  if (UI.touchTolerance) {
    const v = parseInt(UI.touchTolerance.value, 10);
    if (!isNaN(v) && v >= 0 && v <= 100) {
      LEVEL_TOUCH_TOLERANCE = v / 100;
    } else {
      addLog("⚠️ Invalid touch tolerance. Must be between 0-100%.");
      UI.touchTolerance.value = Math.round(LEVEL_TOUCH_TOLERANCE * 100);
    }
  }
  if (UI.dojiRatio) {
    const v = parseInt(UI.dojiRatio.value, 10);
    if (!isNaN(v) && v >= 0 && v <= 100) {
      DOJI_BODY_RATIO = v / 100;
    } else {
      addLog("⚠️ Invalid doji ratio. Must be between 0-100%.");
      UI.dojiRatio.value = Math.round(DOJI_BODY_RATIO * 100);
    }
  }
  if (UI.lookbackPeriod) {
    const v = parseInt(UI.lookbackPeriod.value, 10);
    if (!isNaN(v) && v > 0 && v <= 100) {
      SWING_LOOKBACK_PERIOD = v;
    } else {
      addLog("⚠️ Invalid lookback period. Must be between 1-100.");
      UI.lookbackPeriod.value = SWING_LOOKBACK_PERIOD;
    }
  }
  saveSettings();
}

/* ================= LOGIN GATE ================= */
/**
 * Update the Deriv OAuth status badge and disconnect button visibility.
 * Called on page load and whenever the token changes.
 */
function updateDerivStatus() {
  const token = sessionStorage.getItem(DERIV_TOKEN_KEY) || "";
  const statusEl = document.getElementById("derivAccountStatus");
  const disconnectBtn = document.getElementById("derivDisconnectBtn");
  if (statusEl) {
    statusEl.textContent = token ? "● Connected" : "";
    statusEl.className = "deriv-account-status" + (token ? " connected" : "");
  }
  if (disconnectBtn) disconnectBtn.style.display = token ? "inline-flex" : "none";
}

function initLoginGate() {
  /* Use the shared auth module if available */
  if (typeof ITGuruAuth !== "undefined") {
    ITGuruAuth.initLoginGate({
      onLogin: () => {
        localStorage.removeItem("itguru_deriv_token");
        /* Refresh user data (role + strategies) from server */
        ITGuruAuth.verify().then(() => applyStrategyAccess()).catch(() => { /* silent auth verify */ });
      }
    });

    /* Wire auth logout button */
    const authLogoutBtn = document.getElementById("authLogoutBtn");
    if (authLogoutBtn) {
      authLogoutBtn.addEventListener("click", () => {
        ITGuruAuth.logout();
        location.reload();
      });
    }

    /* If already logged in, apply strategy access after restoring settings */
    if (ITGuruAuth.isLoggedIn()) {
      ITGuruAuth.verify().then(() => applyStrategyAccess()).catch(() => { /* silent auth verify */ });
    }
    return;
  }

  /* Fallback: no auth module, allow browsing freely */
  if (UI.loginOverlay) UI.loginOverlay.style.display = "none";
}

/**
 * Lock strategy toggles that the user has not been granted access to.
 * Admins bypass all gates.
 */
function applyStrategyAccess() {
  if (typeof ITGuruAuth === "undefined") return;

  const user = ITGuruAuth.getUser();
  /* Admins get everything */
  if (user && user.role === "admin") return;

  const granted = new Set(ITGuruAuth.getStrategies());

  /* Map: element id → strategy key → disable callback */
  const strategyMap = [
    { id: "liquiditySweepToggle",  key: "liquidity_sweep",  fn: () => { liquiditySweepEnabled = false; } },
    { id: "stopLossHuntToggle",    key: "stop_loss_hunt",   fn: () => { stopLossHuntEnabled   = false; } },
    { id: "failedPinBarToggle",    key: "failed_pin_bar",   fn: () => { failedPinBarEnabled   = false; } },
    { id: "fibScalpToggle",        key: "fib_scalp",        fn: () => { fibScalpEnabled       = false; } },
    { id: "po3Toggle",             key: "po3",              fn: () => { po3Enabled            = false; } },
    { id: "nyOpenRangeToggle",     key: "ny_open_range",    fn: () => { nyOpenRangeEnabled    = false; } },
    { id: "sessionRangesToggle",   key: "session_ranges",   fn: () => { sessionRangesEnabled  = false; } },
    { id: "gridScalperMAToggle",   key: "grid_scalper_ma",  fn: () => { gridScalperMAEnabled  = false; } },
    { id: "fvgStratToggle",        key: "fvg_strat",        fn: () => { fvgStratEnabled       = false; } },
    { id: "liveScalpToggle",       key: "live_scalp",       fn: () => { liveScalpEnabled      = false; } },
    { id: "mtfTopDownToggle",      key: "mtf_top_down",     fn: () => { mtfTopDownEnabled     = false; } },
    { id: "orderblockToggle",      key: "orderblock",       fn: () => { orderblockEnabled     = false; } },
  ];

  for (const { id, key, fn } of strategyMap) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (!granted.has(key)) {
      el.checked  = false;
      el.disabled = true;
      el.title    = "🔒 Upgrade to access this strategy";
      if (fn) fn();
      /* Add lock icon label next to the toggle */
      const label = el.closest("label") || el.parentElement;
      if (label && !label.querySelector(".strategy-lock-badge")) {
        const badge = document.createElement("span");
        badge.className   = "strategy-lock-badge";
        badge.textContent = "🔒";
        badge.title       = "Upgrade to unlock";
        label.appendChild(badge);
      }
    }
  }
  updateStrategyBadges();
}

/**
 * Refresh the ON/OFF/LOCKED status badges in the Strategies section.
 * Call this after any strategy toggle changes or after loadSettings().
 */
function updateStrategyBadges() {
  const entries = [
    { badgeId: "stratBadge-liquiditySweep", toggleId: "liquiditySweepToggle", enabled: liquiditySweepEnabled },
    { badgeId: "stratBadge-stopLossHunt",   toggleId: "stopLossHuntToggle",   enabled: stopLossHuntEnabled   },
    { badgeId: "stratBadge-failedPinBar",   toggleId: "failedPinBarToggle",   enabled: failedPinBarEnabled   },
    { badgeId: "stratBadge-fibScalp",       toggleId: "fibScalpToggle",       enabled: fibScalpEnabled       },
    { badgeId: "stratBadge-po3",            toggleId: "po3Toggle",            enabled: po3Enabled            },
    { badgeId: "stratBadge-nyOpenRange",    toggleId: "nyOpenRangeToggle",    enabled: nyOpenRangeEnabled    },
    { badgeId: "stratBadge-sessionRanges",  toggleId: "sessionRangesToggle",  enabled: sessionRangesEnabled  },
    { badgeId: "stratBadge-liveScalp",      toggleId: "liveScalpToggle",      enabled: liveScalpEnabled      },
    { badgeId: "stratBadge-gridScalperMA",  toggleId: "gridScalperMAToggle",  enabled: gridScalperMAEnabled  },
    { badgeId: "stratBadge-fvgStrat",       toggleId: "fvgStratToggle",       enabled: fvgStratEnabled       },
    { badgeId: "stratBadge-mtfTopDown",     toggleId: "mtfTopDownToggle",     enabled: mtfTopDownEnabled     },
    { badgeId: "stratBadge-orderblock",     toggleId: "orderblockToggle",     enabled: orderblockEnabled     },
  ];
  for (const { badgeId, toggleId, enabled } of entries) {
    const badge  = document.getElementById(badgeId);
    const toggle = document.getElementById(toggleId);
    if (!badge) continue;
    if (toggle && toggle.disabled) {
      badge.textContent = "🔒";
      badge.className   = "strat-enable-badge locked";
    } else if (enabled) {
      badge.textContent = "ON";
      badge.className   = "strat-enable-badge on";
    } else {
      badge.textContent = "OFF";
      badge.className   = "strat-enable-badge off";
    }
  }
}


/**
 * Multi-symbol system: runs up to 6 independent indicator instances
 * simultaneously, each with its own WebSocket connection and state.
 *
 * Architecture:
 *   - Each panel is a plain object holding all per-symbol state.
 *   - Before calling existing analysis functions (which use globals),
 *     we "activate" a panel (copy its state → globals), run the logic,
 *     then "save" (copy globals → panel state).
 *   - JavaScript is single-threaded so no race conditions occur.
 *   - Each panel has a mini-chart canvas in the UI grid.
 *   - Clicking a panel makes it the "focused" panel; the main chart
 *     and sidebar detail panels update to show that panel's data.
 */

const MULTI_MAX_PANELS = 90;
const multiPanels = new Map();   /* symbol → panel object */

/* ---- Batched rendering for multi-panel performance ---- */
const _dirtyPanels = new Set();          /* panels needing mini-chart redraw */
let _rafScheduled = false;               /* whether a rAF callback is pending  */
let _focusedDirty = false;               /* focused panel needs main-view refresh */
let _bannersDirty = false;               /* aggregated banners need refresh */
const _PANEL_UI_THROTTLE_MS = 300;       /* min interval for card DOM updates */
const _BANNER_THROTTLE_MS = 500;         /* min interval for banner / stats updates */
let _lastBannerUpdate = 0;

/** Mark a panel for deferred mini-chart redraw (batched via rAF). */
function markPanelDirty(p) {
  _dirtyPanels.add(p);
  if (!_rafScheduled) {
    _rafScheduled = true;
    requestAnimationFrame(_flushDirtyPanels);
  }
}

/** Flush all pending mini-chart redraws + focused-panel main-view in one frame. */
function _flushDirtyPanels() {
  _rafScheduled = false;

  /* Redraw dirty mini-charts */
  for (const p of _dirtyPanels) {
    drawMiniChart(p);
  }
  _dirtyPanels.clear();

  /* Refresh focused panel main view once per frame */
  if (_focusedDirty) {
    _focusedDirty = false;
    const fp = multiPanels.get(focusedPanelSymbol);
    if (fp) {
      activatePanel(fp);
      updateStateUI();
      drawChart();
      updateStatsUI();
      if (UI.livePrice && fp.candles.length > 0) {
        UI.livePrice.textContent = fmt(fp.candles[fp.candles.length - 1].close, 4);
      }
    }
  }

  /* Refresh aggregated banners at most every _BANNER_THROTTLE_MS */
  if (_bannersDirty) {
    const now = Date.now();
    if (now - _lastBannerUpdate >= _BANNER_THROTTLE_MS) {
      _bannersDirty = false;
      _lastBannerUpdate = now;
      updateSignalBanners();
      renderScalpAlerts();
      updateScalpStatsUI();
    } else {
      /* Re-schedule via setTimeout to fire exactly when the throttle window opens */
      setTimeout(() => {
        if (_bannersDirty && !_rafScheduled) {
          _rafScheduled = true;
          requestAnimationFrame(_flushDirtyPanels);
        }
      }, _BANNER_THROTTLE_MS - (now - _lastBannerUpdate));
    }
  }
}

/* ---- Aggregate signals from ALL panels (+ single-mode globals) ---- */
function getAggregatedSignalHistory() {
  if (multiPanels.size === 0) return signalHistory;   /* single-symbol mode */
  const all = [];
  for (const p of multiPanels.values()) {
    for (const s of p.signalHistory) all.push(s);
  }
  /* Sort newest-first by ISO time string (lexicographic comparison) */
  all.sort((a, b) => (b.time || "") > (a.time || "") ? 1 : (b.time || "") < (a.time || "") ? -1 : 0);
  return all;
}

function getAggregatedScalpHistory() {
  if (multiPanels.size === 0) return liveScalpHistory;   /* single-symbol mode */
  const all = [];
  for (const p of multiPanels.values()) {
    for (const s of p.liveScalpHistory) all.push(s);
  }
  /* Sort newest-first by epoch */
  all.sort((a, b) => (b.epoch || 0) - (a.epoch || 0));
  return all;
}

/* Lightweight banner-only update — safe to call from any panel context */
function updateSignalBanners() {
  renderSignalBanner();
  renderScalpTickerBanner();
  renderStrategyTickerBanner();
  /* Aggregated signal count */
  if (UI.signalCount) {
    const agg = getAggregatedSignalHistory();
    UI.signalCount.textContent = agg.length;
  }
}

/* ---- Panel state factory ---- */
function createPanelState(symbol) {
  /* Compute per-symbol recommended settings using market type */
  const rec = getMarketRecommendations(symbol);
  return {
    symbol,
    ws: null,
    candles: [],
    rangeStartEpoch: null,
    openingRange: null,
    breakout: null,
    retestInfo: null,
    indecisionInfo: null,
    confirmInfo: null,
    trade: null,
    phase: "WAITING",
    monitoringTrade: false,
    emaFast: [],
    emaSlow: [],
    emaHTF: [],
    emaMTF: [],
    vwapValues: [],
    retestCount: 0,
    atrValue: 0,
    atrValues: [],
    rsiValues: [],
    trailingSL: null,
    partialTpHit: false,
    teslaT1Hit: false,
    teslaT2Hit: false,
    teslaT3Hit: false,
    teslaBEHit: false,
    confluenceScore: 0,
    signalHistory: [],
    signalWins: 0,
    signalLosses: 0,
    liveScalpHistory: [],
    lastScalpCandleIdx: -999,
    connectTime: null,
    pingTimer: null,
    connected: false,
    /* Per-panel recommended filter settings (auto-applied from market type) */
    filters: {
      autoResetEnabled:    true,
      emaFilterEnabled:    rec.ema,
      htfFilterEnabled:    rec.htf,
      atrToleranceEnabled: rec.atr,
      trailingStopEnabled: rec.trailing.rec,
      partialTpEnabled:    rec.partialTp,
      falseBreakoutEnabled: rec.falseBreakout,
      minRREnabled:        rec.minRR.rec,
      minRRValue:          rec.rr.minRR,
      pureTrailingEnabled: false,
      teslaScalingEnabled: false,
      teslaScalingPlan:    "conservative",
      rsiFilterEnabled:    rec.rsi,
      volumeSpikeEnabled:  rec.volSpike.rec,
      sessionFilterEnabled: rec.session.rec,
      sessionFilterMode:   "london_ny",
      fibRetestEnabled:    rec.fib,
      macdFilterEnabled:       rec.macd,
      bbSqueezeFilterEnabled:  rec.bbSqueeze,
      adxFilterEnabled:        rec.adx,
      stochFilterEnabled:      rec.stoch,
      scalpingModeEnabled:     false,
      RANGE_MINUTES:       rec.range.minutes,
      /* Profit-Direction Constraints — inherit from current global state */
      minConfluenceEnabled:    minConfluenceEnabled,
      minConfluenceValue:      minConfluenceValue,
      doubleRetestEnabled:     doubleRetestEnabled,
      confirmBarEnabled:       confirmBarEnabled,
      divergenceFilterEnabled: divergenceFilterEnabled,
      adxHardGateEnabled:      adxHardGateEnabled,
      adxMaxThreshold:         adxMaxThreshold,
      breakoutDistEnabled:     breakoutDistEnabled,
      breakoutDistATR:         breakoutDistATR,
      timeDecayEnabled:        timeDecayEnabled,
      timeDecayCandles:        timeDecayCandles,
      consecutiveDirEnabled:   consecutiveDirEnabled,
      vwapFilterEnabled:       vwapFilterEnabled,
      stochCrossEnabled:       stochCrossEnabled,
      rangeSizeEnabled:        rangeSizeEnabled,
      rangeSizeMin:            rangeSizeMin,
      rangeSizeMax:            rangeSizeMax,
      hhhlEnabled:             hhhlEnabled,
      followThroughEnabled:    followThroughEnabled,
      mtfStructureEnabled:     mtfStructureEnabled,
    },
    /* DOM refs for the card */
    cardEl: null,
    canvasEl: null,
    phaseEl: null,
    dirEl: null,
    priceEl: null,
    dotEl: null,
    actionEl: null,
  };
}

/* ---- Copy panel state → globals (activate) ---- */
function activatePanel(p) {
  candles        = p.candles;
  rangeStartEpoch = p.rangeStartEpoch;
  openingRange   = p.openingRange;
  breakout       = p.breakout;
  retestInfo     = p.retestInfo;
  indecisionInfo = p.indecisionInfo;
  confirmInfo    = p.confirmInfo;
  trade          = p.trade;
  phase          = p.phase;
  monitoringTrade = p.monitoringTrade;
  emaFast        = p.emaFast;
  emaSlow        = p.emaSlow;
  emaHTF         = p.emaHTF;
  atrValue       = p.atrValue;
  atrValues      = p.atrValues;
  rsiValues      = p.rsiValues;
  macdLine       = p.macdLine;
  macdSignal     = p.macdSignal;
  macdHistogram  = p.macdHistogram;
  bbUpper        = p.bbUpper;
  bbLower        = p.bbLower;
  bbMiddle       = p.bbMiddle;
  bbWidth        = p.bbWidth;
  adxValue       = p.adxValue;
  adxDiPlus      = p.adxDiPlus;
  adxDiMinus     = p.adxDiMinus;
  stochK         = p.stochK;
  stochD         = p.stochD;
  emaMTF         = p.emaMTF || [];
  vwapValues     = p.vwapValues || [];
  retestCount    = p.retestCount || 0;
  trailingSL     = p.trailingSL;
  partialTpHit   = p.partialTpHit;
  teslaT1Hit     = p.teslaT1Hit  || false;
  teslaT2Hit     = p.teslaT2Hit  || false;
  teslaT3Hit     = p.teslaT3Hit  || false;
  teslaBEHit     = p.teslaBEHit  || false;
  confluenceScore = p.confluenceScore;
  signalHistory  = p.signalHistory;
  signalWins     = p.signalWins;
  signalLosses   = p.signalLosses;
  liveScalpHistory  = p.liveScalpHistory;
  lastScalpCandleIdx = p.lastScalpCandleIdx;
  ws             = p.ws;

  /* Custom strategy histories (per-panel isolation) */
  liquiditySweepHistory = p.liquiditySweepHistory || [];
  lastLiquiditySweepIdx = p.lastLiquiditySweepIdx != null ? p.lastLiquiditySweepIdx : -999;
  stopLossHuntHistory   = p.stopLossHuntHistory   || [];
  lastStopLossHuntIdx   = p.lastStopLossHuntIdx   != null ? p.lastStopLossHuntIdx   : -999;
  failedPinBarHistory   = p.failedPinBarHistory   || [];
  lastFailedPinBarIdx   = p.lastFailedPinBarIdx   != null ? p.lastFailedPinBarIdx   : -999;
  fibScalpHistory       = p.fibScalpHistory       || [];
  lastFibScalpIdx       = p.lastFibScalpIdx       != null ? p.lastFibScalpIdx       : -999;
  po3History            = p.po3History            || [];
  lastPo3Idx            = p.lastPo3Idx            != null ? p.lastPo3Idx            : -999;
  gridScalperMAHistory  = p.gridScalperMAHistory  || [];
  lastGridScalperMAIdx  = p.lastGridScalperMAIdx  != null ? p.lastGridScalperMAIdx  : -999;
  fvgStratHistory       = p.fvgStratHistory       || [];
  lastFvgStratIdx       = p.lastFvgStratIdx       != null ? p.lastFvgStratIdx       : -999;
  mtfTopDownHistory     = p.mtfTopDownHistory     || [];
  lastMtfTopDownIdx     = p.lastMtfTopDownIdx     != null ? p.lastMtfTopDownIdx     : -999;
  sessionRangeAsian   = p.sessionRangeAsian  || null;
  sessionRangeLondon  = p.sessionRangeLondon || null;
  sessionRangeNY      = p.sessionRangeNY     || null;
  asianRangeTight     = p.asianRangeTight    || false;
  londonSweepSignal   = p.londonSweepSignal  || null;
  sessionRangeTrade   = p.sessionRangeTrade  || null;
  sessionRangeTradeWins   = p.sessionRangeTradeWins   || 0;
  sessionRangeTradeLosses = p.sessionRangeTradeLosses || 0;
  sessionRangeHistory = p.sessionRangeHistory || [];
  lastSessionRangeBuildDate = p.lastSessionRangeBuildDate || null;

  /* NY Open Range */
  nyOpenRange         = p.nyOpenRange        || null;
  nyOpenRangeBreakout = p.nyOpenRangeBreakout || null;
  nyOpenRangeRetest   = p.nyOpenRangeRetest  || null;
  nyOpenRangeTrade    = p.nyOpenRangeTrade   || null;
  nyOpenRangePhase    = p.nyOpenRangePhase   || "IDLE";
  nyOpenRangeTradeWins   = p.nyOpenRangeTradeWins   || 0;
  nyOpenRangeTradeLosses = p.nyOpenRangeTradeLosses || 0;
  nyOpenRangeHistory  = p.nyOpenRangeHistory || [];

  /* Activate per-panel filter settings into globals —
     skip when the indicator-filters lock is active so that manually-set
     filter states are preserved when the user switches panels. */
  const f = p.filters;
  if (!lockIndicatorFilters) {
    autoResetEnabled     = f.autoResetEnabled;
    emaFilterEnabled     = f.emaFilterEnabled;
    htfFilterEnabled     = f.htfFilterEnabled;
    atrToleranceEnabled  = f.atrToleranceEnabled;
    trailingStopEnabled  = f.trailingStopEnabled;
    partialTpEnabled     = f.partialTpEnabled;
    falseBreakoutEnabled = f.falseBreakoutEnabled;
    minRREnabled         = f.minRREnabled;
    minRRValue           = f.minRRValue;
    pureTrailingEnabled  = f.pureTrailingEnabled;
    if (f.teslaScalingEnabled != null) teslaScalingEnabled = f.teslaScalingEnabled;
    if (f.teslaScalingPlan != null) teslaScalingPlan = f.teslaScalingPlan;
    rsiFilterEnabled     = f.rsiFilterEnabled;
    volumeSpikeEnabled   = f.volumeSpikeEnabled;
    sessionFilterEnabled = f.sessionFilterEnabled;
    sessionFilterMode    = f.sessionFilterMode;
    fibRetestEnabled     = f.fibRetestEnabled;
    macdFilterEnabled      = f.macdFilterEnabled;
    bbSqueezeFilterEnabled = f.bbSqueezeFilterEnabled;
    adxFilterEnabled       = f.adxFilterEnabled;
    stochFilterEnabled     = f.stochFilterEnabled;
    scalpingModeEnabled    = f.scalpingModeEnabled;
    RANGE_MINUTES        = f.RANGE_MINUTES;
    /* Profit-Direction Constraints */
    minConfluenceEnabled    = f.minConfluenceEnabled;
    minConfluenceValue      = f.minConfluenceValue;
    doubleRetestEnabled     = f.doubleRetestEnabled;
    confirmBarEnabled       = f.confirmBarEnabled;
    divergenceFilterEnabled = f.divergenceFilterEnabled;
    adxHardGateEnabled      = f.adxHardGateEnabled;
    adxMaxThreshold         = f.adxMaxThreshold;
    breakoutDistEnabled     = f.breakoutDistEnabled;
    breakoutDistATR         = f.breakoutDistATR;
    timeDecayEnabled        = f.timeDecayEnabled;
    timeDecayCandles        = f.timeDecayCandles;
    consecutiveDirEnabled   = f.consecutiveDirEnabled;
    vwapFilterEnabled       = f.vwapFilterEnabled;
    stochCrossEnabled       = f.stochCrossEnabled;
    rangeSizeEnabled        = f.rangeSizeEnabled;
    rangeSizeMin            = f.rangeSizeMin;
    rangeSizeMax            = f.rangeSizeMax;
    hhhlEnabled             = f.hhhlEnabled;
    followThroughEnabled    = f.followThroughEnabled;
    mtfStructureEnabled     = f.mtfStructureEnabled;
  }
}

/* ---- Copy globals → panel state (save) ---- */
function savePanel(p) {
  p.candles        = candles;
  p.rangeStartEpoch = rangeStartEpoch;
  p.openingRange   = openingRange;
  p.breakout       = breakout;
  p.retestInfo     = retestInfo;
  p.indecisionInfo = indecisionInfo;
  p.confirmInfo    = confirmInfo;
  p.trade          = trade;
  p.phase          = phase;
  p.monitoringTrade = monitoringTrade;
  p.emaFast        = emaFast;
  p.emaSlow        = emaSlow;
  p.emaHTF         = emaHTF;
  p.atrValue       = atrValue;
  p.atrValues      = atrValues;
  p.rsiValues      = rsiValues;
  p.macdLine      = macdLine;
  p.macdSignal    = macdSignal;
  p.macdHistogram = macdHistogram;
  p.bbUpper       = bbUpper;
  p.bbLower       = bbLower;
  p.bbMiddle      = bbMiddle;
  p.bbWidth       = bbWidth;
  p.adxValue      = adxValue;
  p.adxDiPlus     = adxDiPlus;
  p.adxDiMinus    = adxDiMinus;
  p.stochK        = stochK;
  p.stochD        = stochD;
  p.emaMTF        = emaMTF;
  p.vwapValues    = vwapValues;
  p.retestCount   = retestCount;
  p.trailingSL     = trailingSL;
  p.partialTpHit   = partialTpHit;
  p.teslaT1Hit     = teslaT1Hit;
  p.teslaT2Hit     = teslaT2Hit;
  p.teslaT3Hit     = teslaT3Hit;
  p.teslaBEHit     = teslaBEHit;
  p.confluenceScore = confluenceScore;
  p.signalHistory  = signalHistory;
  p.signalWins     = signalWins;
  p.signalLosses   = signalLosses;
  p.liveScalpHistory  = liveScalpHistory;
  p.lastScalpCandleIdx = lastScalpCandleIdx;
  p.ws             = ws;

  /* Custom strategy histories (per-panel isolation) */
  p.liquiditySweepHistory = liquiditySweepHistory;
  p.lastLiquiditySweepIdx = lastLiquiditySweepIdx;
  p.stopLossHuntHistory   = stopLossHuntHistory;
  p.lastStopLossHuntIdx   = lastStopLossHuntIdx;
  p.failedPinBarHistory   = failedPinBarHistory;
  p.lastFailedPinBarIdx   = lastFailedPinBarIdx;
  p.fibScalpHistory       = fibScalpHistory;
  p.lastFibScalpIdx       = lastFibScalpIdx;
  p.po3History            = po3History;
  p.lastPo3Idx            = lastPo3Idx;
  p.gridScalperMAHistory  = gridScalperMAHistory;
  p.lastGridScalperMAIdx  = lastGridScalperMAIdx;
  p.fvgStratHistory       = fvgStratHistory;
  p.lastFvgStratIdx       = lastFvgStratIdx;
  p.mtfTopDownHistory     = mtfTopDownHistory;
  p.lastMtfTopDownIdx     = lastMtfTopDownIdx;
  p.sessionRangeAsian   = sessionRangeAsian;
  p.sessionRangeLondon  = sessionRangeLondon;
  p.sessionRangeNY      = sessionRangeNY;
  p.asianRangeTight     = asianRangeTight;
  p.londonSweepSignal   = londonSweepSignal;
  p.sessionRangeTrade   = sessionRangeTrade;
  p.sessionRangeTradeWins   = sessionRangeTradeWins;
  p.sessionRangeTradeLosses = sessionRangeTradeLosses;
  p.sessionRangeHistory = sessionRangeHistory;
  p.lastSessionRangeBuildDate = lastSessionRangeBuildDate;

  /* NY Open Range */
  p.nyOpenRange         = nyOpenRange;
  p.nyOpenRangeBreakout = nyOpenRangeBreakout;
  p.nyOpenRangeRetest   = nyOpenRangeRetest;
  p.nyOpenRangeTrade    = nyOpenRangeTrade;
  p.nyOpenRangePhase    = nyOpenRangePhase;
  p.nyOpenRangeTradeWins   = nyOpenRangeTradeWins;
  p.nyOpenRangeTradeLosses = nyOpenRangeTradeLosses;
  p.nyOpenRangeHistory  = nyOpenRangeHistory;

  /* Save current filter state back to panel */
  p.filters.autoResetEnabled     = autoResetEnabled;
  p.filters.emaFilterEnabled     = emaFilterEnabled;
  p.filters.htfFilterEnabled     = htfFilterEnabled;
  p.filters.atrToleranceEnabled  = atrToleranceEnabled;
  p.filters.trailingStopEnabled  = trailingStopEnabled;
  p.filters.partialTpEnabled     = partialTpEnabled;
  p.filters.falseBreakoutEnabled = falseBreakoutEnabled;
  p.filters.minRREnabled         = minRREnabled;
  p.filters.minRRValue           = minRRValue;
  p.filters.pureTrailingEnabled  = pureTrailingEnabled;
  p.filters.teslaScalingEnabled  = teslaScalingEnabled;
  p.filters.teslaScalingPlan     = teslaScalingPlan;
  p.filters.rsiFilterEnabled     = rsiFilterEnabled;
  p.filters.volumeSpikeEnabled   = volumeSpikeEnabled;
  p.filters.sessionFilterEnabled = sessionFilterEnabled;
  p.filters.sessionFilterMode    = sessionFilterMode;
  p.filters.fibRetestEnabled     = fibRetestEnabled;
  p.filters.macdFilterEnabled      = macdFilterEnabled;
  p.filters.bbSqueezeFilterEnabled = bbSqueezeFilterEnabled;
  p.filters.adxFilterEnabled       = adxFilterEnabled;
  p.filters.stochFilterEnabled     = stochFilterEnabled;
  p.filters.scalpingModeEnabled    = scalpingModeEnabled;
  p.filters.RANGE_MINUTES        = RANGE_MINUTES;
  /* Profit-Direction Constraints */
  p.filters.minConfluenceEnabled    = minConfluenceEnabled;
  p.filters.minConfluenceValue      = minConfluenceValue;
  p.filters.doubleRetestEnabled     = doubleRetestEnabled;
  p.filters.confirmBarEnabled       = confirmBarEnabled;
  p.filters.divergenceFilterEnabled = divergenceFilterEnabled;
  p.filters.adxHardGateEnabled      = adxHardGateEnabled;
  p.filters.adxMaxThreshold         = adxMaxThreshold;
  p.filters.breakoutDistEnabled     = breakoutDistEnabled;
  p.filters.breakoutDistATR         = breakoutDistATR;
  p.filters.timeDecayEnabled        = timeDecayEnabled;
  p.filters.timeDecayCandles        = timeDecayCandles;
  p.filters.consecutiveDirEnabled   = consecutiveDirEnabled;
  p.filters.vwapFilterEnabled       = vwapFilterEnabled;
  p.filters.stochCrossEnabled       = stochCrossEnabled;
  p.filters.rangeSizeEnabled        = rangeSizeEnabled;
  p.filters.rangeSizeMin            = rangeSizeMin;
  p.filters.rangeSizeMax            = rangeSizeMax;
  p.filters.hhhlEnabled             = hhhlEnabled;
  p.filters.followThroughEnabled    = followThroughEnabled;
  p.filters.mtfStructureEnabled     = mtfStructureEnabled;
  /* Reset the "sent via telegram" flag whenever the trade is no longer active,
     so the next TRADE signal (after auto-reset or a new setup) triggers a fresh send. */
  if (phase !== "TRADE") p._tradeTelegramSent = false;
}

/* ---- Get display name for a symbol ---- */
function getSymbolLabel(symbol) {
  /* Try to find it in the main symbol select */
  if (UI.symbolSelect) {
    for (const opt of UI.symbolSelect.options) {
      if (opt.value === symbol) return opt.text;
    }
  }
  /* Fallback: the raw symbol string */
  return symbol;
}

/* ---- Create card DOM for a panel ---- */
function createPanelCard(p) {
  const grid = document.getElementById("multiSymbolGrid");
  if (!grid) return;

  const card = document.createElement("div");
  card.className = "ms-card";
  card.dataset.symbol = p.symbol;
  card.innerHTML = `
    <div class="ms-card-header">
      <span class="ms-card-symbol">${getSymbolLabel(p.symbol)}</span>
      <div class="ms-card-badges">
        <span class="ms-card-phase ms-phase-waiting">WAITING</span>
        <span class="ms-card-dir ms-dir-none">--</span>
      </div>
    </div>
    <canvas class="ms-card-canvas" width="520" height="280"></canvas>
    <div class="ms-card-footer">
      <span class="ms-card-price">--</span>
      <span class="ms-card-action"></span>
      <span class="ms-card-status"><span class="ms-card-dot disconnected"></span> Offline</span>
    </div>
  `;

  p.cardEl   = card;
  p.canvasEl = card.querySelector(".ms-card-canvas");
  p.phaseEl  = card.querySelector(".ms-card-phase");
  p.dirEl    = card.querySelector(".ms-card-dir");
  p.priceEl  = card.querySelector(".ms-card-price");
  p.dotEl    = card.querySelector(".ms-card-dot");
  p.statusTextEl = card.querySelector(".ms-card-status");
  p.actionEl = card.querySelector(".ms-card-action");

  /* Click to focus */
  card.addEventListener("click", () => focusPanel(p.symbol));

  grid.appendChild(card);
}

/* ---- Focus a panel (show in main view) ---- */
function focusPanel(symbol) {
  const p = multiPanels.get(symbol);
  if (!p) return;
  focusedPanelSymbol = symbol;

  /* Update active visual */
  document.querySelectorAll(".ms-card").forEach(c => c.classList.remove("ms-card-active"));
  if (p.cardEl) p.cardEl.classList.add("ms-card-active");

  /* Activate panel state in globals (includes filter settings) */
  activatePanel(p);

  /* Sync the symbol dropdown to match */
  if (UI.symbolSelect) {
    UI.symbolSelect.value = symbol;
    updateCurrentSymbolLabel();
  }

  /* Sync filter checkbox UI to this panel's filter settings */
  syncFilterUIFromGlobals();

  /* Redraw main chart and sidebar */
  updateRecommendedSettings();
  updateStateUI();
  drawChart();
  updateStatsUI();
  renderScalpAlerts();
  renderScalpTickerBanner();
  renderStrategyTickerBanner();
}
/**
 * Sync all filter checkbox / input UI elements from current global filter variables.
 * Called when focusing a panel to reflect that panel's per-symbol settings.
 */
function syncFilterUIFromGlobals() {
  if (UI.emaFilterToggle)     UI.emaFilterToggle.checked     = emaFilterEnabled;
  if (UI.htfFilterToggle)     UI.htfFilterToggle.checked     = htfFilterEnabled;
  if (UI.atrToleranceToggle)  UI.atrToleranceToggle.checked  = atrToleranceEnabled;
  if (UI.trailingStopToggle)  UI.trailingStopToggle.checked  = trailingStopEnabled;
  if (UI.partialTpToggle)     UI.partialTpToggle.checked     = partialTpEnabled;
  if (UI.falseBreakoutToggle) UI.falseBreakoutToggle.checked = falseBreakoutEnabled;
  if (UI.minRRToggle)         UI.minRRToggle.checked         = minRREnabled;
  if (UI.minRRInput)          UI.minRRInput.value            = minRRValue;
  if (UI.pureTrailingToggle)  UI.pureTrailingToggle.checked  = pureTrailingEnabled;
  if (UI.teslaScalingToggle)  UI.teslaScalingToggle.checked  = teslaScalingEnabled;
  if (UI.teslaScalingPlan)    UI.teslaScalingPlan.value      = teslaScalingPlan;
  if (UI.rsiFilterToggle)     UI.rsiFilterToggle.checked     = rsiFilterEnabled;
  if (UI.volumeSpikeToggle)   UI.volumeSpikeToggle.checked   = volumeSpikeEnabled;
  if (UI.sessionFilterToggle) UI.sessionFilterToggle.checked = sessionFilterEnabled;
  if (UI.sessionFilterMode)   UI.sessionFilterMode.value     = sessionFilterMode;
  if (UI.fibRetestToggle)     UI.fibRetestToggle.checked     = fibRetestEnabled;
  if (UI.macdFilterToggle)      UI.macdFilterToggle.checked      = macdFilterEnabled;
  if (UI.bbSqueezeFilterToggle) UI.bbSqueezeFilterToggle.checked = bbSqueezeFilterEnabled;
  if (UI.adxFilterToggle)       UI.adxFilterToggle.checked       = adxFilterEnabled;
  if (UI.stochFilterToggle)     UI.stochFilterToggle.checked     = stochFilterEnabled;
  if (UI.scalpingModeToggle)    UI.scalpingModeToggle.checked    = scalpingModeEnabled;
  if (UI.nyOpenRangeToggle)     UI.nyOpenRangeToggle.checked     = nyOpenRangeEnabled;
  if (UI.rangeDuration)       UI.rangeDuration.value          = RANGE_MINUTES;
  if (UI.autoResetToggle)     UI.autoResetToggle.checked     = autoResetEnabled;
  /* Profit-Direction Constraints */
  if (UI.minConfluenceToggle)    UI.minConfluenceToggle.checked    = minConfluenceEnabled;
  if (UI.minConfluenceInput)     UI.minConfluenceInput.value       = minConfluenceValue;
  if (UI.doubleRetestToggle)     UI.doubleRetestToggle.checked     = doubleRetestEnabled;
  if (UI.confirmBarToggle)       UI.confirmBarToggle.checked       = confirmBarEnabled;
  if (UI.divergenceFilterToggle) UI.divergenceFilterToggle.checked = divergenceFilterEnabled;
  if (UI.adxHardGateToggle)      UI.adxHardGateToggle.checked      = adxHardGateEnabled;
  if (UI.adxMaxInput)            UI.adxMaxInput.value              = adxMaxThreshold;
  if (UI.breakoutDistToggle)     UI.breakoutDistToggle.checked     = breakoutDistEnabled;
  if (UI.breakoutDistInput)      UI.breakoutDistInput.value        = breakoutDistATR;
  if (UI.timeDecayToggle)        UI.timeDecayToggle.checked        = timeDecayEnabled;
  if (UI.timeDecayInput)         UI.timeDecayInput.value           = timeDecayCandles;
  if (UI.consecutiveDirToggle)   UI.consecutiveDirToggle.checked   = consecutiveDirEnabled;
  if (UI.vwapFilterToggle)       UI.vwapFilterToggle.checked       = vwapFilterEnabled;
  if (UI.stochCrossToggle)       UI.stochCrossToggle.checked       = stochCrossEnabled;
  if (UI.rangeSizeToggle)        UI.rangeSizeToggle.checked        = rangeSizeEnabled;
  if (UI.rangeSizeMinInput)      UI.rangeSizeMinInput.value        = rangeSizeMin;
  if (UI.rangeSizeMaxInput)      UI.rangeSizeMaxInput.value        = rangeSizeMax;
  if (UI.hhhlToggle)             UI.hhhlToggle.checked             = hhhlEnabled;
  if (UI.followThroughToggle)    UI.followThroughToggle.checked    = followThroughEnabled;
  if (UI.mtfStructureToggle)     UI.mtfStructureToggle.checked     = mtfStructureEnabled;
}

/**
 * Propagate current Profit-Direction Constraint globals to ALL multi-panels.
 * Called whenever a constraint toggle/input is changed so every chart
 * picks up the new setting immediately and retains it across panel switches.
 */
function syncProfitDirToAllPanels() {
  for (const p of multiPanels.values()) {
    p.filters.minConfluenceEnabled    = minConfluenceEnabled;
    p.filters.minConfluenceValue      = minConfluenceValue;
    p.filters.doubleRetestEnabled     = doubleRetestEnabled;
    p.filters.confirmBarEnabled       = confirmBarEnabled;
    p.filters.divergenceFilterEnabled = divergenceFilterEnabled;
    p.filters.adxHardGateEnabled      = adxHardGateEnabled;
    p.filters.adxMaxThreshold         = adxMaxThreshold;
    p.filters.breakoutDistEnabled     = breakoutDistEnabled;
    p.filters.breakoutDistATR         = breakoutDistATR;
    p.filters.timeDecayEnabled        = timeDecayEnabled;
    p.filters.timeDecayCandles        = timeDecayCandles;
    p.filters.consecutiveDirEnabled   = consecutiveDirEnabled;
    p.filters.vwapFilterEnabled       = vwapFilterEnabled;
    p.filters.stochCrossEnabled       = stochCrossEnabled;
    p.filters.rangeSizeEnabled        = rangeSizeEnabled;
    p.filters.rangeSizeMin            = rangeSizeMin;
    p.filters.rangeSizeMax            = rangeSizeMax;
    p.filters.hhhlEnabled             = hhhlEnabled;
    p.filters.followThroughEnabled    = followThroughEnabled;
    p.filters.mtfStructureEnabled     = mtfStructureEnabled;
  }
}

/* ---- Connect a multi-symbol panel ---- */
function connectPanel(p) {
  if (p.ws && p.ws.readyState <= 1) return;
  if (p.unavailable) return; /* symbol rejected by the API – do not reconnect */
  /* Use per-symbol recommended timeframe from market type recommendations */
  const rec = getMarketRecommendations(p.symbol);
  let gran = rec.timeframe.gran;
  if (lockTimeframe && UI.granSelect) {
    gran = parseInt(UI.granSelect.value, 10) || gran;
  }

  /* Re-apply recommended filters for this symbol's market type */
  p.filters.emaFilterEnabled     = rec.ema;
  p.filters.htfFilterEnabled     = rec.htf;
  p.filters.atrToleranceEnabled  = rec.atr;
  p.filters.trailingStopEnabled  = rec.trailing.rec;
  p.filters.partialTpEnabled     = rec.partialTp;
  p.filters.falseBreakoutEnabled = rec.falseBreakout;
  p.filters.minRREnabled         = rec.minRR.rec;
  p.filters.minRRValue           = lockRR ? minRRValue : rec.rr.minRR;
  p.filters.rsiFilterEnabled     = rec.rsi;
  p.filters.volumeSpikeEnabled   = rec.volSpike.rec;
  p.filters.sessionFilterEnabled = rec.session.rec;
  p.filters.sessionFilterMode    = "london_ny";
  p.filters.fibRetestEnabled     = rec.fib;
  p.filters.macdFilterEnabled      = rec.macd;
  p.filters.bbSqueezeFilterEnabled = rec.bbSqueeze;
  p.filters.adxFilterEnabled       = rec.adx;
  p.filters.stochFilterEnabled     = rec.stoch;
  p.filters.scalpingModeEnabled    = false;
  p.filters.RANGE_MINUTES        = rec.range.minutes;

  /* Reset panel state */
  p.candles = [];
  p.rangeStartEpoch = null;
  p.openingRange = null;
  p.breakout = null;
  p.retestInfo = null;
  p.indecisionInfo = null;
  p.confirmInfo = null;
  p.trade = null;
  p.phase = "WAITING";
  p.monitoringTrade = false;
  p._tradeTelegramSent = false;
  p.emaFast = [];
  p.emaSlow = [];
  p.emaHTF = [];
  p.atrValue = 0;
  p.atrValues = [];
  p.rsiValues = [];
  p.macdLine = []; p.macdSignal = []; p.macdHistogram = [];
  p.bbUpper = []; p.bbLower = []; p.bbMiddle = []; p.bbWidth = [];
  p.adxValue = 0; p.adxDiPlus = 0; p.adxDiMinus = 0;
  p.stochK = []; p.stochD = [];
  p.emaMTF = []; p.vwapValues = [];
  p.retestCount = 0;
  p.trailingSL = null;
  p.partialTpHit = false;
  p.teslaT1Hit = false;
  p.teslaT2Hit = false;
  p.teslaT3Hit = false;
  p.teslaBEHit = false;
  p.confluenceScore = 0;
  p.liveScalpHistory = [];
  p.lastScalpCandleIdx = -999;
  /* Custom strategy histories (per-panel isolation) */
  p.liquiditySweepHistory = [];
  p.lastLiquiditySweepIdx = -999;
  p.stopLossHuntHistory   = [];
  p.lastStopLossHuntIdx   = -999;
  p.failedPinBarHistory   = [];
  p.lastFailedPinBarIdx   = -999;
  p.fibScalpHistory       = [];
  p.lastFibScalpIdx       = -999;
  p.po3History            = [];
  p.lastPo3Idx            = -999;
  p.gridScalperMAHistory  = [];
  p.lastGridScalperMAIdx  = -999;
  p.fvgStratHistory       = [];
  p.lastFvgStratIdx       = -999;
  p.mtfTopDownHistory     = [];
  p.lastMtfTopDownIdx     = -999;
  p.sessionRangeHistory   = [];
  p.connected = false;

  const panelWs = new WebSocket(WS_URL);

  panelWs.onopen = () => {
    if (p.ws !== panelWs) return; /* stale connection */
    p.connected = true;
    p.connectTime = Date.now();
    updatePanelCardUI(p);
    addLog(`[Multi] ${p.symbol} connected`);

    /* Authorize with stored Deriv token to bind live account */
    const token = sessionStorage.getItem(DERIV_TOKEN_KEY) || "";
    if (token) {
      panelWs.send(JSON.stringify({ authorize: token }));
    } else {
      subscribeCandles(panelWs, p.symbol, gran);
    }

    /* Keepalive ping */
    p.pingTimer = setInterval(() => {
      if (panelWs.readyState === WebSocket.OPEN) {
        panelWs.send(JSON.stringify({ ping: 1 }));
      }
    }, PING_INTERVAL_MS);

    /* Start panel stream watchdog */
    startPanelWatchdog(p);
  };

  panelWs.onmessage = (evt) => {
    if (p.ws !== panelWs) return; /* stale connection */
    const msg = JSON.parse(evt.data);
    if (msg.msg_type === "ping" || msg.msg_type === "pong") return;
    if (msg.error) {
      /* Delegate auto-trade errors to the shared handler first */
      if (handleAutoTradeMessage(msg, panelWs)) return;
      addLog(`[Multi] ${p.symbol} API error: ${msg.error.message}`);
      /* If the symbol itself is invalid, mark it unavailable and stop */
      const errCode = msg.error.code || "";
      const errMsg  = msg.error.message || "";
      if (errCode === "InputValidationFailed" || /is invalid/i.test(errMsg) ||
          errCode === "SymbolDoesNotExist"   || /symbol.*not.*found/i.test(errMsg)) {
        p.unavailable = true;
        p.unavailableReason = errMsg || "Symbol not available";
        updatePanelCardUI(p);
        disconnectPanel(p);
        return;
      }
      /* If panel auth fails, still subscribe to data */
      if (msg.msg_type === "authorize") {
        subscribeCandles(panelWs, p.symbol, gran);
      }
      return;
    }

    /* Authorize response – subscribe to candles after successful auth */
    if (msg.msg_type === "authorize") {
      addLog(`[Multi] ${p.symbol} authorized as ${msg.authorize.loginid}`);
      /* Re-subscribe to any in-flight contracts for this panel's symbol */
      const slot = autoTradeSlots.get(p.symbol);
      if (slot && slot.pendingContractId) {
        addLog(`🔄 [Multi] Re-subscribing to contract ${slot.pendingContractId} after reconnect (${p.symbol})…`);
        slot.contractId = slot.pendingContractId;
        slot.inProgress = true;
        slot.pendingContractId = null;
        panelWs.send(JSON.stringify({
          proposal_open_contract: 1,
          contract_id: slot.contractId,
          subscribe: 1,
          passthrough: { auto_trade: true, source: "reconnect", tradeSymbol: p.symbol }
        }));
        startAutoTradePendingTimeout(p.symbol, panelWs);
      }
      subscribeCandles(panelWs, p.symbol, gran);
      return;
    }

    /* Delegate auto-trade messages (proposal, buy, POC, balance) */
    if (handleAutoTradeMessage(msg, panelWs)) {
      /* Still need to save panel state even for non-candle messages,
         since _multiPanelProcessing is not set for these */
      return;
    }

    /* Activate this panel's state into globals */
    _multiPanelProcessing = p.symbol;
    activatePanel(p);

    /* Historical batch */
    if (msg.candles) {
      resetPanelWatchdog(p);
      candles = msg.candles.map(c => ({
        open: +c.open, high: +c.high, low: +c.low, close: +c.close, epoch: c.epoch
      }));
      if (candles.length > 0) rangeStartEpoch = candles[0].epoch;
      computeEMAs();
      processAllCandles();
    }

    /* Streaming OHLC */
    if (msg.ohlc) {
      resetPanelWatchdog(p);
      const o = msg.ohlc;
      const c = {
        open: +o.open, high: +o.high, low: +o.low, close: +o.close, epoch: +o.open_time
      };

      if (candles.length > 0 && candles[candles.length - 1].epoch === c.epoch) {
        candles[candles.length - 1] = c;
      } else {
        candles.push(c);
        if (candles.length > MAX_CANDLE_HISTORY) {
          const removed = candles.length - MAX_CANDLE_HISTORY;
          candles = candles.slice(removed);
          adjustIndicesAfterSlice(removed);
        }
      }

      if (!rangeStartEpoch && candles.length > 0) rangeStartEpoch = candles[0].epoch;

      computeEMAs();
      computeATR();
      computeRSI();
      computeMACD();
      computeBollingerBands();
      computeADX();
      computeStochastic();
      computeEMA200();
      computeVWAP();
      processLatestCandle();
      processLiveScalp();
      processCustomStrategies();
      monitorTradeOutcome(c);
      monitorScalpOutcomes(c);
      monitorCustomStrategyOutcomes(c);
      monitorSessionRangeTradeOutcome(c);
      monitorNyOpenRangeTradeOutcome(c);
    }

    /* Save state back to panel */
    savePanel(p);

    /* Auto-send Telegram for a TRADE signal found during the historical batch.
       processAllCandles() suppressed auto-send via _historicalProcessing=true, so
       we trigger it here — once per trade — for any active, unsent TRADE setup. */
    if (msg.candles && telegramAutoSend && p.phase === "TRADE" && p.trade && !p._tradeTelegramSent) {
      p._tradeTelegramSent = true;
      addLog("📤 Telegram auto-send triggered — active TRADE signal");
      setTimeout(() => sendPanelTelegramAlert(p.symbol), CHART_RENDER_DELAY_MS);
    }

    _multiPanelProcessing = null;

    /* Throttled card DOM update (badges, price, status) */
    const now = Date.now();
    if (!p._lastCardUI || now - p._lastCardUI >= _PANEL_UI_THROTTLE_MS) {
      p._lastCardUI = now;
      updatePanelCardUI(p);
    }

    /* Batch mini-chart redraw into a single animation frame */
    markPanelDirty(p);

    /* If this panel is focused, schedule main-view refresh */
    if (focusedPanelSymbol === p.symbol) {
      _focusedDirty = true;
    }

    /* Schedule aggregated banner / stats refresh (throttled) */
    _bannersDirty = true;
  };

  panelWs.onclose = () => {
    if (p.ws !== panelWs) return; /* stale connection – don't touch panel state */
    if (p.pingTimer) { clearInterval(p.pingTimer); p.pingTimer = null; }
    stopPanelWatchdog(p);
    p.connected = false;
    p.ws = null;
    updatePanelCardUI(p);
    addLog(`[Multi] ${p.symbol} disconnected`);

    /* Clean up per-symbol auto-trade state on panel disconnect.
       Preserve contract IDs for re-subscribe on reconnect. */
    const slot = autoTradeSlots.get(p.symbol);
    if (slot) {
      if (slot.contractId) {
        slot.pendingContractId = slot.contractId;
        addLog(`📌 [Multi] Preserving contract ${slot.contractId} for re-subscribe (${p.symbol})`);
      }
      for (const t of slot.activeTrades) {
        if (t.pendingTimer) { clearTimeout(t.pendingTimer); t.pendingTimer = null; }
      }
      slot.activeTrades = [];
      slot.inProgress = false;
      slot.contractId = null;
    }

    /* Auto-reconnect panel if not intentionally removed */
    if (!p.unavailable && multiPanels.has(p.symbol)) {
      const panelDelay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, (p._reconnectAttempts || 0)), RECONNECT_MAX_DELAY);
      p._reconnectAttempts = (p._reconnectAttempts || 0) + 1;
      if (p._reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
        addLog(`[Multi] ${p.symbol} reconnecting in ${(panelDelay / 1000).toFixed(1)}s (attempt ${p._reconnectAttempts})…`);
        p._reconnectTimer = setTimeout(() => {
          if (multiPanels.has(p.symbol) && !p.ws) {
            p._reconnectAttempts = 0;
            connectPanel(p);
          }
        }, panelDelay);
      } else {
        addLog(`⚠️ [Multi] ${p.symbol} max reconnect attempts reached`);
      }
    }
  };

  panelWs.onerror = () => {
    if (p.ws !== panelWs) return; /* stale connection */
    addLog(`[Multi] ${p.symbol} WebSocket error`);
  };

  p.ws = panelWs;
}

/* ---- Disconnect a multi-symbol panel ---- */
function disconnectPanel(p) {
  if (p.pingTimer) { clearInterval(p.pingTimer); p.pingTimer = null; }
  stopPanelWatchdog(p);
  if (p._reconnectTimer) { clearTimeout(p._reconnectTimer); p._reconnectTimer = null; }
  p._reconnectAttempts = 0;

  /* Clean up per-symbol auto-trade state */
  const slot = autoTradeSlots.get(p.symbol);
  if (slot) {
    clearAutoTradePendingTimeout(p.symbol);
    for (const t of slot.activeTrades) {
      if (t.pendingTimer) { clearTimeout(t.pendingTimer); t.pendingTimer = null; }
    }
    slot.activeTrades = [];
    slot.inProgress = false;
    slot.contractId = null;
    slot.pendingContractId = null;
  }
  /* Resolve any PENDING history entries for this panel's symbol */
  for (const e of autoTradeHistory) {
    if (e.result === "PENDING" && e.symbol === p.symbol) {
      e.result = "CANCELLED";
      e.profit = 0;
    }
  }
  recalcAutoTradePL();
  renderAutoTradeHistory();
  updateAutoTradePLUI();
  persistAutoTradeHistory();

  if (p.ws) {
    const dyingWs = p.ws;
    p.ws = null;
    dyingWs.onopen = dyingWs.onmessage = dyingWs.onclose = dyingWs.onerror = null;
    try {
      if (dyingWs.readyState === WebSocket.OPEN) {
        dyingWs.send(JSON.stringify({ forget_all: "candles" }));
        dyingWs.send(JSON.stringify({ forget_all: "ticks" }));
      }
    } catch (e) { /* ignore */ }
    dyingWs.close();
  }
  p.connected = false;
  updatePanelCardUI(p);
}

/* ---- Update card badges/status ---- */
function updatePanelCardUI(p) {
  /* When the Deriv API has rejected the symbol as invalid, show a distinct N/A state */
  if (p.unavailable) {
    if (p.phaseEl) {
      p.phaseEl.textContent = "N/A";
      p.phaseEl.className = "ms-card-phase ms-phase-waiting";
    }
    if (p.dirEl) {
      p.dirEl.textContent = "--";
      p.dirEl.className = "ms-card-dir ms-dir-none";
    }
    if (p.dotEl) {
      p.dotEl.className = "ms-card-dot disconnected";
    }
    if (p.statusTextEl) {
      p.statusTextEl.innerHTML = `<span class="ms-card-dot disconnected"></span> N/A`;
      p.statusTextEl.title = p.unavailableReason || "Symbol not available on this account";
    }
    if (p.actionEl) {
      p.actionEl.textContent = "";
      p.actionEl.className = "ms-card-action";
    }
    return;
  }
  if (p.phaseEl) {
    p.phaseEl.textContent = p.phase;
    p.phaseEl.className = "ms-card-phase ms-phase-" + p.phase.toLowerCase();
  }
  if (p.dirEl) {
    if (p.breakout) {
      p.dirEl.textContent = p.breakout.dir;
      p.dirEl.className = "ms-card-dir ms-dir-" + p.breakout.dir.toLowerCase();
    } else {
      p.dirEl.textContent = "--";
      p.dirEl.className = "ms-card-dir ms-dir-none";
    }
  }
  if (p.priceEl && p.candles.length > 0) {
    p.priceEl.textContent = fmt(p.candles[p.candles.length - 1].close, 4);
  }
  if (p.dotEl) {
    p.dotEl.className = "ms-card-dot " + (p.connected ? "connected" : "disconnected");
  }
  if (p.statusTextEl) {
    p.statusTextEl.innerHTML = `<span class="ms-card-dot ${p.connected ? "connected" : "disconnected"}"></span> ${p.connected ? "Live" : "Offline"}`;
  }
  /* Recommended action badge — show order type when a trade setup is active */
  if (p.actionEl) {
    const orderType = getPanelOrderType(p);
    if (orderType) {
      p.actionEl.textContent = orderType;
      const isBuy = orderType.startsWith("BUY");
      p.actionEl.className = "ms-card-action ms-action-" + (isBuy ? "buy" : "sell");
    } else {
      p.actionEl.textContent = "";
      p.actionEl.className = "ms-card-action";
    }
  }
}

/**
 * Compute recommended MT5 order type for a panel from its saved state.
 */
function getPanelOrderType(p) {
  if (!p.breakout) return null;
  const currentPrice = p.candles.length > 0 ? p.candles[p.candles.length - 1].close : null;
  if (currentPrice == null) return null;
  const entryLevel = p.trade ? p.trade.entry : p.breakout.level;
  if (p.breakout.dir === "BULL") {
    return entryLevel > currentPrice ? "BUY STOP" : "BUY LIMIT";
  }
  return entryLevel < currentPrice ? "SELL STOP" : "SELL LIMIT";
}

/* ---- Draw mini chart on panel canvas ---- */
function drawMiniChart(p) {
  const canvas = p.canvasEl;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const COLORS = getColors();

  /* High-DPI — cache dimensions to avoid expensive getBoundingClientRect() */
  const dpr = window.devicePixelRatio || 1;
  if (!p._cachedW || !p._cachedH) {
    const rect = canvas.getBoundingClientRect();
    p._cachedW = rect.width;
    p._cachedH = rect.height;
  }
  const W = p._cachedW;
  const H = p._cachedH;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  if (p.candles.length < 2) {
    ctx.fillStyle = "#64748b";
    ctx.font = "12px Arial";
    ctx.textAlign = "center";
    ctx.fillText("Waiting for data…", W / 2, H / 2);
    return;
  }

  const marginLeft = 4, marginRight = 4, marginTop = 6, marginBottom = 6;
  const chartW = W - marginLeft - marginRight;
  const chartH = H - marginTop - marginBottom;

  /* Price range */
  let priceHigh = -Infinity, priceLow = Infinity;
  for (const c of p.candles) {
    if (c.high > priceHigh) priceHigh = c.high;
    if (c.low < priceLow)  priceLow = c.low;
  }
  const pricePad = (priceHigh - priceLow) * 0.05;
  priceHigh += pricePad;
  priceLow  -= pricePad;
  const priceRange = priceHigh - priceLow || 1;

  const cW = Math.max(1.5, chartW / p.candles.length - 0.5);

  function xOf(i) { return marginLeft + (i / p.candles.length) * chartW + cW / 2; }
  function yOf(price) { return marginTop + (1 - (price - priceLow) / priceRange) * chartH; }

  /* Opening range highlight */
  if (p.openingRange) {
    const x1 = xOf(p.openingRange.startIdx) - cW / 2;
    const x2 = xOf(p.openingRange.endIdx) + cW / 2;
    const y1 = yOf(p.openingRange.high);
    const y2 = yOf(p.openingRange.low);
    ctx.fillStyle = COLORS.rangeFill;
    ctx.fillRect(x1, y1, x2 - x1, y2 - y1);

    /* Breakout High / Low horizontal lines */
    const drawMiniHL = (yPos, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(marginLeft, yPos);
      ctx.lineTo(W - marginRight, yPos);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    drawMiniHL(y1, COLORS.breakoutHighLine);
    drawMiniHL(y2, COLORS.breakoutLowLine);
  }

  /* Candles */
  for (let i = 0; i < p.candles.length; i++) {
    const c = p.candles[i];
    const x = xOf(i);
    const isBull = c.close >= c.open;
    const bodyTop = yOf(Math.max(c.open, c.close));
    const bodyBot = yOf(Math.min(c.open, c.close));
    const bodyH = Math.max(1, bodyBot - bodyTop);

    /* Wick */
    ctx.strokeStyle = COLORS.wick;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(x, yOf(c.high));
    ctx.lineTo(x, yOf(c.low));
    ctx.stroke();

    /* Body */
    ctx.fillStyle = isBull ? COLORS.bullCandle : COLORS.bearCandle;
    ctx.fillRect(x - cW / 2, bodyTop, cW, bodyH);
  }

  /* EMA overlays (compact) */
  if (p.emaFast && p.emaFast.length > 0) {
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.7;
    drawMiniEMALine(ctx, p.emaFast, xOf, yOf, COLORS.emaFast);
    drawMiniEMALine(ctx, p.emaSlow, xOf, yOf, COLORS.emaSlow);
    ctx.globalAlpha = 0.4;
    drawMiniEMALine(ctx, p.emaHTF, xOf, yOf, COLORS.emaHTF);
    ctx.globalAlpha = 1;
  }

  /* Trade levels */
  if (p.trade) {
    const drawLine = (price, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.moveTo(marginLeft, yOf(price));
      ctx.lineTo(W - marginRight, yOf(price));
      ctx.stroke();
      ctx.setLineDash([]);
    };
    drawLine(p.trade.entry, COLORS.entryLine);
    drawLine(p.trade.sl, COLORS.slLine);
    if (p.trade.tp != null) drawLine(p.trade.tp, COLORS.tpLine);
  }

  /* Phase watermark */
  if (p.phase !== "WAITING") {
    ctx.save();
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = currentTheme === "light" ? "#000" : "#fff";
    ctx.font = "bold 18px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(p.phase, W / 2, H / 2);
    ctx.restore();
  }
}

function drawMiniEMALine(ctx, emaData, xOf, yOf, color) {
  if (!emaData || emaData.length === 0) return;
  ctx.strokeStyle = color;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < emaData.length; i++) {
    if (emaData[i] == null) continue;
    const x = xOf(i);
    const y = yOf(emaData[i]);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/* ---- Connect all / Disconnect all ---- */
function connectAllPanels() {
  for (const p of multiPanels.values()) {
    connectPanel(p);
  }
}

function disconnectAllPanels() {
  for (const p of multiPanels.values()) {
    disconnectPanel(p);
  }
}

/* ---- Add / remove a symbol panel ---- */
function addSymbolPanel(symbol) {
  symbol = migrateSymbol(symbol);
  if (multiPanels.has(symbol)) return;
  if (multiPanels.size >= MULTI_MAX_PANELS) {
    addLog(`[Multi] Max ${MULTI_MAX_PANELS} panels reached`);
    return;
  }
  const p = createPanelState(symbol);
  multiPanels.set(symbol, p);
  createPanelCard(p);

  /* Show the grid section */
  const section = document.getElementById("multiSymbolSection");
  if (section) section.style.display = "";

  /* Auto-focus the first panel */
  if (multiPanels.size === 1) focusPanel(symbol);

  updateMultiSymbolCount();
}

function removeSymbolPanel(symbol) {
  const p = multiPanels.get(symbol);
  if (!p) return;
  disconnectPanel(p);
  if (p.cardEl) p.cardEl.remove();
  multiPanels.delete(symbol);

  /* Hide grid if no panels remain */
  if (multiPanels.size === 0) {
    const section = document.getElementById("multiSymbolSection");
    if (section) section.style.display = "none";
    focusedPanelSymbol = null;

    /* Clear stale globals so the main UI doesn't keep showing
       data from the just-removed panel */
    candles = []; rangeStartEpoch = null;
    openingRange = null; breakout = null;
    retestInfo = null; indecisionInfo = null; confirmInfo = null;
    trade = null; phase = "WAITING"; monitoringTrade = false;
    emaFast = []; emaSlow = []; emaHTF = [];
    atrValue = 0; atrValues = []; rsiValues = [];
    macdLine = []; macdSignal = []; macdHistogram = [];
    bbUpper = []; bbLower = []; bbMiddle = []; bbWidth = [];
    adxValue = 0; adxDiPlus = 0; adxDiMinus = 0;
    stochK = []; stochD = [];
    trailingSL = null; partialTpHit = false; confluenceScore = 0;
    signalHistory = []; signalWins = 0; signalLosses = 0;
    liveScalpHistory = []; lastScalpCandleIdx = -999;

    /* Refresh the main chart and sidebar so they clear */
    drawChart();
    updateStateUI();
    renderScalpAlerts();
  } else if (focusedPanelSymbol === symbol) {
    /* Focus the first remaining panel */
    const firstKey = multiPanels.keys().next().value;
    focusPanel(firstKey);
  }

  /* Re-render signal banners & stats to drop signals from the removed panel */
  updateSignalBanners();
  updateStatsUI();

  updateMultiSymbolCount();
}

function updateMultiSymbolCount() {
  const el = document.getElementById("multiSymbolCount");
  if (el) el.textContent = `${multiPanels.size} of ${MULTI_MAX_PANELS} selected`;
}

/* ---- Wire multi-symbol picker checkboxes ---- */
function initMultiSymbolPicker() {
  const picker = document.getElementById("multiSymbolPicker");
  if (!picker) return;

  picker.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener("change", () => {
      const sym = cb.dataset.symbol;
      if (cb.checked) {
        addSymbolPanel(sym);
      } else {
        removeSymbolPanel(sym);
      }
    });
  });

  /* Wire Connect All / Disconnect All buttons */
  const connectAllBtn = document.getElementById("connectAllBtn");
  const disconnectAllBtn = document.getElementById("disconnectAllBtn");
  if (connectAllBtn) connectAllBtn.addEventListener("click", connectAllPanels);
  if (disconnectAllBtn) disconnectAllBtn.addEventListener("click", disconnectAllPanels);

  /* Wire Select All / Deselect All buttons */
  const selectAllBtn = document.getElementById("selectAllSymbols");
  const deselectAllBtn = document.getElementById("deselectAllSymbols");
  if (selectAllBtn) {
    selectAllBtn.addEventListener("click", () => {
      const picker = document.getElementById("multiSymbolPicker");
      if (!picker) return;
      picker.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        if (!cb.checked) {
          cb.checked = true;
          addSymbolPanel(cb.dataset.symbol);
        }
      });
    });
  }
  if (deselectAllBtn) {
    deselectAllBtn.addEventListener("click", () => {
      const picker = document.getElementById("multiSymbolPicker");
      if (!picker) return;
      picker.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        if (cb.checked) {
          cb.checked = false;
          removeSymbolPanel(cb.dataset.symbol);
        }
      });
    });
  }
}

/* ================= BOOT ================= */
document.addEventListener("DOMContentLoaded", () => {
 try {
  initUI();
  initLoginGate();
  restoreSettings();
  /* Auto-apply recommended settings on boot so the Active column
     and all filter toggles reflect the current symbol's recommendations */
  applyRecommendedSettings();
  restoreSignalLog();
  restoreSignalHistory();
  initTheme();

  /* Restore stream mode from localStorage before wiring UI */
  try {
    const saved = localStorage.getItem(STREAM_MODE_KEY);
    if (saved !== null) streamMode = JSON.parse(saved) === true;
  } catch (_) { /* ignore */ }

  initKeyboardShortcuts();

  /* Button handlers */
  UI.connectBtn.addEventListener("click", connect);
  UI.disconnectBtn.addEventListener("click", disconnect);
  if (UI.resetSessionBtn) {
    UI.resetSessionBtn.addEventListener("click", () => {
      if (confirm("Reset session? This clears all signals, stats, and log.")) resetSession();
    });
  }

  /* Debounced reconnect on symbol/timeframe change */
  UI.symbolSelect.addEventListener("change", () => { saveSettings(); updateCurrentSymbolLabel(); applyRecommendedSettings(); autoUpdateMultiplier(UI.symbolSelect.value); debouncedReconnect(); });
  UI.granSelect.addEventListener("change",   () => { saveSettings(); updateRecommendedSettings(); debouncedReconnect(); });

  /* Recalculate trade when risk/reward inputs change */
  function onRRChange() {
    saveSettings();
    if (trade && confirmInfo) {
      const c = candles[confirmInfo.candleIdx];
      if (c) {
        buildTrade(c, confirmInfo.candleIdx);
        updateStateUI();
        drawChart();
      }
    }
  }
  UI.riskInput.addEventListener("input", onRRChange);
  UI.rewardInput.addEventListener("input", onRRChange);

  /* Account size & risk % listeners */
  if (UI.accountSizeInput) {
    UI.accountSizeInput.addEventListener("input", () => {
      const v = parseFloat(UI.accountSizeInput.value);
      accountSize = (!isNaN(v) && v > 0) ? v : 0;
      saveSettings();
      updateStateUI();
    });
  }
  if (UI.riskPercentInput) {
    UI.riskPercentInput.addEventListener("input", () => {
      const v = parseFloat(UI.riskPercentInput.value);
      riskPercent = (!isNaN(v) && v > 0) ? v : 0;
      saveSettings();
      updateStateUI();
    });
  }

  /* Auto-trade toggle & stake */
  if (UI.autoTradeToggle) {
    UI.autoTradeToggle.addEventListener("change", () => {
      autoTradeEnabled = UI.autoTradeToggle.checked;
      if (autoTradeEnabled && !authorized) {
        addLog("⚠ Auto-trade enabled but not authorized — trades won't execute until a Deriv token is set");
      }
      updateAutoTradeBalanceVisibility();
      saveSettings();
    });
  }
  if (UI.autoTradeScalpToggle) {
    UI.autoTradeScalpToggle.addEventListener("change", () => {
      autoTradeScalpEnabled = UI.autoTradeScalpToggle.checked;
      if (autoTradeScalpEnabled && !authorized) {
        addLog("⚠ Scalp auto-trade enabled but not authorized — trades won't execute until a Deriv token is set");
      }
      updateAutoTradeBalanceVisibility();
      saveSettings();
    });
  }
  if (UI.autoTradeStrategyToggle) {
    UI.autoTradeStrategyToggle.addEventListener("change", () => {
      autoTradeStrategyEnabled = UI.autoTradeStrategyToggle.checked;
      if (autoTradeStrategyEnabled && !authorized) {
        addLog("⚠ Strategy auto-trade enabled but not authorized — trades won't execute until a Deriv token is set");
      }
      updateAutoTradeBalanceVisibility();
      saveSettings();
    });
  }
  /* Opposite mode toggles */
  if (UI.autoTradeScalpOppositeToggle) {
    UI.autoTradeScalpOppositeToggle.addEventListener("change", () => {
      autoTradeScalpOpposite = UI.autoTradeScalpOppositeToggle.checked;
      addLog(`🔄 Scalp opposite mode: ${autoTradeScalpOpposite ? "ON — signals will be reversed" : "OFF"}`);
      saveSettings();
    });
  }
  if (UI.autoTradeStrategyOppositeToggle) {
    UI.autoTradeStrategyOppositeToggle.addEventListener("change", () => {
      autoTradeStrategyOpposite = UI.autoTradeStrategyOppositeToggle.checked;
      addLog(`🔄 Strategy opposite mode: ${autoTradeStrategyOpposite ? "ON — signals will be reversed" : "OFF"}`);
      saveSettings();
    });
  }
  /* Per-strategy auto-trade sub-toggles */
  const strategySubToggles = [
    { ref: "autoTradeLiquiditySweepToggle", varName: "autoTradeLiquiditySweep", label: "🌊 Liquidity Sweep" },
    { ref: "autoTradeStopLossHuntToggle",   varName: "autoTradeStopLossHunt",   label: "🎯 Stop Loss Hunt" },
    { ref: "autoTradeFailedPinBarToggle",   varName: "autoTradeFailedPinBar",   label: "📌 Failed Pin Bar" },
    { ref: "autoTradeFibScalpToggle",       varName: "autoTradeFibScalp",       label: "📐 Fib Golden Zone" },
    { ref: "autoTradePo3Toggle",            varName: "autoTradePo3",            label: "⚡ Power of 3" },
    { ref: "autoTradeNYOpenRangeToggle",    varName: "autoTradeNYOpenRange",    label: "🕤 NY Open Range" },
    { ref: "autoTradeSessionRangeToggle",   varName: "autoTradeSessionRange",   label: "🌍 Session Range" },
    { ref: "autoTradeGridScalperMAToggle",  varName: "autoTradeGridScalperMA",  label: "🔲 Grid Scalper MA" }
  ];
  for (const t of strategySubToggles) {
    if (UI[t.ref]) {
      UI[t.ref].addEventListener("change", () => {
        /* Dynamic assignment via eval-free pattern: use a lookup object */
        const checked = UI[t.ref].checked;
        switch (t.varName) {
          case "autoTradeLiquiditySweep": autoTradeLiquiditySweep = checked; break;
          case "autoTradeStopLossHunt":   autoTradeStopLossHunt   = checked; break;
          case "autoTradeFailedPinBar":   autoTradeFailedPinBar   = checked; break;
          case "autoTradeFibScalp":       autoTradeFibScalp       = checked; break;
          case "autoTradePo3":            autoTradePo3            = checked; break;
          case "autoTradeNYOpenRange":    autoTradeNYOpenRange    = checked; break;
          case "autoTradeSessionRange":   autoTradeSessionRange   = checked; break;
          case "autoTradeGridScalperMA":  autoTradeGridScalperMA  = checked; break;
        }
        addLog(`🤖 ${t.label} auto-trade: ${checked ? "ON" : "OFF"}`);
        saveSettings();
      });
    }
  }
  if (UI.autoTradeStake) {
    UI.autoTradeStake.addEventListener("input", () => {
      const v = parseFloat(UI.autoTradeStake.value);
      autoTradeStake = (!isNaN(v) && v >= MIN_AUTO_TRADE_STAKE) ? v : 1;
      /* Reset current stake to new base whenever the base is changed */
      autoTradeCurrentStake = Math.max(MIN_AUTO_TRADE_STAKE, autoTradeStake);
      autoTradeWinStreak = 0;
      updateAutoTradeCurrentStakeUI();
      saveSettings();
    });
  }
  if (UI.autoTradeMaxStake) {
    UI.autoTradeMaxStake.addEventListener("input", () => {
      const v = parseFloat(UI.autoTradeMaxStake.value);
      autoTradeMaxStake = (!isNaN(v) && v > 0) ? v : 0;
      saveSettings();
    });
  }
  if (UI.autoTradeSessionTP) {
    UI.autoTradeSessionTP.addEventListener("input", () => {
      const v = parseFloat(UI.autoTradeSessionTP.value);
      autoTradeSessionTP = (!isNaN(v) && v > 0) ? v : 0;
      saveSettings();
    });
  }
  if (UI.autoTradeSessionSL) {
    UI.autoTradeSessionSL.addEventListener("input", () => {
      const v = parseFloat(UI.autoTradeSessionSL.value);
      autoTradeSessionSL = (!isNaN(v) && v > 0) ? v : 0;
      saveSettings();
    });
  }
  if (UI.autoTradeMultiplier) {
    UI.autoTradeMultiplier.addEventListener("input", () => {
      const v = parseInt(UI.autoTradeMultiplier.value, 10);
      if (isNaN(v) || v < 1) {
        autoTradeMultiplier = DEFAULT_AUTO_TRADE_MULTIPLIER;
      } else {
        /* Validate against known valid multipliers for the current symbol */
        const sym = getActiveSymbol();
        const valid = getValidMultipliersForSymbol(sym);
        if (valid && valid.length > 0 && !valid.includes(v)) {
          const corrected = pickBestMultiplier(valid, v);
          autoTradeMultiplier = corrected;
          UI.autoTradeMultiplier.value = corrected;
          addLog(`⚠ Multiplier ×${v} not valid for ${sym} — adjusted to ×${corrected} (valid: ${valid.join(", ")})`);
        } else {
          autoTradeMultiplier = v;
        }
      }
      saveSettings();
    });
  }
  if (UI.maxConcurrentTrades) {
    UI.maxConcurrentTrades.addEventListener("input", () => {
      const v = parseInt(UI.maxConcurrentTrades.value, 10);
      if (isNaN(v) || v < 1) {
        maxConcurrentTrades = DEFAULT_MAX_CONCURRENT_TRADES;
      } else {
        maxConcurrentTrades = Math.min(v, MAX_CONCURRENT_TRADES_LIMIT);
      }
      if (maxConcurrentTrades > 1) {
        addLog(`🔄 Max concurrent trades set to ${maxConcurrentTrades} per symbol — multiple signals can open simultaneously`);
      }
      saveSettings();
    });
  }

  /* Config parameter listeners */
  ["rangeDuration", "touchTolerance", "dojiRatio", "lookbackPeriod"].forEach(id => {
    const el = UI[id];
    if (el) el.addEventListener("change", syncConfigFromUI);
  });

  /* Strategy filter toggle listeners */
  if (UI.autoResetToggle) {
    UI.autoResetToggle.addEventListener("change", () => { autoResetEnabled = UI.autoResetToggle.checked; saveSettings(); });
  }
  if (UI.emaFilterToggle) {
    UI.emaFilterToggle.addEventListener("change", () => { emaFilterEnabled = UI.emaFilterToggle.checked; saveSettings(); updateStateUI(); });
  }
  if (UI.htfFilterToggle) {
    UI.htfFilterToggle.addEventListener("change", () => { htfFilterEnabled = UI.htfFilterToggle.checked; saveSettings(); updateStateUI(); });
  }
  if (UI.atrToleranceToggle) {
    UI.atrToleranceToggle.addEventListener("change", () => { atrToleranceEnabled = UI.atrToleranceToggle.checked; saveSettings(); updateRecommendedSettings(); });
  }
  if (UI.trailingStopToggle) {
    UI.trailingStopToggle.addEventListener("change", () => { trailingStopEnabled = UI.trailingStopToggle.checked; saveSettings(); updateRecommendedSettings(); });
  }
  if (UI.partialTpToggle) {
    UI.partialTpToggle.addEventListener("change", () => { partialTpEnabled = UI.partialTpToggle.checked; saveSettings(); updateStateUI(); drawChart(); });
  }
  if (UI.falseBreakoutToggle) {
    UI.falseBreakoutToggle.addEventListener("change", () => { falseBreakoutEnabled = UI.falseBreakoutToggle.checked; saveSettings(); updateRecommendedSettings(); });
  }
  if (UI.minRRToggle) {
    UI.minRRToggle.addEventListener("change", () => { minRREnabled = UI.minRRToggle.checked; saveSettings(); updateRecommendedSettings(); });
  }
  if (UI.minRRInput) {
    UI.minRRInput.addEventListener("change", () => {
      const v = parseFloat(UI.minRRInput.value);
      if (!isNaN(v) && v > 0) minRRValue = v;
      saveSettings();
      updateRecommendedSettings();
    });
  }
  if (UI.pureTrailingToggle) {
    UI.pureTrailingToggle.addEventListener("change", () => { pureTrailingEnabled = UI.pureTrailingToggle.checked; saveSettings(); updateStateUI(); drawChart(); });
  }
  if (UI.teslaScalingToggle) {
    UI.teslaScalingToggle.addEventListener("change", () => { teslaScalingEnabled = UI.teslaScalingToggle.checked; saveSettings(); drawChart(); });
  }
  if (UI.teslaScalingPlan) {
    UI.teslaScalingPlan.addEventListener("change", () => { teslaScalingPlan = UI.teslaScalingPlan.value; saveSettings(); });
  }
  if (UI.rsiFilterToggle) {
    UI.rsiFilterToggle.addEventListener("change", () => { console.log("Indicator toggle clicked: RSI Filter", UI.rsiFilterToggle.checked); rsiFilterEnabled = UI.rsiFilterToggle.checked; saveSettings(); updateStateUI(); });
  }
  if (UI.volumeSpikeToggle) {
    UI.volumeSpikeToggle.addEventListener("change", () => { volumeSpikeEnabled = UI.volumeSpikeToggle.checked; saveSettings(); updateStateUI(); });
  }
  if (UI.sessionFilterToggle) {
    UI.sessionFilterToggle.addEventListener("change", () => { sessionFilterEnabled = UI.sessionFilterToggle.checked; saveSettings(); updateStateUI(); });
  }
  if (UI.sessionFilterMode) {
    UI.sessionFilterMode.addEventListener("change", () => { sessionFilterMode = UI.sessionFilterMode.value; saveSettings(); updateStateUI(); });
  }
  if (UI.fibRetestToggle) {
    UI.fibRetestToggle.addEventListener("change", () => { fibRetestEnabled = UI.fibRetestToggle.checked; saveSettings(); updateStateUI(); });
  }
  if (UI.macdFilterToggle) {
    UI.macdFilterToggle.addEventListener("change", () => { console.log("Indicator toggle clicked: MACD Filter", UI.macdFilterToggle.checked); macdFilterEnabled = UI.macdFilterToggle.checked; saveSettings(); updateStateUI(); });
  }
  if (UI.bbSqueezeFilterToggle) {
    UI.bbSqueezeFilterToggle.addEventListener("change", () => { console.log("Indicator toggle clicked: Bollinger Bands Squeeze Filter", UI.bbSqueezeFilterToggle.checked); bbSqueezeFilterEnabled = UI.bbSqueezeFilterToggle.checked; saveSettings(); updateStateUI(); });
  }
  if (UI.adxFilterToggle) {
    UI.adxFilterToggle.addEventListener("change", () => { adxFilterEnabled = UI.adxFilterToggle.checked; saveSettings(); updateStateUI(); });
  }
  if (UI.stochFilterToggle) {
    UI.stochFilterToggle.addEventListener("change", () => { console.log("Indicator toggle clicked: Stochastic Filter", UI.stochFilterToggle.checked); stochFilterEnabled = UI.stochFilterToggle.checked; saveSettings(); updateStateUI(); });
  }
  if (UI.scalpingModeToggle) {
    UI.scalpingModeToggle.addEventListener("change", () => { scalpingModeEnabled = UI.scalpingModeToggle.checked; saveSettings(); updateStateUI(); });
  }
  if (UI.nyOpenRangeToggle) {
    UI.nyOpenRangeToggle.addEventListener("change", () => {
      nyOpenRangeEnabled = UI.nyOpenRangeToggle.checked;
      saveSettings();
      if (nyOpenRangeEnabled) {
        startNyOpenRangeTimer();
        resetNyOpenRange();
        nyOpenRangePhase = "WAITING";
        addLog("🕤 NY Open Range strategy enabled — watching for 9:30 AM EST");
        showToast("NY Open Range Enabled", "Watching for 9:30 AM EST to mark the opening range.", "info", 5000);
      } else {
        stopNyOpenRangeTimer();
        resetNyOpenRange();
        addLog("🕤 NY Open Range strategy disabled");
      }
      updateStateUI();
      drawChart();
      updateStrategyBadges();
    });
  }

  /* Session Ranges toggle listener */
  if (UI.sessionRangesToggle) {
    UI.sessionRangesToggle.addEventListener("change", () => {
      sessionRangesEnabled = UI.sessionRangesToggle.checked;
      saveSettings();
      if (sessionRangesEnabled) {
        resetSessionRanges();
        if (candles.length > 0) {
          buildSessionRanges();
          detectLondonAsianSweep();
        }
        addLog("🌍 Session Ranges enabled — tracking Asian, London, NY ranges");
        showToast("Session Ranges Enabled", "Tracking Asian/London/NY session high & low ranges.", "info", 5000);
      } else {
        resetSessionRanges();
        addLog("🌍 Session Ranges disabled");
      }
      updateStateUI();
      drawChart();
      updateStrategyBadges();
    });
  }

  /* Profit-Direction Constraint listeners */
  if (UI.minConfluenceToggle) {
    UI.minConfluenceToggle.addEventListener("change", () => { minConfluenceEnabled = UI.minConfluenceToggle.checked; syncProfitDirToAllPanels(); saveSettings(); updateStateUI(); });
  }
  if (UI.minConfluenceInput) {
    UI.minConfluenceInput.addEventListener("change", () => {
      const v = parseInt(UI.minConfluenceInput.value, 10);
      if (!isNaN(v) && v >= 0 && v <= 16) minConfluenceValue = v;
      UI.minConfluenceInput.value = minConfluenceValue;
      syncProfitDirToAllPanels(); saveSettings();
    });
  }
  if (UI.doubleRetestToggle) {
    UI.doubleRetestToggle.addEventListener("change", () => { doubleRetestEnabled = UI.doubleRetestToggle.checked; syncProfitDirToAllPanels(); saveSettings(); updateStateUI(); });
  }
  if (UI.confirmBarToggle) {
    UI.confirmBarToggle.addEventListener("change", () => { confirmBarEnabled = UI.confirmBarToggle.checked; syncProfitDirToAllPanels(); saveSettings(); updateStateUI(); });
  }
  if (UI.divergenceFilterToggle) {
    UI.divergenceFilterToggle.addEventListener("change", () => { divergenceFilterEnabled = UI.divergenceFilterToggle.checked; syncProfitDirToAllPanels(); saveSettings(); updateStateUI(); });
  }
  if (UI.adxHardGateToggle) {
    UI.adxHardGateToggle.addEventListener("change", () => { adxHardGateEnabled = UI.adxHardGateToggle.checked; syncProfitDirToAllPanels(); saveSettings(); updateStateUI(); });
  }
  if (UI.adxMaxInput) {
    UI.adxMaxInput.addEventListener("change", () => {
      const v = parseInt(UI.adxMaxInput.value, 10);
      if (!isNaN(v) && v >= 25 && v <= 80) adxMaxThreshold = v;
      UI.adxMaxInput.value = adxMaxThreshold;
      syncProfitDirToAllPanels(); saveSettings();
    });
  }
  if (UI.breakoutDistToggle) {
    UI.breakoutDistToggle.addEventListener("change", () => { breakoutDistEnabled = UI.breakoutDistToggle.checked; syncProfitDirToAllPanels(); saveSettings(); updateStateUI(); });
  }
  if (UI.breakoutDistInput) {
    UI.breakoutDistInput.addEventListener("change", () => {
      const v = parseFloat(UI.breakoutDistInput.value);
      if (!isNaN(v) && v >= 1 && v <= 10) breakoutDistATR = v;
      UI.breakoutDistInput.value = breakoutDistATR;
      syncProfitDirToAllPanels(); saveSettings();
    });
  }
  if (UI.timeDecayToggle) {
    UI.timeDecayToggle.addEventListener("change", () => { timeDecayEnabled = UI.timeDecayToggle.checked; syncProfitDirToAllPanels(); saveSettings(); updateStateUI(); });
  }
  if (UI.timeDecayInput) {
    UI.timeDecayInput.addEventListener("change", () => {
      const v = parseInt(UI.timeDecayInput.value, 10);
      if (!isNaN(v) && v >= 5 && v <= 100) timeDecayCandles = v;
      UI.timeDecayInput.value = timeDecayCandles;
      syncProfitDirToAllPanels(); saveSettings();
    });
  }
  if (UI.consecutiveDirToggle) {
    UI.consecutiveDirToggle.addEventListener("change", () => { consecutiveDirEnabled = UI.consecutiveDirToggle.checked; syncProfitDirToAllPanels(); saveSettings(); updateStateUI(); });
  }
  if (UI.vwapFilterToggle) {
    UI.vwapFilterToggle.addEventListener("change", () => { vwapFilterEnabled = UI.vwapFilterToggle.checked; syncProfitDirToAllPanels(); saveSettings(); updateStateUI(); });
  }
  if (UI.stochCrossToggle) {
    UI.stochCrossToggle.addEventListener("change", () => { stochCrossEnabled = UI.stochCrossToggle.checked; syncProfitDirToAllPanels(); saveSettings(); updateStateUI(); });
  }
  if (UI.rangeSizeToggle) {
    UI.rangeSizeToggle.addEventListener("change", () => { rangeSizeEnabled = UI.rangeSizeToggle.checked; syncProfitDirToAllPanels(); saveSettings(); updateStateUI(); });
  }
  if (UI.rangeSizeMinInput) {
    UI.rangeSizeMinInput.addEventListener("change", () => {
      const v = parseFloat(UI.rangeSizeMinInput.value);
      if (!isNaN(v) && v >= 0.1 && v <= 3) rangeSizeMin = v;
      UI.rangeSizeMinInput.value = rangeSizeMin;
      syncProfitDirToAllPanels(); saveSettings();
    });
  }
  if (UI.rangeSizeMaxInput) {
    UI.rangeSizeMaxInput.addEventListener("change", () => {
      const v = parseFloat(UI.rangeSizeMaxInput.value);
      if (!isNaN(v) && v >= 1 && v <= 10) rangeSizeMax = v;
      UI.rangeSizeMaxInput.value = rangeSizeMax;
      syncProfitDirToAllPanels(); saveSettings();
    });
  }
  if (UI.hhhlToggle) {
    UI.hhhlToggle.addEventListener("change", () => { hhhlEnabled = UI.hhhlToggle.checked; syncProfitDirToAllPanels(); saveSettings(); updateStateUI(); });
  }
  if (UI.followThroughToggle) {
    UI.followThroughToggle.addEventListener("change", () => { followThroughEnabled = UI.followThroughToggle.checked; syncProfitDirToAllPanels(); saveSettings(); updateStateUI(); });
  }
  if (UI.mtfStructureToggle) {
    UI.mtfStructureToggle.addEventListener("change", () => { mtfStructureEnabled = UI.mtfStructureToggle.checked; syncProfitDirToAllPanels(); saveSettings(); updateStateUI(); });
  }
  if (UI.appIdInput) {
    UI.appIdInput.addEventListener("change", () => {
      const val = parseInt(UI.appIdInput.value, 10);
      if (!isNaN(val) && val > 0) {
        APP_ID = val;
        updateWsUrl();
        saveSettings();
        addLog(`API App ID changed to ${APP_ID}. Reconnect to apply.`);
      } else {
        UI.appIdInput.value = APP_ID;
      }
    });
  }
  if (UI.derivTokenInput) {
    /* Capture OAuth token from URL redirect (Deriv OAuth flow) */
    if (typeof DerivWsUtils !== "undefined") {
      const captured = DerivWsUtils.captureOAuthToken({ storageKey: DERIV_TOKEN_KEY, logger: addLog });
      if (captured && captured.accessToken) {
        UI.derivTokenInput.value = captured.accessToken;
        addLog("✅ Deriv account connected via OAuth. Reconnect to apply.");
      }
    }

    /* Restore saved token into the input */
    const savedToken = sessionStorage.getItem(DERIV_TOKEN_KEY) || "";
    if (savedToken && !UI.derivTokenInput.value) UI.derivTokenInput.value = savedToken;

    UI.derivTokenInput.addEventListener("change", () => {
      const token = UI.derivTokenInput.value.trim();
      if (token) {
        sessionStorage.setItem(DERIV_TOKEN_KEY, token);
        localStorage.removeItem("itguru_deriv_token");
        addLog("Deriv API token updated for this session only. Reconnect to apply.");
      } else {
        sessionStorage.removeItem(DERIV_TOKEN_KEY);
        localStorage.removeItem("itguru_deriv_token");
        addLog("Deriv API token cleared.");
      }
      updateDerivStatus();
    });
  }

  /* ── Deriv OAuth login / disconnect buttons ── */
  updateDerivStatus();

  const derivLoginBtn = document.getElementById("derivLoginBtn");
  if (derivLoginBtn) {
    derivLoginBtn.addEventListener("click", () => {
      if (typeof DerivWsUtils === "undefined") {
        addLog("⚠ DerivWsUtils not loaded — cannot start OAuth flow.");
        return;
      }
      const redirectUri = location.origin + location.pathname;
      const url = DerivWsUtils.buildOAuthUrl({ appId: APP_ID, redirectUri, responseType: "token" });
      location.href = url;
    });
  }

  const derivDisconnectBtn = document.getElementById("derivDisconnectBtn");
  if (derivDisconnectBtn) {
    derivDisconnectBtn.addEventListener("click", () => {
      sessionStorage.removeItem(DERIV_TOKEN_KEY);
      localStorage.removeItem("itguru_deriv_token");
      if (UI.derivTokenInput) UI.derivTokenInput.value = "";
      updateDerivStatus();
      addLog("Deriv account disconnected.");
    });
  }

  if (UI.revertSettingsBtn) {
    UI.revertSettingsBtn.addEventListener("click", () => { revertAllSettings(); });
  }
  /* Live Scalp Scanner listeners */
  if (UI.liveScalpToggle) {
    UI.liveScalpToggle.addEventListener("change", () => {
      liveScalpEnabled = UI.liveScalpToggle.checked;
      saveSettings();
      if (!liveScalpEnabled && UI.scalpAlertBanner) UI.scalpAlertBanner.classList.remove("scalp-banner-show");
      drawChart();
      updateStrategyBadges();
    });
  }
  if (UI.liveScalpMinConf) {
    UI.liveScalpMinConf.addEventListener("change", () => {
      liveScalpMinConf = Math.max(1, Math.min(7, parseInt(UI.liveScalpMinConf.value, 10) || 3));
      UI.liveScalpMinConf.value = liveScalpMinConf;
      saveSettings();
    });
  }
  if (UI.autoApplyRecToggle) {
    UI.autoApplyRecToggle.addEventListener("change", () => {
      autoApplyRecommended = UI.autoApplyRecToggle.checked;
      saveSettings();
      if (autoApplyRecommended) applyRecommendedSettings();
    });
  }

  /* Lock Timeframe / R:R listeners */
  if (UI.lockTimeframeToggle) {
    UI.lockTimeframeToggle.addEventListener("change", () => {
      lockTimeframe = UI.lockTimeframeToggle.checked;
      saveSettings();
    });
  }
  if (UI.lockRRToggle) {
    UI.lockRRToggle.addEventListener("change", () => {
      lockRR = UI.lockRRToggle.checked;
      saveSettings();
    });
  }
  if (UI.lockIndicatorFiltersToggle) {
    UI.lockIndicatorFiltersToggle.addEventListener("change", () => {
      lockIndicatorFilters = UI.lockIndicatorFiltersToggle.checked;
      saveSettings();
      if (lockIndicatorFilters) {
        showToast("Indicator Filters Locked 🔒", "Strategy filter states are now locked — symbol changes won't override them.", "info", 4000);
      } else {
        showToast("Indicator Filters Unlocked 🔓", "Strategy filters will now update automatically on symbol change.", "info", 3000);
      }
    });
  }

  /* Strategy 1: Liquidity Sweep listener */
  if (UI.liquiditySweepToggle) {
    UI.liquiditySweepToggle.addEventListener("change", () => {
      liquiditySweepEnabled = UI.liquiditySweepToggle.checked;
      saveSettings();
      if (liquiditySweepEnabled) {
        addLog("🌊 Liquidity Sweep strategy enabled — scanning for range sweep patterns");
        showToast("Liquidity Sweep Enabled", "Scanning for 15m→1m liquidity sweep patterns.", "info", 5000);
      } else {
        addLog("🌊 Liquidity Sweep strategy disabled");
      }
      drawChart();
      updateStrategyBadges();
    });
  }

  /* Strategy 2: Stop Loss Hunt listener */
  if (UI.stopLossHuntToggle) {
    UI.stopLossHuntToggle.addEventListener("change", () => {
      stopLossHuntEnabled = UI.stopLossHuntToggle.checked;
      saveSettings();
      if (stopLossHuntEnabled) {
        addLog("🎯 Stop Loss Hunt strategy enabled — scanning for stop hunts at key S/R levels");
        showToast("Stop Loss Hunt Enabled", "Scanning for stop loss hunts at key support/resistance.", "info", 5000);
      } else {
        addLog("🎯 Stop Loss Hunt strategy disabled");
      }
      drawChart();
      updateStrategyBadges();
    });
  }

  /* Strategy 3: Failed Pin Bar listener */
  if (UI.failedPinBarToggle) {
    UI.failedPinBarToggle.addEventListener("change", () => {
      failedPinBarEnabled = UI.failedPinBarToggle.checked;
      saveSettings();
      if (failedPinBarEnabled) {
        addLog("📌 Failed Pin Bar strategy enabled — scanning for pin bar failures in fear/greed");
        showToast("Failed Pin Bar Enabled", "Scanning for pin bar failures against market fear/greed.", "info", 5000);
      } else {
        addLog("📌 Failed Pin Bar strategy disabled");
      }
      drawChart();
      updateStrategyBadges();
    });
  }

  /* Strategy 4: Fib Golden Zone Scalp listener */
  if (UI.fibScalpToggle) {
    UI.fibScalpToggle.addEventListener("change", () => {
      fibScalpEnabled = UI.fibScalpToggle.checked;
      saveSettings();
      if (fibScalpEnabled) {
        addLog("📐 Fib Golden Zone Scalp strategy enabled — scanning for 0.5–0.618 retracement entries");
        showToast("Fib Golden Zone Enabled", "Scanning for micro-trend → break of structure → golden zone retracement entries.", "info", 5000);
      } else {
        addLog("📐 Fib Golden Zone Scalp strategy disabled");
      }
      drawChart();
      updateStrategyBadges();
    });
  }

  /* Strategy 5: Power of 3 (ICT) listener */
  if (UI.po3Toggle) {
    UI.po3Toggle.addEventListener("change", () => {
      po3Enabled = UI.po3Toggle.checked;
      saveSettings();
      if (po3Enabled) {
        addLog("⚡ Power of 3 strategy enabled — scanning for Accumulation → Manipulation → Expansion setups");
        showToast("Power of 3 Enabled", "Scanning for 1H open → liquidity sweep → MSS with FVG → entry on retrace.", "info", 5000);
      } else {
        addLog("⚡ Power of 3 strategy disabled");
      }
      drawChart();
      updateStrategyBadges();
    });
  }
  if (UI.po3FreshnessMode) {
    UI.po3FreshnessMode.addEventListener("change", () => {
      po3EntryMaxAge = _normalizePo3EntryMaxAge(UI.po3FreshnessMode.value);
      UI.po3FreshnessMode.value = String(po3EntryMaxAge);
      saveSettings();
      addLog(`⚡ PO3 freshness updated — ${po3EntryMaxAge === 0 ? "strict (0-candle)" : "safe (1-candle)"} mode`);
    });
  }

  /* Strategy 8: Grid Scalper MA listeners.
     Isolated in its own try/catch so a failure here (this is one of the
     most frequently modified features) cannot silently prevent the
     EMA / Orderblock toggles and the Public Market Feed buttons wired
     further below from ever receiving their click handlers. */
  try {
    if (UI.gridScalperMAToggle) {
      UI.gridScalperMAToggle.addEventListener("change", () => {
        gridScalperMAEnabled = UI.gridScalperMAToggle.checked;
        saveSettings();
        if (gridScalperMAEnabled) {
          const modeLabel = gridScalperMAStrategy === "bos" ? "BOS" : "Price vs MA";
          addLog(`🔲 Grid Scalper MA strategy enabled [${modeLabel}] — MA period: ${gridScalperMAPeriod}`);
          showToast("Grid Scalper MA Enabled", `Scanning with ${modeLabel} signal mode.`, "info", 5000);
        } else {
          addLog("🔲 Grid Scalper MA strategy disabled");
        }
        drawChart();
        updateStrategyBadges();
      });
    }
    if (UI.gridScalperMAStrategySelect) {
      UI.gridScalperMAStrategySelect.addEventListener("change", () => {
        gridScalperMAStrategy = UI.gridScalperMAStrategySelect.value;
        _updateGridScalperMAPeriodVisibility();
        saveSettings();
      });
    }
    if (UI.gridScalperMAPeriodInput) {
      UI.gridScalperMAPeriodInput.addEventListener("change", () => {
        const v = parseInt(UI.gridScalperMAPeriodInput.value, 10);
        if (!isNaN(v) && v >= 2 && v <= 200) gridScalperMAPeriod = v;
        UI.gridScalperMAPeriodInput.value = gridScalperMAPeriod;
        saveSettings();
      });
    }
    if (UI.autoTradeGridScalperMAToggle) {
      UI.autoTradeGridScalperMAToggle.addEventListener("change", () => {
        autoTradeGridScalperMA = UI.autoTradeGridScalperMAToggle.checked;
        saveSettings();
      });
    }
  } catch (err) {
    console.error("Grid Scalper MA controls failed to initialize:", err);
  }

  /* Strategy 9: Fair Value Gap (FVG) listener */
  if (UI.fvgStratToggle) {
    UI.fvgStratToggle.addEventListener("change", () => {
      fvgStratEnabled = UI.fvgStratToggle.checked;
      saveSettings();
      if (fvgStratEnabled) {
        addLog("🎯 Fair Value Gap strategy enabled — scanning for big-push origin zones at discount levels");
        showToast("Fair Value Gap Enabled", "Scanning for demand/supply zones at Fibonacci discounts with FVG confluence.", "info", 5000);
      } else {
        addLog("🎯 Fair Value Gap strategy disabled");
      }
      drawChart();
      updateStrategyBadges();
    });
  }
  if (UI.autoTradeFvgStratToggle) {
    UI.autoTradeFvgStratToggle.addEventListener("change", () => {
      autoTradeFvgStrat = UI.autoTradeFvgStratToggle.checked;
      saveSettings();
    });
  }
  /* Strategy 11: MTF Top-Down listener */
  if (UI.mtfTopDownToggle) {
    UI.mtfTopDownToggle.addEventListener("change", () => {
      mtfTopDownEnabled = UI.mtfTopDownToggle.checked;
      saveSettings();
      if (mtfTopDownEnabled) {
        addLog("\u23f1 MTF Top-Down strategy enabled \u2014 scanning for multi-timeframe bias + retest entries");
        showToast("MTF Top-Down Enabled", "Scanning for 4H bias + 1H setup + retest entry patterns.", "info", 5000);
      } else {
        addLog("\u23f1 MTF Top-Down strategy disabled");
      }
      drawChart();
      updateStrategyBadges();
    });
  }
  if (UI.autoTradeMtfTopDownToggle) {
    UI.autoTradeMtfTopDownToggle.addEventListener("change", () => {
      autoTradeMtfTopDown = UI.autoTradeMtfTopDownToggle.checked;
      saveSettings();
    });
  }
  if (UI.telegramBotToken) {
    UI.telegramBotToken.addEventListener("input", () => { telegramBotToken = UI.telegramBotToken.value; });
    UI.telegramBotToken.addEventListener("change", saveSettings);
  }
  if (UI.telegramChatId) {
    UI.telegramChatId.addEventListener("input", () => { telegramChatId = UI.telegramChatId.value; });
    UI.telegramChatId.addEventListener("change", saveSettings);
  }
  if (UI.telegramAutoSendToggle) {
    UI.telegramAutoSendToggle.addEventListener("change", () => { telegramAutoSend = UI.telegramAutoSendToggle.checked; saveSettings(); });
  }
  if (UI.telegramScalpAutoSendToggle) {
    UI.telegramScalpAutoSendToggle.addEventListener("change", () => { telegramScalpAutoSend = UI.telegramScalpAutoSendToggle.checked; saveSettings(); });
  }
  if (UI.telegramOutcomeSendToggle) {
    UI.telegramOutcomeSendToggle.addEventListener("change", () => { telegramOutcomeSend = UI.telegramOutcomeSendToggle.checked; saveSettings(); });
  }
  if (UI.telegramScalpOutcomeSendToggle) {
    UI.telegramScalpOutcomeSendToggle.addEventListener("change", () => { telegramScalpOutcomeSend = UI.telegramScalpOutcomeSendToggle.checked; saveSettings(); });
  }
  if (UI.telegramSessionRangeAutoSendToggle) {
    UI.telegramSessionRangeAutoSendToggle.addEventListener("change", () => { telegramSessionRangeAutoSend = UI.telegramSessionRangeAutoSendToggle.checked; saveSettings(); });
  }
  if (UI.telegramSessionRangeOutcomeSendToggle) {
    UI.telegramSessionRangeOutcomeSendToggle.addEventListener("change", () => { telegramSessionRangeOutcomeSend = UI.telegramSessionRangeOutcomeSendToggle.checked; saveSettings(); });
  }
  if (UI.telegramStrategyAutoSendToggle) {
    UI.telegramStrategyAutoSendToggle.addEventListener("change", () => { telegramStrategyAutoSend = UI.telegramStrategyAutoSendToggle.checked; saveSettings(); });
  }
  if (UI.telegramStrategyOutcomeSendToggle) {
    UI.telegramStrategyOutcomeSendToggle.addEventListener("change", () => { telegramStrategyOutcomeSend = UI.telegramStrategyOutcomeSendToggle.checked; saveSettings(); });
  }
  if (UI.telegramProfitExitAlertToggle) {
    UI.telegramProfitExitAlertToggle.addEventListener("change", () => { telegramProfitExitAlertEnabled = UI.telegramProfitExitAlertToggle.checked; saveSettings(); });
  }
  if (UI.telegramSendNowBtn) {
    UI.telegramSendNowBtn.addEventListener("click", () => sendTelegramAlert());
  }

  /* Manual send: latest Live Scalp signal → Telegram (bypasses auto-send toggle) */
  if (UI.telegramSendScalpNowBtn) {
    UI.telegramSendScalpNowBtn.addEventListener("click", () => {
      const history = getAggregatedScalpHistory();
      if (!history.length) {
        showToast("⚡ No Live Scalp Signal", "No live scalp signal has fired yet. Enable Live Scalp Scanner in Settings and wait for a setup.", "warning");
        return;
      }
      sendTelegramScalpAlert(history[0], true);
    });
  }

  /* Manual send: latest Strategy signal → Telegram (bypasses auto-send toggle) */
  if (UI.telegramSendStrategyNowBtn) {
    UI.telegramSendStrategyNowBtn.addEventListener("click", () => {
      /* Use getAggregatedStrategyHistory() so multi-panel signals from non-focused
         panels are included — reading globals directly would only see the focused
         panel's history after activatePanel() overwrites the globals. */
      const allSignals = getAggregatedStrategyHistory();
      const latest = allSignals.length > 0 ? allSignals[0] : null;
      if (!latest) {
        showToast("🧠 No Strategy Signal", "No strategy signal has fired yet. Enable a strategy and wait for a setup.", "warning");
        return;
      }
      sendTelegramStrategyAlert(latest, true);
    });
  }

  /* Telegram test connection */
  const telegramTestBtn = document.getElementById("telegramTestBtn");
  if (telegramTestBtn) {
    telegramTestBtn.addEventListener("click", () => testTelegramConnection());
  }

  /* Telegram show/hide bot token toggle */
  const telegramShowTokenBtn = document.getElementById("telegramShowToken");
  if (telegramShowTokenBtn && UI.telegramBotToken) {
    telegramShowTokenBtn.addEventListener("click", () => {
      const isPassword = UI.telegramBotToken.type === "password";
      UI.telegramBotToken.type = isPassword ? "text" : "password";
      telegramShowTokenBtn.textContent = isPassword ? "🙈" : "👁️";
      telegramShowTokenBtn.title = isPassword ? "Hide token" : "Show token";
    });
  }

  updateTelegramDeliveryHud();

  /* Tool buttons */
  if (UI.exportBtn) UI.exportBtn.addEventListener("click", exportSignalsCSV);
  UI.exportPdfBtn = document.getElementById("exportPdfBtn");
  if (UI.exportPdfBtn) UI.exportPdfBtn.addEventListener("click", exportSignalsPDF);
  if (UI.themeToggleBtn) UI.themeToggleBtn.addEventListener("click", toggleTheme);
  if (UI.soundToggleBtn) {
    UI.soundToggleBtn.textContent = soundEnabled ? "🔊 Sound ON" : "🔇 Sound OFF";
    UI.soundToggleBtn.addEventListener("click", () => {
      soundEnabled = !soundEnabled;
      UI.soundToggleBtn.textContent = soundEnabled ? "🔊 Sound ON" : "🔇 Sound OFF";
      saveSettings();
    });
  }
  if (UI.notifToggleBtn) {
    UI.notifToggleBtn.textContent = notificationsEnabled ? "🔔 Notif ON" : "🔕 Notif OFF";
    UI.notifToggleBtn.addEventListener("click", () => {
      notificationsEnabled = !notificationsEnabled;
      if (notificationsEnabled) requestNotificationPermission();
      UI.notifToggleBtn.textContent = notificationsEnabled ? "🔔 Notif ON" : "🔕 Notif OFF";
      saveSettings();
    });
  }
  if (UI.streamModeBtn) UI.streamModeBtn.addEventListener("click", toggleStreamMode);
  /* Apply stream mode visuals now that the button is in the DOM */
  applyStreamMode();

  /* EMA toggle */
  if (UI.emaToggle) {
    UI.emaToggle.addEventListener("change", () => { console.log("Indicator toggle clicked: EMA", UI.emaToggle.checked); saveSettings(); drawChart(); });
  }

  /* Symbol nav buttons */
  if (UI.prevSymbolBtn) UI.prevSymbolBtn.addEventListener("click", () => cycleSymbol(-1));
  if (UI.nextSymbolBtn) UI.nextSymbolBtn.addEventListener("click", () => cycleSymbol(1));
  updateCurrentSymbolLabel();

  /* ---- Chart crosshair + OHLC tooltip mouse tracking ---- */
  if (UI.canvas) {
    UI.canvas.style.cursor = "crosshair";
    UI.canvas.addEventListener("mousemove", (e) => {
      const rect = UI.canvas.getBoundingClientRect();
      chartMouseX = e.clientX - rect.left;
      chartMouseY = e.clientY - rect.top;
      chartMouseActive = true;
      debouncedDrawChart(); /* Use debounced version for mouse movements */
    });
    UI.canvas.addEventListener("mouseleave", () => {
      chartMouseActive = false;
      chartMouseX = -1;
      chartMouseY = -1;
      debouncedDrawChart(); /* Use debounced version for mouse movements */
    });
  }

  /* Resize redraw */
  window.addEventListener("resize", () => {
    debouncedDrawChart(); /* Use debounced version for resize events */
    /* Invalidate cached canvas sizes and redraw all multi-symbol mini-charts */
    for (const p of multiPanels.values()) {
      p._cachedW = null;
      p._cachedH = null;
      drawMiniChart(p);
    }
  });

  /* Nav highlight */
  document.querySelectorAll(".bot-links a").forEach(link => {
    if (link.href === window.location.href) {
      link.style.background = "#1e293b";
      link.style.color = "#38bdf8";
    }
  });

  /* Collapsible sections */
  document.querySelectorAll(".collapsible").forEach(el => {
    const body = el.nextElementSibling;
    /* Keep the header's arrow indicator in sync with the body's initial state */
    if (body && body.classList.contains("open")) el.classList.add("open");
    el.addEventListener("click", () => {
      if (body) body.classList.toggle("open");
      el.classList.toggle("open");
    });
  });

  /* Multi-symbol picker */
  initMultiSymbolPicker();

  /* ---- Feature initialisation ---- */
  loadProfiles();
  renderProfilesList();
  loadSignalNotes();
  loadConfluenceStats();

  /* Feature 2: Orderblock toggle */
  if (UI.orderblockToggle) {
    UI.orderblockToggle.checked = orderblockEnabled;
    UI.orderblockToggle.addEventListener("change", () => {
      console.log("Indicator toggle clicked: Orderblock", UI.orderblockToggle.checked);
      orderblockEnabled = UI.orderblockToggle.checked;
      saveSettings(); drawChart(); updateStrategyBadges();
    });
  }
  if (UI.autoTradeOrderblockToggle) {
    UI.autoTradeOrderblockToggle.checked = autoTradeOrderblock;
    UI.autoTradeOrderblockToggle.addEventListener("change", () => { autoTradeOrderblock = UI.autoTradeOrderblockToggle.checked; saveSettings(); });
  }

  /* Feature 17: Session heatmap */
  if (UI.sessionHeatmapToggle) {
    UI.sessionHeatmapToggle.checked = sessionHeatmapEnabled;
    UI.sessionHeatmapToggle.addEventListener("change", () => { sessionHeatmapEnabled = UI.sessionHeatmapToggle.checked; saveSettings(); drawChart(); });
  }

  /* Feature 6: Candle annotations */
  if (UI.candleAnnotationsToggle) {
    UI.candleAnnotationsToggle.checked = candleAnnotationsEnabled;
    UI.candleAnnotationsToggle.addEventListener("change", () => { candleAnnotationsEnabled = UI.candleAnnotationsToggle.checked; saveSettings(); drawChart(); });
  }

  /* Feature 9: Volume profile */
  if (UI.volumeProfileToggle) {
    UI.volumeProfileToggle.checked = volumeProfileEnabled;
    UI.volumeProfileToggle.addEventListener("change", () => { volumeProfileEnabled = UI.volumeProfileToggle.checked; saveSettings(); drawChart(); });
  }

  /* Feature 10: Fib extensions */
  if (UI.fibExtensionsToggle) {
    UI.fibExtensionsToggle.checked = fibExtensionsEnabled;
    UI.fibExtensionsToggle.addEventListener("change", () => { fibExtensionsEnabled = UI.fibExtensionsToggle.checked; saveSettings(); drawChart(); });
  }

  /* Feature 5: BOS/ChoCH */
  if (UI.bosChochToggle) {
    UI.bosChochToggle.checked = bosChochEnabled;
    UI.bosChochToggle.addEventListener("change", () => {
      bosChochEnabled = UI.bosChochToggle.checked;
      if (bosChochEnabled) detectBosChoch();
      else bosChochMarkers = [];
      saveSettings(); drawChart();
    });
  }

  /* Feature 7: Divergence visual */
  if (UI.divergenceVisualToggle) {
    UI.divergenceVisualToggle.checked = divergenceVisualEnabled;
    UI.divergenceVisualToggle.addEventListener("change", () => { divergenceVisualEnabled = UI.divergenceVisualToggle.checked; buildDivergenceMarkers(); saveSettings(); drawChart(); });
  }

  /* Feature 11: News pause */
  if (UI.newsPauseToggle) {
    UI.newsPauseToggle.checked = newsPauseEnabled;
    UI.newsPauseToggle.addEventListener("change", () => {
      newsPauseEnabled = UI.newsPauseToggle.checked;
      if (newsPauseEnabled) fetchNewsCalendar();
      saveSettings();
    });
  }
  if (UI.newsPauseMinutesInput) {
    UI.newsPauseMinutesInput.value = newsPauseMinutes;
    UI.newsPauseMinutesInput.addEventListener("change", () => {
      const v = parseInt(UI.newsPauseMinutesInput.value, 10);
      if (!isNaN(v) && v >= 1 && v <= 60) newsPauseMinutes = v;
      UI.newsPauseMinutesInput.value = newsPauseMinutes;
      saveSettings();
    });
  }

  /* Feature 15: Multi-R ladder */
  if (UI.multiRLadderToggle) {
    UI.multiRLadderToggle.checked = multiRLadderEnabled;
    UI.multiRLadderToggle.addEventListener("change", () => { multiRLadderEnabled = UI.multiRLadderToggle.checked; saveSettings(); });
  }

  /* Feature 13: Adaptive confluence */
  if (UI.adaptiveConfluenceToggle) {
    UI.adaptiveConfluenceToggle.checked = adaptiveConfluenceEnabled;
    UI.adaptiveConfluenceToggle.addEventListener("change", () => {
      adaptiveConfluenceEnabled = UI.adaptiveConfluenceToggle.checked;
      saveSettings();
      renderAdaptiveConfluenceTable();
    });
  }

  /* Feature 4: Profile save button */
  const profileSaveBtn = document.getElementById("profileSaveBtn");
  if (profileSaveBtn) {
    profileSaveBtn.addEventListener("click", () => {
      const nameInput = document.getElementById("profileNameInput");
      if (nameInput) { saveProfile(nameInput.value); nameInput.value = ""; }
    });
  }

  /* Feature 1: Backtest controls */
  const backtestStartBtn = document.getElementById("backtestStartBtn");
  const backtestStopBtn  = document.getElementById("backtestStopBtn");
  if (backtestStartBtn) backtestStartBtn.addEventListener("click", startBacktest);
  if (backtestStopBtn)  backtestStopBtn.addEventListener("click", stopBacktest);
  if (UI.backtestSpeedInput) {
    UI.backtestSpeedInput.value = backtestSpeedMs;
    UI.backtestSpeedInput.addEventListener("change", () => {
      const v = parseInt(UI.backtestSpeedInput.value, 10);
      if (!isNaN(v) && v >= BACKTEST_MIN_SPEED_MS && v <= BACKTEST_MAX_SPEED_MS) backtestSpeedMs = v;
      UI.backtestSpeedInput.value = backtestSpeedMs;
    });
  }

  /* Feature 8: Scanner toggle */
  if (UI.scannerToggle) {
    UI.scannerToggle.checked = scannerEnabled;
    UI.scannerToggle.addEventListener("change", () => {
      scannerEnabled = UI.scannerToggle.checked;
      const panel = document.getElementById("scannerPanel");
      if (panel) panel.style.display = scannerEnabled ? "block" : "none";
      saveSettings();
      updateScannerUI();
    });
  }
  if (UI.scannerSymbolPicker) {
    UI.scannerSymbolPicker.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener("change", () => {
        const sym = cb.dataset.symbol;
        if (cb.checked) {
          if (!scannerSymbols.includes(sym)) scannerSymbols.push(sym);
        } else {
          scannerSymbols = scannerSymbols.filter(s => s !== sym);
        }
        updateScannerSymbolCount();
        saveSettings();
        updateScannerUI();
      });
    });

    const selectAllScanner = document.getElementById("selectAllScannerSymbols");
    const deselectAllScanner = document.getElementById("deselectAllScannerSymbols");
    if (selectAllScanner) {
      selectAllScanner.addEventListener("click", () => {
        UI.scannerSymbolPicker.querySelectorAll('input[type="checkbox"]').forEach(cb => {
          cb.checked = true;
          if (!scannerSymbols.includes(cb.dataset.symbol)) scannerSymbols.push(cb.dataset.symbol);
        });
        updateScannerSymbolCount();
        saveSettings();
        updateScannerUI();
      });
    }
    if (deselectAllScanner) {
      deselectAllScanner.addEventListener("click", () => {
        UI.scannerSymbolPicker.querySelectorAll('input[type="checkbox"]').forEach(cb => {
          cb.checked = false;
        });
        scannerSymbols = [];
        updateScannerSymbolCount();
        saveSettings();
        updateScannerUI();
      });
    }
  }

  /* Fetch news calendar on load if enabled */
  if (newsPauseEnabled) fetchNewsCalendar();

  /* ── Public Market Feed controls ──
     Wrapped in its own try/catch: this is the most recently added
     integration (public Deriv WS feed) and the notice banner on the page
     explicitly states these buttons are "required before indicators and
     charts can update" — a failure here must not prevent the Start/Stop
     buttons themselves from being wired. */
  try {
    const AUTO_START_FEED_KEY = "itguru_autoStartFeed";

    // Restore auto-start preference from localStorage
    try {
      const saved = localStorage.getItem(AUTO_START_FEED_KEY);
      if (saved !== null) autoStartFeedEnabled = JSON.parse(saved) === true;
    } catch (_) { /* ignore */ }

    // Sync checkbox
    if (UI.autoStartFeedToggle) {
      UI.autoStartFeedToggle.checked = autoStartFeedEnabled;
      UI.autoStartFeedToggle.addEventListener("change", () => {
        autoStartFeedEnabled = UI.autoStartFeedToggle.checked;
        try { localStorage.setItem(AUTO_START_FEED_KEY, JSON.stringify(autoStartFeedEnabled)); } catch (_) {}
        saveSettings();
      });
    }

    // Wire Start / Stop buttons (they delegate to the existing connect/disconnect)
    if (UI.startPublicFeedBtn) {
      UI.startPublicFeedBtn.addEventListener("click", () => {
        console.log("Public feed button clicked: start");
        updatePublicFeedPanel('connecting');
        connect();
      });
    }
    if (UI.stopPublicFeedBtn) {
      UI.stopPublicFeedBtn.addEventListener("click", () => {
        console.log("Public feed button clicked: stop");
        disconnect();
      });
    }

    // Initialise panel to disconnected state
    updatePublicFeedPanel('disconnected');

    // Auto-start: fetch server config first, fall back to local preference
    fetch("/api/market-data/feed-config.php")
      .then(r => r.ok ? r.json() : null)
      .then(cfg => {
        // Server config wins over local localStorage if it exists
        const serverAutoStart = cfg && typeof cfg.autoStart === "boolean" ? cfg.autoStart : null;
        const shouldStart = serverAutoStart !== null ? serverAutoStart : autoStartFeedEnabled;

        if (shouldStart) {
          updatePublicFeedPanel('connecting');
          // Small delay so the UI renders before the connection attempt
          setTimeout(() => { if (!ws || ws.readyState > 1) connect(); }, 400);
        }
      })
      .catch(() => {
        // Network error or server unavailable – honour local preference only
        if (autoStartFeedEnabled) {
          updatePublicFeedPanel('connecting');
          setTimeout(() => { if (!ws || ws.readyState > 1) connect(); }, 400);
        }
      });
  } catch (err) {
    console.error("Public Market Feed controls failed to initialize:", err);
  }

  addLog("Indicator ready – press Connect to start");
  updateStatsUI();
 } catch (err) {
  /* Guard against any single init step throwing and silently aborting
     all remaining event-listener bindings (including indicator toggles
     and the Start/Stop Public Market Feed buttons). Surface the error
     instead of leaving the UI in a half-wired, unresponsive state. */
  console.error("Indicator init error – some controls may not respond to clicks:", err);
  try { addLog("⚠️ Initialization error – some buttons may not respond. Check console (F12) and reload."); } catch (_) { /* addLog itself may be unavailable */ }
 }
});
