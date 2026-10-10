//+------------------------------------------------------------------+
//|                                   StepIndexProfitExtractor.mq5    |
//| Profit-extraction Expert Advisor for Deriv Step Index symbols.   |
//|                                                                   |
//| This EA is NOT a traditional "set TP/SL and wait" trend follower.|
//| It behaves like a professional Step Index scalper:               |
//|   Entry -> Quick Profit -> Close -> Re-Entry -> Repeat            |
//|                                                                   |
//| PIPELINE                                                          |
//|   1. Entry Confirmation Engine (4 selectable modes)               |
//|   2. Step Index Spike/Exhaustion Filter (avoid local highs/lows)  |
//|   3. Entry Quality Score (0-100) gate                             |
//|   4. Quick Profit Extraction (small point / ATR% targets)         |
//|   5. Profit Locking (breakeven -> lock -> tight trail)            |
//|   6. Auto Re-Entry Engine (trend/momentum/structure revalidation) |
//|   7. Session Analytics + Trade Analytics                          |
//|                                                                   |
//| Signals can come from the built-in EMA/momentum engine, or from   |
//| an external custom indicator (InpUseExternalIndicator=true).      |
//|                                                                   |
//| DEPLOYMENT                                                        |
//|   1. Attach to a Step Index chart (e.g. "Step Index", "Step Index |
//|      200", "Step Index 500" ...).                                 |
//|   2. Enable "Allow Algo Trading".                                 |
//|   3. No martingale / grid / averaging: one setup, one risk, one   |
//|      execution at a time per chart.                               |
//|   4. ALWAYS test on a demo account before going live.             |
//+------------------------------------------------------------------+
#property strict
#property copyright "ITGuru"
#property version   "1.00"

//================================= Enums =====================================

enum ENTRY_CONFIRM_MODE
{
   CONFIRM_ONE_CANDLE       = 0, // Mode 1: single candle-close confirmation
   CONFIRM_BREAK_RETEST     = 1, // Mode 2: break and retest
   CONFIRM_MOMENTUM_CONT    = 2, // Mode 3: momentum continuation (N closes)
   CONFIRM_ADAPTIVE         = 3  // Mode 4: adaptive (volatility-based choice)
};

//================================= Inputs ===================================

input string Inp_SymbolHeader        = "===== Step Index Filter ====="; // (label)
input bool   InpRestrictToStepIndex  = true;   // refuse to trade on non Step-Index charts
input string InpAllowedSymbolKeywords= "Step Index,stpRNG,Step,STEP"; // comma-separated, case-insensitive substrings

input string Inp_ConfirmHeader       = "===== Entry Confirmation Engine ====="; // (label)
input ENTRY_CONFIRM_MODE InpConfirmMode = CONFIRM_ADAPTIVE; // confirmation mode
input int    InpMomentumConfirmCandles = 2;     // Mode 3: consecutive directional closes required
input int    InpMaxConfirmationBars   = 6;       // cancel a pending setup if not confirmed within this many bars
input double InpRetestTolerancePoints = 15;      // Mode 2: max distance from break level considered a valid retest

input string Inp_SpikeFilterHeader   = "===== Spike / Exhaustion Filter =====";  // (label)
input double InpSpikeAtrMultiple     = 1.8;      // candle range > ATR * this => spike candle
input int    InpExhaustionLookback   = 3;        // consecutive same-direction spikes => exhaustion
input double InpMinRetracePct        = 30.0;     // required retracement of the last spike range (%) before re-entry

input string Inp_SignalHeader        = "===== Signal Source =====";  // (label)
input int    InpFastMAPeriod         = 8;
input int    InpSlowMAPeriod         = 21;
input int    InpAtrPeriod            = 14;
input bool   InpUseExternalIndicator = false;    // true = pull signal from a custom indicator instead of built-in EMA engine
input string InpExternalIndicatorName= "";       // e.g. "Market\\MySignalIndicator"
input int    InpExternalBuyBuffer    = 0;
input int    InpExternalSellBuffer   = 1;

input string Inp_QualityHeader       = "===== Entry Quality Score =====";  // (label)
input int    InpMinQualityScore      = 65;       // 0-100, only trade at/above this score
input int    InpStructureLookback    = 40;       // bars scanned for swing HH/HL or LH/LL structure

input string Inp_RiskHeader          = "===== Execution & Risk =====";  // (label)
input double InpLotSize              = 0.10;
input long   InpMagic                = 90210001;
input int    InpMaxSlippagePoints    = 20;
input double InpProtectiveSLAtrMult  = 2.5;      // hard protective stop = ATR * this (never widened, never grid/martingale)
input int    InpMaxOrderRetries      = 2;
input int    InpRetryDelayMs         = 300;

input string Inp_ProfitHeader        = "===== Quick Profit Extraction =====";  // (label)
input bool   InpUseAtrTarget         = false;    // false = fixed points target, true = ATR percentage target
input double InpTakeProfitPoints     = 15;       // used when InpUseAtrTarget == false
input double InpAtrTargetPct         = 35.0;     // used when InpUseAtrTarget == true (percent of current ATR, in points)

input string Inp_LockHeader          = "===== Profit Locking =====";  // (label)
input double InpBreakevenTriggerPts  = 6;        // Level 1: move SL to entry once profit reaches this many points
input double InpBreakevenLockPts     = 1;        // small buffer locked in at breakeven
input double InpLockTriggerPts       = 10;       // Level 2: lock in partial profit once profit reaches this many points
input double InpLockProfitPts        = 5;        // points of profit guaranteed at Level 2
input double InpTrailTriggerPts      = 13;       // Level 3: start tight trailing once profit reaches this many points
input double InpTrailDistancePts     = 4;        // tight trailing distance once active

input string Inp_ReentryHeader       = "===== Auto Re-Entry Engine =====";  // (label)
input bool   InpEnableAutoReentry    = true;
input int    InpReentryCooldownSecs  = 5;        // minimum pause after a close before scanning for re-entry

input string Inp_SessionHeader       = "===== Session Analysis =====";  // (label)
input bool   InpUseSessionAdaptive   = true;      // relax/tighten quality threshold based on historical hour performance
input int    InpSessionMinSamples    = 5;         // minimum trades in an hour bucket before adapting its threshold
input int    InpSessionAdaptivePoints= 8;         // max +/- points applied to quality threshold per hour bucket

input string Inp_LoggingHeader       = "===== Logging =====";  // (label)
input bool   InpVerboseLogging       = true;

//================================= Types =====================================

struct PendingSetup
{
   bool     active;
   int      direction;           // +1 buy, -1 sell
   ENTRY_CONFIRM_MODE modeUsed;
   datetime signalBarTime;
   double   breakLevel;          // Mode 2
   bool     retested;            // Mode 2
   int      momentumCount;       // Mode 3
   double   lastTrackedClose;    // Mode 3
   int      barsWaited;
   bool     isReentry;
};

struct TradeRecord
{
   datetime openTime;
   datetime closeTime;
   int      direction;
   double   entryPrice;
   double   closePrice;
   double   atrAtEntry;
   int      qualityScore;
   ENTRY_CONFIRM_MODE modeUsed;
   double   profit;
   int      hourOfDay;
};

struct HourStats
{
   int    trades;
   int    wins;
   double netProfit;
};

//================================= Globals ===================================

int      g_handleFastMA  = INVALID_HANDLE;
int      g_handleSlowMA  = INVALID_HANDLE;
int      g_handleAtr     = INVALID_HANDLE;
int      g_handleExternal = INVALID_HANDLE;

datetime g_lastBarTime   = 0;

PendingSetup g_pending;

ulong    g_openTicket    = 0;     // 0 = no position currently managed
datetime g_openTime      = 0;
int      g_openDirection = 0;
double   g_openEntryPrice= 0.0;
double   g_openAtr       = 0.0;
int      g_openQuality   = 0;
ENTRY_CONFIRM_MODE g_openMode = CONFIRM_ONE_CANDLE;
bool     g_openBreakevenDone = false;
bool     g_openLockDone      = false;
bool     g_openTrailActive   = false;

bool     g_awaitingReentry = false;
int      g_reentryDirection= 0;
datetime g_reentryReadyAt  = 0;

// Edge-triggered diagnostic state: avoids re-printing the same warning every
// tick/bar while still guaranteeing it is logged the moment a blocking
// condition starts (or stops).
bool     g_lastAutoTradingAllowed   = true;
bool     g_lastSymbolFilterPassed   = true;

// Spike/exhaustion tracking
int      g_consecutiveSpikeDirection = 0; // +1/-1 run of same-direction spike candles
int      g_consecutiveSpikeCount     = 0;
double   g_lastSpikeRangeHigh        = 0.0;
double   g_lastSpikeRangeLow         = 0.0;
bool     g_lastSpikeWasUp            = false;

// Analytics
TradeRecord g_trades[];
int      g_totalTrades      = 0;
int      g_totalWins        = 0;
int      g_totalLosses      = 0;
double   g_grossProfit      = 0.0;
double   g_grossLoss        = 0.0;
int      g_consecutiveWins  = 0;
int      g_consecutiveLosses= 0;
int      g_maxConsecutiveWins   = 0;
int      g_maxConsecutiveLosses = 0;

HourStats g_hourStats[24];

//================================= Utility ===================================

void LogInfo(string msg)
{
   if(InpVerboseLogging)
      Print("[StepIndexProfitExtractor] ", msg);
}

// Always printed regardless of InpVerboseLogging: used for conditions that
// explain "no trades executing" (permissions, environment) so they are never
// accidentally silenced by the verbose-logging toggle.
void LogWarn(string msg)
{
   Print("[StepIndexProfitExtractor] WARNING: ", msg);
}

// Human-readable text for the trade server return codes most commonly seen
// when "no trades execute" despite a confirmed, quality-gated setup.
string TradeRetcodeDescription(uint retcode)
{
   switch(retcode)
   {
      case TRADE_RETCODE_DONE:              return "done";
      case TRADE_RETCODE_DONE_PARTIAL:      return "done partially";
      case TRADE_RETCODE_REQUOTE:           return "requote";
      case TRADE_RETCODE_REJECT:            return "request rejected";
      case TRADE_RETCODE_CONNECTION:        return "no connection to trade server";
      case TRADE_RETCODE_TIMEOUT:           return "request timed out";
      case TRADE_RETCODE_INVALID:           return "invalid request";
      case TRADE_RETCODE_INVALID_VOLUME:    return "invalid volume (check broker's min/max/step lot size)";
      case TRADE_RETCODE_INVALID_PRICE:     return "invalid price";
      case TRADE_RETCODE_INVALID_STOPS:     return "invalid stops (SL/TP violate broker's stop level/freeze level)";
      case TRADE_RETCODE_TRADE_DISABLED:    return "trading is disabled for this account/symbol";
      case TRADE_RETCODE_MARKET_CLOSED:     return "market is closed";
      case TRADE_RETCODE_NO_MONEY:          return "not enough money/margin";
      case TRADE_RETCODE_PRICE_CHANGED:     return "price changed";
      case TRADE_RETCODE_PRICE_OFF:         return "no quotes to process request";
      case TRADE_RETCODE_LIMIT_ORDERS:      return "pending orders limit reached";
      case TRADE_RETCODE_LIMIT_VOLUME:      return "volume limit reached";
      case TRADE_RETCODE_CLIENT_DISABLES_AT:return "automated trading disabled by client terminal (enable the 'Algo Trading' button)";
      case TRADE_RETCODE_SERVER_DISABLES_AT:return "automated trading disabled by trade server";
      case TRADE_RETCODE_LOCKED:            return "request locked for processing";
      case TRADE_RETCODE_FROZEN:            return "order/position frozen";
      case TRADE_RETCODE_INVALID_FILL:      return "unsupported order filling type (try a different InpMaxSlippagePoints/filling mode)";
      case TRADE_RETCODE_CONNECTION:        return "no connection";
      case TRADE_RETCODE_ONLY_REAL:         return "operation allowed only for live accounts";
      default:                             return "retcode " + (string)retcode;
   }
}

// Checks the three independent switches that must ALL be on for an EA to be
// able to send orders: the terminal's global "Algo Trading" button, this
// EA's own "Allow Algo Trading" permission, and the account/server-side
// permission. Any one of them being off silently blocks every OrderSend()
// call without the EA itself failing to compile or run.
bool IsAutoTradingAllowed()
{
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED))
      return false;
   if(!MQLInfoInteger(MQL_TRADE_ALLOWED))
      return false;
   if(!AccountInfoInteger(ACCOUNT_TRADE_ALLOWED))
      return false;
   if(!AccountInfoInteger(ACCOUNT_TRADE_EXPERT))
      return false;
   return true;
}

bool IsStepIndexSymbol()
{
   if(!InpRestrictToStepIndex)
      return true;

   string sym = _Symbol;
   string upperSym = sym;
   StringToUpper(upperSym);

   string keywords[];
   int n = StringSplit(InpAllowedSymbolKeywords, ',', keywords);
   for(int i=0; i<n; i++)
   {
      string kw = keywords[i];
      StringTrimLeft(kw);
      StringTrimRight(kw);
      if(StringLen(kw) == 0)
         continue;
      string upperKw = kw;
      StringToUpper(upperKw);
      if(StringFind(upperSym, upperKw) >= 0)
         return true;
   }
   return false;
}

double PointValue()
{
   return SymbolInfoDouble(_Symbol, SYMBOL_POINT);
}

double PointsToPrice(double points)
{
   return points * PointValue();
}

double GetAtr(int shift=0)
{
   double buf[];
   ArraySetAsSeries(buf, true);
   if(CopyBuffer(g_handleAtr, 0, shift, 1, buf) <= 0)
      return 0.0;
   return buf[0];
}

double GetMA(int handle, int shift=0)
{
   double buf[];
   ArraySetAsSeries(buf, true);
   if(CopyBuffer(handle, 0, shift, 1, buf) <= 0)
      return 0.0;
   return buf[0];
}

//================================= Init / Deinit =============================

int OnInit()
{
   ArrayResize(g_trades, 0);
   for(int i=0; i<24; i++)
   {
      g_hourStats[i].trades = 0;
      g_hourStats[i].wins   = 0;
      g_hourStats[i].netProfit = 0.0;
   }

   ZeroMemory(g_pending);

   // Reset spike/exhaustion and re-entry tracking state explicitly: unlike a
   // fresh terminal load, changing EA inputs only triggers OnDeinit/OnInit
   // without clearing module-level globals, so stale state must be cleared here.
   g_consecutiveSpikeDirection = 0;
   g_consecutiveSpikeCount     = 0;
   g_lastSpikeRangeHigh        = 0.0;
   g_lastSpikeRangeLow         = 0.0;
   g_lastSpikeWasUp            = false;
   g_awaitingReentry           = false;
   g_reentryDirection          = 0;
   g_reentryReadyAt            = 0;

   g_lastAutoTradingAllowed    = IsAutoTradingAllowed();
   g_lastSymbolFilterPassed    = true;

   g_handleFastMA = iMA(_Symbol, _Period, InpFastMAPeriod, 0, MODE_EMA, PRICE_CLOSE);
   g_handleSlowMA = iMA(_Symbol, _Period, InpSlowMAPeriod, 0, MODE_EMA, PRICE_CLOSE);
   g_handleAtr    = iATR(_Symbol, _Period, InpAtrPeriod);

   if(g_handleFastMA==INVALID_HANDLE || g_handleSlowMA==INVALID_HANDLE || g_handleAtr==INVALID_HANDLE)
   {
      Print("[StepIndexProfitExtractor] Failed to create indicator handles.");
      return(INIT_FAILED);
   }

   if(InpUseExternalIndicator)
   {
      if(StringLen(InpExternalIndicatorName) == 0)
      {
         Print("[StepIndexProfitExtractor] InpUseExternalIndicator=true but InpExternalIndicatorName is empty.");
         return(INIT_FAILED);
      }
      g_handleExternal = iCustom(_Symbol, _Period, InpExternalIndicatorName);
      if(g_handleExternal == INVALID_HANDLE)
      {
         Print("[StepIndexProfitExtractor] Failed to load external indicator: ", InpExternalIndicatorName);
         return(INIT_FAILED);
      }
   }

   if(!IsStepIndexSymbol())
      Print("[StepIndexProfitExtractor] WARNING: chart symbol '", _Symbol, "' does not look like a Step Index. New entries are disabled until attached to one (InpRestrictToStepIndex=true).");

   if(!g_lastAutoTradingAllowed)
      LogWarn("Automated trading is NOT currently allowed (terminal 'Algo Trading' button, this EA's 'Allow Algo Trading' setting, or the account's expert-trading permission is off). No orders will be sent until this is enabled.");

   g_lastBarTime = 0;
   LogInfo("Initialized on " + _Symbol + " (" + EnumToString((ENUM_TIMEFRAMES)_Period) + ")");
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   if(g_handleFastMA != INVALID_HANDLE) IndicatorRelease(g_handleFastMA);
   if(g_handleSlowMA != INVALID_HANDLE) IndicatorRelease(g_handleSlowMA);
   if(g_handleAtr    != INVALID_HANDLE) IndicatorRelease(g_handleAtr);
   if(g_handleExternal != INVALID_HANDLE) IndicatorRelease(g_handleExternal);

   PrintAnalyticsSummary();
}

//================================= Analytics =================================

void PrintAnalyticsSummary()
{
   double winRate = (g_totalTrades>0) ? (100.0 * g_totalWins / g_totalTrades) : 0.0;
   double profitFactor = (g_grossLoss > 0.0) ? (g_grossProfit / g_grossLoss) : (g_grossProfit>0.0 ? 999.0 : 0.0);
   double avgProfit = (g_totalWins>0) ? (g_grossProfit / g_totalWins) : 0.0;
   double avgLoss   = (g_totalLosses>0) ? (g_grossLoss / g_totalLosses) : 0.0;

   Print("===== StepIndexProfitExtractor Analytics =====");
   Print("Total Trades: ", g_totalTrades, " Wins: ", g_totalWins, " Losses: ", g_totalLosses);
   Print("Win Rate: ", DoubleToString(winRate,2), "%  Profit Factor: ", DoubleToString(profitFactor,2));
   Print("Avg Win: ", DoubleToString(avgProfit,2), "  Avg Loss: ", DoubleToString(avgLoss,2));
   Print("Max Consecutive Wins: ", g_maxConsecutiveWins, "  Max Consecutive Losses: ", g_maxConsecutiveLosses);

   int bestHour=-1; double bestNet=-1e18;
   for(int h=0; h<24; h++)
   {
      if(g_hourStats[h].trades>0 && g_hourStats[h].netProfit>bestNet)
      {
         bestNet = g_hourStats[h].netProfit;
         bestHour = h;
      }
   }
   if(bestHour>=0)
      Print("Most profitable hour (server time): ", bestHour, ":00  net=", DoubleToString(bestNet,2));
}

void RecordClosedTrade(int direction, double entryPrice, double closePrice, double atrAtEntry,
                        int qualityScore, ENTRY_CONFIRM_MODE modeUsed, double profit, datetime openTime, datetime closeTime)
{
   int n = ArraySize(g_trades);
   ArrayResize(g_trades, n+1);
   g_trades[n].openTime    = openTime;
   g_trades[n].closeTime   = closeTime;
   g_trades[n].direction   = direction;
   g_trades[n].entryPrice  = entryPrice;
   g_trades[n].closePrice  = closePrice;
   g_trades[n].atrAtEntry  = atrAtEntry;
   g_trades[n].qualityScore= qualityScore;
   g_trades[n].modeUsed    = modeUsed;
   g_trades[n].profit      = profit;

   MqlDateTime dt;
   TimeToStruct(closeTime, dt);
   g_trades[n].hourOfDay = dt.hour;

   g_totalTrades++;
   if(profit >= 0.0)
   {
      g_totalWins++;
      g_grossProfit += profit;
      g_consecutiveWins++;
      g_consecutiveLosses = 0;
      if(g_consecutiveWins > g_maxConsecutiveWins) g_maxConsecutiveWins = g_consecutiveWins;
   }
   else
   {
      g_totalLosses++;
      g_grossLoss += MathAbs(profit);
      g_consecutiveLosses++;
      g_consecutiveWins = 0;
      if(g_consecutiveLosses > g_maxConsecutiveLosses) g_maxConsecutiveLosses = g_consecutiveLosses;
   }

   int h = dt.hour;
   g_hourStats[h].trades++;
   g_hourStats[h].netProfit += profit;
   if(profit >= 0.0) g_hourStats[h].wins++;

   LogInfo("Trade closed. dir=" + (string)direction + " profit=" + DoubleToString(profit,2) +
           " quality=" + (string)qualityScore + " mode=" + EnumToString(modeUsed) +
           " | WinRate=" + DoubleToString((100.0*g_totalWins/g_totalTrades),1) + "%");
}

int SessionAdaptiveQualityThreshold()
{
   int baseThreshold = InpMinQualityScore;
   if(!InpUseSessionAdaptive)
      return baseThreshold;

   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   int h = dt.hour;

   if(g_hourStats[h].trades == 0 || g_hourStats[h].trades < InpSessionMinSamples)
      return baseThreshold;

   double hourWinRate = 100.0 * g_hourStats[h].wins / g_hourStats[h].trades;
   double overallWinRate = (g_totalTrades>0) ? (100.0*g_totalWins/g_totalTrades) : hourWinRate;

   if(hourWinRate > overallWinRate + 5.0 && g_hourStats[h].netProfit > 0.0)
      return (int)MathMax(0, baseThreshold - InpSessionAdaptivePoints); // more aggressive in strong hours
   if(hourWinRate < overallWinRate - 5.0 || g_hourStats[h].netProfit < 0.0)
      return (int)MathMin(100, baseThreshold + InpSessionAdaptivePoints); // more conservative in weak hours

   return baseThreshold;
}

//================================= Spike / Exhaustion Filter ==================

bool IsSpikeCandle(int shift, double atr, bool &wasUp)
{
   double high = iHigh(_Symbol, _Period, shift);
   double low  = iLow(_Symbol, _Period, shift);
   double open = iOpen(_Symbol, _Period, shift);
   double close= iClose(_Symbol, _Period, shift);
   double range = high - low;

   wasUp = (close >= open);

   if(atr <= 0.0)
      return false;

   return (range > atr * InpSpikeAtrMultiple);
}

// Updates the rolling spike/exhaustion tracker for the most recently closed bar.
void UpdateSpikeTracker()
{
   double atr = GetAtr(1); // ATR at the bar that just closed
   bool wasUp = false;
   bool spike = IsSpikeCandle(1, atr, wasUp);

   if(!spike)
   {
      g_consecutiveSpikeDirection = 0;
      g_consecutiveSpikeCount = 0;
      return;
   }

   int dir = wasUp ? 1 : -1;
   if(dir == g_consecutiveSpikeDirection)
      g_consecutiveSpikeCount++;
   else
   {
      g_consecutiveSpikeDirection = dir;
      g_consecutiveSpikeCount = 1;
   }

   g_lastSpikeRangeHigh = iHigh(_Symbol, _Period, 1);
   g_lastSpikeRangeLow  = iLow(_Symbol, _Period, 1);
   g_lastSpikeWasUp     = wasUp;
}

bool IsExhaustionActive()
{
   return (g_consecutiveSpikeCount >= InpExhaustionLookback);
}

// True once price has retraced the required percentage of the last spike range.
bool HasSufficientRetracement(int direction)
{
   if(g_consecutiveSpikeCount == 0)
      return true; // no recent spike to worry about

   double range = g_lastSpikeRangeHigh - g_lastSpikeRangeLow;
   if(range <= 0.0)
      return true;

   double currentPrice = (direction>0) ? SymbolInfoDouble(_Symbol, SYMBOL_BID) : SymbolInfoDouble(_Symbol, SYMBOL_ASK);

   double retracePct;
   if(g_lastSpikeWasUp)
      retracePct = 100.0 * (g_lastSpikeRangeHigh - currentPrice) / range;
   else
      retracePct = 100.0 * (currentPrice - g_lastSpikeRangeLow) / range;

   return (retracePct >= InpMinRetracePct);
}

// Overall Step Index gate: refuse entries immediately after impulse/exhaustion
// candles until a real pullback/retracement/confirmation has occurred.
bool PassesStepIndexFilter(int direction)
{
   if(IsExhaustionActive())
   {
      // only allow trading WITH an exhausted spike after sufficient retracement,
      // never immediately at the extreme.
      if(!HasSufficientRetracement(direction))
         return false;
   }

   double atr = GetAtr(1);
   bool wasUp=false;
   if(IsSpikeCandle(1, atr, wasUp))
   {
      // the most recent closed candle is itself a spike/impulse -> require pullback first
      if(!HasSufficientRetracement(direction))
         return false;
   }

   return true;
}

//================================= Structure Detection ========================

// Scans the last InpStructureLookback bars for simple 2-bar fractals and
// determines whether the most recent two swing highs/lows form an uptrend
// (HH/HL) or downtrend (LH/LL) structure.
bool DetectStructure(int direction)
{
   int lookback = InpStructureLookback;
   double swingHighs[]; double swingLows[];
   ArrayResize(swingHighs, 0);
   ArrayResize(swingLows, 0);

   for(int i=lookback; i>=2; i--)
   {
      double h0 = iHigh(_Symbol, _Period, i);
      double h1 = iHigh(_Symbol, _Period, i+1);
      double h2 = iHigh(_Symbol, _Period, i-1);
      if(h0 > h1 && h0 > h2)
      {
         int n = ArraySize(swingHighs);
         ArrayResize(swingHighs, n+1);
         swingHighs[n] = h0;
      }

      double l0 = iLow(_Symbol, _Period, i);
      double l1 = iLow(_Symbol, _Period, i+1);
      double l2 = iLow(_Symbol, _Period, i-1);
      if(l0 < l1 && l0 < l2)
      {
         int n = ArraySize(swingLows);
         ArrayResize(swingLows, n+1);
         swingLows[n] = l0;
      }
   }

   int nh = ArraySize(swingHighs);
   int nl = ArraySize(swingLows);
   if(nh < 2 || nl < 2)
      return false;

   bool higherHigh = swingHighs[nh-1] > swingHighs[nh-2];
   bool higherLow  = swingLows[nl-1]  > swingLows[nl-2];
   bool lowerHigh  = swingHighs[nh-1] < swingHighs[nh-2];
   bool lowerLow   = swingLows[nl-1]  < swingLows[nl-2];

   if(direction > 0)
      return (higherHigh && higherLow);
   else
      return (lowerHigh && lowerLow);
}

//================================= Raw Signal Detection ========================

// Returns +1 (buy), -1 (sell) or 0 (none), based on the freshly closed bar (shift=1).
int GetRawSignal()
{
   if(InpUseExternalIndicator)
   {
      double buyBuf[]; double sellBuf[];
      ArraySetAsSeries(buyBuf, true);
      ArraySetAsSeries(sellBuf, true);
      bool haveBuy  = (CopyBuffer(g_handleExternal, InpExternalBuyBuffer, 1, 1, buyBuf) > 0);
      bool haveSell = (CopyBuffer(g_handleExternal, InpExternalSellBuffer, 1, 1, sellBuf) > 0);

      bool buySignal  = haveBuy  && buyBuf[0]  != EMPTY_VALUE && buyBuf[0]  != 0.0;
      bool sellSignal = haveSell && sellBuf[0] != EMPTY_VALUE && sellBuf[0] != 0.0;

      if(buySignal && !sellSignal) return 1;
      if(sellSignal && !buySignal) return -1;
      return 0;
   }

   // Built-in engine: EMA cross/alignment + simple momentum slope.
   double fastNow  = GetMA(g_handleFastMA, 1);
   double slowNow  = GetMA(g_handleSlowMA, 1);
   double fastPrev = GetMA(g_handleFastMA, 2);
   double slowPrev = GetMA(g_handleSlowMA, 2);

   bool bullCross = (fastPrev <= slowPrev) && (fastNow > slowNow);
   bool bearCross = (fastPrev >= slowPrev) && (fastNow < slowNow);

   if(bullCross) return 1;
   if(bearCross) return -1;
   return 0;
}

//================================= Quality Score ==============================

int ComputeQualityScore(int direction, ENTRY_CONFIRM_MODE modeUsed, int momentumCount, bool retested)
{
   double fastNow = GetMA(g_handleFastMA, 1);
   double slowNow = GetMA(g_handleSlowMA, 1);
   double atr     = GetAtr(1);
   if(atr <= 0.0) atr = PointValue();

   // --- Trend score (0-25): normalized EMA separation relative to ATR.
   double sep = MathAbs(fastNow - slowNow) / atr;
   int trendScore = (int)MathMin(25.0, sep * 50.0);

   // --- Momentum score (0-25): rate of change of close over last 3 bars vs ATR.
   double closeNow  = iClose(_Symbol, _Period, 1);
   double closeBack = iClose(_Symbol, _Period, 4);
   double roc = (closeNow - closeBack) / atr;
   if(direction < 0) roc = -roc;
   int momentumScore = (int)MathMax(0.0, MathMin(25.0, roc * 20.0));

   // --- Volatility score (0-20): reward normal volatility, penalize spikes/exhaustion.
   int volatilityScore = 20;
   bool wasUp=false;
   if(IsSpikeCandle(1, atr, wasUp)) volatilityScore -= 12;
   if(IsExhaustionActive())        volatilityScore -= 8;
   if(volatilityScore < 0) volatilityScore = 0;

   // --- Confirmation score (0-15): depends on which mode confirmed the entry.
   int confirmScore = 0;
   switch(modeUsed)
   {
      case CONFIRM_ONE_CANDLE:    confirmScore = 8; break;
      case CONFIRM_BREAK_RETEST:  confirmScore = retested ? 15 : 10; break;
      case CONFIRM_MOMENTUM_CONT: confirmScore = (int)MathMin(15, 6 + momentumCount*3); break;
      case CONFIRM_ADAPTIVE:      confirmScore = 12; break;
      default: confirmScore = 5; break;
   }

   // --- Structure score (0-15): HH/HL or LH/LL confirmation.
   int structureScore = DetectStructure(direction) ? 15 : 5;

   int total = trendScore + momentumScore + volatilityScore + confirmScore + structureScore;
   if(total > 100) total = 100;
   if(total < 0) total = 0;
   return total;
}

//================================= Confirmation State Machine =================

ENTRY_CONFIRM_MODE ResolveAdaptiveMode()
{
   double atrNow = GetAtr(1);
   double sumAtr = 0.0;
   int samples = 20;
   for(int i=1; i<=samples; i++)
      sumAtr += GetAtr(i);
   double avgAtr = (samples>0) ? sumAtr/samples : atrNow;
   if(avgAtr <= 0.0) return CONFIRM_ONE_CANDLE;

   double ratio = atrNow / avgAtr;
   if(ratio > 1.3) return CONFIRM_BREAK_RETEST;   // volatile -> require retest
   if(ratio < 0.8) return CONFIRM_ONE_CANDLE;      // calm -> simple confirmation suffices
   return CONFIRM_MOMENTUM_CONT;                   // normal -> momentum continuation
}

void StartPendingSetup(int direction, bool isReentry)
{
   ENTRY_CONFIRM_MODE mode = InpConfirmMode;
   if(mode == CONFIRM_ADAPTIVE)
      mode = ResolveAdaptiveMode();

   g_pending.active        = true;
   g_pending.direction     = direction;
   g_pending.modeUsed      = mode;
   g_pending.signalBarTime = iTime(_Symbol, _Period, 1);
   g_pending.breakLevel    = (direction>0) ? iHigh(_Symbol, _Period, 1) : iLow(_Symbol, _Period, 1);
   g_pending.retested      = false;
   g_pending.momentumCount = 1;
   g_pending.lastTrackedClose = iClose(_Symbol, _Period, 1);
   g_pending.barsWaited    = 0;
   g_pending.isReentry     = isReentry;

   LogInfo("Pending setup started. dir=" + (string)direction + " mode=" + EnumToString(mode) +
           " isReentry=" + (string)isReentry);
}

void CancelPendingSetup(string why)
{
   if(g_pending.active)
      LogInfo("Pending setup cancelled: " + why);
   ZeroMemory(g_pending);
}

// Advances the pending setup state machine by one closed bar. Returns true
// when the setup is confirmed and ready for execution.
bool AdvancePendingSetup()
{
   if(!g_pending.active)
      return false;

   g_pending.barsWaited++;
   if(g_pending.barsWaited > InpMaxConfirmationBars)
   {
      CancelPendingSetup("timed out waiting for confirmation");
      return false;
   }

   double closeNow = iClose(_Symbol, _Period, 1);
   int dir = g_pending.direction;

   switch(g_pending.modeUsed)
   {
      case CONFIRM_ONE_CANDLE:
      {
         bool confirmed = (dir>0) ? (closeNow > g_pending.breakLevel) : (closeNow < g_pending.breakLevel);
         if(g_pending.barsWaited >= 1)
         {
            if(confirmed) return true;
            CancelPendingSetup("one-candle confirmation failed");
            return false;
         }
         break;
      }

      case CONFIRM_BREAK_RETEST:
      {
         double tolerance = PointsToPrice(InpRetestTolerancePoints);
         if(!g_pending.retested)
         {
            double dist = MathAbs(closeNow - g_pending.breakLevel);
            if(dist <= tolerance)
               g_pending.retested = true;
            // invalidate if price closes back through the level against the direction by more than tolerance
            if(dir>0 && closeNow < g_pending.breakLevel - tolerance)
            {
               CancelPendingSetup("break & retest invalidated (closed back below level)");
               return false;
            }
            if(dir<0 && closeNow > g_pending.breakLevel + tolerance)
            {
               CancelPendingSetup("break & retest invalidated (closed back above level)");
               return false;
            }
         }
         else
         {
            // waiting for a rejection candle back in the original direction
            bool rejection = (dir>0) ? (closeNow > g_pending.breakLevel) : (closeNow < g_pending.breakLevel);
            if(rejection)
               return true;
         }
         break;
      }

      case CONFIRM_MOMENTUM_CONT:
      {
         bool continuing = (dir>0) ? (closeNow > g_pending.lastTrackedClose) : (closeNow < g_pending.lastTrackedClose);
         if(continuing)
         {
            g_pending.momentumCount++;
            g_pending.lastTrackedClose = closeNow;
            if(g_pending.momentumCount >= InpMomentumConfirmCandles)
               return true;
         }
         else
         {
            CancelPendingSetup("momentum continuation broke");
            return false;
         }
         break;
      }

      default:
         CancelPendingSetup("unresolved adaptive mode");
         return false;
   }

   return false;
}

//================================= Trade Execution =============================

ENUM_ORDER_TYPE_FILLING PickFilling()
{
   long filling = SymbolInfoInteger(_Symbol, SYMBOL_FILLING_MODE);
   if((filling & SYMBOL_FILLING_FOK) != 0) return ORDER_FILLING_FOK;
   if((filling & SYMBOL_FILLING_IOC) != 0) return ORDER_FILLING_IOC;
   return ORDER_FILLING_RETURN;
}

bool HasOpenPosition()
{
   return (g_openTicket != 0 && PositionSelectByTicket(g_openTicket));
}

bool ExecuteTrade(int direction, int qualityScore, ENTRY_CONFIRM_MODE modeUsed)
{
   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick))
   {
      LogWarn("ExecuteTrade: failed to get tick.");
      return false;
   }

   double atr = GetAtr(1);
   if(atr <= 0.0)
   {
      LogWarn("ExecuteTrade: ATR unavailable, aborting entry.");
      return false;
   }

   double price = (direction>0) ? tick.ask : tick.bid;
   double slDistance = atr * InpProtectiveSLAtrMult;
   double sl = (direction>0) ? (price - slDistance) : (price + slDistance);

   double tpPoints = InpUseAtrTarget ? (atr / PointValue()) * (InpAtrTargetPct/100.0) : InpTakeProfitPoints;
   double tp = (direction>0) ? (price + PointsToPrice(tpPoints)) : (price - PointsToPrice(tpPoints));

   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   sl = NormalizeDouble(sl, digits);
   tp = NormalizeDouble(tp, digits);

   MqlTradeRequest req;
   MqlTradeResult  res;
   ZeroMemory(req);
   ZeroMemory(res);

   req.action       = TRADE_ACTION_DEAL;
   req.symbol       = _Symbol;
   req.volume       = InpLotSize;
   req.type         = (direction>0) ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   req.price        = price;
   req.sl           = sl;
   req.tp           = tp;
   req.deviation    = InpMaxSlippagePoints;
   req.magic        = InpMagic;
   req.comment      = "SIPE|" + EnumToString(modeUsed) + "|Q" + (string)qualityScore;
   req.type_filling = PickFilling();

   bool ok=false;
   for(int attempt=0; attempt<=InpMaxOrderRetries; attempt++)
   {
      ZeroMemory(res);
      ok = OrderSend(req, res);
      if(ok && (res.retcode==TRADE_RETCODE_DONE || res.retcode==TRADE_RETCODE_DONE_PARTIAL))
         break;

      bool retriable = (res.retcode==TRADE_RETCODE_REQUOTE || res.retcode==TRADE_RETCODE_PRICE_CHANGED ||
                        res.retcode==TRADE_RETCODE_TIMEOUT  || res.retcode==TRADE_RETCODE_CONNECTION);
      if(!retriable || attempt==InpMaxOrderRetries)
         break;

      if(SymbolInfoTick(_Symbol, tick))
      {
         req.price = (direction>0) ? tick.ask : tick.bid;
         sl = (direction>0) ? (req.price - slDistance) : (req.price + slDistance);
         tp = (direction>0) ? (req.price + PointsToPrice(tpPoints)) : (req.price - PointsToPrice(tpPoints));
         req.sl = NormalizeDouble(sl, digits);
         req.tp = NormalizeDouble(tp, digits);
      }
      Sleep(InpRetryDelayMs);
   }

   if(!ok || (res.retcode!=TRADE_RETCODE_DONE && res.retcode!=TRADE_RETCODE_DONE_PARTIAL))
   {
      LogWarn("ExecuteTrade failed. retcode=" + (string)res.retcode + " (" + TradeRetcodeDescription(res.retcode) + ")");
      return false;
   }

   // Resolve the authoritative position ticket by selecting the position on
   // this symbol rather than trusting res.order/res.deal directly (more
   // robust across brokers/netting vs hedging accounts).
   if(PositionSelect(_Symbol))
      g_openTicket = (ulong)PositionGetInteger(POSITION_TICKET);
   else
      g_openTicket = (res.order>0) ? res.order : res.deal;

   g_openTime           = TimeCurrent();
   g_openDirection      = direction;
   g_openEntryPrice     = res.price>0 ? res.price : price;
   g_openAtr            = atr;
   g_openQuality        = qualityScore;
   g_openMode           = modeUsed;
   g_openBreakevenDone  = false;
   g_openLockDone       = false;
   g_openTrailActive    = false;

   LogInfo("ENTRY executed. dir=" + (string)direction + " price=" + DoubleToString(g_openEntryPrice,digits) +
           " sl=" + DoubleToString(sl,digits) + " tp=" + DoubleToString(tp,digits) +
           " quality=" + (string)qualityScore + " mode=" + EnumToString(modeUsed));
   return true;
}

//================================= Position Management =========================

void ClosePosition(string why)
{
   if(!HasOpenPosition())
      return;

   MqlTradeRequest req;
   MqlTradeResult  res;
   ZeroMemory(req);
   ZeroMemory(res);

   double volume = PositionGetDouble(POSITION_VOLUME);
   long   type   = PositionGetInteger(POSITION_TYPE);

   MqlTick tick;
   SymbolInfoTick(_Symbol, tick);

   req.action    = TRADE_ACTION_DEAL;
   req.position  = g_openTicket;
   req.symbol    = _Symbol;
   req.volume    = volume;
   req.type      = (type==POSITION_TYPE_BUY) ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
   req.price     = (type==POSITION_TYPE_BUY) ? tick.bid : tick.ask;
   req.deviation = InpMaxSlippagePoints;
   req.magic     = InpMagic;
   req.type_filling = PickFilling();

   bool ok = OrderSend(req, res);
   LogInfo("ClosePosition (" + why + "): ok=" + (string)ok + " retcode=" + (string)res.retcode +
           " (" + TradeRetcodeDescription(res.retcode) + ")");
}

void ModifySLTP(double newSL, double newTP)
{
   if(!HasOpenPosition())
      return;

   double curSL = PositionGetDouble(POSITION_SL);
   double curTP = PositionGetDouble(POSITION_TP);
   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   newSL = NormalizeDouble(newSL, digits);
   newTP = (newTP>0) ? NormalizeDouble(newTP, digits) : curTP;

   if(MathAbs(newSL-curSL) < PointValue()*0.5 && MathAbs(newTP-curTP) < PointValue()*0.5)
      return; // no meaningful change

   MqlTradeRequest req;
   MqlTradeResult  res;
   ZeroMemory(req);
   ZeroMemory(res);

   req.action   = TRADE_ACTION_SLTP;
   req.position = g_openTicket;
   req.symbol   = _Symbol;
   req.sl       = newSL;
   req.tp       = newTP;

   bool ok = OrderSend(req, res);
   if(!ok || (res.retcode!=TRADE_RETCODE_DONE && res.retcode!=TRADE_RETCODE_DONE_PARTIAL))
      LogWarn("ModifySLTP failed: ok=" + (string)ok + " retcode=" + (string)res.retcode +
              " (" + TradeRetcodeDescription(res.retcode) + ")");
}

// Called every tick while a position is open: handles quick profit extraction
// and the three-level profit-locking ladder. Never widens the stop (no
// martingale/averaging), only tightens it.
void ManageOpenPosition()
{
   if(!HasOpenPosition())
      return;

   double point = PointValue();
   long type = PositionGetInteger(POSITION_TYPE);
   double entry = PositionGetDouble(POSITION_PRICE_OPEN);
   double curSL = PositionGetDouble(POSITION_SL);
   double curTP = PositionGetDouble(POSITION_TP);

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick))
      return;

   double currentPrice = (type==POSITION_TYPE_BUY) ? tick.bid : tick.ask;
   double profitPoints = (type==POSITION_TYPE_BUY) ? (currentPrice-entry)/point : (entry-currentPrice)/point;

   // --- Quick profit extraction: hard target in points (fixed or ATR%-derived).
   double targetPoints = InpUseAtrTarget ? (g_openAtr/point) * (InpAtrTargetPct/100.0) : InpTakeProfitPoints;
   if(profitPoints >= targetPoints)
   {
      ClosePosition("quick profit target reached (" + DoubleToString(profitPoints,1) + "pts)");
      return;
   }

   // --- Level 3: tight trailing stop (checked first since it supersedes level 1/2 once active).
   if(profitPoints >= InpTrailTriggerPts)
   {
      g_openTrailActive = true;
      double trailSL = (type==POSITION_TYPE_BUY) ? (currentPrice - PointsToPrice(InpTrailDistancePts))
                                                  : (currentPrice + PointsToPrice(InpTrailDistancePts));
      bool improves = (type==POSITION_TYPE_BUY) ? (trailSL > curSL) : (trailSL < curSL || curSL==0.0);
      if(improves)
         ModifySLTP(trailSL, curTP);
      return;
   }

   // --- Level 2: lock partial profit.
   if(profitPoints >= InpLockTriggerPts && !g_openLockDone)
   {
      double lockSL = (type==POSITION_TYPE_BUY) ? (entry + PointsToPrice(InpLockProfitPts))
                                                 : (entry - PointsToPrice(InpLockProfitPts));
      bool improves = (type==POSITION_TYPE_BUY) ? (lockSL > curSL) : (lockSL < curSL || curSL==0.0);
      if(improves)
      {
         ModifySLTP(lockSL, curTP);
         g_openLockDone = true;
         g_openBreakevenDone = true; // locking supersedes plain breakeven
      }
      return;
   }

   // --- Level 1: breakeven.
   if(profitPoints >= InpBreakevenTriggerPts && !g_openBreakevenDone)
   {
      double beSL = (type==POSITION_TYPE_BUY) ? (entry + PointsToPrice(InpBreakevenLockPts))
                                               : (entry - PointsToPrice(InpBreakevenLockPts));
      bool improves = (type==POSITION_TYPE_BUY) ? (beSL > curSL) : (beSL < curSL || curSL==0.0);
      if(improves)
      {
         ModifySLTP(beSL, curTP);
         g_openBreakevenDone = true;
      }
   }
}

//================================= Re-Entry Engine ==============================

// Trend/momentum/structure must all still be valid, and there must be no
// opposite-direction raw signal, before the EA is allowed to re-enter.
bool ReentryStillValid(int direction)
{
   if(!DetectStructure(direction))
      return false;

   double fastNow = GetMA(g_handleFastMA, 1);
   double slowNow = GetMA(g_handleSlowMA, 1);
   bool trendAligned = (direction>0) ? (fastNow > slowNow) : (fastNow < slowNow);
   if(!trendAligned)
      return false;

   int opposite = -direction;
   int raw = GetRawSignal();
   if(raw == opposite)
      return false; // an opposite setup just appeared, don't re-enter

   if(!PassesStepIndexFilter(direction))
      return false;

   return true;
}

//================================= Main Bar/Tick Handlers ======================

bool IsNewBar()
{
   datetime t = iTime(_Symbol, _Period, 0);
   if(t != g_lastBarTime)
   {
      g_lastBarTime = t;
      return true;
   }
   return false;
}

void ScanForNewSetup()
{
   if(g_pending.active || HasOpenPosition())
      return;

   if(g_awaitingReentry)
   {
      if(TimeCurrent() < g_reentryReadyAt)
         return;

      if(!InpEnableAutoReentry || !ReentryStillValid(g_reentryDirection))
      {
         LogInfo("Re-entry conditions no longer valid; standing down.");
         g_awaitingReentry = false;
         g_reentryDirection = 0;
         return;
      }

      StartPendingSetup(g_reentryDirection, true);
      g_awaitingReentry = false;
      return;
   }

   bool symbolOk = IsStepIndexSymbol();
   if(symbolOk != g_lastSymbolFilterPassed)
   {
      if(!symbolOk)
         LogWarn("Chart symbol '" + _Symbol + "' no longer matches InpAllowedSymbolKeywords ('" + InpAllowedSymbolKeywords +
                 "'); entry scanning is paused until attached to a matching Step Index symbol or InpRestrictToStepIndex is disabled.");
      else
         LogInfo("Chart symbol '" + _Symbol + "' now matches the Step Index filter; resuming entry scanning.");
      g_lastSymbolFilterPassed = symbolOk;
   }
   if(!symbolOk)
      return;

   int raw = GetRawSignal();
   if(raw == 0)
      return;

   if(!PassesStepIndexFilter(raw))
   {
      LogInfo("Signal rejected by Step Index spike/exhaustion filter.");
      return;
   }

   StartPendingSetup(raw, false);
}

void ProcessPendingSetup()
{
   if(!g_pending.active)
      return;

   if(!PassesStepIndexFilter(g_pending.direction))
   {
      CancelPendingSetup("spike/exhaustion filter failed mid-confirmation");
      return;
   }

   if(AdvancePendingSetup())
   {
      int quality = ComputeQualityScore(g_pending.direction, g_pending.modeUsed, g_pending.momentumCount, g_pending.retested);
      int threshold = SessionAdaptiveQualityThreshold();

      if(quality < threshold)
      {
         LogInfo("Setup confirmed but quality score " + (string)quality + " < threshold " + (string)threshold + "; skipping.");
         CancelPendingSetup("quality score below threshold");
         return;
      }

      ENTRY_CONFIRM_MODE mode = g_pending.modeUsed;
      int direction = g_pending.direction;
      ZeroMemory(g_pending);

      ExecuteTrade(direction, quality, mode);
   }
}

void OnTick()
{
   if(!HasOpenPosition() && g_openTicket != 0)
   {
      // Position vanished between ticks (closed by broker/SL/TP) but our
      // OnTradeTransaction handler should already have recorded it; just
      // make sure local state is clear.
      g_openTicket = 0;
   }

   if(HasOpenPosition())
   {
      ManageOpenPosition();
   }

   if(!IsNewBar())
      return;

   UpdateSpikeTracker();

   bool autoTradingAllowed = IsAutoTradingAllowed();
   if(autoTradingAllowed != g_lastAutoTradingAllowed)
   {
      if(!autoTradingAllowed)
         LogWarn("Automated trading just became disallowed (check the terminal's 'Algo Trading' button, this EA's 'Allow Algo Trading' input/checkbox, and the account's expert-trading permission). New entries are paused until it is re-enabled.");
      else
         LogInfo("Automated trading is allowed again; resuming entry scanning.");
      g_lastAutoTradingAllowed = autoTradingAllowed;
   }

   if(HasOpenPosition())
      return; // one setup, one risk, one execution at a time - no grid/averaging

   if(!autoTradingAllowed)
      return; // do not even start/confirm new setups while orders cannot be sent

   ProcessPendingSetup();
   ScanForNewSetup();
}

//================================= Trade Transaction Handler ===================

void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result)
{
   if(trans.type != TRADE_TRANSACTION_DEAL_ADD)
      return;

   if(!HistoryDealSelect(trans.deal))
      return;

   long magic = HistoryDealGetInteger(trans.deal, DEAL_MAGIC);
   if(magic != InpMagic)
      return;

   long entryType = HistoryDealGetInteger(trans.deal, DEAL_ENTRY);
   if(entryType != DEAL_ENTRY_OUT && entryType != DEAL_ENTRY_OUT_BY)
      return; // only interested in closing deals

   double profit = HistoryDealGetDouble(trans.deal, DEAL_PROFIT) +
                   HistoryDealGetDouble(trans.deal, DEAL_SWAP) +
                   HistoryDealGetDouble(trans.deal, DEAL_COMMISSION);
   double closePrice = HistoryDealGetDouble(trans.deal, DEAL_PRICE);
   datetime closeTime = (datetime)HistoryDealGetInteger(trans.deal, DEAL_TIME);

   int direction = g_openDirection;
   double entryPrice = g_openEntryPrice;
   double atrAtEntry = g_openAtr;
   int quality = g_openQuality;
   ENTRY_CONFIRM_MODE mode = g_openMode;
   datetime openTime = g_openTime;

   RecordClosedTrade(direction, entryPrice, closePrice, atrAtEntry, quality, mode, profit, openTime, closeTime);

   bool wasProfitable = (profit >= 0.0);

   g_openTicket = 0;
   g_openDirection = 0;

   if(InpEnableAutoReentry && wasProfitable && direction != 0)
   {
      g_awaitingReentry  = true;
      g_reentryDirection = direction;
      g_reentryReadyAt   = TimeCurrent() + InpReentryCooldownSecs;
      LogInfo("Profitable close detected; armed for auto re-entry in direction " + (string)direction +
              " after " + (string)InpReentryCooldownSecs + "s cooldown.");
   }
   else
   {
      g_awaitingReentry = false;
      g_reentryDirection = 0;
   }
}
