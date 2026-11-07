'use strict';

const STORE_KEY = 'kyiv-live-settings-v1';
const CFG_VERSION = 2;
const DEFAULTS = {
  proxyBase: '', group: '19.1', interval: 60, notify: false,
  addressStreet: 'Добровольчих батальйонів', addressHouse: '44а',
  addressResolved: true, waterScope: 'local', cfgVersion: 2,
};
const isNative = Boolean(
  window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()
);

let cfg = loadCfg();
saveCfg();
let state = null;
let pollTimer = null;
let lastAlertKey = null;
let activeDay = 'today';
let busy = false;
let lastSuccessAt = null;

const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function loadCfg() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { saved = {}; }
  const merged = { ...DEFAULTS, ...saved };
  // 关注地址变更时，旧的地址与分组必须作废；数据服务地址等个人设置保留
  if (Number(saved.cfgVersion) !== CFG_VERSION) {
    Object.assign(merged, {
      group: DEFAULTS.group,
      addressStreet: DEFAULTS.addressStreet,
      addressHouse: DEFAULTS.addressHouse,
      addressResolved: DEFAULTS.addressResolved,
      waterScope: DEFAULTS.waterScope,
      cfgVersion: CFG_VERSION,
    });
  }
  return merged;
}
function saveCfg() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch { /* 隐私模式下忽略 */ }
}

function kyivFmt(iso, opts) {
  if (!iso) return '—';
  const s = String(iso).replace(/\.(\d{3})\d+Z$/, '.$1Z');
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Europe/Kyiv', ...opts }).format(d);
}
const shortTime = (iso) => kyivFmt(iso, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const clockTime = (iso) => kyivFmt(iso, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function durText(min) {
  if (min == null) return '—';
  if (min < 60) return `${min} 分钟`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
}
function countdown(n) {
  if (!n || n.minutesToNext == null) return '';
  const t = durText(n.minutesToNext);
  return n.nextType === 'off' ? `距下次停电约 ${t}` : `距恢复供电约 ${t}`;
}
function tickClock() {
  $('#clock').textContent = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date());
}

function apiUrl(path, params = {}) {
  const base = String(cfg.proxyBase || '').trim().replace(/\/+$/, '');
  const u = base ? new URL(path, base + '/') : new URL(path, location.href);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

function showBanner(text) {
  const el = $('#banner');
  el.textContent = text;
  el.hidden = false;
}
function hideBanner() { $('#banner').hidden = true; }

async function refresh() {
  if (busy) return;
  busy = true;
  const btn = $('#btn-refresh');
  btn.classList.add('spinning');
  try {
    const res = await fetch(apiUrl('/api/status', { group: cfg.group, water: cfg.waterScope }), { cache: 'no-store' });
    if (!res.ok) throw new Error(`数据服务返回 ${res.status}`);
    const data = await res.json();
    state = data;
    lastSuccessAt = new Date();
    renderAll();
    handleAlertNotification(data.alert);
    if (isNative && !cfg.proxyBase) {
      showBanner('当前在 APK 内运行但未配置数据服务地址，请在「设置」中填写部署了 Node 服务的地址（例如 http://192.168.1.10:8787）。');
    } else {
      hideBanner();
    }
  } catch (err) {
    const hint = state
      ? '下方仍是上次成功获取的数据，可能已经过期，请勿据此判断当前状态。'
      : '请在「设置」中填写数据服务地址；浏览器直接访问本服务时留空即可。';
    showBanner(`无法连接数据服务：${err.message}。${hint}`);
    if (!state) renderConnectionError(err);
  } finally {
    busy = false;
    btn.classList.remove('spinning');
  }
}

function renderConnectionError(err) {
  const html = `<div class="alert-hero unknown"><div class="alert-title"><strong>暂时无法获取数据</strong></div>
    <div class="alert-sub">${esc(err.message)}。未接入任何实时数据，页面不会显示推测状态。</div></div>`;
  $('#alert-body').innerHTML = html;
  $('#power-body').innerHTML = html;
  $('#water-body').innerHTML = html;
  $('#meta-line').textContent = '数据服务未连接';
}

function renderAll() {
  if (!state) return;
  renderAlert(state.alert);
  renderPower(state.power);
  renderWater(state.water);
  renderMeta();
  syncGroupOptions();
}

// ------------------------------------------------------------------ 警报
function renderAlert(a) {
  const body = $('#alert-body');
  const badge = $('#alert-source');
  const note = $('#alert-note');

  if (!a || a.status === 'unavailable' || a.state === 'unknown') {
    badge.textContent = '暂不可用';
    badge.className = 'badge badge-source';
    body.innerHTML = `<div class="alert-hero unknown">
      <div class="alert-title"><strong>警报状态未知</strong><span>无法确认</span></div>
      <div class="alert-sub">所有警报数据源均不可用。这不代表没有警报，请以当地警报器与官方应用为准。</div></div>`;
    note.textContent = a?.note || '请检查网络与数据服务配置。';
    return;
  }

  const src = a.source || {};
  badge.textContent = src.official ? '官方源' : '非官方聚合源';
  badge.className = 'badge badge-source ' + (src.official ? 'badge-official' : 'badge-unofficial');

  const active = a.state === 'active';
  const tone = active ? (a.level === 'red' ? 'active-red' : a.level === 'yellow' ? 'active-yellow' : 'active-red') : 'clear';
  const title = active
    ? (a.level === 'red' ? '空袭警报生效中' : a.level === 'yellow' ? '无人机威胁预警' : '警报生效中')
    : '暂无基辅市生效警报';
  const subtitle = active
    ? '官方预警渠道已将基辅市列入警报范围，请立即按官方指引避险。'
    : '当前数据源未列出基辅市的生效警报。这不等于绝对安全，请保持官方渠道畅通。';

  const chip = active && a.threat
    ? `<div class="threat-chip">威胁类型：${esc(a.threat)}</div>
       <div class="threat-hint">${esc(a.hint || '')}</div>`
    : '';

  const meta = active ? `<div class="alert-meta">
      <span>开始 <b>${esc(shortTime(a.startedAt))}</b></span>
      <span>已持续 <b>${esc(durText(a.durationMin))}</b></span>
      ${a.updatedAt ? `<span>源更新 <b>${esc(clockTime(a.updatedAt))}</b></span>` : ''}
    </div>` : `<div class="alert-meta"><span>检查时间 <b>${esc(shortTime(a.checkedAt))}</b></span></div>`;

  const stale = a.stale ? `<div class="stale-line">上游暂时不可用，正在显示缓存数据（${esc(a.warning || '数据可能已过期')}）。</div>` : '';
  const warnings = (a.warnings || []).length
    ? `<div class="stale-line">${esc(a.warnings.join('；'))}</div>` : '';

  body.innerHTML = `<div class="alert-hero ${tone}">
      <div class="alert-title"><strong>${esc(title)}</strong>
        ${active && a.level ? `<span>${a.level === 'red' ? '红色级别' : '黄色级别'}</span>` : ''}</div>
      <div class="alert-sub">${esc(subtitle)}</div>
      ${chip}${meta}${stale}${warnings}
    </div>
    <div class="scope-note">本模块只显示<strong>区域级警报状态</strong>与预警发布方给出的<strong>威胁类型级别</strong>（如导弹威胁、无人机威胁）。
      不显示、也不接入来袭目标的位置、航迹、速度、拦截动态或防空系统部署信息。</div>`;

  note.textContent = `数据源：${src.name || '—'}${src.url ? `（${src.url}）` : ''}。${a.note || ''}`;
}

// ------------------------------------------------------------------ 电力
function renderPower(p) {
  const body = $('#power-body');
  const note = $('#power-note');
  if (!p || p.status === 'unavailable') {
    body.innerHTML = `<div class="alert-hero unknown"><div class="alert-title"><strong>停电计划暂不可用</strong></div>
      <div class="alert-sub">${esc(p?.error || '数据源请求失败')}</div></div>`;
    note.textContent = '请稍后刷新，或直接查看 YASNO 官网与 Київ Digital。';
    return;
  }

  const n = p.now || {};
  let title = '计划未发布', sub = '当前分组没有适用的当日计划表', dot = '';
  if (p.emergency) { title = '紧急停电'; sub = '紧急停电期间轮流停电计划不适用，以 DTEK 公告为准'; dot = 'off'; }
  else if (!p.dateMatches || n.off === null) { title = '计划未发布'; sub = '当日计划表尚未更新或不适用'; }
  else if (n.off) { title = '当前停电中'; sub = `本时段 ${n.currentLabel || ''} · ${countdown(n) || '等待恢复'}`; dot = 'off'; }
  else { title = '当前有电'; sub = countdown(n) || '按当日计划表，当前时段未安排停电'; dot = 'on'; }

  const notice = p.emergency
    ? '<div class="notice">DTEK 已启用紧急停电，下面的轮流停电时间表在此期间不适用。</div>'
    : (!p.dateMatches
      ? `<div class="notice info">计划表日期为 ${esc(p.today?.date || '—')}，与基辅当地日期 ${esc(p.kyivDate || '—')} 不一致，可能尚未更新。</div>`
      : '');

  const addressNotice = cfg.addressResolved
    ? `<div class="notice ok">已按 YASNO 官方地址库确认：${esc(cfg.addressStreet)} ${esc(cfg.addressHouse || '')} → 停电分组 <b>${esc(p.group)}</b>。</div>`
    : (cfg.addressStreet
      ? `<div class="notice info">当前为手动选择的分组 <b>${esc(p.group)}</b>，未与地址 ${esc(cfg.addressStreet)} ${esc(cfg.addressHouse || '')} 绑定，请在「设置 → 按地址查询停电分组」确认后再据此安排用电。</div>`
      : '');

  const day = activeDay === 'tomorrow' ? p.tomorrow : p.today;
  const slots = day?.slots || [];
  const hasSchedule = Boolean(day?.hasSchedule);
  const nowMinute = state?.kyiv?.minute ?? 0;

  const blocks = slots.map((s) => {
    const left = Math.max(0, Math.min(100, (s.start / 1440) * 100));
    const width = Math.max(0, ((s.end - s.start) / 1440) * 100);
    return `<div class="slot" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%" title="${esc(s.label)}"></div>`;
  }).join('');
  const nowLine = activeDay === 'today'
    ? `<div class="now-line" style="left:${((nowMinute / 1440) * 100).toFixed(3)}%"></div>` : '';

  const timeline = hasSchedule ? `<div class="timeline-wrap">
      <div class="timeline-label"><span>${activeDay === 'today' ? '今日' : '明日'} 00:00</span><span>24:00</span></div>
      <div class="timeline">${blocks}${nowLine}</div>
      <div class="timeline-ticks"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
      <div class="legend"><span><i style="background:#D94841"></i>停电</span><span><i style="background:#DFE7DA;border:1px solid #E6E9EE"></i>供电</span><span><i style="background:#1F2937"></i>当前时刻</span></div>
      <div class="slot-list">${slots.length
        ? slots.map((s) => `<span class="slot-pill">${esc(s.label)}</span>`).join('')
        : '<span class="empty-note">该日无计划停电时段</span>'}</div>
    </div>` : `<div class="empty-note">${activeDay === 'tomorrow' ? '明日计划尚未发布' : '当日计划尚未发布'}（状态：${esc(day?.status || '—')}）。</div>`;

  body.innerHTML = `${notice}${addressNotice}
    <div class="power-state"><span class="power-dot ${dot}"></span>
      <div><strong>${esc(title)}</strong><small>${esc(sub)}</small></div></div>
    <div class="day-tabs">
      <button type="button" data-day="today" class="${activeDay === 'today' ? 'active' : ''}">今日 ${esc(p.today?.date || '')}</button>
      <button type="button" data-day="tomorrow" class="${activeDay === 'tomorrow' ? 'active' : ''}">明日 ${esc(p.tomorrow?.date || '')}</button>
    </div>
    ${timeline}`;

  body.querySelectorAll('[data-day]').forEach((b) => {
    b.addEventListener('click', () => { activeDay = b.dataset.day; renderPower(p); });
  });

  note.textContent = `数据源：${p.source.name}；分组 ${p.group}（共 ${p.groups.length} 组）；计划更新时间 ${shortTime(p.updatedOn)}。${p.note || ''}${p.stale ? ' 上游暂时不可用，当前为缓存数据。' : ''}`;
}

// ------------------------------------------------------------------ 供水
function renderAreaLine(a) {
  if (!a) return '';
  const local = a.scope !== 'all';
  const head = local
    ? `范围：<b>${esc(a.street)} ${esc(a.house)}</b> · ${esc(a.districtUk)}（${esc(a.districtZh)}，${esc(a.neighborhood)}），并含全市通报`
    : '范围：全基辅，所有行政区的公告';
  const detail = local
    ? (a.localCount
      ? `官方公告中有 ${a.localCount} 条直接提及本地址或本区。`
      : '官方公告中当前没有直接提及本地址或本区的条目。')
      + ` 已隐藏 ${a.hidden} 条明确属于其他区域的公告。`
    : `共 ${a.total} 条公告，未做区域过滤。`;
  const planned = a.plannedStatus ? ` ${esc(a.plannedStatus)}。` : '';
  return `<div class="area-line">${head}</div><div class="area-sub">${detail}${planned}</div>`;
}

function renderWater(w) {
  const body = $('#water-body');
  const note = $('#water-note');
  const areaBox = $('#water-area');
  const scope = w?.area?.scope || cfg.waterScope;
  document.querySelectorAll('.scope-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.scope === scope);
  });
  areaBox.innerHTML = renderAreaLine(w?.area);

  if (!w || w.status === 'unavailable') {
    body.innerHTML = `<div class="alert-hero unknown"><div class="alert-title"><strong>供水公告暂不可用</strong></div>
      <div class="alert-sub">${esc(w?.warning || w?.error || '官网公告暂时无法读取')}，请直接打开 Київводоканал 官网查看。</div></div>`;
    note.textContent = w?.note || '';
    return;
  }

  const items = (w.items || []).slice(0, 8);
  body.innerHTML = items.length ? items.map((it) => {
    const date = it.publishedAt
      ? esc(String(it.publishedAt).replace('T', ' ').slice(5, 16))
      : '官网未标注日期';
    const showSummary = (it.scope === 'address' || it.scope === 'district') && it.summary;
    return `<div class="news-item">
      <div class="news-top">
        <span class="tag ${esc(it.tagKey || 'other')}">${esc(it.tag)}</span>
        <span class="tag scope-${esc(it.scope || 'unspecified')}">${esc(it.scopeLabel || '范围未注明')}</span>
        ${date ? `<span class="news-date">${date}</span>` : ''}
        ${it.waterRelated ? '' : '<span class="news-date">非供水专项</span>'}
      </div>
      <a class="news-title" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.title)} <span class="arrow">↗</span></a>
      ${showSummary ? `<div class="news-summary">${esc(it.summary.slice(0, 180))}</div>` : ''}
    </div>`;
  }).join('') : '<div class="empty-note">当前范围内没有可显示的官方公告。可切换到「全基辅」查看全部，或致电调度 15-81 / (044) 200-73-73 查询具体门牌。</div>';

  note.textContent = `数据源：${w.source.name}；检查时间 ${shortTime(w.checkedAt)}。${w.note || ''}${w.stale ? ' 上游暂时不可用，当前为缓存数据。' : ''}`;
}

async function refreshWater() {
  const box = $('#water-body');
  box.innerHTML = '<div class="loading">正在获取该范围的官方公告…</div>';
  try {
    const res = await fetch(apiUrl('/api/water', { scope: cfg.waterScope }), { cache: 'no-store' });
    if (!res.ok) throw new Error(`数据服务返回 ${res.status}`);
    const data = await res.json();
    if (state) state.water = data;
    renderWater(data);
  } catch (err) {
    showBanner(`切换供水范围失败：${err.message}。仍显示上一次成功获取的数据。`);
    if (state?.water) renderWater(state.water);
  }
}

function renderMeta() {
  const token = state.hasOfficialToken ? '已接入官方警报接口' : '官方警报接口未配置 token，当前使用免密钥公开源';
  const local = lastSuccessAt ? new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(lastSuccessAt) : '—';
  $('#meta-line').textContent = `最近获取 ${local} · 自动刷新每 ${cfg.interval} 秒 · ${token}`;
}

// ------------------------------------------------------------------ 通知
function handleAlertNotification(a) {
  const key = (a?.state === 'active' || a?.state === 'clear') ? a.state : null;
  if (!key) { lastAlertKey = null; return; }
  if (lastAlertKey !== null && lastAlertKey !== key && cfg.notify
      && 'Notification' in window && Notification.permission === 'granted') {
    const text = key === 'active'
      ? `基辅市警报生效${a.threat ? `（${a.threat}）` : ''}`
      : '基辅市警报已解除';
    try {
      new Notification('基辅警报状态变化', { body: `${text}。请以官方渠道为准。`, tag: 'kyiv-alert' });
    } catch { /* WebView 不支持时忽略 */ }
  }
  lastAlertKey = key;
}

// ------------------------------------------------------------------ 设置
function syncGroupOptions() {
  const groups = state?.power?.groups || [];
  if (!groups.length) return;
  for (const sel of [$('#group-select'), $('#cfg-group')]) {
    const keep = sel.value || cfg.group;
    sel.innerHTML = groups.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
    sel.value = groups.includes(keep) ? keep : cfg.group;
  }
  $('#group-select').value = state.power.group;
  $('#cfg-group').value = cfg.group;
}

function openSettings() {
  $('#cfg-proxy').value = cfg.proxyBase;
  $('#cfg-interval').value = String(cfg.interval);
  $('#cfg-group').value = cfg.group;
  $('#cfg-street').value = cfg.addressStreet || '';
  $('#cfg-house').value = cfg.addressHouse || '';
  $('#addr-result').innerHTML = '';
  syncNotificationState();
  const dlg = $('#settings');
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
}
function syncNotificationState() {
  const el = $('#notify-state');
  if (!('Notification' in window)) { el.textContent = '当前环境不支持浏览器通知，APK 内请使用官方警报应用的推送。'; return; }
  el.textContent = Notification.permission === 'granted'
    ? (cfg.notify ? '已开启：警报生效或解除时会提示' : '系统已授权，但本页提醒未开启')
    : (Notification.permission === 'denied' ? '已在浏览器中拒绝，需到站点设置里恢复' : '未开启');
}

function restartPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, Math.max(15, Number(cfg.interval) || 60) * 1000);
}

// ------------------------------------------------------------------ 事件
$('#btn-refresh').addEventListener('click', () => refresh());
document.querySelectorAll('.scope-btn').forEach((b) => {
  b.addEventListener('click', () => {
    const scope = b.dataset.scope;
    if (!scope || scope === cfg.waterScope) return;
    cfg.waterScope = scope;
    saveCfg();
    refreshWater();
  });
});
$('#btn-settings').addEventListener('click', openSettings);
$('#btn-close').addEventListener('click', () => $('#settings').close());
$('#btn-cancel').addEventListener('click', () => $('#settings').close());

$('#group-select').addEventListener('change', (e) => {
  cfg.group = e.target.value;
  cfg.addressResolved = false;
  saveCfg();
  $('#cfg-group').value = cfg.group;
  refresh();
});

$('#btn-resolve').addEventListener('click', async () => {
  const street = $('#cfg-street').value.trim();
  const house = $('#cfg-house').value.trim();
  const box = $('#addr-result');
  cfg.addressStreet = street;
  cfg.addressHouse = house;
  saveCfg();
  box.innerHTML = '<div class="addr-msg">正在查询官方地址库…</div>';
  try {
    const r = await fetch(apiUrl('/api/resolve-address', { street, house }), { cache: 'no-store' });
    if (!r.ok) throw new Error(`数据服务返回 ${r.status}`);
    const d = await r.json();
    if (d.status === 'no_street') {
      box.innerHTML = `<div class="addr-msg warn">${esc(d.message)}</div>`;
      return;
    }
    let html = `<div class="addr-msg ${d.candidates.length ? '' : 'warn'}">匹配街道：<b>${esc(d.street)}</b>。${esc(d.message)}</div>`;
    if (d.candidates.length) {
      html += '<div>' + d.candidates.map((c) =>
        `<button type="button" class="addr-choice" data-group="${esc(c.group)}">${esc(c.house)} → <b>${esc(c.group)}</b></button>`
      ).join('') + '</div>';
    }
    if (d.allHouses && d.allHouses.length) {
      html += `<div class="addr-houses">该街已登记门牌：${esc(d.allHouses.join('、'))}</div>`;
    }
    if (d.streetAlternatives && d.streetAlternatives.length > 1) {
      html += `<div class="addr-houses">街道候选：${esc(d.streetAlternatives.join('、'))}</div>`;
    }
    box.innerHTML = html;
    box.querySelectorAll('[data-group]').forEach((b) => {
      b.addEventListener('click', () => {
        cfg.group = b.dataset.group;
        cfg.addressResolved = true;
        saveCfg();
        $('#cfg-group').value = cfg.group;
        $('#group-select').value = cfg.group;
        box.innerHTML = `<div class="addr-msg">已选分组 <b>${esc(cfg.group)}</b>。</div>`;
        refresh();
      });
    });
  } catch (err) {
    box.innerHTML = `<div class="addr-msg warn">查询失败：${esc(err.message)}</div>`;
  }
});

$('#settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = $('#cfg-proxy').value.trim();
  if (raw && !/^https?:\/\//i.test(raw)) {
    showBanner('数据服务地址需以 http:// 或 https:// 开头，或留空使用同源。');
    $('#settings').close();
    return;
  }
  cfg.proxyBase = raw.replace(/\/+$/, '');
  cfg.group = $('#cfg-group').value || cfg.group;
  cfg.interval = Number($('#cfg-interval').value) || 60;
  cfg.addressStreet = $('#cfg-street').value.trim();
  cfg.addressHouse = $('#cfg-house').value.trim();
  saveCfg();
  $('#settings').close();
  restartPoll();
  refresh();
});

$('#btn-notify').addEventListener('click', async () => {
  if (!('Notification' in window)) { syncNotificationState(); return; }
  const perm = await Notification.requestPermission();
  cfg.notify = perm === 'granted';
  saveCfg();
  syncNotificationState();
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !isNative) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* 不影响主功能 */ });
}

// ------------------------------------------------------------------ 启动
// APK 构建时可通过 KYIV_DATA_URL 注入默认数据服务地址（见 scripts/set-default-proxy.js）。
// 浏览器模式始终使用同源，不读取该文件；用户在设置里手动保存的值优先级更高。
async function loadRuntimeConfig() {
  if (!isNative || cfg.proxyBase) return;
  try {
    const res = await fetch(new URL('config.json', location.href), { cache: 'no-store' });
    if (!res.ok) return;
    const j = await res.json();
    if (j && typeof j.proxyBase === 'string' && j.proxyBase.trim()) {
      cfg.proxyBase = j.proxyBase.trim().replace(/\/+$/, '');
    }
  } catch { /* 未注入默认地址时静默忽略 */ }
}

tickClock();
setInterval(tickClock, 1000);

(async function boot() {
  await loadRuntimeConfig();
  $('#cfg-proxy').value = cfg.proxyBase;
  $('#cfg-interval').value = String(cfg.interval);
  if (isNative && !cfg.proxyBase) {
    showBanner('当前在 APK 内运行。请在「设置」中填写数据服务地址，否则无法获取实时数据。');
  }
  refresh();
  restartPoll();
})();
