'use strict';

const { request } = require('./fetch');
const { cached } = require('./cache');
const {
  toChinese, translateTitle, summarize, zhStreet, zhHouse, officialStreet, PLACE,
} = require('./zh');

const YASNO = 'https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages';
const TRYVOHA_ALERTS = 'https://tryvoha.online/api/v1/alerts';
const UBILLING = 'https://ubilling.net.ua/aerialalerts/';
const ALERTS_UA = 'https://api.alerts.in.ua/v1/alerts/active.json';
const VODOKANAL_HOME = 'https://vodokanal.kyiv.ua/';
const VODOKANAL_NEWS = 'https://vodokanal.kyiv.ua/news';
const VODOKANAL_SHUTOFFS = 'https://vodokanal.kyiv.ua/shutoffs';
const VODOKANAL_PLANNED = 'https://vodokanal.kyiv.ua/shutoffs?type=planned';
const YASNO_ADDRESS_API = 'https://app.yasno.ua/api/blackout-service/public/shutdowns/addresses/v2';

// 供水公告的默认关注区域。行政区、旧街名与区内地名的依据：
// uk.wikipedia.org «Вулиця Добровольчих батальйонів (Київ)»、
// «Печерський район (Київ)»。这是关键词匹配，不是官方行政区划数据。
const AREA = {
  streetUk: 'вул. Добровольчих батальйонів',
  house: '44А',
  districtUk: 'Печерський район',
  districtZh: '佩切尔斯基区',
  neighborhoodUk: 'Звіринець',
  oldStreetUk: 'вул. Панфіловців',
  addressTerms: [
    'добровольчих батальйонів', 'добровольчих батальйонiв', 'панфіловців',
    'панфиловців', '44а на вул. добровольчих', 'звіринець',
  ],
  districtTerms: [
    'печерськ', 'печерська', 'печерському', 'звіринець', 'видубичі',
    'верхня теличка', 'саперне поле', 'чорна гора', 'хрести',
    'черепанова гора', 'берестове', 'клов', 'липки', 'бессарабка',
    'лаврська', 'івана мазепи', 'омеляновича-павленка', 'старонаводницька',
    'бастіонна', 'бойчука', 'міхновського', 'лесі українки',
    'арсенальна', 'києво-печерської лаври', 'мистецький арсенал',
  ],
  otherTerms: [
    'лівобережн', 'правобережн', 'оболон', 'голосіїв', 'куренів',
    'подільськ', 'святошин', 'солом’ян', 'солом\'ян', 'дарниц',
    'троєщина', 'позняки', 'осокорки', 'березняки', 'деснянськ',
    'дніпровськ', 'левка лук', 'скляренка', 'івасюка',
    'героїв дніпра', 'лук’яненка', 'шевченківськ',
  ],
  citywideTerms: [
    'усіх районах столиці', 'всіх районах столиці', 'всієї столиці',
    'у цілому по місту', 'мережах києва', 'водопостачання києва',
    'тиск у водопровідних', 'по всій території міста', 'загальноміськ',
    'водопостачання столиці', 'києва повністю відновлено',
    'в усіх районах', 'по всьому місту',
  ],
};

const SRC_POWER = {
  id: 'yasno', name: 'YASNO / DTEK 基辅市停电计划',
  official: true, url: 'https://yasno.ua/schedule-turn-off-electricity',
};
const SRC_ALERTS_UA = {
  id: 'alerts-in-ua', name: 'alerts.in.ua 官方警报接口',
  official: true, url: 'https://alerts.in.ua/',
};
const SRC_TRYVOHA = {
  id: 'tryvoha', name: 'Tryvoha 公开警报聚合',
  official: false, url: 'https://tryvoha.online/',
};
const SRC_UBILLING = {
  id: 'ubilling', name: 'Ubilling 公开警报状态',
  official: false, url: 'https://ubilling.net.ua/aerialalerts/',
};
const SRC_WATER = {
  id: 'kyivvodokanal', name: '基辅自来水公司官网公告',
  official: true, url: 'https://vodokanal.kyiv.ua/news',
};

// ---------------------------------------------------------------- utilities

// 与客户端一致，不依赖 ICU 时区名（部分环境只有 Europe/Kiev）。
function kyivOffsetMs(utcMs) {
  const year = new Date(utcMs).getUTCFullYear();
  const lastSunday = (month) => {
    const last = new Date(Date.UTC(year, month + 1, 0));
    return Date.UTC(year, month, last.getUTCDate() - last.getUTCDay(), 1);
  };
  return (utcMs >= lastSunday(2) && utcMs < lastSunday(9) ? 3 : 2) * 3600000;
}
function kyivNow(date = new Date()) {
  const t = date.getTime() + kyivOffsetMs(date.getTime());
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return {
    minute: d.getUTCHours() * 60 + d.getUTCMinutes(),
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    clock: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
    iso: date.toISOString(),
  };
}

function hhmm(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function clean(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levelInfo(level) {
  if (level === 'red') return {
    level: 'red', threat: '导弹威胁 / 空袭警报',
    hint: '红色级别，通常与导弹威胁或常规空袭警报相关',
  };
  if (level === 'yellow') return {
    level: 'yellow', threat: '无人机威胁',
    hint: '黄色级别，通常指无人机威胁预警',
  };
  return { level: null, threat: '未标注威胁类型', hint: '' };
}

function durationMinutes(iso, nowIso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.parse(nowIso) - t) / 60000));
}

// ---------------------------------------------------------------- air alert

// alerts.in.ua 官方接口的结构化威胁类型枚举（见 devs.alerts.in.ua 的 Alert.threats）
const THREAT_LABELS = {
  drones: '无人机威胁',
  cruise_missiles: '巡航导弹威胁',
  ballistic_missiles: '弹道导弹威胁',
  unspecified_missiles: '导弹威胁',
  guided_aerial_bombs: '制导航空炸弹威胁',
  tactic_aircraft_activity: '战术航空器活动',
  strategic_aircraft_activity: '战略航空器活动',
  mig31k_departure: '米格-31K 起飞预警',
  air_defense: '防空活动预警',
  unknown: '未指明威胁',
};

async function fromOfficial(token) {
  const raw = await cached('alerts-ua', 20000, () => request(ALERTS_UA, { bearer: token }));
  const list = Array.isArray(raw.alerts) ? raw.alerts : [];
  const kyiv = list.find(a =>
    String(a.location_uid) === '31' || /м\.\s*Київ/i.test(a.location_title || '')
  );
  const now = kyivNow();
  const meta = {
    source: SRC_ALERTS_UA, checkedAt: now.iso,
    stale: Boolean(raw.stale), warning: raw.stale ? raw.warning : null,
  };
  if (!kyiv) {
    return {
      status: 'ok', state: 'clear', level: null, threat: null, hint: '',
      startedAt: null, durationMin: null, threatTypes: [],
      note: '官方接口当前未列出基辅市的生效警报', ...meta,
    };
  }

  // 用结构化字段，不从公告文本猜测武器类型
  const threats = Array.isArray(kyiv.threats) ? kyiv.threats : [];
  const types = [...new Set(threats.map((t) => t.threat_type).filter(Boolean))];
  const labels = [...new Set(types.map((t) => THREAT_LABELS[t] || t))];
  const level = (kyiv.alert_level === 'red' || kyiv.alert_level === 'yellow')
    ? kyiv.alert_level
    : (types.some((t) => /missile|mig31|aircraft/i.test(t)) ? 'red'
      : types.includes('drones') ? 'yellow' : null);
  const info = levelInfo(level);
  const sourceMessages = threats.map((t) => t.source_message).filter(Boolean);
  const officialText = [kyiv.notes, ...sourceMessages].filter(Boolean).join('；');

  return {
    status: 'ok', state: 'active', level,
    threat: labels.length ? labels.join('、') : (level ? info.threat : '未标注威胁类型'),
    hint: officialText ? toChinese(officialText, 200) : info.hint,
    threatTypes: types,
    startedAt: kyiv.started_at || null,
    durationMin: durationMinutes(kyiv.started_at, now.iso),
    note: '官方接口发布的结构化威胁类型与警报级别；不含来袭目标位置、航迹与拦截信息',
    ...meta,
  };
}

async function fromTryvoha() {
  // 与 alerts.in.ua 官方源保持同一新鲜度。服务端缓存使多个客户端共享一次上游请求，
  // 避免把免密钥公开源的调用频率抬高；前端最快刷新档位与此对齐。
  const raw = await cached('tryvoha', 20000, () => request(TRYVOHA_ALERTS));
  const list = Array.isArray(raw.alerts) ? raw.alerts : [];
  const kyiv = list.find(a => a.slug === 'kyiv');
  const now = kyivNow();
  const info = levelInfo(kyiv && kyiv.level);
  return {
    status: 'ok', state: kyiv ? 'active' : 'clear',
    level: kyiv ? info.level : null,
    threat: kyiv ? info.threat : null,
    hint: kyiv ? info.hint : '',
    startedAt: kyiv ? (kyiv.started_at || null) : null,
    durationMin: kyiv ? durationMinutes(kyiv.started_at, now.iso) : null,
    source: SRC_TRYVOHA,
    updatedAt: raw.updated_at || null,
    checkedAt: now.iso,
    note: '区域级警报状态与官方发布的威胁类型级别；不含来袭目标位置、航迹与拦截信息',
    stale: Boolean(raw.stale), warning: raw.stale ? raw.warning : null,
  };
}

async function fromUbilling() {
  const raw = await cached('ubilling', 60000, () => request(UBILLING));
  const states = raw.states || {};
  const keys = Object.keys(states);
  const key = keys.find(k => /^м\.\s*Київ$/i.test(k))
    || keys.find(k => /Київ/i.test(k) && !/область/i.test(k));
  if (!key) throw new Error('ubilling feed has no Kyiv city entry');
  const active = Boolean(states[key].alertnow);
  const now = kyivNow();
  return {
    status: 'ok', state: active ? 'active' : 'clear',
    level: null, threat: null, hint: '',
    startedAt: null, durationMin: null,
    source: SRC_UBILLING, checkedAt: now.iso,
    note: '该源仅提供布尔状态，不区分威胁类型与警报级别',
    stale: Boolean(raw.stale), warning: raw.stale ? raw.warning : null,
  };
}

async function getAlert() {
  const token = (process.env.ALERTS_UA_TOKEN || '').trim();
  const warnings = [];
  if (token) {
    try {
      const r = await fromOfficial(token);
      return { ...r, warnings };
    } catch (err) {
      warnings.push(`官方接口不可用，已降级到公开源：${err.message}`);
    }
  }
  try {
    const r = await fromTryvoha();
    return { ...r, warnings };
  } catch (err) {
    warnings.push(`Tryvoha 不可用：${err.message}`);
  }
  try {
    const r = await fromUbilling();
    return { ...r, warnings };
  } catch (err) {
    warnings.push(`Ubilling 不可用：${err.message}`);
  }
  return {
    status: 'unavailable', state: 'unknown', level: null, threat: null,
    hint: '', startedAt: null, durationMin: null,
    source: SRC_TRYVOHA, checkedAt: kyivNow().iso, warnings,
    note: '所有警报数据源均不可用。请以当地警报器与官方空袭警报应用为准',
  };
}

// ---------------------------------------------------------------- electricity

function normaliseDay(d) {
  if (!d) return null;
  return {
    date: String(d.date || '').slice(0, 10),
    status: d.status || 'Unknown',
    // YASNO: Definite = 确定停电，NotPlanned = 不安排停电（有电）
    slots: (Array.isArray(d.slots) ? d.slots : [])
      .filter(s => s.type === 'Definite')
      .map(s => ({ start: Number(s.start), end: Number(s.end), label: `${hhmm(s.start)}–${hhmm(s.end)}` })),
    hasSchedule: d.status === 'ScheduleApplies' && Array.isArray(d.slots) && d.slots.length > 0,
  };
}

function computeNow(day, minute, dateMatches) {
  if (!day || !day.hasSchedule || !dateMatches) {
    return { off: null, nextAt: null, nextType: null, minutesToNext: null, currentEnd: null };
  }
  const current = day.slots.find(s => minute >= s.start && minute < s.end) || null;
  const boundaries = [];
  for (const s of day.slots) {
    boundaries.push({ at: s.start, type: 'off' });
    boundaries.push({ at: s.end, type: 'on' });
  }
  const next = boundaries
    .filter(b => b.at > minute)
    .sort((a, b) => a.at - b.at)[0] || null;
  return {
    off: Boolean(current),
    nextAt: next ? next.at : null,
    nextType: next ? next.type : null,
    minutesToNext: next ? next.at - minute : null,
    currentEnd: current ? current.end : null,
    currentLabel: current ? `${hhmm(current.start)}–${hhmm(current.end)}` : null,
  };
}

async function getPower(group) {
  const raw = await cached('yasno', 5 * 60 * 1000, () => request(YASNO));
  const groups = Object.keys(raw).filter(k => raw[k] && raw[k].today).sort((a, b) => {
    const [an, as] = a.split('.').map(Number);
    const [bn, bs] = b.split('.').map(Number);
    return an - bn || as - bs;
  });
  if (!groups.length) throw new Error('YASNO 返回中没有可用分组');
  const selected = groups.includes(group) ? group : groups[0];
  const entry = raw[selected];
  const now = kyivNow();
  const today = normaliseDay(entry.today);
  const tomorrow = normaliseDay(entry.tomorrow);
  const emergency = groups.some(k =>
    /Emergency/i.test(raw[k].today?.status || '') || /Emergency/i.test(raw[k].tomorrow?.status || '')
  ) || /Emergency/i.test(today?.status || '') || /Emergency/i.test(tomorrow?.status || '');
  const noShutdowns = /NoShutdowns/i.test(today?.status || '');

  return {
    status: 'ok', source: SRC_POWER,
    group: selected, groups,
    today, tomorrow,
    dateMatches: today ? today.date === now.date : false,
    emergency, noShutdowns,
    updatedOn: entry.updatedOn || null,
    now: computeNow(today, now.minute, today ? today.date === now.date : false),
    kyivClock: now.clock, kyivDate: now.date,
    note: '按分组的轮流停电计划。紧急停电期间计划表不适用，请查看 DTEK / 基辅数字服务应用公告',
    stale: Boolean(raw.stale), warning: raw.stale ? raw.warning : null,
  };
}

// ---------------------------------------------------------------- water notices

function classify(slug, title) {
  const s = `${String(slug || '')} ${String(title || '')}`.toLowerCase();
  // 只在明确的供水词上做判断，避免把公司名里的「вод」误当作供水状态
  const waterWord = /vodopostac|vodopostach|vodoprovid|водопостач|водопровід|водопостачання/.test(s);
  // 「атак / atak」只说明成因，不是供水状态，不能据此判为中断
  if (/pereboyi|перебої|припинен|pripinen|znestrumlennia|bez-vodi|nemae-vodi|vidsutn|avariia/.test(s)) {
    return { key: 'disrupted', label: '供水受影响' };
  }
  if (waterWord && /vidnovleno|vidnovliuvati|vidnovlennia|відновлено|відновлює/.test(s)) {
    return { key: 'restored', label: '恢复供水' };
  }
  if (/statnomu-rezimi|штатному режимі|працюють у штатному/.test(s)) {
    return { key: 'normal', label: '运行正常' };
  }
  if (/promivka|promyvka|profilakt|планов|промив/.test(s)) {
    return { key: 'planned', label: '计划检修' };
  }
  return { key: 'other', label: '其他公告' };
}

function isWaterRelated(text) {
  return /vodopostac|vodopostach|vodoprovid|водопостач|водопровід|водопостачання/i.test(String(text || ''));
}

// 按关键词判定公告与本地址的空间关系。优先级：本地址 > 本区 > 明确的其他区
// > 全市 > 正文含地址（判为其他区）> 范围未注明。关键词表不是官方行政区划数据，
// 官方也不提供按行政区检索的接口，因此该判定只用于筛掉明显无关的其他区公告。
function hitTerm(text, terms) {
  return terms.find((t) => text.includes(t)) || '';
}
function areaScope(text, kind = 'news') {
  const s = ` ${String(text || '').toLowerCase()} `;
  let m = hitTerm(s, AREA.addressTerms);
  if (m) return { key: 'address', label: '本地址', matched: m };
  m = hitTerm(s, AREA.districtTerms);
  if (m) return { key: 'district', label: `本区 · ${AREA.districtZh}`, matched: m };
  m = hitTerm(s, AREA.citywideTerms);
  if (m) return { key: 'citywide', label: '全市通报', matched: m };
  m = hitTerm(s, AREA.otherTerms);
  if (m) return { key: 'other', label: '其他区域', matched: m };
  // 官方停水卡片列的是具体停水地址，未命中本区词即属其他区；
  // 新闻正文里偶尔出现地址（举例、办公地点），不能据此判定为其他区。
  if (kind !== 'news' && /(вул\.|вулиц|просп|провул|буд\.|№\s*\d)/.test(s)) {
    return { key: 'other', label: '其他区域', matched: '正文含具体地址' };
  }
  return { key: 'unspecified', label: '范围未注明', matched: '' };
}

// 官方「Планові та аварійні відключення」页按卡片列出停水地址与日期，
// 卡片形如 <div class="group block p-5 border-2 border-primary ...">。
function parseShutoffs(html, url, kind) {
  const out = [];
  const parts = String(html || '').split(/<div class="group block p-5[^"]*"[^>]*>/).slice(1);
  for (const part of parts.slice(0, 12)) {
    const block = part.split(/<div class="bg-primary-light/)[0];
    const dm = block.match(/<span[^>]*>\s*(\d{2})\.(\d{2})\.(\d{4})\s*<\/span>/);
    if (!dm) continue;
    const paragraphs = [...block.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((p) => clean(p[1])).filter(Boolean);
    const lists = [...block.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
      .map((li) => clean(li[1])).filter(Boolean);
    const body = [...paragraphs, ...lists].join(' ');
    if (!body) continue;
    const title = (paragraphs[0] || body).slice(0, 110);
    const scope = areaScope(body, kind);
    out.push({
      title, summary: body.slice(0, 300), url,
      publishedAt: `${dm[3]}-${dm[2]}-${dm[1]}`,
      tag: kind === 'planned' ? '计划停水' : '事故停水',
      tagKey: kind === 'planned' ? 'planned' : 'disrupted',
      waterRelated: true, kind,
      scope: scope.key, scopeLabel: scope.label, matched: scope.matched,
    });
  }
  return out;
}

// 新闻列表页只有标题；判定是否涉及全市或某个区需读正文。
function extractArticleText(html) {
  const txt = clean(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' '));
  const marker = '| Новини |';
  const start = txt.indexOf(marker);
  const from = start >= 0 ? start + marker.length : 0;
  const end = txt.indexOf('Надійне водопостачання', from);
  return txt.slice(from, end > from ? end : undefined).slice(0, 1800);
}

function parseNews(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href=["'](\/news\/[^"'#?]+)["'][^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null && out.length < 24) {
    const href = m[1];
    const url = `https://vodokanal.kyiv.ua${href}`;
    if (seen.has(url)) continue;
    const block = m[2];
    const dt = (block.match(/<time[^>]*datetime=["']([^"']+)/i) || [])[1] || '';
    // 标题里可能含字面单引号，双引号属性优先单独匹配，避免被截断
    const altMatch = block.match(/<img[^>]*\balt="([^"]*)"/i) || block.match(/<img[^>]*\balt='([^']*)'/i);
    const alt = altMatch ? altMatch[1] : '';
    const heading = (block.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i) || [])[1] || '';
    const title = clean(heading || alt);
    if (!title || title.length < 10) continue;
    seen.add(url);
    const tag = classify(href, title);
    out.push({
      title, url, publishedAt: dt || null,
      tag: tag.label, tagKey: tag.key,
      waterRelated: isWaterRelated(`${href} ${title}`),
    });
  }
  return out;
}

async function getWater(scope = 'local') {
  const mode = scope === 'all' ? 'all' : 'local';
  const pages = [
    { url: VODOKANAL_HOME, kind: 'news' },
    { url: VODOKANAL_NEWS, kind: 'news' },
    { url: VODOKANAL_SHUTOFFS, kind: 'emergency' },
    { url: VODOKANAL_PLANNED, kind: 'planned' },
  ];
  const settled = await Promise.allSettled(pages.map(async (p) => ({
    ...p,
    ...(await cached(`vodokanal:${p.url}`, 15 * 60 * 1000, () => request(p.url, { text: true }))),
  })));

  const collected = new Map();
  let stale = false;
  let warning = null;
  let lastError = '';
  let plannedStatus = null;

  for (const r of settled) {
    if (r.status === 'rejected') { lastError = r.reason?.message || lastError; continue; }
    const v = r.value;
    const html = v.html || '';
    if (v.stale) { stale = true; warning = v.warning || warning; }
    if (v.kind === 'news') {
      for (const item of parseNews(html)) {
        if (collected.has(item.url)) continue;
        const sc = areaScope(`${item.title} ${item.url}`, 'news');
        collected.set(item.url, {
          ...item, kind: 'news', summary: '',
          scope: sc.key, scopeLabel: sc.label, matched: sc.matched,
        });
      }
    } else {
      if (v.kind === 'planned') {
        plannedStatus = /Наразі відключень немає/i.test(html)
          ? '官方计划停水栏目：目前没有计划停水' : null;
      }
      for (const item of parseShutoffs(html, v.url, v.kind)) {
        const key = `${v.kind}:${item.publishedAt}:${item.title.slice(0, 40)}`;
        if (!collected.has(key)) collected.set(key, item);
      }
    }
  }

  // 列表页的标题常常不写范围，对最新 5 篇补抓正文后再判定。
  const newsTop = [...collected.values()]
    .filter((x) => x.kind === 'news')
    .slice(0, 8);
  await Promise.allSettled(newsTop.map(async (item) => {
    try {
      const r = await cached(`vodokanal:body:${item.url}`, 30 * 60 * 1000, async () => {
        const page = await request(item.url, { text: true });
        return { body: extractArticleText(page.html) };
      });
      const body = r.body || '';
      const headline = areaScope(`${item.title} ${item.url}`, 'news');
      // 标题已写明具体区域时以标题为准，正文里的举例不得把它改判成全市通报
      const sc = ['address', 'district', 'other'].includes(headline.key)
        ? headline
        : areaScope(`${item.title} ${item.url} ${body}`, 'news');
      item.scope = sc.key;
      item.scopeLabel = sc.label;
      item.matched = sc.matched;
      item.summary = body.slice(0, 280);
    } catch { /* 正文抓取失败时保留标题级判定 */ }
  }));

  // 分类与区域判定已在上面用乌克兰语原文完成。翻译只发生在展示前这最后一步，
  // 不会反过来影响筛选结果。接口不回传乌克兰语原文：官方原文通过每条公告的
  // url 链接核对，界面与数据里都不保留未翻译的乌克兰语。
  const all = [...collected.values()]
    .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')))
    .slice(0, 24)
    .map((item) => ({
      ...item,
      title: translateTitle(item.title, item.tag),
      summary: item.summary ? summarize(item.summary) : '',
      matched: item.matched ? toChinese(item.matched, 40) : '',
      translated: true,
    }));
  const hidden = all.filter((x) => x.scope === 'other').length;
  const items = (mode === 'all' ? all : all.filter((x) => x.scope !== 'other')).slice(0, 12);
  const area = {
    street: PLACE.street, house: PLACE.house,
    districtUk: PLACE.district, districtZh: PLACE.district,
    neighborhood: PLACE.neighborhood, oldStreet: PLACE.oldStreet,
    scope: mode, total: all.length, hidden,
    localCount: all.filter((x) => x.scope === 'address' || x.scope === 'district').length,
    plannedStatus,
  };
  if (!all.length) {
    return {
      status: 'unavailable', source: SRC_WATER, items: [],
      checkedAt: kyivNow().iso, area,
      warning: lastError || '官网未返回可解析的公告条目',
    };
  }
  return {
    status: 'ok', source: SRC_WATER, items,
    checkedAt: kyivNow().iso, area,
    stale, warning: stale ? warning : null,
  };
}

// ---------------------------------------------------------------- aggregate

async function getStatus(group, waterScope) {
  const results = await Promise.allSettled([getAlert(), getPower(group), getWater(waterScope)]);
  const [alertR, powerR, waterR] = results;
  const fail = (r, extra) => ({
    status: 'unavailable',
    error: r.status === 'rejected' ? (r.reason?.message || 'unknown error') : 'unknown error',
    checkedAt: kyivNow().iso,
    ...extra,
  });

  return {
    generatedAt: new Date().toISOString(),
    kyiv: kyivNow(),
    hasOfficialToken: Boolean((process.env.ALERTS_UA_TOKEN || '').trim()),
    alert: alertR.status === 'fulfilled' ? alertR.value : fail(alertR, { state: 'unknown' }),
    power: powerR.status === 'fulfilled' ? powerR.value : fail(powerR, { source: SRC_POWER }),
    water: waterR.status === 'fulfilled' ? waterR.value : fail(waterR, { source: SRC_WATER, items: [] }),
  };
}

// ---------------------------------------------------------------- address lookup

// 门牌写法差异：拉丁 a / 西里尔 а、大小写、连字符
function houseVariants(house) {
  const h = String(house || '').trim();
  if (!h) return [''];
  return [...new Set([
    h,
    h.replace(/a/gi, 'а'),
    h.replace(/а/gi, 'a'),
    h.replace(/[-–\s]/g, ''),
    h.toUpperCase(),
    h.toLowerCase(),
  ])].filter(Boolean);
}

// 按街道与门牌查询 YASNO/DTEK 的轮流停电分组。低频手动操作，不走缓存。
async function resolveAddress(streetQuery, houseQuery) {
  const q = (path, params = {}) => {
    const u = new URL(`${YASNO_ADDRESS_API}/${path}`);
    for (const [k, v] of Object.entries({ regionId: 25, dsoId: 902, ...params })) {
      u.searchParams.set(k, v);
    }
    return request(u.toString());
  };

  const house = zhHouse(String(houseQuery || '').trim()).replace(/\s*号\s*$/, '').trim();
  // 界面与设置里显示中文街名，查询时映射回 YASNO 官方地址库使用的乌克兰语原名。
  const street = officialStreet(String(streetQuery || '').trim());
  if (!street) throw new Error('缺少街道名称');

  const streets = await q('streets', { query: street });
  const streetList = Array.isArray(streets) ? streets : [];
  if (!streetList.length) {
    return {
      status: 'no_street', street: zhStreet(street), house, candidates: [], allHouses: [],
      source: SRC_POWER,
      message: '官方地址库中未找到该街道。基辅部分街道在 2022–2025 年间改名，可尝试中文街名、旧名或新名。',
    };
  }

  const needle = street.toLowerCase();
  const matched = streetList.find((s) => String(s.value).toLowerCase().includes(needle)) || streetList[0];

  let houseList = [];
  for (const v of houseVariants(house)) {
    const params = { streetId: matched.id };
    if (v) params.query = v;
    const r = await q('houses', params);
    if (Array.isArray(r) && r.length) { houseList = r; break; }
  }

  const candidates = [];
  for (const h of houseList.slice(0, 10)) {
    try {
      const g = await q('group', { streetId: matched.id, houseId: h.id });
      if (g && g.group != null && g.subgroup != null) {
        candidates.push({ house: zhHouse(h.value), group: `${g.group}.${g.subgroup}` });
      }
    } catch { /* 单个门牌查不到分组时跳过 */ }
  }

  let allHouses = houseList.map((h) => zhHouse(h.value)).slice(0, 40);
  if (!candidates.length) {
    try {
      const full = await q('houses', { streetId: matched.id });
      if (Array.isArray(full) && full.length) allHouses = full.map((h) => zhHouse(h.value)).slice(0, 40);
    } catch { /* 保留已有结果 */ }
  }

  return {
    status: candidates.length ? 'ok' : 'no_house',
    street: zhStreet(matched.value), house,
    streetAlternatives: streetList.map((s) => zhStreet(s.value)).slice(0, 10),
    allHouses,
    candidates,
    source: SRC_POWER,
    message: candidates.length
      ? '以下分组来自官方地址库，选择对应门牌即可套用。'
      : '官方轮流停电地址库中未找到该门牌。可能是非住宅或独立供电对象、街道改名后重新编号，或门牌写法不同；不要按同街道其他门牌推断。',
  };
}

module.exports = { getStatus, getAlert, getPower, getWater, resolveAddress, kyivNow, levelInfo };
