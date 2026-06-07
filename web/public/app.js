// ── State ─────────────────────────────────────────────────────
const state = {
  vacancies:   [],
  stats:       {},
  selected:    null,
  detail:      null,
  detailTab:   'analysis',
  filters:     { status: 'all', score: 0, source: 'all' },
  search:      '',
  sort:        { field: 'score', dir: -1 },
  loading:     true,
};

// ── API ───────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const b = await res.json(); msg = b.error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

// ── Init ──────────────────────────────────────────────────────
async function init() {
  await Promise.all([loadVacancies(), loadStats()]);
  setupListeners();
  focusSearch();
  checkLlmStatus();   // non-blocking
  loadFollowups();    // non-blocking
}

async function checkLlmStatus() {
  try {
    const s = await api('/api/llm-status');
    const banner = qs('#llm-warning-banner');
    if (!s.ok && banner) {
      qs('#llm-warning-text').textContent =
        `ИИ не настроен (${s.message || s.provider}) — оценка вакансий недоступна.`;
      banner.classList.remove('hidden');
    }
  } catch {}
}

// ── Liveness check ────────────────────────────────────────────
async function checkLiveness(btn) {
  const url = btn.dataset.url;
  if (!url) return;
  btn.disabled = true;
  btn.textContent = '⏳ Проверяю…';
  try {
    const d = await api(`/api/liveness?url=${encodeURIComponent(url)}`);
    const icons  = { active: '✅', expired: '❌', uncertain: '⚠️' };
    const labels = { active: 'Активна', expired: 'Закрыта', uncertain: 'Неизвестно' };
    btn.textContent = `${icons[d.result] || '⚠️'} ${labels[d.result] || d.result}`;
    btn.title = d.reason || '';
    btn.classList.toggle('liveness-active',   d.result === 'active');
    btn.classList.toggle('liveness-expired',  d.result === 'expired');
    btn.classList.toggle('liveness-uncertain', d.result === 'uncertain');
  } catch {
    btn.textContent = '⚠️ Ошибка';
  }
}

// ── Follow-up ─────────────────────────────────────────────────
let _followupData = null;

async function loadFollowups() {
  try {
    _followupData = await api('/api/followups');
    renderFollowupBadge();
  } catch {}
}

function renderFollowupBadge() {
  if (!_followupData?.metadata) return;
  const { overdue, urgent, waiting, cold } = _followupData.metadata;
  const actionable = _followupData.entries?.length ?? 0;
  const numEl   = qs('#s-followup');
  const badgeEl = qs('#s-followup-badge');
  if (!numEl) return;
  numEl.textContent = actionable || '—';
  const hot = (overdue || 0) + (urgent || 0);
  if (hot > 0) {
    numEl.style.color = 'var(--red)';
    badgeEl?.classList.remove('hidden');
  } else if (waiting > 0) {
    numEl.style.color = 'var(--orange)';
  }
}

function openFollowupModal() {
  if (!_followupData) {
    api('/api/followups?force=1').then(d => { _followupData = d; renderFollowupModal(); }).catch(() => {});
  } else {
    renderFollowupModal();
  }
  openModal('followup');
}

const URGENCY_RU = { urgent: 'Срочно', overdue: 'Просрочено', waiting: 'Ждём', cold: 'Холодно' };
const URGENCY_COLOR = { urgent: 'var(--red)', overdue: 'var(--orange)', waiting: 'var(--text-2)', cold: 'var(--text-3)' };
const STATUS_FU_RU = { applied: 'Откликнулся', responded: 'Ответили', interview: 'Интервью' };

function renderFollowupModal() {
  const data = _followupData;
  const sumEl  = qs('#followup-summary');
  const listEl = qs('#followup-list');
  if (!sumEl || !listEl) return;

  if (!data || data.error) {
    sumEl.innerHTML = '';
    listEl.innerHTML = `<div class="fu-empty">Нет данных — добавь отклики в трекер.</div>`;
    return;
  }

  const { metadata, entries } = data;
  const chips = [
    metadata.urgent   > 0 ? `<span class="fu-chip fu-chip-red">${metadata.urgent} срочно</span>`    : '',
    metadata.overdue  > 0 ? `<span class="fu-chip fu-chip-orange">${metadata.overdue} просрочено</span>` : '',
    metadata.waiting  > 0 ? `<span class="fu-chip fu-chip-muted">${metadata.waiting} ждут</span>`   : '',
    metadata.cold     > 0 ? `<span class="fu-chip fu-chip-cold">${metadata.cold} холодно</span>`    : '',
  ].filter(Boolean).join('');

  sumEl.innerHTML = chips
    ? `<div class="fu-chips">${chips}</div>`
    : `<div class="fu-chips"><span class="fu-chip fu-chip-muted">Нет активных откликов</span></div>`;

  if (!entries?.length) {
    listEl.innerHTML = `<div class="fu-empty">Нет откликов для отслеживания.</div>`;
    return;
  }

  listEl.innerHTML = entries.map(e => {
    const color  = URGENCY_COLOR[e.urgency] || 'var(--text-2)';
    const label  = URGENCY_RU[e.urgency]    || e.urgency;
    const stRu   = STATUS_FU_RU[e.status]   || e.status;
    const next   = e.nextFollowupDate
      ? (e.daysUntilNext < 0
          ? `<span style="color:var(--red)">просрочено ${Math.abs(e.daysUntilNext)} д.</span>`
          : e.daysUntilNext === 0
            ? `<span style="color:var(--orange)">сегодня</span>`
            : `через ${e.daysUntilNext} д.`)
      : `<span style="color:var(--text-3)">—</span>`;
    return `
      <div class="fu-row">
        <div class="fu-row-main">
          <span class="fu-company">${esc(e.company)}</span>
          <span class="fu-role">${esc(e.role)}</span>
        </div>
        <div class="fu-row-meta">
          <span class="fu-status-badge">${stRu}</span>
          <span class="fu-days">${e.daysSinceApplication} дн.</span>
          <span class="fu-next">${next}</span>
          <span class="fu-urgency" style="color:${color}">${label}</span>
        </div>
      </div>`;
  }).join('');
}

// ── Analytics ─────────────────────────────────────────────────
let _analyticsData = null;

async function openAnalyticsModal() {
  openModal('analytics');
  const body = qs('#analytics-body');
  if (!_analyticsData) {
    body.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';
    try {
      const d = await api('/api/analytics');
      if (!d.error) _analyticsData = d;
      renderAnalyticsModal(d);
      return;
    } catch (e) {
      body.innerHTML = `<div class="an-empty">Ошибка загрузки: ${esc(e.message)}</div>`;
      return;
    }
  }
  renderAnalyticsModal(_analyticsData);
}

const IMPACT_COLOR = { high: 'var(--green)', medium: 'var(--orange)', low: 'var(--text-2)' };
const IMPACT_RU    = { high: 'Высокий', medium: 'Средний', low: 'Низкий' };

function barW(val, max) {
  return max > 0 ? Math.round((val / max) * 100) : 0;
}

function renderAnalyticsModal(data) {
  const body = qs('#analytics-body');
  if (!body) return;

  if (data?.error) {
    body.innerHTML = `<div class="an-empty">📊 Недостаточно данных.<br><span class="hint">${esc(data.error)}</span><br><span class="hint" style="margin-top:8px;display:block">Добавь отклики со статусом Applied / Responded / Interview и попробуй снова.</span></div>`;
    return;
  }

  const { metadata, funnel, scoreComparison, blockerAnalysis, recommendations, scoreThreshold } = data;

  // ── Metadata summary ──
  const total   = metadata?.total ?? '?';
  const drRange = metadata?.dateRange
    ? `${metadata.dateRange.earliest ?? ''} – ${metadata.dateRange.latest ?? ''}`.trim()
    : '';
  const byOut   = metadata?.byOutcome ?? {};

  // ── Funnel ──
  const funnelSteps = [
    { key: 'evaluated', label: 'Оценено' },
    { key: 'applied',   label: 'Откликнулся' },
    { key: 'responded', label: 'Ответили' },
    { key: 'interview', label: 'Интервью' },
    { key: 'offer',     label: 'Офер' },
  ];
  const funnelMax = Math.max(...funnelSteps.map(s => funnel?.[s.key] ?? 0), 1);

  const funnelHtml = funnelSteps.map(s => {
    const v = funnel?.[s.key] ?? 0;
    const w = barW(v, funnelMax);
    return `
      <div class="an-bar-row">
        <span class="an-bar-label">${s.label}</span>
        <div class="an-bar-track"><div class="an-bar-fill" style="width:${w}%"></div></div>
        <span class="an-bar-val">${v}</span>
      </div>`;
  }).join('');

  // ── Score comparison ──
  const SC_KEYS   = ['positive', 'negative', 'pending'];
  const SC_LABELS = { positive: 'Позитив', negative: 'Отказ', pending: 'В процессе' };
  const SC_COLORS = { positive: 'var(--green)', negative: 'var(--red)', pending: 'var(--blue)' };

  const scoreCards = SC_KEYS
    .map(k => {
      const s = scoreComparison?.[k];
      if (!s?.count) return '';
      return `
        <div class="an-score-card">
          <span class="an-score-num" style="color:${SC_COLORS[k]}">${(+s.avg).toFixed(1)}</span>
          <span class="an-score-label">${SC_LABELS[k]}</span>
          <span class="an-score-sub">${s.count} откл.</span>
        </div>`;
    }).join('');

  // ── Blockers ──
  const topBlockers = (blockerAnalysis ?? []).slice(0, 5);
  const maxBFreq    = Math.max(...topBlockers.map(b => b.frequency), 1);
  const blockersHtml = topBlockers.length
    ? topBlockers.map(b => `
        <div class="an-bar-row">
          <span class="an-bar-label">${esc(b.blocker)}</span>
          <div class="an-bar-track"><div class="an-bar-fill an-bar-fill-red" style="width:${barW(b.frequency, maxBFreq)}%"></div></div>
          <span class="an-bar-val">${b.frequency}×</span>
        </div>`).join('')
    : '<span class="hint">Нет данных о блокерах</span>';

  // ── Recommendations ──
  const recs = (recommendations ?? []).slice(0, 4);
  const recsHtml = recs.length
    ? recs.map(r => `
        <div class="an-rec-row">
          <div class="an-rec-impact an-impact-${r.impact || 'low'}">${IMPACT_RU[r.impact] ?? r.impact}</div>
          <div class="an-rec-content">
            <div class="an-rec-action">${esc(r.action)}</div>
            <div class="an-rec-reason hint">${esc(r.reasoning)}</div>
          </div>
        </div>`).join('')
    : '<span class="hint">Недостаточно данных для рекомендаций</span>';

  // ── Score threshold hint ──
  const threshHtml = scoreThreshold?.recommended
    ? `<div class="an-threshold">Рекомендуемый порог оценки: <strong>${scoreThreshold.recommended}/5</strong> — ${esc(scoreThreshold.reasoning ?? '')}</div>`
    : '';

  body.innerHTML = `
    <div class="an-meta">
      <span>Всего откликов: <strong>${total}</strong></span>
      ${drRange ? `<span class="hint">· ${drRange}</span>` : ''}
      ${byOut.positive ? `<span class="an-meta-chip an-chip-green">✅ ${byOut.positive} позитив</span>` : ''}
      ${byOut.negative ? `<span class="an-meta-chip an-chip-red">❌ ${byOut.negative} отказ</span>` : ''}
    </div>

    <div class="an-grid">
      <div class="an-section">
        <div class="an-section-title">Воронка</div>
        ${funnelHtml}
      </div>

      <div class="an-section">
        <div class="an-section-title">Средний балл по исходу</div>
        <div class="an-score-cards">${scoreCards || '<span class="hint">Нет данных</span>'}</div>
        ${threshHtml}
      </div>
    </div>

    <div class="an-section" style="margin-top:12px">
      <div class="an-section-title">Топ блокеры</div>
      ${blockersHtml}
    </div>

    <div class="an-section" style="margin-top:12px">
      <div class="an-section-title">Рекомендации</div>
      ${recsHtml}
    </div>
  `;
}

async function loadVacancies() {
  state.loading = true;
  renderList();
  try {
    const params = new URLSearchParams();
    if (state.search)                   params.set('q', state.search);
    if (state.filters.status !== 'all') params.set('status', state.filters.status);
    if (state.filters.source !== 'all') params.set('source', state.filters.source);
    if (state.filters.score > 0)        params.set('score_min', state.filters.score);
    state.vacancies = await api(`/api/vacancies?${params}`);
    sortVacancies();
  } catch (e) {
    showError(e.message);
  } finally {
    state.loading = false;
    renderList();
  }
}

async function loadStats() {
  try {
    state.stats = await api('/api/stats');
    renderStats();
  } catch {}
}

async function loadDetail(id) {
  if (state.selected === id && state.detail) return renderDetail();
  state.selected = id;
  state.detail   = null;
  renderDetail(); // show skeleton
  try {
    state.detail = await api(`/api/vacancies/${id}`);
  } catch (e) {
    state.detail = { error: e.message };
  }
  renderDetail();
}

// ── Sort ──────────────────────────────────────────────────────
function sortVacancies() {
  const { field, dir } = state.sort;
  state.vacancies.sort((a, b) => {
    // pending always last
    if (a.status === 'pending' && b.status !== 'pending') return 1;
    if (b.status === 'pending' && a.status !== 'pending') return -1;
    if (field === 'score') {
      const sa = a.score ?? -1, sb = b.score ?? -1;
      return dir * (sb - sa);
    }
    if (field === 'company') {
      return dir * a.company.localeCompare(b.company, 'ru');
    }
    if (field === 'date') {
      return dir * (a.date > b.date ? 1 : a.date < b.date ? -1 : 0);
    }
    return 0;
  });
}

// ── Render: Stats ─────────────────────────────────────────────
function renderStats() {
  const s = state.stats;
  setText('s-total',     s.total     ?? '—');
  setText('s-pending',   s.pending   ?? '—');
  setText('s-evaluated', s.evaluated ?? '—');
  setText('s-priority',  s.highPriority ?? '—');
  setText('s-applied',   s.applied   ?? '—');
  setText('s-interview', s.interview ?? '—');

  // Queue badge on scan button + "Evaluate all" button visibility
  const queueBadge = qs('#queue-badge');
  const evalAllBtn = qs('#btn-eval-all');
  const evalAllBadge = qs('#eval-all-badge');
  const n = s.pending ?? 0;
  if (queueBadge) { queueBadge.textContent = n; queueBadge.classList.toggle('hidden', n === 0); }
  if (evalAllBtn) {
    evalAllBtn.classList.toggle('hidden', n === 0);
    if (evalAllBadge) evalAllBadge.textContent = n;
  }
}

// ── Render: List ──────────────────────────────────────────────
function renderList() {
  const el = qs('#vacancies-list');

  if (state.loading) {
    el.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Загрузка…</p></div>`;
    return;
  }
  if (!state.vacancies.length) {
    const hasFilters = state.filters.status !== 'all' || state.filters.score > 0
      || state.filters.source !== 'all' || state.search;
    if (hasFilters) {
      el.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">🔍</span>
          <p>Ничего не найдено по фильтрам</p>
          <button class="btn btn-ghost btn-sm" id="btn-reset-filters">✕ Сбросить фильтры</button>
        </div>`;
      qs('#btn-reset-filters').addEventListener('click', resetFilters);
    } else {
      el.innerHTML = `
        <div class="onboarding-state">
          <div class="onboarding-title">👋 Привет! Вот как начать:</div>
          <div class="onboarding-steps">
            <div class="onboarding-step">
              <div class="step-num">1</div>
              <div class="step-body">
                <div class="step-title">Найди вакансии</div>
                <div class="step-desc">Нажми кнопку ниже, введи желаемую должность — ИИ автоматически подберёт ключевые слова</div>
                <button class="btn btn-primary" id="btn-empty-scan">🔍 Найти вакансии</button>
              </div>
            </div>
            <div class="onboarding-step">
              <div class="step-num">2</div>
              <div class="step-body">
                <div class="step-title">Оцени с ИИ</div>
                <div class="step-desc">Нажми на вакансию → «Оценить» — ИИ разберёт требования и поставит оценку от 1 до 5</div>
              </div>
            </div>
            <div class="onboarding-step">
              <div class="step-num">3</div>
              <div class="step-body">
                <div class="step-title">Откликнись на лучшие</div>
                <div class="step-desc">Вакансии с оценкой ≥ 4.0 — твои приоритеты. Остальные можно пропустить</div>
              </div>
            </div>
          </div>
          <p class="hint" style="margin-top:16px;font-size:11px">Также можно добавить конкретную вакансию по ссылке — кнопка «➕ Добавить» вверху</p>
        </div>`;
      qs('#btn-empty-scan').addEventListener('click', openScanModal);
    }
    return;
  }

  el.innerHTML = state.vacancies.map(v => vacancyRow(v)).join('');

  // Row click — open detail
  el.querySelectorAll('.vacancy-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      const id = row.dataset.id;
      el.querySelectorAll('.vacancy-row').forEach(r => r.classList.toggle('selected', r.dataset.id === id));
      loadDetail(id);
    });
  });

  // Status quick-change buttons
  el.querySelectorAll('.status-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      closeStatusPopover();
      showStatusPopover(btn);
    });
  });
}

// ── Inline status popover ─────────────────────────────────────
let _activeStatusBtn = null;

const STATUS_LABELS = {
  evaluated: 'Оценено', applied: 'Откликнулся', responded: 'Ответили',
  interview: 'Собеседование', offer: 'Оффер', rejected: 'Отказ',
  discarded: 'Архив', skip: 'Пропустить',
};

function showStatusPopover(btn) {
  closeStatusPopover();
  _activeStatusBtn = btn;

  const pop = document.createElement('div');
  pop.className = 'status-popover';
  pop.id = 'status-popover';

  pop.innerHTML = Object.entries(STATUS_LABELS).map(([val, label]) =>
    `<button class="status-pop-item ${val}" data-val="${val}">${label}</button>`
  ).join('');

  document.body.appendChild(pop);
  positionPopover(pop, btn);

  pop.querySelectorAll('.status-pop-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const newStatus = item.dataset.val;
      closeStatusPopover();
      btn.textContent = `${STATUS_LABELS[newStatus] || newStatus} ▾`;
      btn.className = `status-badge ${newStatus} status-btn`;
      try {
        await api(`/api/vacancies/${id}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: newStatus }),
        });
        await Promise.all([loadVacancies(), loadStats()]);
      } catch (e) { showToast(`❌ ${e.message}`, 'error'); }
    });
  });

  setTimeout(() => document.addEventListener('click', closeStatusPopover, { once: true }), 10);
}

function positionPopover(pop, btn) {
  const rect = btn.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.top  = `${rect.bottom + 4}px`;
  pop.style.left = `${rect.left}px`;
  pop.style.zIndex = '9999';
}

function closeStatusPopover() {
  const p = document.getElementById('status-popover');
  if (p) p.remove();
  _activeStatusBtn = null;
}

function vacancyRow(v) {
  const score = v.score
    ? `<span class="score-badge ${v.scoreColor}">${v.score.toFixed(1)}</span>`
    : `<span class="score-badge muted">—</span>`;

  const srcClass = v.jobSource === 'hh'       ? 'source-hh' :
                   v.jobSource === 'habr'      ? 'source-habr' :
                   v.jobSource === 'getmatch'  ? 'source-getmatch' :
                   v.jobSource === 'telegram'  ? 'source-telegram' : 'source-other';

  const statusCell = v.source === 'tracker'
    ? `<div class="status-cell">
         <button class="status-badge ${v.status} status-btn" data-id="${v.id}" title="Сменить статус">
           ${v.statusRu} ▾
         </button>
       </div>`
    : `<div><span class="status-badge ${v.status}">${v.statusRu}</span></div>`;

  return `
    <div class="vacancy-row" data-id="${v.id}">
      <div>${score}</div>
      <div class="company-name">
        <span class="source-dot ${srcClass}"></span>${esc(v.company)}
      </div>
      <div class="role-name" title="${esc(v.role)}">${esc(v.role)}</div>
      ${statusCell}
      <div class="date-cell">${v.date || ''}</div>
      <div class="actions-cell">
        ${v.url ? `<button class="btn btn-ghost btn-sm" onclick="openUrl('${esc(v.url)}')" title="Открыть на hh.ru">↗</button>` : ''}
      </div>
    </div>`;
}

// ── Render: Detail panel ──────────────────────────────────────
function renderDetail() {
  const panel = qs('#detail-panel');
  const el    = qs('#detail-content');

  if (!state.selected) {
    el.innerHTML = `<div class="detail-empty"><span>👈</span><p>Выбери вакансию</p></div>`;
    return;
  }

  if (!state.detail) {
    el.innerHTML = `<div class="loading-state"><div class="spinner"></div></div>`;
    panel.classList.add('mobile-open');
    return;
  }

  const v = state.detail;
  if (v.error) {
    el.innerHTML = `<div class="detail-empty"><span>⚠️</span><p>${esc(v.error)}</p></div>`;
    return;
  }

  panel.classList.add('mobile-open');

  const score = v.score
    ? `<div class="divergence-meter">
         <div class="divergence-label">convergence</div>
         <span class="score-badge ${v.scoreColor}" style="width:58px;height:28px;font-size:16px;letter-spacing:.06em">${v.score.toFixed(1)}</span>
       </div>`
    : '';

  const metaChips = [
    v.archetype  && `<span class="meta-chip">${esc(v.archetype)}</span>`,
    v.legitimacy && `<span class="meta-chip">${esc(v.legitimacy)}</span>`,
    v.jobSource  && `<span class="meta-chip">${v.jobSource}</span>`,
    v.date       && `<span class="meta-chip">${v.date}</span>`,
  ].filter(Boolean).join('');

  const statusOptions = [
    'evaluated', 'applied', 'responded', 'interview', 'offer', 'rejected', 'discarded', 'skip'
  ].map(s => {
    const labels = { evaluated: 'Оценено', applied: 'Откликнулся', responded: 'Ответили',
      interview: 'Собеседование', offer: 'Оффер', rejected: 'Отказ', discarded: 'Архив', skip: 'Пропустить' };
    return `<option value="${s}" ${v.status === s ? 'selected' : ''}>${labels[s] || s}</option>`;
  }).join('');

  const tabs = ['analysis', 'report', 'actions'].map(t => {
    const labels = { analysis: 'Анализ', report: 'Отчёт', actions: 'Действия' };
    return `<div class="detail-tab ${state.detailTab === t ? 'active' : ''}" data-tab="${t}">${labels[t]}</div>`;
  }).join('');

  el.innerHTML = `
    <div class="detail-header">
      <div class="detail-company">${esc(v.company)}</div>
      <div class="detail-role">${esc(v.role)}</div>
      <div class="detail-meta">
        ${score}
        ${metaChips}
      </div>
      <div class="detail-actions">
        ${v.source === 'tracker' ? `
          <select class="status-select" id="status-select">
            ${statusOptions}
          </select>
          <button class="btn btn-sm btn-primary" id="btn-save-status">Сохранить</button>
        ` : `
          <button class="btn btn-sm btn-primary" id="btn-eval-vacancy">⚡ Оценить с ИИ</button>
        `}
        ${v.url ? `<button class="btn btn-sm btn-ghost" onclick="openUrl('${v.url}')">↗ Открыть</button>` : ''}
        ${v.url ? `<button class="btn btn-sm btn-ghost liveness-btn" id="btn-liveness" data-url="${esc(v.url)}" onclick="checkLiveness(this)">🔎 Актуальна?</button>` : ''}
      </div>
    </div>

    <div class="detail-tabs">${tabs}</div>

    <div class="detail-body" id="detail-tab-body">
      ${renderDetailTab(v)}
    </div>`;

  // Attach listeners for buttons inside tab body (re-called on every tab switch)
  function attachTabBodyListeners() {
    const evalTabBtn  = qs('#btn-eval-tab');
    if (evalTabBtn) evalTabBtn.addEventListener('click', () => openEvalModal(v));

    const reevalBtn = qs('#btn-reeval-action');
    if (reevalBtn) reevalBtn.addEventListener('click', () => openEvalModal(v));

    const deleteBtn = qs('#btn-delete-vacancy');
    if (deleteBtn) deleteBtn.addEventListener('click', () => deleteVacancy(v));
  }

  // Tab clicks
  el.querySelectorAll('.detail-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      state.detailTab = tab.dataset.tab;
      el.querySelectorAll('.detail-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === state.detailTab));
      qs('#detail-tab-body').innerHTML = renderDetailTab(v);
      attachTabBodyListeners();
    });
  });

  attachTabBodyListeners();

  // Status save
  const saveBtn = el.querySelector('#btn-save-status');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const sel    = el.querySelector('#status-select');
      const newSt  = sel.value;
      saveBtn.textContent = '…';
      try {
        await api(`/api/vacancies/${v.id}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: newSt }),
        });
        await Promise.all([loadVacancies(), loadStats()]);
      } catch (e) { showToast(`❌ ${e.message}`); }
      saveBtn.textContent = 'Сохранить';
    });
  }

  // Eval button (for pipeline items)
  const evalBtn = el.querySelector('#btn-eval-vacancy');
  if (evalBtn) {
    evalBtn.addEventListener('click', () => openEvalModal(v));
  }
}

function renderDetailTab(v) {
  if (state.detailTab === 'analysis') {
    if (!v.summary || !Object.keys(v.summary).length) {
      if (v.source === 'tracker' && v.reportPath) {
        return `<div class="empty-state"><span class="empty-icon">📄</span>
          <p style="font-size:13px">Краткий анализ недоступен</p>
          <p class="hint" style="text-align:center;max-width:220px;line-height:1.6">Полный отчёт есть во вкладке <strong>Отчёт</strong></p>
        </div>`;
      }
      return `<div class="empty-state"><span class="empty-icon">📊</span><p>Оценка ещё не проведена</p>
        <button class="btn btn-primary" id="btn-eval-tab">⚡ Оценить с ИИ</button></div>`;
    }
    const sum = v.summary;
    const rows = Object.entries(sum)
      .filter(([k]) => !['SCORE'].includes(k))
      .map(([k, val]) => `<tr><td><strong>${esc(k)}</strong></td><td>${esc(val)}</td></tr>`)
      .join('');
    return `<table style="width:100%;border-collapse:collapse;font-size:12px">
      <tbody>${rows}</tbody></table>
      ${v.notes ? `<div class="detail-section" style="margin-top:12px">
        <div class="detail-section-title">Заметки</div>
        <p style="color:var(--text-2);font-size:12px">${esc(v.notes)}</p>
      </div>` : ''}`;
  }

  if (state.detailTab === 'report') {
    if (!v.reportHtml) {
      return `<div class="empty-state"><span class="empty-icon">📄</span><p>Отчёт отсутствует</p></div>`;
    }
    return `<div class="report-content">${v.reportHtml}</div>`;
  }

  if (state.detailTab === 'actions') {
    return `
      <div class="detail-section">
        <div class="detail-section-title">Быстрые действия</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <button class="btn btn-primary" id="btn-reeval-action">
            ⚡ Переоценить
          </button>
          <button class="btn btn-ghost" onclick="openOptimizeModalById('${esc(v.id)}')">
            🔄 Оптимизировать CV под эту вакансию
          </button>
          <button class="btn btn-ghost" onclick="copyClaudeCmd('cv', '${esc(v.id)}')">
            📄 Сгенерировать CV через Claude
          </button>
          <button class="btn btn-ghost" onclick="openInterviewModal('${esc(v.id)}')">
            🎤 Подготовка к интервью
          </button>
          <button class="btn btn-ghost" onclick="copyClaudeCmd('contact', '${esc(v.id)}')">
            ✉️ Написать рекрутёру
          </button>
          ${v.url ? `<a href="${v.url}" target="_blank" class="btn btn-ghost">↗ Открыть вакансию</a>` : ''}
        </div>
      </div>
      <div style="margin-top:auto;padding-top:16px;border-top:1px solid var(--border)">
        <button class="btn btn-danger-ghost" id="btn-delete-vacancy" style="width:100%">
          🗑 Удалить вакансию
        </button>
      </div>
`;
  }
  return '';
}

// ── Listeners ─────────────────────────────────────────────────
function setupListeners() {
  // Search
  qs('#search').addEventListener('input', debounce(e => {
    state.search = e.target.value;
    loadVacancies();
  }, 300));

  // Search shortcut /
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== qs('#search')) {
      e.preventDefault();
      qs('#search').focus();
    }
    if (e.key === 'Escape') {
      const openModal = document.querySelector('.modal:not(.hidden)');
      const activeTag = document.activeElement?.tagName;
      const typing    = ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag);
      if (openModal) {
        // Close modal, leave detail panel intact
        closeAllModals();
      } else if (!typing) {
        // Only close detail if not editing something
        closeDetail();
      }
    }
  });

  // Filters
  document.querySelectorAll('.filter-opt').forEach(opt => {
    opt.addEventListener('click', () => {
      const type = opt.dataset.type;
      const val  = opt.dataset.val;

      document.querySelectorAll(`.filter-opt[data-type="${type}"]`).forEach(o => o.classList.remove('active'));
      opt.classList.add('active');

      if (type === 'status') state.filters.status = val;
      if (type === 'source') state.filters.source = val;
      if (type === 'score')  state.filters.score  = parseFloat(val);

      loadVacancies();
    });
  });

  // Stats bar click → filter by status
  document.querySelectorAll('.stat-card[data-filter]').forEach(card => {
    card.addEventListener('click', () => {
      const val = card.dataset.filter || 'all';
      document.querySelectorAll('.stat-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      document.querySelectorAll(`.filter-opt[data-type="status"]`).forEach(o => {
        o.classList.toggle('active', o.dataset.val === val);
      });
      state.filters.status = val;
      loadVacancies();
    });
  });

  // Column sort
  document.querySelectorAll('.th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const f = th.dataset.sort;
      if (state.sort.field === f) {
        state.sort.dir *= -1;
      } else {
        state.sort.field = f;
        state.sort.dir   = -1;
      }
      sortVacancies();
      renderList();
    });
  });

  // CSV export
  qs('#btn-export-csv').addEventListener('click', exportCSV);
  qs('#btn-analytics').addEventListener('click', openAnalyticsModal);
  qs('#btn-followup').addEventListener('click', openFollowupModal);

  // Settings modal
  qs('#btn-settings').addEventListener('click', () => { openModal('settings'); loadLlmSettings(); });

  // LLM warning banner
  qs('#btn-open-llm-settings')?.addEventListener('click', () => {
    openModal('settings');
    loadLlmSettings();
    document.querySelector('[data-settings-tab="llm"]')?.click();
  });
  qs('#btn-dismiss-llm-banner')?.addEventListener('click', () => {
    qs('#llm-warning-banner')?.classList.add('hidden');
  });
  qs('#btn-clear-pipeline').addEventListener('click', clearPipeline);
  qs('#btn-archive-tracker').addEventListener('click', archiveTracker);
  qs('#btn-delete-tracker').addEventListener('click', deleteTrackerRows);
  qs('#btn-clear-scan-history').addEventListener('click', clearScanHistory);
  qs('#btn-delete-reports').addEventListener('click', deleteReports);

  // Settings tabs
  document.querySelectorAll('[data-settings-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.settingsTab;
      document.querySelectorAll('[data-settings-tab]').forEach(b =>
        b.classList.toggle('active', b.dataset.settingsTab === tab));
      document.querySelectorAll('.settings-tab-pane').forEach(p =>
        p.classList.toggle('hidden', p.id !== `settings-tab-${tab}`));
      if (tab === 'telegram') loadTelegramChannels();
    });
  });

  // LLM settings: provider tabs
  document.querySelectorAll('.provider-tab').forEach(btn => {
    btn.addEventListener('click', () => switchProvider(btn.dataset.provider));
  });

  // LLM settings: save + test
  qs('#btn-llm-save').addEventListener('click', saveLlmSettings);
  qs('#btn-llm-test').addEventListener('click', testLlmConnection);

  // CV button
  qs('#btn-cv').addEventListener('click', openCVModal);

  // CV modal tab switching
  document.querySelectorAll('.modal-nav[data-cv-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchCVTab(btn.dataset.cvTab));
  });

  // Interview prep modal tab switching
  document.querySelectorAll('[data-interview-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.interviewTab;
      interviewState.tab = tab;
      document.querySelectorAll('[data-interview-tab]').forEach(b =>
        b.classList.toggle('active', b.dataset.interviewTab === tab));
      document.querySelectorAll('.interview-tab-pane').forEach(p =>
        p.classList.toggle('hidden', p.id !== `interview-tab-${tab}`));
    });
  });

  // Add vacancy button
  qs('#btn-add-vacancy').addEventListener('click', openAddModal);
  qs('#btn-add-run').addEventListener('click', runAdd);

  // Scan button — load config then open modal
  qs('#btn-scan').addEventListener('click', openScanModal);

  // Evaluate-all button
  qs('#btn-eval-all')?.addEventListener('click', openBatchEvalModal);

  // Modal close buttons
  document.querySelectorAll('[data-modal]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.modal));
  });

  // Overlay click → close all
  qs('#overlay').addEventListener('click', closeAllModals);

  // Keyword suggester
  qs('#btn-suggest-keywords').addEventListener('click', suggestKeywords);
  qs('#suggest-role-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); suggestKeywords(); }
  });

  // Scan advanced toggle
  qs('#btn-scan-advanced')?.addEventListener('click', () => {
    const block = qs('#scan-advanced-block');
    const btn   = qs('#btn-scan-advanced');
    const open  = block.style.display !== 'flex';
    block.style.display = open ? 'flex' : 'none';
    btn.textContent = open ? '▾ Дополнительно' : '▸ Дополнительно';
    if (open) {
      // Scroll the modal body to show the newly opened section
      setTimeout(() => {
        const body = qs('#modal-scan .scan-modal-body');
        if (body) body.scrollTop = body.scrollHeight;
      }, 40);
    }
  });

  // Negative keywords toggle
  qs('#btn-scan-negkw')?.addEventListener('click', () => {
    const block = qs('#scan-negkw-block');
    const btn   = qs('#btn-scan-negkw');
    const open  = block.style.display !== 'none';
    block.style.display = open ? 'none' : 'block';
    const countStr = scanConfig.negative.length ? ` (${scanConfig.negative.length})` : '';
    const countEl  = qs('#negkw-count');
    if (countEl) countEl.textContent = countStr;
    btn.innerHTML = btn.innerHTML.replace(/^[▸▾]/, open ? '▸' : '▾');
  });

  // Clear keywords button
  qs('#btn-clear-kw')?.addEventListener('click', () => {
    scanConfig.positive = [];
    renderTags('positive');
  });

  // ── Telegram channel management (Settings → Telegram tab) ────
  let telegramChannels = [];

  async function loadTelegramChannels() {
    try {
      const data = await api('/api/telegram-channels');
      telegramChannels = data.channels || [];
      renderTelegramChannels();
    } catch {}
  }

  function renderTelegramChannels() {
    const list = qs('#tg-settings-list');
    if (!list) return;

    if (telegramChannels.length === 0) {
      list.innerHTML = '<div class="telegram-ch-empty">Каналов пока нет. Добавь первый ниже.</div>';
      return;
    }
    list.innerHTML = telegramChannels.map(ch => `
      <div class="telegram-ch-item">
        <a class="telegram-ch-handle" href="https://t.me/s/${ch.handle}" target="_blank"
           title="Открыть веб-превью канала">@${ch.handle}</a>
        <span class="telegram-ch-notes">${ch.notes || ''}</span>
        <button class="telegram-ch-remove" data-handle="${ch.handle}" title="Удалить канал">✕</button>
      </div>
    `).join('');
    list.querySelectorAll('.telegram-ch-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        const h = btn.dataset.handle;
        try {
          await api(`/api/telegram-channels/${encodeURIComponent(h)}`, { method: 'DELETE' });
          telegramChannels = telegramChannels.filter(c => c.handle !== h);
          renderTelegramChannels();
          showToast(`@${h} удалён`, 'success');
        } catch (e) { showToast(e.message, 'error'); }
      });
    });
  }

  async function addTelegramChannel() {
    const input    = qs('#tg-add-handle');
    const notesInp = qs('#tg-add-notes');
    const statusEl = qs('#tg-add-status');
    const handle   = input?.value?.trim().replace(/^@/, '');
    if (!handle) { input?.focus(); return; }
    if (statusEl) statusEl.textContent = 'Добавляю…';
    try {
      await api('/api/telegram-channels', {
        method: 'POST',
        body: JSON.stringify({ handle, notes: notesInp?.value?.trim() || '' }),
      });
      telegramChannels.push({ handle, notes: notesInp?.value?.trim() || '' });
      renderTelegramChannels();
      if (input) input.value = '';
      if (notesInp) notesInp.value = '';
      if (statusEl) statusEl.textContent = '';
      showToast(`@${handle} добавлен`, 'success');
    } catch (e) {
      if (statusEl) statusEl.textContent = e.message;
      showToast(e.message, 'error');
    }
  }

  qs('#btn-tg-add')?.addEventListener('click', addTelegramChannel);
  qs('#tg-add-handle')?.addEventListener('keydown', e => { if (e.key === 'Enter') addTelegramChannel(); });

  // "📡 Каналы" button in scan modal → open Settings → Telegram tab
  qs('#btn-open-telegram-settings')?.addEventListener('click', () => {
    closeModal('scan');
    openModal('settings');
    document.querySelector('[data-settings-tab="telegram"]')?.click();
  });
  // ── End Telegram channel management ───────────────────────────

  // Scan run + tag inputs
  qs('#btn-scan-run').addEventListener('click', runScan);
  setupTagInput('positive');
  setupTagInput('negative');

  // Region search filter
  qs('#scan-area-search')?.addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim();
    const sel = qs('#scan-area');
    if (!sel) return;
    let firstVisible = null;
    for (const opt of sel.options) {
      const match = !q || opt.textContent.toLowerCase().includes(q);
      opt.hidden = !match;
      if (match && !firstVisible) firstVisible = opt;
    }
    // If selected option got hidden, switch to first visible
    if (sel.selectedOptions[0]?.hidden && firstVisible) {
      sel.value = firstVisible.value;
    }
  });

  // Evaluate run
  qs('#btn-eval-run').addEventListener('click', runEvaluate);

  // Optimize run + apply + copy
  qs('#btn-optimize-run').addEventListener('click', runOptimize);
  qs('#btn-optimize-apply').addEventListener('click', async () => {
    if (!cvState.optimized) return;
    const status = qs('#optimize-apply-status');
    status.textContent = '…';
    try {
      await saveCVContent(cvState.optimized);
      status.textContent = '✓ Применено';
      showToast('CV обновлено. Старый вариант — cv.backup.md');
    } catch (e) {
      status.textContent = `❌ ${e.message}`;
    }
  });
  qs('#btn-optimize-copy').addEventListener('click', () => {
    if (!cvState.optimized) return;
    navigator.clipboard.writeText(cvState.optimized)
      .then(() => showToast('Скопировано в буфер'));
  });

  // Setup CV upload
  setupCVUpload();
}

// ── Modals ────────────────────────────────────────────────────
function openModal(name) {
  qs(`#modal-${name}`).classList.remove('hidden');
  qs('#overlay').classList.remove('hidden');
}
function closeModal(name) {
  qs(`#modal-${name}`).classList.add('hidden');
  if (!document.querySelector('.modal:not(.hidden)')) {
    qs('#overlay').classList.add('hidden');
  }
}
function closeAllModals() {
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  qs('#overlay').classList.add('hidden');
}
function closeDetail() {
  state.selected = null;
  state.detail   = null;
  qs('#detail-panel').classList.remove('mobile-open');
  qs('#detail-content').innerHTML = `<div class="detail-empty"><span>👈</span><p>Выбери вакансию</p></div>`;
  document.querySelectorAll('.vacancy-row').forEach(r => r.classList.remove('selected'));
}

async function openEvalModal(v) {
  resetEvalModal(false);
  evalState.vacancyUrl = v?.url || null;
  const titleEl = qs('#eval-modal-title');
  const hintEl  = qs('#eval-modal-hint');
  const textarea = qs('#eval-text');

  if (titleEl) titleEl.textContent = v ? `Оценить: ${v.company} — ${v.role}` : 'Оценить вакансию';
  textarea.value = '';
  textarea.disabled = false;
  qs('#eval-output').textContent = '';
  qs('#eval-output').classList.add('hidden');
  openModal('evaluate');

  // Auto-fetch JD for hh.ru vacancies
  const hhMatch = v?.url?.match(/hh\.ru\/vacancy\/(\d+)/);
  if (hhMatch) {
    textarea.value = '';
    textarea.disabled = true;
    textarea.placeholder = '⏳ Открываю страницу вакансии…';
    if (hintEl) hintEl.textContent = '⏳ Загружаю через браузер, подожди 3–5 сек…';
    try {
      const data = await api(`/api/hh-vacancy/${hhMatch[1]}`);
      textarea.value = data.text;
      textarea.placeholder = '';
      if (hintEl) hintEl.textContent = '✓ Текст загружен. Можешь отредактировать перед оценкой.';
    } catch (e) {
      textarea.placeholder = 'Вставь текст вакансии вручную…';
      if (hintEl) hintEl.textContent = `Не удалось загрузить (${e.message}). Вставь текст вакансии вручную.`;
    } finally {
      textarea.disabled = false;
    }
  } else if (v?.url) {
    textarea.value = `URL: ${v.url}\nКомпания: ${v.company}\nРоль: ${v.role}\n\n`;
    if (hintEl) hintEl.textContent = 'Добавь текст вакансии ниже (не hh.ru — автозагрузка недоступна).';
  } else {
    // No URL available — show URL input so user can trigger auto-fetch without pasting full JD
    if (hintEl) hintEl.innerHTML =
      `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
         <input id="eval-url-input" type="text" class="eval-url-input"
           placeholder="https://hh.ru/vacancy/…  — для автозагрузки текста">
         <button class="btn btn-sm btn-ghost" id="btn-eval-fetch-url">Загрузить</button>
       </div>
       <span class="hint" style="display:block;margin-top:5px">или вставь текст вакансии в поле ниже</span>`;

    const doFetchByUrl = async () => {
      const urlVal  = qs('#eval-url-input')?.value?.trim();
      const hhMatch = urlVal?.match(/hh\.ru\/vacancy\/(\d+)/);
      if (!hhMatch) return;
      evalState.vacancyUrl = urlVal.replace(/\?.*$/, '');
      textarea.disabled = true;
      textarea.placeholder = '⏳ Загружаю через браузер…';
      if (hintEl) hintEl.textContent = '⏳ Загружаю, подожди 3–5 сек…';
      try {
        const data = await api(`/api/hh-vacancy/${hhMatch[1]}`);
        textarea.value       = data.text;
        textarea.placeholder = '';
        if (hintEl) hintEl.textContent = '✓ Текст загружен. Можешь отредактировать перед оценкой.';
      } catch (e) {
        textarea.placeholder = 'Вставь текст вакансии вручную…';
        if (hintEl) hintEl.textContent = `Не удалось загрузить (${e.message}). Вставь текст вручную.`;
      } finally {
        textarea.disabled = false;
      }
    };

    setTimeout(() => {
      const urlInput = qs('#eval-url-input');
      const fetchBtn = qs('#btn-eval-fetch-url');
      if (urlInput) urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') doFetchByUrl(); });
      if (fetchBtn) fetchBtn.addEventListener('click', doFetchByUrl);
    }, 50);
  }
}

// ── Add vacancy modal ─────────────────────────────────────────
function openAddModal() {
  qs('#add-input').value = '';
  const preview = qs('#add-preview');
  preview.textContent = '';
  preview.className = 'add-preview hidden';
  const btn = qs('#btn-add-run');
  btn.disabled = false;
  btn.textContent = 'Добавить';
  openModal('add');
  setTimeout(() => qs('#add-input').focus(), 60);
}

async function runAdd() {
  const raw = qs('#add-input').value.trim();
  if (!raw) { qs('#add-input').focus(); return; }

  const preview = qs('#add-preview');
  const btn     = qs('#btn-add-run');

  // Detect URL vs text
  const urlMatch = raw.match(/https?:\/\/\S+/);
  const url      = urlMatch ? urlMatch[0].replace(/\?.*$/, '') : null;

  // Text (not URL, >80 chars) → redirect to eval modal
  if (!url && raw.length > 80) {
    closeModal('add');
    openEvalModal(null);
    setTimeout(() => {
      const ta = qs('#eval-text');
      if (ta) { ta.value = raw; ta.disabled = false; }
    }, 60);
    return;
  }

  if (!url) {
    preview.textContent = '⚠️ Не похоже на ссылку и слишком короткий текст для оценки.';
    preview.className = 'add-preview warning';
    return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ Добавляю…';
  preview.textContent = url.includes('hh.ru') ? '⏳ Открываю страницу для получения названия…' : '⏳ Добавляю…';
  preview.className = 'add-preview';

  try {
    const data = await api('/api/pipeline/add', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });

    preview.textContent = `✓ ${data.company} — ${data.title}`;
    preview.className = 'add-preview success';

    await Promise.all([loadVacancies(), loadStats()]);

    // Select the newly added pending entry
    const newEntry = state.vacancies.find(v => v.url === data.url && v.status === 'pending');
    if (newEntry) {
      document.querySelectorAll('.vacancy-row').forEach(r =>
        r.classList.toggle('selected', r.dataset.id === newEntry.id));
      loadDetail(newEntry.id);
    }

    setTimeout(() => closeModal('add'), 1200);
  } catch (e) {
    if (e.message.includes('уже')) {
      preview.textContent = `⚠️ ${e.message}`;
      preview.className = 'add-preview warning';
    } else {
      preview.textContent = `❌ ${e.message}`;
      preview.className = 'add-preview error';
    }
    btn.disabled = false;
    btn.textContent = 'Добавить';
  }
}

// ── Keyword suggester ─────────────────────────────────────────
async function suggestKeywords() {
  const input   = qs('#suggest-role-input');
  const btn     = qs('#btn-suggest-keywords');
  const results = qs('#suggest-results');
  const role    = input.value.trim();
  if (!role) { input.focus(); return; }

  btn.disabled     = true;
  btn.textContent  = '…';
  results.classList.remove('hidden');
  results.innerHTML = `<div class="suggest-loading"><div class="spinner" style="width:14px;height:14px;border-width:2px"></div> ИИ подбирает ключевые слова…</div>`;

  try {
    const data = await api('/api/suggest-keywords', {
      method: 'POST',
      body: JSON.stringify({ role }),
    });

    const addChip = (word, type) => {
      const list   = type === 'kw' ? scanConfig.positive : scanConfig.negative;
      const already = list.includes(word);
      const chip   = document.createElement('span');
      chip.className = `suggest-chip suggest-chip-${type}${already ? ' added' : ''}`;
      chip.innerHTML = `<span class="suggest-chip-icon">${type === 'kw' ? '+' : '—'}</span>${esc(word)}`;
      if (!already) {
        chip.addEventListener('click', () => {
          if (chip.classList.contains('added')) return;
          list.push(word);
          renderTags(type === 'kw' ? 'positive' : 'negative');
          chip.classList.add('added');
        });
      }
      return chip;
    };

    results.innerHTML = '';

    if (data.keywords?.length) {
      const g = document.createElement('div');
      g.innerHTML = `<div class="suggest-group-title">✅ Ключевые слова (кликни чтобы добавить)</div>`;
      const chips = document.createElement('div');
      chips.className = 'suggest-chips';
      data.keywords.forEach(w => chips.appendChild(addChip(w, 'kw')));
      g.appendChild(chips);
      results.appendChild(g);
    }

    if (data.stopwords?.length) {
      const g = document.createElement('div');
      g.innerHTML = `<div class="suggest-group-title">🚫 Стоп-слова (кликни чтобы добавить)</div>`;
      const chips = document.createElement('div');
      chips.className = 'suggest-chips';
      data.stopwords.forEach(w => chips.appendChild(addChip(w, 'sw')));
      g.appendChild(chips);
      results.appendChild(g);
    }

    if (!data.keywords?.length && !data.stopwords?.length) {
      results.innerHTML = `<span class="hint">ИИ не вернул результатов — попробуй другую формулировку</span>`;
    }
  } catch (e) {
    results.innerHTML = `<span class="hint" style="color:var(--red)">❌ ${esc(e.message)}</span>`;
  } finally {
    btn.disabled    = false;
    btn.textContent = '✨ Подобрать';
  }
}

// ── Scan modal open ───────────────────────────────────────────
async function openScanModal() {
  // Load current config from server
  try {
    const cfg = await api('/api/search-config');
    scanConfig.positive = cfg.positive || [];
    scanConfig.negative = cfg.negative || [];
  } catch {
    // keep whatever is in scanConfig
  }
  renderTags('positive');
  renderTags('negative');
  qs('#scan-output').textContent = '';
  qs('#scan-output').classList.add('hidden');
  // Reset suggest results
  const suggRes = qs('#suggest-results');
  if (suggRes) { suggRes.innerHTML = ''; suggRes.classList.add('hidden'); }
  // Update negkw badge
  const negCount = qs('#negkw-count');
  if (negCount) negCount.textContent = scanConfig.negative.length ? ` (${scanConfig.negative.length})` : '';
  openModal('scan');
  // Focus role input if no keywords yet
  if (scanConfig.positive.length === 0) setTimeout(() => qs('#suggest-role-input')?.focus(), 60);
  // Load hh.ru regions (lazy, cached after first load)
  loadHhAreas();
}

// ── Tag management ────────────────────────────────────────────
function renderTags(type) {
  const list  = qs(`#${type}-tags`);
  const items = scanConfig[type];
  list.innerHTML = items.map((kw, i) => `
    <span class="tag tag-${type}">
      ${esc(kw)}
      <button class="tag-remove" data-type="${type}" data-idx="${i}">×</button>
    </span>`).join('');
  list.querySelectorAll('.tag-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      scanConfig[btn.dataset.type].splice(parseInt(btn.dataset.idx), 1);
      renderTags(btn.dataset.type);
    });
  });
}

function setupTagInput(type) {
  const input = qs(`#${type}-tag-input`);
  if (!input) return;
  const addTag = () => {
    const val = input.value.trim().replace(/,+$/, '');
    if (!val) return;
    // Allow comma-separated batch entry
    for (const kw of val.split(',').map(s => s.trim()).filter(Boolean)) {
      if (!scanConfig[type].includes(kw)) scanConfig[type].push(kw);
    }
    input.value = '';
    renderTags(type);
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addTag(); }
    if (e.key === 'Backspace' && input.value === '' && scanConfig[type].length) {
      scanConfig[type].pop();
      renderTags(type);
    }
  });
  input.addEventListener('blur', addTag);
  // Click on wrap focuses input
  qs(`#${type}-tags-wrap`)?.addEventListener('click', e => {
    if (!e.target.closest('.tag')) input.focus();
  });
}

// ── HH Areas loader ───────────────────────────────────────────
let _hhAreas = null;

async function loadHhAreas() {
  if (_hhAreas !== null) return;
  try {
    const areas = await api('/api/hh-areas');
    _hhAreas = areas;
    const sel = qs('#scan-area');
    if (!sel) return;
    for (const a of areas) {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.name;
      sel.appendChild(opt);
    }
  } catch {
    _hhAreas = [];
  }
}

// ── Scan runner ───────────────────────────────────────────────
async function runScan() {
  const btn    = qs('#btn-scan-run');
  const output = qs('#scan-output');
  const period     = qs('#scan-period').value;
  const pages      = qs('#scan-pages').value;
  const habrPages      = qs('#scan-habr-pages')?.value || '2';
  const getmatchPages  = qs('#scan-getmatch-pages')?.value || '2';
  const dryRun     = qs('#scan-dryrun').checked;
  const saveDefault = qs('#scan-save-default').checked;
  const area       = qs('#scan-area').value;
  const schedule   = qs('#scan-schedule')?.value || null;

  // Collect selected sources
  const sources = [];
  if (qs('#scan-src-hh')?.checked)       sources.push('hh');
  if (qs('#scan-src-habr')?.checked)     sources.push('habr');
  if (qs('#scan-src-getmatch')?.checked) sources.push('getmatch');
  if (qs('#scan-src-telegram')?.checked) sources.push('telegram');
  if (sources.length === 0) {
    showToast('Выбери хотя бы один источник', 'error');
    return;
  }

  // If no keywords yet but role input has text, auto-add it as a tag
  if (scanConfig.positive.length === 0) {
    const roleInput = qs('#suggest-role-input');
    const rawRole = roleInput?.value?.trim();
    if (rawRole) {
      scanConfig.positive.push(rawRole);
      renderTags('positive');
    }
  }

  if (scanConfig.positive.length === 0) {
    showToast('Введи хотя бы одну должность', 'error');
    qs('#suggest-role-input')?.focus();
    return;
  }

  // Save defaults before scanning
  if (saveDefault && !dryRun) {
    try {
      await api('/api/search-config', {
        method: 'PUT',
        body: JSON.stringify({ positive: scanConfig.positive, negative: scanConfig.negative }),
      });
    } catch {}
  }

  btn.disabled = true;
  btn.textContent = '⏳ Ищу…';
  output.textContent = '';
  output.classList.add('hidden');

  const progressArea = qs('#scan-progress');
  const phaseIcon  = qs('#scan-phase-icon');
  const phaseText  = qs('#scan-phase-text');
  const elapsedEl  = qs('#scan-elapsed');
  if (progressArea) progressArea.classList.remove('hidden');

  const t0 = Date.now();
  const timer = setInterval(() => {
    if (elapsedEl) elapsedEl.textContent = `${Math.round((Date.now() - t0) / 1000)}с`;
  }, 500);

  const logToggle = qs('#btn-scan-log-toggle');
  if (logToggle && !logToggle._hooked) {
    logToggle._hooked = true;
    logToggle.addEventListener('click', () => {
      const open = output.classList.contains('hidden');
      output.classList.toggle('hidden', !open);
      logToggle.textContent = open ? '▾ Скрыть вывод' : '▸ Подробный вывод';
    });
  }

  const setPhase = (icon, text) => {
    if (phaseIcon) phaseIcon.textContent = icon;
    if (phaseText) phaseText.textContent = text;
  };

  // Track which source is currently streaming — switches on server separator lines
  let activeSource = sources[0];
  const phaseLabel = {
    hh: 'Сканирую hh.ru…',
    habr: 'Сканирую Habr Карьера…',
    getmatch: 'Сканирую GetMatch…',
    telegram: 'Сканирую Telegram…',
  };
  setPhase('🔍', phaseLabel[activeSource] || 'Сканирую…');

  try {
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        period, pages, habrPages, getmatchPages, dryRun, area, schedule, sources,
        keywords: scanConfig.positive,
        negative: scanConfig.negative,
      }),
    });

    const reader = res.body.getReader();
    const dec    = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value).split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const d = JSON.parse(line.slice(6));
          if (d.text) {
            const t = d.text;
            appendTerminal(output, t);
            // Server separator ━━━ (46 chars) = hh → habr transition
            if (t.includes('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')) {
              activeSource = 'habr';
              setPhase('🔍', 'Сканирую Habr Карьера…');
            // Server separator ◆◆◆ (46 chars) = → getmatch transition
            } else if (t.includes('◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆')) {
              activeSource = 'getmatch';
              setPhase('🔍', 'Сканирую GetMatch…');
            // Server separator ▲▲▲ (46 chars) = → telegram transition
            } else if (t.includes('▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲')) {
              activeSource = 'telegram';
              setPhase('📡', 'Сканирую Telegram…');
            } else if (activeSource === 'hh') {
              if (t.includes('Scanning') || t.includes('Запрос') || t.includes('Fetching page'))
                setPhase('🔍', 'Сканирую hh.ru…');
              if (t.includes('Found') || t.includes('Найдено'))
                setPhase('📋', 'Обрабатываю результаты hh.ru…');
              if (t.includes('Saved') || t.includes('pipeline'))
                setPhase('💾', 'Сохраняю вакансии hh.ru…');
              if (t.includes('Skipped') || t.includes('дубликат') || t.includes('Duplicates'))
                setPhase('🔄', 'Фильтрую дубликаты…');
            } else if (activeSource === 'habr') {
              if (t.includes('Fetching page') || t.includes('Query'))
                setPhase('🔍', 'Сканирую Habr Карьера…');
              if (t.includes('Найдено') || t.includes('New offers') || t.includes('Found'))
                setPhase('📋', 'Обрабатываю результаты Habr…');
              if (t.includes('pipeline') || t.includes('Results saved'))
                setPhase('💾', 'Сохраняю вакансии Habr…');
            } else if (activeSource === 'getmatch') {
              if (t.includes('Fetching page') || t.includes('Query') || t.includes('API hit'))
                setPhase('🔍', 'Сканирую GetMatch…');
              if (t.includes('Found') || t.includes('New offers'))
                setPhase('📋', 'Обрабатываю результаты GetMatch…');
              if (t.includes('pipeline') || t.includes('Results saved'))
                setPhase('💾', 'Сохраняю вакансии GetMatch…');
            } else if (activeSource === 'telegram') {
              if (t.includes('Сканирую @') || t.includes('📡'))
                setPhase('📡', 'Сканирую Telegram-каналы…');
              if (t.includes('✅') || t.includes('новых'))
                setPhase('📋', 'Обрабатываю результаты Telegram…');
            }
          }
          if (d.done) {
            clearInterval(timer);
            await Promise.all([loadVacancies(), loadStats()]);
            const newCount = state.stats?.pending || 0;
            if (newCount > 0) {
              setPhase('✅', `Готово! Найдено ${newCount} вакансий`);
              if (elapsedEl) elapsedEl.textContent = '';
              const hint = document.createElement('div');
              hint.className = 'scan-next-hint';
              hint.innerHTML = `✅ Найдено: <strong>${newCount}</strong> вакансий<br>
                <span style="font-size:12px;opacity:.8">Нажми «⚡ Оценить все» чтобы ИИ оценил их автоматически</span>`;
              output.appendChild(hint);
            } else {
              setPhase('🔍', 'Новых вакансий не найдено');
            }
          }
        } catch {}
      }
    }
  } catch (e) {
    clearInterval(timer);
    setPhase('❌', `Ошибка: ${e.message.slice(0, 60)}`);
    appendTerminal(output, `\n❌ ${e.message}`);
  } finally {
    clearInterval(timer);
    btn.disabled = false;
    btn.textContent = '▶ Запустить поиск';
  }
}

// ── Evaluate runner ───────────────────────────────────────────
async function runEvaluate() {
  const text = qs('#eval-text').value.trim();
  if (!text) { qs('#eval-text').focus(); return; }
  // Store JD for optimize modal (same-URL fast-path)
  cvState.jdText      = text;
  cvState.jdSourceUrl = evalState.vacancyUrl || null;

  const inputArea   = qs('#eval-input-area');
  const progressArea = qs('#eval-progress-area');
  const phaseIcon   = qs('#eval-phase-icon');
  const phaseText   = qs('#eval-phase-text');
  const elapsedEl   = qs('#eval-elapsed');
  const fill        = qs('#eval-fill');
  const output      = qs('#eval-output');
  const btn         = qs('#btn-eval-run');
  const cancelBtn   = qs('#btn-eval-cancel');

  const setPhase = (icon, label) => {
    phaseIcon.textContent = icon;
    phaseText.textContent = label;
  };

  // Set phase BEFORE showing progress area — prevents stale "Готово" flash
  setPhase('📂', 'Загружаю контекст…');

  // Switch to progress view
  inputArea.classList.add('hidden');
  progressArea.classList.remove('hidden');
  progressArea.classList.add('running');
  output.textContent = '';
  output.classList.remove('hidden');
  btn.classList.add('hidden');
  cancelBtn.textContent = 'Отмена';

  // Elapsed timer
  const t0 = Date.now();
  const timer = setInterval(() => {
    elapsedEl.textContent = `${Math.round((Date.now() - t0) / 1000)}с`;
  }, 500);

  let evalCode = null;

  try {
    const res = await fetch('/api/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sourceUrl: evalState.vacancyUrl }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuf    = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuf += decoder.decode(value, { stream: true });

      const events = sseBuf.split('\n\n');
      sseBuf = events.pop();

      for (const ev of events) {
        const line = ev.trim();
        if (!line.startsWith('data: ')) continue;
        try {
          const d = JSON.parse(line.slice(6));
          if (d.text) {
            const t = d.text;

            // Detect phase from server output
            if (t.includes('📂') || t.includes('Loading context'))  setPhase('📂', 'Загружаю контекст…');
            if (t.includes('🔍') || t.includes('Checking Ollama'))  setPhase('🔍', 'Проверяю Ollama…');
            if (t.includes('Ollama running'))                       setPhase('🤖', 'Ollama готов…');
            if (t.includes('🤖') || t.includes('Calling Ollama'))   setPhase('⚡', 'Генерирую оценку…');
            if (t.includes('\r') && t.includes('enerating'))        setPhase('⚡', 'Генерирую оценку…');
            if (t.includes('Generated in'))                         setPhase('📝', 'Обрабатываю результат…');
            if (t.includes('Report saved') || t.includes('Отчёт')) setPhase('💾', 'Сохраняю отчёт…');
            if (t.includes('Добавлено') || t.includes('трекер'))    setPhase('📊', 'Обновляю трекер…');

            appendTerminal(output, t);
          }
          if (d.done) {
            evalCode = d.code;
            const prevSelectedId = state.selected;
            await Promise.all([loadVacancies(), loadStats()]);

            if (evalCode === 0 && prevSelectedId) {
              // After evaluation, the pipeline item is gone; find the new tracker entry
              let newId = null;

              // Try URL match first (most precise)
              if (evalState.vacancyUrl) {
                const byUrl = state.vacancies.find(v =>
                  v.url === evalState.vacancyUrl && v.source === 'tracker');
                if (byUrl) newId = byUrl.id;
              }

              // Fallback: highest-numbered tracker entry (just added)
              if (!newId) {
                const trackers = state.vacancies.filter(v => v.source === 'tracker');
                if (trackers.length) {
                  trackers.sort((a, b) => (b.number || 0) - (a.number || 0));
                  newId = trackers[0].id;
                }
              }

              if (newId && newId !== prevSelectedId) {
                state.selected = newId;
                document.querySelectorAll('.vacancy-row').forEach(r =>
                  r.classList.toggle('selected', r.dataset.id === newId));
              }
            }

            // Reload detail panel so analysis tab shows fresh data
            if (state.selected) {
              state.detail = null;
              await loadDetail(state.selected);
            }
          }
        } catch {}
      }
    }
  } catch (e) {
    output.textContent += `\n❌ ${e.message}`;
  } finally {
    clearInterval(timer);

    progressArea.classList.remove('running');

    if (evalCode === 0) {
      setPhase('✅', 'Готово');
      fill.classList.add('done');
    } else {
      setPhase('❌', evalCode === null ? 'Прервано' : 'Ошибка');
      fill.classList.add('error');
    }

    // Replace footer: show "Закрыть" + "Оценить снова"
    const footer = qs('#eval-footer');
    footer.innerHTML = `
      <button class="btn btn-primary" id="btn-eval-close">
        ${evalCode === 0 ? '✅ Закрыть' : '✕ Закрыть'}
      </button>
      <button class="btn btn-ghost" id="btn-eval-again">↺ Оценить другую</button>`;

    qs('#btn-eval-close').onclick = () => resetEvalModal(true);
    qs('#btn-eval-again').onclick = () => resetEvalModal(false);
  }
}

function resetEvalModal(andClose) {
  qs('#eval-input-area').classList.remove('hidden');
  qs('#eval-progress-area').classList.add('hidden');
  qs('#eval-output').classList.add('hidden');
  qs('#eval-fill').classList.remove('done', 'error');
  qs('#eval-phase-icon').textContent = '⚡';
  qs('#eval-phase-text').textContent = 'Подготовка…';
  qs('#eval-elapsed').textContent    = '';
  qs('#eval-footer').innerHTML = `
    <button id="btn-eval-run" class="btn btn-primary">⚡ Оценить</button>
    <button class="btn btn-ghost" data-modal="evaluate" id="btn-eval-cancel">Отмена</button>`;
  qs('#btn-eval-run').addEventListener('click', runEvaluate);
  qs('#btn-eval-cancel').addEventListener('click', () => closeModal('evaluate'));
  if (andClose) closeModal('evaluate');
}

// ── Claude handoff helpers ────────────────────────────────────
window.openOptimizeModal = openOptimizeModal;
window.openOptimizeModalById = function(id) {
  // Prefer state.detail — it has guessed URL from the detail endpoint (guessVacancyUrl)
  const v = (state.detail?.id === id ? state.detail : null)
         || state.vacancies.find(x => x.id === id)
         || state.detail;
  openOptimizeModal(v);
};

window.copyClaudeCmd = function(action, id) {
  const v = state.vacancies.find(x => x.id === id) || state.detail;
  if (!v) return;

  const cmds = {
    cv:        `/career-ops pdf ${v.url || v.role}`,
    interview: `/career-ops interview-prep ${v.url || v.role}`,
    contact:   `/career-ops contacto ${v.url || v.role}`,
  };
  const cmd = cmds[action] || '';
  navigator.clipboard.writeText(cmd).then(() => {
    showToast(`Скопировано: ${cmd}`);
  });
};

window.openUrl = function(url) {
  window.open(url, '_blank', 'noopener');
};

// ── Interview prep modal ───────────────────────────────────────
const interviewState = { tab: 'report', vacancyId: null };

window.openInterviewModal = async function(id) {
  const reportBody    = qs('#interview-report-body');
  const storybankBody = qs('#interview-storybank-body');
  const generating    = qs('#interview-generating');
  const titleEl       = qs('#interview-modal-title');
  const copyBtn       = qs('#btn-interview-copy-cmd');

  interviewState.vacancyId = id;

  // Reset to report tab
  interviewState.tab = 'report';
  document.querySelectorAll('[data-interview-tab]').forEach(b =>
    b.classList.toggle('active', b.dataset.interviewTab === 'report'));
  document.querySelectorAll('.interview-tab-pane').forEach(p =>
    p.classList.toggle('hidden', p.id !== 'interview-tab-report'));

  reportBody.innerHTML    = '<div class="loading-state"><div class="spinner"></div></div>';
  storybankBody.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';
  generating.classList.add('hidden');
  reportBody.classList.remove('hidden');
  copyBtn.classList.add('hidden');
  titleEl.textContent = '🎤 Подготовка к интервью';

  // Show current LLM model in footer badge
  api('/api/llm-config').then(cfg => {
    const badge = qs('#interview-model-badge');
    if (badge && cfg?.model) badge.textContent = `🤖 ${cfg.provider || 'ollama'} / ${cfg.model}`;
  }).catch(() => {});

  openModal('interview');

  try {
    const data = await api(`/api/interview-prep/${id}`);
    interviewState.lastData = data;

    if (data.company && data.company !== 'Unknown') {
      titleEl.textContent = `🎤 ${data.company}`;
    }

    // Render report tab
    if (data.hasReport && data.reportHtml) {
      reportBody.innerHTML = `<div class="report-content">${data.reportHtml}</div>`;
    } else {
      const cmd = data.claudeCmd || '';
      reportBody.innerHTML = `
        <div class="interview-no-report">
          <div style="font-size:48px">🎤</div>
          <p style="font-size:14px;font-weight:600;color:var(--text-1)">Отчёт ещё не создан</p>
          <p class="hint" style="max-width:380px;line-height:1.65">
            ИИ проанализирует вакансию и резюме, предложит вероятные вопросы и ответы под твой профиль:
          </p>
          <button class="btn btn-primary" onclick="runInterviewGenerate()">⚡ Сгенерировать план подготовки</button>
          <p class="hint" style="font-size:11px;margin-top:8px">
            Для глубокого исследования (Glassdoor, Blind) — запусти в Claude Code:
          </p>
          <div class="interview-cmd-box">${esc(cmd)}</div>
        </div>`;
      if (cmd) {
        copyBtn.classList.remove('hidden');
        copyBtn.onclick = () =>
          navigator.clipboard.writeText(cmd).then(() => showToast('Команда скопирована'));
      }
    }

    // Render story bank tab
    if (data.storyBankHtml) {
      storybankBody.innerHTML = `<div class="report-content">${data.storyBankHtml}</div>`;
    } else {
      storybankBody.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">📚</span>
          <p>Story bank пуст</p>
          <p class="hint" style="text-align:center;max-width:240px;line-height:1.6">
            Истории появятся после оценок и первых интервью
          </p>
        </div>`;
    }
  } catch (e) {
    reportBody.innerHTML = `<div class="empty-state"><span class="empty-icon">⚠️</span><p>${esc(e.message)}</p></div>`;
  }
};

window.runInterviewGenerate = async function() {
  const id = interviewState.vacancyId;
  if (!id) return;

  const reportBody  = qs('#interview-report-body');
  const generating  = qs('#interview-generating');
  const phaseEl     = qs('#interview-phase-text');
  const fillEl      = qs('#interview-fill');
  const elapsedEl   = qs('#interview-elapsed');
  const streamEl    = qs('#interview-stream');
  const copyBtn     = qs('#btn-interview-copy-cmd');

  // Show generating state
  reportBody.classList.add('hidden');
  generating.classList.remove('hidden');
  copyBtn.classList.add('hidden');
  streamEl.textContent = '';
  phaseEl.textContent  = 'Подготовка…';
  fillEl.className     = 'eval-fill';
  fillEl.style.width   = '0%';
  elapsedEl.textContent = '0s';

  const start  = Date.now();
  const ticker = setInterval(() => {
    elapsedEl.textContent = `${Math.round((Date.now() - start) / 1000)}s`;
  }, 1000);

  // Animate fill bar (slow — generation is long)
  let fillPct = 0;
  const fillTimer = setInterval(() => {
    fillPct = Math.min(fillPct + 0.4, 90);
    fillEl.style.width = `${fillPct}%`;
  }, 800);

  try {
    const resp = await fetch(`/api/interview-prep/${id}/generate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({}),
    });

    if (!resp.ok) {
      throw new Error(`Server ${resp.status}`);
    }

    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let   result  = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const raw of decoder.decode(value).split('\n')) {
        if (!raw.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(raw.slice(6));
          if (ev.phase) {
            phaseEl.textContent = ev.phase;
          } else if (ev.token) {
            result += ev.token;
            streamEl.textContent += ev.token;
            streamEl.scrollTop   = streamEl.scrollHeight;
          } else if (ev.error) {
            throw new Error(ev.error);
          } else if (ev.done) {
            result = ev.result || result;
          }
        } catch (parseErr) {
          if (parseErr.message && !parseErr.message.includes('JSON')) throw parseErr;
        }
      }
    }

    clearInterval(ticker);
    clearInterval(fillTimer);
    fillEl.style.width = '100%';
    fillEl.classList.add('done');
    phaseEl.textContent = '✅ Готово!';

    setTimeout(async () => {
      // Reload the report data and show it
      try {
        const data = await api(`/api/interview-prep/${id}`);
        interviewState.lastData = data;
        generating.classList.add('hidden');
        reportBody.classList.remove('hidden');
        if (data.hasReport && data.reportHtml) {
          reportBody.innerHTML = `<div class="report-content">${data.reportHtml}</div>`;
          // Update story bank too
          const sbBody = qs('#interview-storybank-body');
          if (data.storyBankHtml) {
            sbBody.innerHTML = `<div class="report-content">${data.storyBankHtml}</div>`;
          }
        }
      } catch { /* show stream result as fallback */ }
    }, 600);

  } catch (e) {
    clearInterval(ticker);
    clearInterval(fillTimer);
    fillEl.classList.add('error');
    phaseEl.textContent = `❌ ${e.message}`;
  }
};

// ── Toast ─────────────────────────────────────────────────────
function showToast(msg, type = 'success') {
  let toast = qs('#toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.style.cssText = `
      position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(4px);
      padding:9px 20px;border-radius:8px;font-size:13px;font-weight:500;
      z-index:200;opacity:0;transition:opacity .2s,transform .2s;pointer-events:none;
      white-space:nowrap;box-shadow:0 4px 20px rgba(0,0,0,.5);
    `;
    document.body.appendChild(toast);
  }
  const isErr = type === 'error' || msg.startsWith('❌');
  toast.style.background = isErr ? 'rgba(248,113,113,.15)' : 'rgba(52,211,153,.15)';
  toast.style.color       = isErr ? 'var(--red)'           : 'var(--green)';
  toast.style.border      = isErr ? '1px solid rgba(248,113,113,.3)' : '1px solid rgba(52,211,153,.3)';
  toast.textContent = msg;
  toast.style.opacity   = '1';
  toast.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    toast.style.opacity   = '0';
    toast.style.transform = 'translateX(-50%) translateY(4px)';
  }, 2800);
}

// ── CSV export ────────────────────────────────────────────────
function exportCSV() {
  const params = new URLSearchParams();
  if (state.filters.status !== 'all') params.set('status', state.filters.status);
  if (state.filters.score > 0)        params.set('score_min', state.filters.score);
  const url = `/api/export/csv${params.toString() ? '?' + params : ''}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.click();
}

// ── Manage: clear pipeline ────────────────────────────────────
async function clearPipeline() {
  const btn    = qs('#btn-clear-pipeline');
  const status = qs('#clear-pipeline-status');
  btn.disabled = true;
  status.textContent = '…';
  try {
    const d = await api('/api/pipeline/pending', { method: 'DELETE' });
    status.textContent = d.cleared > 0 ? `✓ Очищено ${d.cleared} ссылок` : '✓ Очередь уже пуста';
    await Promise.all([loadVacancies(), loadStats()]);
  } catch (e) {
    status.textContent = `❌ ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ── Manage: archive tracker entries ──────────────────────────
async function archiveTracker() {
  const btn      = qs('#btn-archive-tracker');
  const statusEl = qs('#archive-tracker-status');
  const checked  = [...document.querySelectorAll('#archive-status-checks input:checked')]
    .map(cb => cb.value);
  if (!checked.length) { statusEl.textContent = 'Выбери хотя бы один статус'; return; }

  btn.disabled = true;
  statusEl.textContent = '…';
  try {
    const d = await api('/api/tracker/archive', {
      method: 'POST',
      body: JSON.stringify({ statuses: checked }),
    });
    statusEl.textContent = d.archived > 0
      ? `✓ Архивировано ${d.archived} вакансий`
      : '✓ Нечего архивировать';
    await Promise.all([loadVacancies(), loadStats()]);
  } catch (e) {
    statusEl.textContent = `❌ ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ── Manage: clear scan history ────────────────────────────────
async function clearScanHistory() {
  const btn      = qs('#btn-clear-scan-history');
  const statusEl = qs('#clear-scan-history-status');
  btn.disabled   = true;
  statusEl.textContent = '…';
  try {
    const d = await api('/api/scan-history', { method: 'DELETE' });
    const parts = [];
    if (d.deleted > 0) parts.push(`${d.deleted} из истории`);
    if (d.pipelineReset > 0) parts.push(`${d.pipelineReset} из очереди`);
    statusEl.textContent = parts.length ? `✓ Сброшено: ${parts.join(', ')}` : '✓ Уже пусто';
    if ((d.deleted || 0) + (d.pipelineReset || 0) > 0) await Promise.all([loadVacancies(), loadStats()]);
  } catch (e) {
    statusEl.textContent = `❌ ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ── Manage: delete reports ─────────────────────────────────────
async function deleteReports() {
  const btn      = qs('#btn-delete-reports');
  const statusEl = qs('#delete-reports-status');
  const allCheck = qs('#delete-reports-checks input[value="all"]');
  const mode     = allCheck?.checked ? 'all' : 'evaluated';
  btn.disabled   = true;
  statusEl.textContent = '…';
  try {
    const d = await api('/api/reports', {
      method: 'DELETE',
      body: JSON.stringify({ mode }),
    });
    statusEl.textContent = d.deleted > 0
      ? `✓ Удалено ${d.deleted} отчётов`
      : '✓ Нечего удалять';
    if (d.deleted > 0) await Promise.all([loadVacancies(), loadStats()]);
  } catch (e) {
    statusEl.textContent = `❌ ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ── Manage: delete tracker rows ───────────────────────────────
async function deleteTrackerRows() {
  const btn      = qs('#btn-delete-tracker');
  const statusEl = qs('#delete-tracker-status');
  const checked  = [...document.querySelectorAll('#delete-status-checks input:checked')]
    .map(cb => cb.value);
  if (!checked.length) { statusEl.textContent = 'Выбери хотя бы один статус'; return; }

  statusEl.textContent = '…';
  btn.disabled = true;
  try {
    const d = await api('/api/tracker/rows', {
      method: 'DELETE',
      body: JSON.stringify({ statuses: checked }),
    });
    statusEl.textContent = d.deleted > 0
      ? `✓ Удалено ${d.deleted} вакансий`
      : '✓ Нечего удалять';
    if (d.deleted > 0) await Promise.all([loadVacancies(), loadStats()]);
  } catch (e) {
    statusEl.textContent = `❌ ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ── Delete single vacancy ─────────────────────────────────────
async function deleteVacancy(v) {
  const label = [v.company, v.role].filter(Boolean).join(' — ') || v.url || v.id;
  if (!confirm(`Удалить «${label}» полностью?\n\nБудет удалено из pipeline, трекера и отчёта (если есть). Отменить нельзя.`)) return;

  const btn = qs('#btn-delete-vacancy');
  if (btn) { btn.disabled = true; btn.textContent = 'Удаляем…'; }

  try {
    await api(`/api/vacancies/${v.id}`, { method: 'DELETE' });
    closeDetail();
    await Promise.all([loadVacancies(), loadStats()]);
  } catch (e) {
    alert(`Не удалось удалить: ${e.message}`);
    if (btn) { btn.disabled = false; btn.textContent = '🗑 Удалить вакансию'; }
  }
}

// ── LLM Settings ─────────────────────────────────────────────

const PROVIDER_FIELD_VISIBILITY = {
  ollama:     { host: true,  key: false, url: false },
  openai:     { host: false, key: true,  url: false },
  anthropic:  { host: false, key: true,  url: false },
  deepseek:   { host: false, key: true,  url: false },
  openrouter: { host: false, key: true,  url: false },
  custom:     { host: false, key: true,  url: true  },
};

let _llmProviderModels = {};

async function loadLlmSettings() {
  try {
    const cfg = await api('/api/llm-config');
    _llmProviderModels = cfg.providerModels || {};

    // Set provider tab
    switchProvider(cfg.provider || 'ollama');

    // Fill fields
    if (cfg.ollama_host) qs('#llm-ollama-host').value = cfg.ollama_host;
    if (cfg.api_key)     qs('#llm-api-key').value     = cfg.api_key;
    if (cfg.base_url)    qs('#llm-base-url').value    = cfg.base_url;
    if (cfg.model)       qs('#llm-model').value       = cfg.model;

    qs('#llm-test-result').textContent = '';
  } catch (e) {
    console.error('Failed to load LLM config', e);
  }
}

function switchProvider(provider) {
  // Update tab active state
  document.querySelectorAll('.provider-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.provider === provider));

  // Show/hide fields
  const vis = PROVIDER_FIELD_VISIBILITY[provider] || {};
  qs('#llm-row-ollama-host').classList.toggle('hidden', !vis.host);
  qs('#llm-row-api-key').classList.toggle('hidden',     !vis.key);
  qs('#llm-row-base-url').classList.toggle('hidden',    !vis.url);

  // Update model chips
  const models = _llmProviderModels[provider] || [];
  const chipsEl = qs('#llm-model-chips');
  chipsEl.innerHTML = models.map(m =>
    `<button class="model-chip" data-model="${m}">${m}</button>`
  ).join('');
  chipsEl.querySelectorAll('.model-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      qs('#llm-model').value = chip.dataset.model;
    });
  });

  // Pre-fill model if field is empty
  const modelInput = qs('#llm-model');
  if (!modelInput.value && models.length) modelInput.value = models[0];
}

async function saveLlmSettings() {
  const btn = qs('#btn-llm-save');
  const provider = document.querySelector('.provider-tab.active')?.dataset.provider || 'ollama';
  btn.disabled = true;
  try {
    await api('/api/llm-config', {
      method: 'PUT',
      body: JSON.stringify({
        provider,
        model:       qs('#llm-model').value.trim(),
        ollama_host: qs('#llm-ollama-host').value.trim(),
        api_key:     qs('#llm-api-key').value.trim(),
        base_url:    qs('#llm-base-url').value.trim(),
      }),
    });
    showToast('Настройки LLM сохранены', 'success');
    closeModal('settings');
    // Re-check status and hide banner if now OK
    const s = await api('/api/llm-status').catch(() => null);
    if (s?.ok) qs('#llm-warning-banner')?.classList.add('hidden');
  } catch (e) {
    showToast(`Ошибка: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function testLlmConnection() {
  const btn    = qs('#btn-llm-test');
  const result = qs('#llm-test-result');
  const provider = document.querySelector('.provider-tab.active')?.dataset.provider || 'ollama';
  btn.disabled = true;
  result.textContent = '⏳ Проверяю…';
  try {
    const d = await api('/api/llm-config/test', {
      method: 'POST',
      body: JSON.stringify({
        provider,
        model:       qs('#llm-model').value.trim(),
        ollama_host: qs('#llm-ollama-host').value.trim(),
        api_key:     qs('#llm-api-key').value.trim(),
        base_url:    qs('#llm-base-url').value.trim(),
      }),
    });
    result.textContent = d.ok
      ? `✅ OK — «${d.response}»`
      : `❌ ${d.error}`;
  } catch (e) {
    result.textContent = `❌ ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ── Terminal output ───────────────────────────────────────────
function appendTerminal(el, rawText) {
  const text = rawText
    .replace(/\x1b\[[0-9;]*m/g, '')  // strip ANSI color codes
    .replace(/\r[^\n]*/g, '');        // collapse \r overwrite lines
  if (!text.trim()) return;
  const frag  = document.createDocumentFragment();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '' && i === lines.length - 1) continue; // skip trailing empty
    const span = document.createElement('span');
    if      (/❌|error|failed|ошибка/i.test(line))              span.className = 'term-err';
    else if (/✅|saved|report|успешно|добавлено|done/i.test(line)) span.className = 'term-ok';
    else if (/📂|🔍|🤖|⚡|📝|💾|📊|⏳/.test(line))             span.className = 'term-info';
    span.textContent = line + '\n';
    frag.appendChild(span);
  }
  el.appendChild(frag);
  el.scrollTop = el.scrollHeight;
}

// ── Utils ─────────────────────────────────────────────────────
function qs(sel) { return document.querySelector(sel); }
function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function showError(msg) { qs('#vacancies-list').innerHTML = `<div class="empty-state"><span class="empty-icon">⚠️</span><p>${esc(msg)}</p></div>`; }
function resetFilters() {
  state.filters = { status: 'all', score: 0, source: 'all' };
  state.search  = '';
  qs('#search').value = '';
  document.querySelectorAll('.filter-opt').forEach(o => {
    o.classList.toggle('active', o.dataset.val === 'all' || o.dataset.val === '0');
  });
  document.querySelectorAll('.stat-card').forEach(c => c.classList.remove('active'));
  loadVacancies();
}
function focusSearch() { setTimeout(() => qs('#search')?.focus(), 100); }

// ── CV ────────────────────────────────────────────────────────
const cvState  = { content: '', optimized: '', jdText: '', jdSourceUrl: null, vacancyId: null };
const evalState = { vacancyUrl: null };

// ── Search config (keywords for scan modal) ───────────────────
const scanConfig = {
  positive: [],   // desired role keywords
  negative: [],   // stop words
};

async function openCVModal() {
  openModal('cv');
  switchCVTab('view');
  await reloadCVPreview();
}

async function reloadCVPreview() {
  const preview = qs('#cv-preview');
  preview.innerHTML = `<div class="loading-state"><div class="spinner"></div></div>`;
  try {
    const data = await api('/api/cv');
    cvState.content = data.content || '';
    if (!data.exists || !cvState.content.trim()) {
      preview.innerHTML = `<div class="detail-empty"><span>📄</span>
        <p>cv.md не найден. Загрузи файл или введи вручную.</p></div>`;
    } else {
      preview.innerHTML = `<div class="cv-preview-inner">${simpleMdToHtml(cvState.content)}</div>`;
    }
    qs('#cv-edit-text').value = cvState.content;
  } catch (e) {
    preview.innerHTML = `<div class="detail-empty"><span>⚠️</span><p>${esc(e.message)}</p></div>`;
  }
}

function switchCVTab(tab) {
  document.querySelectorAll('.cv-tab-pane').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.modal-nav[data-cv-tab]').forEach(b => b.classList.remove('active'));
  qs(`#cv-tab-${tab}`)?.classList.remove('hidden');
  qs(`.modal-nav[data-cv-tab="${tab}"]`)?.classList.add('active');
}

async function saveCVContent(content) {
  await api('/api/cv', { method: 'PUT', body: JSON.stringify({ content }) });
  cvState.content = content;
}

// Upload tab
function setupCVUpload() {
  const zone  = qs('#cv-drop-zone');
  const input = qs('#cv-file-input');

  qs('#btn-cv-pick').addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files[0]) uploadCVFile(input.files[0]); });

  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', ()  => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) uploadCVFile(file);
  });

  qs('#btn-cv-upload-save').addEventListener('click', async () => {
    const text = qs('#cv-upload-text').value.trim();
    if (!text) return;
    await saveCVContent(text);
    switchCVTab('view');
    await reloadCVPreview();
    qs('#cv-upload-result').classList.add('hidden');
    qs('#cv-upload-footer').style.display = 'none';
    showToast('Резюме сохранено как cv.md');
  });

  qs('#btn-cv-save').addEventListener('click', async () => {
    const text   = qs('#cv-edit-text').value;
    const status = qs('#cv-save-status');
    status.textContent = '…';
    try {
      await saveCVContent(text);
      status.textContent = '✓ Сохранено';
      setTimeout(() => { status.textContent = ''; }, 2000);
      // Show re-optimize hint if there's a top vacancy
      const topV = state.vacancies.find(v => v.source === 'tracker' && v.score >= 4.0);
      const hint = qs('#cv-reoptimize-hint');
      if (topV && hint) {
        hint.classList.remove('hidden');
        const reBtn = qs('#btn-reoptimize');
        reBtn.onclick = () => {
          closeModal('cv');
          hint.classList.add('hidden');
          openOptimizeModal(topV);
        };
      }
    } catch (e) {
      status.textContent = `❌ ${e.message}`;
    }
  });
}

async function uploadCVFile(file) {
  const zone   = qs('#cv-drop-zone');
  const result = qs('#cv-upload-result');
  const footer = qs('#cv-upload-footer');

  zone.classList.add('uploading');
  zone.querySelector('p').textContent = 'Извлекаю текст…';

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res  = await fetch('/api/cv/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);

    qs('#cv-upload-filename').textContent = `${data.filename}${data.pages ? ` (${data.pages} стр.)` : ''}`;
    qs('#cv-upload-text').value = data.text;
    result.classList.remove('hidden');
    footer.style.display = '';
  } catch (e) {
    showToast(`Ошибка: ${e.message}`);
  } finally {
    zone.classList.remove('uploading');
    zone.querySelector('p').textContent = 'Перетащи резюме сюда';
  }
}

// Optimize modal
async function openOptimizeModal(v) {
  cvState.vacancyId = v?.id || null;
  qs('#optimize-title').textContent = v
    ? `Оптимизировать CV → ${v.company} · ${v.role}`
    : 'Оптимизировать CV';
  qs('#optimize-output').textContent = '';
  qs('#optimize-running').classList.add('hidden');
  qs('#optimize-result').classList.add('hidden');
  qs('#optimize-input-area').classList.remove('hidden');
  qs('#optimize-apply-status').textContent = '';
  const phaseEl = qs('#opt-phase-text');
  const fillEl  = qs('#opt-fill');
  const elEl    = qs('#opt-elapsed');
  if (phaseEl) phaseEl.textContent = 'Генерирую оптимизированное резюме…';
  if (fillEl)  { fillEl.classList.remove('done', 'error'); }
  if (elEl)    elEl.textContent = '0s';
  const jdHint = qs('#optimize-jd-hint');
  if (jdHint) { jdHint.innerHTML = ''; jdHint.classList.add('hidden'); }
  openModal('optimize');

  // Populate CV selector and reload base content when changed
  try {
    const files = await api('/api/cvs');
    const sel = qs('#optimize-cv-select');
    sel.innerHTML = files.map(f =>
      `<option value="${esc(f)}"${f === 'cv.md' ? ' selected' : ''}>${esc(f)}</option>`
    ).join('');
    sel.onchange = async () => {
      try {
        const data = await api(`/api/cv?file=${encodeURIComponent(sel.value)}`);
        cvState.content = data.content || '';
      } catch {}
    };
    // Always load current CV content so "Оригинал" column is populated
    try {
      const data = await api(`/api/cv?file=${encodeURIComponent(sel.value || 'cv.md')}`);
      cvState.content = data.content || '';
    } catch {}
  } catch {}

  const jdEl = qs('#optimize-jd');

  // Fast-path: JD was just evaluated for this same vacancy
  if (v?.url && cvState.jdSourceUrl === v.url && cvState.jdText) {
    jdEl.value = cvState.jdText;
    return;
  }

  // Auto-fetch for hh.ru vacancies
  const hhMatch = v?.url?.match(/hh\.ru\/vacancy\/(\d+)/);
  if (hhMatch) {
    jdEl.value = '';
    jdEl.disabled = true;
    jdEl.placeholder = '⏳ Загружаю текст вакансии…';
    try {
      const data = await api(`/api/hh-vacancy/${hhMatch[1]}`);
      jdEl.value       = data.text;
      cvState.jdText      = data.text;
      cvState.jdSourceUrl = v.url;
      jdEl.placeholder = '';
    } catch (e) {
      jdEl.placeholder = 'Вставь текст вакансии…';
      showToast(`❌ Не удалось загрузить JD: ${e.message}`, 'error');
    } finally {
      jdEl.disabled = false;
    }
    return;
  }

  // Fallback: cached JD text or URL input hint
  if (cvState.jdText) {
    jdEl.value = cvState.jdText;
    return;
  }

  // No URL, no cache — show inline URL-fetch hint above the textarea
  const hintEl = qs('#optimize-jd-hint');
  if (hintEl) {
    hintEl.innerHTML =
      `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
         <input id="opt-url-input" type="text" class="eval-url-input"
           placeholder="https://hh.ru/vacancy/…  — для автозагрузки текста">
         <button class="btn btn-sm btn-ghost" id="btn-opt-fetch-url">Загрузить</button>
       </div>
       <span class="hint">или вставь текст вакансии в поле ниже</span>`;
    hintEl.classList.remove('hidden');

    const doFetch = async () => {
      const urlVal  = qs('#opt-url-input')?.value?.trim();
      const hhMatch = urlVal?.match(/hh\.ru\/vacancy\/(\d+)/);
      if (!hhMatch) return;
      jdEl.disabled = true;
      jdEl.placeholder = '⏳ Загружаю через браузер…';
      try {
        const data = await api(`/api/hh-vacancy/${hhMatch[1]}`);
        jdEl.value = data.text;
        cvState.jdText      = data.text;
        cvState.jdSourceUrl = urlVal.replace(/\?.*$/, '');
        jdEl.placeholder = '';
        hintEl.classList.add('hidden');
      } catch (e) {
        jdEl.placeholder = 'Вставь текст вакансии вручную…';
        showToast(`❌ Не удалось загрузить: ${e.message}`, 'error');
      } finally {
        jdEl.disabled = false;
      }
    };

    setTimeout(() => {
      const urlInput = qs('#opt-url-input');
      const fetchBtn = qs('#btn-opt-fetch-url');
      if (urlInput) urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') doFetch(); });
      if (fetchBtn) fetchBtn.addEventListener('click', doFetch);
    }, 50);
  }
}

async function runOptimize() {
  const jdText = qs('#optimize-jd').value.trim();
  const model  = qs('#optimize-model').value.trim();
  const cvFile = qs('#optimize-cv-select')?.value || 'cv.md';
  if (!jdText) { qs('#optimize-jd').focus(); return; }

  cvState.jdText = jdText;

  // Ensure CV content is loaded for the "Оригинал" column
  if (!cvState.content) {
    try {
      const data = await api(`/api/cv?file=${encodeURIComponent(cvFile)}`);
      cvState.content = data.content || '';
    } catch {}
  }

  const btn     = qs('#btn-optimize-run');
  const running = qs('#optimize-running');
  const output  = qs('#optimize-output');
  const fillEl  = qs('#opt-fill');
  const elapsed = qs('#opt-elapsed');
  const phase   = qs('#opt-phase-text');

  btn.disabled = true;
  btn.textContent = '⏳ Оптимизирую…';
  output.textContent = '';
  running.classList.remove('hidden');
  qs('#optimize-result').classList.add('hidden');
  qs('#optimize-input-area').classList.add('hidden');

  // Elapsed-time ticker
  const startMs = Date.now();
  const ticker = setInterval(() => {
    elapsed.textContent = `${Math.round((Date.now() - startMs) / 1000)}s`;
  }, 1000);

  let result = '';

  try {
    const res = await fetch('/api/cv/optimize', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ jdText, model: model || undefined, cvFile: cvFile !== 'cv.md' ? cvFile : undefined }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value).split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const d = JSON.parse(line.slice(6));
          if (d.error) throw new Error(d.error);
          if (d.token) {
            result += d.token;
            output.textContent += d.token;
            output.scrollTop = output.scrollHeight;
          }
          if (d.done) {
            result = d.result || result;
            clearInterval(ticker);
            if (fillEl) { fillEl.classList.add('done'); }
            if (phase)  { phase.textContent = '✅ Готово!'; }
            elapsed.textContent = `${Math.round((Date.now() - startMs) / 1000)}s`;
            setTimeout(() => showOptimizeResult(result), 400);
          }
        } catch (parseErr) {
          if (parseErr.message !== 'Unexpected end of JSON input') throw parseErr;
        }
      }
    }
  } catch (e) {
    clearInterval(ticker);
    if (fillEl) fillEl.classList.add('error');
    if (phase)  phase.textContent = `❌ ${e.message}`;
    qs('#optimize-input-area').classList.remove('hidden');
    running.classList.add('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = '⚡ Оптимизировать';
  }
}

function showOptimizeResult(optimizedText) {
  const cleaned = optimizedText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  cvState.optimized = cleaned;

  qs('#compare-original').textContent  = cvState.content;
  qs('#compare-optimized').textContent = cleaned;
  qs('#optimize-running').classList.add('hidden');
  qs('#optimize-result').classList.remove('hidden');
}

// ── Simple markdown → HTML (for CV preview, no deps) ──────────
function simpleMdToHtml(md) {
  return md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm,  '<h2>$1</h2>')
    .replace(/^# (.+)$/gm,   '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,    '<em>$1</em>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(?!<[hul])/gm, '')
    .replace(/\n/g, '<br>');
}

// ── Batch evaluation ─────────────────────────────────────────
const batchEvalState = { running: false, total: 0, done: 0, items: [] };

async function openBatchEvalModal() {
  // Load pending items
  const pending = state.vacancies.filter(v => v.status === 'pending');
  const hhItems = pending.filter(v => v.url?.includes('hh.ru'));

  const list = qs('#batch-eval-list');
  const footer = qs('#batch-eval-footer');
  const progress = qs('#batch-progress-wrap');
  progress.classList.add('hidden');

  if (hhItems.length === 0) {
    list.innerHTML = `<div class="empty-state"><span class="empty-icon">⚡</span>
      <p>Нет вакансий для оценки</p>
      <p class="hint">Сначала найди вакансии с помощью кнопки «🔍 Найти вакансии»</p></div>`;
    footer.innerHTML = `<button class="btn btn-ghost" data-modal="batch-eval">Закрыть</button>`;
    qs('[data-modal="batch-eval"]', footer)?.addEventListener('click', () => closeModal('batch-eval'));
  } else {
    batchEvalState.total = hhItems.length;
    batchEvalState.items = hhItems;

    list.innerHTML = hhItems.map((v, i) => `
      <div class="batch-eval-item" id="batch-item-${i}">
        <span class="batch-eval-item-icon">⏳</span>
        <span class="batch-eval-item-name">
          <span class="company">${esc(v.company)}</span>
          <span class="role">— ${esc(v.role)}</span>
        </span>
        <span class="batch-eval-item-status" id="batch-status-${i}">Ожидает</span>
      </div>`).join('');

    footer.innerHTML = `
      <button id="btn-batch-eval-run" class="btn btn-primary">⚡ Начать оценку (${hhItems.length})</button>
      <button class="btn btn-ghost" data-modal="batch-eval">Закрыть</button>`;

    qs('#btn-batch-eval-run')?.addEventListener('click', runBatchEval);
    footer.querySelectorAll('[data-modal="batch-eval"]').forEach(b =>
      b.addEventListener('click', () => closeModal('batch-eval')));
  }

  openModal('batch-eval');
}

async function runBatchEval() {
  if (batchEvalState.running) return;
  batchEvalState.running = true;

  const runBtn = qs('#btn-batch-eval-run');
  if (runBtn) { runBtn.disabled = true; runBtn.textContent = '⏳ Оцениваю…'; }

  const progress = qs('#batch-progress-wrap');
  const fill = qs('#batch-progress-fill');
  const label = qs('#batch-progress-label');
  progress?.classList.remove('hidden');

  let evaluated = 0, errors = 0;

  try {
    const res = await fetch('/api/evaluate-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const reader = res.body.getReader();
    const dec = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value).split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const d = JSON.parse(line.slice(6));

          if (d.type === 'start') {
            if (label) label.textContent = `0 / ${d.total}`;
          }

          if (d.type === 'item-begin') {
            setItemState(d.index, '🔄', d.company, d.role, 'Загружаю…', '');
            if (fill) fill.style.width = `${Math.round((d.index / batchEvalState.total) * 100)}%`;
            if (label) label.textContent = `${d.index} / ${batchEvalState.total}`;
          }

          if (d.type === 'item-status') {
            const statusEl = qs(`#batch-status-${d.index}`);
            if (statusEl) statusEl.textContent = d.text;
          }

          if (d.type === 'item-done') {
            const scoreStr = d.score != null ? `${d.score.toFixed(1)}/5` : '?/5';
            setItemState(d.index, '✅', d.company || '', d.role || '', scoreStr, 'ok');
            evaluated++;
          }

          if (d.type === 'item-error') {
            setItemState(d.index, '❌', null, null, d.error, 'err');
            errors++;
          }

          if (d.type === 'all-done') {
            if (fill) fill.style.width = '100%';
            if (label) label.textContent = `Готово: ${evaluated} оценено, ${errors} ошибок`;
            await Promise.all([loadVacancies(), loadStats()]);
            const footer = qs('#batch-eval-footer');
            if (footer) {
              footer.innerHTML = `
                <span class="hint">✅ Оценено: ${evaluated} | ❌ Ошибок: ${errors}</span>
                <button class="btn btn-ghost" id="btn-batch-close">Закрыть</button>`;
              qs('#btn-batch-close')?.addEventListener('click', () => closeModal('batch-eval'));
            }
          }
        } catch {}
      }
    }
  } catch (e) {
    if (label) label.textContent = `Ошибка: ${e.message}`;
  } finally {
    batchEvalState.running = false;
  }
}

function setItemState(index, icon, company, role, statusText, statusClass) {
  const item = qs(`#batch-item-${index}`);
  if (!item) return;
  const iconEl = item.querySelector('.batch-eval-item-icon');
  const statusEl = qs(`#batch-status-${index}`);
  if (iconEl) iconEl.textContent = icon;
  if (statusEl) {
    statusEl.textContent = statusText;
    statusEl.className = `batch-eval-item-status ${statusClass}`;
  }
  if (company && role) {
    const nameEl = item.querySelector('.batch-eval-item-name');
    if (nameEl) nameEl.innerHTML = `<span class="company">${esc(company)}</span>
      <span class="role">— ${esc(role)}</span>`;
  }
}

// ── Boot ──────────────────────────────────────────────────────
init();
