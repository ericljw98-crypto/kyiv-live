'use strict';

// 多国涉乌安全提醒索引：聚合「五眼联盟 + 德国 + 法国」共 7 国官方发布的、与乌克兰相关的
// 公开安全/旅行警告，统一在客户端「安全提醒-避险提示」区块展示。
//
// 收录范围（用户明确指定，取代原先的「美国使馆 + 欧盟使团」）：
//   美国(US)  美国驻乌克兰使馆 RSS（经 CDP 绕过 WAF；仅取 Security/Demonstration/Health/Weather Alert）
//   英国(UK)  英国政府 travel advice 更新流（Atom，逐条"近期更新"）
//   加拿大(CA)  travel.gc.ca 乌克兰旅行建议页（HTML，取"Latest updates" + "Last updated"）
//   澳大利亚(AU) smartraveller 乌克兰页（HTML，取"Latest update" + "Updated"）
//   新西兰(NZ) safetravel 乌克兰页（HTML，取"Page updated"日期）
//   德国(DE)  德国外交部乌克兰安全页（HTML；该页更新日期由前端 JS 渲染，静态抓取常拿不到，故尽力而为）
//   法国(FR)  法国外交部乌克兰旅行建议页（HTML，取"Dernière mise à jour"日期）
//
// 展示规则（用户明确要求）：
//   - 仅在「近一周内有提醒」时收录并显示；无任何提醒时整块隐藏，不显示空占位、也不显示来源主页链接。
//   - 每条提醒只展示「标题 + 来源国 + 日期 + 指向该提醒/官方页的链接」，不在下方罗列各国主页。
//
// 内容边界：只取官方公开、用于避险的领事安全提醒与官方旅行警告更新；不接入非官方实时战术军情，
// 也不把英文正文外发翻译（仅译标题）。翻译沿用 server/news.js 的破例通道（Google 免费端点，sl=auto）。
//
// 抓取通道：美国使馆对服务端直连有 WAF（直接 403），故走本机 Chrome（CDP）；其余国家为公开政府站点，
// 直接用服务端 fetch 即可（云端 5 分钟循环无 Chrome 时，美国项由本机推送的快照继承兜底）。任一来源
// 抓取失败（fetched=false）时，从线上快照继承该来源近一周内的条目，避免整块缺失。

const fs = require('node:fs');
const path = require('node:path');

const { cdpFetchText } = require('./cdp-fetch.js');

const ROOT = path.resolve(__dirname, '..');
const CACHE_FILE = path.join(ROOT, 'snapshot-out', 'embassy-cache.json');
const CACHE_TTL_MS = 10 * 60 * 1000;
// 近一周窗口；取 8 天作为容差，覆盖部分仅标注日期、无时刻的提醒（按日精度会少算约半天）。
const WINDOW_MS = 8 * 24 * 60 * 60 * 1000;
const MAX_ITEMS = 8;

// 美国使馆：标题以安全类提醒开头者（"ALERT – MESSAGE FOR U.S. CITIZENS" 等行政通知不取）。
const US_PREFIX = /^(security alert|demonstration alert|health alert|weather alert)\b/i;

// 各来源配置。method: 'cdp' 走 Chrome（仅美国使馆，因 WAF）；其余 'direct' 服务端直连。
const SOURCES = [
  { id: 'us', country: '美国', method: 'cdp', type: 'rss', url: 'https://ua.usembassy.gov/feed/' },
  { id: 'uk', country: '英国', method: 'direct', type: 'atom', url: 'https://www.gov.uk/foreign-travel-advice/ukraine.atom' },
  { id: 'au', country: '澳大利亚', method: 'direct', type: 'html', url: 'https://www.smartraveller.gov.au/destinations/europe/ukraine' },
  { id: 'ca', country: '加拿大', method: 'direct', type: 'html', url: 'https://travel.gc.ca/destinations/ukraine' },
  { id: 'nz', country: '新西兰', method: 'direct', type: 'html', url: 'https://safetravel.govt.nz/destinations/ukraine' },
  { id: 'de', country: '德国', method: 'direct', type: 'html', url: 'https://www.auswaertiges-amt.de/de/ReiseUndSicherheit/ukraine-sicherheit' },
  { id: 'fr', country: '法国', method: 'direct', type: 'html', url: 'https://www.diplomatie.gouv.fr/fr/conseils-aux-voyageurs/conseils-par-pays-destination/ukraine/' },
];

// HTML 来源的"更新文本 + 更新日期"提取规则；textRe 为 null 时用 titleFallback 生成标题。
// dateRe 抓取一段包含日期的窗口（日期常被 <span> 包裹），由 parseAnyDate 在窗口内定位日期。
const HTML_RULES = {
  au: {
    textRe: null,
    dateRe: /Updated:([\s\S]{0,160})/i,
    titleFallback: '澳大利亚更新对乌克兰的旅行安全提醒',
  },
  ca: {
    textRe: /Latest updates:\s*<\/b>?\s*([\s\S]*?)(?=<\/p>)/i,
    dateRe: /Last updated:([\s\S]{0,160})/i,
    titleFallback: '加拿大更新对乌克兰的旅行安全提醒',
  },
  nz: {
    textRe: null,
    dateRe: /Page updated([\s\S]{0,80})/i,
    titleFallback: '新西兰更新对乌克兰的旅行安全提醒',
  },
  de: {
    textRe: null,
    dateRe: null, // 德国页更新日期由前端 JS 渲染，静态抓取拿不到；尽力而为，拿不到则不收录
    titleFallback: '德国更新对乌克兰的旅行与安全提示',
  },
  fr: {
    textRe: null,
    dateRe: /Derni[eè]re mise [àa] jour le\s*:?([\s\S]{0,80})/i,
    titleFallback: '法国更新对乌克兰的旅行安全提醒',
  },
};

// ---------------------------------------------------------------- 工具函数
function stripTags(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

function tag(block, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  if (!m) return '';
  return stripTags(m[1]);
}

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7,
  september: 8, october: 9, november: 10, december: 11,
  januar: 0, februar: 1, märz: 2, mai: 4, juni: 5, juli: 6, august: 7,
  september: 8, oktober: 9, november: 10, dezember: 11,
  janvier: 0, février: 1, mars: 2, avril: 3, mai: 4, juin: 5, juillet: 6,
  août: 7, septembre: 8, octobre: 9, novembre: 10, décembre: 11,
};

// 解析多语言/多格式的日期：ISO、DD.MM.YYYY（德）、"D Month YYYY"（英/法/德）、"Month D, YYYY"。
function parseAnyDate(raw) {
  if (!raw) return NaN;
  const s = String(raw).replace(/&nbsp;|&#160;|&#xA0;/gi, ' ').replace(/\s+/g, ' ').trim();
  let t = Date.parse(s);
  if (Number.isFinite(t)) return t;
  let m = /(\d{1,2})\s*[.\u00a0]\s*(\d{1,2})\s*[.\u00a0]\s*(\d{4})/.exec(s);
  if (m) { t = Date.UTC(+m[3], +m[2] - 1, +m[1]); if (Number.isFinite(t)) return t; }
  m = /(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s+(\d{4})/.exec(s);
  if (m) { const mo = MONTHS[m[2].toLowerCase()]; if (mo !== undefined) { t = Date.UTC(+m[3], mo, +m[1]); if (Number.isFinite(t)) return t; } }
  m = /([A-Za-zÀ-ÿ]+)\s+(\d{1,2}),?\s+(\d{4})/.exec(s);
  if (m) { const mo = MONTHS[m[1].toLowerCase()]; if (mo !== undefined) { t = Date.UTC(+m[3], mo, +m[2]); if (Number.isFinite(t)) return t; } }
  return NaN;
}

async function fetchText(url, method, timeoutMs = 25000) {
  if (method === 'cdp') return cdpFetchText(url, { timeoutMs });
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kyiv-live-embassy/1.0)' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// 破例外发标题翻译：Google 免费端点，sl=auto 自动识别英/德/法。
const TRANSLATE_TIMEOUT_MS = 15000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function translateAuto(text, attempt = 0) {
  if (!text) return text;
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kyiv-live-embassy/1.0)' },
      signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`translate HTTP ${res.status}`);
    const j = await res.json();
    const zh = (j[0] || []).map((seg) => seg[0]).join('');
    if (zh && zh.trim()) return zh.trim();
    throw new Error('empty');
  } catch {
    if (attempt < 2) { await sleep(350 * (attempt + 1)); return translateAuto(text, attempt + 1); }
    return text; // 翻译失败兜底：保留原文，不编造中文
  }
}
// 标题已含中文（如生成的兜底标题）则不再送译，避免把中文当外文翻坏。
const isChineseTitle = (t) => /[一-鿿]/.test(t || '');

// ---------------------------------------------------------------- 美国使馆 RSS
function parseRssItems(xml, sourceName) {
  const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];
  const out = [];
  for (const b of blocks) {
    const title = tag(b, 'title');
    const link = tag(b, 'link');
    const pub = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated');
    const ts = Date.parse(pub);
    if (!title || !/^https?:\/\//i.test(link) || !Number.isFinite(ts)) continue;
    out.push({
      title: title.slice(0, 200),
      url: link,
      source: sourceName,
      category: '',
      publishedAt: new Date(ts).toISOString(),
    });
  }
  return out;
}

async function collectUs(src) {
  try {
    const xml = await fetchText(src.url, 'cdp', 30000);
    if (!/<rss\b|<feed\b|<item\b/i.test(xml || '')) return { items: [], fetched: false, note: 'not-rss' };
    const items = parseRssItems(xml, src.country).filter((it) => US_PREFIX.test(it.title));
    return { items, fetched: true };
  } catch (e) {
    return { items: [], fetched: false, note: e.message };
  }
}

// ---------------------------------------------------------- 英国 gov.uk Atom
function parseAtom(xml, src) {
  const entries = xml.match(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi) || [];
  const out = [];
  for (const e of entries) {
    const summary = stripTags(/<summary[\s\S]*?>([\s\S]*?)<\/summary>/i.exec(e)?.[1] || '').slice(0, 240);
    const title = stripTags(/<title[\s\S]*?>([\s\S]*?)<\/title>/i.exec(e)?.[1] || '');
    const updated = tag(e, 'updated') || tag(e, 'published') || '';
    const linkM = /<link[^>]+href=["']([^"']+)["']/i.exec(e);
    const url = linkM ? linkM[1] : src.url;
    const ts = Date.parse(updated);
    if (!Number.isFinite(ts)) continue;
    const titleText = summary || title; // 用"更新了什么"的摘要作标题更贴近提醒内容
    if (!titleText) continue;
    out.push({ title: titleText, url, source: src.country, category: '', publishedAt: new Date(ts).toISOString() });
  }
  return out;
}

async function collectUk(src) {
  try {
    const xml = await fetchText(src.url, 'direct', 20000);
    return { items: parseAtom(xml, src), fetched: true };
  } catch (e) {
    return { items: [], fetched: false, note: e.message };
  }
}

// ---------------------------------------------- 加拿大/澳/新/德/法 HTML 页面
async function collectHtml(src) {
  const rule = HTML_RULES[src.id];
  if (!rule) return { items: [], fetched: false, note: 'no-rule' };
  try {
    const html = await fetchText(src.url, 'direct', 20000);
    if (!html || html.length < 1000) return { items: [], fetched: false, note: 'short' };

    let text = null;
    if (rule.textRe) {
      const tm = rule.textRe.exec(html);
      if (tm) text = stripTags(tm[1]).slice(0, 240).trim();
    }
    let dateStr = null;
    if (rule.dateRe) {
      const dm = rule.dateRe.exec(html);
      if (dm) dateStr = dm[1].trim();
    }
    const ts = parseAnyDate(dateStr);
    if (!Number.isFinite(ts)) return { items: [], fetched: true, note: 'no-date' }; // 抓到了页但无可用日期 → 不收录（条件渲染）

    const title = (text && text.length > 3) ? text : rule.titleFallback;
    return {
      items: [{ title, url: src.url, source: src.country, category: '', publishedAt: new Date(ts).toISOString() }],
      fetched: true,
    };
  } catch (e) {
    return { items: [], fetched: false, note: e.message };
  }
}

async function collectSource(src) {
  try {
    if (src.type === 'rss') return await collectUs(src);
    if (src.type === 'atom') return await collectUk(src);
    if (src.type === 'html') return await collectHtml(src);
    return { items: [], fetched: false, note: 'unknown-type' };
  } catch (e) {
    return { items: [], fetched: false, note: e.message };
  }
}

// ------------------------------------------------------------- 线上继承兜底
async function fetchOnlineItems() {
  try {
    const res = await fetch(
      'https://raw.githubusercontent.com/ericljw98-crypto/kyiv-live/snapshot/status.json',
      { headers: { 'User-Agent': 'kyiv-live-embassy' }, signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return [];
    const j = await res.json();
    return Array.isArray(j.embassy?.items) ? j.embassy.items : [];
  } catch {
    return [];
  }
}

// 探测本机是否有可用 Chrome（CDP）。云端 5 分钟循环无 Chrome，127.0.0.1:9222 不可达。
async function cdpAvailable() {
  try {
    const res = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------- 缓存
function readCache() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (j && j.schema === 3 && Array.isArray(j.payload?.items)
      && Date.now() - Date.parse(j.fetchedAt) < CACHE_TTL_MS) return j;
  } catch { /* 首次运行或缓存损坏 */ }
  return null;
}
function writeCache(payload) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, `${JSON.stringify({ schema: 3, fetchedAt: new Date().toISOString(), payload })}\n`, 'utf8');
  } catch (err) {
    console.warn(`[warn] 外交安全提醒缓存写入失败：${err?.message || err}`);
  }
}

// ------------------------------------------------------------- 主入口
async function getEmbassy() {
  const cache = readCache();
  if (cache) return { ...cache.payload, fromCache: true };

  const onlineItems = await fetchOnlineItems();

  // 无 Chrome 环境（云端 5 分钟循环）：本机推送的快照才是使馆数据真源（美国使馆走 CDP，
  // 其余直连也常因云端出口差异拿不到日期）。此时直接沿用线上近一周条目，避免重抓丢项、
  // 进而被循环覆盖成只剩美国一项。本机有 Chrome 时走下方实时抓取。
  if (!(await cdpAvailable()) && onlineItems.length) {
    const items = onlineItems.slice(0, MAX_ITEMS).map((it) => ({
      title: it.title,
      titleEn: it.titleEn || '',
      url: it.url,
      publishedAt: it.publishedAt,
      source: it.source,
      category: it.category || '',
    }));
    const payload = {
      status: 'cached',
      generatedAt: new Date().toISOString(),
      fetchedAt: '',
      sources: SOURCES.map((s) => s.country),
      items,
    };
    writeCache(payload);
    const srcs = items.map((i) => i.source).filter((v, idx, a) => a.indexOf(v) === idx).join('+') || '—';
    console.log(`多国涉乌安全提醒：沿用线上快照 ${items.length} 条（无 Chrome，${srcs}）`);
    return payload;
  }

  const results = await Promise.all(SOURCES.map(async (s) => ({ s, r: await collectSource(s) })));
  let anyFailed = false;
  for (const { r } of results) if (!r.fetched) anyFailed = true;

  // 始终读取线上快照（本机推送的版本），用于补齐本轮回抓失败、或抓到页面但无可用日期的来源。
  // 线上条目已按近一周窗口过滤，故仅会补入仍在窗口内的真实提醒，不会用陈旧值冒充实时。
  // 注：onlineItems 已在上方 fetch 并复用，避免重复网络请求与变量重声明。
  const onlineBySource = new Map();
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  for (const o of onlineItems) {
    const t = Date.parse(o.publishedAt);
    if (Number.isFinite(t) && t >= windowStart && t <= now + 60 * 60 * 1000) {
      if (!onlineBySource.has(o.source)) onlineBySource.set(o.source, []);
      onlineBySource.get(o.source).push(o);
    }
  }

  const merged = [];
  const seen = new Set();
  for (const { s, r } of results) {
    let items = r.items;
    // 本来源本轮回抓为空（含抓取失败或无可用日期），且线上有该来源近一周条目时，予以补齐。
    if (!items.length && onlineBySource.has(s.country)) items = onlineBySource.get(s.country);
    for (const it of items) {
      if (!it || !it.url || seen.has(it.url)) continue;
      const t = Date.parse(it.publishedAt);
      if (!Number.isFinite(t) || t > now + 60 * 60 * 1000 || t < windowStart) continue;
      seen.add(it.url);
      merged.push(it);
    }
  }
  merged.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));

  // 翻译非中文标题（英文/德文/法文源文本）。
  const toTranslate = merged.filter((it) => !isChineseTitle(it.title));
  const zh = await Promise.all(toTranslate.map((it) => translateAuto(it.title)));
  let k = 0;
  const items = merged.map((it) => {
    const hasZh = isChineseTitle(it.title);
    const title = hasZh ? it.title : (zh[k++] || it.title);
    return {
      title,
      titleEn: hasZh ? '' : it.title,
      url: it.url,
      publishedAt: it.publishedAt,
      source: it.source,
      category: it.category || '',
    };
  }).slice(0, MAX_ITEMS);

  const status = items.length ? 'ok' : (anyFailed ? 'partial' : 'empty');
  const payload = {
    status,
    generatedAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
    sources: SOURCES.map((s) => s.country),
    items,
  };
  writeCache(payload);
  const srcs = items.map((i) => i.source).filter((v, idx, a) => a.indexOf(v) === idx).join('+') || '—';
  console.log(`多国涉乌安全提醒：${items.length} 条（${status}，${srcs}）`);
  return payload;
}

module.exports = { getEmbassy, collectSource, SOURCES, FEED_URL: SOURCES[0].url, isSafetyAlert: (t) => US_PREFIX.test(String(t || '').trim()) };
