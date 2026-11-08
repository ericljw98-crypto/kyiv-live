'use strict';

// 编译期由 scripts/write-version.mjs 写入。APK 内当前版本必须是本地常量，
// 不能从服务端或 Service Worker 缓存里取，否则会被新版本反向覆盖而永远检测不到更新。
const BUILD_VERSION = '1.3.2';
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
function tickClock() {
  const p = kyivParts(new Date().toISOString());
  $('#clock').textContent = p ? p.full : '—';
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
const AFTERMATH_SOURCE = '新华社';
function singleSourceAftermath(data) {
  if (!data || !Array.isArray(data.items)) return null;
  const items = data.items
    .filter((it) => String(it.source || '').startsWith(AFTERMATH_SOURCE))
    // 旧快照把转载页写进来源名，统一收敛为同一家。
    .map((it) => ({ ...it, source: AFTERMATH_SOURCE }))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, 1);
  return items.length ? { ...data, items } : null;
}
async function resolveAftermath(fromSnapshot) {
  const remote = singleSourceAftermath(fromSnapshot);
  let builtin = null;
  try {
    const local = await fetchJson(new URL('aftermath.json', location.href).toString(), 6000);
    builtin = singleSourceAftermath(local?.schema === 1 ? local : null);
  } catch { /* 内置副本缺失时只用快照 */ }
  if (!remote && !builtin) return null;
  const base = remote?.items[0] || builtin.items[0];
  const patch = builtin?.items[0]?.date === base.date ? builtin.items[0] : null;
  // 内容由内置校订副本覆盖时，更新时间与口径说明也一并采用内置值，
  // 避免角标显示旧快照的时间戳。
  const meta = patch ? builtin : (remote || builtin);
  return { ...meta, items: [patch ? { ...base, ...patch } : base] };
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
function setDataSourceBar() {
  const bar = $('#data-source-bar');
  if (!bar) return;
  const iso = state?.snapshotGeneratedAt || snapshotRaw?.generatedAt;
  const ageMin = iso ? Math.floor((Date.now() - Date.parse(iso)) / 60000) : 0;
  const stale = Number.isFinite(ageMin) && ageMin >= 15;
  bar.dataset.kind = stale ? 'stale' : 'ok';
  $('#data-source-text').textContent = iso
    ? `数据来源：远端 GitHub 静态快照 · 生成于 ${fmtLocalTime(iso)}（${snapshotAgeText(iso)}）· ${stale ? '已超过 15 分钟未更新，数据可能过期' : '约每 5 分钟更新'}；警报以官方渠道为准`
    : '数据来源：远端 GitHub 静态快照 · 正在读取…';
  bar.hidden = false;
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
  $('#meta-line').textContent = '远端快照未连接';
}

function renderAll() {
  if (!state) return;
  renderAlert(state.alert);
  renderPower(state.power);
  renderWater(state.water);
  renderAftermath(snapshotRaw?.aftermath);
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
    <div class="scope-note">本模块汇总<strong>官方公开发布的避险预警</strong>：区域级警报状态、红／黄级别、威胁类型标签（如导弹威胁、无人机威胁）与警报起止时间，用于提醒提前避险。非官方渠道传播的来袭坐标、航迹、拦截动态等不属于本页采集范围。</div>`;

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

  const n = p.now || {};
  let title = '计划未发布', sub = '当前分组没有适用的当日计划表', dot = '';
  if (p.emergency) { title = '紧急停电'; sub = '紧急停电期间轮流停电计划不适用，以供电公司公告为准'; dot = 'off'; }
  else if (!p.dateMatches || n.off === null) { title = '计划未发布'; sub = '当日计划表尚未更新或不适用'; }
  else if (n.off) { title = '当前停电中'; sub = `本时段 ${n.currentLabel || ''} · ${countdown(n) || '等待恢复'}`; dot = 'off'; }
  else { title = '当前有电'; sub = countdown(n) || '按当日计划表，当前时段未安排停电'; dot = 'on'; }

  const notice = p.emergency
    ? '<div class="notice">供电公司已启用紧急停电，下面的轮流停电时间表在此期间不适用。</div>'
    : (!p.dateMatches
      ? `<div class="notice info">计划表日期为 ${esc(p.today?.date || '—')}，与基辅当地日期 ${esc(p.kyivDate || '—')} 不一致，可能尚未更新。</div>`
      : '');

  const addressNotice = cfg.addressResolved
    ? `<div class="notice ok">已按供电公司官方地址库确认：${esc(cfg.addressStreet)} ${esc(cfg.addressHouse || '')} → 停电分组 <b>${esc(p.group)}</b>。</div>`
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

  note.textContent = zhText(`数据源：${p.source.name}；分组 ${p.group}（共 ${p.groups.length} 组）；计划更新时间 ${shortTime(p.updatedOn)}。${p.note || ''}${p.stale ? ' 上游暂时不可用，当前为缓存数据。' : ''}`);
}

// ------------------------------------------------------------------ 供水
function renderAreaLine(a) {
  if (!a) return '';
  const local = a.scope !== 'all';
  const head = local
    ? `范围：<b>${esc(a.street)} ${esc(a.house)}</b> · ${esc(a.districtZh)}（${esc(a.neighborhood)}片区），并含全市通报`
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
      <div class="alert-sub">${esc(w?.warning || w?.error || '官网公告暂时无法读取')}，请直接打开基辅自来水公司官网查看。</div></div>`;
    note.textContent = zhText(w?.note || '');
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
      <a class="news-title" href="${escUrl(it.url)}" target="_blank" rel="noopener noreferrer" title="打开乌克兰语官方原文">${esc(it.title)} <span class="arrow">↗</span></a>
      ${showSummary ? `<div class="news-summary">${esc(it.summary.slice(0, 180))}</div>` : ''}
    </div>`;
  }).join('') : '<div class="empty-note">当前范围内没有可显示的官方公告。可切换到「全基辅」查看全部，或致电调度 15-81 / (044) 200-73-73 查询具体门牌。</div>';

  note.textContent = zhText(`数据源：${w.source.name}；检查时间 ${shortTime(w.checkedAt)}。${w.note || ''}${w.stale ? ' 上游暂时不可用，当前为缓存数据。' : ''}`);
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
  $('#meta-line').textContent = `快照生成于 ${g}（${snapshotAgeText(state.snapshotGeneratedAt)}）· 页面每 ${pollSeconds()} 秒重新读取 · 远端约每 5 分钟更新 · ${token}`;
}

// ------------------------------------------------------------------ 袭击后果公开报道索引
// 只展示袭击结束后已由官方通报或公开媒体发布的汇总数字，逐条保留来源与口径。
// 这是事后报道索引，不参与警报判定，也不会被当作实时状态使用。
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
// 每次检查都给出主界面可见结果，包括「已是最新」和失败原因，
// 避免出现「什么都没发生」被当成功能失效。发现新版本时，状态条提供
// 直达「软件更新」页的入口，因为详细更新卡片已不再堆在主页顶部。
function setUpdateStatusBar(text, kind = 'ok') {
  const bar = $('#update-status-bar');
  if (!bar) return;
  $('#update-status-text').textContent = zhText(text);
  bar.dataset.kind = kind;
  bar.hidden = false;
  const action = $('#btn-update-retry');
  if (!action) return;
  if (kind === 'new') {
    action.hidden = false;
    action.textContent = '查看更新';
  } else if (kind === 'error' || kind === 'stale') {
    action.hidden = false;
    action.textContent = '重新检查';
  } else {
    action.hidden = true;
  }
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
  $('#update-source').textContent = ({
    github: '来源：GitHub Release',
    snapshot: '来源：GitHub 数据快照',
  })[info.source] || '来源：更新服务';
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
    const from = ({
      github: 'GitHub Release', snapshot: 'GitHub 数据快照',
    })[info.source] || '更新服务';
    const current = currentVersion();

    if (compareVersion(info.version, current) > 0) {
      updateInfo = info;
      const ignored = isSameVersion(updateSettings.ignoredVersion, info.version);
      const snoozed = isSameVersion(snoozedVersion, info.version);
      const status = `发现 ${versionLabel(info.version)}（${checkedAt} 检查 · ${from}）${ignored && !force ? '，已忽略' : ''}`;
      setCheckStatus(status);
      setUpdateStatusBar(status, 'new');
      if (force || (!ignored && !snoozed)) showUpdateBanner(info);
      notifyUpdate(info);
    } else {
      updateInfo = null;
      hideUpdateBanner();
      const status = `已是最新版本 ${versionLabel(current)}（${checkedAt} 检查 · ${from}）`;
      setCheckStatus(status);
      setUpdateStatusBar(status, 'ok');
    }
    // 只有成功才占用 5 分钟节流；失败时清零并安排 1 分钟后重试。
    updateLastCheckAt = Date.now();
    scheduleNextUpdateCheck(true);
  } catch (err) {
    updateLastCheckAt = 0;
    const msg = `检查失败：${err.message}。将在 1 分钟后自动重试。`;
    setCheckStatus(msg);
    setUpdateStatusBar(msg, 'error');
    scheduleNextUpdateCheck(false);
  } finally {
    updateChecking = false;
  }
}

// ------------------------------------------------------------------ 页签导航
// 底部只有主页、设置、软件更新三个页签。原先警报／电力／供水／避险四个
// 锚点合并为主页一个滚动视图，设置和版本更新各自成为独立页面。
function switchView(name) {
  const target = ['home', 'settings', 'update'].includes(name) ? name : 'home';
  for (const el of document.querySelectorAll('.view')) {
    el.hidden = el.id !== `view-${target}`;
  }
  for (const tab of document.querySelectorAll('.tabbar .tab')) {
    const on = tab.dataset.view === target;
    tab.classList.toggle('active', on);
    if (on) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  currentView = target;
  window.scrollTo(0, 0);
  if (target === 'settings') fillSettingsForm();
  if (target === 'update') syncIgnoreButton();
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
  const sample = $('#cfg-source-example');
  if (sample) sample.textContent = SNAPSHOT_URL;
  syncNotificationState();
}
function syncNotificationState() {
  const el = $('#notify-state');
  if (!('Notification' in window)) { el.textContent = '当前环境不支持浏览器通知，APK 内请使用官方警报应用的推送。'; return; }
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
// 手动刷新同时强制检查一次更新，不受自动检查的 5 分钟节流限制。
$('#btn-refresh').addEventListener('click', () => { refresh(); checkForUpdates(true); });
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
$('#btn-update-retry').addEventListener('click', () => {
  if ($('#update-status-bar').dataset.kind === 'new') switchView('update');
  else checkForUpdates(true);
});
$('#btn-data-check').addEventListener('click', () => { refresh(); checkForUpdates(true); });
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
  const sample = $('#cfg-source-example');
  if (sample) sample.textContent = SNAPSHOT_URL;
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
