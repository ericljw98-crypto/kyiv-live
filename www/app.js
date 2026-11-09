'use strict';

// 编译期由 scripts/write-version.mjs 写入。APK 内当前版本必须是本地常量，
// 不能从服务端或 Service Worker 缓存里取，否则会被新版本反向覆盖而永远检测不到更新。
const BUILD_VERSION = '1.5.0';
const RELEASE_API = 'https://api.github.com/repos/ericljw98-crypto/kyiv-live/releases/latest';
// 唯一的取数地址：GitHub 上的静态快照。手机不连接任何电脑，也不需要电脑常开。
// 本机数据服务只用于生成并推送这份快照，不作为手机端数据源。
const SNAPSHOT_URL = 'https://raw.githubusercontent.com/ericljw98-crypto/kyiv-live/snapshot/status.json';
const SNAPSHOT_REFRESH_MS = 5 * 60 * 1000;
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const UPDATE_MIN_GAP_MS = 5 * 60 * 1000;
const UPDATE_RETRY_MS = 60 * 1000;
const UPDATE_STORE_KEY = 'kyiv-live-update-v1';

const STORE_KEY = 'kyiv-live-settings-v1';
const CFG_VERSION = 4;
const DEFAULTS = {
  group: '19.1', interval: 60, notify: false,
  waterScope: 'local', cfgVersion: 4,
};
const isNative = Boolean(
  window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()
);
function snapshotFetchUrl() {
  const u = new URL(SNAPSHOT_URL);
  u.searchParams.set('_t', String(Date.now()));
  return u.toString();
}
// 显示前最后一道防线：服务端已经把公告、地址与警报文本译成中文，
// 这里只在仍出现西里尔字母时兜底，保证界面不会出现未翻译的乌克兰语。
const CYR = /[\u0400-\u04FF]/;
function zhText(v) {
  const s = String(v ?? '');
  if (!CYR.test(s)) return s;
  return window.KyivZh ? window.KyivZh.toChinese(s, 400) : s.replace(/[\u0400-\u04FF]/g, '');
}

let cfg = loadCfg();
saveCfg();
let state = null;
let snapshotRaw = null;
let pollTimer = null;
let lastAlertKey = null;
let activeDay = 'today';
let busy = false;
let lastSuccessAt = null;
let updateInfo = null;
let updateChecking = false;
let updateLastCheckAt = 0;
let updateRetryTimer = null;
let updateNotifiedVersion = '';
let snoozedVersion = '';
let updateSettings = loadUpdateSettings();
let currentView = 'home';
let newsFilter = '全部';

const $ = (sel) => document.querySelector(sel);
const esc = (v) => zhText(v).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
// URL 必须原样保留，不能被词库翻译；西里尔字符只做百分号编码兜底。
const escUrl = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function loadCfg() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { saved = {}; }
  const merged = { ...DEFAULTS, ...saved };
  // 本次改动起彻底放弃局域网／本机数据服务。旧版保存的电脑地址、按地址查询
  // 用的街道门牌等字段一律丢弃；分组、刷新间隔与通知偏好继续保留。
  for (const key of ['proxyBase', 'addressStreet', 'addressHouse', 'addressResolved']) delete merged[key];
  merged.cfgVersion = CFG_VERSION;
  return merged;
}
function saveCfg() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch { /* 隐私模式下忽略 */ }
}

// 基辅时间：UTC+2（EET），夏令时 UTC+3（EEST），切换点为 3 月最后一个周日
// 01:00 UTC 与 10 月最后一个周日 01:00 UTC。部分 Android WebView 的 ICU 数据
// 只有旧名 Europe/Kiev，没有 Europe/Kyiv，给 Intl.DateTimeFormat 传新名会抛
// RangeError 并中断整页渲染，因此按规则自算偏移，不依赖系统时区数据库。
function kyivOffsetMs(utcMs) {
  const year = new Date(utcMs).getUTCFullYear();
  const lastSunday = (month) => {
    const last = new Date(Date.UTC(year, month + 1, 0));
    return Date.UTC(year, month, last.getUTCDate() - last.getUTCDay(), 1);
  };
  return (utcMs >= lastSunday(2) && utcMs < lastSunday(9) ? 3 : 2) * 3600000;
}
function kyivParts(iso) {
  if (!iso) return null;
  const s = String(iso).replace(/\.(\d{3})\d+Z$/, '.$1Z');
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + kyivOffsetMs(t));
  const p = (n) => String(n).padStart(2, '0');
  return {
    short: `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
    clock: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
    full: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`,
  };
}
// 设备当前时刻对应的基辅墙钟（分钟数、日期、时钟）。停电时间轴的「当前时刻」
// 竖线与「当前有电／停电中」必须按设备实时时间重算：快照是静态文件，里面的
// kyiv.minute 与 power.now 是生成那一刻算好的，直接用会把状态冻结在过去。
function kyivNowParts(at = new Date()) {
  const t = at.getTime();
  const d = new Date(t + kyivOffsetMs(t));
  const pad = (n) => String(n).padStart(2, '0');
  return {
    minute: d.getUTCHours() * 60 + d.getUTCMinutes(),
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    clock: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    full: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
  };
}
function kyivFmt(iso, opts) {
  const p = kyivParts(iso);
  if (!p) return '—';
  // 调用点只有「月日 + 时分」与「时分」两种组合。
  return opts?.month ? p.short : p.clock;
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

// 与服务端 computeNow 同口径，但基准是设备当前的基辅分钟。快照里的
// power.now 是生成那一刻算好的，静态文件不会自己往前走，必须客户端重算。
function computePowerNow(day, minute, dateMatches) {
  if (!day || !day.hasSchedule || !dateMatches) {
    return { off: null, nextAt: null, nextType: null, minutesToNext: null, currentEnd: null, currentLabel: null };
  }
  const slots = Array.isArray(day.slots) ? day.slots : [];
  const current = slots.find((s) => minute >= s.start && minute < s.end) || null;
  const boundaries = [];
  for (const s of slots) {
    boundaries.push({ at: s.start, type: 'off' });
    boundaries.push({ at: s.end, type: 'on' });
  }
  const next = boundaries.filter((b) => b.at > minute).sort((a, b) => a.at - b.at)[0] || null;
  return {
    off: Boolean(current),
    nextAt: next ? next.at : null,
    nextType: next ? next.type : null,
    minutesToNext: next ? next.at - minute : null,
    currentEnd: current ? current.end : null,
    currentLabel: current ? (current.label || '') : null,
  };
}

let lastRenderedMinute = -1;
function tickClock() {
  const now = kyivNowParts();
  $('#clock').textContent = now.full;
  // 分钟一变就重画电力卡：当前时刻竖线、有电／停电状态与倒计时都随真实
  // 时间推进，不必等下一份快照（快照约每 5 分钟更新，且可能明显滞后）。
  if (now.minute !== lastRenderedMinute) {
    lastRenderedMinute = now.minute;
    if (state?.power) renderPower(state.power);
    if (state?.alert) renderAlert(state.alert);
    if (state) renderMeta();
    setDataSourceBar();
  }
}

function showBanner(text) {
  const el = $('#banner');
  el.textContent = zhText(text);
  el.hidden = false;
}
function hideBanner() { $('#banner').hidden = true; }

// 把静态快照还原成前端一直使用的 state 结构，渲染代码无需区分数据来源。
function buildStateFromSnapshot(j) {
  const powers = j.powerByGroup || {};
  const waters = j.waterByScope || {};
  const power = powers[cfg.group] || powers['19.1'] || Object.values(powers)[0]
    || { status: 'unavailable', error: '快照中没有该分组的停电计划', groups: [] };
  const water = waters[cfg.waterScope] || waters.local || Object.values(waters)[0]
    || { status: 'unavailable', items: [], error: '快照中没有该范围的供水公告' };
  return {
    generatedAt: j.generatedAt,
    kyiv: j.kyiv,
    hasOfficialToken: Boolean(j.hasOfficialToken),
    alert: j.alert || { status: 'unavailable' },
    power, water,
    snapshot: true,
    snapshotGeneratedAt: j.generatedAt,
    degraded: Boolean(j.degraded),
  };
}

// 发射数量只取单一信息源的最新一次通报，不并列不同来源或不同口径。
// 线上旧快照仍存有多家来源与多条记录，客户端在此收敛为一条；同日期条目以
// APK 内置的人工校订副本补齐「重点目标」等新增字段，避免旧数据覆盖新界面。
// 袭击后果由 server/aftermath.js 自动索引乌通社英文 RSS 生成，随快照分发；
// 这里优先采用快照里的自动结果，快照缺失时退回 APK 内置种子（data/aftermath.json）。
async function resolveAftermath(fromSnapshot) {
  const remoteItems = Array.isArray(fromSnapshot?.items) ? fromSnapshot.items : [];
  if (remoteItems.length) return { ...fromSnapshot, items: remoteItems.slice(0, 1) };
  try {
    const local = await fetchJson(new URL('aftermath.json', location.href).toString(), 6000);
    if (local?.schema === 1 && Array.isArray(local.items) && local.items.length)
      return { ...local, items: local.items.slice(0, 1) };
  } catch { /* 内置副本缺失时只用快照 */ }
  return (fromSnapshot && Array.isArray(fromSnapshot.items)) ? fromSnapshot : null;
}

// 页面所有时间统一为基辅时间，避免手机系统时区与顶部时钟口径不一致。
function fmtLocalTime(iso) {
  return kyivParts(iso)?.clock || '—';
}
function snapshotAgeText(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return '生成时间未知';
  return s < 60 ? `${s} 秒前` : `${Math.floor(s / 60)} 分钟前`;
}
let lastDataStatus = '';
let lastVerStatus = '';
// 把「数据更新于…」与「已是最新 / 发现新版本…」合并到基辅时间那一行，保持简约。
function renderStatusRest() {
  const el = $('#status-rest');
  if (!el) return;
  const parts = [lastDataStatus, lastVerStatus].filter(Boolean);
  el.textContent = parts.length ? ` · ${parts.join(' · ')}` : '';
}
function setDataSourceBar() {
  const iso = state?.snapshotGeneratedAt || snapshotRaw?.generatedAt;
  const ageMin = iso ? Math.floor((Date.now() - Date.parse(iso)) / 60000) : 0;
  const stale = Number.isFinite(ageMin) && ageMin >= 15;
  lastDataStatus = iso
    ? `数据更新于 ${fmtLocalTime(iso)}（${snapshotAgeText(iso)}）${stale ? '，已过期' : ''}`
    : '正在读取…';
  renderStatusRest();
}
function shortVerStatus(text) {
  const m = /已是最新版本\s*(v?[\d.]+)/.exec(text);
  if (m) return `已是最新 ${m[1]}`;
  const m2 = /发现\s*(v?[\d.]+)/.exec(text);
  if (m2) return `发现新版本 ${m2[1]}`;
  return text;
}

async function refresh() {
  if (busy) return;
  busy = true;
  const btn = $('#btn-refresh');
  btn.classList.add('spinning');
  try {
    const j = await fetchJson(snapshotFetchUrl(), 15000);
    if (!j || j.schema !== 1 || !j.alert) throw new Error('远端快照格式无法识别');
    snapshotRaw = j;
    snapshotRaw.aftermath = await resolveAftermath(j.aftermath);
    state = buildStateFromSnapshot(j);
    lastSuccessAt = new Date();
    renderAll();
    handleAlertNotification(state.alert);
    setDataSourceBar();
    hideBanner();
  } catch (err) {
    const hint = state
      ? '下方仍是上次成功获取的快照，可能已经过期，请勿据此判断当前状态。'
      : '请确认手机能访问 raw.githubusercontent.com，并稍后重试。';
    showBanner(`无法获取数据：${err.message}。${hint}`);
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
  $('#news-body').innerHTML = `<div class="news-empty">${esc(err.message)}。要闻暂不可用，未以推测内容代替。</div>`;
  $('#news-count').textContent = '暂不可用';
  $('#meta-line').textContent = '远端快照未连接';
}

function renderAll() {
  if (!state) return;
  renderAlert(state.alert);
  renderPower(state.power);
  renderWater(state.water);
  renderAftermath(snapshotRaw?.aftermath);
  renderEmbassy(snapshotRaw?.embassy);
  renderNews(snapshotRaw?.news);
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
    note.textContent = zhText(a?.note || '请检查网络与远端快照。');
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

  // 持续时间按设备当前时刻与警报开始时刻之差实时计算；快照里的
  // durationMin 是生成那一刻的数值，静态文件不会自己增长。
  const startedMs = Date.parse(a.startedAt);
  const liveMin = Number.isFinite(startedMs)
    ? Math.max(0, Math.round((Date.now() - startedMs) / 60000)) : a.durationMin;
  const meta = active ? `<div class="alert-meta">
      <span>开始 <b>${esc(shortTime(a.startedAt))}</b></span>
      <span>已持续 <b>${esc(durText(liveMin))}</b></span>
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
    </div>`;

  note.textContent = zhText(`数据源：${src.name || '—'}${src.url ? `（${src.url}）` : ''}。${a.note || ''}`);
}

// ------------------------------------------------------------------ 电力
function renderPower(p) {
  const body = $('#power-body');
  const note = $('#power-note');
  if (!p || p.status === 'unavailable') {
    body.innerHTML = `<div class="alert-hero unknown"><div class="alert-title"><strong>停电计划暂不可用</strong></div>
      <div class="alert-sub">${esc(p?.error || '数据源请求失败')}</div></div>`;
    note.textContent = '请稍后刷新，或直接查看供电公司官网与基辅数字服务应用。';
    return;
  }

  // 一切「当前」判断都以设备此刻的基辅时间为准，而不是快照生成时刻。
  // 快照只提供计划表本身（时段、日期、分组），不提供会过期的当前状态。
  const nowK = kyivNowParts();
  const dateMatches = Boolean(p.today?.date && p.today.date === nowK.date);
  const n = computePowerNow(p.today, nowK.minute, dateMatches);
  let title = '计划未发布', sub = '当前分组没有适用的当日计划表', dot = '';
  if (p.emergency) { title = '紧急停电'; sub = '紧急停电期间轮流停电计划不适用，以供电公司公告为准'; dot = 'off'; }
  else if (!dateMatches) { title = '计划表待更新'; sub = '快照中的计划表不是基辅当天日期，暂不判断当前供电状态'; }
  else if (n.off === null) { title = '计划未发布'; sub = '当日计划表尚未更新或不适用'; }
  else if (n.off) { title = '当前停电中'; sub = `本时段 ${n.currentLabel || ''} · ${countdown(n) || '等待恢复'}`; dot = 'off'; }
  else { title = '当前有电'; sub = countdown(n) || '按当日计划表，当前时段未安排停电'; dot = 'on'; }

  const notice = p.emergency
    ? '<div class="notice">供电公司已启用紧急停电，下面的轮流停电时间表在此期间不适用。</div>'
    : (!dateMatches
      ? `<div class="notice info">计划表日期为 ${esc(p.today?.date || '—')}，与基辅当地日期 ${esc(nowK.date)} 不一致，可能尚未更新；当前时刻标记已隐藏，以免把旧计划表当作今日状态。</div>`
      : '');

  const addressNotice = cfg.addressResolved
    ? `<div class="notice ok">已按供电公司官方地址库确认：${esc(cfg.addressStreet)} ${esc(cfg.addressHouse || '')} → 停电分组 <b>${esc(p.group)}</b>。</div>`
    : (cfg.addressStreet
      ? `<div class="notice info">当前为手动选择的分组 <b>${esc(p.group)}</b>，未与地址 ${esc(cfg.addressStreet)} ${esc(cfg.addressHouse || '')} 绑定，请在供电公司官网核对后再据此安排用电。</div>`
      : '');

  const day = activeDay === 'tomorrow' ? p.tomorrow : p.today;
  const slots = day?.slots || [];
  const hasSchedule = Boolean(day?.hasSchedule);

  const blocks = slots.map((s) => {
    const left = Math.max(0, Math.min(100, (s.start / 1440) * 100));
    const width = Math.max(0, ((s.end - s.start) / 1440) * 100);
    return `<div class="slot" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%" title="${esc(s.label)}"></div>`;
  }).join('');
  // 竖线位置取设备当前的基辅分钟，且只在「今日计划表确实是基辅今天」时绘制。
  const showNow = activeDay === 'today' && dateMatches;
  const nowLine = showNow
    ? `<div class="now-line" style="left:${((nowK.minute / 1440) * 100).toFixed(3)}%" title="基辅时间 ${nowK.clock}"></div>` : '';

  const timeline = hasSchedule ? `<div class="timeline-wrap">
      <div class="timeline-label"><span>${activeDay === 'today' ? '今日' : '明日'} 00:00</span><span>24:00</span></div>
      <div class="timeline">${blocks}${nowLine}</div>
      <div class="timeline-ticks"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
      <div class="legend"><span><i style="background:#D94841"></i>停电</span><span><i style="background:#DFE7DA;border:1px solid #E6E9EE"></i>供电</span><span><i style="background:#1F2937"></i>${showNow ? `当前 ${nowK.clock}` : '当前时刻'}</span></div>
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

  note.textContent = zhText(`数据源：${p.source.name}；分组 ${p.group}（共 ${p.groups.length} 组）；计划更新时间 ${shortTime(p.updatedOn)}。${p.note || ''}${p.stale ? ' 上游暂时不可用，当前为缓存数据。' : ''}`);
}

// ------------------------------------------------------------------ 供水
function renderAreaLine(a) {
  if (!a) return '';
  const local = a.scope !== 'all';
  const head = local
    ? `范围：<b>${esc(a.street)} ${esc(a.house)}</b> · ${esc(a.districtZh)}（${esc(a.neighborhood)}片区），并含全市通报`
    : '范围：全基辅，所有行政区的公告';
  // 区域筛选的说明行已移除。旧快照里可能仍带 localCount / hidden / plannedStatus，
  // 这些字段一律不再渲染，避免旧数据把说明文字带回界面。
  return `<div class="area-line">${head}</div>`;
}

// 官网 <time datetime> 有两种写法：不带时区的墙上时间（本身就是基辅时间，
// 照录即可，不能再按手机本地时区解析一次）与带 Z/偏移的 ISO（换算为基辅时间）。
function waterDate(raw) {
  if (!raw) return '官网未标注日期';
  const s = String(raw);
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const p = kyivParts(s);
    if (p) return esc(p.short.replace('/', '-'));
  }
  return esc(s.replace('T', ' ').slice(5, 16));
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
      <div class="alert-sub">${esc(w?.warning || w?.error || '官网公告暂时无法读取')}，请直接打开基辅自来水公司官网查看。</div></div>`;
    // 旧快照可能仍带 water.note 说明段，界面一律不再展示该段文字。
    note.textContent = '';
    return;
  }

  // 只显示最新的 2 条。服务端已按发布时间倒序，这里再排一次以兼容旧快照；
  // 没有日期的公告排在后面，不挤掉有明确日期的新公告。
  const items = [...(w.items || [])]
    .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')))
    .slice(0, 2);
  body.innerHTML = items.length ? items.map((it) => {
    const date = waterDate(it.publishedAt);
    const showSummary = (it.scope === 'address' || it.scope === 'district') && it.summary;
    return `<div class="news-item">
      <div class="news-top">
        <span class="tag ${esc(it.tagKey || 'other')}">${esc(it.tag)}</span>
        <span class="tag scope-${esc(it.scope || 'unspecified')}">${esc(it.scopeLabel || '范围未注明')}</span>
        ${date ? `<span class="news-date">${date}</span>` : ''}
        ${it.waterRelated ? '' : '<span class="news-date">非供水专项</span>'}
      </div>
      <a class="news-title" href="${escUrl(it.url)}" target="_blank" rel="noopener noreferrer" title="打开乌克兰语官方原文">${esc(it.title)} <span class="arrow">↗</span></a>
      ${showSummary ? `<div class="news-summary">${esc(it.summary.slice(0, 180))}</div>` : ''}
    </div>`;
  }).join('') : '<div class="empty-note">当前范围内没有可显示的官方公告。可切换到「全基辅」查看全部，或致电调度 15-81 / (044) 200-73-73 查询具体门牌。</div>';

  note.textContent = zhText(`仅显示最新 2 条公告，时间均为基辅时间。数据源：${w.source.name}；检查时间 ${shortTime(w.checkedAt)}。${w.stale ? ' 上游暂时不可用，当前为缓存数据。' : ''}`);
}

function refreshWater() {
  // 快照已包含两种供水范围，切换时直接本地取用。
  const d = snapshotRaw?.waterByScope?.[cfg.waterScope];
  if (d) {
    if (state) state.water = d;
    renderWater(d);
    return;
  }
  showBanner('该范围的供水公告尚未随快照下发，正在重新读取快照…');
  refresh();
}

function renderMeta() {
  const token = state.hasOfficialToken ? '已接入官方警报接口' : '官方警报接口未配置访问令牌，当前使用免密钥公开源';
  const g = fmtLocalTime(state.snapshotGeneratedAt);
  $('#meta-line').textContent = `本页所有时间均为基辅时间 · 快照生成于 ${g}（${snapshotAgeText(state.snapshotGeneratedAt)}）· 页面每 ${pollSeconds()} 秒重新读取 · 远端约每 5 分钟更新 · ${token}`;
}

// ------------------------------------------------------------------ 袭击后果公开报道索引
// 单一信息源（新华社）校订过的结构化数字索引：发射数量、伤亡、重点目标。
// 这是事后公开报道索引，不是实时预警，不参与警报判定。
function renderAftermath(data) {
  const body = $('#aftermath-body');
  const badge = $('#aftermath-count');
  if (!body || !badge) return;
  const items = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) {
    badge.textContent = '暂无索引';
    body.innerHTML = '<div class="empty-note">暂无已校订的公开报道条目。</div>';
    return;
  }
  badge.textContent = `${items.length} 条 · 截至 ${fmtLocalTime(data.updatedAt)}`;
  body.innerHTML = items.map((it) => {
    const facts = [
      ['导弹', it.missiles],
      ['无人机', it.drones],
      ['伤亡', it.casualties],
    ].map(([k, v]) => `<div class="aftermath-fact"><span>${k}</span><b>${esc(v || '未公布')}</b></div>`).join('');
    return `<article class="aftermath-item">
        <div class="aftermath-head"><strong>${esc(it.title)}</strong><time>${esc(it.date)}</time></div>
        <div class="aftermath-source">${esc(it.source)} · ${esc(it.sourceType || '公开报道')}</div>
        <div class="aftermath-facts">${facts}</div>
        ${it.targets ? `<div class="aftermath-target"><span>重点目标</span><b>${esc(it.targets)}</b></div>` : ''}
        ${it.note ? `<p class="aftermath-note">${esc(it.note)}</p>` : ''}
        <a class="text-link" href="${escUrl(it.url)}" target="_blank" rel="noopener noreferrer">查看原文 →</a>
      </article>`;
  }).join('');
}

// ------------------------------------------------------------------ 基辅要闻
// 数据来自快照的 news 字段：服务端已从公开中文 RSS 抓取并筛好，这里只做分组、
// 分类筛选与展示。时间一律用设备实时基辅时间，避免静态快照把日期冻结在过去。
const NEWS_CAT_CLASS = { 外交: 'cat-diplomacy', 政治: 'cat-politics', 安全: '' };

function renderNews(data) {
  const body = $('#news-body');
  const badge = $('#news-count');
  const meta = $('#news-meta');
  if (!body || !badge || !meta) return;

  for (const chip of document.querySelectorAll('#news-filter .news-chip')) {
    chip.classList.toggle('active', chip.dataset.cat === newsFilter);
  }
  const status = String(data?.status || 'unavailable');
  const items = Array.isArray(data?.items) ? data.items : [];
  if (status !== 'ok' && status !== 'cached') {
    badge.textContent = '暂不可用';
    body.innerHTML = '<div class="news-empty">要闻源暂不可用，未以推测内容代替。稍后刷新即可重试。</div>';
    meta.textContent = '';
    return;
  }

  const visible = items.filter((it) => newsFilter === '全部' || it.category === newsFilter);
  if (!items.length) {
    badge.textContent = '暂无';
    body.innerHTML = '<div class="news-empty">暂无符合条件的公开报道。</div>';
    meta.textContent = status === 'cached' ? '当前显示上次成功采集的缓存内容。' : '';
    return;
  }

  let html = visible.map((it) => {
    const cat = ['外交', '政治', '安全'].includes(it.category) ? it.category : '其他';
    const cls = NEWS_CAT_CLASS[cat] || '';
    return `<article class="news-item">
        <a class="news-title" href="${escUrl(it.url)}" target="_blank" rel="noopener noreferrer"><span class="news-cat ${cls}">${esc(cat)}</span>${esc(it.title)}</a>
        ${it.summary ? `<p class="news-summary">${esc(it.summary.slice(0, 200))}</p>` : ''}
        <div class="news-meta"><span>${esc(it.source || '公开报道')}</span><time>${esc(shortTime(it.publishedAt))}</time></div>
      </article>`;
  }).join('');
  if (!html) html = `<div class="news-empty">「${esc(newsFilter)}」类暂无符合条件的公开报道。</div>`;
  body.innerHTML = html;
  badge.textContent = `${visible.length} 条${newsFilter === '全部' ? '' : ` · ${newsFilter}`}`;

  const sources = Array.isArray(data.sources) ? data.sources : [];
  const bits = [
    `采集于 ${shortTime(data.generatedAt)}（基辅时间）`,
    `信息源 ${sources.filter((s) => !s.error).length}/${sources.length} 可用`,
  ];
  if (status === 'cached') bits.push('当前为上次成功采集的缓存内容');
  else if (data.fromCache) bits.push('本轮复用十分钟内的采集结果');
  meta.textContent = bits.join(' · ');
}

// ------------------------------------------------------------------ 外交安全提醒
// 数据来自快照的 embassy 字段：服务端已聚合美国驻乌克兰使馆（RSS）与欧盟驻乌使团
// （新闻室）的公开安全/避险提醒并译好中文标题。这里只做展示（标题 + 基辅时间 + 原文
// 链接），不逐条抓正文。有提醒才显示「外交安全提醒」子区，无任何提醒时整块隐藏。
function renderEmbassy(data) {
  const wrap = $('#embassy-wrap');
  const body = $('#embassy-body');
  if (!wrap || !body) return;

  const status = String(data?.status || 'unavailable');
  const items = Array.isArray(data?.items) ? data.items : [];

  // 用户要求：有安全提醒才显示，没有则不显示。抓取失败（unavailable）且无继承数据时
  // 同样不显示，避免展示空白占位。
  if (!items.length) {
    wrap.hidden = true;
    body.innerHTML = '';
    return;
  }

  wrap.hidden = false;
  const dateLabel = (iso) => kyivParts(iso)?.short || '—';
  body.innerHTML = items.map((it) => {
    const src = esc(it.source || '外交来源');
    const cat = it.category ? `<span class="tag">${esc(it.category)}</span>` : '';
    return `
    <article class="news-item">
      <a class="news-title" href="${escUrl(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.title)} <span class="arrow">↗</span></a>
      <div class="news-meta"><span class="m-src">${src}${cat}</span><time>${esc(dateLabel(it.publishedAt))}</time></div>
    </article>`;
  }).join('');
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

// ------------------------------------------------------------------ 自动更新
// 只检查并提示，不自动下载、不自动安装，也不做 WebView 资源热替换。
// 两个来源：数据快照内的 app 版本信息与公开仓库的 latest Release。
function loadUpdateSettings() {
  try { return JSON.parse(localStorage.getItem(UPDATE_STORE_KEY) || '{}') || {}; } catch { return {}; }
}
function saveUpdateSettings() {
  try { localStorage.setItem(UPDATE_STORE_KEY, JSON.stringify(updateSettings)); } catch { /* 隐私模式下忽略 */ }
}
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function compareVersion(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}
function currentVersion() {
  return BUILD_VERSION;
}
function versionLabel(v) {
  return /^v/i.test(String(v || '')) ? String(v) : `v${v}`;
}

async function fetchJson(url, timeoutMs = 8000) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, { cache: 'no-store', ...(ctrl ? { signal: ctrl.signal } : {}) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // GitHub raw 对 .json 返回 text/plain，不能只按 Content-Type 判断；
    // 以实际内容能否解析为准，同时挡住 SPA 回退造成的整页 HTML。
    const text = await res.text();
    if (/^\s*</.test(text)) throw new Error('返回的是网页，不是接口数据');
    try { return JSON.parse(text); }
    catch { throw new Error('返回的不是 JSON'); }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeGithubRelease(j) {
  const version = String(j.tag_name || j.name || '').trim();
  if (!parseVersion(version)) throw new Error('Release 版本号无法识别');
  const asset = (j.assets || []).find((a) => a.name === 'kyiv-live-debug.apk');
  const lines = String(j.body || '').split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !/^https?:\/\//i.test(s) && !/^[#>|-]{2,}/.test(s));
  return {
    version,
    notes: lines.slice(0, 2).join(' ').replace(/[*`]/g, '').slice(0, 140) || '新版本已发布，建议更新。',
    url: asset?.browser_download_url || j.html_url || '',
    size: asset?.size || null,
    sha256: String(asset?.digest || '').replace(/^sha256:/, '') || null,
    source: 'github',
  };
}

// 快照里带有版本信息，与数据来源同一个地址，是最不容易被网络环境挡住的更新源。
function normalizeSnapshotApp(app) {
  if (!parseVersion(app.version)) throw new Error('快照中的版本号无法识别');
  return {
    version: String(app.version).replace(/^v/i, ''),
    notes: String(app.notes || '新版本已发布，建议更新。').slice(0, 140),
    url: String(app.apkUrl || ''),
    size: app.size || null,
    sha256: app.sha256 || null,
    source: 'snapshot',
  };
}

function setCheckStatus(text) { $('#ver-status').textContent = zhText(text); }
// 状态条只负责显示自动检查的结果。主页上的手动按钮一律是「刷新数据」，
// 软件更新由启动／切回前台／定时自动检查提醒，详细内容在设置页的软件更新小节。
function setUpdateStatusBar(text, kind = 'ok') {
  lastVerStatus = shortVerStatus(text);
  renderStatusRest();
}
function syncIgnoreButton() {
  const b = $('#btn-unignore');
  if (!b) return;
  const v = updateSettings.ignoredVersion;
  b.hidden = !parseVersion(v);
  if (!b.hidden) b.textContent = `取消忽略 ${versionLabel(v)}`;
}
function scheduleNextUpdateCheck(ok) {
  if (updateRetryTimer) { clearTimeout(updateRetryTimer); updateRetryTimer = null; }
  if (!ok) updateRetryTimer = setTimeout(() => { if (!document.hidden) checkForUpdates(); }, UPDATE_RETRY_MS);
}
function hideUpdateBanner() {
  $('#update-banner').hidden = true;
  const dot = $('#tab-update-dot');
  if (dot) dot.hidden = true;
  const link = $('#update-download');
  if (link) link.setAttribute('href', '#');
}
function isSameVersion(a, b) {
  return Boolean(parseVersion(a)) && compareVersion(a, b) === 0;
}

function showUpdateBanner(info) {
  $('#update-version').textContent = versionLabel(info.version);
  $('#update-source').hidden = true;
  const size = info.size ? `安装包约 ${(info.size / 1024 / 1024).toFixed(2)} MB` : '';
  $('#update-notes').textContent = zhText([info.notes, size].filter(Boolean).join('  ·  '));
  const link = $('#update-download');
  if (info.url) {
    link.href = info.url;
    link.hidden = false;
    link.textContent = '下载更新';
  } else {
    link.hidden = true;
  }
  $('#update-banner').hidden = false;
  const dot = $('#tab-update-dot');
  if (dot) dot.hidden = false;
}

function notifyUpdate(info) {
  if (!cfg.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (updateNotifiedVersion === info.version) return;
  updateNotifiedVersion = info.version;
  try {
    new Notification('基辅安全信息汇总有新版本', {
      body: `${versionLabel(info.version)} 已发布，请手动下载安装。此提示与空袭警报无关，避险以官方渠道为准。`,
      tag: 'kyiv-app-update',
    });
  } catch { /* WebView 不支持 Notification 构造函数时忽略 */ }
}

async function checkForUpdates(force = false) {
  if (updateChecking) return;
  const now = Date.now();
  if (!force && now - updateLastCheckAt < UPDATE_MIN_GAP_MS) return;
  updateChecking = true;
  updateLastCheckAt = now;
  setCheckStatus('正在检查更新…');
  setUpdateStatusBar('正在检查更新…', 'pending');
  try {
    // 两个来源并行收集，取其中最高的版本。快照与页面数据同源，最不容易被
    // 手机网络或 WebView 的跨域策略挡住；GitHub API 是权威源。
    const candidates = [];
    const errors = [];
    try {
      const j = snapshotRaw || await fetchJson(snapshotFetchUrl(), 12000);
      if (j?.app?.version) candidates.push(normalizeSnapshotApp(j.app));
    } catch (err) { errors.push(`快照 ${err.message}`); }
    try {
      candidates.push(normalizeGithubRelease(await fetchJson(RELEASE_API, 9000)));
    } catch (err) { errors.push(`GitHub ${err.message}`); }
    if (!candidates.length) throw new Error(errors.join('；') || '更新源均不可用');
    candidates.sort((a, b) => compareVersion(b.version, a.version));
    const info = candidates[0];

    const checkedAt = kyivParts(new Date().toISOString())?.clock || '—';
    const current = currentVersion();

    if (compareVersion(info.version, current) > 0) {
      updateInfo = info;
      const ignored = isSameVersion(updateSettings.ignoredVersion, info.version);
      const snoozed = isSameVersion(snoozedVersion, info.version);
      const status = `发现 ${versionLabel(info.version)}（${checkedAt} 检查），请点底部「软件更新」查看${ignored && !force ? '；此版本已忽略' : ''}`;
      setCheckStatus(status);
      setUpdateStatusBar(status, 'new');
      if (force || (!ignored && !snoozed)) showUpdateBanner(info);
      notifyUpdate(info);
    } else {
      updateInfo = null;
      hideUpdateBanner();
      const status = `已是最新版本 ${versionLabel(current)}（${checkedAt} 检查）`;
      setCheckStatus(status);
      setUpdateStatusBar(status, 'ok');
    }
    // 只有成功才占用 5 分钟节流；失败时清零并安排 1 分钟后重试。
    updateLastCheckAt = Date.now();
    scheduleNextUpdateCheck(true);
  } catch (err) {
    updateLastCheckAt = 0;
    const msg = `检查失败：${err.message}。将在 1 分钟后自动重试，也可在「软件更新」页手动检查。`;
    setCheckStatus(msg);
    setUpdateStatusBar(msg, 'error');
    scheduleNextUpdateCheck(false);
  } finally {
    updateChecking = false;
  }
}

// ------------------------------------------------------------------ 页签导航
// 底部只有主页、基辅要闻、设置三个页签。软件更新不再单设页签，它是设置页
// 下方的第二个区块：切到设置时两个相邻区块一起显示，形成一个滚动页面。
function switchView(name) {
  const wanted = name === 'update' ? 'settings' : name;
  const target = ['home', 'news', 'settings'].includes(wanted) ? wanted : 'home';
  for (const el of document.querySelectorAll('.view')) {
    el.hidden = target === 'settings'
      ? !['view-settings', 'view-update'].includes(el.id)
      : el.id !== `view-${target}`;
  }
  for (const tab of document.querySelectorAll('.tabbar .tab')) {
    const on = tab.dataset.view === target;
    tab.classList.toggle('active', on);
    if (on) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  currentView = target;
  // 数据来源与更新检查两条状态提醒只在首页显示；用 body 的视图属性交给 CSS，
  // 不改动各状态条自身的 hidden 状态，切回首页时原样恢复。
  document.body.dataset.view = target;
  window.scrollTo(0, 0);
  if (target === 'news') renderNews(snapshotRaw?.news);
  if (target === 'settings') {
    fillSettingsForm();
    syncIgnoreButton();
  }
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

function fillSettingsForm() {
  $('#cfg-interval').value = String(cfg.interval);
  $('#cfg-group').value = cfg.group;
  syncNotificationState();
}
function syncNotificationState() {
  const el = $('#notify-state');
  if (!('Notification' in window)) return;
  el.textContent = Notification.permission === 'granted'
    ? (cfg.notify ? '已开启：警报生效或解除时会提示' : '系统已授权，但本页提醒未开启')
    : (Notification.permission === 'denied' ? '已在浏览器中拒绝，需到站点设置里恢复' : '未开启');
}

function pollSeconds() {
  // 远端快照约每 5 分钟更新，页面 60 秒重读一次足够，再快只是重复下载同一份文件。
  return Math.max(60, Number(cfg.interval) || 60);
}
function restartPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, pollSeconds() * 1000);
}

// ------------------------------------------------------------------ 事件
// 主页上的手动按钮只刷新数据，不触发软件更新检查。版本检查由启动、切回
// 前台与每 30 分钟的自动任务完成，手动查看走底部「软件更新」标签页。
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
document.querySelectorAll('.tabbar .tab').forEach((tab) => {
  tab.addEventListener('click', () => switchView(tab.dataset.view));
});
document.querySelectorAll('#news-filter .news-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    newsFilter = chip.dataset.cat || '全部';
    renderNews(snapshotRaw?.news);
  });
});
$('#btn-close').addEventListener('click', () => switchView('home'));
$('#btn-cancel').addEventListener('click', () => switchView('home'));

$('#group-select').addEventListener('change', (e) => {
  cfg.group = e.target.value;
  saveCfg();
  $('#cfg-group').value = cfg.group;
  // 快照内含全部分组，切换时本地取用即可，不必重新下载整份文件。
  if (snapshotRaw) {
    const p = snapshotRaw.powerByGroup?.[cfg.group];
    if (p) {
      state.power = p;
      renderPower(p);
      renderMeta();
      return;
    }
  }
  refresh();
});

$('#settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  cfg.group = $('#cfg-group').value || cfg.group;
  cfg.interval = Number($('#cfg-interval').value) || 60;
  saveCfg();
  switchView('home');
  setDataSourceBar();
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

// ------------------------------------------------------------------ 更新提示交互
$('#btn-check-update').addEventListener('click', () => checkForUpdates(true));
$('#btn-unignore').addEventListener('click', () => {
  delete updateSettings.ignoredVersion;
  saveUpdateSettings();
  syncIgnoreButton();
  setCheckStatus('已取消忽略，正在重新检查…');
  checkForUpdates(true);
});
$('#update-later').addEventListener('click', () => {
  snoozedVersion = updateInfo?.version || '';
  hideUpdateBanner();
  const msg = '已选择稍后处理，下次启动应用会再次提示。';
  setCheckStatus(msg);
  setUpdateStatusBar(msg, 'ok');
});
$('#update-ignore').addEventListener('click', () => {
  if (!updateInfo) return;
  updateSettings.ignoredVersion = updateInfo.version;
  saveUpdateSettings();
  syncIgnoreButton();
  hideUpdateBanner();
  const msg = `已忽略 ${versionLabel(updateInfo.version)}，之后不再自动提示；可在「软件更新」页点「取消忽略」恢复。`;
  setCheckStatus(msg);
  setUpdateStatusBar(msg, 'ok');
});
$('#btn-page-reload').addEventListener('click', () => location.reload());

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { refresh(); checkForUpdates(); }
});

// 浏览器/PWA 的资源更新与 APK 版本更新是两条独立路径：
// Service Worker 发现新缓存版本时提示刷新页面，不静默打断用户当前操作。
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !isNative) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const next = reg.installing;
      if (!next) return;
      next.addEventListener('statechange', () => {
        if (next.state === 'installed' && navigator.serviceWorker.controller) {
          $('#page-update').hidden = false;
        }
      });
    });
  }).catch(() => { /* 不影响主功能 */ });
}

// ------------------------------------------------------------------ 启动
// 初次进入固定在主页，三个页签的显隐与高亮统一由 switchView 管理。
switchView('home');
tickClock();
setInterval(tickClock, 1000);

(function boot() {
  $('#cfg-interval').value = String(cfg.interval);
  $('#ver-current').textContent = `当前版本 ${versionLabel(BUILD_VERSION)}${isNative ? '（APK 内置）' : ''}`;
  setDataSourceBar();
  syncIgnoreButton();
  refresh();
  restartPoll();
  // 启动后稍延迟检查，避免与首页首次数据请求抢连接；成功后每 30 分钟一次，
  // 切回前台与点击刷新另有触发；失败会在 1 分钟后自动重试。
  setTimeout(() => checkForUpdates(), 1200);
  setInterval(() => { if (!document.hidden) checkForUpdates(); }, UPDATE_CHECK_INTERVAL_MS);
})();
