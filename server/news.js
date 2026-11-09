'use strict';

// 基辅要闻：索引乌通社（Ukrinform，乌克兰国家通讯社）英文 RSS 的最新消息，翻译为中文展示。
//
// 内容边界与全项目一致，不是可开关选项：只索引权威公开媒体「已经发布」的事实性报道，
// 不做二次判读、不推断数字、不改写标题。不接入非官方渠道传播的来袭坐标、飞行轨迹、
// 拦截动态、防空部署与作战实况，也不抓取 Telegram 实时军情频道。英文标题命中实时战术
// 军情关键词时直接丢弃，只保留外交、政治、安全事件类报道（袭击、伤亡、断电、能源设施等）。
//
// 翻译（破例）：调用外部翻译服务把英文标题与摘要都翻译为中文展示。默认用 Google 免费端点
// （translate.googleapis.com，无需密钥，但属未授权使用、可能限流）；设置环境变量
// TRANSLATE_KEY 可改为走正式翻译服务（请在 translateOne 中补充对应实现）。翻译失败时
// 保留英文，不编造中文。外发内容仅限公开新闻标题与摘要，不涉及任何本地住址或警报数据。
//
// 抓取结果做 10 分钟文件缓存，避免云端每 5 分钟一轮把上游打满；全部失败时从线上已有
// 快照继承最近条目，并明确标记为缓存，不冒充实时数据。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CACHE_FILE = path.join(ROOT, 'snapshot-out', 'news-cache.json');
const CACHE_TTL_MS = 10 * 60 * 1000;
// 只展示最近 2 天内的报道（按发布时间倒序），超出窗口的不纳入快照；
// 显示条数不再设固定上限，2 天内通过筛选的条目通常只有几十条，自然可滚动浏览。
const NEWS_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
// 翻译前候选上限（安全阀）：限制单次翻译调用规模，避免免费端点限流。
const MAX_CANDIDATES = 80;
const FETCH_TIMEOUT_MS = 9000;
const SOURCE_NAME = 'Ukrinform';

// 乌通社公开英文 RSS（ukrinform.net）。乌克兰语主站 ukrinform.ua 无公开 RSS、只能抓网页，
// 故采用英文 RSS 再翻译。覆盖战事、政治、国防、社会、经济、突发事件、犯罪、重建等栏目。
const UKRINFORM_FEEDS = [
  'https://ukrinform.net/rss/rubric-ato',        // War
  'https://ukrinform.net/rss/rubric-polytics',    // Politics
  'https://ukrinform.net/rss/rubric-defense',     // Defense
  'https://ukrinform.net/rss/rubric-society',     // Society
  'https://ukrinform.net/rss/rubric-economy',     // Economy
  'https://ukrinform.net/rss/rubric-crime',       // Crime
  'https://ukrinform.net/rss/rubric-vidbudova',   // Recovery of Ukraine
];

// 英文标题筛选：先排除实时战术军情，再要求命中主题与显著事件信号词。
// 排除：前线交火/战况统计、拦截与击落数字、坐标/航迹、实时/直播军情、战场地图等。
const SUBJECT_EN = /Ukraine|Ukrainian|Kyiv|Zelensky|Russian|Moscow|Donetsk|Luhansk|Kherson|Kharkiv|Odesa|Zaporizhzhia|Crimea|Sevastopol|EU|NATO|U\.S\.|Washington|Putin|Biden|Trump|Poland|Moldova/i;
const EXCLUDE_EN = /clashes|front[- ]?line|combat engagement|troop movement|interception|neutraliz|shot down|destroyed|liquidat|eliminat|losses|coordinates|trajectory|geolocation|real[- ]?time|live (update|map)|battlefield map|war (update|map)|strike package|offensive|advance|gains/i;
const SIGNIFICANT_EN = /attack|strike|missile|drone|explosion|casualt|injur|kill|wound|power outage|blackout|energy|sanction|aids?|talks|negotiation|summit|visit|president|prime minister|parliament|government|sign|agreement|ceasefire|resolut|statement|arrest|corruption|official|diplomat|embassy|foreign minister|defen[sc]e|military/i;

// 中文分类（翻译后标题）：外交 / 政治 / 安全。
const CATEGORY_RULES = [
  ['外交', /会谈|谈判|会晤|峰会|访问|外交|外长|使馆|大使|代表团|磋商|协议|制裁|援助|停火|联合国|北约|欧盟|美俄|俄美|三方|波兰|摩尔多瓦/],
  ['政治', /总统|总理|议会|政府|内阁|法案|政策|任命|解雇|人事|反腐|官员|警官|诈骗|被抓|涉腐|表决|辞职|选举|改革|法令|签署|安全局|整肃|声明|国防|军队|军事/],
  ['安全', /空袭|袭击|导弹|无人机|爆炸|伤亡|断电|停电|防空|警报|前线|战事|打击|能源|救援|被埋|遇难|受伤|攻击/],
];
// 兜底过滤（用于继承线上快照时复用）：实时战术军情、观点评论与疑问句。
const EXCLUDE_ZH = /来袭坐标|飞行轨迹|航迹|实时坐标|实时追踪|实时定位|拦截动态|防空系统位置|防空阵地|防空失效|防空网|拦截率|突防成功|打击效果评估|战果|战报|损失创|绝对纪录|歼灭|部署位置|导弹飞行路线|打击坐标|Telegram|电报频道|实时直播|直播画面|现场视频流|实时更新.*坐标/i;
const OPINION_ZH = /[?？]|专家[：:]|学者[：:]|评论员|为何|何以至此|后悔了|解读|深度观察|剖析|盘点|细数|揭秘|真相|撑腰|铁了心|招招|压箱底|狠角色|怒了|呼喊|会不会|难道|竟然|震惊|网友|被曝|大和解|一针见血|扎心|太可怕|意味着什么|背后/i;

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&#183;/g, '·')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}
function tag(block, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? decode(m[1]) : '';
}
function directUrl(u) {
  try {
    const target = new URL(u).searchParams.get('url');
    if (target && /^https?:\/\//i.test(target)) return target;
  } catch { /* 已是直链 */ }
  return u;
}

// 英文→中文翻译。破例外发标题；默认 Google 免费端点，设置 TRANSLATE_KEY 可走正式服务。
const TRANSLATE_TIMEOUT_MS = 15000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function translateOne(en, attempt = 0) {
  if (!en) return en;
  const KEY = process.env.TRANSLATE_KEY;
  try {
    let zh;
    if (KEY) {
      // 正式翻译服务接入点：设置 TRANSLATE_KEY 后在此调用 DeepL / Google Cloud，
      // 把 en 翻译为 zh-CN。默认不启用，避免把标题外发给未获授权的第三方。
      zh = en;
    } else {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(en)}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kyiv-live-news/1.0)' },
        signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`translate HTTP ${res.status}`);
      const j = await res.json();
      zh = (j[0] || []).map((seg) => seg[0]).join('');
    }
    if (zh && zh.trim()) return zh.trim();
    throw new Error('empty');
  } catch {
    if (attempt < 2) { await sleep(350 * (attempt + 1)); return translateOne(en, attempt + 1); }
    return en; // 翻译失败兜底：保留英文，不编造中文
  }
}
async function translateBatch(list) {
  const out = [];
  for (const t of list) {
    out.push(await translateOne(t));
    await sleep(200);
  }
  return out;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kyiv-live-index/1.0)' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!/<rss\b|<feed\b|<item\b/i.test(text)) throw new Error('返回内容不是 RSS');
  return text;
}

function parseRss(xml, defaultSource) {
  const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];
  const out = [];
  for (const b of blocks) {
    const title = tag(b, 'title');
    const url = directUrl(tag(b, 'link'));
    const published = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated');
    const ts = Date.parse(published);
    if (!title || !/^https?:\/\//i.test(url) || !Number.isFinite(ts)) continue;
    const source = defaultSource || '';
    const summary = decode(tag(b, 'description')).slice(0, 280);
    out.push({
      title: title.slice(0, 160),
      url,
      source,
      summary,
      publishedAt: new Date(ts).toISOString(),
    });
  }
  return out;
}

async function collect() {
  const jobs = UKRINFORM_FEEDS.map((url) => ({
    label: `Ukrinform · ${url.split('/').pop()}`,
    run: async () => parseRss(await fetchText(url), SOURCE_NAME),
  }));
  const results = await Promise.allSettled(jobs.map((j) => j.run()));
  const sources = [];
  const raw = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      sources.push({ name: jobs[i].label, count: r.value.length });
      raw.push(...r.value);
    } else {
      sources.push({ name: jobs[i].label, error: String(r.reason?.message || r.reason) });
    }
  });
  return { raw, sources, ok: results.some((r) => r.status === 'fulfilled') };
}

function categoryOf(title) {
  let best = ['其他', 0];
  for (const [name, re] of CATEGORY_RULES) {
    const n = (String(title).match(new RegExp(re.source, 'g')) || []).length;
    if (n > best[1]) best = [name, n];
  }
  return best[0];
}
// 同一事件常被不同栏目换序、扩写或改标点重发。三道去重：规范化 URL、
// 规范化标题全文、中文二元组相似度（Jaccard 与较小集合覆盖率取其一）。
function titleTokens(s) {
  const t = String(s || '').replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '');
  const set = new Set();
  for (let i = 0; i < t.length - 1; i += 1) set.add(t.slice(i, i + 2));
  return set;
}
function urlKey(u) {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, '').toLowerCase()}${x.pathname.replace(/\/+$/, '')}`;
  } catch {
    return String(u).replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  }
}
function titleKey(t) {
  return String(t || '').replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '').toLowerCase();
}
function similarTitle(a, b) {
  const A = titleTokens(a), B = titleTokens(b);
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const union = A.size + B.size - inter;
  if (union && inter / union >= 0.45) return true;
  // 一条标题是另一条的扩展或删节版时 Jaccard 偏低，用较小集合的覆盖率补判。
  return inter / Math.min(A.size, B.size) >= 0.7;
}

async function shape(raw, now = Date.now()) {
  // 英文阶段筛选：丢弃未来时间戳、非乌克兰主题、战术军情、非显著事件，
  // 并丢弃超过 2 天窗口的报道（按发布时间倒序，超出窗口的不纳入快照）。
  const windowStart = now - NEWS_WINDOW_MS;
  const filtered = raw.filter((it) => {
    const t = Date.parse(it.publishedAt);
    if (!Number.isFinite(t) || t > now + 60 * 60 * 1000 || t < windowStart) return false;
    const en = it.title || '';
    return SUBJECT_EN.test(en) && !EXCLUDE_EN.test(en) && SIGNIFICANT_EN.test(en);
  });
  if (!filtered.length) return [];

  // 按发布时间倒序取较新的候选，限制单次翻译规模，避免免费端点限流。
  const ordered = [...filtered].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const candidates = ordered.slice(0, MAX_CANDIDATES);

  // 翻译标题（用于去重与展示）。
  const zhTitles = await translateBatch(candidates.map((it) => it.title));
  candidates.forEach((it, i) => { it.zhTitle = zhTitles[i]; });

  // 去重：规范化 URL、规范化标题全文、中文二元组相似度（Jaccard 与较小集合覆盖率取其一）。
  const seenUrl = new Set();
  const seenTitle = new Set();
  const keptTitles = [];
  const kept = [];
  for (const it of candidates) {
    const uk = urlKey(it.url);
    const tk = titleKey(it.zhTitle);
    if (seenUrl.has(uk) || (tk && seenTitle.has(tk))
      || keptTitles.some((title) => similarTitle(title, it.zhTitle))) continue;
    seenUrl.add(uk);
    if (tk) seenTitle.add(tk);
    keptTitles.push(it.zhTitle);
    kept.push(it);
  }
  if (!kept.length) return [];

  // 仅对去重后的条目翻译摘要，控制翻译调用量；失败兜底保留英文摘要。
  const zhSummaries = await translateBatch(kept.map((it) => it.summary || ''));
  kept.forEach((it, i) => { it.zhSummary = zhSummaries[i]; });

  const items = kept.map((it) => ({
    title: it.zhTitle,
    url: it.url,
    source: SOURCE_NAME,
    summary: (it.zhSummary && it.zhSummary.trim()) ? it.zhSummary.trim() : (it.summary || ''),
    publishedAt: it.publishedAt,
    category: categoryOf(it.zhTitle),
  }));
  items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  return items;
}

function readCache() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (j && j.schema === 1 && Array.isArray(j.payload?.items)
      && Date.now() - Date.parse(j.fetchedAt) < CACHE_TTL_MS) return j;
  } catch { /* 首次运行或缓存损坏 */ }
  return null;
}
function writeCache(payload) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, `${JSON.stringify({ schema: 1, fetchedAt: new Date().toISOString(), payload })}\n`, 'utf8');
  } catch (err) {
    console.warn(`[warn] 要闻缓存写入失败：${err?.message || err}`);
  }
}

// 抓取整体失败时继承线上已有快照里最近条目，明确标记为缓存。
async function fallbackFromOnline() {
  try {
    const res = await fetch(
      'https://raw.githubusercontent.com/ericljw98-crypto/kyiv-live/snapshot/status.json',
      { headers: { 'User-Agent': 'kyiv-live-news' }, signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return [];
    const j = await res.json();
    const old = Array.isArray(j.news?.items) ? j.news.items : [];
    const now = Date.now();
    const windowStart = now - NEWS_WINDOW_MS;
    // 与 shape() 同一口径：只继承命中主题词、非战术军情、非观点评论、且在 2 天窗口内的条目，
    // 按时间倒序（继承线上已有快照，其摘要已是中文，无需再译）。
    return old
      .filter((it) => {
        const t = Date.parse(it.publishedAt);
        return Number.isFinite(t) && t <= now + 60 * 60 * 1000 && t >= windowStart
          && SUBJECT_EN.test(it.title) && !EXCLUDE_ZH.test(it.title) && !OPINION_ZH.test(it.title);
      })
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  } catch {
    return [];
  }
}

async function getNews() {
  const cache = readCache();
  if (cache) {
    const { policy, ...rest } = cache.payload;
    return { ...rest, fromCache: true, sources: cache.payload.sources || [] };
  }

  const { raw, sources, ok } = await collect();
  let items = await shape(raw);
  let status = 'ok';
  if (!ok || !items.length) {
    const inherited = await fallbackFromOnline();
    if (inherited.length) {
      items = inherited;
      status = 'cached';
    } else if (!ok) {
      status = 'unavailable';
    }
    // 各源都成功但时间窗内恰好没有符合条件的新闻，属于正常空结果，仍标 ok。
  }

  const payload = {
    status,
    generatedAt: new Date().toISOString(),
    fetchedAt: status === 'cached' ? '' : new Date().toISOString(),
    sources,
    items,
  };
  if (status !== 'cached') writeCache(payload);
  console.log(`要闻：${items.length} 条（${status}），成功源 ${sources.filter((s) => !s.error).length}/${sources.length}`);
  return payload;
}

module.exports = {
  getNews, collect, shape, categoryOf,
  fetchText, parseRss, decode, directUrl,
  translateOne, translateBatch,
  urlKey, titleKey, similarTitle, titleTokens,
  SUBJECT_EN, EXCLUDE_EN, SIGNIFICANT_EN,
};
