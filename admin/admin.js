/* =========================================================
   IT Guru – Admin Dashboard JS
   ========================================================= */

"use strict";

const ADMIN_API = (typeof window !== "undefined" && window.ITGURU_AUTH_API_BASE)
  ? window.ITGURU_AUTH_API_BASE.replace(/\/auth\/?$/, "")
  : "https://trading.dsitservicesja.com/api";

const THEME_KEY  = "itguru_admin_theme";
const THEME_DARK  = "dark";
const THEME_LIGHT = "light";

/* ── State ── */
let allStrategies   = [];   /* [{ key, label }] */
let currentPage     = 1;
let currentFilters  = {};
let editingUserId   = null;
let editingUserStrategies = [];
let deletingUser    = null; /* { id, username } */
let resetPwUser     = null; /* { id, username } */
const userCache     = new Map(); /* id → user object from last load */

/* Bot strategy keys — rendered/styled separately from indicator strategies */
const BOT_STRATEGY_KEYS = new Set(['bot_hc_1hz75v', 'bot_normal']);

/* ═══════════════════════════════════════════════
   Theme
   ═══════════════════════════════════════════════ */

/** Return current theme ("dark" | "light"), defaulting to dark. */
function getTheme() {
  return localStorage.getItem(THEME_KEY) === THEME_LIGHT ? THEME_LIGHT : THEME_DARK;
}

/** Apply a theme and persist to localStorage. */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  const btn = document.getElementById("themeToggleBtn");
  if (btn) {
    btn.textContent = theme === THEME_LIGHT ? "🌙 Dark" : "☀️ Light";
    btn.title       = theme === THEME_LIGHT ? "Switch to dark theme" : "Switch to light theme";
  }
}

/** Toggle between light and dark. */
function toggleTheme() {
  applyTheme(getTheme() === THEME_LIGHT ? THEME_DARK : THEME_LIGHT);
}

/* ═══════════════════════════════════════════════
   Boot
   ═══════════════════════════════════════════════ */
document.addEventListener("DOMContentLoaded", async () => {
  /* Wire the login button immediately so it responds even while the async
     token-verify request is in flight (overlay is visible via CSS until
     initApp() hides it). initLoginGate's duplicate guard prevents double
     registration if showLoginOverlay() is called again later. */
  ITGuruAuth.initLoginGate({
    onLogin: async () => {
      const user = ITGuruAuth.getUser();
      if (!user || user.role !== "admin") {
        showAccessDenied();
        return;
      }
      initApp(user);
    }
  });

  if (!ITGuruAuth.isLoggedIn()) {
    /* Overlay already visible and button already wired — nothing more to do */
    return;
  }

  /* User appears logged in — re-show overlay while we verify the token,
     so the button remains visible and usable during the async request. */
  const overlay = document.getElementById("loginOverlay");
  if (overlay) overlay.style.display = "flex";

  const valid = await ITGuruAuth.verify();
  if (!valid) {
    ITGuruAuth.logout();
    /* Overlay is already visible; button handler is already registered */
    return;
  }

  const user = ITGuruAuth.getUser();
  if (!user || user.role !== "admin") {
    showAccessDenied();
    return;
  }

  initApp(user);
});

/* ── Show login overlay ── */
function showLoginOverlay() {
  ITGuruAuth.initLoginGate({
    onLogin: async () => {
      const user = ITGuruAuth.getUser();
      if (!user || user.role !== "admin") {
        showAccessDenied();
        return;
      }
      initApp(user);
    }
  });
}

/* ── Access denied (non-admin logged in) ── */
function showAccessDenied() {
  const overlay = document.getElementById("loginOverlay");
  if (overlay) {
    overlay.innerHTML = `
      <div class="login-card" style="text-align:center;">
        <h2>🚫 Access Denied</h2>
        <p style="margin:16px 0;">Your account does not have admin privileges.</p>
        <button type="button" class="login-action-btn" onclick="ITGuruAuth.logout(); location.reload();">
          Logout
        </button>
      </div>`;
    overlay.style.display = "flex";
  }
}

/* ── Init after confirmed admin ── */
async function initApp(user) {
  document.getElementById("loginOverlay").style.display  = "none";
  document.getElementById("appWrapper").style.display    = "";

  const lbl = document.getElementById("adminUserLabel");
  if (lbl) lbl.textContent = "👤 " + (user.displayName || user.username);

  /* Theme: apply saved preference and wire toggle button */
  applyTheme(getTheme());
  const themeBtn = document.getElementById("themeToggleBtn");
  if (themeBtn) themeBtn.addEventListener("click", toggleTheme);

  /* Logout */
  const logoutBtn = document.getElementById("adminLogoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      ITGuruAuth.logout();
      location.reload();
    });
  }

  /* Load strategy list then users */
  await loadStrategies();
  buildStrategyChecks("editStrategyChecks",  []);
  buildStrategyChecks("newStrategyChecks",   []);
  await loadUsers();
  bindToolbar();
  bindModals();
  await loadProfiles();
  bindProfileModals();
  await loadNotifications();
  bindNotifications();
  await loadNotificationPreferences();
  bindNotificationPreferences();
  await loadTelegramDeliveryLog();
  bindTelegramDeliveryLog();
  await loadAdaptiveDashboard();
  bindAdaptiveAdmin();
}

/* ═══════════════════════════════════════════════
   API helpers
   ═══════════════════════════════════════════════ */
async function apiRequest(path, options = {}) {
  const token = ITGuruAuth.getToken();
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { "Authorization": "Bearer " + token } : {}),
    ...(options.headers || {}),
  };

  const url  = ADMIN_API + path;
  
  /* Use auth error handler for 401/403 responses */
  const resp = await AdminAuthErrorHandler.fetchWithAuthHandling(
    url,
    async () => {
      let fetchResp = await fetch(url, { ...options, headers });
      /* Fallback: if .htaccess URL rewriting is not available (e.g. Nginx without rewrite rules),
         retry with explicit .php extension so the endpoint is always reachable. */
      if (fetchResp.status === 404 && !path.endsWith(".php")) {
        const phpPath = path.includes("?") ? path.replace("?", ".php?") : path + ".php";
        fetchResp = await fetch(ADMIN_API + phpPath, { ...options, headers });
      }
      return fetchResp;
    },
    { retry: true, stopPollingOnFailure: true }
  );
  return resp;
}

/* ═══════════════════════════════════════════════
   Strategies
   ═══════════════════════════════════════════════ */
async function loadStrategies() {
  try {
    const resp = await apiRequest("/admin/strategies");
    const data = await resp.json();
    allStrategies = data.strategies || [];
  } catch {
    allStrategies = [];
  }
}

function buildStrategyChecks(containerId, grantedKeys) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";
  const granted = new Set(grantedKeys);

  const botStrategies = allStrategies.filter(s => BOT_STRATEGY_KEYS.has(s.key));
  const indStrategies = allStrategies.filter(s => !BOT_STRATEGY_KEYS.has(s.key));

  function renderSection(sectionLabel, items, isBotSection) {
    if (!items.length) return;
    const heading = document.createElement("div");
    heading.className = "strategy-section-label";
    heading.textContent = sectionLabel;
    container.appendChild(heading);
    const group = document.createElement("div");
    group.className = "strategy-check-group";
    for (const s of items) {
      const label = document.createElement("label");
      label.className = "strategy-check-item" + (isBotSection ? " strategy-check-bot" : "");
      const cb = document.createElement("input");
      cb.type  = "checkbox";
      cb.value = s.key;
      cb.checked = granted.has(s.key);
      cb.dataset.stratKey = s.key;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(s.label));
      group.appendChild(label);
    }
    container.appendChild(group);
  }

  renderSection("🤖 Bot Access", botStrategies, true);
  renderSection("📊 Indicator Strategies", indStrategies, false);
}

function getCheckedStrategies(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return [];
  return Array.from(container.querySelectorAll("input[type=checkbox]:checked"))
    .map(cb => cb.value);
}

/* ═══════════════════════════════════════════════
   Load users
   ═══════════════════════════════════════════════ */
async function loadUsers(page = currentPage, filters = currentFilters) {
  currentPage    = page;
  currentFilters = filters;

  const params = new URLSearchParams({
    page,
    per_page: 25,
    ...(filters.search ? { search: filters.search } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.subscription ? { subscription: filters.subscription } : {}),
    ...(filters.role ? { role: filters.role } : {}),
  });

  const tbody = document.getElementById("userTableBody");
  tbody.innerHTML = `<tr><td colspan="11" class="table-empty">Loading…</td></tr>`;

  try {
    const resp = await apiRequest("/admin/users?" + params);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      tbody.innerHTML = `<tr><td colspan="11" class="table-empty" style="color:var(--danger-soft)">
        Error: ${escHtml(err.error || "Failed to load users")}
      </td></tr>`;
      return;
    }

    const data = await resp.json();
    renderTable(data.users || []);
    renderPagination(data.page, data.last_page, data.total, data.per_page);
    updateStats(data.total, data.stats || {});
    loadTelegramStats();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="11" class="table-empty" style="color:var(--danger-soft)">
      Network error — ${escHtml(e.message)}
    </td></tr>`;
  }
}

/* ── Render rows ── */
function renderTable(users) {
  const tbody = document.getElementById("userTableBody");
  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="table-empty">No users found.</td></tr>`;
    return;
  }

  tbody.innerHTML = "";
  const now = Date.now();

  for (const u of users) {
    userCache.set(u.id, u);
    const expiresMs = u.subscription_expires_at ? new Date(u.subscription_expires_at).getTime() : null;
    const isExpired      = expiresMs && expiresMs < now;
    const isExpiringSoon = expiresMs && !isExpired && (expiresMs - now) < 7 * 86400 * 1000;

    const tr = document.createElement("tr");
    if (isExpired)      tr.classList.add("row-expired");
    else if (isExpiringSoon) tr.classList.add("row-expiring-soon");

    const strategies = (u.strategies || []).map(k => {
      const label    = allStrategies.find(s => s.key === k)?.label || k;
      const isBotKey = BOT_STRATEGY_KEYS.has(k);
      return `<span class="strategy-tag${isBotKey ? ' strategy-tag-bot' : ''}">${escHtml(label)}</span>`;
    }).join("") || '<span style="color:var(--text-muted);font-size:11px;">none</span>';

    const expiryBadge = expiresMs
      ? (isExpired
          ? `<span class="badge badge-expired">Expired</span> `
          : isExpiringSoon
            ? `<span class="badge badge-expiring">⚠ Soon</span> `
            : "")
      : "";

    const expiryText = u.subscription_expires_at
      ? `<span class="ts">${expiryBadge}${fmtDate(u.subscription_expires_at)}</span>`
      : `<span class="ts">—</span>`;

    const planLabel = u.subscription_plan
      ? u.subscription_plan.charAt(0).toUpperCase() + u.subscription_plan.slice(1)
      : "—";

    /* Telegram cell — show linked status + per-user action buttons */
    let tgCell;
    if (u.telegram_linked) {
      const tgName = u.telegram_username ? `@${escHtml(u.telegram_username)}` : "linked";
      tgCell = `
        <div class="tg-cell">
          <span class="badge badge-active" title="Linked since ${u.telegram_linked_at ? escHtml(fmtDate(u.telegram_linked_at)) : 'unknown'}">✅ ${tgName}</span>
          <div class="tg-actions">
            <button type="button" class="btn-tg-user-sync" data-action="tg-sync" data-id="${u.id}" aria-label="Sync Telegram group membership" title="Add to group if active subscription, remove if inactive">📱 Sync</button>
            <button type="button" class="btn-tg-user-kick" data-action="tg-kick" data-id="${u.id}" data-username="${escHtml(u.username)}" aria-label="Force kick from Telegram group" title="Force-remove this user from the Telegram group now">🚫 Kick</button>
            <button type="button" class="btn-tg-user-unlink" data-action="tg-unlink" data-id="${u.id}" data-username="${escHtml(u.username)}" aria-label="Unlink Telegram account" title="Unlink Telegram (does not kick from group)">🔓 Unlink</button>
          </div>
        </div>`;
    } else {
      const savedName = u.telegram_username ? ` · @${escHtml(u.telegram_username)}` : "";
      const notLinkedTitle = u.telegram_username
        ? `@${escHtml(u.telegram_username)} saved but not yet linked via bot`
        : "No Telegram account linked";
      tgCell = `<span class="tg-not-linked" title="${notLinkedTitle}">⚠ not linked${savedName}</span>`;
    }

    tr.innerHTML = `
      <td><strong>${escHtml(u.username)}</strong><div class="ts">ID: ${escHtml(String(u.id))}</div></td>
      <td class="ts">${escHtml(u.email || "—")}</td>
      <td><span class="badge badge-${escHtml(u.role)}">${escHtml(u.role)}</span></td>
      <td><span class="badge badge-${escHtml(u.status)}">${escHtml(u.status)}</span></td>
      <td><span class="badge badge-${escHtml(u.subscription_status)}">${escHtml(u.subscription_status)}</span></td>
      <td class="ts">${escHtml(planLabel)}</td>
      <td>${expiryText}</td>
      <td class="ts">${u.last_login_at ? fmtDateTime(u.last_login_at) : "—"}</td>
      <td class="tg-col">${tgCell}</td>
      <td class="strategies-cell">${strategies}</td>
      <td class="actions-cell">
        <button type="button" class="btn-icon btn-sm" data-action="toggle-status" data-id="${u.id}" data-status="${escHtml(u.status)}" title="${u.status === 'active' ? 'Lock account' : 'Unlock account'}">
          ${u.status === "active" ? "🔒" : "🔓"}
        </button>
        <button type="button" class="btn-icon btn-sm" data-action="edit" data-id="${u.id}" title="Edit user">✏️</button>
        <button type="button" class="btn-icon btn-sm" data-action="reset-password" data-id="${u.id}" data-username="${escHtml(u.username)}" title="Reset password">🔑</button>
        <button type="button" class="btn-icon btn-sm btn-danger" data-action="delete" data-id="${u.id}" data-username="${escHtml(u.username)}" title="Delete user">🗑️</button>
      </td>`;

    tbody.appendChild(tr);
  }

  /* Attach row action handlers */
  tbody.querySelectorAll("[data-action]").forEach(btn => {
    btn.addEventListener("click", handleRowAction);
  });
}

/* ── Stats bar ── */
function updateStats(total, stats) {
  el("statTotal").textContent      = total;
  el("statActiveSubs").textContent = stats.active_subs    ?? "—";
  el("statTrial").textContent      = stats.trial_subs     ?? "—";
  el("statLocked").textContent     = stats.locked_count   ?? "—";
  el("statExpiring").textContent   = stats.expiring_soon  ?? "—";
  const botEl = el("statBotAccess");
  if (botEl) botEl.textContent     = stats.bot_access_count ?? "—";
  /* Telegram stats loaded separately */
}

/* ── Load and display Telegram stats ── */
async function loadTelegramStats() {
  try {
    const resp = await apiRequest("/admin/telegram");
    if (!resp.ok) return;
    const data = await resp.json();
    const s = data.stats || {};
    el("statTgLinked").textContent        = s.total_linked      ?? "—";
    el("statTgActiveUnlinked").textContent = s.active_unlinked  ?? "—";
  } catch {
    /* non-critical, silently ignore */
  }
}

/* ── Pagination ── */
function renderPagination(page, lastPage, total, perPage) {
  const container = document.getElementById("pagination");
  container.innerHTML = "";

  if (lastPage <= 1) return;

  const prev = mkBtn("← Prev", page <= 1, () => loadUsers(page - 1));
  if (page <= 1) prev.disabled = true;
  container.appendChild(prev);

  const info = document.createElement("span");
  info.className = "page-info";
  info.textContent = `Page ${page} / ${lastPage}`;
  container.appendChild(info);

  const next = mkBtn("Next →", page >= lastPage, () => loadUsers(page + 1));
  if (page >= lastPage) next.disabled = true;
  container.appendChild(next);
}

function mkBtn(label, disabled, onClick) {
  const b = document.createElement("button");
  b.type      = "button";
  b.className = "page-btn";
  b.textContent = label;
  b.disabled  = disabled;
  if (!disabled) b.addEventListener("click", onClick);
  return b;
}

/* ═══════════════════════════════════════════════
   Toolbar bindings
   ═══════════════════════════════════════════════ */
function bindToolbar() {
  let debounceTimer;
  const doSearch = () => {
    currentFilters = {
      search:       el("searchInput").value.trim(),
      status:       el("filterStatus").value,
      subscription: el("filterSub").value,
      role:         el("filterRole").value,
    };
    loadUsers(1, currentFilters);
  };

  el("searchInput").addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(doSearch, 350);
  });
  el("filterStatus").addEventListener("change", doSearch);
  el("filterSub").addEventListener("change",    doSearch);
  el("filterRole").addEventListener("change",   doSearch);

  el("newUserBtn").addEventListener("click", openNewUserModal);

  const syncAllBtn = el("syncAllTgBtn");
  if (syncAllBtn) {
    syncAllBtn.addEventListener("click", async () => {
      if (!confirm("Sync ALL linked Telegram accounts with group membership?\n\nThis will add active subscribers and remove inactive ones. This may take a moment.")) return;
      syncAllBtn.disabled = true;
      syncAllBtn.textContent = "📱 Syncing…";
      try {
        const resp = await apiRequest("/admin/telegram?action=sync_all", { method: "POST" });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          alert("Sync error: " + (data.error || "Unknown error"));
        } else {
          alert(`Sync complete:\n✅ Added: ${data.added ?? 0}\n❌ Kicked: ${data.kicked ?? 0}\n⚠ Errors: ${data.errors ?? 0}`);
          await loadUsers();
        }
      } catch (e) {
        alert("Network error: " + e.message);
      } finally {
        syncAllBtn.disabled = false;
        syncAllBtn.textContent = "📱 Sync All Telegram";
      }
    });
  }
}

/* ═══════════════════════════════════════════════
   Row action handler
   ═══════════════════════════════════════════════ */
async function handleRowAction(e) {
  const btn    = e.currentTarget;
  const action = btn.dataset.action;
  const id     = parseInt(btn.dataset.id, 10);

  if (action === "toggle-status") {
    const current = btn.dataset.status;
    const next    = current === "active" ? "locked" : "active";
    if (!confirm(`${next === "locked" ? "Lock" : "Unlock"} this account?`)) return;
    btn.disabled = true;
    try {
      const resp = await apiRequest("/admin/user?id=" + id, {
        method: "PATCH",
        body: JSON.stringify({ status: next }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        alert("Error: " + (err.error || "Could not update status"));
      } else {
        await loadUsers();
      }
    } finally {
      btn.disabled = false;
    }
    return;
  }

  if (action === "edit") {
    openEditModal(id);
    return;
  }

  if (action === "reset-password") {
    openResetPwModal({ id, username: btn.dataset.username });
    return;
  }

  if (action === "delete") {
    openDeleteModal({ id, username: btn.dataset.username });
    return;
  }

  if (action === "tg-sync") {
    btn.disabled = true;
    try {
      const resp = await apiRequest("/admin/telegram?action=sync_user&id=" + id, { method: "POST" });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        alert("Telegram sync error: " + (data.error || "Unknown error"));
      } else {
        alert(data.message || "Sync complete");
        await loadUsers();
      }
    } finally {
      btn.disabled = false;
    }
    return;
  }

  if (action === "tg-kick") {
    const username = btn.dataset.username || ("user #" + id);
    if (!confirm(`Force-kick ${username} from the Telegram group?\n\nThis removes them from the group immediately regardless of subscription status. Their Telegram account remains linked.`)) return;
    btn.disabled = true;
    try {
      const resp = await apiRequest("/admin/telegram?action=kick&id=" + id, { method: "POST" });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        alert("Kick error: " + (data.error || "Unknown error"));
      } else {
        alert(data.message || "User kicked from group");
        await loadUsers();
      }
    } finally {
      btn.disabled = false;
    }
    return;
  }

  if (action === "tg-unlink") {
    const username = btn.dataset.username || ("user #" + id);
    if (!confirm(`Unlink Telegram from ${username}? This does not kick them from the group.`)) return;
    btn.disabled = true;
    try {
      const resp = await apiRequest("/admin/telegram?id=" + id, { method: "DELETE" });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        alert("Unlink error: " + (data.error || "Unknown error"));
      } else {
        await loadUsers();
      }
    } finally {
      btn.disabled = false;
    }
    return;
  }
}

/* ═══════════════════════════════════════════════
   Edit Modal
   ═══════════════════════════════════════════════ */
function openEditModal(userId) {
  editingUserId = userId;

  /* Use cached user data populated during renderTable */
  const u = userCache.get(userId);
  if (!u) {
    alert("User data not found. Please reload the page.");
    return;
  }

  const strategies = u.strategies || [];

  /* Populate modal */
  document.getElementById("editModalTitle").textContent = u.username;
  const emailInput = el("editEmail");
  if (emailInput) emailInput.value = u.email || "";
  setSelectValue("editStatus",    u.status || "active");
  setSelectValue("editRole",      u.role   || "user");
  setSelectValue("editSubStatus", u.subscription_status || "inactive");
  setSelectValue("editSubPlan",   u.subscription_plan || "");

  /* Pre-fill expiry date using ISO extraction for reliable cross-browser handling */
  const expiryInput = el("editSubExpiry");
  expiryInput.value = u.subscription_expires_at
    ? new Date(u.subscription_expires_at).toISOString().split("T")[0]
    : "";

  /* Pre-fill telegram username (strip leading @ if present) */
  const tgInput = el("editTelegramUsername");
  if (tgInput) {
    tgInput.value = u.telegram_username ? u.telegram_username.replace(/^@/, "") : "";
  }

  document.getElementById("editError").textContent = "";

  editingUserStrategies = strategies;
  buildStrategyChecks("editStrategyChecks", strategies);

  /* Load profiles section */
  loadEditModalProfiles(userId);

  document.getElementById("editModal").style.display = "flex";
}

/* ── Profiles section inside the Edit modal ── */
async function loadEditModalProfiles(userId) {
  const listEl   = el("editProfilesList");
  const selectEl = el("editProfileSelect");
  if (!listEl || !selectEl) return;

  listEl.textContent = "Loading…";
  selectEl.innerHTML = `<option value="">— Select a profile to assign —</option>`;

  try {
    /* Fetch assigned profiles for this user and all available profiles in parallel */
    const [assignedResp, allResp] = await Promise.all([
      apiRequest("/admin/profiles?action=assignments&user_id=" + userId),
      apiRequest("/admin/profiles"),
    ]);

    const assignedData  = assignedResp.ok ? await assignedResp.json() : { assignments: [] };
    const allData       = allResp.ok      ? await allResp.json()      : { profiles: [] };

    const assigned    = assignedData.assignments || [];
    const allProfiles = allData.profiles || [];
    const assignedIds = new Set(assigned.map(p => p.id));

    /* Render currently assigned profiles */
    if (!assigned.length) {
      listEl.innerHTML = `<span style="color:var(--text-muted);font-size:12px;">No profiles assigned yet.</span>`;
    } else {
      listEl.innerHTML = "";
      for (const p of assigned) {
        const tag = document.createElement("span");
        tag.className = "profile-assigned-tag";
        tag.innerHTML = `${escHtml(p.name)} <button type="button" class="btn-unassign-profile" data-pid="${p.id}" title="Remove profile" aria-label="Remove profile ${escHtml(p.name)}">✕</button>`;
        tag.querySelector(".btn-unassign-profile").addEventListener("click", async () => {
          await unassignProfileFromEditModal(userId, p.id);
        });
        listEl.appendChild(tag);
      }
    }

    /* Populate select with profiles not yet assigned */
    const unassigned = allProfiles.filter(p => !assignedIds.has(p.id));
    if (unassigned.length) {
      for (const p of unassigned) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name + (p.is_admin_profile ? " ⭐" : "");
        selectEl.appendChild(opt);
      }
    }
  } catch (e) {
    listEl.textContent = "Failed to load profiles.";
  }
}

async function unassignProfileFromEditModal(userId, profileId) {
  try {
    const resp = await apiRequest("/admin/profiles?action=unassign", {
      method: "DELETE",
      body: JSON.stringify({ profile_id: profileId, user_id: userId }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      alert("Error: " + (err.error || "Could not remove profile"));
      return;
    }
    await loadEditModalProfiles(userId);
    await loadProfiles();
  } catch (e) {
    alert("Network error: " + e.message);
  }
}

async function assignProfileFromEditModal(userId) {
  const selectEl  = el("editProfileSelect");
  const profileId = parseInt(selectEl?.value || "0", 10);
  if (!profileId) return;

  const btn = el("editProfileAssignBtn");
  if (btn) btn.disabled = true;
  try {
    const resp = await apiRequest("/admin/profiles?action=assign", {
      method: "POST",
      body: JSON.stringify({ profile_id: profileId, user_id: userId }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      alert("Error: " + (err.error || "Could not assign profile"));
      return;
    }
    await loadEditModalProfiles(userId);
    await loadProfiles();
  } catch (e) {
    alert("Network error: " + e.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ── Save edit ── */
async function saveEdit() {
  const btn     = document.getElementById("editSaveBtn");
  const errEl   = document.getElementById("editError");
  errEl.textContent = "";
  btn.disabled  = true;
  btn.textContent = "Saving…";

  const status   = el("editStatus").value;
  const role     = el("editRole").value;
  const sub      = el("editSubStatus").value;
  const plan     = el("editSubPlan").value || null;
  const expiry   = el("editSubExpiry").value || null;
  const email    = (el("editEmail")?.value || "").trim();
  const telegramUsername = (el("editTelegramUsername")?.value || "").trim().replace(/^@/, "") || null;
  const newStrats = getCheckedStrategies("editStrategyChecks");

  try {
    /* Update user fields */
    const resp = await apiRequest("/admin/user?id=" + editingUserId, {
      method: "PATCH",
      body: JSON.stringify({ email, status, role, subscription_status: sub, subscription_plan: plan, subscription_expires_at: expiry, telegram_username: telegramUsername }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || "Failed to save");
    }

    /* Sync strategies: grant new, revoke removed */
    const prev    = new Set(editingUserStrategies);
    const next    = new Set(newStrats);
    const toGrant = [...next].filter(k => !prev.has(k));
    const toRevoke = [...prev].filter(k => !next.has(k));

    for (const key of toGrant) {
      const grantResp = await apiRequest("/admin/strategy_access", {
        method: "POST",
        body: JSON.stringify({ user_id: editingUserId, strategy_key: key }),
      });
      if (!grantResp.ok) {
        const grantErr = await grantResp.json().catch(() => ({}));
        throw new Error(grantErr.error || `Failed to grant strategy: ${key}`);
      }
    }
    for (const key of toRevoke) {
      const revokeResp = await apiRequest("/admin/strategy_access", {
        method: "DELETE",
        body: JSON.stringify({ user_id: editingUserId, strategy_key: key }),
      });
      if (!revokeResp.ok) {
        const revokeErr = await revokeResp.json().catch(() => ({}));
        throw new Error(revokeErr.error || `Failed to revoke strategy: ${key}`);
      }
    }

    closeModal("editModal");
    await loadUsers();
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Save";
  }
}

/* ═══════════════════════════════════════════════
   New User Modal
   ═══════════════════════════════════════════════ */
function openNewUserModal() {
  el("newUsername").value          = "";
  el("newEmail").value             = "";
  el("newPassword").value          = "";
  el("newRole").value              = "user";
  el("newSubStatus").value         = "inactive";
  el("newSubPlan").value           = "";
  el("newSubExpiry").value         = "";
  el("newTelegramUsername").value  = "";
  el("newUserError").textContent   = "";
  buildStrategyChecks("newStrategyChecks", []);
  document.getElementById("newUserModal").style.display = "flex";
}

async function saveNewUser() {
  const btn   = document.getElementById("newUserSaveBtn");
  const errEl = document.getElementById("newUserError");
  errEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Creating…";

  const username       = el("newUsername").value.trim();
  const email          = el("newEmail").value.trim();
  const password       = el("newPassword").value;
  const role           = el("newRole").value;
  const sub            = el("newSubStatus").value;
  const plan           = el("newSubPlan").value || null;
  const expiry         = el("newSubExpiry").value || null;
  const telegramUsername = (el("newTelegramUsername")?.value || "").trim().replace(/^@/, "") || null;
  const strategies     = getCheckedStrategies("newStrategyChecks");

  if (!username || !password) {
    errEl.textContent = "Username and password are required";
    btn.disabled = false; btn.textContent = "Create User";
    return;
  }

  try {
    const resp = await apiRequest("/admin/users", {
      method: "POST",
      body: JSON.stringify({ username, email, password, role, subscription_status: sub, subscription_plan: plan, subscription_expires_at: expiry, telegram_username: telegramUsername, strategies }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Failed to create user");

    closeModal("newUserModal");
    await loadUsers(1);
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Create User";
  }
}

/* ═══════════════════════════════════════════════
   Reset Password Modal
   ═══════════════════════════════════════════════ */
function openResetPwModal(user) {
  resetPwUser = user;
  document.getElementById("resetPwModalTitle").textContent = user.username;
  document.getElementById("resetPwNew").value     = "";
  document.getElementById("resetPwConfirm").value = "";
  document.getElementById("resetPwError").textContent = "";
  document.getElementById("resetPwModal").style.display = "flex";
  document.getElementById("resetPwNew").focus();
}

async function saveResetPassword() {
  const btn   = document.getElementById("resetPwSaveBtn");
  const errEl = document.getElementById("resetPwError");
  errEl.textContent = "";

  const newPw     = document.getElementById("resetPwNew").value;
  const confirmPw = document.getElementById("resetPwConfirm").value;

  if (!newPw) {
    errEl.textContent = "New password is required";
    return;
  }
  if (newPw.length < 8) {
    errEl.textContent = "Password must be at least 8 characters";
    return;
  }
  if (newPw !== confirmPw) {
    errEl.textContent = "Passwords do not match";
    return;
  }

  btn.disabled = true;
  btn.textContent = "Saving…";

  try {
    const resp = await apiRequest("/admin/user?id=" + encodeURIComponent(resetPwUser.id), {
      method: "PATCH",
      body: JSON.stringify({ password: newPw }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || "Failed to reset password");
    }
    closeModal("resetPwModal");
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Reset Password";
  }
}

/* ═══════════════════════════════════════════════
   Delete Modal
   ═══════════════════════════════════════════════ */
function openDeleteModal(user) {
  deletingUser = user;
  document.getElementById("deleteModalUsername").textContent = user.username;
  document.getElementById("deleteConfirmInput").value = "";
  document.getElementById("deleteError").textContent  = "";
  document.getElementById("deleteModal").style.display = "flex";
  document.getElementById("deleteConfirmInput").focus();
}

async function confirmDelete() {
  const input = el("deleteConfirmInput").value.trim();
  const errEl = document.getElementById("deleteError");
  errEl.textContent = "";

  if (input !== deletingUser.username) {
    errEl.textContent = "Username does not match";
    return;
  }

  const btn = document.getElementById("deleteConfirmBtn");
  btn.disabled = true;
  btn.textContent = "Deleting…";

  try {
    const resp = await apiRequest("/admin/user?id=" + deletingUser.id, { method: "DELETE" });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || "Failed to delete user");
    }
    closeModal("deleteModal");
    await loadUsers();
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Delete";
  }
}

/* ═══════════════════════════════════════════════
   Modal bindings
   ═══════════════════════════════════════════════ */
function bindModals() {
  document.getElementById("editSaveBtn").addEventListener("click",   saveEdit);
  document.getElementById("editCancelBtn").addEventListener("click", () => closeModal("editModal"));

  const assignBtn = el("editProfileAssignBtn");
  if (assignBtn) {
    assignBtn.addEventListener("click", () => assignProfileFromEditModal(editingUserId));
  }

  document.getElementById("resetPwSaveBtn").addEventListener("click",   saveResetPassword);
  document.getElementById("resetPwCancelBtn").addEventListener("click", () => closeModal("resetPwModal"));

  document.getElementById("newUserSaveBtn").addEventListener("click",   saveNewUser);
  document.getElementById("newUserCancelBtn").addEventListener("click", () => closeModal("newUserModal"));

  document.getElementById("deleteConfirmBtn").addEventListener("click", confirmDelete);
  document.getElementById("deleteCancelBtn").addEventListener("click",  () => closeModal("deleteModal"));

  /* Close on backdrop click */
  ["editModal", "newUserModal", "resetPwModal", "deleteModal"].forEach(id => {
    document.getElementById(id).addEventListener("click", e => {
      if (e.target === e.currentTarget) closeModal(id);
    });
  });

  /* Enter key in delete confirm */
  document.getElementById("deleteConfirmInput").addEventListener("keydown", e => {
    if (e.key === "Enter") confirmDelete();
  });

  /* Enter key in reset-password fields */
  ["resetPwNew", "resetPwConfirm"].forEach(id => {
    document.getElementById(id).addEventListener("keydown", e => {
      if (e.key === "Enter") saveResetPassword();
    });
  });
}

function closeModal(id) {
  document.getElementById(id).style.display = "none";
}

/* ═══════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════ */
function el(id) { return document.getElementById(id); }

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setSelectValue(selectId, value) {
  const sel = el(selectId);
  if (!sel) return;
  for (const opt of sel.options) {
    if (opt.value === value || opt.text.trim().toLowerCase() === value.toLowerCase()) {
      sel.value = opt.value;
      return;
    }
  }
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}

/* ═══════════════════════════════════════════════
   Profiles Management
   ═══════════════════════════════════════════════ */
let assigningProfileId   = null;  /* profile id open in assign modal */
let assigningProfileName = "";

async function loadProfiles() {
  const tbody = document.getElementById("profilesTableBody");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="6" class="table-empty">Loading…</td></tr>`;

  try {
    const resp = await apiRequest("/admin/profiles");
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      tbody.innerHTML = `<tr><td colspan="6" class="table-empty" style="color:var(--danger-soft)">
        Error: ${escHtml(err.error || "Failed to load profiles")}
      </td></tr>`;
      return;
    }
    const data = await resp.json();
    renderProfilesTable(data.profiles || []);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="table-empty" style="color:var(--danger-soft)">
      Network error — ${escHtml(e.message)}
    </td></tr>`;
  }
}

function renderProfilesTable(profiles) {
  const tbody = document.getElementById("profilesTableBody");
  if (!tbody) return;
  if (!profiles.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="table-empty">No profiles yet. Click "＋ New Profile" to create one.</td></tr>`;
    return;
  }
  tbody.innerHTML = "";
  for (const p of profiles) {
    const tr = document.createElement("tr");
    const typeBadge = p.is_admin_profile
      ? `<span class="badge-admin-profile">⭐ Admin</span>`
      : `<span class="badge-user-profile">👤 User</span>`;

    tr.innerHTML = `
      <td><strong>${escHtml(p.name)}</strong></td>
      <td>${typeBadge}</td>
      <td class="ts">${escHtml(p.created_by_username || "—")}</td>
      <td class="ts">${p.assignment_count} user${p.assignment_count === 1 ? "" : "s"}</td>
      <td class="ts">${fmtDate(p.updated_at)}</td>
      <td class="actions-cell">
        <button type="button" class="btn-icon btn-sm" data-paction="assign" data-pid="${p.id}" data-pname="${escHtml(p.name)}" title="Assign to users">📌</button>
        <button type="button" class="btn-icon btn-sm btn-danger" data-paction="delete" data-pid="${p.id}" data-pname="${escHtml(p.name)}" title="Delete profile">🗑️</button>
      </td>`;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll("[data-paction]").forEach(btn => {
    btn.addEventListener("click", handleProfileAction);
  });
}

async function handleProfileAction(e) {
  const btn    = e.currentTarget;
  const action = btn.dataset.paction;
  const id     = parseInt(btn.dataset.pid, 10);
  const name   = btn.dataset.pname;

  if (action === "assign") {
    openAssignProfileModal(id, name);
    return;
  }

  if (action === "delete") {
    if (!confirm(`Delete profile "${name}"?\n\nThis will also remove all user assignments.`)) return;
    btn.disabled = true;
    try {
      const resp = await apiRequest("/admin/profiles?id=" + id, { method: "DELETE" });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        alert("Error: " + (err.error || "Could not delete profile"));
      } else {
        await loadProfiles();
      }
    } finally {
      btn.disabled = false;
    }
  }
}

/* ── New Profile Modal ── */
function openNewProfileModal() {
  el("newProfileName").value      = "";
  el("newProfileSettings").value  = "";
  el("newProfileIsAdmin").checked = false;
  el("newProfileError").textContent = "";
  el("newProfileModal").style.display = "flex";
  el("newProfileName").focus();
}

async function saveNewProfile() {
  const btn   = el("newProfileSaveBtn");
  const errEl = el("newProfileError");
  errEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Creating…";

  const name    = el("newProfileName").value.trim();
  const isAdmin = el("newProfileIsAdmin").checked;
  const rawJson = el("newProfileSettings").value.trim();

  if (!name) {
    errEl.textContent = "Profile name is required";
    btn.disabled = false; btn.textContent = "Create Profile";
    return;
  }

  let settings = {};
  if (rawJson) {
    try { settings = JSON.parse(rawJson); }
    catch {
      errEl.textContent = "Settings JSON is invalid — check for syntax errors";
      btn.disabled = false; btn.textContent = "Create Profile";
      return;
    }
  }

  try {
    const resp = await apiRequest("/admin/profiles", {
      method: "POST",
      body: JSON.stringify({ name, settings, is_admin_profile: isAdmin }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Failed to create profile");
    closeModal("newProfileModal");
    await loadProfiles();
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Create Profile";
  }
}

/* ── Assign Profile Modal ── */
function openAssignProfileModal(profileId, profileName) {
  assigningProfileId   = profileId;
  assigningProfileName = profileName;
  el("assignProfileModalTitle").textContent = profileName;
  el("profileAssignSearch").value  = "";
  el("profileAssignSearchResults").innerHTML = "";
  el("assignProfileError").textContent = "";
  el("assignProfileModal").style.display = "flex";
  el("profileAssignSearch").focus();
}

async function searchUsersForAssign(query) {
  const container = el("profileAssignSearchResults");
  if (!query) { container.innerHTML = ""; return; }

  container.innerHTML = `<div class="assign-user-row" style="color:var(--text-muted)">Searching…</div>`;

  try {
    /* Load first page filtered by search, then show top results */
    const params = new URLSearchParams({ page: 1, per_page: 10, search: query });
    const resp   = await apiRequest("/admin/users?" + params);
    if (!resp.ok) { container.innerHTML = ""; return; }

    const data  = await resp.json();
    const users = data.users || [];

    /* Fetch which user IDs already have this profile assigned */
    const assResp = await apiRequest("/admin/profiles?action=assignments_for_profile&profile_id=" + assigningProfileId);
    let assignedUserIds = new Set();
    if (assResp.ok) {
      const assData = await assResp.json();
      (assData.assigned_user_ids || []).forEach(id => assignedUserIds.add(id));
    }

    if (!users.length) {
      container.innerHTML = `<div class="assign-user-row" style="color:var(--text-muted)">No users found</div>`;
      return;
    }

    container.innerHTML = "";
    for (const u of users) {
      const isAssigned = assignedUserIds.has(u.id);
      const row = document.createElement("div");
      row.className = "assign-user-row";
      row.innerHTML = `
        <span>${escHtml(u.username)}${u.email ? ` <span style="color:var(--text-muted);font-size:11px;">(${escHtml(u.email)})</span>` : ""}</span>
        <button type="button" class="${isAssigned ? "btn-unassign-user" : "btn-assign-user"}"
                data-uid="${u.id}" data-uname="${escHtml(u.username)}">
          ${isAssigned ? "Remove" : "Assign"}
        </button>`;
      row.querySelector("button").addEventListener("click", async (ev) => {
        const btn    = ev.currentTarget;
        const uid    = parseInt(btn.dataset.uid, 10);
        const remove = btn.classList.contains("btn-unassign-user");
        btn.disabled = true;
        try {
          let resp;
          if (remove) {
            resp = await apiRequest("/admin/profiles?action=unassign", {
              method: "DELETE",
              body: JSON.stringify({ profile_id: assigningProfileId, user_id: uid }),
            });
          } else {
            resp = await apiRequest("/admin/profiles?action=assign", {
              method: "POST",
              body: JSON.stringify({ profile_id: assigningProfileId, user_id: uid }),
            });
          }
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            el("assignProfileError").textContent = err.error || "Request failed";
          } else {
            /* Toggle button state */
            btn.textContent = remove ? "Assign" : "Remove";
            btn.className   = remove ? "btn-assign-user" : "btn-unassign-user";
            await loadProfiles(); /* refresh assignment count */
          }
        } finally {
          btn.disabled = false;
        }
      });
      container.appendChild(row);
    }
  } catch (e) {
    container.innerHTML = `<div class="assign-user-row" style="color:var(--danger-soft)">${escHtml(e.message)}</div>`;
  }
}

/* ── Bind profile modal buttons ── */
function bindProfileModals() {
  const newBtn = el("newProfileBtn");
  if (newBtn) newBtn.addEventListener("click", openNewProfileModal);

  const refreshBtn = el("refreshProfilesBtn");
  if (refreshBtn) refreshBtn.addEventListener("click", loadProfiles);

  const saveBtn = el("newProfileSaveBtn");
  if (saveBtn) saveBtn.addEventListener("click", saveNewProfile);

  const cancelBtn = el("newProfileCancelBtn");
  if (cancelBtn) cancelBtn.addEventListener("click", () => closeModal("newProfileModal"));

  const closeAssign = el("assignProfileCloseBtn");
  if (closeAssign) closeAssign.addEventListener("click", () => closeModal("assignProfileModal"));

  /* Live search in assign modal */
  const searchInput = el("profileAssignSearch");
  if (searchInput) {
    let timer;
    searchInput.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => searchUsersForAssign(searchInput.value.trim()), 500);
    });
  }

  /* Close on backdrop click */
  ["newProfileModal", "assignProfileModal"].forEach(id => {
    const el_ = document.getElementById(id);
    if (el_) el_.addEventListener("click", e => { if (e.target === e.currentTarget) closeModal(id); });
  });

  /* Enter key in new profile name */
  const nameInput = el("newProfileName");
  if (nameInput) nameInput.addEventListener("keydown", e => { if (e.key === "Enter") saveNewProfile(); });
}


/* ═══════════════════════════════════════════════
   User Notifications
   ═══════════════════════════════════════════════ */
async function loadNotifications() {
  const tbody = document.getElementById("notificationsTableBody");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="7" class="table-empty">Loading…</td></tr>`;

  try {
    const resp = await apiRequest("/admin/notifications");
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      tbody.innerHTML = `<tr><td colspan="7" class="table-empty" style="color:var(--danger-soft)">
        Error: ${escHtml(err.error || "Failed to load notifications")}
      </td></tr>`;
      return;
    }
    const data = await resp.json();
    renderNotificationsTable(data.notifications || []);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="table-empty" style="color:var(--danger-soft)">
      Network error — ${escHtml(e.message)}
    </td></tr>`;
  }
}

function renderNotificationsTable(notifications) {
  const tbody = document.getElementById("notificationsTableBody");
  if (!tbody) return;
  if (!notifications.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="table-empty">No notifications sent yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = "";
  for (const n of notifications) {
    const tr = document.createElement("tr");
    const recipient = n.user_id
      ? `👤 ${escHtml(n.target_username || "(deleted user)")}`
      : `<span class="badge-admin-profile">📢 All users</span>`;
    const msg = String(n.message || "");
    const msgShort = msg.length > 120 ? msg.slice(0, 120) + "…" : msg;
    tr.innerHTML = `
      <td class="ts">${fmtDate(n.created_at)}</td>
      <td>${recipient}</td>
      <td><strong>${escHtml(n.title)}</strong></td>
      <td class="ts" title="${escHtml(msg)}">${escHtml(msgShort)}</td>
      <td class="ts">${n.read_count}</td>
      <td class="ts">${escHtml(n.created_by_username || "—")}</td>
      <td class="actions-cell">
        <button type="button" class="btn-icon btn-sm btn-danger" data-naction="delete" data-nid="${n.id}" title="Delete notification">🗑️</button>
      </td>`;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll("[data-naction]").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      const id = e.currentTarget.dataset.nid;
      if (!confirm("Delete this notification? Users who have not read it will no longer see it.")) return;
      try {
        const resp = await apiRequest(`/admin/notifications?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          alert(err.error || "Failed to delete notification");
          return;
        }
        await loadNotifications();
      } catch (ex) {
        alert("Network error — " + ex.message);
      }
    });
  });
}

function bindNotifications() {
  const sendBtn    = el("notifSendBtn");
  const refreshBtn = el("refreshNotifsBtn");
  const errEl      = el("notifError");
  const okEl       = el("notifSuccess");

  if (refreshBtn) refreshBtn.addEventListener("click", () => loadNotifications());
  if (!sendBtn) return;

  sendBtn.addEventListener("click", async () => {
    const username = el("notifRecipient")?.value.trim() || "";
    const title    = el("notifTitle")?.value.trim() || "";
    const message  = el("notifMessage")?.value.trim() || "";

    if (errEl) errEl.textContent = "";
    if (okEl)  okEl.textContent  = "";

    if (!title || !message) {
      if (errEl) errEl.textContent = "Title and message are required.";
      return;
    }
    if (!username && !confirm("Send this notification to ALL users?")) return;

    sendBtn.disabled = true;
    sendBtn.textContent = "Sending…";
    try {
      const resp = await apiRequest("/admin/notifications", {
        method: "POST",
        body: JSON.stringify({ username, title, message }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        if (errEl) errEl.textContent = data.error || "Failed to send notification";
        return;
      }
      if (okEl) okEl.textContent = username
        ? `✅ Notification sent to ${username}.`
        : "✅ Notification broadcast to all users.";
      const titleInput = el("notifTitle");
      const msgInput   = el("notifMessage");
      if (titleInput) titleInput.value = "";
      if (msgInput)   msgInput.value   = "";
      await loadNotifications();
    } catch (ex) {
      if (errEl) errEl.textContent = "Network error — " + ex.message;
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = "📤 Send Notification";
    }
  });
}


/* ═══════════════════════════════════════════════
   Notification Preferences (per-user Telegram toggles)
   ═══════════════════════════════════════════════ */
const NOTIF_PREF_COLUMNS = [
  ["telegram_trade_setup", "Setup"],
  ["telegram_trade_activation", "Activated"],
  ["telegram_take_profit", "TP"],
  ["telegram_stop_loss", "SL"],
  ["telegram_trade_cancelled", "Cancelled"],
  ["telegram_trade_expired", "Expired"],
  ["telegram_market_alerts", "Market"],
  ["telegram_scanner_alerts", "Scanner"],
  ["telegram_high_confidence_only", "High-Conf Only"],
];
let notifPrefUsersCache = [];
let notifPrefPage = 1;
const NOTIF_PREF_PAGE_SIZE = 50;
let notifPrefSearchDebounce = null;

async function loadNotificationPreferences(page = 1) {
  const tbody = el("notifPrefsTableBody");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="12" class="table-empty">Loading…</td></tr>`;
  notifPrefPage = Math.max(1, page);
  const params = new URLSearchParams();
  const search = (el("notifPrefSearch")?.value || "").trim();
  if (search) params.set("search", search);
  params.set("page", String(notifPrefPage));
  params.set("per_page", String(NOTIF_PREF_PAGE_SIZE));
  try {
    const resp = await apiRequest(`/admin/notification_preferences?${params.toString()}`);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      tbody.innerHTML = `<tr><td colspan="12" class="table-empty" style="color:var(--danger-soft)">Error: ${escHtml(err.error || "Failed to load preferences")}</td></tr>`;
      renderNotifPrefsPagination(0, 0);
      return;
    }
    const data = await resp.json();
    notifPrefUsersCache = data.users || [];
    const total = data.total ?? notifPrefUsersCache.length;
    const lastPage = data.last_page || Math.max(1, Math.ceil(total / NOTIF_PREF_PAGE_SIZE));
    if (data.page && data.page !== notifPrefPage) notifPrefPage = data.page;
    renderNotifPrefStats(data.stats || {}, data.total_users || 0);
    renderNotifPrefsTable(notifPrefUsersCache);
    renderNotifPrefsPagination(total, notifPrefPage, lastPage);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="12" class="table-empty" style="color:var(--danger-soft)">Network error — ${escHtml(e.message)}</td></tr>`;
    renderNotifPrefsPagination(0, 0);
  }
}

function renderNotifPrefsPagination(total, page, lastPage) {
  const container = el("notifPrefsPagination");
  if (!container) return;
  container.innerHTML = "";
  const last = lastPage || Math.max(1, Math.ceil(total / NOTIF_PREF_PAGE_SIZE));
  if (last <= 1) return;

  const prev = mkBtn("← Prev", page <= 1, () => loadNotificationPreferences(page - 1));
  container.appendChild(prev);

  const info = document.createElement("span");
  info.className = "page-info";
  info.textContent = `Page ${page} / ${last} (${total} users)`;
  container.appendChild(info);

  const next = mkBtn("Next →", page >= last, () => loadNotificationPreferences(page + 1));
  container.appendChild(next);
}

function renderNotifPrefStats(stats, totalUsers) {
  const bar = el("notifPrefStatsBar");
  if (!bar) return;
  bar.innerHTML = `<div class="stat-card"><div class="stat-label">Total Users</div><div class="stat-value">${totalUsers}</div></div>` +
    NOTIF_PREF_COLUMNS.map(([col, label]) =>
      `<div class="stat-card"><div class="stat-label">${escHtml(label)} Enabled</div><div class="stat-value">${stats[col] || 0}</div></div>`
    ).join("");
}

function renderNotifPrefsTable(users) {
  const tbody = el("notifPrefsTableBody");
  if (!tbody) return;
  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="12" class="table-empty">No users found.</td></tr>`;
    return;
  }
  tbody.innerHTML = "";
  for (const u of users) {
    const tr = document.createElement("tr");
    const checks = NOTIF_PREF_COLUMNS.map(([col]) =>
      `<td><input type="checkbox" data-pref-col="${col}" data-user-id="${u.user_id}" ${u.preferences[col] ? "checked" : ""} /></td>`
    ).join("");
    tr.innerHTML = `
      <td><input type="checkbox" class="notif-pref-row-select" data-user-id="${u.user_id}" /></td>
      <td>${escHtml(u.username)}${u.is_default ? ' <span class="field-hint">(default)</span>' : ""}</td>
      ${checks}
      <td class="actions-cell">
        <button type="button" class="btn-icon btn-sm" data-preset-action="reset" data-user-id="${u.user_id}" title="Reset to defaults">↺</button>
      </td>`;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll("[data-pref-col]").forEach(cb => {
    cb.addEventListener("change", async () => {
      const userId = cb.dataset.userId;
      const col = cb.dataset.prefCol;
      try {
        const resp = await apiRequest(`/admin/notification_preferences?id=${encodeURIComponent(userId)}`, {
          method: "POST",
          body: JSON.stringify({ [col]: cb.checked }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          alert(err.error || "Failed to update preference");
          cb.checked = !cb.checked;
        }
      } catch (ex) {
        alert("Network error — " + ex.message);
        cb.checked = !cb.checked;
      }
    });
  });

  tbody.querySelectorAll("[data-preset-action='reset']").forEach(btn => {
    btn.addEventListener("click", async () => {
      const userId = btn.dataset.userId;
      if (!confirm("Reset this user's notification preferences to defaults?")) return;
      try {
        const resp = await apiRequest(`/admin/notification_preferences?action=reset&id=${encodeURIComponent(userId)}`, { method: "POST" });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          alert(err.error || "Failed to reset preferences");
          return;
        }
        await loadNotificationPreferences(notifPrefPage);
      } catch (ex) {
        alert("Network error — " + ex.message);
      }
    });
  });
}

function bindNotificationPreferences() {
  el("refreshNotifPrefsBtn")?.addEventListener("click", () => loadNotificationPreferences());
  el("notifPrefSearch")?.addEventListener("input", () => {
    clearTimeout(notifPrefSearchDebounce);
    notifPrefSearchDebounce = setTimeout(() => loadNotificationPreferences(1), 300);
  });

  el("notifPrefApplyDefaultsBtn")?.addEventListener("click", async () => {
    try {
      const resp = await apiRequest("/admin/notification_preferences?action=apply_defaults", { method: "POST" });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { alert(data.error || "Failed to apply defaults"); return; }
      alert(`Applied defaults to ${data.applied_count || 0} user(s).`);
      await loadNotificationPreferences(notifPrefPage);
    } catch (ex) {
      alert("Network error — " + ex.message);
    }
  });

  el("notifPrefSelectAll")?.addEventListener("change", (e) => {
    document.querySelectorAll(".notif-pref-row-select").forEach(cb => { cb.checked = e.target.checked; });
  });

  el("notifPrefBulkUpdateBtn")?.addEventListener("click", async () => {
    const selected = Array.from(document.querySelectorAll(".notif-pref-row-select:checked")).map(cb => Number(cb.dataset.userId));
    if (!selected.length) { alert("Select at least one user (checkbox in the first column)."); return; }
    const col = prompt(
      "Preference column to update:\n" + NOTIF_PREF_COLUMNS.map(([c, l]) => `${c} (${l})`).join("\n")
    );
    if (!col) return;
    if (!NOTIF_PREF_COLUMNS.some(([c]) => c === col)) { alert("Unknown preference column."); return; }
    const enable = confirm("Click OK to ENABLE this preference for the selected users, or Cancel to DISABLE it.");
    try {
      const resp = await apiRequest("/admin/notification_preferences?action=bulk_update", {
        method: "POST",
        body: JSON.stringify({ user_ids: selected, updates: { [col]: enable } }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { alert(data.error || "Bulk update failed"); return; }
      alert(`Updated ${data.updated_count || 0} user(s).`);
      await loadNotificationPreferences(notifPrefPage);
    } catch (ex) {
      alert("Network error — " + ex.message);
    }
  });
}

/* ═══════════════════════════════════════════════
   Telegram Delivery Log
   ═══════════════════════════════════════════════ */
const TG_DELIVERY_LOG_PAGE_SIZE = 50;
let tgDeliveryLogPage = 1;

async function loadTelegramDeliveryLog(page = 1) {
  const tbody = el("tgDeliveryLogTableBody");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="9" class="table-empty">Loading…</td></tr>`;

  tgDeliveryLogPage = Math.max(1, page);

  const params = new URLSearchParams();
  const userId = el("tgDeliveryUserFilter")?.value.trim();
  const type = el("tgDeliveryTypeFilter")?.value;
  const status = el("tgDeliveryStatusFilter")?.value;
  if (userId) params.set("user_id", userId);
  if (type) params.set("notification_type", type);
  if (status) params.set("status", status);
  params.set("limit", String(TG_DELIVERY_LOG_PAGE_SIZE));
  params.set("offset", String((tgDeliveryLogPage - 1) * TG_DELIVERY_LOG_PAGE_SIZE));

  try {
    const resp = await apiRequest(`/admin/telegram_delivery_log?${params.toString()}`);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      tbody.innerHTML = `<tr><td colspan="9" class="table-empty" style="color:var(--danger-soft)">Error: ${escHtml(err.error || "Failed to load delivery log")}</td></tr>`;
      renderTgDeliveryLogPagination(0, 0);
      return;
    }
    const data = await resp.json();
    const total = data.total || 0;
    const lastPage = Math.max(1, Math.ceil(total / TG_DELIVERY_LOG_PAGE_SIZE));
    if (tgDeliveryLogPage > lastPage) {
      return loadTelegramDeliveryLog(lastPage);
    }
    renderTgDeliveryStats(data.stats || {}, data.duplicate_event_count || 0, data.duplicate_events || []);
    renderTgDeliveryLogTable(data.entries || []);
    renderTgDeliveryLogPagination(total, tgDeliveryLogPage);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="9" class="table-empty" style="color:var(--danger-soft)">Network error — ${escHtml(e.message)}</td></tr>`;
    renderTgDeliveryLogPagination(0, 0);
  }
}

function renderTgDeliveryLogPagination(total, page) {
  const container = el("tgDeliveryLogPagination");
  if (!container) return;
  container.innerHTML = "";

  const lastPage = Math.max(1, Math.ceil(total / TG_DELIVERY_LOG_PAGE_SIZE));
  if (lastPage <= 1) return;

  const prev = mkBtn("← Prev", page <= 1, () => loadTelegramDeliveryLog(page - 1));
  container.appendChild(prev);

  const info = document.createElement("span");
  info.className = "page-info";
  info.textContent = `Page ${page} / ${lastPage}`;
  container.appendChild(info);

  const next = mkBtn("Next →", page >= lastPage, () => loadTelegramDeliveryLog(page + 1));
  container.appendChild(next);
}

function renderTgDeliveryStats(stats, duplicateEventCount = 0, duplicateEvents = []) {
  const bar = el("tgDeliveryStatsBar");
  if (!bar) return;
  const dupTitle = duplicateEvents.length
    ? duplicateEvents.map((d) => `${escHtml(d.trade_id)} (${escHtml(d.notification_type)}) x${d.c}`).join("\n")
    : "No duplicate events detected";
  bar.innerHTML = `
    <div class="stat-card"><div class="stat-label">✅ Sent</div><div class="stat-value">${stats.sent || 0}</div></div>
    <div class="stat-card"><div class="stat-label">❌ Failed</div><div class="stat-value">${stats.failed || 0}</div></div>
    <div class="stat-card"><div class="stat-label">⏭️ Skipped</div><div class="stat-value">${stats.skipped || 0}</div></div>
    <div class="stat-card" title="${dupTitle}" style="${duplicateEventCount > 0 ? 'border-color:var(--danger-soft)' : ''}">
      <div class="stat-label">⚠️ Duplicate Events</div>
      <div class="stat-value" style="${duplicateEventCount > 0 ? 'color:var(--danger-soft)' : ''}">${duplicateEventCount}</div>
    </div>`;
}

function renderTgDeliveryLogTable(entries) {
  const tbody = el("tgDeliveryLogTableBody");
  if (!tbody) return;
  if (!entries.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="table-empty">No delivery log entries yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = "";
  for (const e2 of entries) {
    const tr = document.createElement("tr");
    const statusBadge = e2.status === "sent" ? "✅ Sent" : e2.status === "failed" ? "❌ Failed" : "⏭️ Skipped";
    const detail = e2.status === "failed" ? (e2.error_detail || "") : (e2.telegram_response || e2.error_detail || "");
    tr.innerHTML = `
      <td class="ts">${fmtDate(e2.sent_at)}</td>
      <td>${escHtml(e2.username || "(deleted user)")}</td>
      <td class="ts">${escHtml(e2.signal_id || "—")}</td>
      <td class="ts" title="${escHtml(e2.event_hash || '')}">${escHtml(e2.trade_id || e2.signal_id || "—")}</td>
      <td>${escHtml(e2.notification_type)}</td>
      <td>${escHtml(e2.strategy || "—")}</td>
      <td>${escHtml(e2.symbol || "—")}</td>
      <td>${statusBadge}</td>
      <td class="ts" title="${escHtml(detail)}">${escHtml(detail.length > 80 ? detail.slice(0, 80) + "…" : detail)}</td>`;
    tbody.appendChild(tr);
  }
}

function bindTelegramDeliveryLog() {
  el("refreshTgDeliveryLogBtn")?.addEventListener("click", () => loadTelegramDeliveryLog(1));
  el("tgDeliveryUserFilter")?.addEventListener("change", () => loadTelegramDeliveryLog(1));
  el("tgDeliveryTypeFilter")?.addEventListener("change", () => loadTelegramDeliveryLog(1));
  el("tgDeliveryStatusFilter")?.addEventListener("change", () => loadTelegramDeliveryLog(1));
}


/* ═══════════════════════════════════════════════
   Adaptive Intelligence Administration
   ═══════════════════════════════════════════════ */

function adaptiveActionLabel(action) {
  const value = String(action || '').toUpperCase();
  if (value.includes('HIGH')) return '<span class="adaptive-badge adaptive-badge-success">🔥 High</span>';
  if (value.includes('WATCHLIST')) return '<span class="adaptive-badge adaptive-badge-warning">👀 Watchlist</span>';
  if (value.includes('REJECT')) return '<span class="adaptive-badge adaptive-badge-danger">⛔ Reject</span>';
  if (value.includes('SEND_NORMAL')) return '<span class="adaptive-badge adaptive-badge-success">✅ Normal</span>';
  return `<span class="adaptive-badge adaptive-badge-muted">${escHtml(value || '—')}</span>`;
}

const ADAPTIVE_CATEGORY_LABELS = {
  VOLATILITY_1S: 'Volatility (1s)',
  VOLATILITY_STANDARD: 'Volatility (Standard)',
  BOOM_INDICES: 'Boom Indices',
  CRASH_INDICES: 'Crash Indices',
  JUMP_INDICES: 'Jump Indices',
  STEP_INDICES: 'Step Indices',
  FOREX_MAJORS: 'Forex Majors',
  FOREX_CROSSES: 'Forex Crosses',
  COMMODITIES: 'Commodities',
};

const ADAPTIVE_GUIDE_ENTRIES = [
  {
    name: 'MTF Weight',
    description: 'Controls how strongly higher timeframe confirmation influences qualification.',
    purpose: 'Makes signal delivery more selective when higher timeframe alignment matters.',
    range: 'Usually effective between 4.0 and 10.0 total weight influence.',
    impact: 'Higher values tighten filtering; lower values allow more opportunities.',
    warning: 'Set too high and good early setups may be skipped before momentum expands.'
  },
  {
    name: 'Confidence Threshold',
    description: 'The minimum confidence required before a signal is approved for Telegram delivery.',
    purpose: 'Prevents low-quality signals from reaching users too aggressively.',
    range: 'Most users perform well with watchlist near 80% and high confidence near 90%.',
    impact: 'Higher thresholds reduce signal count and usually improve precision.',
    warning: 'Low thresholds can flood users with noisy signals during unstable sessions.'
  },
  {
    name: 'Historical Sample Size',
    description: 'Minimum resolved trade count before adaptive statistics become trusted.',
    purpose: 'Protects the engine from overreacting to tiny samples.',
    range: '10–20 is common for activation; 15+ is safer for weight changes.',
    impact: 'Lower values adapt faster; higher values trade speed for stability.',
    warning: 'Very small samples can overfit to a single market streak.'
  },
  {
    name: 'Adaptive Weight',
    description: 'The current learned strength of an individual confluence factor.',
    purpose: 'Represents how useful that factor has historically been for the user and scope.',
    range: 'Weights normally move between 1.0 and 10.0.',
    impact: 'Higher weights raise confidence more strongly for matching factors.',
    warning: 'Locked weights stop automatic evolution until unlocked.'
  },
  {
    name: 'Confidence Score',
    description: 'Statistical reliability derived from sample size, win rate, and expectancy.',
    purpose: 'Shows how much trust to place in learned conclusions.',
    range: '0–100%. Values above 70% usually indicate mature learning.',
    impact: 'Higher confidence lets strong weights matter more in final scoring.',
    warning: 'A high win rate with low sample size can still be misleading.'
  },
  {
    name: 'Win Rate',
    description: 'Percentage of resolved WIN trades for the selected scope or factor.',
    purpose: 'Gives an intuitive picture of how often a rule succeeds.',
    range: 'Healthy values vary by strategy and market regime.',
    impact: 'Higher win rate usually improves reliability and weight direction.',
    warning: 'Win rate alone is incomplete; always compare it with average R multiple.'
  },
  {
    name: 'Average R Multiple',
    description: 'Average reward-to-risk outcome for resolved WIN/LOSS trades.',
    purpose: 'Separates strategies that win often from those that win efficiently.',
    range: 'Positive values indicate profitable expectancy; 0.3+ is generally healthier.',
    impact: 'Higher expectancy improves both confidence and best-strategy ranking.',
    warning: 'A good win rate with poor R multiple can still underperform.'
  },
  {
    name: 'Learning Mode',
    description: 'Shows whether a factor is auto-adjusting, mixed, locked, or not yet started.',
    purpose: 'Helps admins understand if the engine is still learning or being manually controlled.',
    range: 'Auto Learning, Mixed, Locked, Not Started.',
    impact: 'Locked values preserve manual tuning while auto learning keeps evolving.',
    warning: 'Overusing locks can freeze the model in outdated market conditions.'
  },
  {
    name: 'Telegram Qualification Threshold',
    description: 'The watchlist / send threshold controlling when Telegram delivery begins.',
    purpose: 'Balances opportunity volume against notification quality.',
    range: 'Commonly around 75–85%.',
    impact: 'Higher values make Telegram quieter and more selective.',
    warning: 'If it sits too close to reject threshold, watchlist analysis loses meaning.'
  },
];

let adaptiveDashboardState = { profileIndex: null, detail: null };
let adaptiveSelectedUserId = 0;
let adaptiveEditingRuleScope = null;
let adaptiveProfileSortKey = 'name';
let adaptiveProfileSortDirection = 'asc';
let adaptiveFactorSortKey = 'sample_size';
let adaptiveFactorSortDirection = 'desc';
let adaptiveRuleSortKey = 'market_category';
let adaptiveRuleSortDirection = 'asc';
let adaptiveProfileSearchTimer = null;
const adaptiveFactorRowMap = new Map();
const adaptiveRuleRowMap = new Map();

/* Server-side pagination/sort/search state for the Rules, Trades, Decisions,
   and Audit Log tables on the adaptive intelligence detail view. Prefixes
   match the backend's adaptiveFetchPaginated() query-param prefixes. */
const ADAPTIVE_PAGE_TABLES = {
  rules: { prefix: 'rules', defaultSort: 'updated_at', defaultDir: 'desc' },
  trades: { prefix: 'trades', defaultSort: 'created_at', defaultDir: 'desc' },
  decisions: { prefix: 'decisions', defaultSort: 'created_at', defaultDir: 'desc' },
  audit: { prefix: 'audit', defaultSort: 'created_at', defaultDir: 'desc' },
};
const adaptiveTablePagination = {
  rules: { page: 1, per_page: 25, sort: 'updated_at', dir: 'desc', search: '' },
  trades: { page: 1, per_page: 25, sort: 'created_at', dir: 'desc', search: '' },
  decisions: { page: 1, per_page: 25, sort: 'created_at', dir: 'desc', search: '' },
  audit: { page: 1, per_page: 25, sort: 'created_at', dir: 'desc', search: '' },
};
let adaptiveTableSearchTimer = null;

function renderAdaptiveTablePagination(tableKey, pageData) {
  const container = el(`adaptive${tableKey.charAt(0).toUpperCase()}${tableKey.slice(1)}Pagination`);
  const summary = el(`adaptive${tableKey.charAt(0).toUpperCase()}${tableKey.slice(1)}Summary`);
  const state = adaptiveTablePagination[tableKey];
  const total = pageData?.total || 0;
  const page = pageData?.page || 1;
  const lastPage = pageData?.last_page || 1;
  if (summary) {
    const start = total === 0 ? 0 : (page - 1) * (pageData?.per_page || state.per_page) + 1;
    const end = total === 0 ? 0 : Math.min(total, start + (pageData?.rows?.length || 0) - 1);
    summary.textContent = total === 0 ? 'No records found.' : `Showing ${start}-${end} of ${total}`;
  }
  if (!container) return;
  container.innerHTML = '';
  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'btn-ghost btn-sm';
  prev.textContent = '← Prev';
  prev.disabled = page <= 1;
  prev.addEventListener('click', () => {
    state.page = Math.max(1, page - 1);
    loadAdaptiveUserDetail(adaptiveSelectedUserId);
  });
  const info = document.createElement('span');
  info.className = 'adaptive-page-label';
  info.textContent = `Page ${page} / ${Math.max(1, lastPage)}`;
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'btn-ghost btn-sm';
  next.textContent = 'Next →';
  next.disabled = page >= lastPage;
  next.addEventListener('click', () => {
    state.page = Math.min(lastPage, page + 1);
    loadAdaptiveUserDetail(adaptiveSelectedUserId);
  });
  container.appendChild(prev);
  container.appendChild(info);
  container.appendChild(next);
}

function bindAdaptiveTableControl(tableKey, searchId, pageSizeId) {
  const state = adaptiveTablePagination[tableKey];
  const searchInput = el(searchId);
  if (searchInput) {
    searchInput.value = state.search;
    searchInput.addEventListener('input', () => {
      clearTimeout(adaptiveTableSearchTimer);
      adaptiveTableSearchTimer = setTimeout(() => {
        state.search = searchInput.value.trim();
        state.page = 1;
        loadAdaptiveUserDetail(adaptiveSelectedUserId);
      }, 350);
    });
  }
  const pageSizeSelect = el(pageSizeId);
  if (pageSizeSelect) {
    pageSizeSelect.value = String(state.per_page);
    pageSizeSelect.addEventListener('change', () => {
      state.per_page = Number(pageSizeSelect.value) || 25;
      state.page = 1;
      loadAdaptiveUserDetail(adaptiveSelectedUserId);
    });
  }
}

function bindAdaptiveTableControls() {
  bindAdaptiveTableControl('rules', 'adaptiveRulesSearch', 'adaptiveRulesPageSize');
  bindAdaptiveTableControl('trades', 'adaptiveTradesSearch', 'adaptiveTradesPageSize');
  bindAdaptiveTableControl('decisions', 'adaptiveDecisionsSearch', 'adaptiveDecisionsPageSize');
  bindAdaptiveTableControl('audit', 'adaptiveAuditSearch', 'adaptiveAuditPageSize');
}

function resetAdaptiveTablePagination() {
  for (const [tableKey, config] of Object.entries(ADAPTIVE_PAGE_TABLES)) {
    const state = adaptiveTablePagination[tableKey];
    state.page = 1;
    state.sort = config.defaultSort;
    state.dir = config.defaultDir;
  }
}

function adaptiveCategoryLabel(value) {
  return ADAPTIVE_CATEGORY_LABELS[value] || value || '—';
}

function adaptiveFiniteNumber(value) {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function adaptiveNumber(value, digits = 1, fallback = '—') {
  const parsed = adaptiveFiniteNumber(value);
  return parsed === null ? fallback : parsed.toFixed(digits);
}

function adaptivePct(value, digits = 1, fallback = '—') {
  const parsed = adaptiveFiniteNumber(value);
  return parsed === null ? fallback : `${parsed.toFixed(digits)}%`;
}

function adaptiveStatusClass(status) {
  const value = String(status || '').toUpperCase();
  if (value.includes('LOCK')) return 'adaptive-badge-danger';
  if (value.includes('MATURE') || value.includes('AUTO')) return 'adaptive-badge-success';
  if (value.includes('ACTIVE')) return 'adaptive-badge-primary';
  if (value.includes('LEARNING')) return 'adaptive-badge-warning';
  if (value.includes('MIX')) return 'adaptive-badge-warning';
  return 'adaptive-badge-muted';
}

function adaptiveJsonSummary(value) {
  if (value == null) return '—';
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return escHtml(parsed).slice(0, 120); }
  }
  if (parsed === null || typeof parsed !== 'object') return escHtml(String(parsed));
  const entries = Object.entries(parsed).slice(0, 4).map(([k, v]) => `${k}: ${typeof v === 'object' ? '[...]' : v}`);
  return escHtml(entries.join(' · ') || '—');
}

function adaptiveWeightTone(percent) {
  if (percent >= 75) return 'success';
  if (percent >= 45) return 'warning';
  return 'danger';
}

function adaptiveBar(percent, label, title) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  const tone = adaptiveWeightTone(value);
  return `<div class="adaptive-meter" title="${escHtml(title || '')}"><span class="adaptive-meter-bar adaptive-meter-${tone}" style="width:${value}%"></span><span class="adaptive-meter-label">${escHtml(label)}</span></div>`;
}

function adaptiveSortRows(rows, key, direction, customGetter) {
  const list = [...(rows || [])];
  const factor = direction === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    const av = customGetter ? customGetter(a, key) : a?.[key];
    const bv = customGetter ? customGetter(b, key) : b?.[key];
    const an = Number(av);
    const bn = Number(bv);
    if (Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * factor;
    return String(av ?? '').localeCompare(String(bv ?? ''), undefined, { sensitivity: 'base' }) * factor;
  });
  return list;
}

function getAdaptiveProfileFilters() {
  return {
    search: (el('adaptiveProfileSearch')?.value || '').trim(),
    status: el('adaptiveProfileStatusFilter')?.value || '',
    plan: el('adaptiveProfilePlanFilter')?.value || '',
    learning_status: el('adaptiveLearningStatusFilter')?.value || '',
    market_category: el('adaptiveCategoryFilter')?.value || '',
    strategy_key: (el('adaptiveStrategyFilter')?.value || '').trim(),
    symbol: (el('adaptiveSymbolFilter')?.value || '').trim(),
  };
}

function buildAdaptiveProfilesQuery(page = 1) {
  const params = new URLSearchParams({ action: 'profiles', page: String(page), per_page: '10' });
  const filters = getAdaptiveProfileFilters();
  for (const [key, value] of Object.entries(filters)) {
    if (key === 'strategy_key' || key === 'symbol') continue;
    if (value) params.set(key, value);
  }
  params.set('sort_key', adaptiveProfileSortKey);
  params.set('sort_direction', adaptiveProfileSortDirection);
  return params.toString();
}

function buildAdaptiveDetailQuery(userId = adaptiveSelectedUserId) {
  const params = new URLSearchParams({ action: 'detail', user_id: String(userId) });
  const filters = getAdaptiveProfileFilters();
  if (filters.market_category) params.set('market_category', filters.market_category);
  if (filters.strategy_key) params.set('strategy_key', filters.strategy_key);
  if (filters.symbol) params.set('symbol', filters.symbol);
  for (const [tableKey, config] of Object.entries(ADAPTIVE_PAGE_TABLES)) {
    const state = adaptiveTablePagination[tableKey];
    params.set(`${config.prefix}_page`, String(state.page));
    params.set(`${config.prefix}_per_page`, String(state.per_page));
    params.set(`${config.prefix}_sort`, state.sort);
    params.set(`${config.prefix}_dir`, state.dir);
    if (state.search) params.set(`${config.prefix}_search`, state.search);
  }
  return params.toString();
}

async function loadAdaptiveDashboard(preferredUserId = adaptiveSelectedUserId) {
  renderAdaptiveGuide();
  await loadAdaptiveProfileIndex(preferredUserId);
}

async function loadAdaptiveProfileIndex(preferredUserId = adaptiveSelectedUserId, pageOverride = null) {
  const page = Number.isFinite(Number(pageOverride)) && Number(pageOverride) > 0
    ? Number(pageOverride)
    : (adaptiveDashboardState.profileIndex?.page || 1);
  const tbody = el('adaptiveProfilesIndexBody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="table-empty">Loading intelligence profiles…</td></tr>';
  try {
    const resp = await apiRequest('/admin/adaptive?' + buildAdaptiveProfilesQuery(page));
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || 'Failed to load intelligence profiles');
    const rows = data.rows || [];
    adaptiveDashboardState.profileIndex = { ...data, rows };
    renderAdaptiveProfileIndex(rows, data);
    const selected = rows.some((row) => Number(row.user_id) === Number(preferredUserId))
      ? Number(preferredUserId)
      : (rows[0] ? Number(rows[0].user_id) : 0);
    if (selected !== adaptiveSelectedUserId) resetAdaptiveTablePagination();
    adaptiveSelectedUserId = selected;
    if (selected > 0) {
      await loadAdaptiveUserDetail(selected);
    } else {
      renderAdaptiveEmptyState();
    }
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="table-empty" style="color:var(--danger-soft)">${escHtml(e.message)}</td></tr>`;
    renderAdaptiveEmptyState(escHtml(e.message));
  }
}

function renderAdaptiveProfileIndex(rows, payload) {
  const tbody = el('adaptiveProfilesIndexBody');
  const summary = el('adaptiveProfileListSummary');
  if (summary) {
    summary.textContent = `${payload.total || 0} users • server-filtered adaptive intelligence directory`;
  }
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="table-empty">No adaptive profiles match the current filters.</td></tr>';
    renderAdaptiveProfilesPagination(payload.page || 1, payload.last_page || 1);
    return;
  }
  tbody.innerHTML = rows.map((row) => {
    const selected = Number(row.user_id) === Number(adaptiveSelectedUserId);
    const strategies = (row.assigned_strategies || []).slice(0, 3).map((key) => escHtml(allStrategies.find((s) => s.key === key)?.label || key)).join(', ') || 'No strategies';
    const categories = (row.market_categories_enabled || []).slice(0, 2).map(adaptiveCategoryLabel).join(', ') || 'All defaults';
    const rowLabel = `View adaptive profile for ${row.name || row.username}`;
    return `
      <tr class="adaptive-profile-row${selected ? ' selected' : ''}" data-adaptive-user-id="${row.user_id}" tabindex="0" role="button" aria-label="${escHtml(rowLabel)}" aria-pressed="${selected ? 'true' : 'false'}">
        <td>
          <strong>${escHtml(row.name || row.username)}</strong>
          <div class="ts">@${escHtml(row.username)}</div>
          <div class="adaptive-row-note">${escHtml(strategies)}</div>
          <div class="adaptive-row-note">${escHtml(categories)}</div>
        </td>
        <td><span class="adaptive-badge adaptive-badge-muted">${escHtml(row.subscription_plan || 'none')}</span></td>
        <td><span class="adaptive-badge ${adaptiveStatusClass(row.status)}">${escHtml(row.status)}</span></td>
        <td><span class="adaptive-badge ${adaptiveStatusClass(row.learning_status_code)}">${escHtml(row.learning_status)}</span></td>
        <td>
          <div class="adaptive-threshold-stack">
            <span title="Active high-confidence threshold">High ${adaptivePct(row.active_confidence_threshold)}</span>
            <span title="Telegram qualification threshold">TG ${adaptivePct(row.telegram_qualification_threshold)}</span>
          </div>
        </td>
      </tr>`;
  }).join('');
  const selectUser = async (node) => {
    resetAdaptiveTablePagination();
    adaptiveSelectedUserId = Number(node.dataset.adaptiveUserId);
    renderAdaptiveProfileIndex(rows, payload);
    await loadAdaptiveUserDetail(adaptiveSelectedUserId);
  };
  tbody.querySelectorAll('[data-adaptive-user-id]').forEach((node) => {
    node.addEventListener('click', () => selectUser(node));
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectUser(node);
      }
    });
  });
  renderAdaptiveProfilesPagination(payload.page || 1, payload.last_page || 1);
}

function renderAdaptiveProfilesPagination(page, lastPage) {
  const container = el('adaptiveProfilesPagination');
  if (!container) return;
  container.innerHTML = '';
  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'btn-ghost btn-sm';
  prev.textContent = '← Prev';
  prev.disabled = page <= 1;
  prev.addEventListener('click', () => loadAdaptiveProfileIndex(adaptiveSelectedUserId, page - 1));
  const info = document.createElement('span');
  info.className = 'adaptive-page-label';
  info.textContent = `Page ${page} / ${Math.max(1, lastPage)}`;
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'btn-ghost btn-sm';
  next.textContent = 'Next →';
  next.disabled = page >= lastPage;
  next.addEventListener('click', () => loadAdaptiveProfileIndex(adaptiveSelectedUserId, page + 1));
  container.appendChild(prev);
  container.appendChild(info);
  container.appendChild(next);
}

async function loadAdaptiveUserDetail(userId = adaptiveSelectedUserId) {
  const empty = el('adaptiveDetailEmpty');
  const content = el('adaptiveDetailContent');
  if (!userId) return renderAdaptiveEmptyState();
  if (empty) empty.textContent = 'Loading adaptive intelligence workspace…';
  if (empty) empty.style.display = '';
  if (content) content.style.display = 'none';
  try {
    const resp = await apiRequest('/admin/adaptive?' + buildAdaptiveDetailQuery(userId));
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || 'Failed to load user intelligence detail');
    adaptiveDashboardState.detail = data;
    renderAdaptiveUserDetail(data);
  } catch (e) {
    renderAdaptiveEmptyState(e.message);
  }
}

function renderAdaptiveEmptyState(message = 'Select a user intelligence profile to begin.') {
  const empty = el('adaptiveDetailEmpty');
  const content = el('adaptiveDetailContent');
  if (empty) {
    empty.textContent = message;
    empty.style.display = '';
  }
  if (content) content.style.display = 'none';
}

function renderAdaptiveUserDetail(data) {
  const empty = el('adaptiveDetailEmpty');
  const content = el('adaptiveDetailContent');
  if (empty) empty.style.display = 'none';
  if (content) content.style.display = '';
  renderAdaptiveUserHero(data.profile || {}, data.adaptive_profiles || []);
  renderAdaptiveSummary(data.profile || {}, data.ingestion_diagnostics || null);
  renderAdaptiveFactorDiagnostics(data.factor_diagnostics || null);
  renderAdaptivePipelineDiagnostics(data.pipeline_diagnostics || null);
  renderAdaptiveFactors(data.factor_stats || []);
  renderAdaptiveQualificationRules(data.rules_page || { rows: data.rules || [], total: (data.rules || []).length, page: 1, last_page: 1, per_page: 25 });
  renderAdaptiveTrades(data.trades_page || { rows: data.trades || [], total: (data.trades || []).length, page: 1, last_page: 1, per_page: 25 });
  renderAdaptiveDecisions(data.decisions_page || { rows: data.decisions || [], total: (data.decisions || []).length, page: 1, last_page: 1, per_page: 25 });
  renderAdaptiveAudit(data.audits_page || { rows: data.audits || [], total: (data.audits || []).length, page: 1, last_page: 1, per_page: 25 });
  renderAdaptiveCategoryAnalytics(data.category_analytics || [], data.category_diagnostics || null);
  renderAdaptiveFactorStatsBreakdown(
    data.factor_statistics_by_strategy || [],
    data.factor_statistics_by_symbol || [],
    data.factor_statistics_by_category || []
  );
}

function renderAdaptiveUserHero(profile, adaptiveProfiles) {
  const container = el('adaptiveUserHero');
  if (!container) return;
  const strategies = (profile.assigned_strategies || []).map((key) => `<span class="strategy-tag">${escHtml(allStrategies.find((s) => s.key === key)?.label || key)}</span>`).join('') || '<span class="adaptive-muted">No strategies assigned</span>';
  const categories = (profile.market_categories_enabled || []).map((value) => `<span class="adaptive-chip">${escHtml(adaptiveCategoryLabel(value))}</span>`).join('') || '<span class="adaptive-muted">Default rule categories</span>';
  const learnedProfiles = adaptiveProfiles.length
    ? adaptiveProfiles.slice(0, 4).map((item) => `<span class="adaptive-chip">${escHtml(item.symbol)} · ${escHtml(item.strategy_key)} · ${escHtml(item.adaptive_mode)}</span>`).join('')
    : '<span class="adaptive-muted">No saved adaptive profiles yet</span>';
  container.innerHTML = `
    <div class="adaptive-user-hero-card">
      <div>
        <div class="adaptive-eyebrow">USER INTELLIGENCE PROFILE</div>
        <h2>${escHtml(profile.name || profile.username || 'Unknown User')}</h2>
        <div class="adaptive-user-meta">@${escHtml(profile.username || '—')} • ${escHtml(profile.subscription_plan || 'no plan')} • ${escHtml(profile.status || 'unknown')}</div>
      </div>
      <div class="adaptive-hero-stats">
        <span class="adaptive-badge ${adaptiveStatusClass(profile.learning_status_code)}">${escHtml(profile.learning_status || 'Not Started')}</span>
        <span class="adaptive-badge adaptive-badge-muted">Updated ${escHtml(profile.last_updated ? fmtDateTime(profile.last_updated) : '—')}</span>
      </div>
      <div class="adaptive-hero-section"><strong>Assigned Strategies</strong><div class="adaptive-chip-row">${strategies}</div></div>
      <div class="adaptive-hero-section"><strong>Market Categories Enabled</strong><div class="adaptive-chip-row">${categories}</div></div>
      <div class="adaptive-hero-section"><strong>Assigned Adaptive Profiles</strong><div class="adaptive-chip-row">${learnedProfiles}</div></div>
    </div>`;
}

function renderAdaptiveSummary(profile, ingestionDiagnostics = null) {
  const container = el('adaptiveUserSummaryCards');
  if (!container) return;
  const cards = [
    ['Total Trades', profile.trade_count || 0, 'Resolved adaptive trade history for this user.'],
    ['Win Rate', adaptivePct(profile.win_rate || 0), 'Share of resolved WIN trades.'],
    ['Average R', adaptiveNumber(profile.avg_r_multiple, 2), 'Average reward-to-risk multiple.'],
    ['Confidence', adaptivePct(profile.avg_confidence, 1), 'Average confidence across recorded trades.'],
    ['Adaptive Rules', profile.factor_count || 0, 'Learned factor rows available for inspection.'],
    ['Locked Values', profile.locked_factor_count || 0, 'Adaptive weights currently locked by an admin.'],
    ['High Threshold', adaptivePct(profile.active_confidence_threshold, 1), 'Active high-confidence threshold.'],
    ['Telegram Threshold', adaptivePct(profile.telegram_qualification_threshold, 1), 'Watchlist / Telegram qualification threshold.'],
  ];
  if (ingestionDiagnostics) {
    cards.push(
      ['Trusted Ingestion', adaptivePct(ingestionDiagnostics.trusted_rate_pct, 1), 'Trusted adaptive trade ingestion rate (all-time).'],
      ['Untrusted Ingestion', adaptivePct(ingestionDiagnostics.untrusted_rate_pct, 1), 'Untrusted adaptive trade ingestion rate (all-time).'],
      ['Trusted Ingestion (24h)', adaptivePct(ingestionDiagnostics.trusted_24h_rate_pct, 1), 'Trusted adaptive trade ingestion rate in the last 24h.']
    );
  }
  container.innerHTML = cards.map(([label, value, title]) => `<div class="stat-card" title="${escHtml(title)}"><div class="stat-label">${label}</div><div class="stat-value">${value}</div></div>`).join('');
}

function renderAdaptiveFactorDiagnostics(diagnostics = null) {
  const container = el('adaptiveFactorDiagnostics');
  if (!container) return;
  if (!diagnostics) {
    container.innerHTML = '';
    return;
  }
  const cards = [
    ['Total Resolved Trades', diagnostics.total_resolved_trades || 0],
    ['Total Adaptive Trades', diagnostics.total_adaptive_trades || 0],
    ['Total Factors Recorded', diagnostics.total_factors_recorded || 0],
    ['Rated Factors', diagnostics.rated_factors || 0],
    ['Unrated Factors', diagnostics.unrated_factors || 0],
    ['Min Samples To Rate', diagnostics.min_sample_size || 0],
  ];
  container.innerHTML = cards.map(([label, value]) => `<div class="stat-card"><div class="stat-label">${escHtml(label)}</div><div class="stat-value">${escHtml(String(value))}</div></div>`).join('');
}

function renderAdaptivePipelineDiagnostics(diagnostics = null) {
  const container = el('adaptivePipelineDiagnostics');
  if (!container) return;
  if (!diagnostics) {
    container.innerHTML = '';
    return;
  }
  const cards = [
    ['Generated Signals', diagnostics.generated_signals || 0],
    ['Opened Trades', diagnostics.opened_trades || 0],
    ['Closed Trades', diagnostics.closed_trades || 0],
    ['Recorded Wins', diagnostics.recorded_wins || 0],
    ['Recorded Losses', diagnostics.recorded_losses || 0],
    ['Recorded Cancelled', diagnostics.recorded_cancelled || 0],
    ['Adaptive Updates', diagnostics.adaptive_updates || 0],
    ['Category Updates', diagnostics.category_updates || 0],
    ['Failed Updates', diagnostics.failed_updates || 0],
  ];
  container.innerHTML = cards.map(([label, value]) => {
    const isFailed = label === 'Failed Updates' && Number(value) > 0;
    const title = label === 'Failed Updates' ? ` title="${escHtml(diagnostics.failed_updates_reason || '')}"` : '';
    return `<div class="stat-card${isFailed ? ' stat-card-warning' : ''}"${title}><div class="stat-label">${escHtml(label)}</div><div class="stat-value">${escHtml(String(value))}</div></div>`;
  }).join('');
}

function adaptiveFactorStatus(row) {
  if (Number(row.locked_by_admin || 0)) return 'Locked';
  if (Number(row.sample_size || 0) >= 15) return 'Auto Adjusting';
  return 'Learning';
}

function renderAdaptiveFactors(rows) {
  adaptiveFactorRowMap.clear();
  const tbody = el('adaptiveFactorsBody');
  if (!tbody) return;
  const sorted = adaptiveSortRows(rows, adaptiveFactorSortKey, adaptiveFactorSortDirection, (row, key) => {
    if (key === 'market_category') return adaptiveCategoryLabel(row.market_category);
    if (key === 'strategy_key') return `${row.strategy_key}/${row.symbol_scope}`;
    if (key === 'win_rate') return Number(row.win_rate || 0);
    return row[key];
  });
  if (!sorted.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="table-empty">No adaptive rule weights found for the selected user and filters.</td></tr>';
    return;
  }
  tbody.innerHTML = sorted.map((row) => {
    adaptiveFactorRowMap.set(Number(row.id), row);
    const weightPct = Math.round((Number(row.current_weight || 0) / 10) * 100);
    const winRate = Number(row.win_rate || 0) * 100;
    const status = adaptiveFactorStatus(row);
    return `
      <tr>
        <td><strong>${escHtml(row.factor_key)}</strong><div class="adaptive-row-note">${escHtml(row.last_adjustment_reason || '')}</div></td>
        <td>${escHtml(adaptiveCategoryLabel(row.market_category))}</td>
        <td class="ts">${escHtml(row.strategy_key)} / ${escHtml(row.symbol_scope)}</td>
        <td>${adaptiveBar(weightPct, `${adaptiveNumber(weightPct, 0, '0')}%`, 'Visual adaptive weight indicator')}</td>
        <td title="Measures historical success rate based on resolved WIN and LOSS outcomes.">${adaptivePct(winRate, 1)}</td>
        <td title="Number of statistically meaningful outcomes used for this rule.">${escHtml(String(row.sample_size || 0))}</td>
        <td title="Measures statistical reliability based on historical performance and sample size.">${adaptivePct(row.confidence_score, 1)}</td>
        <td><span class="adaptive-badge ${adaptiveStatusClass(status)}">${escHtml(status)}</span></td>
        <td class="actions-cell">
          <button type="button" class="btn-icon btn-sm" data-adaptive-edit-factor="${row.id}">✏️</button>
          <button type="button" class="btn-icon btn-sm" data-adaptive-history-factor="${row.id}">🕘</button>
          <button type="button" class="btn-icon btn-sm" data-adaptive-lock-factor="${row.id}">${Number(row.locked_by_admin || 0) ? '🔓' : '🔒'}</button>
          <button type="button" class="btn-icon btn-sm btn-danger" data-adaptive-reset-factor="${row.id}">↺</button>
        </td>
      </tr>`;
  }).join('');
  tbody.querySelectorAll('[data-adaptive-edit-factor]').forEach((btn) => btn.addEventListener('click', () => editAdaptiveFactor(Number(btn.dataset.adaptiveEditFactor))));
  tbody.querySelectorAll('[data-adaptive-history-factor]').forEach((btn) => btn.addEventListener('click', () => openAdaptiveFactorHistory(Number(btn.dataset.adaptiveHistoryFactor))));
  tbody.querySelectorAll('[data-adaptive-lock-factor]').forEach((btn) => btn.addEventListener('click', () => toggleAdaptiveFactorLock(Number(btn.dataset.adaptiveLockFactor))));
  tbody.querySelectorAll('[data-adaptive-reset-factor]').forEach((btn) => btn.addEventListener('click', () => resetAdaptiveFactor(Number(btn.dataset.adaptiveResetFactor))));
}

function setAdaptiveRuleEditor(rule) {
  if (!rule) return;
  adaptiveEditingRuleScope = {
    market_category: rule.market_category,
    strategy_key: rule.strategy_key,
    symbol_scope: rule.symbol_scope,
  };
  el('adaptiveRuleScopeLabel').textContent = `Editing ${rule.market_category} / ${rule.strategy_key} / ${rule.symbol_scope}`;
  setRuleField('adaptiveRuleReject', rule.reject_below, 65);
  setRuleField('adaptiveRuleWatchlist', rule.watchlist_below, 80);
  setRuleField('adaptiveRuleHigh', rule.high_confidence_min, 90);
  setRuleField('adaptiveRuleSamples', rule.min_sample_size, 10);
  setRuleField('adaptiveRuleWeightSamples', rule.min_weight_adjustment_samples, 15);
  setRuleField('adaptiveRuleWeightStep', rule.max_weight_step, 1);
  setRuleField('adaptiveRuleSignalBlend', rule.confidence_blend_signal, 0.30);
  setRuleField('adaptiveRuleHistoryBlend', rule.confidence_blend_history, 0.30);
  setRuleField('adaptiveRuleMarketBlend', rule.confidence_blend_market, 0.20);
  setRuleField('adaptiveRuleStrategyBlend', rule.confidence_blend_strategy, 0.20);
  if (el('adaptiveRuleWatchlistTelegram')) el('adaptiveRuleWatchlistTelegram').checked = !!Number(rule.watchlist_sends_to_telegram || 0);
}

function setRuleField(id, value, fallback) {
  const target = el(id);
  if (target) target.value = value != null ? value : fallback;
}

function renderAdaptiveQualificationRules(pageData) {
  adaptiveRuleRowMap.clear();
  const tbody = el('adaptiveRulesBody');
  if (!tbody) return;
  const rows = pageData.rows || [];
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="table-empty">No qualification rules found.</td></tr>';
    renderAdaptiveTablePagination('rules', pageData);
    return;
  }
  tbody.innerHTML = rows.map((row) => {
    const key = `${row.market_category}|${row.strategy_key}|${row.symbol_scope}`;
    adaptiveRuleRowMap.set(key, row);
    const selected = adaptiveEditingRuleScope
      && adaptiveEditingRuleScope.market_category === row.market_category
      && adaptiveEditingRuleScope.strategy_key === row.strategy_key
      && adaptiveEditingRuleScope.symbol_scope === row.symbol_scope;
    return `
      <tr class="${selected ? 'adaptive-selected-rule' : ''}">
        <td>${escHtml(adaptiveCategoryLabel(row.market_category))}</td>
        <td class="ts">${escHtml(row.strategy_key)}</td>
        <td class="ts">${escHtml(row.symbol_scope)}</td>
        <td>${adaptivePct(row.reject_below, 1)}</td>
        <td>${adaptivePct(row.watchlist_below, 1)}</td>
        <td>${adaptivePct(row.high_confidence_min, 1)}</td>
        <td><span class="adaptive-badge ${Number(row.enabled || 0) ? 'adaptive-badge-success' : 'adaptive-badge-muted'}">${Number(row.enabled || 0) ? 'Enabled' : 'Disabled'}</span></td>
        <td class="actions-cell"><button type="button" class="btn-icon btn-sm" data-adaptive-edit-rule="${escHtml(key)}">✏️ Edit</button></td>
      </tr>`;
  }).join('');
  const current = adaptiveEditingRuleScope
    ? adaptiveRuleRowMap.get(`${adaptiveEditingRuleScope.market_category}|${adaptiveEditingRuleScope.strategy_key}|${adaptiveEditingRuleScope.symbol_scope}`)
    : null;
  setAdaptiveRuleEditor(current || rows[0]);
  tbody.querySelectorAll('[data-adaptive-edit-rule]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = adaptiveRuleRowMap.get(btn.dataset.adaptiveEditRule);
      setAdaptiveRuleEditor(row);
      renderAdaptiveQualificationRules(pageData);
    });
  });
  renderAdaptiveTablePagination('rules', pageData);
}

function renderAdaptiveTrades(pageData) {
  const tbody = el('adaptiveTradesBody');
  if (!tbody) return;
  const rows = pageData.rows || [];
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="table-empty">No adaptive trade history found.</td></tr>';
    renderAdaptiveTablePagination('trades', pageData);
    return;
  }
  tbody.innerHTML = rows.map((row) => `
    <tr>
      <td class="ts">${fmtDateTime(row.created_at)}</td>
      <td class="ts">${escHtml(row.trade_id)}</td>
      <td>${escHtml(adaptiveCategoryLabel(row.market_category))}</td>
      <td class="ts">${escHtml(row.strategy_key)}</td>
      <td>${escHtml(row.result)}</td>
      <td>${adaptiveNumber(row.r_multiple, 2)}</td>
      <td>${adaptivePct(row.confidence_score, 1)}</td>
      <td><span class="badge bg-${row.trusted ? 'info' : 'secondary'}" title="${row.trusted ? 'Counted toward adaptive learning aggregates' : 'Excluded from adaptive learning aggregates'}">${row.trusted ? 'Trusted' : 'Untrusted'}</span></td>
    </tr>`).join('');
  renderAdaptiveTablePagination('trades', pageData);
}

function renderAdaptiveDecisions(pageData) {
  const tbody = el('adaptiveDecisionsBody');
  if (!tbody) return;
  const rows = pageData.rows || [];
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No signal decisions logged yet.</td></tr>';
    renderAdaptiveTablePagination('decisions', pageData);
    return;
  }
  tbody.innerHTML = rows.map((row) => `
    <tr>
      <td class="ts">${fmtDateTime(row.created_at)}</td>
      <td class="ts">${escHtml(row.signal_id)}</td>
      <td>${escHtml(adaptiveCategoryLabel(row.market_category))}</td>
      <td>${adaptiveActionLabel(row.telegram_action)}</td>
      <td>${escHtml(row.qualification_band)}</td>
      <td><strong>${adaptivePct(row.final_confidence_score, 1)}</strong></td>
    </tr>`).join('');
  renderAdaptiveTablePagination('decisions', pageData);
}

function renderAdaptiveAudit(pageData) {
  const tbody = el('adaptiveAuditBody');
  if (!tbody) return;
  const rows = pageData.rows || [];
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No adaptive audit entries found.</td></tr>';
    renderAdaptiveTablePagination('audit', pageData);
    return;
  }
  tbody.innerHTML = rows.map((row) => `
    <tr>
      <td class="ts">${fmtDateTime(row.created_at)}</td>
      <td class="ts">${escHtml(row.actor_role)}${row.actor_user_id ? ` #${escHtml(String(row.actor_user_id))}` : ''}</td>
      <td>${escHtml(row.action_type)}<div class="adaptive-row-note">${escHtml(row.entity_key || '')}</div></td>
      <td class="ts">${adaptiveJsonSummary(row.previous_value_json)}</td>
      <td class="ts">${adaptiveJsonSummary(row.new_value_json)}</td>
      <td>${escHtml(row.reason_text || '—')}</td>
    </tr>`).join('');
  renderAdaptiveTablePagination('audit', pageData);
}

function renderAdaptiveCategoryAnalytics(rows, diagnostics = null) {
  const container = el('adaptiveCategoryAnalytics');
  if (!container) return;
  const rowMap = new Map((rows || []).map((row) => [row.market_category, row]));
  const baseCategories = Object.keys(ADAPTIVE_CATEGORY_LABELS).map((key) => rowMap.get(key) || ({
    market_category: key,
    trade_count: 0,
    wins: 0,
    losses: 0,
    win_rate: 0,
    avg_r_multiple: null,
    confidence: null,
    best_strategy: null,
    worst_strategy: null,
  }));
  const extraCategories = (rows || []).filter((row) => !ADAPTIVE_CATEGORY_LABELS[row.market_category]);
  const categories = baseCategories.concat(extraCategories);
  const diagnosticsBlock = diagnostics
    ? `<div class="adaptive-category-diag" title="Category aggregation diagnostics">Total: <strong>${escHtml(String(diagnostics.total_trades || 0))}</strong> · Categorized: <strong>${escHtml(String(diagnostics.categorized_trades || 0))}</strong> · Uncategorized: <strong>${escHtml(String(diagnostics.uncategorized_trades || 0))}</strong></div>`
    : '';
  container.innerHTML = diagnosticsBlock + categories.map((row) => {
    const total = Math.max(1, Number(row.trade_count || 0));
    const wins = Number(row.wins || 0);
    const losses = Number(row.losses || 0);
    const winWidth = Math.round((wins / total) * 100);
    const lossWidth = Math.round((losses / total) * 100);
    return `
      <article class="adaptive-category-card">
        <div class="adaptive-category-head">
          <h4>${escHtml(adaptiveCategoryLabel(row.market_category))}</h4>
          <span class="adaptive-badge adaptive-badge-muted">${escHtml(String(row.trade_count || 0))} trades</span>
        </div>
        <div class="adaptive-chart-stack" title="Wins vs losses">
          <span class="adaptive-chart-win" style="width:${winWidth}%"></span>
          <span class="adaptive-chart-loss" style="width:${lossWidth}%"></span>
        </div>
        <div class="adaptive-category-metrics">
          <span>Wins <strong>${escHtml(String(wins))}</strong></span>
          <span>Losses <strong>${escHtml(String(losses))}</strong></span>
          <span>Win Rate <strong>${adaptivePct(row.win_rate, 1)}</strong></span>
          <span>Avg R <strong>${adaptiveNumber(row.avg_r_multiple, 2)}</strong></span>
          <span>Confidence <strong>${adaptivePct(row.confidence, 1)}</strong></span>
        </div>
        <div class="adaptive-category-bestworst">
          <div><span class="adaptive-muted">Best Strategy</span><strong>${escHtml(row.best_strategy?.strategy_key || '—')}</strong><small>${adaptivePct(row.best_strategy?.win_rate, 1)} • ${adaptiveNumber(row.best_strategy?.avg_r_multiple, 2)}</small></div>
          <div><span class="adaptive-muted">Worst Strategy</span><strong>${escHtml(row.worst_strategy?.strategy_key || '—')}</strong><small>${adaptivePct(row.worst_strategy?.win_rate, 1)} • ${adaptiveNumber(row.worst_strategy?.avg_r_multiple, 2)}</small></div>
        </div>
      </article>`;
  }).join('');
}

function renderAdaptiveFactorStatsBreakdown(byStrategy, bySymbol, byCategory) {
  const container = el('adaptiveFactorStatsBreakdown');
  if (!container) return;
  const makeTable = (title, rows, keyLabel) => `
    <div class="profiles-table-wrapper adaptive-surface">
      <div class="adaptive-card-header"><div><h3>${escHtml(title)}</h3></div></div>
      <table class="profiles-table adaptive-table">
        <thead><tr><th>${escHtml(keyLabel)}</th><th>Factors</th><th>Rated</th><th>Samples</th><th>Avg Weight</th></tr></thead>
        <tbody>${(rows || []).length ? rows.map((row) => `
          <tr>
            <td>${escHtml(String(row[keyLabel === 'Category' ? 'market_category' : keyLabel === 'Strategy' ? 'strategy_key' : 'symbol_scope'] || '—'))}</td>
            <td>${escHtml(String(row.factor_count || 0))}</td>
            <td>${escHtml(String(row.rated_factor_count || 0))}</td>
            <td>${escHtml(String(row.total_samples || 0))}</td>
            <td>${adaptiveNumber(row.avg_weight, 2)}</td>
          </tr>`).join('') : `<tr><td colspan="5" class="table-empty">No factor statistics found.</td></tr>`}</tbody>
      </table>
    </div>`;
  container.innerHTML = makeTable('Factor Statistics By Strategy', byStrategy, 'Strategy')
    + makeTable('Factor Statistics By Symbol', bySymbol, 'Symbol')
    + makeTable('Factor Statistics By Category', byCategory, 'Category');
}

function renderAdaptiveGuide() {
  const container = el('adaptiveGuideGrid');
  if (!container) return;
  container.innerHTML = ADAPTIVE_GUIDE_ENTRIES.map((entry) => `
    <article class="adaptive-guide-card">
      <h4>${escHtml(entry.name)}</h4>
      <p>${escHtml(entry.description)}</p>
      <dl>
        <dt>Purpose</dt><dd>${escHtml(entry.purpose)}</dd>
        <dt>Recommended Range</dt><dd>${escHtml(entry.range)}</dd>
        <dt>Impact</dt><dd>${escHtml(entry.impact)}</dd>
        <dt>Warning</dt><dd>${escHtml(entry.warning)}</dd>
      </dl>
    </article>`).join('');
}

async function saveAdaptiveRule() {
  const status = el('adaptiveRuleStatus');
  if (status) status.textContent = '';
  if (!adaptiveSelectedUserId || !adaptiveEditingRuleScope) {
    if (status) status.textContent = 'Select a user and rule before saving.';
    return;
  }
  try {
    const resp = await apiRequest('/admin/adaptive?action=rules', {
      method: 'PATCH',
      body: JSON.stringify({
        user_id: adaptiveSelectedUserId,
        market_category: adaptiveEditingRuleScope.market_category,
        strategy_key: adaptiveEditingRuleScope.strategy_key,
        symbol_scope: adaptiveEditingRuleScope.symbol_scope,
        reject_below: Number(el('adaptiveRuleReject')?.value || 65),
        watchlist_below: Number(el('adaptiveRuleWatchlist')?.value || 80),
        high_confidence_min: Number(el('adaptiveRuleHigh')?.value || 90),
        min_sample_size: Number(el('adaptiveRuleSamples')?.value || 10),
        min_weight_adjustment_samples: Number(el('adaptiveRuleWeightSamples')?.value || 15),
        max_weight_step: Number(el('adaptiveRuleWeightStep')?.value || 1),
        confidence_blend_signal: Number(el('adaptiveRuleSignalBlend')?.value || 0.30),
        confidence_blend_history: Number(el('adaptiveRuleHistoryBlend')?.value || 0.30),
        confidence_blend_market: Number(el('adaptiveRuleMarketBlend')?.value || 0.20),
        confidence_blend_strategy: Number(el('adaptiveRuleStrategyBlend')?.value || 0.20),
        watchlist_sends_to_telegram: el('adaptiveRuleWatchlistTelegram')?.checked ? 1 : 0,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || 'Failed to save adaptive rule');
    if (status) {
      status.textContent = '✅ Adaptive rule saved.';
      status.style.color = 'var(--success-soft)';
    }
    await loadAdaptiveDashboard(adaptiveSelectedUserId);
  } catch (e) {
    if (status) {
      status.textContent = e.message;
      status.style.color = 'var(--danger-soft)';
    }
  }
}

async function editAdaptiveFactor(factorId) {
  const row = adaptiveFactorRowMap.get(factorId);
  if (!row) return;
  const currentWeight = prompt('Adaptive weight', String(row.current_weight ?? 5));
  if (currentWeight == null) return;
  const confidence = prompt('Confidence score', String(row.confidence_score ?? 0));
  if (confidence == null) return;
  const reason = prompt('Reason for manual override', 'Manual optimization');
  if (reason == null) return;
  const resp = await apiRequest('/admin/adaptive?action=factor', {
    method: 'PATCH',
    body: JSON.stringify({
      id: factorId,
      user_id: adaptiveSelectedUserId,
      current_weight: Number(currentWeight),
      confidence_score: Number(confidence),
      reason,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) return alert(data.error || 'Failed to update factor');
  await loadAdaptiveDashboard(adaptiveSelectedUserId);
}

async function toggleAdaptiveFactorLock(factorId) {
  const row = adaptiveFactorRowMap.get(factorId);
  if (!row) return;
  const locking = !Number(row.locked_by_admin || 0);
  const reason = prompt(locking ? 'Reason for locking this adaptive value' : 'Reason for re-enabling automatic learning', locking ? 'Preserve manual optimization' : 'Resume automatic learning');
  if (reason == null) return;
  const resp = await apiRequest('/admin/adaptive?action=factor', {
    method: 'PATCH',
    body: JSON.stringify({
      id: factorId,
      user_id: adaptiveSelectedUserId,
      locked_by_admin: locking ? 1 : 0,
      locked_reason: locking ? reason : '',
      reason,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) return alert(data.error || 'Failed to update adaptive lock');
  await loadAdaptiveDashboard(adaptiveSelectedUserId);
}

async function resetAdaptiveFactor(factorId) {
  if (!confirm('Reset this adaptive factor back to its base weight and re-enable automatic learning?')) return;
  const reason = prompt('Reason for reset', 'Reset to base weight');
  if (reason == null) return;
  const resp = await apiRequest('/admin/adaptive?action=reset_factor', {
    method: 'POST',
    body: JSON.stringify({ id: factorId, user_id: adaptiveSelectedUserId, reason }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) return alert(data.error || 'Failed to reset adaptive factor');
  await loadAdaptiveDashboard(adaptiveSelectedUserId);
}

async function openAdaptiveFactorHistory(factorId) {
  const row = adaptiveFactorRowMap.get(factorId);
  if (!row) return;
  const resp = await apiRequest('/admin/adaptive?action=history&' + new URLSearchParams({
    user_id: String(adaptiveSelectedUserId),
    factor_key: row.factor_key,
    market_category: row.market_category,
    strategy_key: row.strategy_key,
    symbol_scope: row.symbol_scope,
  }).toString());
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) return alert(data.error || 'Failed to load history');
  el('adaptiveHistoryTitle').textContent = `${row.factor_key} History`;
  el('adaptiveHistorySubtitle').textContent = `${adaptiveCategoryLabel(row.market_category)} • ${row.strategy_key} • ${row.symbol_scope}`;
  renderAdaptiveHistory(data.history || []);
  el('adaptiveHistoryModal').style.display = 'flex';
}

function renderAdaptiveHistory(rows) {
  const tbody = el('adaptiveHistoryBody');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No history found for this adaptive rule.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((row) => `
    <tr>
      <td class="ts">${fmtDateTime(row.created_at)}</td>
      <td class="ts">${escHtml(row.actor_role)}${row.actor_user_id ? ` #${escHtml(String(row.actor_user_id))}` : ''}</td>
      <td>${escHtml(row.action_type)}</td>
      <td class="ts">${adaptiveJsonSummary(row.previous_value_json)}</td>
      <td class="ts">${adaptiveJsonSummary(row.new_value_json)}</td>
      <td>${escHtml(row.reason_text || '—')}</td>
    </tr>`).join('');
}

async function exportAdaptiveData() {
  if (!adaptiveSelectedUserId) return alert('Select a user first.');
  const area = el('adaptiveImportExport');
  try {
    const resp = await apiRequest('/admin/adaptive?action=export&' + new URLSearchParams({ ...getAdaptiveProfileFilters(), user_id: String(adaptiveSelectedUserId) }).toString(), { method: 'GET' });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || 'Failed to export adaptive data');
    if (area) area.value = JSON.stringify(data.data || {}, null, 2);
  } catch (e) {
    if (area) area.value = `Export failed: ${e.message}`;
  }
}

async function importAdaptiveData() {
  if (!adaptiveSelectedUserId) return alert('Select a user first.');
  const area = el('adaptiveImportExport');
  const status = el('adaptiveImportStatus');
  if (status) status.textContent = '';
  try {
    const parsed = JSON.parse(area?.value || '{}');
    const resp = await apiRequest('/admin/adaptive?action=import', {
      method: 'POST',
      body: JSON.stringify({ user_id: adaptiveSelectedUserId, data: parsed }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || 'Failed to import adaptive data');
    if (status) {
      status.textContent = `✅ Imported ${data.inserted || 0} trades.`;
      status.style.color = 'var(--success-soft)';
    }
    await loadAdaptiveDashboard(adaptiveSelectedUserId);
  } catch (e) {
    if (status) {
      status.textContent = e.message;
      status.style.color = 'var(--danger-soft)';
    }
  }
}

async function resetAdaptiveScope(deleteHistory = false) {
  if (!adaptiveSelectedUserId) return alert('Select a user first.');
  const reason = prompt(deleteHistory ? 'Reason for deleting adaptive history' : 'Reason for resetting adaptive learning', deleteHistory ? 'Delete adaptive history' : 'Reset learning');
  if (reason == null) return;
  const resp = await apiRequest('/admin/adaptive?action=reset', {
    method: 'POST',
    body: JSON.stringify({
      user_id: adaptiveSelectedUserId,
      market_category: el('adaptiveCategoryFilter')?.value || '',
      delete_history: deleteHistory ? 1 : 0,
      reason,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) return alert(data.error || 'Failed to reset adaptive learning');
  await loadAdaptiveDashboard(adaptiveSelectedUserId);
}

async function cloneAdaptiveRules() {
  if (!adaptiveSelectedUserId) return alert('Select a user first.');
  const source = prompt('Enter the source username, or use id:<user_id> (example: id:42)');
  if (!source) return;
  const reason = prompt('Reason for cloning rules', 'Clone high-performing rule set');
  if (reason == null) return;
  const payload = { user_id: adaptiveSelectedUserId, reason };
  const sourceInput = source.trim();
  const sourceIdMatch = sourceInput.match(/^id:\s*(\d+)$/i);
  if (sourceIdMatch) payload.source_user_id = Number(sourceIdMatch[1]);
  else payload.source_username = sourceInput;
  const resp = await apiRequest('/admin/adaptive?action=clone_rules', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) return alert(data.error || 'Failed to clone rules');
  await loadAdaptiveDashboard(adaptiveSelectedUserId);
}

async function assignAdaptiveDefaults() {
  if (!adaptiveSelectedUserId) return alert('Select a user first.');
  if (!confirm('Assign the default adaptive profile to this user? This replaces their current qualification rules.')) return;
  const reason = prompt('Reason for assigning defaults', 'Reset to system default profile');
  if (reason == null) return;
  const resp = await apiRequest('/admin/adaptive?action=defaults', {
    method: 'POST',
    body: JSON.stringify({ user_id: adaptiveSelectedUserId, reason }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) return alert(data.error || 'Failed to assign defaults');
  await loadAdaptiveDashboard(adaptiveSelectedUserId);
}

function bindAdaptiveSortHeaders() {
  document.querySelectorAll('[data-adaptive-profile-sort]').forEach((th) => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', async () => {
      const key = th.dataset.adaptiveProfileSort;
      adaptiveProfileSortDirection = adaptiveProfileSortKey === key && adaptiveProfileSortDirection === 'asc' ? 'desc' : 'asc';
      adaptiveProfileSortKey = key;
      await loadAdaptiveProfileIndex(adaptiveSelectedUserId, 1);
    });
  });
  document.querySelectorAll('[data-adaptive-factor-sort]').forEach((th) => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const key = th.dataset.adaptiveFactorSort;
      adaptiveFactorSortDirection = adaptiveFactorSortKey === key && adaptiveFactorSortDirection === 'asc' ? 'desc' : 'asc';
      adaptiveFactorSortKey = key;
      renderAdaptiveFactors(adaptiveDashboardState.detail?.factor_stats || []);
    });
  });
  document.querySelectorAll('[data-adaptive-rule-sort]').forEach((th) => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const key = th.dataset.adaptiveRuleSort;
      const state = adaptiveTablePagination.rules;
      state.dir = state.sort === key && state.dir === 'asc' ? 'desc' : 'asc';
      state.sort = key;
      state.page = 1;
      loadAdaptiveUserDetail(adaptiveSelectedUserId);
    });
  });
}

function bindAdaptiveAdmin() {
  bindAdaptiveSortHeaders();
  bindAdaptiveTableControls();
  el('adaptiveRefreshBtn')?.addEventListener('click', () => loadAdaptiveDashboard(adaptiveSelectedUserId));
  el('adaptiveExportBtn')?.addEventListener('click', exportAdaptiveData);
  el('adaptiveImportBtn')?.addEventListener('click', importAdaptiveData);
  el('adaptiveResetBtn')?.addEventListener('click', () => resetAdaptiveScope(false));
  el('adaptiveDeleteHistoryBtn')?.addEventListener('click', () => resetAdaptiveScope(true));
  el('adaptiveSaveRuleBtn')?.addEventListener('click', saveAdaptiveRule);
  el('adaptiveCloneRulesBtn')?.addEventListener('click', cloneAdaptiveRules);
  el('adaptiveAssignDefaultsBtn')?.addEventListener('click', assignAdaptiveDefaults);
  el('adaptiveHistoryCloseBtn')?.addEventListener('click', () => { el('adaptiveHistoryModal').style.display = 'none'; });
  ['adaptiveProfileStatusFilter', 'adaptiveProfilePlanFilter', 'adaptiveLearningStatusFilter', 'adaptiveCategoryFilter'].forEach((id) => {
    const node = el(id);
    if (node) node.addEventListener('change', () => loadAdaptiveProfileIndex(adaptiveSelectedUserId, 1));
  });
  ['adaptiveStrategyFilter', 'adaptiveSymbolFilter'].forEach((id) => {
    const node = el(id);
    if (node) node.addEventListener('change', () => loadAdaptiveDashboard(adaptiveSelectedUserId));
  });
  const search = el('adaptiveProfileSearch');
  if (search) search.addEventListener('input', () => {
    clearTimeout(adaptiveProfileSearchTimer);
    adaptiveProfileSearchTimer = setTimeout(() => loadAdaptiveProfileIndex(adaptiveSelectedUserId, 1), 250);
  });
}
