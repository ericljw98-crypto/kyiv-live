'use strict';

// 基辅要闻：基辅时间当天重大外交、政治、安全事件的公开中文报道索引。
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
// 只收录基辅时间当天零点之后的报道，不再保留前一日条目。
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
// 境内媒体排到最后。既匹配 RSS 给出的媒体名，也匹配来源域名，避免转载站漏判。
const DOMESTIC_SOURCE = /新华社|新华网|xinhua|中新网|中国新闻网|chinanews|央视|央广|cctv|人民日报|人民网|people\.com|环球时报|环球网|huanqiu|参考消息|澎湃|thepaper|界面|jiemian|财新|caixin|观察者|guancha|腾讯|qq\.com|新浪|sina|网易|163\.com|搜狐|sohu|凤凰|ifeng|百度|baidu|今日头条|toutiao|中国日报|chinadaily|中国网|china\.com|光明网|gmw|中青网|上观|jfdaily|央视新闻|\.cn(?:$|[^a-z])/i;
// 明确可识别的境外媒体排最前；未识别来源排在中间，仍优先于境内媒体。
const FOREIGN_SOURCE = /路透|Reuters|法新社|AFP|美联社|apnews|塔斯社|TASS|共同社|kyodo|法广|法国国际广播电台|RFI|BBC|CNN|纽约时报|nytimes|华尔街日报|wsj|卫报|theguardian|彭博|bloomberg|德国之声|DW\b|日经|nikkei|朝日|asahi|NHK|联合早报|zaobao|金融时报|ft\.com|经济学人|economist|Ukrinform|基辅独立|kyivindependent|pravda\.com|unn\.ua|interfax|俄新社|sputnik|卫星通讯社|Politico|axios|rferl|voanews|lemonde|ansa|elpais|skynews|华盛顿邮报|washingtonpost|newsweek|aljazeera|半岛|星洲|南洋|UA\.NEWS|ua\.news/i;

function sourceRank(source) {
  const s = String(source || '');
  if (DOMESTIC_SOURCE.test(s)) return 2;
  if (FOREIGN_SOURCE.test(s)) return 0;
  return 1;
}

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
// 基辅时间当天零点对应的 UTC 毫秒，用于把「当天」与「最近 24 小时」区分开。
function kyivDayStartUtc(now = Date.now()) {
  const off = kyivOffsetMs(now);
  const d = new Date(now + off);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - off;
}
function categoryOf(title) {
  let best = ['其他', 0];
  for (const [name, re] of CATEGORY_RULES) {
    const n = (String(title).match(new RegExp(re.source, 'g')) || []).length;
    if (n > best[1]) best = [name, n];
  }
  return best[0];
}
// 同一事件常被不同媒体换序、扩写或改标点重发。三道去重：规范化 URL、
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
  const seenTitle = new Set();
  const keptTitles = [];
  const items = [];
  const dayStart = kyivDayStartUtc(now);
  const today = dayKey(new Date(now).toISOString());
  // 境外媒体优先、未识别来源居中、境内媒体最后；同档内取较新的报道。
  // 去重时先遇到谁就保留谁，因此同一事件会优先留下境外媒体那条。
  const ordered = [...raw].sort((a, b) => {
    const tier = sourceRank(a.source) - sourceRank(b.source);
    if (tier) return tier;
    return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
  });
  for (const it of ordered) {
    const t = Date.parse(it.publishedAt);
    if (!Number.isFinite(t) || t < dayStart || t > now + 60 * 60 * 1000) continue;
    if (dayKey(it.publishedAt) !== today) continue;
    if (!SUBJECT.test(it.title) || EXCLUDE.test(it.title)
      || OPINION.test(it.title) || !SIGNIFICANT.test(it.title)) continue;
    const uk = urlKey(it.url);
    const tk = titleKey(it.title);
    if (seenUrl.has(uk) || (tk && seenTitle.has(tk))
      || keptTitles.some((title) => similarTitle(title, it.title))) continue;
    seenUrl.add(uk);
    if (tk) seenTitle.add(tk);
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
  // 只有当天条目，排序按来源档位、来源可信度、发布时间；不做主观重要性评级。
  items.sort((a, b) => {
    const tier = sourceRank(a.source) - sourceRank(b.source);
    if (tier) return tier;
    const p = Number(PREFERRED_SOURCE.test(b.source)) - Number(PREFERRED_SOURCE.test(a.source));
    if (p) return p;
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

// 抓取整体失败时继承线上已有快照里仍属当天的条目，明确标记为缓存。
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
    // 与 shape() 同一口径：只继承基辅时间当天的条目，避免旧闻回潮。
    const today = dayKey(new Date(now).toISOString());
    return old.filter((it) => {
      const t = Date.parse(it.publishedAt);
      return Number.isFinite(t) && dayKey(it.publishedAt) === today
        && SUBJECT.test(it.title) && !EXCLUDE.test(it.title) && !OPINION.test(it.title);
    }).slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
}

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
  };
  if (status !== 'cached') writeCache(payload);
  console.log(`要闻：${items.length} 条（${status}），成功源 ${sources.filter((s) => !s.error).length}/${sources.length}`);
  return payload;
}

module.exports = {
  getNews, collect, shape, dayKey, categoryOf,
  SUBJECT, EXCLUDE, OPINION, SIGNIFICANT, PREFERRED_SOURCE,
};
