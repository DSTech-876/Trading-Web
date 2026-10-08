//+------------------------------------------------------------------+
//|                                             ITGuruMt5Bridge.mq5  |
//| Signal-bridge Expert Advisor: polls a secure HTTPS API for       |
//| pending orders, validates risk, executes trades, and reports     |
//| detailed status back to the signal engine.                      |
//|                                                                   |
//| DEPLOYMENT                                                        |
//|  1. Attach to any chart with "Allow Algo/Automated Trading" ON.   |
//|  2. Tools > Options > Expert Advisors > Allow WebRequest for:     |
//|       https://<your-domain>                                      |
//|  3. Set InpBaseUrl and InpBridgeKey (never commit real secrets).  |
//|  4. ALWAYS test on a demo account before enabling live trading.   |
//+------------------------------------------------------------------+
#property strict
#property copyright "ITGuru"
#property version   "2.00"

//================================= Inputs ===================================

input string InpBaseUrl         = "https://trading.dsitservicesja.com"; // no trailing slash
input string InpBridgeKey       = "";    // REQUIRED: set a strong secret, matches server MT5_BRIDGE_KEY. Never commit real keys.
input string InpTerminalId      = "MT5-TERM-01";
input int    InpPollSeconds     = 2;      // base polling interval
input int    InpHttpTimeoutMs   = 5000;
input long   InpMagic           = 26051701;
input bool   InpOnlyChartSymbol = false;  // true = skip orders not matching current chart symbol

input string Inp_RiskHeader     = "===== Risk Controls =====";  // (label)
input double InpMaxLotSize      = 1.0;    // hard cap, overrides any server-supplied lot
input int    InpMaxTradesPerSymbol = 3;   // max concurrent open positions+pending per symbol
input double InpMaxTotalExposureLots = 5.0; // sum of volumes across all symbols/positions
input bool   InpAllowHedging     = false; // false = reject new signal that conflicts with an opposite open position
input double InpMaxSpreadPoints  = 30;    // reject if current spread exceeds this many points
input int    InpMaxSlippagePoints= 20;    // deviation passed to OrderSend
input int    InpMaxSignalAgeSecs = 90;    // reject signals older than this (staleness protection)
input double InpMarginBufferPct  = 20.0;  // require this % extra free margin above computed requirement
input double InpDailyLossLimitPct= 85.0;   // halt new trades if daily realized loss exceeds this % of day-start equity
input bool   InpUseSessionFilter = false; // restrict trading to a server-time hour window
input int    InpSessionStartHour = 0;     // 0-23, inclusive
input int    InpSessionEndHour   = 23;    // 0-23, inclusive

input string Inp_ResilienceHeader = "===== Connection & Retry =====";  // (label)
input int    InpMaxConsecutiveFailBeforeBackoff = 3;
input int    InpMaxBackoffSeconds = 120;
input int    InpAlertAfterFailures = 10;   // send a terminal alert/notification after this many consecutive poll failures
input int    InpMaxOrderRetries   = 2;     // retries for retriable broker errors (requote/busy/timeout)
input int    InpRetryDelayMs      = 400;

input string Inp_LoggingHeader   = "===== Logging =====";  // (label)
input bool   InpVerboseLogging   = true;
input string InpLogFileName      = "ITGuruMt5Bridge_log.csv";

input string Inp_SymbolHeader    = "===== Symbol Resolution =====";  // (label)
input string InpSymbolAliasMap   = ""; // manual overrides: "stpRNG5=Step Index 500;EURUSD=EURUSD.m" (code=brokerSymbol pairs, ';' separated)
input string InpSymbolSuffixCandidates = ""; // broker suffixes to try appended to the raw code, e.g. "m,.a,-ECN,#" (comma separated)

//================================= Types =====================================

struct BridgeOrder
{
   string orderId;
   string symbol;
   string brokerSymbolHint; // optional server-suggested broker/MarketWatch symbol name
   string side;
   string orderType;
   double entry;
   double sl;
   double tp;
   double lot;
   long   createdAt; // unix epoch seconds, from server
};

//================================= Globals ===================================

datetime g_nextPollAllowedAt   = 0;
int      g_consecutiveFailures = 0;
datetime g_lastSuccessfulPoll  = 0;
bool     g_disconnectAlerted   = false;

bool     g_tradingHalted       = false; // combined: g_dailyLossHalted || g_serverHalted
string   g_haltReason          = "";
bool     g_dailyLossHalted     = false;
bool     g_serverHalted        = false;
string   g_serverHaltReason    = "";

// Daily loss tracking
datetime g_dayStart             = 0;
double   g_dayStartEquity       = 0.0;

// Admin-editable daily loss limit %, relayed from the server via pull.php's
// "dailyLossLimitPct" field so an operator can change it without recompiling
// the EA. -1 means "not yet received from server" — falls back to the
// compiled-in InpDailyLossLimitPct input until the first successful poll.
double   g_serverDailyLossLimitPct = -1.0;

// Processed-signal de-duplication (persisted across restarts). The last known
// final status/ticket is kept alongside each orderId so that if the server
// never received (or never persisted) our status callback — e.g. a transient
// HTTP failure on PostStatus() — a later redispatch of the SAME orderId can be
// resynced instead of silently dropped forever (which previously left the
// order stuck as non-final server-side, causing it to be redispatched on every
// poll cycle and counted as a duplicate every single time, with no trade ever
// reaching the broker).
string   g_processedIds[];
long     g_processedAt[];
string   g_processedStatus[];
string   g_processedTicket[];
double   g_processedPrice[];
int      g_processedDigits[];

// Monitoring counters
int      g_statSignalsReceived  = 0;
int      g_statSignalsDuplicate = 0;
int      g_statSignalsRejected  = 0;
int      g_statSignalsFilled    = 0;
int      g_statSignalsPending   = 0;
int      g_statPollFailures     = 0;
int      g_statPollOk           = 0;

#define PROCESSED_TTL_SECS (7*24*3600)
#define MAX_PROCESSED_ENTRIES 2000

//=============================== Utilities ===================================

string TrimSlash(string s)
{
   int n=StringLen(s);
   while(n>0 && StringGetCharacter(s,n-1)=='/')
   {
      s=StringSubstr(s,0,n-1);
      n=StringLen(s);
   }
   return s;
}

string JsonEscape(string s)
{
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   StringReplace(s, "\r", "\\r");
   StringReplace(s, "\n", "\\n");
   StringReplace(s, "\t", "\\t");
   return s;
}

string NowStamp()
{
   return TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS);
}

//------------------------------- Logging -------------------------------------

void LogEvent(string level, string event, string orderId, string message)
{
   if(InpVerboseLogging || level=="ERROR" || level=="WARN")
      Print("[",level,"] ",event," orderId=",orderId," ",message);

   int fh = FileOpen(InpLogFileName, FILE_READ|FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_SHARE_READ|FILE_SHARE_WRITE);
   if(fh==INVALID_HANDLE) return;
   FileSeek(fh, 0, SEEK_END);
   string line = NowStamp()+","+level+","+event+","+orderId+","+JsonEscape(message);
   FileWrite(fh, line);
   FileClose(fh);
}

//------------------------- Processed-signal store -----------------------------

string ProcessedIdsFileName()
{
   return "ITGuruMt5Bridge_processed_"+InpTerminalId+".csv";
}

void LoadProcessedIds()
{
   ArrayResize(g_processedIds,0);
   ArrayResize(g_processedAt,0);
   ArrayResize(g_processedStatus,0);
   ArrayResize(g_processedTicket,0);
   ArrayResize(g_processedPrice,0);
   ArrayResize(g_processedDigits,0);

   int fh = FileOpen(ProcessedIdsFileName(), FILE_READ|FILE_TXT|FILE_ANSI|FILE_SHARE_READ);
   if(fh==INVALID_HANDLE) return;

   long cutoff = (long)TimeGMT() - PROCESSED_TTL_SECS;
   while(!FileIsEnding(fh))
   {
      string line = FileReadString(fh);
      if(StringLen(line)==0) continue;
      // Formats seen on disk, oldest to newest:
      //   id,ts                              (legacy, no status)
      //   id,ts,status,ticket                 (status/ticket resync)
      //   id,ts,status,ticket,price,digits    (current, replayable fill price)
      string parts[];
      int n = StringSplit(line, ',', parts);
      if(n<2) continue;
      string id = parts[0];
      long ts = (long)StringToInteger(parts[1]);
      string status  = (n>2) ? parts[2] : "";
      string ticket   = (n>3) ? parts[3] : "";
      double price    = (n>4) ? StringToDouble(parts[4]) : 0.0;
      int    digits   = (n>5) ? (int)StringToInteger(parts[5]) : -1;
      if(ts < cutoff) continue; // drop expired entries
      int sz=ArraySize(g_processedIds);
      ArrayResize(g_processedIds, sz+1);
      ArrayResize(g_processedAt, sz+1);
      ArrayResize(g_processedStatus, sz+1);
      ArrayResize(g_processedTicket, sz+1);
      ArrayResize(g_processedPrice, sz+1);
      ArrayResize(g_processedDigits, sz+1);
      g_processedIds[sz]=id;
      g_processedAt[sz]=ts;
      g_processedStatus[sz]=status;
      g_processedTicket[sz]=ticket;
      g_processedPrice[sz]=price;
      g_processedDigits[sz]=digits;
   }
   FileClose(fh);
}

void SaveProcessedIds()
{
   int fh = FileOpen(ProcessedIdsFileName(), FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_SHARE_READ);
   if(fh==INVALID_HANDLE) return;
   int n=ArraySize(g_processedIds);
   int start = MathMax(0, n-MAX_PROCESSED_ENTRIES); // cap file growth
   for(int i=start;i<n;i++)
      FileWrite(fh, g_processedIds[i]+","+(string)g_processedAt[i]+","+g_processedStatus[i]+","+g_processedTicket[i]+
                    ","+DoubleToString(g_processedPrice[i],8)+","+(string)g_processedDigits[i]);
   FileClose(fh);
}

int FindProcessedIndex(string orderId)
{
   int n=ArraySize(g_processedIds);
   for(int i=0;i<n;i++)
      if(g_processedIds[i]==orderId) return i;
   return -1;
}

bool IsDuplicateSignal(string orderId)
{
   return FindProcessedIndex(orderId) >= 0;
}

// Returns the last reported status/ticket/fill price we sent for this
// orderId, so a duplicate redispatch can resync the server instead of being
// dropped with no trace, which previously left orders stuck non-final forever
// (endlessly redispatched and counted as a duplicate every single poll).
bool GetProcessedStatus(string orderId, string &status, string &ticket, double &price, int &digits)
{
   int idx = FindProcessedIndex(orderId);
   if(idx<0) return false;
   status = g_processedStatus[idx];
   ticket = g_processedTicket[idx];
   price  = g_processedPrice[idx];
   digits = g_processedDigits[idx];
   return status!="";
}

void MarkProcessed(string orderId, string status="", string ticket="", double price=0.0, int digits=-1)
{
   int idx = FindProcessedIndex(orderId);
   if(idx>=0)
   {
      // Already recorded (e.g. first MarkProcessed call without a status, or a
      // resync): update the status/ticket/price in place if we now have one.
      if(status!="") g_processedStatus[idx]=status;
      if(ticket!="") g_processedTicket[idx]=ticket;
      if(price!=0.0) g_processedPrice[idx]=price;
      if(digits>=0) g_processedDigits[idx]=digits;
      SaveProcessedIds();
      return;
   }
   int sz=ArraySize(g_processedIds);
   ArrayResize(g_processedIds, sz+1);
   ArrayResize(g_processedAt, sz+1);
   ArrayResize(g_processedStatus, sz+1);
   ArrayResize(g_processedTicket, sz+1);
   ArrayResize(g_processedPrice, sz+1);
   ArrayResize(g_processedDigits, sz+1);
   g_processedIds[sz]=orderId;
   g_processedAt[sz]=(long)TimeGMT();
   g_processedStatus[sz]=status;
   g_processedTicket[sz]=ticket;
   g_processedPrice[sz]=price;
   g_processedDigits[sz]=digits;
   SaveProcessedIds();
}

// Legacy processed entries (persisted before status/ticket/price were tracked,
// or written by an older build) load with an empty status. Previously a
// duplicate redispatch for one of these was simply ignored forever, leaving
// the order stuck non-final on the server and redispatched on every poll. To
// break that loop, derive the real outcome from the account's current open
// state and trade history instead of guessing: a still-open position/pending
// order tagged with this orderId is reported as FILLED/RECEIVED with its true
// fill price, a filled deal resolved to its originating order's ORDER_COMMENT
// is reported as FILLED, and a historical order that was cancelled, expired,
// or rejected before ever filling is reported with that same final status. If
// none of that is found the order was never placed on this account, so it is
// safe to report REJECTED. Returns false if history could not be queried, so
// the caller can retry reconciliation on the next redispatch instead of
// permanently persisting a REJECTED outcome without having checked history.
bool ReconcileLegacyStatus(const BridgeOrder &o, string &status, string &ticket, double &price, int &digits)
{
   for(int i=0;i<PositionsTotal();i++)
   {
      ulong t=PositionGetTicket(i);
      if(t==0 || !PositionSelectByTicket(t)) continue;
      if((long)PositionGetInteger(POSITION_MAGIC)!=InpMagic) continue;
      if(PositionGetString(POSITION_COMMENT)!=o.orderId) continue;
      status="FILLED";
      ticket=(string)t;
      price=PositionGetDouble(POSITION_PRICE_OPEN);
      digits=(int)SymbolInfoInteger(PositionGetString(POSITION_SYMBOL), SYMBOL_DIGITS);
      return true;
   }

   for(int i=0;i<OrdersTotal();i++)
   {
      ulong t=OrderGetTicket(i);
      if(t==0 || !OrderSelect(t)) continue;
      if((long)OrderGetInteger(ORDER_MAGIC)!=InpMagic) continue;
      if(OrderGetString(ORDER_COMMENT)!=o.orderId) continue;
      status="RECEIVED";
      ticket=(string)t;
      price=0.0;
      digits=-1;
      return true;
   }

   if(!HistorySelect((datetime)((long)TimeCurrent()-PROCESSED_TTL_SECS), TimeCurrent()))
      return false; // selection failed; retry reconciliation on the next redispatch

   int totalDeals = HistoryDealsTotal();
   for(int i=0;i<totalDeals;i++)
   {
      ulong dealTicket = HistoryDealGetTicket(i);
      if(dealTicket==0) continue;
      if((long)HistoryDealGetInteger(dealTicket, DEAL_MAGIC) != InpMagic) continue;
      if((long)HistoryDealGetInteger(dealTicket, DEAL_ENTRY)!=DEAL_ENTRY_IN) continue;
      ulong orderTicket = (ulong)HistoryDealGetInteger(dealTicket, DEAL_ORDER);
      if(orderTicket==0 || !HistoryOrderSelect(orderTicket)) continue;
      if(HistoryOrderGetString(orderTicket, ORDER_COMMENT)!=o.orderId) continue;
      status="FILLED";
      ticket=(string)orderTicket;
      price=HistoryDealGetDouble(dealTicket, DEAL_PRICE);
      digits=(int)SymbolInfoInteger(HistoryDealGetString(dealTicket, DEAL_SYMBOL), SYMBOL_DIGITS);
      return true;
   }

   // No matching fill: check historical orders for a pending order that was
   // cancelled, expired, or rejected before ever filling, so these distinct
   // final statuses (already reported by OnTradeTransaction going forward)
   // aren't misreported as REJECTED-with-no-trace below. HistoryOrderSelect()
   // above (in the deal loop) replaces the order list built by the earlier
   // HistorySelect() with just the selected order, so the history must be
   // re-selected before scanning orders or this loop would only see the last
   // order examined by the deal loop.
   if(!HistorySelect((datetime)((long)TimeCurrent()-PROCESSED_TTL_SECS), TimeCurrent()))
      return false; // selection failed; retry reconciliation on the next redispatch

   int totalOrders = HistoryOrdersTotal();
   for(int i=0;i<totalOrders;i++)
   {
      ulong orderTicket = HistoryOrderGetTicket(i);
      if(orderTicket==0) continue;
      if((long)HistoryOrderGetInteger(orderTicket, ORDER_MAGIC) != InpMagic) continue;
      if(HistoryOrderGetString(orderTicket, ORDER_COMMENT)!=o.orderId) continue;
      long state = HistoryOrderGetInteger(orderTicket, ORDER_STATE);
      if(state==ORDER_STATE_EXPIRED)       status="EXPIRED";
      else if(state==ORDER_STATE_REJECTED) status="REJECTED";
      else if(state==ORDER_STATE_CANCELED) status="CANCELLED";
      else continue;
      ticket=(string)orderTicket;
      price=0.0;
      digits=-1;
      return true;
   }

   // No trace of this orderId anywhere on the account: it was never placed,
   // so it is safe to finalize it as rejected rather than leaving it stuck.
   status="REJECTED";
   ticket="";
   price=0.0;
   digits=-1;
   return true;
}

//=============================== HTTP / JSON =================================

bool HttpRequest(string method, string url, string headers, string body, string &resp, string &respHeaders, int &statusCode)
{
   char data[];
   if(method=="POST")
   {
      StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
      // CRITICAL: StringToCharArray() with count=WHOLE_ARRAY copies the string's
      // terminating NUL byte into the array as well. WebRequest() sends the raw
      // array contents as the POST body, so without trimming this off, every
      // single POST (status.php, signal.php, etc.) is transmitted with a stray
      // trailing 0x00 byte. PHP's json_decode() treats any trailing non-whitespace
      // byte after the JSON value as a parse error and returns NULL — which is
      // exactly the "Invalid JSON body" HTTP 400 the server was returning for
      // every STATUS_POST call. Drop the terminator so the wire body is pure JSON.
      int sz = ArraySize(data);
      if(sz>0 && data[sz-1]==0)
         ArrayResize(data, sz-1);
   }
   else
      ArrayResize(data, 0);

   if(InpVerboseLogging)
      LogEvent("DEBUG","HTTP_REQUEST","", "method="+method+" url="+url+" bodyBytes="+(string)ArraySize(data));

   char result[];
   ResetLastError();
   statusCode = WebRequest(method, url, headers, InpHttpTimeoutMs, data, result, respHeaders);
   if(statusCode == -1)
   {
      int err = GetLastError();
      string hint = "";
      // err 4014 = ERR_FUNCTION_NOT_ALLOWED. In the Strategy Tester, WebRequest()
      // always returns this error because outbound web requests are never permitted
      // there, regardless of the allow-list — so the allow-list remedy below is
      // guaranteed wrong for backtests. Outside the tester, it means the base URL is
      // not (yet) allow-listed in Tools > Options > Expert Advisors > "Allow
      // WebRequest for listed URL", or the terminal needs a restart/EA re-attach
      // after adding it. Every poll will fail identically until this is fixed, so
      // surface the correct fix directly in the log instead of forcing the operator
      // to look up the MQL5 error code.
      if(err == 4014)
      {
         if(MQLInfoInteger(MQL_TESTER))
            hint = " (WebRequest is not available in the Strategy Tester; this EA requires live web access and cannot be backtested)";
         else
            hint = " (URL not allow-listed: add '"+TrimSlash(InpBaseUrl)+"' in Tools > Options > Expert Advisors > Allow WebRequest for listed URL, then re-attach this EA)";
      }
      LogEvent("ERROR","HTTP_FAIL","", "method="+method+" url="+url+" err="+(string)err+hint+" bodyBytes="+(string)ArraySize(data));
      return false;
   }
   resp = CharArrayToString(result, 0, -1, CP_UTF8);
   if(InpVerboseLogging)
      LogEvent("DEBUG","HTTP_RESPONSE","", "method="+method+" url="+url+" code="+(string)statusCode+" body="+resp);
   return true;
}

string JsonGetString(string obj, string key)
{
   string k="\""+key+"\"";
   int p=StringFind(obj,k);
   if(p<0) return "";
   p=StringFind(obj,":",p);
   if(p<0) return "";
   p++;
   while(p<StringLen(obj) && (StringGetCharacter(obj,p)==' ' || StringGetCharacter(obj,p)=='\n' || StringGetCharacter(obj,p)=='\r' || StringGetCharacter(obj,p)=='\t')) p++;
   if(p>=StringLen(obj) || StringGetCharacter(obj,p)!='"') return "";
   p++;
   int q=p;
   while(q<StringLen(obj))
   {
      int c=StringGetCharacter(obj,q);
      if(c=='"' && StringGetCharacter(obj,q-1)!='\\') break;
      q++;
   }
   if(q<=p) return "";
   return StringSubstr(obj,p,q-p);
}

double JsonGetNumber(string obj, string key, double def=0.0)
{
   string k="\""+key+"\"";
   int p=StringFind(obj,k);
   if(p<0) return def;
   p=StringFind(obj,":",p);
   if(p<0) return def;
   p++;
   while(p<StringLen(obj) && (StringGetCharacter(obj,p)==' ' || StringGetCharacter(obj,p)=='\n' || StringGetCharacter(obj,p)=='\r' || StringGetCharacter(obj,p)=='\t')) p++;
   int q=p;
   while(q<StringLen(obj))
   {
      int c=StringGetCharacter(obj,q);
      if(!((c>='0'&&c<='9') || c=='-' || c=='+' || c=='.' || c=='e' || c=='E')) break;
      q++;
   }
   if(q<=p) return def;
   return StringToDouble(StringSubstr(obj,p,q-p));
}

int JsonGetInt(string obj, string key, int def=0)
{
   return (int)MathRound(JsonGetNumber(obj,key,def));
}

long JsonGetLong(string obj, string key, long def=0)
{
   return (long)MathRound(JsonGetNumber(obj,key,(double)def));
}

bool JsonGetBool(string obj, string key, bool def=false)
{
   string k="\""+key+"\"";
   int p=StringFind(obj,k);
   if(p<0) return def;
   p=StringFind(obj,":",p);
   if(p<0) return def;
   p++;
   while(p<StringLen(obj) && StringGetCharacter(obj,p)==' ') p++;
   if(StringSubstr(obj,p,4)=="true") return true;
   if(StringSubstr(obj,p,5)=="false") return false;
   return def;
}

bool ExtractOrdersArray(string json, string &ordersArray)
{
   int p=StringFind(json,"\"orders\"");
   if(p<0) return false;
   p=StringFind(json,"[",p);
   if(p<0) return false;

   int depth=0, q=p;
   for(; q<StringLen(json); q++)
   {
      int c=StringGetCharacter(json,q);
      if(c=='[') depth++;
      else if(c==']')
      {
         depth--;
         if(depth==0) break;
      }
   }
   if(q<=p) return false;
   ordersArray = StringSubstr(json,p+1,q-p-1);
   return true;
}

int ParseOrders(string json, BridgeOrder &out[])
{
   ArrayResize(out,0);

   int count=JsonGetInt(json,"count",0);
   if(count<=0) return 0;

   string arr;
   if(!ExtractOrdersArray(json,arr)) return 0;

   int i=0, n=StringLen(arr);
   while(i<n)
   {
      while(i<n && StringGetCharacter(arr,i)!='{') i++;
      if(i>=n) break;

      int start=i, depth=0;
      for(; i<n; i++)
      {
         int c=StringGetCharacter(arr,i);
         if(c=='{') depth++;
         else if(c=='}')
         {
            depth--;
            if(depth==0) break;
         }
      }
      if(i>=n) break;

      string obj = StringSubstr(arr,start,i-start+1);
      BridgeOrder o;
      o.orderId   = JsonGetString(obj,"orderId");
      o.symbol    = JsonGetString(obj,"symbol");
      o.brokerSymbolHint = JsonGetString(obj,"brokerSymbolHint");
      o.side      = JsonGetString(obj,"side");
      o.orderType = JsonGetString(obj,"orderType");
      o.entry     = JsonGetNumber(obj,"entry",0.0);
      o.sl        = JsonGetNumber(obj,"sl",0.0);
      o.tp        = JsonGetNumber(obj,"tp",0.0);
      o.lot       = JsonGetNumber(obj,"lot",0.01);
      o.createdAt = JsonGetLong(obj,"createdAt",0);

      if(o.orderId!="" && o.symbol!="" && o.orderType!="" && o.lot>0)
      {
         int sz=ArraySize(out);
         ArrayResize(out,sz+1);
         out[sz]=o;
      }
      i++;
   }

   return ArraySize(out);
}

//=========================== Status callback =================================

void PostStatus(string orderId, string status, string brokerTicket, string message, double filledPrice=0.0, int digits=-1)
{
   int fmtDigits = (digits>=0) ? digits : _Digits;
   string base = TrimSlash(InpBaseUrl);
   string url  = base + "/api/mt5/status.php";
   string headers =
      "Content-Type: application/json\r\n"
      "X-MT5-BRIDGE-KEY: " + InpBridgeKey + "\r\n";

   string body = "{"
      "\"bridge_key\":\""+JsonEscape(InpBridgeKey)+"\","
      "\"orderId\":\""+JsonEscape(orderId)+"\","
      "\"status\":\""+JsonEscape(status)+"\","
      "\"brokerTicket\":\""+JsonEscape(brokerTicket)+"\","
      "\"message\":\""+JsonEscape(message)+"\","
      "\"terminal\":\""+JsonEscape(InpTerminalId)+"\","
      "\"filledPrice\":"+DoubleToString(filledPrice,fmtDigits)+"}";

   // Diagnostics requirement: always log the outgoing request metadata (never the body, which carries the bridge key) for a
   // status callback, tagged with the endpoint URL and signal id, *before*
   // transmission — so a server-side "Invalid JSON body" (or any other 4xx)
   // can be correlated against what was actually sent by endpoint, status, and byte count.
   uchar bodyBytesArr[];
   int bodyByteCount = StringToCharArray(body, bodyBytesArr, 0, -1, CP_UTF8) - 1; // exclude the NUL terminator
   LogEvent("DEBUG","STATUS_POST_REQUEST",orderId,"endpoint="+url+" status="+status+" bodyBytes="+(string)bodyByteCount);

   string resp, respHeaders;
   int code=-1;
   if(!HttpRequest("POST",url,headers,body,resp,respHeaders,code))
   {
      LogEvent("ERROR","STATUS_POST_FAIL",orderId,"could not reach "+url+", status="+status);
      return;
   }

   if(code!=200)
      LogEvent("ERROR","STATUS_POST_HTTP",orderId,"endpoint="+url+" HTTP "+(string)code+" responseBody="+resp+" bodyBytes="+(string)bodyByteCount);
   else
      LogEvent("INFO","STATUS_POST_OK",orderId,"endpoint="+url+" status="+status+" ticket="+brokerTicket+" responseBody="+resp);
}

//============================ Risk / validation ===============================

//--------------------------- Symbol resolution --------------------------------
// Cache of resolved symbols so repeated signals for the same code don't
// re-scan the full MarketWatch / re-log the resolution attempts every time.
string g_symbolResolveFrom[];
string g_symbolResolveTo[];

string NormalizeSymbolForMatch(string s)
{
   string out = s;
   StringToUpper(out);
   StringReplace(out, " ", "");
   StringReplace(out, "_", "");
   StringReplace(out, "-", "");
   StringReplace(out, ".", "");
   StringReplace(out, "#", "");
   return out;
}

// Looks up "code=brokerSymbol" pairs from InpSymbolAliasMap (";"-separated).
// Returns "" if no alias is configured for the requested code.
string LookupSymbolAlias(string requested)
{
   if(InpSymbolAliasMap=="") return "";
   string pairs[];
   int n = StringSplit(InpSymbolAliasMap, StringGetCharacter(";",0), pairs);
   for(int i=0;i<n;i++)
   {
      string pair = pairs[i];
      StringTrimLeft(pair); StringTrimRight(pair);
      if(pair=="") continue;
      int eq = StringFind(pair,"=");
      if(eq<=0) continue;
      string key = StringSubstr(pair,0,eq);
      string val = StringSubstr(pair,eq+1);
      StringTrimLeft(key); StringTrimRight(key);
      StringTrimLeft(val); StringTrimRight(val);
      if(val!="" && StringCompare(key,requested,false)==0) return val;
   }
   return "";
}

int g_symbolResolveCacheSize = 0;

bool SymbolResolveCacheGet(string requested, string &resolved)
{
   for(int i=0;i<g_symbolResolveCacheSize;i++)
   {
      if(g_symbolResolveFrom[i]==requested) { resolved=g_symbolResolveTo[i]; return true; }
   }
   return false;
}

void SymbolResolveCachePut(string requested, string resolved)
{
   int sz=ArraySize(g_symbolResolveFrom);
   if(g_symbolResolveCacheSize>=sz)
   {
      ArrayResize(g_symbolResolveFrom, sz+16);
      ArrayResize(g_symbolResolveTo, sz+16);
   }
   g_symbolResolveFrom[g_symbolResolveCacheSize]=requested;
   g_symbolResolveTo[g_symbolResolveCacheSize]=resolved;
   g_symbolResolveCacheSize++;
}

/**
 * Resolves the symbol code carried on an incoming signal (e.g. the
 * TradingView/indicator shorthand "stpRNG5") to a broker/MarketWatch symbol
 * name that SymbolSelect() actually accepts, instead of failing outright with
 * "Symbol not found/selectable". Tries, in order, and logs every attempt:
 *   1. Exact match (already a valid broker symbol — the common case).
 *   2. Server-supplied brokerSymbolHint (from MT5_SYMBOL_MAP on the server).
 *   3. Manually configured InpSymbolAliasMap override.
 *   4. Configured broker suffix candidates appended to the raw code
 *      (e.g. "EURUSD" + "m" => "EURUSDm").
 *   5. Case/punctuation-insensitive scan of the full available symbol list
 *      (Market Watch + all symbols the terminal knows about).
 * Successful non-exact resolutions are cached so this only runs once per
 * unique requested code per EA session.
 */
bool ResolveBrokerSymbol(string requested, string brokerSymbolHint, string orderId, string &resolved)
{
   if(requested=="")
   {
      resolved="";
      return false;
   }

   if(SymbolResolveCacheGet(requested, resolved))
      return resolved!="";

   // 1. Exact match
   if(SymbolSelect(requested,true))
   {
      LogEvent("INFO","SYMBOL_RESOLVE",orderId,"requested="+requested+" mapped="+requested+" method=exact");
      SymbolResolveCachePut(requested, requested);
      resolved=requested;
      return true;
   }
   LogEvent("WARN","SYMBOL_RESOLVE",orderId,"requested="+requested+" exact match not selectable, attempting resolution");

   // 2. Server-supplied hint
   if(brokerSymbolHint!="" && brokerSymbolHint!=requested)
   {
      if(SymbolSelect(brokerSymbolHint,true))
      {
         LogEvent("INFO","SYMBOL_RESOLVE",orderId,"requested="+requested+" mapped="+brokerSymbolHint+" method=serverHint");
         SymbolResolveCachePut(requested, brokerSymbolHint);
         resolved=brokerSymbolHint;
         return true;
      }
      LogEvent("WARN","SYMBOL_RESOLVE",orderId,"requested="+requested+" serverHint="+brokerSymbolHint+" not selectable");
   }

   // Some brokers name Step Index 100 "Step Index 100" instead of plain "Step Index"
   if(brokerSymbolHint=="Step Index" && SymbolSelect("Step Index 100",true))
   {
      LogEvent("INFO","SYMBOL_RESOLVE",orderId,"requested="+requested+" mapped=Step Index 100 method=stepIndex100Fallback");
      SymbolResolveCachePut(requested, "Step Index 100");
      resolved="Step Index 100";
      return true;
   }

   // 3. Manual alias map
   string alias = LookupSymbolAlias(requested);
   if(alias!="" && SymbolSelect(alias,true))
   {
      LogEvent("INFO","SYMBOL_RESOLVE",orderId,"requested="+requested+" mapped="+alias+" method=aliasMap");
      SymbolResolveCachePut(requested, alias);
      resolved=alias;
      return true;
   }
   if(alias!="")
      LogEvent("WARN","SYMBOL_RESOLVE",orderId,"requested="+requested+" alias="+alias+" not selectable");

   // 4. Suffix candidates
   if(InpSymbolSuffixCandidates!="")
   {
      string suffixes[];
      int sn = StringSplit(InpSymbolSuffixCandidates, StringGetCharacter(",",0), suffixes);
      for(int i=0;i<sn;i++)
      {
         string suf = suffixes[i];
         StringTrimLeft(suf); StringTrimRight(suf);
         if(suf=="") continue;
         string candidate = requested+suf;
         if(SymbolSelect(candidate,true))
         {
            LogEvent("INFO","SYMBOL_RESOLVE",orderId,"requested="+requested+" mapped="+candidate+" method=suffix("+suf+")");
            SymbolResolveCachePut(requested, candidate);
            resolved=candidate;
            return true;
         }
      }
   }

   // 5. Normalized fuzzy scan across every symbol the terminal knows about
   string normReq = NormalizeSymbolForMatch(requested);
   int total = SymbolsTotal(false);
   for(int i=0;i<total;i++)
   {
      string name = SymbolName(i,false);
      if(NormalizeSymbolForMatch(name)==normReq && SymbolSelect(name,true))
      {
         LogEvent("INFO","SYMBOL_RESOLVE",orderId,"requested="+requested+" mapped="+name+" method=fuzzyScan");
         SymbolResolveCachePut(requested, name);
         resolved=name;
         return true;
      }
   }

   LogEvent("ERROR","SYMBOL_RESOLVE_FAIL",orderId,"requested="+requested+" no broker symbol could be resolved (hint="+brokerSymbolHint+", alias="+alias+")");
   resolved="";
   return false;
}

// Returns true if symbol is selected and currently tradable.
bool ValidateSymbolTradable(string symbol, string &reason)
{
   if(!SymbolSelect(symbol,true))
   {
      reason = "Symbol not found/selectable: "+symbol;
      return false;
   }
   long tradeMode = SymbolInfoInteger(symbol, SYMBOL_TRADE_MODE);
   if(tradeMode == SYMBOL_TRADE_MODE_DISABLED)
   {
      reason = "Symbol trading disabled by broker: "+symbol;
      return false;
   }
   return true;
}

bool ValidateSpread(string symbol, double &spreadPointsOut, string &reason)
{
   MqlTick tick;
   if(!SymbolInfoTick(symbol,tick))
   {
      reason = "No tick data for "+symbol;
      return false;
   }
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   if(point<=0) point = _Point;
   spreadPointsOut = (tick.ask - tick.bid) / point;
   if(InpMaxSpreadPoints>0 && spreadPointsOut > InpMaxSpreadPoints)
   {
      reason = "Spread "+DoubleToString(spreadPointsOut,1)+" pts exceeds max "+(string)InpMaxSpreadPoints;
      return false;
   }
   return true;
}

bool ValidateSession(string &reason)
{
   if(!InpUseSessionFilter) return true;
   MqlDateTime dt;
   TimeToStruct(TimeGMT(), dt);
   int h = dt.hour;
   bool ok;
   if(InpSessionStartHour <= InpSessionEndHour)
      ok = (h >= InpSessionStartHour && h <= InpSessionEndHour);
   else // wraps midnight
      ok = (h >= InpSessionStartHour || h <= InpSessionEndHour);
   if(!ok) reason = "Outside configured trading session (hour="+(string)h+" GMT)";
   return ok;
}

bool ValidateNotStale(const BridgeOrder &o, string &reason)
{
   if(o.createdAt<=0 || InpMaxSignalAgeSecs<=0) return true; // no timestamp or filter disabled
   long ageSecs = (long)TimeGMT() - o.createdAt;
   if(ageSecs > InpMaxSignalAgeSecs)
   {
      reason = "Signal is stale, age="+(string)ageSecs+"s > "+(string)InpMaxSignalAgeSecs+"s";
      return false;
   }
   return true;
}

// Counts current positions/pending orders for symbol (and total exposure/comment match).
void ScanOpenState(string symbol, string orderId,
                    int &countSameSymbol, double &totalExposureLots,
                    bool &hasBuy, bool &hasSell, bool &alreadyPlaced, bool &alreadyPlacedPending)
{
   countSameSymbol = 0;
   totalExposureLots = 0.0;
   hasBuy = false;
   hasSell = false;
   alreadyPlaced = false;
   alreadyPlacedPending = false;

   for(int i=0;i<PositionsTotal();i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket==0) continue;
      if(!PositionSelectByTicket(ticket)) continue;
      if((long)PositionGetInteger(POSITION_MAGIC) != InpMagic) continue;

      string posSymbol = PositionGetString(POSITION_SYMBOL);
      double vol = PositionGetDouble(POSITION_VOLUME);
      totalExposureLots += vol;

      if(posSymbol==symbol)
      {
         countSameSymbol++;
         long type = PositionGetInteger(POSITION_TYPE);
         if(type==POSITION_TYPE_BUY) hasBuy = true;
         if(type==POSITION_TYPE_SELL) hasSell = true;
         if(PositionGetString(POSITION_COMMENT)==orderId) alreadyPlaced = true;
      }
   }

   for(int i=0;i<OrdersTotal();i++)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket==0) continue;
      if(!OrderSelect(ticket)) continue;
      if((long)OrderGetInteger(ORDER_MAGIC) != InpMagic) continue;

      string ordSymbol = OrderGetString(ORDER_SYMBOL);
      double vol = OrderGetDouble(ORDER_VOLUME_CURRENT);
      totalExposureLots += vol;

      if(ordSymbol==symbol)
      {
         countSameSymbol++;
         long type = OrderGetInteger(ORDER_TYPE);
         if(type==ORDER_TYPE_BUY_LIMIT || type==ORDER_TYPE_BUY_STOP) hasBuy = true;
         if(type==ORDER_TYPE_SELL_LIMIT || type==ORDER_TYPE_SELL_STOP) hasSell = true;
         if(OrderGetString(ORDER_COMMENT)==orderId)
         {
            alreadyPlaced = true;
            alreadyPlacedPending = true;
         }
      }
   }
}

bool ValidateStopLevels(string symbol, double entryPrice, double sl, double tp, string side, string &reason)
{
   long stopLevelPts = SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL);
   long freezeLevelPts = SymbolInfoInteger(symbol, SYMBOL_TRADE_FREEZE_LEVEL);
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   if(point<=0) point=_Point;
   double minDist = MathMax(stopLevelPts, freezeLevelPts) * point;
   if(minDist<=0) return true;

   if(sl>0 && MathAbs(entryPrice-sl) < minDist)
   {
      reason = "SL distance below broker minimum stop level ("+(string)stopLevelPts+" pts)";
      return false;
   }
   if(tp>0 && MathAbs(tp-entryPrice) < minDist)
   {
      reason = "TP distance below broker minimum stop level ("+(string)stopLevelPts+" pts)";
      return false;
   }
   return true;
}

bool ValidateMargin(string symbol, string side, double lot, double price, string &reason)
{
   ENUM_ORDER_TYPE ot = (side=="BUY") ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   double marginRequired = 0.0;
   if(!OrderCalcMargin(ot, symbol, lot, price, marginRequired))
   {
      reason = "OrderCalcMargin failed err="+(string)GetLastError();
      return false;
   }
   double freeMargin = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   double required = marginRequired * (1.0 + InpMarginBufferPct/100.0);
   if(required > freeMargin)
   {
      reason = "Insufficient free margin: need~"+DoubleToString(required,2)+" have="+DoubleToString(freeMargin,2);
      return false;
   }
   return true;
}

//------------------------------ Daily loss halt --------------------------------

string DailyStateFileName()
{
   return "ITGuruMt5Bridge_dailystate_"+InpTerminalId+".csv";
}

// Persist the UTC day boundary, start-of-day equity, and halt flag so an EA
// restart during the same UTC day does not reset the loss baseline or clear
// an active halt (the "remainder of the trading day" safeguard).
void SaveDailyState()
{
   int fh = FileOpen(DailyStateFileName(), FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_SHARE_READ);
   if(fh==INVALID_HANDLE) return;
   FileWrite(fh, (string)(long)g_dayStart+","+DoubleToString(g_dayStartEquity,2)+","+(string)(g_dailyLossHalted?1:0));
   FileClose(fh);
}

void LoadDailyState()
{
   int fh = FileOpen(DailyStateFileName(), FILE_READ|FILE_TXT|FILE_ANSI|FILE_SHARE_READ);
   if(fh==INVALID_HANDLE) return;
   if(!FileIsEnding(fh))
   {
      string line = FileReadString(fh);
      string parts[];
      int cnt = StringSplit(line, ',', parts);
      if(cnt>=3)
      {
         g_dayStart        = (datetime)StringToInteger(parts[0]);
         g_dayStartEquity  = StringToDouble(parts[1]);
         g_dailyLossHalted = (StringToInteger(parts[2])!=0);
      }
   }
   FileClose(fh);
}

void RecomputeHaltState()
{
   g_tradingHalted = g_dailyLossHalted || g_serverHalted;
   if(g_dailyLossHalted)
      g_haltReason = "Daily loss limit reached";
   else if(g_serverHalted)
      g_haltReason = (g_serverHaltReason!="") ? g_serverHaltReason : "Halted by server";
   else
      g_haltReason = "";
}

void ResetDailyTrackingIfNeeded()
{
   MqlDateTime dt;
   TimeToStruct(TimeGMT(), dt);
   dt.hour=0; dt.min=0; dt.sec=0;
   datetime todayStart = StructToTime(dt);
   if(g_dayStart != todayStart)
   {
      // AccountInfoDouble(ACCOUNT_EQUITY) can transiently report 0 while the
      // terminal is still reconnecting/resyncing with the trade server. Don't
      // baseline the day on a bad reading — retry on the next tick instead,
      // otherwise CheckDailyLossHalt() would return early (line 647) and
      // daily-loss protection would remain disabled for that day.
      double equityNow = AccountInfoDouble(ACCOUNT_EQUITY);
      if(!TerminalInfoInteger(TERMINAL_CONNECTED) || equityNow<=0) return;

      g_dayStart = todayStart;
      g_dayStartEquity = equityNow;
      if(g_dailyLossHalted)
      {
         g_dailyLossHalted = false;
         RecomputeHaltState();
         LogEvent("INFO","DAILY_RESET","","New trading day, halt cleared, start equity="+DoubleToString(g_dayStartEquity,2));
      }
      SaveDailyState();
   }
}

datetime g_lastDailyLossLogAt = 0;

// Effective daily loss limit %: prefers the admin-configured value relayed by
// the server (risk_settings, via pull.php's "dailyLossLimitPct" field) so an
// operator can retune this without recompiling/redeploying the EA. Falls back
// to the compiled-in InpDailyLossLimitPct input if the server hasn't supplied
// a value yet (e.g. before the first successful poll) or sends an invalid one.
double EffectiveDailyLossLimitPct()
{
   if(g_serverDailyLossLimitPct > 0) return g_serverDailyLossLimitPct;
   return InpDailyLossLimitPct;
}

void CheckDailyLossHalt()
{
   double limitPct = EffectiveDailyLossLimitPct();
   if(limitPct<=0 || g_dayStartEquity<=0) return;
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   // A transient ACCOUNT_EQUITY==0 (or disconnected terminal) reading is a
   // broker-sync glitch, not a real loss — skip the loss calculation to avoid
   // a false daily-loss halt on this transient bad reading (see POLL_FAIL/reconnect
   // cycles that can momentarily zero out account data).
   if(equity<=0 || !TerminalInfoInteger(TERMINAL_CONNECTED)) return;
   double lossPct = (g_dayStartEquity - equity) / g_dayStartEquity * 100.0;

   // Throttled visibility log (every 60s) so the daily-loss baseline/inputs can
   // be audited even when the limit is never breached. Uses real account
   // equity only — never derived from signal counts or rejected/unfilled
   // orders, so a string of EA-side rejections cannot move this number.
   datetime nowT = TimeCurrent();
   if(nowT - g_lastDailyLossLogAt >= 60)
   {
      g_lastDailyLossLogAt = nowT;
      LogEvent("INFO","DAILY_LOSS_CHECK","",
               "dayStartEquity="+DoubleToString(g_dayStartEquity,2)+
               " equity="+DoubleToString(equity,2)+
               " loss%="+DoubleToString(lossPct,2)+
               " limit%="+DoubleToString(limitPct,2)+
               " limitSource="+(g_serverDailyLossLimitPct>0?"server(admin)":"local(input)")+
               " halted="+(string)g_dailyLossHalted);
   }

   if(lossPct >= limitPct && !g_dailyLossHalted)
   {
      g_dailyLossHalted = true;
      RecomputeHaltState();
      SaveDailyState();
      LogEvent("ERROR","DAILY_LOSS_HALT","","loss%="+DoubleToString(lossPct,2)+" limit%="+DoubleToString(limitPct,2));
      Alert("ITGuruMt5Bridge: Daily loss limit reached ("+DoubleToString(lossPct,2)+"%). New trades halted.");
      SendNotification("ITGuruMt5Bridge: Daily loss limit reached. Trading halted.");
   }
}

//=============================== Execution ====================================

// Retriable broker return codes worth a bounded retry.
bool IsRetriableRetcode(uint retcode)
{
   return retcode==TRADE_RETCODE_REQUOTE
       || retcode==TRADE_RETCODE_PRICE_CHANGED
       || retcode==TRADE_RETCODE_PRICE_OFF
       || retcode==TRADE_RETCODE_TIMEOUT
       || retcode==TRADE_RETCODE_CONNECTION
       || retcode==TRADE_RETCODE_TRADE_DISABLED
       || retcode==10004; /*REQUOTE legacy; trade-context-busy is read via GetLastError(), not retcode*/
}

bool ConfirmExecution(const MqlTradeResult &res, string &confirmNote)
{
   if(res.deal>0 && HistoryDealSelect(res.deal))
   {
      confirmNote = "Deal confirmed in history #"+(string)res.deal;
      return true;
   }
   if(res.order>0 && PositionSelectByTicket(res.order))
   {
      confirmNote = "Position confirmed ticket=#"+(string)res.order;
      return true;
   }
   if(res.order>0 && OrderSelect(res.order))
   {
      confirmNote = "Pending order confirmed ticket=#"+(string)res.order;
      return true;
   }
   confirmNote = "Could not independently confirm execution (relying on retcode)";
   return false;
}

bool SendTrade(BridgeOrder &o)
{
   g_statSignalsReceived++;
   LogEvent("INFO","SIGNAL_RECEIVED",o.orderId,
            o.symbol+" "+o.side+" "+o.orderType+" lot="+DoubleToString(o.lot,2)+
            " entry="+DoubleToString(o.entry,_Digits)+" sl="+DoubleToString(o.sl,_Digits)+" tp="+DoubleToString(o.tp,_Digits));

   // Resolve the signal's symbol code to a broker/MarketWatch symbol name
   // before any downstream use (duplicate/chart checks, validation, order
   // placement). o.symbol is overwritten in place with the resolved name so
   // every subsequent step — including PostStatus messages — operates on a
   // symbol the terminal actually recognizes. The original requested code is
   // preserved in `requestedSymbol` for diagnostics.
   string requestedSymbol = o.symbol;
   string resolvedSymbol = "";
   bool symbolResolved = ResolveBrokerSymbol(requestedSymbol, o.brokerSymbolHint, o.orderId, resolvedSymbol);
   if(symbolResolved)
      o.symbol = resolvedSymbol;
   LogEvent("INFO","SIGNAL_STATE",o.orderId,"lifecycle=RECEIVED requestedSymbol="+requestedSymbol+" mappedSymbol="+(symbolResolved?resolvedSymbol:"(unresolved)"));

   if(IsDuplicateSignal(o.orderId))
   {
      g_statSignalsDuplicate++;
      // The server only stops redispatching an order once it has recorded a
      // final status for it. If our earlier PostStatus() call never reached
      // (or was never persisted by) the server — a transient HTTP failure —
      // the server keeps redispatching this SAME orderId forever, and without
      // this resync it would be silently dropped every time: "duplicates
      // ignored" growing in lockstep with "signals received" while no trade
      // (or rejection) is ever finalized on the server. Re-send our last
      // known status so the server can finalize it and stop redispatching.
      string dupStatus="", dupTicket="";
      double dupPrice=0.0; int dupDigits=-1;
      if(GetProcessedStatus(o.orderId, dupStatus, dupTicket, dupPrice, dupDigits))
      {
         LogEvent("WARN","SIGNAL_DUPLICATE",o.orderId,"already processed as "+dupStatus+"; resyncing status to server");
         PostStatus(o.orderId, dupStatus, dupTicket, "Resynced (duplicate signal redelivered)", dupPrice, dupDigits);
      }
      else if(ReconcileLegacyStatus(o, dupStatus, dupTicket, dupPrice, dupDigits))
      {
         // Legacy entry with no stored status: derive and persist the real
         // outcome from broker state instead of ignoring the redispatch.
         LogEvent("WARN","SIGNAL_DUPLICATE",o.orderId,"legacy entry missing status; reconciled as "+dupStatus+" from broker state");
         MarkProcessed(o.orderId, dupStatus, dupTicket, dupPrice, dupDigits);
         PostStatus(o.orderId, dupStatus, dupTicket, "Resynced (reconciled from broker history/open state)", dupPrice, dupDigits);
      }
      else
      {
         LogEvent("WARN","SIGNAL_DUPLICATE",o.orderId,"already processed, ignoring");
      }
      return false;
   }

   if(g_tradingHalted)
   {
      g_statSignalsRejected++;
      LogEvent("WARN","SIGNAL_REJECTED",o.orderId,"trading halted: "+g_haltReason);
      PostStatus(o.orderId,"REJECTED","", "Trading halted: "+g_haltReason, 0.0);
      MarkProcessed(o.orderId, "REJECTED", "");
      return false;
   }

   if(InpOnlyChartSymbol && o.symbol != _Symbol)
      return false; // not for this chart/terminal instance; leave for correct terminal

   string reason;

   if(!ValidateSymbolTradable(o.symbol, reason))
   {
      g_statSignalsRejected++;
      LogEvent("WARN","VALIDATION_FAIL",o.orderId,reason);
      PostStatus(o.orderId,"REJECTED","", reason, 0.0);
      MarkProcessed(o.orderId, "REJECTED", "");
      return false;
   }

   if(o.side!="BUY" && o.side!="SELL")
   {
      g_statSignalsRejected++;
      LogEvent("WARN","VALIDATION_FAIL",o.orderId,"invalid side: "+o.side);
      PostStatus(o.orderId,"REJECTED","", "Invalid signal direction", 0.0);
      MarkProcessed(o.orderId, "REJECTED", "");
      return false;
   }

   if(!ValidateNotStale(o, reason))
   {
      g_statSignalsRejected++;
      LogEvent("WARN","VALIDATION_FAIL",o.orderId,reason);
      PostStatus(o.orderId,"EXPIRED","", reason, 0.0);
      MarkProcessed(o.orderId, "EXPIRED", "");
      return false;
   }

   if(!ValidateSession(reason))
   {
      g_statSignalsRejected++;
      LogEvent("WARN","VALIDATION_FAIL",o.orderId,reason);
      PostStatus(o.orderId,"REJECTED","", reason, 0.0);
      MarkProcessed(o.orderId, "REJECTED", "");
      return false;
   }

   double spreadPts=0;
   if(!ValidateSpread(o.symbol, spreadPts, reason))
   {
      g_statSignalsRejected++;
      LogEvent("WARN","VALIDATION_FAIL",o.orderId,reason);
      PostStatus(o.orderId,"REJECTED","", reason, 0.0);
      MarkProcessed(o.orderId, "REJECTED", "");
      return false;
   }

   double lot = MathMin(o.lot, InpMaxLotSize);
   if(lot<=0)
   {
      g_statSignalsRejected++;
      LogEvent("WARN","VALIDATION_FAIL",o.orderId,"lot size invalid after capping");
      PostStatus(o.orderId,"REJECTED","", "Lot size invalid", 0.0);
      MarkProcessed(o.orderId, "REJECTED", "");
      return false;
   }

   int countSameSymbol; double totalExposure; bool hasBuy, hasSell, alreadyPlaced, alreadyPlacedPending;
   ScanOpenState(o.symbol, o.orderId, countSameSymbol, totalExposure, hasBuy, hasSell, alreadyPlaced, alreadyPlacedPending);

   if(alreadyPlaced)
   {
      // Idempotency guard: an order tagged with this orderId already exists on
      // the account (e.g. a prior send succeeded but the HTTP confirmation was
      // lost before a retry). Do not place a second order.
      if(alreadyPlacedPending)
      {
         g_statSignalsPending++;
         LogEvent("WARN","DUPLICATE_GUARD",o.orderId,"matching pending order already exists on account; skipping resend");
         PostStatus(o.orderId,"RECEIVED","", "Already placed on account as a pending order (idempotent skip)", 0.0);
         MarkProcessed(o.orderId, "RECEIVED", "");
      }
      else
      {
         g_statSignalsFilled++;
         LogEvent("WARN","DUPLICATE_GUARD",o.orderId,"matching ticket already exists on account; skipping resend");
         PostStatus(o.orderId,"FILLED","", "Already placed on account (idempotent skip)", 0.0);
         MarkProcessed(o.orderId, "FILLED", "");
      }
      return true;
   }

   if(countSameSymbol >= InpMaxTradesPerSymbol)
   {
      g_statSignalsRejected++;
      reason = "Max trades per symbol reached ("+(string)countSameSymbol+"/"+(string)InpMaxTradesPerSymbol+")";
      LogEvent("WARN","RISK_REJECT",o.orderId,reason);
      PostStatus(o.orderId,"REJECTED","", reason, 0.0);
      MarkProcessed(o.orderId, "REJECTED", "");
      return false;
   }

   if(totalExposure + lot > InpMaxTotalExposureLots)
   {
      g_statSignalsRejected++;
      reason = "Max total exposure exceeded ("+DoubleToString(totalExposure,2)+"+"+DoubleToString(lot,2)+">"+DoubleToString(InpMaxTotalExposureLots,2)+")";
      LogEvent("WARN","RISK_REJECT",o.orderId,reason);
      PostStatus(o.orderId,"REJECTED","", reason, 0.0);
      MarkProcessed(o.orderId, "REJECTED", "");
      return false;
   }

   if(!InpAllowHedging)
   {
      if((o.side=="BUY" && hasSell) || (o.side=="SELL" && hasBuy))
      {
         g_statSignalsRejected++;
         reason = "Hedging disabled: opposite position already open on "+o.symbol;
         LogEvent("WARN","RISK_REJECT",o.orderId,reason);
         PostStatus(o.orderId,"REJECTED","", reason, 0.0);
         MarkProcessed(o.orderId, "REJECTED", "");
         return false;
      }
   }

   MqlTick tick;
   if(!SymbolInfoTick(o.symbol,tick))
   {
      g_statSignalsRejected++;
      LogEvent("WARN","VALIDATION_FAIL",o.orderId,"SymbolInfoTick failed");
      PostStatus(o.orderId,"REJECTED","", "SymbolInfoTick failed: "+o.symbol, 0.0);
      MarkProcessed(o.orderId, "REJECTED", "");
      return false;
   }

   bool isMarket = (o.orderType=="BUY_MARKET" || o.orderType=="SELL_MARKET");
   double execPrice = isMarket ? (o.side=="BUY" ? tick.ask : tick.bid) : o.entry;

   if(!ValidateStopLevels(o.symbol, execPrice, o.sl, o.tp, o.side, reason))
   {
      g_statSignalsRejected++;
      LogEvent("WARN","VALIDATION_FAIL",o.orderId,reason);
      PostStatus(o.orderId,"REJECTED","", reason, 0.0);
      MarkProcessed(o.orderId, "REJECTED", "");
      return false;
   }

   if(!ValidateMargin(o.symbol, o.side, lot, execPrice, reason))
   {
      g_statSignalsRejected++;
      LogEvent("WARN","RISK_REJECT",o.orderId,reason);
      PostStatus(o.orderId,"REJECTED","", reason, 0.0);
      MarkProcessed(o.orderId, "REJECTED", "");
      return false;
   }

   // All checks passed; about to act. Do NOT advance server status yet: the order
   // must remain dispatchable (QUEUED/DISPATCHED) until a definitive broker outcome
   // is known. Otherwise, if the EA terminates before reporting a final result, the
   // order gets stuck forever since api/mt5/pull.php only redispatches QUEUED or
   // stale DISPATCHED orders, never RECEIVED. The idempotency guard above (alreadyPlaced)
   // safely handles any redispatch of an order that actually reached the broker.
   LogEvent("INFO","SIGNAL_VALIDATED",o.orderId,"EA validated signal, submitting to broker");

   MqlTradeRequest req;
   MqlTradeResult  res;
   ZeroMemory(req);
   ZeroMemory(res);

   req.magic      = InpMagic;
   req.symbol     = o.symbol;
   req.volume     = lot;
   req.deviation  = InpMaxSlippagePoints;
   req.comment    = o.orderId;
   req.sl         = o.sl;
   req.tp         = o.tp;

   string ot = o.orderType;
   if(isMarket)
   {
      req.action = TRADE_ACTION_DEAL;
      req.type   = (o.side=="BUY" ? ORDER_TYPE_BUY : ORDER_TYPE_SELL);
      req.price  = execPrice;
      req.type_filling = ORDER_FILLING_FOK;
   }
   else
   {
      req.action = TRADE_ACTION_PENDING;
      if(ot=="BUY_LIMIT")       req.type = ORDER_TYPE_BUY_LIMIT;
      else if(ot=="SELL_LIMIT") req.type = ORDER_TYPE_SELL_LIMIT;
      else if(ot=="BUY_STOP")   req.type = ORDER_TYPE_BUY_STOP;
      else if(ot=="SELL_STOP")  req.type = ORDER_TYPE_SELL_STOP;
      else
      {
         g_statSignalsRejected++;
         LogEvent("WARN","VALIDATION_FAIL",o.orderId,"Unknown orderType: "+ot);
         PostStatus(o.orderId,"REJECTED","", "Unknown orderType: "+ot, 0.0);
         MarkProcessed(o.orderId, "REJECTED", "");
         return false;
      }
      req.price        = o.entry;
      req.type_time    = ORDER_TIME_GTC;
      req.type_filling = ORDER_FILLING_RETURN;
   }

   int reqDigits = (int)SymbolInfoInteger(req.symbol, SYMBOL_DIGITS);
   LogEvent("INFO","ORDER_SEND_REQUEST",o.orderId,
            "action="+(string)req.action+" type="+(string)req.type+" symbol="+req.symbol+
            " volume="+DoubleToString(req.volume,2)+" price="+DoubleToString(req.price,reqDigits)+
            " sl="+DoubleToString(req.sl,reqDigits)+" tp="+DoubleToString(req.tp,reqDigits)+
            " deviation="+(string)req.deviation+" magic="+(string)req.magic);

   bool ok=false;
   int attempt=0;
   for(attempt=0; attempt<=InpMaxOrderRetries; attempt++)
   {
      ZeroMemory(res);
      ok = OrderSend(req,res);
      LogEvent("INFO","BROKER_RESPONSE",o.orderId,
               "attempt="+(string)(attempt+1)+" ok="+(string)ok+" retcode="+(string)res.retcode+
               " deal="+(string)res.deal+" order="+(string)res.order+" price="+DoubleToString(res.price,reqDigits)+
               " comment="+res.comment);
      if(ok && (res.retcode==TRADE_RETCODE_DONE || res.retcode==TRADE_RETCODE_DONE_PARTIAL || res.retcode==TRADE_RETCODE_PLACED))
         break;

      if(!IsRetriableRetcode(res.retcode) || attempt==InpMaxOrderRetries)
         break;

      // Refresh price before retrying a market order.
      if(isMarket && SymbolInfoTick(o.symbol,tick))
         req.price = (o.side=="BUY" ? tick.ask : tick.bid);
      Sleep(InpRetryDelayMs);
   }

   string ticket = (string)((res.order>0)?res.order:res.deal);

   if(!ok || !(res.retcode==TRADE_RETCODE_DONE || res.retcode==TRADE_RETCODE_DONE_PARTIAL || res.retcode==TRADE_RETCODE_PLACED))
   {
      g_statSignalsRejected++;
      string msg = "Broker reject after "+(string)(attempt+1)+" attempt(s) retcode="+(string)res.retcode+" comment="+res.comment;
      LogEvent("ERROR","ORDER_REJECTED",o.orderId,msg);
      PostStatus(o.orderId,"REJECTED",ticket,msg,0.0);
      MarkProcessed(o.orderId, "REJECTED", ticket);
      return false;
   }

   string confirmNote;
   bool confirmed = ConfirmExecution(res, confirmNote);
   LogEvent(confirmed?"INFO":"WARN","EXECUTION_CONFIRM",o.orderId,confirmNote);

   if(res.retcode==TRADE_RETCODE_PLACED)
   {
      g_statSignalsPending++;
      LogEvent("INFO","ORDER_PENDING_PLACED",o.orderId,"ticket="+ticket);
      PostStatus(o.orderId,"RECEIVED",ticket,"Pending order placed. "+confirmNote,0.0);
      MarkProcessed(o.orderId, "RECEIVED", ticket);
   }
   else
   {
      int filledDigits = (int)SymbolInfoInteger(o.symbol, SYMBOL_DIGITS);
      g_statSignalsFilled++;
      LogEvent("INFO","ORDER_FILLED",o.orderId,"ticket="+ticket+" price="+DoubleToString(res.price,filledDigits));
      PostStatus(o.orderId,"FILLED",ticket,"Executed. "+confirmNote,res.price,filledDigits);
      MarkProcessed(o.orderId, "FILLED", ticket, res.price, filledDigits);
   }

   return true;
}

//============================ Poll loop & connection resilience ===============

int BackoffSecondsForFailures(int failures)
{
   if(failures < InpMaxConsecutiveFailBeforeBackoff) return MathMax(1,InpPollSeconds);
   int extra = failures - InpMaxConsecutiveFailBeforeBackoff;
   double backoff = InpPollSeconds * MathPow(2, MathMin(extra, 10));
   return (int)MathMin(backoff, InpMaxBackoffSeconds);
}

void PollAndExecute()
{
   datetime nowTime = TimeLocal();
   if(nowTime < g_nextPollAllowedAt)
      return; // still backing off

   string base = TrimSlash(InpBaseUrl);
   string url  = base + "/api/mt5/pull.php?limit=20&terminal=" + InpTerminalId;
   string headers =
      "X-MT5-BRIDGE-KEY: " + InpBridgeKey + "\r\n"
      "Content-Type: application/json\r\n";

   string resp, respHeaders;
   int code=-1;
   bool httpOk = HttpRequest("GET",url,headers,"",resp,respHeaders,code);

   if(!httpOk || code!=200)
   {
      g_consecutiveFailures++;
      g_statPollFailures++;
      int backoff = BackoffSecondsForFailures(g_consecutiveFailures);
      g_nextPollAllowedAt = nowTime + backoff;
      LogEvent("ERROR","POLL_FAIL","","httpOk="+(string)httpOk+" code="+(string)code+" consecutiveFailures="+(string)g_consecutiveFailures+" nextRetryIn="+(string)backoff+"s");

      if(g_consecutiveFailures>=InpAlertAfterFailures && !g_disconnectAlerted)
      {
         g_disconnectAlerted = true;
         string msg = "ITGuruMt5Bridge: lost connection to signal bridge for "+(string)g_consecutiveFailures+" consecutive polls.";
         Alert(msg);
         SendNotification(msg);
         LogEvent("ERROR","DISCONNECT_ALERT","",msg);
      }
      return;
   }

   // Successful HTTP round-trip.
   g_consecutiveFailures = 0;
   g_nextPollAllowedAt = nowTime + MathMax(1,InpPollSeconds);
   g_lastSuccessfulPoll = nowTime;
   g_statPollOk++;
   if(g_disconnectAlerted)
   {
      g_disconnectAlerted = false;
      string msg = "ITGuruMt5Bridge: signal bridge connection restored.";
      Print(msg);
      SendNotification(msg);
      LogEvent("INFO","RECONNECTED","",msg);
   }

   double newServerDailyLossLimitPct = JsonGetNumber(resp,"dailyLossLimitPct",-1.0);
   if(newServerDailyLossLimitPct > 0 && MathAbs(newServerDailyLossLimitPct - g_serverDailyLossLimitPct) > 0.0001)
   {
      LogEvent("INFO","DAILY_LOSS_LIMIT_UPDATED","",
               "server-configured daily loss limit changed: "+DoubleToString(g_serverDailyLossLimitPct,2)+
               "% -> "+DoubleToString(newServerDailyLossLimitPct,2)+"%");
      g_serverDailyLossLimitPct = newServerDailyLossLimitPct;
   }

   bool serverHalted = JsonGetBool(resp,"halted",false);
   if(serverHalted)
   {
      string serverReason = JsonGetString(resp,"haltReason");
      if(!g_serverHalted)
         LogEvent("WARN","SERVER_HALT","","server reports trading halted: "+serverReason);
      g_serverHalted = true;
      g_serverHaltReason = serverReason;
      RecomputeHaltState();
      return; // do not process any orders while halted
   }
   else if(g_serverHalted)
   {
      g_serverHalted = false;
      g_serverHaltReason = "";
      RecomputeHaltState();
      LogEvent("INFO","SERVER_HALT_CLEARED","","server-side halt lifted");
   }

   BridgeOrder orders[];
   int n = ParseOrders(resp, orders);
   if(n<=0) return;

   for(int i=0;i<n;i++)
      SendTrade(orders[i]);
}

//=============================== Dashboard ====================================

void UpdateDashboard()
{
   string connStatus = (g_consecutiveFailures==0) ? "CONNECTED" : ("DISCONNECTED x"+(string)g_consecutiveFailures);
   string haltStatus  = g_tradingHalted ? ("HALTED: "+g_haltReason) : "ACTIVE";

   string txt = "";
   txt += "=== ITGuru MT5 Bridge =============\n";
   txt += "Terminal: "+InpTerminalId+"   Magic: "+(string)InpMagic+"\n";
   txt += "Connection: "+connStatus+"   Last OK poll: "+(g_lastSuccessfulPoll>0?TimeToString(g_lastSuccessfulPoll,TIME_DATE|TIME_SECONDS):"never")+"\n";
   txt += "Trading: "+haltStatus+"\n";
   txt += "------------------------------------\n";
   txt += "Signals received:  "+(string)g_statSignalsReceived+"\n";
   txt += "Filled:             "+(string)g_statSignalsFilled+"\n";
   txt += "Pending placed:     "+(string)g_statSignalsPending+"\n";
   txt += "Rejected:           "+(string)g_statSignalsRejected+"\n";
   txt += "Duplicates ignored: "+(string)g_statSignalsDuplicate+"\n";
   txt += "Poll ok/fail:       "+(string)g_statPollOk+" / "+(string)g_statPollFailures+"\n";
   txt += "Equity: "+DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY),2)+
          "   Free margin: "+DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE),2)+"\n";
   txt += "====================================";

   Comment(txt);
}

//=============================== EA lifecycle ==================================

//----------------------- Pending-order final-state reporting -------------------

// This EA reports a pending order as "RECEIVED" once placed on the broker, but
// has no further hook to report its eventual fill/cancellation/expiration/rejection.
// OnTradeTransaction closes that gap by watching for deals/order-history entries
// tied to pending order types (identified via the order comment == orderId) and
// pushing the final status to the backend so monitoring/order status stays accurate.
void OnTradeTransaction(const MqlTradeTransaction &trans,
                         const MqlTradeRequest &request,
                         const MqlTradeResult &result)
{
   if(trans.type==TRADE_TRANSACTION_DEAL_ADD)
   {
      if(!HistoryDealSelect(trans.deal)) return;
      if((long)HistoryDealGetInteger(trans.deal, DEAL_MAGIC) != InpMagic) return;
      if((long)HistoryDealGetInteger(trans.deal, DEAL_ENTRY) != DEAL_ENTRY_IN) return; // only new fills

      ulong orderTicket = (ulong)HistoryDealGetInteger(trans.deal, DEAL_ORDER);
      if(orderTicket==0 || !HistoryOrderSelect(orderTicket)) return;

      long otype = HistoryOrderGetInteger(orderTicket, ORDER_TYPE);
      bool wasPending = (otype==ORDER_TYPE_BUY_LIMIT || otype==ORDER_TYPE_SELL_LIMIT ||
                          otype==ORDER_TYPE_BUY_STOP  || otype==ORDER_TYPE_SELL_STOP  ||
                          otype==ORDER_TYPE_BUY_STOP_LIMIT || otype==ORDER_TYPE_SELL_STOP_LIMIT);
      if(!wasPending) return; // market fills already reported synchronously in SendTrade()

      string orderId = HistoryOrderGetString(orderTicket, ORDER_COMMENT);
      if(orderId=="") return;

      string symbol = HistoryDealGetString(trans.deal, DEAL_SYMBOL);
      int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
      double price = HistoryDealGetDouble(trans.deal, DEAL_PRICE);
      string ticket = (string)orderTicket;

      LogEvent("INFO","ORDER_TRANSACTION_FILLED",orderId,"pending order filled, deal=#"+(string)trans.deal);
      PostStatus(orderId,"FILLED",ticket,"Pending order filled (OnTradeTransaction)",price,digits);
      g_statSignalsPending = MathMax(0, g_statSignalsPending-1);
      g_statSignalsFilled++;
      MarkProcessed(orderId, "FILLED", ticket, price, digits);
      return;
   }

   if(trans.type==TRADE_TRANSACTION_HISTORY_ADD)
   {
      if(!HistoryOrderSelect(trans.order)) return;
      if((long)HistoryOrderGetInteger(trans.order, ORDER_MAGIC) != InpMagic) return;

      long otype = HistoryOrderGetInteger(trans.order, ORDER_TYPE);
      bool wasPending = (otype==ORDER_TYPE_BUY_LIMIT || otype==ORDER_TYPE_SELL_LIMIT ||
                          otype==ORDER_TYPE_BUY_STOP  || otype==ORDER_TYPE_SELL_STOP  ||
                          otype==ORDER_TYPE_BUY_STOP_LIMIT || otype==ORDER_TYPE_SELL_STOP_LIMIT);
      if(!wasPending) return;

      long state = HistoryOrderGetInteger(trans.order, ORDER_STATE);
      if(state==ORDER_STATE_FILLED) return; // handled via TRADE_TRANSACTION_DEAL_ADD above

      string orderId = HistoryOrderGetString(trans.order, ORDER_COMMENT);
      if(orderId=="") return;

      string status, msg;
      if(state==ORDER_STATE_EXPIRED)       { status="EXPIRED";   msg="Pending order expired"; }
      else if(state==ORDER_STATE_REJECTED) { status="REJECTED";  msg="Pending order rejected by broker"; }
      else if(state==ORDER_STATE_CANCELED) { status="CANCELLED"; msg="Pending order cancelled"; }
      else return; // other transitional states are not relevant here

      LogEvent("INFO","ORDER_TRANSACTION_"+status,orderId,msg);
      PostStatus(orderId,status,(string)trans.order,msg,0.0);
      g_statSignalsPending = MathMax(0, g_statSignalsPending-1);
      MarkProcessed(orderId, status, (string)trans.order);
   }
}

int OnInit()
{
   if(StringLen(InpBridgeKey) < 16)
   {
      Print("FATAL: InpBridgeKey is empty or too short. Set a strong secret matching the server MT5_BRIDGE_KEY. EA will not poll.");
      Comment("ITGuruMt5Bridge: NOT RUNNING - InpBridgeKey not configured.");
      return(INIT_FAILED);
   }

   LoadProcessedIds();
   LoadDailyState();
   RecomputeHaltState();
   ResetDailyTrackingIfNeeded();

   EventSetTimer(MathMax(1,InpPollSeconds));

   LogEvent("INFO","EA_INIT","","Base="+TrimSlash(InpBaseUrl)+" TerminalId="+InpTerminalId+
            ". Ensure WebRequest URL is allow-listed in Tools > Options > Expert Advisors.");
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   SaveProcessedIds();
   Comment("");
   LogEvent("INFO","EA_DEINIT","","reason="+(string)reason);
}

void OnTimer()
{
   ResetDailyTrackingIfNeeded();
   CheckDailyLossHalt();
   PollAndExecute();
   UpdateDashboard();
}
