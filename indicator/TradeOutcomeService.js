/**
 * TradeOutcomeService.js
 * ──────────────────────
 * SINGLE SOURCE OF TRUTH for trade outcome tracking.
 *
 * This service centralizes:
 * - Trade outcome determination (WIN, LOSS, BREAKEVEN, EXPIRED, CANCELLED)
 * - Outcome state persistence (localStorage + database)
 * - Statistics calculation (from database, not memory)
 * - Notification deduplication (checks database registry)
 *
 * All outcome changes must go through this service.
 * This prevents duplicate notifications and ensures accuracy.
 */

class TradeOutcomeService {
    constructor() {
        // In-memory cache of recent outcomes (for quick access)
        this.outcomeCache = new Map();
        this.notificationRegistry = new Map();
        
        // Configuration
        this.autoLogToDatabase = true;
        this.deduplicationEnabled = true;
        this.logLevel = 'INFO'; // 'DEBUG', 'INFO', 'WARN', 'ERROR'
    }

    /**
     * Get the app's JWT auth token for API requests.
     * NOTE: `getTelegramCredentials().token` is the Telegram BOT token, not the
     * user's session JWT — using it here previously caused every trade-outcome
     * API call to be rejected with 401 Unauthorized. ITGuruAuth.getToken() is
     * the correct accessor for the JWT used by all other authenticated calls.
     */
    _getAuthToken() {
        if (typeof ITGuruAuth !== 'undefined' && ITGuruAuth && typeof ITGuruAuth.getToken === 'function') {
            return ITGuruAuth.getToken() || '';
        }
        return sessionStorage.getItem('itguru_auth_token') || '';
    }

    /**
     * Build a human-readable description of a failed fetch response.
     * `response.statusText` is frequently blank (e.g. HTTP/2 responses), so
     * fall back to the JSON/text error body and the numeric status code.
     */
    async _describeErrorResponse(response) {
        let detail = '';
        try {
            const text = await response.text();
            if (text) {
                try {
                    const data = JSON.parse(text);
                    detail = (data && (data.error || data.message)) || text;
                } catch {
                    detail = text;
                }
            }
        } catch {
            // ignore body read failures; fall back to status below
        }
        return detail || response.statusText || `HTTP ${response.status}`;
    }

    /**
     * Generate a unique trade ID (UUID v4)
     */
    generateTradeId() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    /**
     * Mark a trade as won.
     * @param {Object} trade - trade object with entry, sl, tp, symbol, etc.
     * @param {number} exitPrice - actual exit price (should equal TP for true WIN)
     * @param {Object} options - { reason, telegramSend, dbLog }
     */
    async markTradeWIN(trade, exitPrice, options = {}) {
        const {
            reason = 'TP_FINAL',
            telegramSend = true,
            dbLog = true,
            partialTpHit = false
        } = options;

        const tradeId = trade.tradeId || trade.signalId || this.generateTradeId();
        this._log('INFO', `[WIN] Trade ${tradeId} marked WIN (reason: ${reason})`);

        // Check if already terminal
        if (this._isTerminalState(trade)) {
            this._log('WARN', `[WIN] Trade ${tradeId} already in terminal state: ${trade.result}`);
            return false;
        }

        // Update trade object
        trade.result = 'WIN';
        trade.terminal_reason = reason;
        trade.exitPrice = exitPrice;
        trade.exit_timestamp = new Date().toISOString();

        // Update cache
        this.outcomeCache.set(tradeId, {
            outcome: 'WIN',
            timestamp: Date.now(),
            reason
        });

        // Persist to localStorage
        this._persistToLocalStorage(trade);

        // Log to database
        if (dbLog && this.autoLogToDatabase) {
            await this._logOutcomeToDatabase(trade);
        }

        // Send Telegram notification
        if (telegramSend && typeof sendStrategyOutcomeTelegram === 'function') {
            trade._stratOutcomeSent = false; // Reset to allow send
            await this._sendOutcomeNotification(trade, 'TRADE_WIN');
        }

        return true;
    }

    /**
     * Mark a trade as lost.
     */
    async markTradeLOSS(trade, exitPrice, options = {}) {
        const {
            reason = 'STOP_LOSS',
            telegramSend = true,
            dbLog = true
        } = options;

        const tradeId = trade.tradeId || trade.signalId || this.generateTradeId();
        this._log('INFO', `[LOSS] Trade ${tradeId} marked LOSS (reason: ${reason})`);

        // Check if already terminal
        if (this._isTerminalState(trade)) {
            this._log('WARN', `[LOSS] Trade ${tradeId} already in terminal state: ${trade.result}`);
            return false;
        }

        // Update trade object
        trade.result = 'LOSS';
        trade.terminal_reason = reason;
        trade.exitPrice = exitPrice;
        trade.exit_timestamp = new Date().toISOString();

        // Update cache
        this.outcomeCache.set(tradeId, {
            outcome: 'LOSS',
            timestamp: Date.now(),
            reason
        });

        // Persist to localStorage
        this._persistToLocalStorage(trade);

        // Log to database
        if (dbLog && this.autoLogToDatabase) {
            await this._logOutcomeToDatabase(trade);
        }

        // Send Telegram notification
        if (telegramSend && typeof sendStrategyOutcomeTelegram === 'function') {
            trade._stratOutcomeSent = false; // Reset to allow send
            await this._sendOutcomeNotification(trade, 'TRADE_LOSS');
        }

        return true;
    }

    /**
     * Mark a trade as breakeven (e.g., SL hit after partial TP).
     */
    async markTradeBREAKEVEN(trade, options = {}) {
        const {
            reason = 'PARTIAL_TP_SL',
            telegramSend = true,
            dbLog = true
        } = options;

        const tradeId = trade.tradeId || trade.signalId || this.generateTradeId();
        this._log('INFO', `[BREAKEVEN] Trade ${tradeId} marked BREAKEVEN (reason: ${reason})`);

        // Check if already terminal
        if (this._isTerminalState(trade)) {
            this._log('WARN', `[BREAKEVEN] Trade ${tradeId} already in terminal state: ${trade.result}`);
            return false;
        }

        // Update trade object
        trade.result = 'BREAKEVEN';
        trade.terminal_reason = reason;
        trade.exitPrice = trade.entry;
        trade.exit_timestamp = new Date().toISOString();

        // Update cache
        this.outcomeCache.set(tradeId, {
            outcome: 'BREAKEVEN',
            timestamp: Date.now(),
            reason
        });

        // Persist to localStorage
        this._persistToLocalStorage(trade);

        // Log to database
        if (dbLog && this.autoLogToDatabase) {
            await this._logOutcomeToDatabase(trade);
        }

        // Send Telegram notification
        if (telegramSend && typeof sendStrategyOutcomeTelegram === 'function') {
            trade._stratOutcomeSent = false;
            await this._sendOutcomeNotification(trade, 'TRADE_BREAKEVEN');
        }

        return true;
    }

    /**
     * Mark a trade as expired.
     */
    async markTradeEXPIRED(trade, options = {}) {
        const {
            reason = 'TIMEOUT',
            telegramSend = true,
            dbLog = true
        } = options;

        const tradeId = trade.tradeId || trade.signalId || this.generateTradeId();
        this._log('INFO', `[EXPIRED] Trade ${tradeId} marked EXPIRED (reason: ${reason})`);

        // Check if already terminal
        if (this._isTerminalState(trade)) {
            this._log('WARN', `[EXPIRED] Trade ${tradeId} already in terminal state: ${trade.result}`);
            return false;
        }

        // Update trade object
        trade.result = 'EXPIRED';
        trade.terminal_reason = reason;
        trade.exit_timestamp = new Date().toISOString();

        // Update cache
        this.outcomeCache.set(tradeId, {
            outcome: 'EXPIRED',
            timestamp: Date.now(),
            reason
        });

        // Persist to localStorage
        this._persistToLocalStorage(trade);

        // Log to database
        if (dbLog && this.autoLogToDatabase) {
            await this._logOutcomeToDatabase(trade);
        }

        // Send Telegram notification
        if (telegramSend && typeof sendStrategyOutcomeTelegram === 'function') {
            trade._stratOutcomeSent = false;
            await this._sendOutcomeNotification(trade, 'TRADE_EXPIRED');
        }

        return true;
    }

    /**
     * Register a partial TP hit and prevent duplicates.
     */
    async registerPartialTPHit(trade, partialLevel, index = 1, options = {}) {
        const {
            telegramSend = true,
            dbLog = true
        } = options;

        const tradeId = trade.tradeId || trade.signalId || this.generateTradeId();
        const notifType = `PARTIAL_TP_${index}`;
        
        this._log('INFO', `[TP${index}] Trade ${tradeId} partial TP hit at level ${partialLevel}`);

        // Check if already sent
        if (await this._checkNotificationDedup(tradeId, notifType)) {
            this._log('WARN', `[DUPLICATE_BLOCKED] ${notifType} already sent for trade ${tradeId}`);
            return false;
        }

        // Mark the flag
        trade[`partialTp${index}Hit`] = true;
        trade[`partialTp${index}Level`] = partialLevel;
        trade[`partialTp${index}Time`] = new Date().toISOString();
        trade.partialTpHit = true;

        // Persist to localStorage
        this._persistToLocalStorage(trade);

        // Log to database
        if (dbLog && this.autoLogToDatabase) {
            await this._updatePartialTPInDatabase(trade, index, partialLevel);
        }

        // Send Telegram notification
        if (telegramSend && typeof sendPartialTpTelegram === 'function') {
            await sendPartialTpTelegram(trade, partialLevel);
            await this._recordNotificationSent(tradeId, notifType, 'PARTIAL_TP_ALERT');
        } else {
            await this._recordNotificationSent(tradeId, notifType, 'SKIPPED');
        }

        return true;
    }

    /**
     * Check if notification was already sent (persistent check).
     * Checks both in-memory cache and database.
     */
    async _checkNotificationDedup(tradeId, notificationType) {
        // Check in-memory cache first
        const cacheKey = `${tradeId}::${notificationType}`;
        if (this.notificationRegistry.has(cacheKey)) {
            return true;
        }

        // Check database (requires API call)
        if (this.deduplicationEnabled) {
            try {
                const response = await fetch('/api/trades/check_notification?trade_id=' + 
                    encodeURIComponent(tradeId) + '&notification_type=' + encodeURIComponent(notificationType), {
                    headers: { 'Authorization': 'Bearer ' + this._getAuthToken() }
                });
                if (response.ok) {
                    const data = await response.json();
                    if (data.sent) {
                        this.notificationRegistry.set(cacheKey, true);
                        return true;
                    }
                }
            } catch (err) {
                this._log('WARN', `Failed to check notification dedup: ${err.message}`);
                // Fall through - allow send if database check fails
            }
        }

        return false;
    }

    /**
     * Record a notification as sent to both cache and database.
     */
    async _recordNotificationSent(tradeId, notificationType, status = 'sent') {
        const cacheKey = `${tradeId}::${notificationType}`;
        this.notificationRegistry.set(cacheKey, true);

        // Log to database
        try {
            const token = this._getAuthToken();
            const response = await fetch('/api/trades/check_notification', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    trade_id: tradeId,
                    notification_type: notificationType,
                    telegram_status: status
                })
            });

            if (!response.ok) {
                this._log('WARN', `Failed to record notification: ${await this._describeErrorResponse(response)}`);
            }
        } catch (err) {
            this._log('WARN', `Error recording notification to database: ${err.message}`);
        }
    }

    /**
     * Log a complete trade outcome to the database.
     */
    async _logOutcomeToDatabase(trade) {
        try {
            const token = this._getAuthToken();
            const metadata = {
                candleIdx: trade.candleIdx,
                epoch: trade.epoch,
                mode: trade.mode,
                volCategory: trade.volCategory,
                entry_delay_mode: trade.entryDelayMode || null,
                trigger_level: Number.isFinite(trade.triggerLevel) ? Number(trade.triggerLevel) : null,
                trigger_idx: Number.isFinite(trade.triggerIdx) ? Number(trade.triggerIdx) : null,
                entry_quality_score: Number.isFinite(trade.entryQualityScore) ? Number(trade.entryQualityScore) : null,
                entry_quality_breakdown: trade.entryQualityBreakdown || null,
                trend_strength_score: Number.isFinite(trade.trendStrengthScore) ? Number(trade.trendStrengthScore) : null,
                atr_ratio: Number.isFinite(trade.atrRatio) ? Number(trade.atrRatio) : null,
                structure_ok: typeof trade.structureOk === 'boolean' ? trade.structureOk : null,
                pullback_ok: typeof trade.pullbackOk === 'boolean' ? trade.pullbackOk : null,
                mae: Number.isFinite(trade._mae) ? Number(trade._mae) : null,
                mfe: Number.isFinite(trade._mfe) ? Number(trade._mfe) : null,
                sl_overshoot: Number.isFinite(trade._slOvershoot) ? Number(trade._slOvershoot) : null,
                sl_then_tp_flag: trade._slThenTpFlag ? 1 : 0,
                tp_after_sl_seconds: Number.isFinite(trade._tpAfterSlSeconds) ? Number(trade._tpAfterSlSeconds) : null,
                reversal_distance: Number.isFinite(trade._reversalDistance) ? Number(trade._reversalDistance) : null
            };
            const payload = {
                trade_id: trade.tradeId || trade.signalId || this.generateTradeId(),
                signal_id: trade.signalId || null,
                symbol: trade.symbol || getActiveSymbol?.() || '',
                strategy_type: trade.type || 'unknown',
                direction: trade.dir,
                entry_price: trade.entry,
                entry_timestamp: (Number.isFinite(trade.epoch) && trade.epoch > 0)
                    ? new Date(trade.epoch * 1000).toISOString()
                    : (Number.isFinite(trade.createdAtMs) ? new Date(trade.createdAtMs).toISOString() : new Date().toISOString()),
                stop_loss: trade.sl,
                take_profit: trade.tp,
                outcome: trade.result,
                terminal_reason: trade.terminal_reason,
                exit_price: trade.exitPrice,
                exit_timestamp: trade.exit_timestamp || new Date().toISOString(),
                partial_tp_hit: trade.partialTpHit ? 1 : 0,
                partial_tp_level: trade.partialTp1Level,
                partial_tp_timestamp: trade.partialTp1Time,
                rr_ratio: trade.rr,
                confluence_score: trade.confluenceScore,
                outcome_notif_sent: trade._stratOutcomeSent ? 1 : 0,
                mae: Number.isFinite(trade._mae) ? Number(trade._mae) : null,
                mfe: Number.isFinite(trade._mfe) ? Number(trade._mfe) : null,
                sl_overshoot: Number.isFinite(trade._slOvershoot) ? Number(trade._slOvershoot) : null,
                sl_then_tp_flag: trade._slThenTpFlag ? 1 : 0,
                tp_after_sl_seconds: Number.isFinite(trade._tpAfterSlSeconds) ? Number(trade._tpAfterSlSeconds) : null,
                reversal_distance: Number.isFinite(trade._reversalDistance) ? Number(trade._reversalDistance) : null,
                entry_quality_score: Number.isFinite(trade.entryQualityScore) ? Number(trade.entryQualityScore) : null,
                metadata_json: metadata
            };

            const response = await fetch('/api/trades/log_outcome', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                this._log('DEBUG', `Trade outcome logged to database: ${payload.trade_id}`);
            } else {
                this._log('WARN', `Failed to log outcome: ${await this._describeErrorResponse(response)}`);
            }
        } catch (err) {
            this._log('WARN', `Error logging outcome to database: ${err.message}`);
        }
    }

    async syncTradeAnalytics(trade) {
        if (!trade || !this.autoLogToDatabase) return false;
        await this._logOutcomeToDatabase(trade);
        return true;
    }

    /**
     * Update partial TP information in database.
     */
    async _updatePartialTPInDatabase(trade, index, level) {
        try {
            const token = this._getAuthToken();
            const payload = {
                trade_id: trade.tradeId || trade.signalId,
                partial_tp_hit: 1,
                partial_tp_level: level,
                partial_tp_timestamp: new Date().toISOString(),
                partial_tp_notif_sent: 1
            };

            const response = await fetch('/api/trades/log_outcome', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                this._log('WARN', `Failed to update partial TP: ${await this._describeErrorResponse(response)}`);
            }
        } catch (err) {
            this._log('WARN', `Error updating partial TP: ${err.message}`);
        }
    }

    /**
     * Send outcome notification via Telegram with dedup guards.
     */
    async _sendOutcomeNotification(trade, notificationType) {
        const tradeId = trade.tradeId || trade.signalId;

        // Check if already sent
        if (await this._checkNotificationDedup(tradeId, notificationType)) {
            this._log('WARN', `[DUPLICATE_BLOCKED] ${notificationType} already sent for ${tradeId}`);
            return false;
        }

        // Send via Telegram
        try {
            trade._stratOutcomeSent = false;
            if (typeof sendStrategyOutcomeTelegram === 'function') {
                await sendStrategyOutcomeTelegram(trade);
            }
            await this._recordNotificationSent(tradeId, notificationType, 'sent');
            this._log('INFO', `[NOTIFICATION] ${notificationType} sent for ${tradeId}`);
            return true;
        } catch (err) {
            this._log('WARN', `[NOTIFICATION] ${notificationType} failed: ${err.message}`);
            await this._recordNotificationSent(tradeId, notificationType, 'failed');
            return false;
        }
    }

    /**
     * Persist trade state to localStorage.
     */
    _persistToLocalStorage(trade) {
        try {
            const historyKey = 'itguru_indicator_signalHistory';
            let history = [];
            try {
                const stored = localStorage.getItem(historyKey);
                if (stored) {
                    history = JSON.parse(stored);
                }
            } catch (e) {
                // Ignore parse errors
            }

            // Find and update the trade in history
            const idx = history.findIndex(s => 
                (s.signalId === trade.signalId || s.tradeId === trade.tradeId) &&
                s.symbol === trade.symbol
            );

            if (idx >= 0) {
                history[idx] = Object.assign(history[idx], trade);
            } else {
                history.unshift(trade);
            }

            // Keep max 200 trades
            if (history.length > 200) {
                history = history.slice(0, 200);
            }

            localStorage.setItem(historyKey, JSON.stringify(history));
            this._log('DEBUG', `Trade persisted to localStorage: ${trade.signalId}`);
        } catch (err) {
            this._log('WARN', `Failed to persist to localStorage: ${err.message}`);
        }
    }

    /**
     * Check if trade is in a terminal state (cannot change outcome).
     */
    _isTerminalState(trade) {
        const terminalStates = ['WIN', 'LOSS', 'BREAKEVEN', 'EXPIRED', 'CANCELLED'];
        return trade.result && terminalStates.includes(trade.result);
    }

    /**
     * Internal logging with level control.
     */
    _log(level, message) {
        const levels = { 'ERROR': 0, 'WARN': 1, 'INFO': 2, 'DEBUG': 3 };
        const currentLevel = levels[this.logLevel] || 2;
        const msgLevel = levels[level] || 2;

        if (msgLevel <= currentLevel) {
            const prefix = level === 'ERROR' ? '❌' :
                          level === 'WARN' ? '⚠️' :
                          level === 'INFO' ? 'ℹ️' : '🔍';
            console.log(`${prefix} [TradeOutcomeService] ${message}`);
            addLog?.(`${prefix} [TradeOutcomeService] ${message}`);
        }
    }

    /**
     * Get statistics from database (not memory).
     * This is the single source of truth for win rates, etc.
     */
    async getStatistics(symbol, strategyType, timeframe) {
        // TODO: Implement API call to fetch stats from trade_outcomes table
        // This would aggregate wins/losses from database
        return {
            wins: 0,
            losses: 0,
            winRate: 0,
            totalTrades: 0
        };
    }

    /**
     * Recover pending trades from localStorage after app restart.
     */
    recoverPendingTrades() {
        try {
            const historyKey = 'itguru_indicator_signalHistory';
            const stored = localStorage.getItem(historyKey);
            if (!stored) return [];

            const history = JSON.parse(stored);
            const pending = history.filter(t => t.result === 'PENDING');
            this._log('INFO', `Recovered ${pending.length} pending trades from localStorage`);
            return pending;
        } catch (err) {
            this._log('WARN', `Failed to recover trades: ${err.message}`);
            return [];
        }
    }
}

// Export as global for use in indicator.js
if (typeof window !== 'undefined') {
    window.TradeOutcomeService = TradeOutcomeService;
    window.tradeOutcomeService = new TradeOutcomeService();
}
