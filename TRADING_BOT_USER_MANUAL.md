# IT GURU — BREAKOUT RETEST INDICATOR
## Complete Client User Manual

> **IMPORTANT DISCLAIMER:** This manual and the IT Guru indicator described herein do **not** constitute financial advice. All trade setups are potential opportunities based on technical analysis only. Trading financial markets involves significant risk of loss. You are solely responsible for your own trading decisions, position sizing, and account management. Past performance does not guarantee future results.

---

## TABLE OF CONTENTS

1. [Introduction — The PIN (Beginner Level)](#1-introduction--the-pin-beginner-level)
2. [How the Indicator Works (Beginner to Intermediate)](#2-how-the-indicator-works-beginner-to-intermediate)
3. [How to Use IT Guru (Core Usage)](#3-how-to-use-it-guru-core-usage)
4. [Signal Format Explained](#4-signal-format-explained)
5. [Strategies Explained — All 12 Modules](#5-strategies-explained--all-12-modules)
6. [Advanced Usage — The ANCHOR (Power Users)](#6-advanced-usage--the-anchor-power-users)
7. [Risk Management and Responsibility](#7-risk-management-and-responsibility)
8. [Limitations of the Indicator](#8-limitations-of-the-indicator)
9. [Quick Start Summary](#9-quick-start-summary)
10. [Frequently Asked Questions (FAQ)](#10-frequently-asked-questions-faq)
11. [MT5 Bridge Integration](#11-mt5-bridge-integration)
12. [Indicator V2](#12-indicator-v2)
13. [XAUUSD Scalping Strategy Guide](#13-xauusd-scalping-strategy-guide)

---

## 1. INTRODUCTION — THE PIN (BEGINNER LEVEL)

### What Is IT Guru?

**IT Guru** is a professional-grade, browser-based trading indicator built specifically for the **Deriv platform**. It connects live to Deriv's price feeds and continuously watches charts for high-quality trading opportunities across dozens of markets — 24 hours a day, 7 days a week.

Think of IT Guru as your personal market analyst who never sleeps. While you go about your day, it is scanning every candlestick, measuring every price move, and alerting you the moment a quality setup forms. You remain in full control of your trades — IT Guru gives you the information; you make the decisions.

It is accessed through your web browser at: **trading.dsitservicesja.com/indicator/**

---

### What Does IT Guru Do?

IT Guru:

- **Connects live to Deriv** via a secure WebSocket and receives real-time price data
- **Monitors candles in real time** across every timeframe from 1 minute to 1 day
- **Identifies 6-phase breakout-retest setups** — the core signal engine
- **Runs up to 12 additional strategies simultaneously** on the same chart
- **Fires a Live Scalp Scanner** for rapid, high-confluence short-term entries
- **Alerts you via Telegram** with a full chart screenshot, entry, stop loss, and take profit
- **Optionally places trades automatically** on your Deriv account when a signal fires
- **Tracks your win/loss record** and displays live performance statistics
- **Can be backtested** using historical candle data

---

### Markets IT Guru Analyses

IT Guru supports over 90 symbols across the following categories:

| Category | Available Markets |
|---|---|
| **Volatility (1s)** | Vol 10, 15, 25, 30, 50, 75, 90, 100, 150, 200, 250, 300 (1s) |
| **Volatility (Standard)** | Vol 10, 25, 50, 75, 100 Index |
| **Boom Indices** | Boom 300, 500, 600, 900, 1000 |
| **Crash Indices** | Crash 300, 500, 600, 900, 1000 |
| **Jump Indices** | Jump 10, 25, 50, 75, 100 |
| **Step Indices** | Step Index, Step 200, 300, 400, 500 |
| **Daily Reset** | Bull Market Index, Bear Market Index |
| **DEX Indices** | DEX 600/900/1500 Up and Down |
| **Drift Switch** | Drift Switch 10, 20, 30 |
| **Forex Majors** | EUR/USD, GBP/USD, USD/JPY, USD/CHF, AUD/USD, USD/CAD, NZD/USD |
| **Forex Crosses** | EUR/GBP, EUR/JPY, GBP/JPY, and 14 more pairs |
| **Forex Exotics** | USD/MXN, USD/ZAR, USD/TRY, and 5 more |
| **Commodities** | Gold (XAU/USD), Silver (XAG/USD), Platinum, Palladium |

> All Deriv synthetic indices are available 24/7, including weekends. Forex markets follow standard market hours.

---

### Timeframes Available

IT Guru can run on any of these timeframes: **1m, 2m, 3m, 5m, 10m, 15m, 30m, 1h, 2h, 4h, 8h, 1D**

The best timeframe depends on your trading style and the market you are trading (explained further in Sections 3 and 5).

---

### What Are "Potential Trade Setups"?

When IT Guru identifies a setup, it means:

- A defined sequence of price conditions has been satisfied
- The technical evidence suggests the market **may** move in a specific direction
- The risk-to-reward on the setup meets a minimum standard
- There is **always a possibility the trade does not work** — no setup is certain

Think of it like a weather forecast: "70% chance of rain." The meteorologist uses the best available data to give you a probability — not a guarantee.

---

### Who Is IT Guru For?

| Trader Type | How IT Guru Helps |
|---|---|
| **Complete Beginner** | Provides structured, explained setups as a learning guide |
| **Scalper** | Live Scalp Scanner fires rapid entries on 1m-5m charts |
| **Intraday Trader** | Core breakout-retest signals on 15m-1h charts |
| **Swing Trader** | Higher-timeframe signals (4h, Daily) on Forex pairs |
| **Busy Professional** | Telegram alerts mean you never have to watch the screen |
| **Advanced Trader** | 12 strategies and deep filter controls for precision execution |
| **Auto-Trader** | Optional auto-execution on your Deriv account |

---

### What IT Guru Does NOT Do

- Does not guarantee profits — no indicator, system, or analyst can do that
- Does not replace your risk management — stop loss and lot size remain your responsibility
- Does not constitute financial advice — setups are technical signals only
- Does not place trades automatically unless you enable Auto-Trade and accept the associated risk
- Is not responsible for losses — you are the trader and final decision-maker

---

### Subscription Plans

IT Guru is a subscription service. Plans are available as follows:

| Plan | Price | Duration | Access |
|---|---|---|---|
| **Trial** | Free | Limited | Basic signals, demo trading only |
| **Weekly** | $9.99 | 7 days | All 12 strategies, live and demo trading, Telegram alerts |
| **Monthly** | $29.99 | 30 days | All 12 strategies, live and demo trading, Telegram alerts, priority support |

> Contact your administrator to activate a plan. Subscription access is enforced at login.

---

## 2. HOW THE INDICATOR WORKS (BEGINNER TO INTERMEDIATE)

### The Core Engine: 6-Phase Breakout-Retest Cycle

The heart of IT Guru is a 6-phase process that plays out on every chart, on every candle. Understanding these six phases is the most important thing you can learn about this indicator.

---

#### Phase 1 — RANGE

The indicator watches the first group of candles and measures the **opening range** — the high and low price established during the initial period (configurable, default 15 minutes).

Think of this as the "base camp" — a zone where price has been consolidating before making its next move. The range high and range low are drawn on the chart as reference lines.

> *Example: On V75 (1m), IT Guru collects the first 15 one-minute candles and marks the high and low of that period.*

---

#### Phase 2 — BREAKOUT

The indicator waits for a candle to **close** above the range high (bullish breakout) or below the range low (bearish breakout). A wick through the level that closes back inside is **not** counted — the candle body must close outside.

This is important: IT Guru requires a **confirmed close** outside the range, not just a temporary spike. This filters out false moves.

> *Example: A strong bullish candle closes above the range high. Breakout confirmed, direction set to BUY.*

---

#### Phase 3 — RETEST

After a breakout, price almost always pulls back to **retest** the level it just broke through. The breakout level becomes new support (after a bullish break) or new resistance (after a bearish break).

IT Guru monitors for this retest using ATR-based tolerance so that minor wicks above or below the level do not count as a failed retest.

> *Example: After the bullish breakout, price pulls back down toward the range high. IT Guru detects that price has touched the retest zone.*

---

#### Phase 4 — INDECISION

At the retest zone, the indicator looks for a **candlestick pattern that shows the market pausing** — buyers and sellers fighting for control. IT Guru detects the following indecision patterns:

| Pattern | Description |
|---|---|
| **Doji** | Open and close nearly identical — neither side winning |
| **Spinning Top** | Small body with wicks on both sides |
| **Pin Bar / Hammer / Shooting Star** | Long tail in one direction — rejection of a price level |
| **Inside Bar** | Current candle fully inside the previous candle's range |
| **Dragonfly Doji** | Long lower wick, open/close near high — bullish rejection |
| **Gravestone Doji** | Long upper wick, open/close near low — bearish rejection |

> *Example: A pin bar with a long lower tail forms at the retest zone — sellers tried to push lower but buyers rejected it.*

---

#### Phase 5 — CONFIRMATION

The indecision candle alone is not enough. IT Guru requires a **confirmation candle** that shows momentum is genuinely entering in the direction of the trade. Confirmation patterns include:

| Pattern | What It Means |
|---|---|
| **Bullish Engulfing** | A green candle that completely engulfs the previous red candle — strong buying momentum |
| **Bearish Engulfing** | A red candle that completely engulfs the previous green candle — strong selling momentum |
| **Morning Star** | A 3-candle reversal pattern signalling the end of a downtrend |
| **Evening Star** | A 3-candle reversal pattern signalling the end of an uptrend |
| **Inside Bar Breakout** | The inside bar's range is broken in the trade direction |
| **Piercing Line / Dark Cloud Cover** | Mid-body penetration patterns showing momentum shift |
| **Tweezers Tops / Bottoms** | Two candles with matching highs or lows — double rejection |

---

#### Phase 6 — TRADE

When confirmation fires, IT Guru calculates and displays the full trade setup:

- **Entry price** — the close of the confirmation candle
- **Stop Loss** — anchored to the lowest low (bullish) or highest high (bearish) of the retest zone candles, with an ATR buffer for breathing room
- **Take Profit** — calculated from your chosen Risk:Reward ratio
- **Confluence Score** — an overall quality rating for the setup (0-16 points)
- **Position Size** — calculated automatically if you enter your account balance and risk percentage

The signal is then sent to Telegram and displayed on the live chart.

---

### Confluence Score (0-16)

Every breakout-retest signal is scored from **0 to 16** based on how many quality conditions are met. The higher the score, the stronger the setup. Factors that contribute to the score include:

- EMA 8/21 alignment with trade direction
- Higher-timeframe EMA 100 alignment
- Strong breakout candle (body conviction)
- Pin bar present at retest
- Support/Resistance confluence
- RSI at ideal retest level
- Volume spike on breakout
- Session timing
- Fibonacci level at retest
- MACD momentum alignment
- Bollinger Bands squeeze
- ADX trend strength
- Stochastic momentum

> A confluence score of **8 or higher** is generally considered a strong, high-quality setup.

---

### Live Ticker Banners

The top of the IT Guru screen shows three live scrolling banners:

- **LIVE SIGNALS** — breakout-retest signals
- **LIVE SCALPS** — scalp scanner alerts
- **STRATEGIES** — alerts from the 12 strategy modules

> **Tip:** Clicking a card in the **LIVE SIGNALS** or **STRATEGIES** banner selects that signal and draws the **Entry, Stop Loss, and Take Profit lines** directly on the chart as a visual overlay — without changing your active trade state. This lets you review any historical signal visually without disrupting a live trade.

---

### Technical Indicators Running in the Background

IT Guru continuously computes the following indicators on every candle:

| Indicator | Purpose |
|---|---|
| **EMA 8 and 21** | Short-term trend direction and crossover filter |
| **EMA 100** | Higher-timeframe trend proxy |
| **EMA 200** | Long-term structural trend reference |
| **ATR (14)** | Measures volatility — used for SL placement, tolerance, and trailing stops |
| **RSI (14)** | Confirms pullback depth at retest; oversold/overbought conditions |
| **MACD (12/26/9)** | Momentum filter — is momentum aligning with the trade? |
| **Bollinger Bands (20/2 std dev)** | Detects squeeze — low volatility before a big move |
| **ADX (14)** | Measures trend strength (25+ = trending; below 20 = ranging) |
| **Stochastic (14/3/3)** | Secondary momentum filter — K/D crossovers |
| **VWAP** | Volume-weighted average price — institutional bias level |
| **Fibonacci Levels** | 23.6%, 38.2%, 50%, 61.8%, 78.6% retracement levels at retest |

---

### The 6-Phase in Action — Full Example

> **Market:** Volatility 75 (1s) | **Timeframe:** 1 Minute
>
> **Phase 1 (RANGE):** IT Guru collects 15 candles and marks the range: high at 12,450, low at 12,430.
>
> **Phase 2 (BREAKOUT):** A strong green candle closes at 12,458 — above the 12,450 range high. Breakout direction: BUY.
>
> **Phase 3 (RETEST):** Price pulls back. IT Guru detects that the current candle touched 12,451 — inside the ATR tolerance zone of the 12,450 level.
>
> **Phase 4 (INDECISION):** A pin bar forms with a long lower wick at 12,449. Tail is 2.5x the body — confirmed pin bar.
>
> **Phase 5 (CONFIRM):** The next candle is a strong bullish engulfing candle closing at 12,455.
>
> **Phase 6 (TRADE):** Entry: 12,455. SL: 12,441 (swing low + ATR buffer). TP: 12,483 (2:1 RR). Confluence Score: 11/16. Telegram alert sent with chart screenshot.

---

## 3. HOW TO USE IT GURU (CORE USAGE)

### The Interface at a Glance

When you open IT Guru in your browser, you will see:

**Top bar (always visible):**
- Brand name + connection status badge
- Account type (Demo or Real)
- Current phase (RANGE, BREAKOUT, RETEST, INDECISION, CONFIRM, TRADE)
- Breakout direction
- Live price
- Candle countdown timer (turns red when under 10 seconds)
- Candles processed count
- Session uptime
- Win rate %
- Connect / Disconnect / Reset buttons
- Tool buttons: Export CSV, Export PDF, Theme, Sound, Notifications, Stream Mode

**Left Panel (tabbed):**
- **Settings** — API credentials, symbol, timeframe, strategies, filters, auto-trade
- **State** — live indicator values (EMA status, HTF trend, ATR, RSI, MACD, etc.)
- **Stats** — win/loss count, win rate, signal history

**Centre — Live Chart:** Candlestick chart with EMAs, range lines, signal markers, and overlays drawn in real time.

---

### Step 1 — Connect to Deriv

1. In the **API** section of the Settings tab, enter your **Deriv App ID** (default is provided)
2. Paste your **Deriv API Token** (create one at app.deriv.com under API Token)
3. Click the **Connect** button in the top bar (or press **Alt+C**)
4. The status badge changes from DISCONNECTED to CONNECTED and the account type badge shows Demo or Real

> **Tip:** Keep your API token secure. IT Guru stores it encrypted in your browser's local storage.

---

### Step 2 — Choose Your Market and Timeframe

In the **Market** section:
1. Select your **Symbol** from the dropdown (e.g. Volatility 75 (1s), EUR/USD, Boom 1000)
2. Select your **Timeframe** (e.g. 1m for scalping, 15m for intraday, 1h for swing)
3. IT Guru automatically applies **recommended settings** for the selected symbol

> **Lock features:** Tick the Lock checkbox next to Timeframe or R:R to prevent them from being overridden when you switch symbols.

---

### Step 3 — Configure Your Risk:Reward

In the **Risk : Reward** section:
- Set your desired ratio (e.g. Risk = 1, Reward = 2 for a 1:2 RR)
- The TP level on the chart and in Telegram alerts is calculated from this ratio

> A **minimum 1:2 RR** is recommended. Enable the **Min R:R Gate** filter to automatically reject setups that do not meet your threshold.

---

### Step 4 — Enter Your Account Size (Optional but Recommended)

In the **Account Size** section:
- Enter your **account balance** in USD
- Enter your **risk per trade %** (recommended: 1%)
- IT Guru will automatically calculate and display:
  - Dollar risk per trade
  - Dollar reward potential
  - Recommended position size (lots)

---

### Step 5 — Enable Strategies

In the **Strategies** section, toggle on the strategies you want to run. Each strategy scans independently for its own specific setup. All active strategy signals appear in the Strategy Alerts panel and are sent to Telegram.

*(See Section 5 for a full explanation of all 12 strategies.)*

---

### Step 6 — Press Connect and Let IT Guru Run

Once connected, IT Guru:
- Starts collecting candles
- Processes each new candle through the 6-phase engine
- Scans all enabled strategies on every candle close
- Displays the live phase, direction, and state in real time

You do not need to do anything else. Watch the chart, wait for signals, and act when you are ready.

---

### Receiving Signals on Telegram

IT Guru sends Telegram alerts automatically when a signal fires. Each alert includes:

- A **1920x1080 screenshot** of the live chart with all indicators and levels drawn
- Signal details: symbol, direction, entry, SL, TP, RR, confluence score
- The strategy or phase that triggered the alert
- A **Trade Conditions block** summarising the key factors behind the setup (EMA alignment, HTF trend, RSI, session, ATR volatility, etc.)

**Strategy Outcome Notifications:**
- When a strategy trade closes at a WIN or LOSS, IT Guru sends a follow-up Telegram message with the outcome.
- If partial TP was hit (SL moved to breakeven) and price then closes at the entry level, the outcome is classified as **BREAKEVEN** rather than LOSS — this is tracked separately in your strategy record.

To receive Telegram alerts, link your Telegram account via the Telegram section in Settings or contact your administrator.

---

### Best Times to Trade Different Markets

| Market | Best Timeframe | Best Hours (UTC) |
|---|---|---|
| **Forex Majors (EUR/USD, GBP/USD)** | 15m, 1h, 4h | 07:00-16:00 (London + NY) |
| **USD/JPY, AUD/USD** | 15m, 1h | 00:00-09:00 (Asian + London) |
| **Gold (XAU/USD)** | 15m, 1h | 07:00-17:00 (London + NY) |
| **Volatility Indices (standard)** | 5m-1h | 24/7 |
| **Volatility (1s) indices** | 1m-5m | 24/7 |
| **Boom and Crash** | 1m-15m | 24/7 |
| **Jump and Step Indices** | 1m-5m | 24/7 |

---

### Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| **Alt+C** | Connect |
| **Alt+D** | Disconnect |
| **Alt+R** | Reset Session |
| **Alt+T** | Toggle Theme (Light/Dark) |
| **Alt+E** | Export signals to CSV |
| **Alt+P** | Export signals to PDF with charts |
| **Alt+N** | Toggle notifications |
| **Alt+S** | Toggle Stream Mode (hides sensitive info during screen recording) |

---

## 4. SIGNAL FORMAT EXPLAINED

### Sample Telegram Signal

```
=======================================
   IT GURU - POTENTIAL TRADE SETUP
=======================================
Symbol     : Volatility 75 (1s)
Direction  : BUY
Timeframe  : 1m
---------------------------------------
Entry      : 12,455.20
Stop Loss  : 12,441.00
Take Profit: 12,483.40
Risk:Reward: 1:2.0
---------------------------------------
Confluence : 11 / 16
Phase      : TRADE
Confirm    : Bullish Engulfing
---------------------------------------
NOTE: Bullish breakout above 15-min
range. Pin bar retest at 12,450 level.
EMA 8/21 aligned bullish. RSI at 42.
Fib 0.618 confluence at retest zone.
---------------------------------------
NOT financial advice. Manage your risk.
=======================================
```

*(A full 1920x1080 chart screenshot is attached to every signal)*

---

### Breaking Down Each Field

#### Symbol
The exact market being traded.
*Example: "Volatility 75 (1s)" means the 1-second Volatility 75 Index on Deriv.*

#### Direction
- **BUY** — setup favours price moving up. Open a BUY/LONG contract on Deriv.
- **SELL** — setup favours price moving down. Open a SELL/SHORT contract on Deriv.

#### Timeframe
The chart timeframe the setup was detected on.
- 1m-5m = scalp / very short-term
- 15m-1h = intraday
- 4h-1D = swing trade

#### Entry
The price at the close of the confirmation candle — this is where IT Guru suggests entering the trade.

#### Stop Loss (SL)
The price level that defines your risk. If price reaches this level, the trade is considered invalid. IT Guru places the SL at the structural swing low/high of the retest zone, plus an ATR buffer.

> **Always set your stop loss before opening the trade. This is non-negotiable.**

#### Take Profit (TP)
Your target exit price. Calculated automatically from your R:R setting.
- At 1:2 RR: risk $1 to make $2
- At 1:3 RR: risk $1 to make $3

#### Risk:Reward (RR)
How much potential reward relative to the risk taken. IT Guru rejects setups that do not meet your minimum RR threshold (configurable via the Min R:R Gate filter).

#### Confluence Score
A quality rating from **0 to 16**. Higher means more technical factors confirm the trade. Use this as a priority guide — prefer higher-scored setups when multiple signals are firing.

#### Confirm Pattern
The specific candlestick pattern that triggered Phase 5 (Confirmation). Examples: Bullish Engulfing, Pin Bar, Morning Star, Inside Bar Breakout.

#### Note
A plain-language summary of why the setup was identified — which indicators agree, what structure is in place, and any notable conditions.

---

## 5. STRATEGIES EXPLAINED — ALL 12 MODULES

IT Guru runs up to 12 independent strategies simultaneously alongside the core breakout-retest engine. Each one looks for a different type of market condition and fires its own alerts. Here is what each strategy does, explained simply.

---

### Strategy 1: Liquidity Sweep

**What it looks for:** A quick price sweep below a key support level (or above resistance) that immediately reverses — indicating that smart money grabbed stop losses and is now pushing in the opposite direction.

**Trade setup:** Entry on the reversal candle after the sweep, with a fixed **2:1 Risk:Reward**.

**Best for:** Experienced traders who understand stop-loss hunting concepts. Works well on Volatility indices.

---

### Strategy 2: Stop Loss Hunt

**What it looks for:** Price approaching a well-defined S/R level that has been touched 3 or more times, making a sharp spike through it, then quickly reversing. Institutions sweep retail stops before moving the other way.

**Trade setup:** Entry after the reversal confirmation candle. SL above/below the spike extreme.

**Best for:** Traders who understand key support/resistance levels.

> **One-at-a-time:** IT Guru will not fire a new Stop Loss Hunt signal while a previous one is still PENDING (active and unresolved). This prevents spam and keeps you focused on the live trade.

---

### Strategy 3: Failed Pin Bar

**What it looks for:** A sequence of 3 or more consecutive strong directional candles (a fear or greed push), followed by a pin bar that appears to signal reversal — but actually fails and resumes the original direction.

**Trade setup:** Entry in the direction of the original move when the pin bar's reversal breaks down.

**Best for:** Momentum traders who trade with the trend.

---

### Strategy 4: Fib Golden Zone Scalp

**What it looks for:** A clear micro-trend on 1-minute charts, a break of structure, then price pulling back into the **0.5-0.618 Fibonacci Golden Zone** — the most statistically powerful retracement area.

**Trade setup:** Entry at the Fibonacci zone with the target at the previous swing high (uptrend) or swing low (downtrend). Pure price action — no additional indicators.

**Best for:** Scalpers on 1m charts. Particularly effective on Volatility indices.

---

### Strategy 5: Power of 3 (ICT PO3)

**What it looks for:** The ICT "Power of 3" concept — three phases that repeat every hour:
1. **Accumulation** — price consolidates near the 1-hour candle open
2. **Manipulation** — a sweep below (bullish day) or above (bearish day) the 1H open to trap retail traders
3. **Expansion** — a strong displacement candle leaving a Fair Value Gap (FVG), followed by a retrace into the FVG for entry

**Trade setup:** Entry into the Fair Value Gap after the displacement candle. SL below the manipulation low or above the manipulation high. Partial TP at 1R, SL moves to breakeven, let the rest run.

**Best timeframes:**

| Timeframe | Notes |
|---|---|
| **1 min** | Highest signal frequency; freshest FVG entries; best for Volatility indices |
| **5 min** | Good balance of frequency and quality; sweep lookback auto-scales to 18 candles |
| **15 min** | Fewer setups per hour; use STRICT entry freshness to avoid stale entries |

The strategy always anchors to the current 1-hour block regardless of chart timeframe.

**Entry Freshness Mode** (configurable in the PO3 settings):

| Mode | Behaviour | When to Use |
|---|---|---|
| **SAFE** (default) | Allows entry up to 1 candle after the FVG touch — more signals | 1–5 min charts |
| **STRICT** | Entry only on the exact FVG-touch candle — fewer but cleaner signals | 15 min+ charts |

**Required conditions:** EMA 8/21 trend alignment plus EMA 100 (HTF) confirmation. A minimum R:R of 1.0 is enforced automatically.

**Best for:** Intermediate-to-advanced traders familiar with ICT concepts. Recommended minimum confluence score: 11.

> **One-at-a-time:** IT Guru will not fire a new PO3 signal while a previous one is still PENDING.

---

### Strategy 6: NY Open Range

**What it looks for:** The 9:30-9:35 AM EST New York open range — the first 5 minutes of the New York session. The strategy monitors for a breakout of this range and a retest, then enters in the breakout direction.

**Trade setup:** Retest entry with SL inside the range. Tracks wins/losses to show NY session performance.

**Best for:** Forex traders who trade during the New York session. Best on EUR/USD, GBP/USD, Gold.

---

### Strategy 7: Session Ranges (London Sweep)

**What it looks for:** IT Guru marks the Asian session range (00:00-09:00 UTC). When the London session opens and price **sweeps** the Asian range high or low with a wick but closes **back inside** — this is the London Sweep, a reliable reversal signal.

**Trade setup:** Entry on the closing candle that sweeps but closes back inside the Asian range. SL beyond the sweep extreme.

**Best for:** Forex traders during the London session. Works especially well on tight Asian ranges.

---

### Live Scalp Scanner

**What it looks for:** A rapid confluence check on every candle, scoring 7 technical conditions simultaneously. When 3 or more conditions align, a scalp alert fires immediately — no waiting for multiple phases.

**Signals appear** in the LIVE SCALPS ticker banner at the top of the screen.

**Best for:** Scalpers who want the fastest possible entries. Best on 1m charts and Volatility (1s) indices.

---

### Strategy 8: Grid Scalper MA

**What it looks for:** Three modes:
- **Price vs MA mode:** BUY when price crosses above a moving average; SELL when it crosses below
- **BOS mode:** BUY when price breaks above a confirmed swing high; SELL below a swing low
- **Triple MA mode:** SMA 50 acts as the trend filter, SMA 20 confirms direction, and SMA 11 times the entry — a pullback must touch SMA 11 and the candle must close back on the trend side (rejection/bounce entry). These three periods are fixed; the configurable MA Period setting only applies to Price vs MA mode.

**Best for:** Traders who prefer moving average-based systems or simple break-of-structure trades.

#### Recommended Profitable Settings

Use this profile as your starting point, then let the adaptive tools refine it with your own data:

| Setting | Recommended | Why |
|---|---|---|
| **Mode** | **Triple MA** (trending markets) or **Price vs MA** (general) | Triple MA is the most selective — it only enters with the trend on a pullback rejection, which is structurally the highest win-rate setup of the three modes. BOS fires more often but with more noise. |
| **MA Period** (Price vs MA mode) | **21** (default) on 1m; **34–50** on 5m if getting whipsawed | Shorter = more signals but more false crosses. A longer MA filters chop for free. |
| **Timeframe** | **1m–5m** | Matches the playbook recommendation; typical hold window 5–20 candles. |
| **Min Confluence Gate** | ✅ ON, threshold **8/16** | Raise to 9–10 for fewer, higher-quality trades. |
| **Adaptive Confluence** | ✅ ON — start in **ObservationOnly**, switch to **Active** after ~30 resolved trades | The adaptive gate learns which confluence factors actually win for you. **ObservationOnly** logs what it *would* reject without blocking any signals; **Active** actually rejects low-quality signals. Let it gather data before allowing it to reject. |
| **Opposite Mode** | ❌ OFF initially | Only enable if the 🔮 Shadow stats consistently show the opposite direction outperforming. Data first, then flip. |
| **Tesla 3-6-9** | ✅ ON, Conservative (50/30/20) | Locks in partial profits at 3R/6R/9R milestones. |

**Symbol choice — take-profit is auto-tuned per instrument class:**

| Symbol class | R:R target | Notes |
|---|---|---|
| Volatility 1s indices (1HZ…) | **1.5:1** | Quick scalps; needs ~40%+ win rate to profit |
| Standard Volatility indices (R_…) | **2.5:1** | Best expectancy per trade; only ~29% win rate needed to break even |
| All other symbols (Gold, forex) | **2.0:1** | Balanced |

**Most profitable combos in practice:**
- **R_75 / R_100 on 1m, Triple MA mode** — the 2.5R target plus trend-following entries gives the best expectancy math
- **Gold (XAUUSD) on 1m–5m during London/NY sessions** — Gold's trending session behavior makes MA crosses reliable, and the 2.0× ATR SL cap protects against spikes

**Built-in protections (always active, no tuning needed):** 5-candle cooldown between signals, one pending signal at a time, SL capped at 2.0× ATR, structural swing-based SL with 0.15× ATR buffer, and signals rejected if risk is under 0.05× ATR.

> **Note:** These recommendations come from the strategy's structural logic and this playbook — not from backtest data. Run Adaptive Confluence in ObservationOnly mode for a week, then review the per-factor win rates and shadow stats to tighten the settings empirically.

---

### Strategy 9: Fair Value Gap (FVG)

**What it looks for:**
1. A big push — 3 or more consecutive strong directional candles
2. A Fair Value Gap within that push (a gap between the high of candle 1 and the low of candle 3)
3. Price retesting the origin/demand zone before the push started
4. A Fibonacci discount (price below 50% retracement for buys, above for sells)
5. A confirmation engulfing candle at the zone

**Trade setup:** Entry at the confirmation candle. SL below/above the demand/supply zone. TP at recent swing.

**Best for:** Intermediate traders who understand supply/demand zones. Strong on trending markets.

---

### Strategy 11: MTF Top-Down Analysis

**What it looks for:** IT Guru synthesises higher timeframe candles from your current chart (16x multiplier for "4H" bias, 4x for "1H" setup). It then:
1. Determines the 4H bias (bullish/bearish structure)
2. Finds a 1H consolidation and breakout aligned with that bias
3. Looks for a retest and confirmation on the current timeframe

**Trade setup:** Entry on the confirmation candle. Minimum 2:1 RR. SL at wick extreme plus ATR buffer.

**Best for:** Advanced traders who want true multi-timeframe top-down alignment without switching charts.

---

### Strategy 12: Orderblock Detection

**What it looks for:** An orderblock — the last bearish candle before a strong bullish move, or the last bullish candle before a strong bearish move. These are zones where institutional orders were placed. When price returns to retest these zones, high-probability entries form.

**Trade setup:** Entry when price retests the orderblock zone with a confirmation pattern.

**Best for:** Advanced traders who understand institutional order flow and supply/demand.

> **One-at-a-time:** IT Guru will not fire a new Orderblock signal while a previous one is still PENDING. Telegram alerts for Orderblock setups include **impulse metrics** (displacement strength, body ratio) in the caption for additional context.

---

### Tesla 3-6-9 Scaling Model

This optional profit management overlay alerts you at three profit milestones:

| Level | R Multiple | Action |
|---|---|---|
| **T1** | 3R | Take first partial profit. SL moves to breakeven. |
| **T2** | 6R | Take second partial profit. Continue running. |
| **T3** | 9R | Final target or let runner trail. |

Two plans available:
- **Conservative (50/30/20):** Take 50% at T1, 30% at T2, 20% at T3
- **Aggressive (25/35/20+trail):** Smaller T1 exit, larger T2 exit, trail the final portion

The chart shows amber T1/T2/T3 horizontal lines so you can visually see your targets.

---

### Recommended Strategy Playbook (Timeframe, Hold Time & Confluence)

Use this as your default operating guide when you enable strategy alerts and Telegram auto-send.

| Strategy | Recommended Timeframe | Typical Hold Window | Recommended Minimum Confluence* |
|---|---|---|---|
| **Liquidity Sweep** | 1m-5m | 5-20 candles | **9/16** |
| **Stop Loss Hunt** | 5m-15m | 10-30 candles | **10/16** |
| **Failed Pin Bar** | 1m-5m | 3-12 candles | **8/16** |
| **Fib Golden Zone Scalp** | 1m | 3-10 candles | **9/16** |
| **Power of 3 (ICT PO3)** | 1m-5m (15m with STRICT mode) | 10-40 candles | **11/16** |
| **NY Open Range** | 1m-5m during NY open | 5-20 candles | **10/16** |
| **Session Range (London Sweep)** | 5m-15m during London open | 10-30 candles | **10/16** |
| **Live Scalp Scanner** | 1m | 2-8 candles | **3/7 scanner score** + **8/16+ confluence** |
| **Grid Scalper MA** | 1m-5m | 5-20 candles | **8/16** |
| **Fair Value Gap (FVG)** | 5m-15m | 10-40 candles | **10/16** |
| **MTF Top-Down Analysis** | 15m-1h | 20-80 candles | **11/16** |
| **Orderblock Detection** | 5m-15m | 15-60 candles | **10/16** |
| **TikTok Fibonacci** | 1m-5m | 8-25 candles | **9/16** |
| **Tesla 3-6-9 Scaling Model** | Follow parent setup timeframe | Hold until T1/T2/T3 milestones | Match parent setup confluence |

\*Confluence guidance uses the main 0-16 quality score where available. Strategy Telegram alerts now include this confluence value so you can rank opportunities quickly.

---

## 6. ADVANCED USAGE — THE ANCHOR (POWER USERS)

### Reading Market Bias from the State Panel

Open the **State** tab in the left panel. This shows you the live values of every indicator in real time:

| State Field | What to Look For |
|---|---|
| **EMA Filter Status** | BULL or BEAR — EMA 8 vs 21 crossover direction |
| **HTF Trend** | BULL or BEAR — EMA 100 direction (higher-timeframe bias) |
| **ATR** | Current volatility level — larger ATR means wider SL needed |
| **Breakout Strength** | Candle body vs ATR — how convincing was the breakout |
| **RSI** | Current RSI value — ideal retest zone is 35-45 (BULL) or 55-65 (BEAR) |
| **MACD** | Above zero = bullish momentum; below = bearish |
| **ADX** | 25 or above = trending market; below 20 = ranging |
| **Stochastic** | K/D lines — crossover from oversold or overbought |
| **Volatility Regime** | TRENDING or RANGING — ADX-based market condition |
| **Signal Strength** | Visual gauge showing current confluence score |

**Power User Rule:** Only take trades where EMA Filter, HTF Trend, and your own chart reading all agree on direction.

---

### Mastering the Strategy Filter Toggles

The **Strategy Filters** section gives you 15+ individual toggles to tune the indicator's precision:

| Filter | Recommended Setting | Why |
|---|---|---|
| **Auto-Reset After Trade** | ON | Automatically scans for the next setup |
| **EMA 8/21 Trend Filter** | ON | Rejects counter-trend breakouts |
| **HTF Trend Filter (EMA 100)** | ON | Keeps you aligned with the bigger picture |
| **ATR-Based Tolerance** | ON | More accurate retest detection on volatile markets |
| **Trailing Stop** | ON for swings | Locks in profit as the trade runs |
| **Partial TP (1:1)** | ON for safety | Moves SL to breakeven at 1:1, de-risks the trade |
| **Tesla 3-6-9 Scaling** | Optional | For runners — maximises profit on big moves |
| **False Breakout Filter** | ON | Invalidates breakouts that close back inside range within 3 candles |
| **Min R:R Gate** | ON (set to 2.0) | Automatically rejects low-quality setups |
| **RSI Filter** | ON | Ensures price has pulled back enough to have room to move |
| **Volume Spike Filter** | ON | Only accepts breakouts with a strong body candle |
| **Session Filter** | Optional (Forex only) | Trade Forex only during active sessions |
| **Fibonacci Retest** | ON | Adds confluence when retest aligns with fib level |
| **MACD Filter** | ON for strong trends | Ensures momentum agrees with the trade |
| **ADX Filter** | ON for scalps | Filters out ranging markets |

> **Lock Filters:** Once you have your filters set exactly how you want them, tick **Lock Filters** to prevent the auto-apply feature from overriding them when you switch symbols.

---

### Using Multi-Symbol Analysis

IT Guru supports **simultaneous analysis of up to 90 symbols**. To scan multiple markets at once:

1. Open the **Multi-Symbol Analysis** section
2. Tick the symbols you want to monitor
3. IT Guru opens background connections to each selected symbol
4. Signals from any symbol appear in the LIVE SIGNALS ticker banner and trigger Telegram alerts
5. Click any signal in the banner to switch the main chart to that symbol

> **Power User Tip:** Select 5-10 of your most-traded markets instead of all 90. Too many simultaneous connections can slow down your browser.

---

### Position Sizing — Calculated Automatically

Advanced users never guess lot sizes. With IT Guru:

1. Enter your **account balance** in the Account Size section
2. Set your **risk per trade %** (start with 1%)
3. IT Guru calculates exact **position size** (lots) based on your stop loss distance

The formula used:
```
Dollar Risk = Account Balance x Risk %
Position Size (lots) = Dollar Risk / (SL distance in price x contract size)
```

This means every trade risks exactly the same percentage of your account, regardless of how wide the stop loss is.

---

### Using the Confluence Score to Prioritise Signals

When multiple signals fire across different markets or strategies, use the confluence score to prioritise:

| Score | Quality | Action |
|---|---|---|
| 12-16 | Excellent | High priority — consider taking |
| 8-11 | Good | Solid setup — use with normal risk |
| 4-7 | Fair | Lower quality — trade smaller or skip |
| 0-3 | Weak | Consider skipping unless strategy-specific |

---

### Auto-Trade — How It Works

Auto-Trade places **multiplier contracts** on your Deriv account automatically when a signal fires. To use it:

1. Enter your **Deriv API Token** with trading permissions enabled
2. In the **Auto-Trade** section, toggle on the signal source(s) you want automated:
   - **Breakout-Retest Trades** — core phase-6 signals
   - **Live Scalp Trades** — scalp scanner signals
   - **Strategy Trades** — individual strategy signals (12 sub-toggles)
3. Set your **Base Stake** (starting trade size, minimum $0.37)
4. Set a **Max Stake** cap (leave blank = 4x base)
5. Set **Multiplier** (contract leverage — default 100)
6. Optionally set a **Session TP** (stop auto-trading after a set dollar profit) and **Session SL** (stop after a set dollar loss)

**Compounding:** Stake automatically increases after 2 or more consecutive wins and resets to base on a loss.

**Safety cut:** Auto-trading halts after 3 consecutive losses to protect your account.

**Opposite Mode:** Enable **Opposite Mode** to automatically reverse every signal direction — a BUY signal fires a SELL contract, and vice versa. This is useful for markets where you have tested a counter-directional edge. The opposing-direction guard (which prevents opening a trade while one is already active in the opposite direction) checks the effective post-reversal direction so there are no conflicts.

**Candle-Close Processing:** By default, strategy entries and trade outcomes are evaluated only on **closed candles**. This prevents premature signals from wicks that do not confirm on close, and applies to both the main chart and any additional multi-symbol panels.

> CAUTION: Auto-Trade uses real money when connected with a live Deriv account. Fully understand the risks before enabling. Start on a demo account first.

---

### Backtesting Your Settings

IT Guru includes a **backtesting engine** that replays historical candle data through your current settings:

1. Ensure you have candles loaded (connect and wait for history to load)
2. Open the Backtest section in Settings
3. Set the replay speed
4. Press Start — the indicator replays each candle as if it were live
5. Review how many signals fired, how many were wins/losses, and what the confluence scores were

> Use backtesting to validate new settings before running them on a live account.

#### Which settings a Strategy Backtest run uses

The **Strategy Backtest** panel (per-strategy replay over downloaded history) picks its
filter configuration automatically:

- **Recommended mode (default).** Every advanced gate is reset to its documented
  default and then the **recommended settings for the symbol being replayed** are
  applied on top (timeframe, min R:R, range minutes, EMA/HTF/ATR/session/RSI/volume/
  Fibonacci/MACD/Bollinger/ADX/Stochastic filters). Each symbol is therefore tested with
  the configuration the app would actually recommend for it, instead of inheriting
  whatever the live chart happens to be tuned to. A hand-tuned gate such as a 11/16
  minimum-confluence threshold would otherwise silently reject every signal and the run
  would report zero trades for every strategy except Live Scalp.
- **Manual mode.** Turn on **Lock Strategy Filters** and the replay uses your manual
  configuration verbatim — the lock means "these are my settings, do not touch them".
  `Lock R:R` and `Lock Range Minutes` are honoured in recommended mode too.

The run status line and the report config both state which mode was used.

---

### Advanced Signal Interpretation Examples

**Example 1 — High-Score Priority:**
> Two signals fire simultaneously — V75 (1s) BUY with confluence score 14, EUR/USD SELL with score 6. Focus on the V75 signal — it has far stronger technical alignment.

**Example 2 — Conflicting Filters:**
> A BUY signal fires on GBP/USD but the HTF trend (EMA 100) is bearish and ADX shows 17 (ranging market). Two key filters disagree. Skip this trade and wait for better alignment.

**Example 3 — Tesla Scaling in Practice:**
> You enter a BUY on Boom 1000 at $12,000 with SL at $11,985 (15-point risk). T1 = 3R = $12,045. When price reaches $12,045, take 50% of your position off and move SL to breakeven ($12,000). T2 = 6R = $12,090, take another 30%. Let the final 20% run to T3 = 9R = $12,135 or trail it.

---

## 7. RISK MANAGEMENT AND RESPONSIBILITY

> This section is mandatory reading for all users, regardless of experience level.

### Trading Risk — The Reality

Trading financial markets is one of the most rewarding and most risky activities a person can undertake. The potential to grow capital is real — but so is the potential to lose it all. There is no version of trading that eliminates risk. IT Guru reduces guesswork through analysis, but it cannot remove risk from the equation.

Even the best trading systems in the world have losing periods. What determines long-term success is not winning every trade — it is managing risk so that losses are small and wins are larger.

---

### Why Trades Lose Even With Good Signals

- Markets are influenced by millions of participants — no analysis can account for all of them
- Major economic news events can override any technical setup instantly
- Synthetic indices have engineered statistical randomness built into their price generation
- Even a 70% win rate means 3 out of every 10 trades are losses — that is normal

A losing trade does not mean the indicator failed. It means you experienced the natural probability distribution of the market. What matters is your RR ratio — if you risk $1 to make $2 at a 60% win rate, you are mathematically profitable.

---

### The Three Pillars of Risk Management

#### 1. Always Use a Stop Loss

IT Guru always provides a stop loss level. Use it. Always.

- Set your stop loss before confirming the trade
- Never widen your stop loss because the trade is going against you — that turns a small loss into a large one
- Never trade without a stop loss — one unprotected trade can wipe weeks of profit

#### 2. Size Your Position Correctly

Risk a fixed, small percentage of your account on every single trade:

| Account Stage | Risk Per Trade |
|---|---|
| New / Learning | 0.5% of account |
| Developing | 1.0% of account |
| Consistent and Profitable | Up to 2.0% of account |

**Example:** $200 account x 1% = $2.00 maximum risk per trade.

Use IT Guru's built-in position size calculator — enter account balance and risk % and it does the maths for you.

#### 3. Emotional Discipline

- No revenge trading — after a loss, take a break, return with a clear head
- No over-trading — quality beats quantity; fewer, better trades beat many mediocre ones
- No greed — if your TP is hit, close the trade; do not hold for more without a plan
- No panic — if price moves against you but has not hit your SL, the trade is still valid; do not close early
- Trust the process — consistent, small risk per trade compounds into significant results over time

---

### Why No Signal Is Ever 100% Accurate

Technical analysis works on probabilities. IT Guru identifies setups where the statistical odds favour a particular outcome — but there is always uncertainty. Even a confluence score of 16/16 does not guarantee the trade will win.

Professional traders accept this. They focus on risk:reward and consistency, not on winning every trade.

---

### Client Accountability Statement

> By using IT Guru, you acknowledge that all signals and analysis provided are for educational and informational purposes only and do not constitute financial advice. You accept full responsibility for your own trading decisions, including the choice of whether to enter, manage, or exit any trade. IT Guru and its operators cannot be held liable for any losses incurred as a result of acting on signals, alerts, or analysis generated by this indicator. Always trade with money you can afford to lose.

---

## 8. LIMITATIONS OF THE INDICATOR

### Market Manipulation and Sudden Volatility

Large institutional players (banks, hedge funds, market makers) can move markets in ways that invalidate technical setups. A perfect-looking setup at a support level can be deliberately targeted by institutions to stop-hunt retail traders before the actual move.

IT Guru's Liquidity Sweep and Stop Loss Hunt strategies are specifically designed to identify and trade with these manipulation patterns — but they cannot predict every instance.

---

### News Impact (Forex)

For Forex pairs, major economic news releases cause extreme, sudden price moves that no technical indicator can anticipate:

- US Non-Farm Payrolls (NFP) — first Friday of each month
- Interest rate decisions (Federal Reserve, ECB, Bank of England)
- Inflation data (CPI, PPI)
- GDP releases, geopolitical events

> **Recommendation:** Enable the **Economic Calendar / News Pause** feature in Settings. This automatically pauses signal generation around high-impact news events. Also check **Forex Factory** or **Investing.com** for the daily economic calendar.

Deriv synthetic indices are **not affected by economic news** — they are computer-generated and run 24/7.

---

### Internet and Platform Dependency

IT Guru requires:
- A stable internet connection
- Deriv's WebSocket service to be operational
- Your browser to remain open and active

If your connection drops, IT Guru will attempt to **auto-reconnect** with exponential backoff. During any disconnection, candles and signals may be missed. The current phase will reset on reconnect.

> **Tip:** Use a reliable internet connection. On mobile, prefer WiFi over cellular for sustained sessions.

---

### Single-Symbol Focus

The core breakout-retest engine monitors one symbol at a time. While Multi-Symbol mode allows scanning multiple markets simultaneously, the main chart and detailed state panel always reflect the primary selected symbol.

---

### Why Human Judgment Still Matters

IT Guru is a sophisticated analytical engine — but it is not sentient. It processes numbers and patterns. It does not know:

- Your personal financial situation or risk tolerance
- Whether a news event is about to override the technical picture
- Whether you are having an emotional day
- Whether the market is in an unusual, low-liquidity condition

These are human factors that require human judgment. The indicator provides high-quality technical analysis — you provide the wisdom, context, and final decision.

---

## 9. QUICK START SUMMARY

*Your one-page guide to getting value from IT Guru today.*

---

### Getting Started — 5 Steps

1. **Log in** at `trading.dsitservicesja.com/indicator/` with your credentials
2. **Paste your Deriv API Token** in the API section (create one at app.deriv.com under API Token)
3. **Select a market** — recommended start: **Volatility 75 (1s)** on the **1-minute** timeframe
4. **Press Connect** (or Alt+C) — IT Guru begins collecting candles immediately
5. **Wait for a signal** — when Phase 6 (TRADE) fires, you will see the entry, SL, TP, and confluence score on the chart and receive a Telegram alert

---

### How to Get Maximum Value Fast

- **Start on a demo account** — practice the workflow without risking real money
- **Enable only 2-3 strategies at first** — Liquidity Sweep, Fib Golden Zone, and Live Scalp Scanner are excellent starting points
- **Set your account balance and risk %** — let IT Guru calculate position sizes for you automatically
- **Pay attention to confluence scores** — prioritise signals with scores of 8 or above and skip weak setups below 4
- **Review the State tab before each trade** — confirm EMA Filter and HTF Trend agree with the signal direction
- **Export your signals weekly** (CSV or PDF) and review what worked — learning from your own trade history is priceless

---

### Common Beginner Mistakes to Avoid

| Mistake | Why It Hurts | What to Do Instead |
|---|---|---|
| Ignoring the confluence score | Low-quality setups have higher failure rates | Prefer scores of 8 or above |
| Trading without a stop loss | One bad trade can wipe many wins | IT Guru always provides an SL — use it |
| Over-sizing positions | Losses feel catastrophic and cause panic | Use the 1% rule — let IT Guru calculate for you |
| Enabling too many strategies at once | Conflicting signals cause confusion | Start with 2-3 strategies |
| Ignoring HTF trend | Counter-trend trades fail more often | Check the State tab before every entry |
| Chasing missed signals | Late entries have poor RR | If price has moved past the entry, wait for the next setup |
| Trading Forex during news | News overrides all technical analysis | Check the economic calendar daily |
| Enabling Auto-Trade on a live account immediately | Real money at risk before understanding the system | Test on demo for 2 or more weeks first |
| Turning off filters after losses | Weakens signal quality further | Keep filters on — trust the confluence engine |
| Judging the system on one week | Too small a sample size | Evaluate over 3-6 months minimum |

---

## 10. FREQUENTLY ASKED QUESTIONS (FAQ)

---

**Can IT Guru guarantee profits?**

No. IT Guru identifies high-probability technical setups based on proven analysis methods. No indicator, system, or analyst can guarantee profits in financial markets. Your profitability depends on how you apply the signals, your risk management discipline, and market conditions.

---

**Is this financial advice?**

No. IT Guru provides technical analysis and trade setup identification only. It is not regulated financial advice. All trading decisions are yours alone. If you need personalised financial guidance, consult a licensed financial advisor.

---

**Can complete beginners use IT Guru?**

Yes — many beginners find it an excellent learning tool. The 6-phase display teaches you exactly what to look for in a trade. However, beginners should:
- Start on a **demo account**
- Read this manual in full
- Enable the **Auto-Apply Recommended** settings feature
- Start with just the core breakout-retest signals before exploring strategies

---

**Can I use it on a small account?**

Yes. IT Guru calculates position sizes based on any account size. A $50 account trading $0.50 risk per trade (1%) is just as disciplined as a $5,000 account. IT Guru supports Deriv multiplier contracts with a minimum stake of $0.37, making it accessible at any account size.

---

**Does IT Guru work on Forex or only Deriv synthetics?**

Both. IT Guru analyses all Deriv synthetic indices (Volatility, Boom, Crash, Jump, Step) and Forex pairs (majors, crosses, exotics) and commodities (Gold, Silver, Platinum, Palladium) — all within the same interface.

---

**Can results vary from month to month?**

Yes. Market conditions change constantly. A trending market produces more clean breakout setups; a choppy, sideways market produces more false breakouts. Evaluate performance over 3-6 months minimum. Short-term results can be misleading in either direction.

---

**What does the confluence score mean?**

The confluence score (0-16) measures how many of IT Guru's technical filters agree with the trade direction. A score of 12 means 12 out of 16 conditions align with the setup. Higher scores statistically correlate with stronger setups. Use it to prioritise when multiple signals fire simultaneously.

---

**What is Auto-Trade and is it safe?**

Auto-Trade places multiplier contracts on your Deriv account automatically when signals fire. It includes multiple safety mechanisms: compounding resets after losses, auto-halt after 3 consecutive losses, and session P/L limits. That said, real money is at risk — always test on demo first and only enable live auto-trade when you fully understand the system and accept the risk.

---

**How do I know which strategy to use?**

Start with the core breakout-retest engine (always active) and Live Scalp Scanner for fast markets. Add Liquidity Sweep and FVG as you grow comfortable. Advanced traders can run all 12 simultaneously and use the confluence score and session filter to prioritise.

---

**What platform do I need?**

IT Guru runs entirely in your **web browser** — no downloads or installations required. You need:
- A Deriv account (app.deriv.com)
- A Deriv API Token (generated in your Deriv account settings)
- A modern browser (Chrome, Firefox, Edge — latest version recommended)
- A stable internet connection

---

**What if IT Guru disconnects mid-session?**

IT Guru will automatically attempt to reconnect using exponential backoff. The current phase resets on reconnect and candle history is reloaded. To manually reconnect at any time, press the **Connect** button in the top bar.

---

**What is the Power of 3 Entry Freshness Mode?**

Entry Freshness controls how strictly IT Guru requires the FVG retrace to be timed:
- **SAFE** (default): allows entry up to 1 candle after the FVG touch — recommended for 1–5 min charts
- **STRICT**: only accepts the exact candle that touches the FVG — recommended for 15 min+ charts

You can change this in the Power of 3 settings panel next to the PO3 toggle.

---

**What does BREAKEVEN mean in a strategy outcome?**

If a strategy trade hits partial TP (price reached 1:1 profit and SL was moved to breakeven), and price then reverses back to close at the entry level, the outcome is classified as **BREAKEVEN** — not LOSS. This is tracked separately in your win/loss statistics and Telegram outcome messages.

---

**What is the MT5 bridge?**

The MT5 bridge is an optional integration that lets a MetaTrader 5 Expert Advisor (EA) receive IT Guru signals and execute trades automatically on your MT5 broker. See Section 11 for full details, or consult your administrator.

---

**What is Indicator V2?**

Indicator V2 is a second-generation version of IT Guru with an improved interface, accessible at `trading.dsitservicesja.com/indicatorv2/`. It runs with an isolated login session separate from V1. Access must be enabled by your administrator. See Section 12 for details.

---

**What is Opposite Mode in Auto-Trade?**

Opposite Mode reverses every signal direction before placing the auto-trade — a BUY signal triggers a SELL contract and vice versa. It is useful if you have tested a counter-trend edge on a specific market. Enable it in the Auto-Trade settings.

---

---

## 11. MT5 BRIDGE INTEGRATION

IT Guru includes a **MetaTrader 5 (MT5) bridge** that allows an MT5 Expert Advisor (EA) to receive signals from IT Guru and execute trades on any MT5-connected broker.

### How It Works

1. **IT Guru fires a signal** → the signal is queued via the web bridge at `api/mt5/signal.php`
2. **Your MT5 EA polls** `api/mt5/pull.php` every few seconds to pick up pending signals
3. **The EA executes the trade** on your MT5 broker account (entry, SL, TP automatically applied)
4. **The EA reports back** to `api/mt5/status.php` with order status (filled, partial, rejected)
5. **IT Guru polls** `api/mt5/order_status.php` to display the MT5 order status in the UI

### Bridge Endpoints Summary

| Endpoint | Direction | Purpose |
|---|---|---|
| `api/mt5/signal.php` | Web → Queue | IT Guru queues a new signal for MT5 |
| `api/mt5/pull.php` | EA → Web | EA fetches the next pending signal |
| `api/mt5/status.php` | EA → Web | EA reports back order fill status |
| `api/mt5/order_status.php` | Web → UI | UI polls for current MT5 order status |

### Setup Requirements

- A working MetaTrader 5 installation with an EA configured to call the bridge endpoints
- Your IT Guru server URL accessible from the MT5 machine
- Refer to `api/mt5/README.md` in the IT Guru files for the full payload format

> **Note:** MT5 bridge integration is an advanced feature intended for traders who run their own MT5 instance alongside IT Guru. Contact your administrator for setup assistance.

---

## 12. INDICATOR V2

IT Guru offers a second-generation interface, **Indicator V2**, accessible at `trading.dsitservicesja.com/indicatorv2/`.

### Key Differences

- V2 runs with an **isolated authentication session** — your V2 login is stored separately from the standard indicator, so you can be logged into both simultaneously.
- Access to V2 must be **granted by an administrator** (via the `indicator_v2` strategy key in the admin panel). Users without this key will not see the V2 option in the navigation.
- V2 uses the same core signal engine and strategies as V1, with improvements to the interface layout and panel management.

### Accessing V2

1. Log in at `trading.dsitservicesja.com/indicatorv2/`
2. If you have V2 access enabled, you will be taken to the V2 interface automatically
3. Your V2 settings are stored independently from your V1 settings

> Contact your administrator if you need V2 access enabled on your account.

---

## 13. XAUUSD SCALPING STRATEGY GUIDE

### Overview

Gold (XAUUSD) is one of the most liquid and volatile instruments available. IT Guru includes **XAUUSD-specific optimizations** — session filtering, 1H timeframe recommendations, London+NY session focus, Fibonacci alignment, and supply/demand zone detection — that make several strategies particularly effective for gold scalping.

This section ranks all 14 strategies by their suitability for **scalping XAUUSD for profits**.

---

### Tier 1 — Best Optimized for XAUUSD Scalping

| # | Strategy | Why It Excels on Gold |
|---|----------|----------------------|
| **4** | **Fib Golden Zone Scalp** | Purpose-built scalper. 1-min micro-trend → Golden Zone (0.5–0.618) retracement → entry. 15-candle timeout, 3-candle cooldown. Gold respects Fib levels extremely well during London/NY sessions. |
| **8** | **Grid Scalper MA** | Fast MA-crossover or BOS scalp with R:R tuned per asset class. Short cooldown (5 candles), confluence-gated. Gold's trending behavior during sessions makes MA crosses reliable. |
| — | **Live Scalp Scanner** | Multi-confluence scanner (7-factor scoring, min 3 required). Rapid 3-candle cooldown. Designed for real-time scalping — gold's structured moves produce high-quality confluence signals. |

---

### Tier 2 — Strong for XAUUSD (Intraday/Short-Term)

| # | Strategy | Notes |
|---|----------|-------|
| **5** | **Power of 3 (ICT)** | Gold loves ICT methodology. Accumulation → Manipulation → Expansion maps perfectly to London open. FVG-based entry, 30-candle timeout. |
| **1** | **Liquidity Sweep** | Gold has heavy liquidity pools at session highs/lows. 15m → 1m sweep detection with 1.5× ATR SL cap catches whipsaws well. |
| **2** | **Stop Loss Hunt** | Gold frequently hunts retail stop clusters at key S/R (3+ touches). Short cooldown, good for rapid re-entries. |
| **9** | **Fair Value Gap (FVG)** | Gold creates large FVGs during London/NY impulse moves. 60-candle lookback, Fib discount filter, engulfing confirmation at demand zones. |
| **12** | **Orderblock** | Institutional order blocks are powerful on gold. Pending-signal guard prevents spam. |

---

### Tier 3 — Usable but Not Ideal for Pure Scalping

| # | Strategy | Limitation |
|---|----------|------------|
| **3** | **Failed Pin Bar** | Works on gold but requires 3 consecutive fear/greed candles — slower setup formation. |
| **13** | **TikTok Fibonacci** | 4-step sequential process (A → B → C → D) with 80-candle lookback — too slow for pure scalping. Better for swing entries. |
| **11** | **MTF Top-Down** | Multi-timeframe synthesis (16× and 4× base TF). Excellent directional bias but entry timing too slow for scalping. 60-candle timeout. |
| **14** | **Candlestick Interpretation** | Multi-TF narrative analysis. High-quality signals but 60-candle timeout and complex setup = infrequent scalp opportunities. |
| **6/7** | **NY Open Range / Session Ranges** | Only active during specific 5-minute windows (9:30–9:35 EST). One trade per day max — not a scalping strategy, but the single trade on gold is often high-quality. |

---

### Recommended XAUUSD Scalping Stack

For maximum scalping profitability on gold, enable these strategies together:

1. **Fib Golden Zone Scalp** — your core scalp engine
2. **Grid Scalper MA** — catches MA-cross momentum entries
3. **Live Scalp Scanner** — confluence-based rapid signals
4. **Power of 3 (ICT)** — catches London/NY session manipulation moves
5. **Liquidity Sweep** — catches stop runs at session extremes

---

### Key Settings for Gold Scalping

| Setting | Recommendation |
|---------|---------------|
| **Scalping Mode** | ✅ Enable — activates 5-min range, 0.75× ATR trailing, 1:1 R:R, 15-candle auto-timeout |
| **Session Filter** | ✅ London + NY — gold spreads widen sharply outside peak hours |
| **Timeframe** | 1H or lower — balances gold's volatility with clean signal formation |
| **Confluence Gating** | ✅ Enable on Grid Scalper MA and TikTok Fib to reduce noise |
| **Partial TP** | ✅ Recommended — lock in profits on gold's sharp retracements |
| **Trailing Stop** | Standard (1.5× ATR) — allows gold's momentum moves to breathe |
| **Fibonacci** | ✅ Enable — gold's London/NY session swings are highly structured |
| **Supply/Demand Zones** | ✅ Enable HTF zones — gold respects Daily and 4H zones powerfully |

---

### Gold-Specific Notes

- **Best trading hours:** London session (07:00–12:00 UTC) and NY session (12:00–17:00 UTC) overlap produces the highest gold volatility and tightest spreads.
- **Avoid Asian session scalping** — gold typically consolidates with wider spreads and false breakouts.
- **Gold pip value:** Standard lot (100 oz) = ~$1 per $0.01 move. Micro lot (10 oz) = ~$0.10 per $0.01 move.
- **Typical scalp target:** 50–200 pips ($0.50–$2.00 per move on gold) during active sessions.
- **Risk management:** Gold's volatility means SL placement is critical. The ATR-based SL caps in Liquidity Sweep (1.5× ATR) and Grid Scalper MA (2.0× ATR) prevent oversized risk on spiky moves.

---
Best Strategies for Index Symbols & Profit Settings
Based on the IT Guru indicator documentation, here's your comprehensive strategy guide:

Best Strategies for Index Trading (Volatility, Boom, Crash, Jump, Step Indices)
Tier 1 — Top Performers for Indices:

Live Scalp Scanner ⭐ (Best for speed)

Multi-confluence rapid scanner (7 factors, min 3 required)
Best on: 1m charts and Volatility (1s) indices
Rapid 3-candle cooldown for frequent entries
Minimum Confluence: 8/16+
Fib Golden Zone Scalp ⭐ (Most consistent)

Purpose-built for micro-trends and Fibonacci retracements (0.5-0.618)
Best on: 1m charts, Volatility indices
15-candle timeout, 3-candle cooldown
Minimum Confluence: 9/16
Power of 3 (ICT) ⭐ (High-conviction)

FVG-based entries with hourly anchoring
Best Timeframe: 1m (highest frequency), 5m (balanced)
Recommended Minimum Confluence: 11/16
Entry Freshness Mode: SAFE (default) for 1-5m charts
Grid Scalper MA

MA-crossover or Break-of-Structure entries
Short 5-candle cooldown, confluence-gated
Best Timeframe: 1m-5m
Minimum Confluence: 8/16
Best Settings for Profit Optimization
Recommended Core Filters (All Indices):

✅ EMA 8/21 Trend Filter — ON
✅ HTF Trend Filter (EMA 100) — ON
✅ Partial TP (1:1) — ON (locks in profits, moves SL to breakeven)
✅ Trailing Stop — Standard (1.5× ATR)
✅ False Breakout Filter — ON
✅ Min R:R Gate — 2.0 minimum
✅ ADX Filter — ON for scalps (trending markets only)
✅ Volume Spike Filter — ON
✅ ATR-Based Tolerance — ON (more accurate on volatile markets)
Scalping Mode (For Volatility Indices):

✅ Scalping Mode — Enable
5-min range, 0.75× ATR trailing, 1:1 R:R, 15-candle auto-timeout
Timeframe Strategy:

Timeframe	Use Case	Confluence Score
1m	Highest signal frequency; freshest entries	9/16+
5m	Good balance of frequency & quality	9/16+
15m	Fewer setups; use STRICT entry freshness	10/16+
Profit Management (Tesla 3-6-9 Scaling Model)
Conservative Plan (Lower Risk):

T1 (3R): Take 50% profit, move SL to breakeven
T2 (6R): Take 30% profit, continue running
T3 (9R): Take 20% profit or trail final portion
Aggressive Plan (Higher Reward):

T1 (3R): Take 25% profit, move SL to breakeven
T2 (6R): Take 35% profit, continue running
T3 (9R): Take 20% and trail the final portion
Recommended Strategy Stack for Index Symbols
For maximum profitability, enable these together:

Live Scalp Scanner — Your rapid entry engine
Fib Golden Zone Scalp — Core scalp setup
Power of 3 (ICT) — High-confluence swing entries
Grid Scalper MA — Trend-following momentum
Liquidity Sweep — Catches stop runs (optional)
Key Success Factors
✅ Confluence Score: Prioritize signals with 8/16 or above
✅ HTF Alignment: Confirm with EMA 100 trend before entry
✅ Partial TP: Always lock profits at 1:1 to de-risk
✅ Session Timing: Best on Volatility (1s) indices 24/7, especially during active market hours
✅ Stop Loss: Use ATR-based calculations to prevent oversized risk
✅ Cool-Down Windows: Respect strategy timeouts (3-15 candles) to avoid spam signals

Start with: Demo account → Fib Golden Zone Scalp + Live Scalp Scanner → Add Power of 3 as you improve

---
*Trade smart. Manage your risk. Stay consistent.*

---

> **FINAL DISCLAIMER:** All content in this manual is for educational and informational purposes only. IT Guru is a technical analysis tool, not financial advice. Trading CFDs, Forex, and synthetic indices involves significant risk of loss and is not suitable for all investors. Never trade with funds you cannot afford to lose. Past signal performance is not indicative of future results.

---

*IT Guru — Breakout Retest Indicator | User Manual — All Rights Reserved*
