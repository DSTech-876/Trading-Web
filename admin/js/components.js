/**
 * Admin Dashboard Components Library
 * Reusable UI components for modern Bootstrap 5 dashboard
 * 
 * Includes:
 * - Card components
 * - Collapsible sections
 * - Pagination controls
 * - Modal dialogs
 * - Loading skeletons
 * - Data tables
 */

const AdminComponents = (() => {
    'use strict';

    // ─── Configuration ───
    const config = {
        apiBase: window.ITGURU_AUTH_API_BASE ? 
            window.ITGURU_AUTH_API_BASE.replace(/\/auth\/?$/, '') : 
            'https://trading.dsitservicesja.com/api',
        debounceDelay: 300,
        defaultPageSize: 50
    };

    // ─── Utility Functions ───
    const debounce = (fn, delay = config.debounceDelay) => {
        let timeoutId;
        return function(...args) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => fn(...args), delay);
        };
    };

    const escapeHtml = (text) => {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    };

    const formatDate = (dateStr) => {
        return new Date(dateStr).toLocaleString();
    };

    const formatCurrency = (value) => {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD'
        }).format(value);
    };

    const formatPercent = (value) => {
        return (value * 100).toFixed(2) + '%';
    };

    // ─── KPI Card Component ───
    const createKPICard = (options) => {
        const {
            title,
            value,
            icon = 'chart-line',
            trend = null,
            trendLabel = '',
            color = 'primary',
            size = 'md'
        } = options;

        const sizeClass = {
            'sm': 'col-md-6',
            'md': 'col-lg-4',
            'lg': 'col-lg-3'
        }[size] || 'col-lg-4';

        const trendHtml = trend ? `
            <div class="kpi-trend ${trend > 0 ? 'trend-up' : 'trend-down'}">
                <i class="fas fa-arrow-${trend > 0 ? 'up' : 'down'}"></i>
                ${trend > 0 ? '+' : ''}${trend.toFixed(1)}% ${trendLabel}
            </div>
        ` : '';

        const html = `
            <div class="${sizeClass}">
                <div class="card kpi-card border-${color}">
                    <div class="card-body">
                        <div class="d-flex justify-content-between align-items-start">
                            <div>
                                <p class="text-muted mb-1">${escapeHtml(title)}</p>
                                <h3 class="mb-0">${escapeHtml(String(value))}</h3>
                                ${trendHtml}
                            </div>
                            <div class="kpi-icon text-${color}">
                                <i class="fas fa-${icon}"></i>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        return html;
    };

    // ─── Collapsible Section Component ───
    const createCollapsibleSection = (options) => {
        const {
            id = 'section-' + Math.random().toString(36).substr(2, 9),
            title,
            icon = 'folder',
            content,
            isOpen = true,
            onToggle = null,
            count = null // optional item/record counter shown next to the title
        } = options;

        const sectionKey = 'collapsed_' + id;
        const isCollapsed = localStorage.getItem(sectionKey) === 'true';
        const displayClass = isCollapsed ? 'collapsed' : '';
        const contentDisplay = isCollapsed ? 'display: none;' : '';
        const countBadge = count !== null && count !== undefined
            ? `<span class="badge section-count-badge ms-2" data-section-count>${escapeHtml(count)}</span>`
            : '';

        const html = `
            <div class="collapsible-section mb-3" data-section-id="${escapeHtml(id)}">
                <button class="btn btn-outline-secondary w-100 text-start d-flex justify-content-between align-items-center ${displayClass}" 
                        type="button" data-bs-toggle="collapse" data-bs-target="#${id}"
                        aria-expanded="${!isCollapsed}" aria-controls="${id}">
                    <div class="d-flex align-items-center flex-wrap">
                        <i class="fas fa-${icon} me-2"></i>
                        <span>${escapeHtml(title)}</span>
                        ${countBadge}
                    </div>
                    <i class="fas fa-chevron-down collapse-icon"></i>
                </button>
                <div id="${id}" class="collapse ${!isCollapsed ? 'show' : ''}" style="${contentDisplay}">
                    <div class="card-body">
                        ${typeof content === 'string' ? content : ''}
                    </div>
                </div>
            </div>
        `;

        // Create element
        const temp = document.createElement('div');
        temp.innerHTML = html;
        const element = temp.firstElementChild;

        // Add toggle listener
        const button = element.querySelector('button');
        button.addEventListener('click', () => {
            const isNowCollapsed = !element.querySelector('.collapse').classList.contains('show');
            localStorage.setItem(sectionKey, isNowCollapsed);
            button.setAttribute('aria-expanded', String(!isNowCollapsed));
            if (onToggle) onToggle(isNowCollapsed);
        });

        // Allow callers to update the counter badge later (e.g. after a
        // lazily-loaded dataset finishes fetching its total record count).
        element.updateCount = (nextCount) => {
            let badge = element.querySelector('[data-section-count]');
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'badge section-count-badge ms-2';
                badge.setAttribute('data-section-count', '');
                button.querySelector('div').appendChild(badge);
            }
            badge.textContent = String(nextCount);
        };

        return element;
    };

    // ─── Pagination Component ───
    const createPagination = (options) => {
        const {
            currentPage = 1,
            totalPages = 1,
            onPageChange = null,
            pageSizes = [25, 50, 100, 250],
            currentPageSize = 50
        } = options;

        let html = `
            <div class="pagination-wrapper d-flex justify-content-between align-items-center my-3">
                <div class="page-size-selector">
                    <label class="me-2">Rows per page:</label>
                    <select class="form-select form-select-sm d-inline-block w-auto">
        `;

        pageSizes.forEach(size => {
            const selected = size === currentPageSize ? 'selected' : '';
            html += `<option value="${size}" ${selected}>${size}</option>`;
        });

        html += `
                    </select>
                </div>
                <nav>
                    <ul class="pagination mb-0">
        `;

        // Previous button
        html += `
            <li class="page-item ${currentPage === 1 ? 'disabled' : ''}">
                <a class="page-link" href="#" data-page="${currentPage - 1}">
                    <i class="fas fa-chevron-left"></i> Previous
                </a>
            </li>
        `;

        // Page numbers
        const startPage = Math.max(1, currentPage - 2);
        const endPage = Math.min(totalPages, currentPage + 2);

        if (startPage > 1) {
            html += `<li class="page-item"><a class="page-link" href="#" data-page="1">1</a></li>`;
            if (startPage > 2) {
                html += `<li class="page-item disabled"><span class="page-link">...</span></li>`;
            }
        }

        for (let i = startPage; i <= endPage; i++) {
            const active = i === currentPage ? 'active' : '';
            html += `<li class="page-item ${active}"><a class="page-link" href="#" data-page="${i}">${i}</a></li>`;
        }

        if (endPage < totalPages) {
            if (endPage < totalPages - 1) {
                html += `<li class="page-item disabled"><span class="page-link">...</span></li>`;
            }
            html += `<li class="page-item"><a class="page-link" href="#" data-page="${totalPages}">${totalPages}</a></li>`;
        }

        // Next button
        html += `
            <li class="page-item ${currentPage === totalPages ? 'disabled' : ''}">
                <a class="page-link" href="#" data-page="${currentPage + 1}">
                    Next <i class="fas fa-chevron-right"></i>
                </a>
            </li>
        `;

        html += `
                    </ul>
                </nav>
            </div>
        `;

        const temp = document.createElement('div');
        temp.innerHTML = html;
        const element = temp.firstElementChild;

        // Add event listeners
        const pageLinks = element.querySelectorAll('a[data-page]');
        pageLinks.forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const page = parseInt(link.dataset.page);
                if (page >= 1 && page <= totalPages && onPageChange) {
                    onPageChange(page);
                }
            });
        });

        const pageSizeSelect = element.querySelector('select');
        if (pageSizeSelect) {
            pageSizeSelect.addEventListener('change', () => {
                if (onPageChange) {
                    onPageChange(1, parseInt(pageSizeSelect.value));
                }
            });
        }

        return element;
    };

    // ─── Loading Skeleton Component ───
    const createLoadingSkeleton = (rows = 3, columns = 4) => {
        let html = '<div class="loading-skeleton">';
        for (let i = 0; i < rows; i++) {
            html += '<div class="skeleton-row">';
            for (let j = 0; j < columns; j++) {
                const width = Math.random() * 30 + 70;
                html += `<div class="skeleton-item" style="width: ${width}%"></div>`;
            }
            html += '</div>';
        }
        html += '</div>';

        const temp = document.createElement('div');
        temp.innerHTML = html;
        return temp.firstElementChild;
    };

    // ─── Alert Component ───
    const createAlert = (message, type = 'info', icon = null) => {
        const iconMap = {
            'success': 'check-circle',
            'error': 'exclamation-circle',
            'warning': 'exclamation-triangle',
            'info': 'info-circle'
        };

        const alertIcon = icon || iconMap[type] || 'info-circle';

        const html = `
            <div class="alert alert-${type === 'error' ? 'danger' : type} alert-dismissible fade show" role="alert">
                <i class="fas fa-${alertIcon} me-2"></i>
                ${escapeHtml(message)}
                <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
            </div>
        `;

        const temp = document.createElement('div');
        temp.innerHTML = html;
        return temp.firstElementChild;
    };

    // ─── Modal Component ───
    const createModal = (options) => {
        const {
            id = 'modal-' + Math.random().toString(36).substr(2, 9),
            title,
            content,
            buttons = [
                { label: 'Close', action: 'close', variant: 'secondary' },
                { label: 'Save', action: 'save', variant: 'primary' }
            ]
        } = options;

        let buttonsHtml = '';
        buttons.forEach(btn => {
            buttonsHtml += `<button type="button" class="btn btn-${btn.variant}" data-action="${btn.action}">${escapeHtml(btn.label)}</button>`;
        });

        const html = `
            <div class="modal fade" id="${id}" tabindex="-1">
                <div class="modal-dialog modal-dialog-centered">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">${escapeHtml(title)}</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body">
                            ${typeof content === 'string' ? content : ''}
                        </div>
                        <div class="modal-footer">
                            ${buttonsHtml}
                        </div>
                    </div>
                </div>
            </div>
        `;

        const temp = document.createElement('div');
        temp.innerHTML = html;
        const element = temp.firstElementChild;

        return {
            element,
            show: () => {
                const modal = new bootstrap.Modal(element);
                modal.show();
            },
            hide: () => {
                const modal = bootstrap.Modal.getInstance(element);
                if (modal) modal.hide();
            },
            addAction: (action, callback) => {
                const button = element.querySelector(`[data-action="${action}"]`);
                if (button) {
                    button.addEventListener('click', callback);
                }
            }
        };
    };

    // ─── Data Table Component ───
    const createDataTable = (options) => {
        const {
            id = 'table-' + Math.random().toString(36).substr(2, 9),
            columns = [],
            data = [],
            searchable = true,
            sortable = true,
            selectable = true
        } = options;

        let html = `
            <div class="data-table-wrapper">
        `;

        if (searchable) {
            html += `
                <div class="mb-3">
                    <input type="text" class="form-control" placeholder="Search...">
                </div>
            `;
        }

        html += `
                <div class="table-responsive">
                    <table class="table table-hover" id="${id}">
                        <thead>
                            <tr>
        `;

        if (selectable) {
            html += `<th style="width: 40px;"><input type="checkbox" class="form-check-input"></th>`;
        }

        columns.forEach(col => {
            const sortIcon = sortable ? ' <i class="fas fa-sort text-muted ms-1"></i>' : '';
            html += `<th ${sortable ? 'style="cursor: pointer;"' : ''}>${escapeHtml(col.label)}${sortIcon}</th>`;
        });

        html += `
                            </tr>
                        </thead>
                        <tbody>
        `;

        data.forEach(row => {
            html += '<tr>';
            if (selectable) {
                html += `<td><input type="checkbox" class="form-check-input"></td>`;
            }
            columns.forEach(col => {
                const value = row[col.key] || '';
                let displayValue = value;

                if (col.type === 'date') {
                    displayValue = formatDate(value);
                } else if (col.type === 'currency') {
                    displayValue = formatCurrency(value);
                } else if (col.type === 'percent') {
                    displayValue = formatPercent(value);
                } else if (col.render) {
                    displayValue = col.render(value, row);
                }

                html += `<td>${displayValue}</td>`;
            });
            html += '</tr>';
        });

        html += `
                        </tbody>
                    </table>
                </div>
            </div>
        `;

        const temp = document.createElement('div');
        temp.innerHTML = html;
        return temp.firstElementChild;
    };

    // ─── Stat Badge Component ───
    const createStatBadge = (label, value, color = 'primary') => {
        return `
            <span class="badge bg-${color}">
                ${escapeHtml(label)}: <strong>${escapeHtml(String(value))}</strong>
            </span>
        `;
    };

    // ─── API Request Helper ───
    const apiRequest = async (path, options = {}) => {
        const token = window.ITGuruAuth?.getToken?.()
            || localStorage.getItem('itguru_auth_token')
            || localStorage.getItem('auth_token');
        const headers = {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': 'Bearer ' + token } : {}),
            ...options.headers
        };

        const url = config.apiBase + path;
        
        // Use auth error handler for 401/403 responses if available
        const fetchFn = async () => {
            let resp = await fetch(url, { ...options, headers });
            
            // Fallback to .php extension
            if (resp.status === 404 && !path.endsWith('.php')) {
                const phpPath = path.includes('?') ? path.replace('?', '.php?') : path + '.php';
                resp = await fetch(config.apiBase + phpPath, { ...options, headers });
            }
            
            return resp;
        };
        
        const response = typeof AdminAuthErrorHandler !== 'undefined' && AdminAuthErrorHandler?.fetchWithAuthHandling
            ? await AdminAuthErrorHandler.fetchWithAuthHandling(url, fetchFn, { retry: true, stopPollingOnFailure: true })
            : await fetchFn();

        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: response.statusText }));
            const errorMsg = error.error || error.message || response.statusText || `HTTP ${response.status}`;
            throw new Error(errorMsg);
        }

        return response.json();
    };

    // ─── Public API ───
    return {
        config,
        createKPICard,
        createCollapsibleSection,
        createPagination,
        createLoadingSkeleton,
        createAlert,
        createModal,
        createDataTable,
        createStatBadge,
        apiRequest,
        debounce,
        escapeHtml,
        formatDate,
        formatCurrency,
        formatPercent
    };
})();
