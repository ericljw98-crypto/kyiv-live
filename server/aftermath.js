'use strict';

// 袭击后果自动索引：从乌通社（Ukrinform）英文 RSS 自动提取「对乌袭击及其后果」的结构化数字
// （导弹 / 无人机发射总数、伤亡），每日按基辅日期重算一次，随快照一起分发。与要闻同源
// （Ukrinform 英文 RSS），复用 server/news.js 的抓取与翻译。
//
// 内容边界的破例说明：公开英文 RSS 里「导弹 / 无人机发射总数」与「拦截数」只裹在乌空军战报的
// 英文转述中（例如 "Air defense neutralizes 271 of 317 Russian drones targeting Ukraine overnight"）。
// 这类报道本身含拦截统计，属项目默认的实时战术军情排除范围；本模块为补全发射与拦截数据破例放行
// 此类报道，但**只采用官方公布的发射数与拦截统计**（如发射 317、拦截 271），不触碰坐标 / 航迹 /
// 防空阵地 / 部署等纯战术情报。发射与拦截并排展示在同一武器卡的括号内，不做独立卡片。事件级报道
// 里的伤亡与重点目标照常索引。全部抓取失败时沿用最近一次成功结果或 APK 内置种子。这是事后公开
// 报道的汇总索引，不是实时预警，不参与警报判定。

const fs = require('node:fs');
const path = require('path');
const news = require('./news.js');

const ROOT = path.resolve(__dirname, '..');
const CACHE_FILE = path.join(ROOT, 'snapshot-out', 'aftermath-auto.json');
const SEED_FILE = path.join(ROOT, 'data', 'aftermath.json');
// 抓过去 30 小时内的报道，覆盖「昨夜 + 今晨」两份综合战报，避免单份窗口遗漏。
const WINDOW_MS = 30 * 60 * 60 * 1000;
const SOURCE_NAME = 'Ukrinform';

// 仅索引与「袭击后果」直接相关的两个栏目，避免要闻全量抓取浪费额度。
const FEEDS = [
  'https://ukrinform.net/rss/rubric-ato',       // War
  'https://ukrinform.net/rss/rubric-defense',    // Defense
];

// ----------------------------------------------------------------- 基辅日期（自算，禁 Intl timeZone）
function kyivOffsetMs(date) {
  const year = date.getUTCFullYear();
  const lastSunday = (month) => {
    const d = new Date(Date.UTC(year, month, 31));
    d.setUTCDate(31 - ((d.getUTCDay() + 6) % 7));
    return d.getTime();
  };
  const eestStart = lastSunday(2) + 3 * 3600 * 1000;   // 3 月最后一个周日 03:00 UTC 进入 EEST
  const eestEnd = lastSunday(9) + 4 * 3600 * 1000;     // 10 月最后一个周日 04:00 UTC 退出 EEST
  const t = date.getTime();
  return (t >= eestStart && t < eestEnd) ? 3 * 3600 * 1000 : 2 * 3600 * 1000;
}
function kyivDateStr(d = new Date()) {
  const date = (typeof d === 'number') ? new Date(d) : d;
  const kd = new Date(date.getTime() + kyivOffsetMs(date));
  const y = kd.getUTCFullYear();
  const m = String(kd.getUTCMonth() + 1).padStart(2, '0');
  const day = String(kd.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ----------------------------------------------------------------- 数字提取与筛选
const ATTACK_EVENT = /attack|strike|missile|drone|shelling|explosion|blast|fire|air(?: ?)strike|raid|assault|hit|target|decoy|shahed/i;
// 坚决排除：坐标 / 航迹 / 防空阵地与部署位置等纯战术情报。
const PURE_TACTICAL = /coordinate|trajectory|geolocation|air\s+defen[sc]e\s+(?:position|site|system|unit|base|deploy|radar)|radar\s+(?:system|station)|launcher\s+(?:located|position)|flight\s+(?:path|track)|real[- ]?time/i;
// 乌方进攻 / 军援 / 军事单位动态，与「对乌袭击后果」无关。
const EXCLUDE_OFFENSE = /ukrainian\s+(?:forces|army|troops|military|soldiers)|air\s+assault|recruit|brigade|received|deliver|aid\s+package|supply|training|drill|deploy|produce|manufactur|russia(?:n)?\s+(?:oil\s+refinery|refinery|plant|territory|soil|base)/i;
// 战术拦截词：命中时，除非该报道同时含「对乌发射 / 袭击」语义，否则排除（避免纯拦截战报）。
const TACTICAL_WORD = /air\s+defen[sc]e|neutraliz|down(?:ed)?\b|shot\s+down|intercept|patriot|anti[- ]aircraft|eastern\s+(?:front|flank)/i;
const LAUNCH_WORD = /launch|fired|fire\s+(?:a|missile|drone)|targeting\s+(?:ukraine|kyiv|odesa|ukrainian)|against\s+ukraine|struck|strike|attack|hit\s+(?:ukraine|kyiv|odesa|ukrainian)|overnight|russia(?:n)?\s+(?:launches|launched|fires|fired|strikes|struck|attack|targets)/i;
const CASUALTY_VERB = /killed|dead|injur|wound|casualt|victim|perish/i;
const UKRAINE_PLACE = /ukraine|kyiv|odesa|odessa|kharkiv|kherson|donetsk|luhansk|zaporizhzhia|crimea|sevastopol|sumy|poltava|dnipro|dnipropetrovsk|zhytomyr|lviv|mykolaiv|cherkasy|chernihiv|vinnytsia|buryatia|ternopil|rivne|volyn|zakarpattia|ivano|khmelnytskyi|lutsk|kremenchuk|pavlohrad|komyshuvakha|balakliia/i;

function isAftermath(item) {
  const en = `${item.title} ${item.summary}`;
  if (!ATTACK_EVENT.test(en)) return false;
  if (PURE_TACTICAL.test(en)) return false;
  if (EXCLUDE_OFFENSE.test(en)) return false;
  if (TACTICAL_WORD.test(en) && !LAUNCH_WORD.test(en)) return false;
  const ukrPlace = UKRAINE_PLACE.test(en);
  const againstUkr = /against\s+ukraine|targeting\s+ukraine|on\s+ukraine|ukraine\s+(?:overnight|early)|russia(?:n)?\s+(?:launches|launched|fires|fired|strikes|struck|attack|targets)/i.test(en);
  const casualty = CASUALTY_VERB.test(en);
  return ukrPlace || againstUkr || casualty;
}

// 英文数字词（用于伤亡报道常见写法：three killed / one injured）。
const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12 };
const NUM_GROUP = `(\\d[\\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen)`;
const PEOPLE = `(?:people|civilians?|persons?|residents?|soldiers?|children)?`;

function toNum(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d/.test(s)) return parseInt(s.replace(/,/g, ''), 10);
  const w = WORD_NUM[s.toLowerCase()];
  return (w != null) ? w : null;
}
// 在一个文本里对多组正则取所有命中数字的最大值（用于发射总数：避开拦截数）。
function maxOfAll(text, patterns) {
  let max = null;
  for (const re of patterns) {
    const g = new RegExp(re.source, 'gi');
    let m;
    while ((m = g.exec(text)) !== null) {
      const n = toNum(m[1]);
      if (n != null && (max == null || n > max)) max = n;
      if (m.index === g.lastIndex) g.lastIndex += 1;
    }
  }
  return max;
}
// 在一个文本里按给定模式取第一个可解析的伤亡数（支持「数字+动词」与「动词+数字」双向）。
function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) {
      const n = toNum(m[1] || m[2]);
      if (n != null) return n;
    }
  }
  return null;
}
const MISSILE_PAT = [new RegExp(`${NUM_GROUP}\\s*(?:cruise|guided|ballistic|iskander|kalibr)?\\s*missile`, 'i')];
const DRONE_PAT = [new RegExp(`${NUM_GROUP}\\s*(?:shahed|attack|unmanned|reconnaissance|explosive)?\\s*(?:drone|uav)s?\\b`, 'i')];
// 拦截数：只取官方战报里「拦截 / 击落」动词后的数字（如 neutralizes 271 of 317 → 271），不取发射数。
const INTER_DRONE_PAT = [new RegExp(`(?:neutraliz\\w*|intercept\\w*|down\\w*|shot\\s+down|destroy\\w*|suppress\\w*|eliminat\\w*)\\s*${NUM_GROUP}\\s*(?:of\\s+[\\d,]+)?\\s*(?:russian\\s+)?drones?`, 'i')];
const INTER_MISSILE_PAT = [new RegExp(`(?:neutraliz\\w*|intercept\\w*|down\\w*|shot\\s+down|destroy\\w*|suppress\\w*|eliminat\\w*)\\s*${NUM_GROUP}\\s*(?:of\\s+[\\d,]+)?\\s*(?:russian\\s+)?missiles?`, 'i')];
const KILL_PAT = [
  new RegExp(`${NUM_GROUP}\\s*${PEOPLE}\\s*(?:were\\s+)?(?:killed|dead|perished|lost\\s+their\\s+lives)`, 'i'),
  new RegExp(`(?:killed|dead|perished)\\s*(?:some|about|over|up\\s+to\\s+)?\\s*${NUM_GROUP}`, 'i'),
];
const INJ_PAT = [
  new RegExp(`${NUM_GROUP}\\s*${PEOPLE}\\s*(?:were\\s+)?(?:injur(?:e|ed|es)|wounded|hurt)`, 'i'),
  new RegExp(`(?:injur(?:e|ed|es)|wounded|hurt)\\s*(?:some|about|over|up\\s+to\\s+)?\\s*${NUM_GROUP}`, 'i'),
];

// ----------------------------------------------------------------- 抓取与聚合
async function collectLocal() {
  const jobs = FEEDS.map((url) => ({
    label: url.split('/').pop(),
    run: async () => news.parseRss(await news.fetchText(url), SOURCE_NAME),
  }));
  const results = await Promise.allSettled(jobs.map((j) => j.run()));
  const raw = [];
  const sources = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') { sources.push({ name: jobs[i].label, count: r.value.length }); raw.push(...r.value); }
    else sources.push({ name: jobs[i].label, error: String(r.reason?.message || r.reason) });
  });
  return { raw, sources, ok: results.some((r) => r.status === 'fulfilled') };
}

const FAC_RE = /energy|infrastructure|power|substation|electric|residential|facility|plant|station|hospital|bridge|depot|warehouse|enterprise|factory|grid|oil\s+refinery|pipeline/i;

async function build() {
  const { raw, sources, ok } = await collectLocal();
  if (!ok || !raw.length) return { ok: false, sources, items: [] };

  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const candidates = raw.filter((it) => {
    const t = Date.parse(it.publishedAt);
    return Number.isFinite(t) && t <= now && t >= windowStart && isAftermath(it);
  });

  const seen = new Set();
  const dedup = [];
  for (const it of candidates) {
    const k = news.urlKey(it.url);
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(it);
  }
  if (!dedup.length) return { ok: true, sources, items: [] };

  const enriched = dedup.map((it) => {
    const text = `${it.title} ${it.summary}`;
    return {
      ...it,
      text,
      m: maxOfAll(text, MISSILE_PAT),
      d: maxOfAll(text, DRONE_PAT),
      interD: maxOfAll(text, INTER_DRONE_PAT),
      interM: maxOfAll(text, INTER_MISSILE_PAT),
      k: firstMatch(text, KILL_PAT),
      i: firstMatch(text, INJ_PAT),
    };
  });

  // 导弹 / 无人机发射总数：跨报道取最大（发射战报是窗口内唯一含总数的来源）。
  let missiles = null;
  let drones = null;
  for (const e of enriched) {
    if (e.m != null && (missiles == null || e.m > missiles)) missiles = e.m;
    if (e.d != null && (drones == null || e.d > drones)) drones = e.d;
  }
  // 拦截数：跨报道取最大（官方战报里「拦截 / 击落」动词后的数字）。
  let interDrones = null;
  let interMissiles = null;
  for (const e of enriched) {
    if (e.interD != null && (interDrones == null || e.interD > interDrones)) interDrones = e.interD;
    if (e.interM != null && (interMissiles == null || e.interM > interMissiles)) interMissiles = e.interM;
  }

  // 伤亡：窗口内各报道明确提及的 killed / injured 累计求和（去重后不同事件近似当日总伤亡）。
  let killedSum = 0;
  let injuredSum = 0;
  let hasCas = false;
  for (const e of enriched) {
    if (e.k != null) { killedSum += e.k; hasCas = true; }
    if (e.i != null) { injuredSum += e.i; hasCas = true; }
  }

  // 重点目标：聚合窗口内所有「设施类」事件报道，逐一翻译摘要后拼接，得到比单条摘要更丰富的罗列，
  // 逼近手工校订的详度（如能源设施、变电站、居民楼停暖、多地断电等分项并列）。最多取 4 条去重报道。
  const byNewest = enriched.slice().sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const spine = byNewest[0] || null;
  const facReports = byNewest.filter((e) => FAC_RE.test(e.text));
  const seenT = new Set();
  const targetSlices = [];
  for (const e of facReports) {
    if (targetSlices.length >= 4) break;
    const k = news.urlKey(e.url) + '|' + news.titleKey(e.title);
    if (seenT.has(k)) continue;
    const slice = (e.summary || '').slice(0, 180).trim();
    if (!slice) continue;
    seenT.add(k);
    targetSlices.push(slice);
  }
  let targets = '详见原文';
  if (targetSlices.length) {
    const zhs = await Promise.all(targetSlices.map((s) => news.translateOne(s)));
    const joined = zhs.map((z) => (z && z.trim()) ? z.trim() : '').filter(Boolean);
    if (joined.length) targets = joined.join('；') + '。';
  }

  const date = kyivDateStr(now);
  // 武器卡内联「发射数（拦截数）」：发射与拦截并排展示，不单独立卡。
  const dronesStr = drones != null
    ? `发射 ${drones} 架无人机${interDrones != null ? `（拦截 ${interDrones} 架）` : ''}`
    : (interDrones != null ? `拦截 ${interDrones} 架无人机` : '未公布');
  const missilesStr = missiles != null
    ? `发射 ${missiles} 枚导弹${interMissiles != null ? `（拦截 ${interMissiles} 枚）` : ''}`
    : (interMissiles != null ? `拦截 ${interMissiles} 枚导弹` : '未公布');
  const wpn = [dronesStr, missilesStr].filter((s) => s && s !== '未公布').join('；');
  const title = wpn ? `俄罗斯对乌发动袭击：${wpn}（截至 ${date}）` : `俄罗斯对乌发动导弹与无人机袭击（截至 ${date}）`;
  const casualtiesZh = hasCas
    ? [killedSum ? `${killedSum} 人死亡` : null, injuredSum ? `${injuredSum} 人受伤` : null].filter(Boolean).join('、')
    : '未公布';

  const item = {
    date,
    title,
    source: SOURCE_NAME,
    sourceType: '乌通社英文 RSS 自动索引（破例含乌空军战报发射与拦截统计）',
    url: spine ? spine.url : '',
    missiles: missilesStr,
    drones: dronesStr,
    casualties: casualtiesZh,
    targets,
    note: '',
  };
  return { ok: true, sources, items: [item] };
}

// ----------------------------------------------------------------- 缓存与兜底
function readCache() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (j && typeof j.cachedDate === 'string' && Array.isArray(j.items)) return j;
  } catch { /* 首次运行或缓存损坏 */ }
  return null;
}
function writeCache(cachedDate, items) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, `${JSON.stringify({ cachedDate, generatedAt: new Date().toISOString(), items })}\n`, 'utf8');
  } catch (err) {
    console.warn(`[warn] 袭击后果缓存写入失败：${err?.message || err}`);
  }
}

function wrap(items, updatedAt, status) {
  return {
    schema: 1,
    updatedAt: updatedAt || new Date().toISOString(),
    status,
    policy: '袭击后果由服务端自动索引乌通社（Ukrinform）英文 RSS 的 War/Defense 栏目，每日按基辅日期重算一次；'
      + '从报道中提取导弹、无人机发射总数、拦截数与伤亡数字，经翻译后结构化呈现。为补全发射与拦截数据，破例放行含乌空军战报的报道，'
      + '仅采用官方公布的发射与拦截统计，不触碰坐标 / 航迹 / 防空阵地 / 部署等纯战术情报。这是事后公开报道的汇总索引，不是实时预警，'
      + '数字为截至抓取时各报道提及的口径，可能随新报道更新。',
    items,
  };
}

// 抓取整体失败时，从线上快照继承最近条目（与 news 一致的兜底思路）。
async function fallbackFromOnline() {
  try {
    const res = await fetch(
      'https://raw.githubusercontent.com/ericljw98-crypto/kyiv-live/snapshot/status.json',
      { headers: { 'User-Agent': 'kyiv-live-aftermath' }, signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return [];
    const j = await res.json();
    const old = Array.isArray(j.aftermath?.items) ? j.aftermath.items : [];
    return old.slice(0, 1);
  } catch {
    return [];
  }
}

async function getAftermath(force = false) {
  const kd = kyivDateStr();
  const cached = readCache();
  if (!force && cached && cached.cachedDate === kd && Array.isArray(cached.items)) {
    console.log(`袭击后果：使用 ${kd} 当日缓存（${cached.items.length} 条）`);
    return wrap(cached.items, cached.generatedAt, 'cached');
  }

  let built;
  try {
    built = await build();
  } catch (err) {
    console.warn(`[warn] 袭击后果抓取失败：${err?.message || err}`);
    built = { ok: false, items: [] };
  }

  if (built.ok && built.items.length) {
    writeCache(kd, built.items);
    console.log(`袭击后果：${built.items.length} 条（ok），来源 ${built.sources.filter((s) => !s.error).length}/${built.sources.length}`);
    return wrap(built.items, new Date().toISOString(), 'ok');
  }

  // 今日无战报或抓取失败：沿用缓存里最近一次成功结果（可能跨日），明确标注。
  if (cached && Array.isArray(cached.items) && cached.items.length) {
    const items = cached.items.map((it) => ({ ...it, note: `今日战报暂未汇总，数据沿用 ${it.date}` }));
    console.log(`袭击后果：沿用缓存 ${cached.cachedDate}（carried）`);
    return wrap(items, cached.generatedAt, 'carried');
  }

  // 完全没有缓存：尝试线上快照继承，再不行用 APK 内置种子。
  const online = await fallbackFromOnline();
  if (online.length) {
    const items = online.map((it) => ({ ...it, note: '自动索引暂未取得今日数据，显示线上最近一条' }));
    return wrap(items, '', 'online');
  }
  try {
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    if (seed.schema === 1 && Array.isArray(seed.items) && seed.items.length) {
      const items = seed.items.map((it) => ({ ...it, note: '自动索引暂不可用，显示最近一次人工校订种子数据' }));
      console.log('袭击后果：使用内置种子（seed）');
      return wrap(items, seed.updatedAt || '', 'seed');
    }
  } catch { /* 无种子 */ }
  console.log('袭击后果：无可用数据（unavailable）');
  return wrap([], '', 'unavailable');
}

module.exports = { getAftermath, isAftermath, kyivDateStr, build };
