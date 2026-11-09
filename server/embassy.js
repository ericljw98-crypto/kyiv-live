'use strict';

// 外交安全提醒索引：聚合多个官方外交来源的公开安全/避险提醒，统一在客户端
// 「安全提醒-避险提示」区块展示（有则显示、无则不显示）。
//
// 数据源：
//   1) 美国驻乌克兰使馆（RSS，经 CDP 绕过 WAF 抓取）
//      - 仅取 Security Alert / Demonstration Alert / Health / Weather Alert 类领事安全提醒。
//   2) 欧盟驻乌使团（EEAS 新闻室 HTML，经 CDP 抓取）
//      - 该机构不发布专门的安全提醒 RSS，故抓取新闻室近期官方动态，按安全相关
//        关键词筛选标题/类别，取其官方声明与公告中与安全避险相关的条目。
//
// 内容边界：只取官方公开、用于避险的领事安全提醒与官方安全动态；不接入非官方
// 实时战术军情，也不把英文正文外发翻译（仅译标题）。翻译沿用 server/news.js 的
// 破例通道（Google 免费端点）。
//
// 抓取通道：使馆与欧盟站点都对服务端直连较敏感（使馆甚至有 WAF 直接 403），
// 故统一走本机 Chrome（CDP）真实浏览器绕过反爬。CDP 不可用时 collect 返回空，
// 由上层 getEmbassy 退回线上快照兜底，最终仍无数据则标记 unavailable。

const fs = require('node:fs');
const path = require('node:path');

const news = require('./news.js');
const { parseRss, translateOne } = news;
const { cdpFetchText } = require('./cdp-fetch.js');

const ROOT = path.resolve(__dirname, '..');
const CACHE_FILE = path.join(ROOT, 'snapshot-out', 'embassy-cache.json');
const CACHE_TTL_MS = 10 * 60 * 1000;
// 外交提醒频率低（通常每周至多几条），窗口放宽到 14 天，避免偶发提醒被窗口切掉。
const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ITEMS = 6;

// 美国使馆：标题以安全类提醒开头者（"ALERT – MESSAGE FOR U.S. CITIZENS" 等行政通知不取）。
const US_PREFIX = /^(security alert|demonstration alert|health alert|weather alert)\b/i;

// 欧盟使团新闻室为泛政策/新闻，仅保留标题或类别明显涉安全的条目。
const EU_SECURITY_RE = /\b(security|threat|attack|missile|drone|shelling?|air ?raid|blackout|evacuat|consular|advisor\w*|warning|alert|safety|defen[cs]e|military|civilian|border|cyber|terror|casualt\w*|strike\w*|explosion|hostage|front ?line)\b/i;

const SOURCES = [
  { id: 'us', name: '美国驻乌克兰使馆', type: 'rss', url: 'https://ua.usembassy.gov/feed/' },
  { id: 'eu', name: '欧盟驻乌使团', type: 'html', url: 'https://www.eeas.europa.eu/delegations/ukraine_en' },
];

function isSafetyAlert(title) {
  return US_PREFIX.test(String(title || '').trim());
}

// ---------------------------------------------------------------- 美国使馆 RSS
async function collectUs() {
  let xml;
  try {
    xml = await cdpFetchText(SOURCES[0].url);
  } catch (err) {
    console.warn(`[warn] CDP 抓取美使馆 feed 失败：${err?.message || err}`);
    return [];
  }
  if (!/<rss\b|<feed\b|<item\b/i.test(xml || '')) {
    console.warn('[warn] CDP 返回的使馆 feed 不是 RSS（可能命中反爬页），已跳过');
    return [];
  }
  const items = parseRss(xml, SOURCES[0].name);
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  return items
    .filter((it) => {
      const t = Date.parse(it.publishedAt);
      if (!Number.isFinite(t) || t > now + 60 * 60 * 1000 || t < windowStart) return false;
      return isSafetyAlert(it.title);
    })
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

// ---------------------------------------------------------- 欧盟使团新闻室 HTML
function parseEuItem(blk) {
  const aM = /<h3[^>]*>\s*<a\s+href=([^\s>]+)[^>]*>([\s\S]*?)<\/a>/.exec(blk);
  if (!aM) return null;
  let url = aM[1].replace(/^["']|["']$/g, '');
  const titleRaw = aM[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (!titleRaw) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://www.eeas.europa.eu${url}`;

  // 官方动态只给日期（DD.MM.YYYY），无时刻；锚定到基辅正午，避免 kyivParts 跨日偏移。
  const dM = /card-footer[^>]*>[\s\S]*?(\d{2})\.(\d{2})\.(\d{4})/.exec(blk);
  if (!dM) return null;
  const day = Number(dM[1]);
  const mon = Number(dM[2]);
  const yr = Number(dM[3]);
  const ts = Date.UTC(yr, mon - 1, day, 10, 0, 0); // 10:00 UTC ≈ 12:00/13:00 基辅
  if (!Number.isFinite(ts)) return null;

  const catM = /card-subtitle[\s\S]*?<div[^>]*>([\s\S]*?)<\/div>/.exec(blk);
  const category = catM ? catM[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';

  if (!EU_SECURITY_RE.test(`${titleRaw} ${category}`)) return null;

  return {
    title: titleRaw.slice(0, 220),
    url,
    source: SOURCES[1].name,
    category,
    publishedAt: new Date(ts).toISOString(),
  };
}

async function collectEu() {
  let html;
  try {
    html = await cdpFetchText(SOURCES[1].url, { timeoutMs: 30000 });
  } catch (err) {
    console.warn(`[warn] CDP 抓取欧盟使团新闻室失败：${err?.message || err}`);
    return [];
  }
  if (!html || html.length < 2000) {
    console.warn('[warn] 欧盟使团新闻室返回内容异常，已跳过');
    return [];
  }
  const blocks = html.split('<div class="card node node--type-press-material').slice(1);
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const out = [];
  for (const blk of blocks) {
    let it;
    try { it = parseEuItem(blk); } catch { continue; }
    if (!it) continue;
    const t = Date.parse(it.publishedAt);
    if (!Number.isFinite(t) || t > now + 60 * 60 * 1000 || t < windowStart) continue;
    out.push(it);
  }
  return out.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

// ------------------------------------------------------------- 聚合 + 翻译
async function collectAll() {
  const [usRes, euRes] = await Promise.allSettled([collectUs(), collectEu()]);
  const raw = [
    ...(usRes.status === 'fulfilled' ? usRes.value : []),
    ...(euRes.status === 'fulfilled' ? euRes.value : []),
  ];
  const seen = new Set();
  const uniq = [];
  for (const it of raw) {
    if (!it || !it.url || seen.has(it.url)) continue;
    seen.add(it.url);
    uniq.push(it);
  }
  return uniq.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

async function shape(raw) {
  const candidates = raw.slice(0, MAX_ITEMS);
  const zhTitles = await Promise.all(candidates.map((it) => translateOne(it.title)));
  return candidates.map((it, i) => {
    const zh = (zhTitles[i] && zhTitles[i].trim()) ? zhTitles[i].trim() : it.title;
    return {
      title: zh,
      titleEn: it.title,
      url: it.url,
      publishedAt: it.publishedAt,
      source: it.source,
      category: it.category || '',
    };
  });
}

function readCache() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (j && j.schema === 2 && Array.isArray(j.payload?.items)
      && Date.now() - Date.parse(j.fetchedAt) < CACHE_TTL_MS) return j;
  } catch { /* 首次运行或缓存损坏 */ }
  return null;
}
function writeCache(payload) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, `${JSON.stringify({ schema: 2, fetchedAt: new Date().toISOString(), payload })}\n`, 'utf8');
  } catch (err) {
    console.warn(`[warn] 外交安全提醒缓存写入失败：${err?.message || err}`);
  }
}

// 抓取整体失败时继承线上已有快照里的条目，明确标记为缓存，不冒充实时数据。
async function fallbackFromOnline() {
  try {
    const res = await fetch(
      'https://raw.githubusercontent.com/ericljw98-crypto/kyiv-live/snapshot/status.json',
      { headers: { 'User-Agent': 'kyiv-live-embassy' }, signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return [];
    const j = await res.json();
    const old = Array.isArray(j.embassy?.items) ? j.embassy.items : [];
    const now = Date.now();
    const windowStart = now - WINDOW_MS;
    return old
      .filter((it) => {
        const t = Date.parse(it.publishedAt);
        return Number.isFinite(t) && t <= now + 60 * 60 * 1000 && t >= windowStart;
      })
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      .slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
}

async function getEmbassy() {
  const cache = readCache();
  if (cache) {
    return { ...cache.payload, fromCache: true };
  }

  let raw = [];
  let anyOk = false;
  try {
    raw = await collectAll();
    anyOk = true;
  } catch (err) {
    console.warn(`[warn] 外交安全提醒抓取失败：${err?.message || err}`);
  }

  let items = (raw && raw.length) ? await shape(raw) : [];
  let status = 'ok';
  if (!items.length) {
    const inherited = await fallbackFromOnline();
    if (inherited.length) {
      items = inherited;
      status = 'cached';
    } else {
      // 任一来源报错且线上也无继承数据 → 视为暂不可用；两源都正常响应但无匹配 → empty。
      status = anyOk ? 'empty' : 'unavailable';
    }
  }

  const payload = {
    status,
    generatedAt: new Date().toISOString(),
    fetchedAt: status === 'cached' ? '' : new Date().toISOString(),
    sources: SOURCES.map((s) => s.name),
    items,
  };
  if (status !== 'cached') writeCache(payload);
  const srcs = items.map((i) => i.source).filter((v, idx, a) => a.indexOf(v) === idx).join('+') || '—';
  console.log(`外交安全提醒：${items.length} 条（${status}，${srcs}）`);
  return payload;
}

module.exports = { getEmbassy, collectAll, shape, isSafetyAlert, SOURCES, FEED_URL: SOURCES[0].url };
