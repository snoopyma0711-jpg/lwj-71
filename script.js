const STORAGE_KEY = 'night_market_scheduler_v1';
const NEGOTIATION_SECONDS = 90;
const MAX_EXTENSIONS = 2;
const EXTENSION_SECONDS = 20;
const CRITICAL_THRESHOLD = 20;
const UNDO_WINDOW_SECONDS = 60;

const CATEGORIES = ['小吃', '饮品', '烧烤', '服饰', '饰品', '游戏'];
const ZONES = [
    { code: 'A区-入口', stalls: ['A01', 'A02', 'A03'] },
    { code: 'B区-中间', stalls: ['B01', 'B02', 'B03'] },
    { code: 'C区-角落', stalls: ['C01', 'C02', 'C03'] },
    { code: 'D区-出口', stalls: ['D01', 'D02', 'D03'] }
];

const MERCHANT_TEMPLATES = [
    { name: '张记麻辣烫', category: '小吃', power: '高' },
    { name: '老王烧烤摊', category: '烧烤', power: '高' },
    { name: '小李果汁铺', category: '饮品', power: '中' },
    { name: '潮酷衣舍', category: '服饰', power: '低' },
    { name: '珍珠奶茶站', category: '饮品', power: '中' },
    { name: '铁板鱿鱼王', category: '小吃', power: '中' },
    { name: '闪亮小饰品', category: '饰品', power: '低' },
    { name: '套圈游戏摊', category: '游戏', power: '低' },
    { name: '新疆羊肉串', category: '烧烤', power: '高' },
    { name: '手作甜品屋', category: '饮品', power: '中' },
    { name: '关东煮小哥', category: '小吃', power: '高' },
    { name: '幸运打气球', category: '游戏', power: '中' }
];

let state = null;
let currentNegotiationId = null;
let negotiationTimer = null;
let undoTimer = null;
let timeTickInterval = null;

function generateInitialState() {
    const stalls = [];
    const merchants = [];
    
    let stallIndex = 0;
    ZONES.forEach(zone => {
        zone.stalls.forEach(stallId => {
            const tmpl = MERCHANT_TEMPLATES[stallIndex];
            const merchantId = 'M' + String(stallIndex + 1).padStart(3, '0');
            const merchant = {
                id: merchantId,
                name: tmpl.name,
                category: tmpl.category,
                power: tmpl.power,
                currentStallId: stallId,
                joinDate: new Date(Date.now() - Math.random() * 30 * 24 * 3600 * 1000).toISOString()
            };
            merchants.push(merchant);
            
            const popularity = 2 + Math.floor(Math.random() * 4);
            stallIndex++;
            stalls.push({
                id: stallId,
                zone: zone.code,
                merchantId: merchantId,
                category: tmpl.category,
                power: tmpl.power,
                popularity: popularity,
                status: 'idle',
                note: generateStallNote(tmpl.category, popularity, tmpl.power)
            });
        });
    });

    const now = Date.now();
    
    const applications = [];
    
    const history = [
        {
            id: 'H' + (now - 3600000),
            type: 'swap',
            status: 'success',
            merchantAId: merchants[0].id,
            merchantBId: merchants[3].id,
            stallAFrom: 'A01',
            stallBFrom: 'B02',
            stallATo: 'B02',
            stallBTo: 'A01',
            reason: '张记麻辣烫想换到B区避开入口的油烟堆积，潮酷衣舍想搬到入口招揽人流',
            priority: 2,
            createdAt: now - 7200000,
            completedAt: now - 3600000,
            canUndo: false
        },
        {
            id: 'H' + (now - 1800000),
            type: 'application',
            status: 'rejected',
            applicantId: merchants[5].id,
            targetId: merchants[7].id,
            fromStallId: 'C02',
            toStallId: 'C01',
            reason: '想换到离水源更近的摊位',
            priority: 1,
            createdAt: now - 2400000,
            completedAt: now - 1800000,
            rejectReason: '当前摊主不想换位置'
        },
        {
            id: 'H' + (now - 600000),
            type: 'application',
            status: 'timeout',
            applicantId: merchants[10].id,
            targetId: merchants[2].id,
            fromStallId: 'D03',
            toStallId: 'D01',
            reason: '关东煮需要更大的电力供应，小李果汁铺可以换到D03',
            priority: 2,
            createdAt: now - 1500000,
            completedAt: now - 600000
        }
    ];

    return {
        stalls,
        merchants,
        applications,
        negotiations: [],
        history,
        lastUndoableId: null,
        createdAt: now,
        updatedAt: now
    };
}

function generateStallNote(category, popularity, power) {
    const notes = {
        '小吃': ['汤类需排水', '油炸排烟好', '位置宽敞'],
        '饮品': ['水源方便', '电源稳定', '冷藏设备'],
        '烧烤': ['排烟设备', '独立电源', '防火措施'],
        '服饰': ['试衣空间', '照明充足', '展示面广'],
        '饰品': ['灯光要求高', '玻璃柜台', '防盗设施'],
        '游戏': ['空间开阔', '噪音影响小', '儿童友好']
    };
    const catNotes = notes[category] || ['正常标准'];
    return catNotes[Math.floor(Math.random() * catNotes.length)];
}

function saveState() {
    if (!state) return;
    state.updatedAt = Date.now();
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
        console.error('保存状态失败:', e);
    }
}

function loadState() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            state = JSON.parse(saved);
            repairStateOnLoad();
            return true;
        }
    } catch (e) {
        console.error('加载状态失败:', e);
    }
    return false;
}

function repairStateOnLoad() {
    if (!state) return;
    const now = Date.now();
    
    if (state.negotiations) {
        state.negotiations = state.negotiations.filter(n => {
            if (n.status !== 'active') return true;
            const deadline = (n.startTime || 0) + (n.totalSeconds || NEGOTIATION_SECONDS) * 1000;
            if (now > deadline + 60000) {
                finishNegotiation(n.id, 'timeout');
                return false;
            }
            return true;
        });
    }
    
    if (state.applications) {
        state.applications.forEach(app => {
            if (app.status === 'negotiating') {
                const hasActiveNego = (state.negotiations || []).some(n => 
                    n.applicationId === app.id && n.status === 'active'
                );
                if (!hasActiveNego) {
                    app.status = 'queued';
                }
            }
        });
    }
    
    if (state.stalls) {
        state.stalls.forEach(s => {
            if (s.status !== 'idle') {
                const hasActiveApp = (state.applications || []).some(a =>
                    (a.status === 'queued' || a.status === 'negotiating') &&
                    (a.fromStallId === s.id || a.toStallId === s.id)
                );
                const hasActiveNego = (state.negotiations || []).some(n =>
                    n.status === 'active' &&
                    (n.fromStallId === s.id || n.toStallId === s.id)
                );
                if (!hasActiveApp && !hasActiveNego) {
                    s.status = 'idle';
                }
            }
        });
    }
    
    if (state.lastUndoableId && state.history) {
        const lastRecord = state.history.find(h => h.id === state.lastUndoableId);
        if (lastRecord && lastRecord.canUndo && lastRecord.completedAt) {
            const deadline = lastRecord.completedAt + UNDO_WINDOW_SECONDS * 1000;
            if (now > deadline) {
                lastRecord.canUndo = false;
                state.lastUndoableId = null;
            }
        } else if (lastRecord && !lastRecord.canUndo) {
            state.lastUndoableId = null;
        }
    }
    
    saveState();
}

function resetAllData() {
    showConfirm('确认重置', '确定要重置所有数据吗？将清空所有摊位状态、申请、协商和历史记录。', () => {
        localStorage.removeItem(STORAGE_KEY);
        state = generateInitialState();
        saveState();
        renderAll();
        showToast('数据已重置为初始场景', 'success');
    });
}

function $(id) { return document.getElementById(id); }

function formatTime(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDateTime(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatCountdown(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function getMerchant(id) {
    return state.merchants.find(m => m.id === id);
}

function getStall(id) {
    return state.stalls.find(s => s.id === id);
}

function getStallMerchant(stallId) {
    const stall = getStall(stallId);
    if (!stall) return null;
    return getMerchant(stall.merchantId);
}

function getMerchantStall(merchantId) {
    return state.stalls.find(s => s.merchantId === merchantId);
}

function getPriorityLabel(p) {
    return ['普通', '较急', '紧急'][p - 1] || '普通';
}

function getStars(n) {
    return '★'.repeat(n) + '☆'.repeat(5 - n);
}

function getPowerLabel(p) {
    return p === '高' ? '高功耗' : p === '中' ? '中功耗' : '低功耗';
}

function getPowerClass(p) {
    return p === '高' ? 'power-high' : p === '中' ? 'power-mid' : 'power-low';
}

function getZoneOfStall(stallId) {
    const prefix = stallId.charAt(0);
    return ZONES.find(z => z.code.startsWith(prefix + '区'));
}

function showToast(message, type = 'info', duration = 3000) {
    const container = $('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    toast.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span class="toast-content">${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

function openModal(id) {
    const el = $(id);
    if (el) el.style.display = 'flex';
}

function closeModal(id) {
    const el = $(id);
    if (el) el.style.display = 'none';
}

let confirmCallback = null;
function showConfirm(title, message, callback) {
    $('confirmTitle').textContent = title;
    $('confirmMessage').textContent = message;
    confirmCallback = callback;
    openModal('confirmModal');
}

function initEventListeners() {
    document.querySelectorAll('[data-close]').forEach(btn => {
        btn.addEventListener('click', () => {
            closeModal(btn.dataset.close);
        });
    });

    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay && overlay.id !== 'negotiationModal') {
                overlay.style.display = 'none';
            }
        });
    });

    $('btnConfirmCancel').addEventListener('click', () => {
        confirmCallback = null;
        closeModal('confirmModal');
    });

    $('btnConfirmOk').addEventListener('click', () => {
        if (confirmCallback) confirmCallback();
        confirmCallback = null;
        closeModal('confirmModal');
    });

    $('btnNewApplication').addEventListener('click', openApplicationModal);
    $('btnResetData').addEventListener('click', resetAllData);
    $('btnUndoSwap').addEventListener('click', undoLastSwap);
    $('btnSubmitApplication').addEventListener('click', submitApplication);

    $('appMerchant').addEventListener('change', onAppMerchantChange);
    $('appTargetDirection').addEventListener('change', updateAppTargetStalls);

    $('filterCategory').addEventListener('change', renderStalls);
    $('filterPower').addEventListener('change', renderStalls);
    $('filterPopularity').addEventListener('change', renderStalls);
    $('filterMerchant').addEventListener('change', renderHistory);

    $('btnNegoAccept').addEventListener('click', () => handleNegotiationAction('accept'));
    $('btnNegoReject').addEventListener('click', () => handleNegotiationAction('reject'));
    $('btnNegoWait').addEventListener('click', () => handleNegotiationAction('wait'));
}

function renderAll() {
    renderHeader();
    renderStalls();
    renderQueue();
    renderHistory();
    renderMerchantFilterOptions();
    updateUndoButton();
    updateCurrentTime();
}

function renderHeader() {
    updateCurrentTime();
    if (timeTickInterval) clearInterval(timeTickInterval);
    timeTickInterval = setInterval(updateCurrentTime, 1000);
}

function updateCurrentTime() {
    const now = new Date();
    const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
    $('currentTime').textContent = 
        `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} ${weekday} ${formatTime(now.getTime())}`;
}

function renderStalls() {
    const grid = $('stallsGrid');
    const fCat = $('filterCategory').value;
    const fPower = $('filterPower').value;
    const fPop = parseInt($('filterPopularity').value) || 0;

    let stalls = [...state.stalls];
    if (fCat) stalls = stalls.filter(s => s.category === fCat);
    if (fPower) stalls = stalls.filter(s => s.power === fPower);
    if (fPop) stalls = stalls.filter(s => s.popularity >= fPop);

    if (stalls.length === 0) {
        grid.innerHTML = `
            <div class="empty-state" style="grid-column:1/-1">
                <div class="empty-state-icon">🔍</div>
                <div class="empty-state-text">没有符合筛选条件的摊位</div>
            </div>`;
        return;
    }

    grid.innerHTML = stalls.map(s => {
        const merchant = getMerchant(s.merchantId);
        const statusClass = s.status === 'negotiating' ? 'stall-negotiating' 
            : s.status === 'targeted' ? 'stall-targeted'
            : s.status === 'busy' ? 'stall-busy' : '';
        
        let statusTag = '';
        if (s.status === 'negotiating') statusTag = '<div class="stall-status-tag tag-negotiating">协商中</div>';
        else if (s.status === 'targeted') statusTag = '<div class="stall-status-tag tag-targeted">被申请</div>';

        return `
            <div class="stall-card ${statusClass}" data-stall="${s.id}">
                ${statusTag}
                <div class="stall-header">
                    <div class="stall-number">${s.id}</div>
                    <div class="stall-zone">${s.zone}</div>
                </div>
                <div class="stall-merchant-name" title="${merchant ? merchant.name : '空闲'}">${merchant ? merchant.name : '— 空闲 —'}</div>
                <span class="stall-category cat-${s.category}">${s.category}</span>
                <div class="stall-info-row">
                    <span class="stall-stars">${getStars(s.popularity)}</span>
                    <span class="stall-power ${getPowerClass(s.power)}">
                        <span class="power-dot"></span>${getPowerLabel(s.power)}
                    </span>
                </div>
                <div class="stall-info-row" style="margin-top:6px;color:#94a3b8;font-size:11px">
                    <span>💡 ${s.note}</span>
                </div>
                <div class="stall-actions">
                    <button class="stall-btn btn-history" data-merchant="${merchant ? merchant.id : ''}" onclick="event.stopPropagation(); viewMerchantHistory('${merchant ? merchant.id : ''}')">商户历史</button>
                    <button class="stall-btn" onclick="event.stopPropagation(); quickApplyFromStall('${s.id}')">申请换位</button>
                </div>
            </div>
        `;
    }).join('');
}

function quickApplyFromStall(stallId) {
    const stall = getStall(stallId);
    if (!stall || !stall.merchantId) {
        showToast('该摊位没有商户', 'warning');
        return;
    }
    openApplicationModal(stall.merchantId);
}

function renderQueue() {
    const list = $('queueList');
    const applications = state.applications.filter(a => a.status === 'queued' || a.status === 'negotiating');
    
    $('queueCount').textContent = applications.length;
    
    if (applications.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📋</div>
                <div class="empty-state-text">暂无排队中的换位申请</div>
            </div>`;
        return;
    }

    applications.sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return a.createdAt - b.createdAt;
    });

    list.innerHTML = applications.map(app => {
        const applicant = getMerchant(app.applicantId);
        const fromStall = getStall(app.fromStallId);
        const toStall = getStall(app.toStallId);
        const isNegotiating = app.status === 'negotiating';

        return `
            <div class="queue-item priority-${app.priority}">
                <div class="queue-header">
                    <span class="queue-merchant">${applicant ? applicant.name : '未知商户'}</span>
                    <span class="queue-priority priority-tag-${app.priority}">${getPriorityLabel(app.priority)}</span>
                </div>
                <div class="queue-route">📍 ${fromStall ? fromStall.id : '?'} (${fromStall ? fromStall.zone : ''}) → ${toStall ? toStall.id : '?'} (${toStall ? toStall.zone : ''})</div>
                <div class="queue-reason">${app.reason}</div>
                <div class="queue-meta">
                    <span>申请于 ${formatDateTime(app.createdAt)}</span>
                    <span>${isNegotiating ? '🔵 协商中' : '🟡 等待处理'}</span>
                </div>
                <div class="queue-actions">
                    <button class="queue-btn queue-btn-negotiate" onclick="startNegotiation('${app.id}')">${isNegotiating ? '继续协商' : '开始协商'}</button>
                    <button class="queue-btn queue-btn-cancel" onclick="cancelApplication('${app.id}')">取消申请</button>
                </div>
            </div>
        `;
    }).join('');
}

function renderHistory() {
    const list = $('historyList');
    const fMerchant = $('filterMerchant').value;

    let records = [...state.history];
    if (fMerchant) {
        records = records.filter(h => {
            if (h.type === 'swap') {
                return h.merchantAId === fMerchant || h.merchantBId === fMerchant;
            } else {
                return h.applicantId === fMerchant || h.targetId === fMerchant;
            }
        });
    }

    records.sort((a, b) => (b.completedAt || b.createdAt) - (a.completedAt || a.createdAt));
    
    if (records.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📜</div>
                <div class="empty-state-text">暂无换位历史记录</div>
            </div>`;
        return;
    }

    const statusLabels = {
        success: '换位成功',
        rejected: '已拒绝',
        timeout: '协商超时',
        cancelled: '已取消',
        invalid: '已失效',
        undone: '已撤销'
    };

    list.innerHTML = records.map(h => {
        const status = h.status;
        const time = h.completedAt || h.createdAt;
        let routeText = '';
        let reasonText = h.reason || '';

        if (h.type === 'swap') {
            const mA = getMerchant(h.merchantAId);
            const mB = getMerchant(h.merchantBId);
            routeText = `🔄 ${mA ? mA.name : ''}[${h.stallAFrom}→${h.stallATo}] ⇄ ${mB ? mB.name : ''}[${h.stallBFrom}→${h.stallBTo}]`;
        } else {
            const applicant = getMerchant(h.applicantId);
            const target = getMerchant(h.targetId);
            routeText = `➡️ ${applicant ? applicant.name : ''}[${h.fromStallId}] → ${target ? target.name : ''}[${h.toStallId}]`;
            if (h.rejectReason) {
                reasonText += ` (拒绝原因: ${h.rejectReason})`;
            }
        }

        return `
            <div class="history-item status-${status}">
                <div class="history-header">
                    <span class="history-status">${statusLabels[status] || status}</span>
                    <span class="history-time">${formatDateTime(time)}</span>
                </div>
                <div class="history-route">${routeText}</div>
                <div class="history-reason">${reasonText}</div>
            </div>
        `;
    }).join('');
}

function renderMerchantFilterOptions() {
    const select = $('filterMerchant');
    const currentValue = select.value;
    select.innerHTML = '<option value="">全部商户</option>' +
        state.merchants.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
    select.value = currentValue;
}

function updateUndoButton() {
    const btn = $('btnUndoSwap');
    const record = state.lastUndoableId ? state.history.find(h => h.id === state.lastUndoableId) : null;
    
    if (!record || !record.canUndo) {
        btn.disabled = true;
        btn.textContent = '↩️ 撤销上一笔换位';
        return;
    }

    const remaining = UNDO_WINDOW_SECONDS - Math.floor((Date.now() - record.completedAt) / 1000);
    if (remaining <= 0) {
        record.canUndo = false;
        state.lastUndoableId = null;
        saveState();
        btn.disabled = true;
        btn.textContent = '↩️ 撤销上一笔换位';
        return;
    }

    btn.disabled = false;
    btn.textContent = `↩️ 撤销上一笔 (${formatCountdown(remaining)})`;
}

function openApplicationModal(preselectMerchantId = null) {
    const sel = $('appMerchant');
    
    const blockedMerchants = new Set();
    state.applications.forEach(app => {
        if (app.status === 'queued' || app.status === 'negotiating') {
            blockedMerchants.add(app.applicantId);
        }
    });
    state.negotiations.forEach(n => {
        if (n.status === 'active') {
            blockedMerchants.add(n.applicantId);
            blockedMerchants.add(n.targetId);
        }
    });

    let options = state.merchants
        .filter(m => !blockedMerchants.has(m.id))
        .map(m => `<option value="${m.id}">${m.name} (当前: ${m.currentStallId})</option>`)
        .join('');

    if (!options) {
        options = '<option value="">所有商户都有未结束的申请，请稍后再试</option>';
    }

    sel.innerHTML = options;
    $('appPriority').value = '1';
    $('appTargetDirection').value = '';
    $('appTargetStall').innerHTML = '<option value="">自动推荐同方向空闲/可协商摊位</option>';
    $('appReason').value = '';
    
    if (preselectMerchantId && sel.querySelector(`option[value="${preselectMerchantId}"]`)) {
        sel.value = preselectMerchantId;
    }
    
    onAppMerchantChange();
    openModal('applicationModal');
}

function onAppMerchantChange() {
    const merchantId = $('appMerchant').value;
    const stall = getMerchantStall(merchantId);
    $('appCurrentStall').value = stall ? `${stall.id} (${stall.zone})` : '';
    updateAppTargetStalls();
}

function updateAppTargetStalls() {
    const merchantId = $('appMerchant').value;
    const direction = $('appTargetDirection').value;
    const targetSel = $('appTargetStall');
    const currentStall = getMerchantStall(merchantId);
    
    if (!merchantId || !direction) {
        targetSel.innerHTML = '<option value="">自动推荐同方向空闲/可协商摊位</option>';
        return;
    }

    const blockedStalls = new Set();
    state.applications.forEach(app => {
        if (app.status === 'queued' || app.status === 'negotiating') {
            blockedStalls.add(app.toStallId);
        }
    });
    state.negotiations.forEach(n => {
        if (n.status === 'active') {
            blockedStalls.add(n.fromStallId);
            blockedStalls.add(n.toStallId);
        }
    });
    if (currentStall) blockedStalls.add(currentStall.id);

    const zonePrefix = direction.charAt(0);
    let candidates = state.stalls.filter(s => {
        if (!s.id.startsWith(zonePrefix)) return false;
        if (blockedStalls.has(s.id)) return false;
        return true;
    });

    if (candidates.length === 0) {
        candidates = state.stalls.filter(s => {
            if (blockedStalls.has(s.id)) return false;
            if (currentStall && s.id === currentStall.id) return false;
            return true;
        });
    }

    const hint = candidates.length === 0 
        ? '<option value="">暂无可用摊位，该方向摊位都被锁定</option>'
        : '<option value="">自动推荐同方向空闲/可协商摊位</option>';

    targetSel.innerHTML = hint + candidates.map(s => {
        const merchant = getMerchant(s.merchantId);
        const isSameZone = s.id.startsWith(zonePrefix);
        return `<option value="${s.id}">${s.id} - ${merchant ? merchant.name : '空闲'} (${s.zone})${isSameZone ? ' ✓同区' : ''}</option>`;
    }).join('');
}

function submitApplication() {
    const applicantId = $('appMerchant').value;
    const priority = parseInt($('appPriority').value);
    const direction = $('appTargetDirection').value;
    const targetStallId = $('appTargetStall').value;
    const reason = $('appReason').value.trim();

    if (!applicantId) {
        showToast('请选择发起商户', 'error');
        return;
    }
    if (!direction) {
        showToast('请选择想换去的方向', 'error');
        return;
    }
    if (!reason) {
        showToast('请填写换位原因', 'error');
        return;
    }

    const hasActiveApp = state.applications.some(a =>
        a.applicantId === applicantId && (a.status === 'queued' || a.status === 'negotiating')
    );
    if (hasActiveApp) {
        showToast('该商户已有未结束的申请，不能重复发起', 'error');
        return;
    }

    const fromStall = getMerchantStall(applicantId);
    if (!fromStall) {
        showToast('找不到该商户的摊位', 'error');
        return;
    }

    let toStallId = targetStallId;
    if (!toStallId) {
        const zonePrefix = direction.charAt(0);
        const blocked = new Set();
        state.applications.forEach(a => {
            if (a.status === 'queued' || a.status === 'negotiating') blocked.add(a.toStallId);
        });
        state.negotiations.forEach(n => {
            if (n.status === 'active') {
                blocked.add(n.fromStallId);
                blocked.add(n.toStallId);
            }
        });
        blocked.add(fromStall.id);

        const candidates = state.stalls.filter(s => 
            s.id.startsWith(zonePrefix) && !blocked.has(s.id)
        );
        if (candidates.length > 0) {
            toStallId = candidates[Math.floor(Math.random() * candidates.length)].id;
        } else {
            const allCandidates = state.stalls.filter(s => !blocked.has(s.id) && s.id !== fromStall.id);
            if (allCandidates.length === 0) {
                showToast('所有摊位都被锁定，无法发起申请', 'error');
                return;
            }
            toStallId = allCandidates[Math.floor(Math.random() * allCandidates.length)].id;
        }
    }

    const isTargeted = state.applications.some(a =>
        a.toStallId === toStallId && (a.status === 'queued' || a.status === 'negotiating')
    );
    if (isTargeted) {
        showToast('该摊位已有其他人申请，换一个试试', 'warning');
        return;
    }

    const application = {
        id: 'APP' + Date.now(),
        applicantId,
        targetId: getStall(toStallId).merchantId || null,
        fromStallId: fromStall.id,
        toStallId,
        targetDirection: direction,
        priority,
        reason,
        status: 'queued',
        createdAt: Date.now()
    };

    state.applications.push(application);

    const toStall = getStall(toStallId);
    if (toStall.status === 'idle') toStall.status = 'targeted';
    if (fromStall.status === 'idle') fromStall.status = 'busy';

    saveState();
    closeModal('applicationModal');
    renderAll();
    showToast(`换位申请已提交：${getMerchant(applicantId).name} 申请换至 ${toStallId}`, 'success');
}

function cancelApplication(appId) {
    const app = state.applications.find(a => a.id === appId);
    if (!app) return;
    
    showConfirm('取消申请', `确定要取消这条换位申请吗？`, () => {
        app.status = 'cancelled';
        
        const historyRec = {
            id: 'H' + Date.now(),
            type: 'application',
            status: 'cancelled',
            applicantId: app.applicantId,
            targetId: app.targetId,
            fromStallId: app.fromStallId,
            toStallId: app.toStallId,
            reason: app.reason,
            priority: app.priority,
            createdAt: app.createdAt,
            completedAt: Date.now()
        };
        state.history.push(historyRec);

        const fromStall = getStall(app.fromStallId);
        const toStall = getStall(app.toStallId);
        checkAndResetStallStatus(fromStall, app);
        checkAndResetStallStatus(toStall, app);

        saveState();
        renderAll();
        showToast('申请已取消', 'info');
    });
}

function checkAndResetStallStatus(stall, excludeApp) {
    if (!stall) return;
    const hasOther = state.applications.some(a =>
        a.id !== excludeApp.id &&
        (a.status === 'queued' || a.status === 'negotiating') &&
        (a.fromStallId === stall.id || a.toStallId === stall.id)
    );
    const hasNego = state.negotiations.some(n =>
        n.status === 'active' &&
        (n.fromStallId === stall.id || n.toStallId === stall.id)
    );
    if (!hasOther && !hasNego) stall.status = 'idle';
    else if (hasNego) stall.status = 'negotiating';
    else stall.status = 'targeted';
}

function startNegotiation(appId) {
    const app = state.applications.find(a => a.id === appId);
    if (!app) return;

    if (app.targetId) {
        const targetInOther = state.negotiations.some(n =>
            n.status === 'active' &&
            n.id !== (app.negotiationId || '') &&
            (n.applicantId === app.targetId || n.targetId === app.targetId)
        );
        if (targetInOther) {
            showToast('被申请方正在其他协商中，请稍后再试', 'warning');
            return;
        }
    }

    const appInOtherNego = state.negotiations.some(n =>
        n.status === 'active' &&
        (n.applicantId === app.applicantId)
    );
    if (appInOtherNego) {
        showToast('申请方正在其他协商中，请先处理', 'warning');
        return;
    }

    let nego = state.negotiations.find(n => n.applicationId === appId && n.status === 'active');
    const now = Date.now();

    if (!nego) {
        nego = {
            id: 'NEGO' + now,
            applicationId: appId,
            applicantId: app.applicantId,
            targetId: app.targetId,
            fromStallId: app.fromStallId,
            toStallId: app.toStallId,
            reason: app.reason,
            priority: app.priority,
            status: 'active',
            startTime: now,
            totalSeconds: NEGOTIATION_SECONDS,
            extensionsUsed: 0,
            currentStep: 'waiting_target',
            createdAt: now
        };
        state.negotiations.push(nego);
        app.status = 'negotiating';
        app.negotiationId = nego.id;

        const fromStall = getStall(app.fromStallId);
        const toStall = getStall(app.toStallId);
        if (fromStall) fromStall.status = 'negotiating';
        if (toStall) toStall.status = 'negotiating';
    }

    currentNegotiationId = nego.id;
    saveState();
    renderAll();
    openNegotiationModal(nego);
}

function openNegotiationModal(nego) {
    const applicant = getMerchant(nego.applicantId);
    const target = nego.targetId ? getMerchant(nego.targetId) : null;
    const fromStall = getStall(nego.fromStallId);
    const toStall = getStall(nego.toStallId);

    $('negoStallAName').textContent = fromStall ? fromStall.id : '?';
    $('negoMerchantA').textContent = applicant ? applicant.name : '?';
    $('negoPopA').textContent = fromStall ? getStars(fromStall.popularity) : '';
    $('negoCatA').textContent = fromStall ? fromStall.category : '';

    $('negoStallBName').textContent = toStall ? toStall.id : '?';
    $('negoMerchantB').textContent = target ? target.name : '(空闲摊位)';
    $('negoPopB').textContent = toStall ? getStars(toStall.popularity) : '';
    $('negoCatB').textContent = toStall ? toStall.category : '';

    $('negoApplicant').textContent = applicant ? applicant.name : '';
    $('negoTarget').textContent = target ? target.name : '(空闲摊位，无需对方同意)';
    $('negoPriority').textContent = getPriorityLabel(nego.priority);
    $('negoReason').textContent = nego.reason;
    $('negoApplyTime').textContent = formatDateTime(nego.createdAt);

    if (!target) {
        $('negoActionHint').textContent = '目标是空闲摊位，运营人员可直接确认换位';
        $('btnNegoReject').style.display = 'none';
        $('btnNegoWait').style.display = 'none';
        $('btnNegoAccept').textContent = '✅ 确认换位（空闲摊位）';
    } else {
        $('negoActionHint').textContent = '请作为运营人员模拟当前摊主的决策';
        $('btnNegoReject').style.display = '';
        $('btnNegoWait').style.display = '';
        $('btnNegoAccept').textContent = '✅ 同意换位';
    }

    updateNegotiationTimer();
    if (negotiationTimer) clearInterval(negotiationTimer);
    negotiationTimer = setInterval(updateNegotiationTimer, 1000);

    openModal('negotiationModal');
}

function updateNegotiationTimer() {
    if (!currentNegotiationId) {
        if (negotiationTimer) {
            clearInterval(negotiationTimer);
            negotiationTimer = null;
        }
        return;
    }

    const nego = state.negotiations.find(n => n.id === currentNegotiationId);
    if (!nego || nego.status !== 'active') {
        if (negotiationTimer) {
            clearInterval(negotiationTimer);
            negotiationTimer = null;
        }
        return;
    }

    const now = Date.now();
    const deadline = nego.startTime + nego.totalSeconds * 1000;
    const remainingSec = Math.max(0, Math.ceil((deadline - now) / 1000));
    const progress = (remainingSec / nego.totalSeconds) * 100;

    $('negoTimer').textContent = formatCountdown(remainingSec);
    $('negoProgressBar').style.width = `${progress}%`;

    const timerBar = document.querySelector('.negotiation-timer-bar');
    if (remainingSec <= CRITICAL_THRESHOLD) {
        timerBar.classList.add('timer-critical');
    } else {
        timerBar.classList.remove('timer-critical');
    }

    const extBadge = $('negoExtensionBadge');
    if (nego.extensionsUsed === 0) {
        extBadge.textContent = '原始窗口';
        extBadge.classList.remove('extended');
    } else {
        extBadge.textContent = `已延长${nego.extensionsUsed}次`;
        extBadge.classList.add('extended');
    }

    const stepLabels = {
        'waiting_target': '等待对方回应',
        'target_considered': '对方考虑中',
        'applicant_confirm': '等待申请方确认'
    };
    $('negoStepBadge').textContent = stepLabels[nego.currentStep] || '协商进行中';

    if (remainingSec <= 0) {
        finishNegotiation(nego.id, 'timeout');
    }
}

function handleNegotiationAction(action) {
    if (!currentNegotiationId) return;
    const nego = state.negotiations.find(n => n.id === currentNegotiationId);
    if (!nego || nego.status !== 'active') return;

    const now = Date.now();
    const deadline = nego.startTime + nego.totalSeconds * 1000;
    const remainingSec = Math.ceil((deadline - now) / 1000);
    const isCriticalPeriod = remainingSec <= CRITICAL_THRESHOLD && remainingSec > 0;

    if (action === 'wait') {
        if (isCriticalPeriod && nego.extensionsUsed < MAX_EXTENSIONS) {
            nego.totalSeconds += EXTENSION_SECONDS;
            nego.extensionsUsed++;
            nego.currentStep = 'target_considered';
            saveState();
            showToast(`最后时刻操作！窗口自动延长 ${EXTENSION_SECONDS} 秒（${nego.extensionsUsed}/${MAX_EXTENSIONS}）`, 'warning');
        } else if (isCriticalPeriod && nego.extensionsUsed >= MAX_EXTENSIONS) {
            showToast(`已达最大延长次数（${MAX_EXTENSIONS}次），窗口不再延长`, 'warning');
            nego.currentStep = 'target_considered';
            saveState();
        } else {
            nego.currentStep = 'target_considered';
            saveState();
            showToast('已标记为暂时不处理', 'info');
        }
        updateNegotiationTimer();
        return;
    }

    if (action === 'accept') {
        if (isCriticalPeriod && nego.extensionsUsed < MAX_EXTENSIONS) {
            nego.totalSeconds += EXTENSION_SECONDS;
            nego.extensionsUsed++;
            saveState();
            showToast(`最后时刻同意！窗口延长 ${EXTENSION_SECONDS} 秒做最终确认（${nego.extensionsUsed}/${MAX_EXTENSIONS}）`, 'success');
            nego.currentStep = 'applicant_confirm';
            updateNegotiationTimer();
            if (nego.targetId) {
                $('negoActionHint').textContent = '被申请方已同意，请申请方点击确认完成换位';
                $('btnNegoAccept').textContent = '✅ 最终确认换位';
            }
            return;
        }
        completeSwapFromNegotiation(nego);
        return;
    }

    if (action === 'reject') {
        if (isCriticalPeriod && nego.extensionsUsed < MAX_EXTENSIONS) {
            nego.totalSeconds += EXTENSION_SECONDS;
            nego.extensionsUsed++;
            saveState();
            showToast(`最后时刻操作！窗口延长 ${EXTENSION_SECONDS} 秒（${nego.extensionsUsed}/${MAX_EXTENSIONS}）`, 'warning');
        }
        finishNegotiation(nego.id, 'rejected', '被申请方拒绝了换位请求');
    }
}

function completeSwapFromNegotiation(nego) {
    const app = state.applications.find(a => a.id === nego.applicationId);
    const merchantA = getMerchant(nego.applicantId);
    const merchantB = nego.targetId ? getMerchant(nego.targetId) : null;
    const stallA = getStall(nego.fromStallId);
    const stallB = getStall(nego.toStallId);
    const now = Date.now();

    if (merchantA && stallB) {
        merchantA.currentStallId = stallB.id;
        stallB.merchantId = merchantA.id;
        stallB.category = merchantA.category;
        stallB.power = merchantA.power;
    }

    if (merchantB && stallA) {
        merchantB.currentStallId = stallA.id;
        stallA.merchantId = merchantB.id;
        stallA.category = merchantB.category;
        stallA.power = merchantB.power;
    } else if (stallA && !merchantB) {
        stallA.merchantId = null;
        stallA.category = stallA.category || '';
    }

    if (stallA) stallA.status = 'idle';
    if (stallB) stallB.status = 'idle';

    if (app) {
        app.status = 'completed';
    }
    nego.status = 'completed';

    state.stalls.forEach(s => checkAndResetStallStatus(s, app || {}));

    const historyRec = {
        id: 'H' + now,
        type: 'swap',
        status: 'success',
        merchantAId: nego.applicantId,
        merchantBId: nego.targetId,
        stallAFrom: nego.fromStallId,
        stallBFrom: nego.toStallId,
        stallATo: nego.toStallId,
        stallBTo: nego.fromStallId,
        reason: nego.reason,
        priority: nego.priority,
        createdAt: nego.createdAt,
        completedAt: now,
        canUndo: true
    };
    state.history.push(historyRec);
    state.lastUndoableId = historyRec.id;

    saveState();
    if (negotiationTimer) {
        clearInterval(negotiationTimer);
        negotiationTimer = null;
    }
    currentNegotiationId = null;
    closeModal('negotiationModal');
    renderAll();
    showToast(`🎉 换位成功！${merchantA ? merchantA.name : ''} ⇄ ${merchantB ? merchantB.name : '空闲'}`, 'success');
}

function finishNegotiation(negoId, result, extraReason = '') {
    const nego = state.negotiations.find(n => n.id === negoId);
    if (!nego || nego.status !== 'active') return;

    const app = state.applications.find(a => a.id === nego.applicationId);
    const now = Date.now();
    nego.status = result;
    if (app) app.status = result;

    let historyStatus = result;
    let rejectReason = extraReason;

    if (result === 'timeout') {
        rejectReason = '协商窗口超时未处理';
        
        const stallA = getStall(nego.fromStallId);
        const stallB = getStall(nego.toStallId);
        const applicant = getMerchant(nego.applicantId);
        const target = nego.targetId ? getMerchant(nego.targetId) : null;
        
        const invalid = 
            (stallA && stallA.merchantId !== nego.applicantId) ||
            (stallB && nego.targetId && stallB.merchantId !== nego.targetId);
        
        if (invalid) {
            historyStatus = 'invalid';
            rejectReason = '摊位状态在协商期间发生变化，申请失效';
        }
    }

    const historyRec = {
        id: 'H' + now,
        type: 'application',
        status: historyStatus,
        applicantId: nego.applicantId,
        targetId: nego.targetId,
        fromStallId: nego.fromStallId,
        toStallId: nego.toStallId,
        reason: nego.reason,
        priority: nego.priority,
        createdAt: nego.createdAt,
        completedAt: now,
        rejectReason
    };
    state.history.push(historyRec);

    const stallA = getStall(nego.fromStallId);
    const stallB = getStall(nego.toStallId);
    if (stallA) checkAndResetStallStatus(stallA, app || {});
    if (stallB) checkAndResetStallStatus(stallB, app || {});
    state.stalls.forEach(s => {
        const hasActive = state.applications.some(a =>
            a.id !== (app ? app.id : '') &&
            (a.status === 'queued' || a.status === 'negotiating') &&
            (a.fromStallId === s.id || a.toStallId === s.id)
        );
        const hasNego = state.negotiations.some(n =>
            n.status === 'active' &&
            n.id !== nego.id &&
            (n.fromStallId === s.id || n.toStallId === s.id)
        );
        if (!hasActive && !hasNego && s.status !== 'idle') s.status = 'idle';
    });

    saveState();

    if (negotiationTimer) {
        clearInterval(negotiationTimer);
        negotiationTimer = null;
    }
    if (currentNegotiationId === negoId) {
        currentNegotiationId = null;
        closeModal('negotiationModal');
    }

    renderAll();
    const msg = result === 'timeout' ? '协商超时，申请已关闭' 
        : result === 'rejected' ? '申请被拒绝' 
        : result === 'invalid' ? '摊位变化，申请失效' : '协商结束';
    showToast(msg, result === 'timeout' ? 'warning' : result === 'rejected' ? 'error' : 'info');
}

function undoLastSwap() {
    if (!state.lastUndoableId) {
        showToast('没有可撤销的换位记录', 'warning');
        return;
    }

    const record = state.history.find(h => h.id === state.lastUndoableId);
    if (!record || !record.canUndo) {
        showToast('该记录已超过撤销时间', 'warning');
        state.lastUndoableId = null;
        saveState();
        renderAll();
        return;
    }

    const elapsed = (Date.now() - record.completedAt) / 1000;
    if (elapsed > UNDO_WINDOW_SECONDS) {
        record.canUndo = false;
        state.lastUndoableId = null;
        saveState();
        renderAll();
        showToast('撤销窗口已关闭', 'warning');
        return;
    }

    const merchantA = getMerchant(record.merchantAId);
    const merchantB = record.merchantBId ? getMerchant(record.merchantBId) : null;
    const stallA = getStall(record.stallATo);
    const stallB = getStall(record.stallBTo);

    showConfirm('撤销换位', 
        `确定要撤销这次换位吗？\n` +
        `${merchantA ? merchantA.name : ''} 将从 ${record.stallATo} 回到 ${record.stallAFrom}\n` +
        `${merchantB ? merchantB.name : '空闲'} 将从 ${record.stallBTo} 回到 ${record.stallBFrom}\n\n` +
        `剩余撤销时间：${formatCountdown(UNDO_WINDOW_SECONDS - Math.floor(elapsed))}`,
        () => {
            if (merchantA && stallA) {
                merchantA.currentStallId = record.stallAFrom;
                stallA.merchantId = record.merchantBId || null;
                if (merchantA) {
                    stallA.category = merchantB ? merchantB.category : stallA.category;
                    stallA.power = merchantB ? merchantB.power : stallA.power;
                }
            }

            const origStallA = getStall(record.stallAFrom);
            if (origStallA) {
                origStallA.merchantId = record.merchantAId;
                origStallA.category = merchantA ? merchantA.category : origStallA.category;
                origStallA.power = merchantA ? merchantA.power : origStallA.power;
                origStallA.status = 'idle';
            }

            if (merchantB && stallB) {
                merchantB.currentStallId = record.stallBFrom;
            }
            const origStallB = getStall(record.stallBFrom);
            if (!merchantB && origStallB) {
                origStallB.merchantId = null;
            }
            if (stallA) stallA.status = 'idle';
            if (stallB) stallB.status = 'idle';

            record.canUndo = false;
            record.status = 'undone';
            state.lastUndoableId = null;

            const undoRec = {
                id: 'H' + Date.now(),
                type: 'swap',
                status: 'undone',
                merchantAId: record.merchantAId,
                merchantBId: record.merchantBId,
                stallAFrom: record.stallATo,
                stallBFrom: record.stallBTo,
                stallATo: record.stallAFrom,
                stallBTo: record.stallBFrom,
                reason: `撤销操作（原记录 ${record.id}）：${record.reason}`,
                priority: record.priority,
                createdAt: record.completedAt,
                completedAt: Date.now(),
                canUndo: false
            };
            state.history.push(undoRec);

            saveState();
            renderAll();
            showToast('↩️ 已撤销上一笔换位，摊位已恢复', 'success');
        }
    );
}

function viewMerchantHistory(merchantId) {
    if (!merchantId) {
        showToast('该摊位没有商户', 'warning');
        return;
    }
    const merchant = getMerchant(merchantId);
    if (!merchant) return;

    const stall = getMerchantStall(merchantId);
    const swapCount = state.history.filter(h => {
        if (h.status !== 'success' && h.status !== 'undone') return false;
        return h.type === 'swap' && (h.merchantAId === merchantId || h.merchantBId === merchantId);
    }).length;
    const appCount = state.history.filter(h => {
        if (h.type !== 'application') return false;
        return h.applicantId === merchantId || h.targetId === merchantId;
    }).length;

    $('merchantHistoryTitle').textContent = `📊 ${merchant.name} - 换位历史`;
    $('merchantProfile').innerHTML = `
        <div class="profile-name">${merchant.name}</div>
        <div class="profile-info">
            <div class="profile-info-item">
                <span class="profile-info-label">经营品类</span>
                <span>${merchant.category}</span>
            </div>
            <div class="profile-info-item">
                <span class="profile-info-label">当前摊位</span>
                <span>${stall ? stall.id + ' (' + stall.zone + ')' : '无'}</span>
            </div>
            <div class="profile-info-item">
                <span class="profile-info-label">用电需求</span>
                <span>${getPowerLabel(merchant.power)}</span>
            </div>
            <div class="profile-info-item">
                <span class="profile-info-label">入驻时间</span>
                <span>${formatDateTime(merchant.joinDate)}</span>
            </div>
            <div class="profile-info-item">
                <span class="profile-info-label">成功换位</span>
                <span>${swapCount} 次</span>
            </div>
            <div class="profile-info-item">
                <span class="profile-info-label">参与申请</span>
                <span>${appCount} 次</span>
            </div>
        </div>
    `;

    let records = state.history.filter(h => {
        if (h.type === 'swap') {
            return h.merchantAId === merchantId || h.merchantBId === merchantId;
        } else {
            return h.applicantId === merchantId || h.targetId === merchantId;
        }
    }).sort((a, b) => (b.completedAt || b.createdAt) - (a.completedAt || a.createdAt));

    const statusLabels = {
        success: '换位成功',
        rejected: '已拒绝',
        timeout: '协商超时',
        cancelled: '已取消',
        invalid: '已失效',
        undone: '已撤销'
    };

    if (records.length === 0) {
        $('merchantHistoryList').innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📜</div>
                <div class="empty-state-text">该商户暂无换位记录</div>
            </div>`;
    } else {
        $('merchantHistoryList').innerHTML = records.map(h => {
            const status = h.status;
            const time = h.completedAt || h.createdAt;
            let routeText = '';
            let roleBadge = '';

            if (h.type === 'swap') {
                const isA = h.merchantAId === merchantId;
                roleBadge = isA ? '【申请方】' : '【被申请方】';
                routeText = `${isA ? h.stallAFrom : h.stallBFrom} → ${isA ? h.stallATo : h.stallBTo}`;
            } else {
                const isApplicant = h.applicantId === merchantId;
                roleBadge = isApplicant ? '【申请方】' : '【被申请方】';
                routeText = `${isApplicant ? h.fromStallId + ' → ' + h.toStallId : h.toStallId + ' ← ' + h.fromStallId}`;
            }

            return `
                <div class="history-item status-${status}">
                    <div class="history-header">
                        <span class="history-status">${roleBadge} ${statusLabels[status] || status}</span>
                        <span class="history-time">${formatDateTime(time)}</span>
                    </div>
                    <div class="history-route">📍 ${routeText}</div>
                    <div class="history-reason">${h.reason}${h.rejectReason ? ' (' + h.rejectReason + ')' : ''}</div>
                </div>
            `;
        }).join('');
    }

    openModal('merchantHistoryModal');
}

function startUndoTimerTicker() {
    if (undoTimer) clearInterval(undoTimer);
    undoTimer = setInterval(() => {
        updateUndoButton();
    }, 1000);
}

function init() {
    if (!loadState()) {
        state = generateInitialState();
        saveState();
    }
    initEventListeners();
    renderAll();
    startUndoTimerTicker();
    showToast('夜市摊位换位调度台已就绪！', 'success', 2500);
}

document.addEventListener('DOMContentLoaded', init);
