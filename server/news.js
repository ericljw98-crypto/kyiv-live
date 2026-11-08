'use strict';

// 基辅要闻：当天重大外交、政治、安全事件的公开中文报道索引。
//
// 内容边界与全项目一致，且不是可开关选项：这里只索引权威公开媒体「已经发布」
// 的新闻报道，不做二次判读、不推断数字、不改写标题。不接入非官方渠道传播的
// 来袭目标坐标、飞行轨迹、速度、拦截动态、防空系统部署与作战实况，也不抓取
// Telegram 等平台上的实时军情频道。标题命中实时战术军情关键词时直接丢弃。
//
// 不调用任何翻译 API：数据源本身是中文 RSS，标题、摘要、来源名照录后展示。
// 原文链接一律指向媒体直链，点击可核对；不使用国内不可达的聚合跳转地址。
//
// 抓取结果做 10 分钟文件缓存，避免云端每 5 分钟一轮把上游打满；全部失败时
// 从线上已有快照继承仍在时间窗内的条目，并明确标记为缓存，不冒充实时数据。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CACHE_FILE = path.join(ROOT, 'snapshot-out', 'news-cache.json');
const CACHE_TTL_MS = 10 * 60 * 1000;
const WINDOW_MS = 48 * 60 * 60 * 1000;
const MAX_ITEMS = 24;
const FETCH_TIMEOUT_MS = 9000;

// 四组查询覆盖外交、政治、安全三类；中新网国际 RSS 作为补充直链来源。
// 不用 Google 新闻 RSS：它的 link 是国内打不开的 news.google.com 聚合跳转。
const BING_QUERIES = [
  { q: '乌克兰 基辅 会谈 谈判 外交', hint: '外交' },
  { q: '乌克兰 政府 议会 政策 签署', hint: '政治' },
  { q: '泽连斯基 声明 会谈 援助', hint: '政治' },
  { q: '乌克兰 反腐 安全局 人事', hint: '政治' },
  { q: '基辅 空袭 袭击 安全 局势', hint: '安全' },
  { q: '乌克兰 断电 能源设施 空袭', hint: '安全' },
];
// Bing 的时间过滤把「过去一天」的报道排在前面，实测同一组查询的当天条目
// 从 1 条提升到 7 条；不加这个参数时 RSS 里大量是几周前的旧闻。
const BING_FRESH = '&qft=interval%3d%227%22';
const CHINANEWS_RSS = 'https://www.chinanews.com.cn/rss/world.xml';

// 标题必须命中主题词，避免把「俄罗斯国内经济」「G20 其他议题」之类新闻混进要闻。
const SUBJECT = /乌克兰|乌方|乌军|乌总统|乌外长|乌外交部|基辅|俄乌|俄美乌|美俄乌|俄乌美|泽连斯基|三方会谈|阿布扎比.*会谈/;
// 明确的实时战术军情，一律排除；正常的安全事件报道（空袭、伤亡、断电）不在其列。
const EXCLUDE = /来袭坐标|飞行轨迹|航迹|实时坐标|实时追踪|实时定位|拦截动态|防空系统位置|防空阵地|防空失效|防空网|拦截率|突防成功|打击效果评估|战果|战报|损失创|绝对纪录|歼灭|部署位置|导弹飞行路线|打击坐标|Telegram|电报频道|实时直播|直播画面|现场视频流|实时更新.*坐标/i;
// 观点评论、疑问句与标题党不是「已发生的事件」，只保留事实性报道标题。
const OPINION = /[?？]|专家[：:]|学者[：:]|评论员|为何|何以至此|后悔了|解读|深度观察|剖析|盘点|细数|揭秘|真相|撑腰|铁了心|招招|压箱底|狠角色|怒了|呼喊|会不会|难道|竟然|震惊|网友|被曝|大和解|一针见血|扎心|太可怕|意味着什么|背后/;
// 「重大」只按公开报道标题里的事件信号词判断，不做主观重要性评级。
const SIGNIFICANT = /会谈|谈判|会晤|峰会|访问|外长|总统|总理|议会|政府|签署|协议|制裁|援助|停火|决议|声明|空袭|袭击|导弹|无人机|伤亡|断电|能源设施|大规模|爆炸|救援|法令|辞职|任命|解雇|人事|反腐|被抓|逮捕|调查|官员|安全局|选举|联合国|北约|欧盟|美俄|俄美|三方|使馆|大使/;
const CATEGORY_RULES = [
  ['外交', /会谈|谈判|会晤|峰会|访问|外交|外长|使馆|大使|代表团|磋商|协议|制裁|援助|停火|联合国|北约|欧盟|美俄|俄美|三方/],
  ['政治', /总统|总理|议会|政府|内阁|法案|政策|任命|解雇|人事|反腐|官员|警官|诈骗|被抓|涉腐|表决|辞职|选举|改革|法令|签署|安全局|整肃|声明/],
  ['安全', /空袭|袭击|导弹|无人机|爆炸|伤亡|断电|防空|警报|前线|战事|打击|能源设施|救援|被埋|停电/],
];
const PREFERRED_SOURCE = /新华社|中新网|中国新闻网|央视|人民日报|人民网|环球时报|参考消息|联合早报|路透|法新社|塔斯社|共同社|法广|RFI|BBC|观察者|澎湃|界面|财新|腾讯网|新浪|网易/;

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
function sourceFromUrl(u, fallback) {
  if (fallback) return fallback;
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return '公开报道'; }
}

// 基辅墙钟按 EET/EEST 固定规则自算。部分运行环境的 ICU 没有 Europe/Kyiv，
// 传时区名给 Intl 会直接抛 RangeError，这里完全不依赖系统时区数据库。
function kyivOffsetMs(utcMs) {
  const year = new Date(utcMs).getUTCFullYear();
  const lastSunday = (month) => {
    const last = new Date(Date.UTC(year, month + 1, 0));
    return Date.UTC(year, month, last.getUTCDate() - last.getUTCDay(), 1);
  };
  return (utcMs >= lastSunday(2) && utcMs < lastSunday(9) ? 3 : 2) * 3600000;
}
function dayKey(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t + kyivOffsetMs(t));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
function categoryOf(title) {
  let best = ['其他', 0];
  for (const [name, re] of CATEGORY_RULES) {
    const n = (String(title).match(new RegExp(re.source, 'g')) || []).length;
    if (n > best[1]) best = [name, n];
  }
  return best[0];
}
// 同一事件常被不同媒体用相同字句换序重发，单靠 URL 或前几十字去重会漏。
// 用中文二元组 Jaccard 相似度判重，只合并高度重合的标题，不合并同主题的后续报道。
function titleTokens(s) {
  const t = String(s || '').replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '');
  const set = new Set();
  for (let i = 0; i < t.length - 1; i += 1) set.add(t.slice(i, i + 2));
  return set;
}
function similarTitle(a, b) {
  const A = titleTokens(a), B = titleTokens(b);
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter) >= 0.58;
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
    const source = sourceFromUrl(url, tag(b, 'News:Source') || defaultSource || '');
    const summary = decode(tag(b, 'description')).slice(0, 84);
    out.push({
      title: title.slice(0, 120),
      url,
      source: source.slice(0, 40),
      summary,
      publishedAt: new Date(ts).toISOString(),
    });
  }
  return out;
}

async function collect() {
  const jobs = BING_QUERIES.map(({ q, hint }) => ({
    label: `Bing · ${hint}`,
    run: async () => parseRss(await fetchText(
      `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss${BING_FRESH}`
    ), ''),
  }));
  jobs.push({
    label: '中国新闻网 · 国际',
    run: async () => parseRss(await fetchText(CHINANEWS_RSS), '中国新闻网'),
  });

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

function shape(raw, now = Date.now()) {
  const seenUrl = new Set();
  const keptTitles = [];
  const items = [];
  // 先按发布时间倒序，去重时保留同一事件的最新一条报道。
  const ordered = [...raw].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  for (const it of ordered) {
    const t = Date.parse(it.publishedAt);
    if (!Number.isFinite(t) || t < now - WINDOW_MS || t > now + 60 * 60 * 1000) continue;
    if (!SUBJECT.test(it.title) || EXCLUDE.test(it.title)
      || OPINION.test(it.title) || !SIGNIFICANT.test(it.title)) continue;
    const urlKey = it.url.replace(/[?#].*$/, '');
    if (seenUrl.has(urlKey) || keptTitles.some((title) => similarTitle(title, it.title))) continue;
    seenUrl.add(urlKey);
    keptTitles.push(it.title);
    items.push({
      title: it.title,
      url: it.url,
      source: it.source,
      summary: it.summary,
      publishedAt: it.publishedAt,
      dayKey: dayKey(it.publishedAt),
      category: categoryOf(it.title),
    });
  }
  // 今日优先，同日内按来源可信度再按时间倒序；不做主观重要性排序。
  items.sort((a, b) => {
    const day = String(b.dayKey).localeCompare(String(a.dayKey));
    if (day) return day;
    const s = Number(PREFERRED_SOURCE.test(b.source)) - Number(PREFERRED_SOURCE.test(a.source));
    if (s) return s;
    return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
  });
  return items.slice(0, MAX_ITEMS);
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

// 抓取整体失败时继承线上已有快照里仍在时间窗内的条目，明确标记为缓存。
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
    return old.filter((it) => {
      const t = Date.parse(it.publishedAt);
      return Number.isFinite(t) && t >= now - WINDOW_MS
        && SUBJECT.test(it.title) && !EXCLUDE.test(it.title) && !OPINION.test(it.title);
    }).slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
}

const POLICY = '只索引权威公开媒体已发布的中文事实性报道，标题与摘要照录、不改写不推断；按标题关键词归入外交、政治、安全三类，不代表重要性评级，也不代表本页核实结论。已剔除观点评论与疑问句标题。不收录来袭坐标、飞行轨迹、拦截动态、防空系统部署等实时战术军情，也不接入 Telegram 实时军情频道。';

async function getNews() {
  const cache = readCache();
  if (cache) {
    return { ...cache.payload, fromCache: true, sources: cache.payload.sources || [] };
  }

  const { raw, sources, ok } = await collect();
  let items = shape(raw);
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
    todayKey: dayKey(new Date().toISOString()),
    sources,
    items,
    policy: POLICY,
  };
  if (status !== 'cached') writeCache(payload);
  console.log(`要闻：${items.length} 条（${status}），成功源 ${sources.filter((s) => !s.error).length}/${sources.length}`);
  return payload;
}

module.exports = {
  getNews, collect, shape, dayKey, categoryOf, POLICY,
  SUBJECT, EXCLUDE, OPINION, SIGNIFICANT, PREFERRED_SOURCE,
};
