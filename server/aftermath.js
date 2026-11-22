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

// 备用源：Interfax-Ukraine 乌克兰语 RSS（乌通社英文 RSS 维护时的兜底）。
// 重要限制：Interfax 通用「最新消息」流只含事件级报道，不含乌空军那种「夜间发射 X、拦截 Y」汇总战报，
// 因此兜底只能补全「事件级伤亡 + 重点目标」，发射 / 拦截总数仍标为暂缺，需待乌通社恢复后才会有。
const INTERFAX_FEED = 'https://interfax.com.ua/news/last.rss';
const INTERFAX_NAME = 'Interfax-Ukraine';

// 补充源：Kyiv Post 英文 RSS。其正文常转述乌空军每日汇总战报（发射/拦截无人机、导弹总数），
// 是乌通社之外第二个能拿到该总数的公开来源。RSS 摘要只有开头两段、不含战报数字，须抓正文。
// 边界：只取「乌空军官方口径、对乌袭击、单夜」的发射与拦截总数，不碰坐标/航迹/战术情报。
const KP_FEED = 'https://www.kyivpost.com/feed';
const KP_NAME = 'Kyiv Post';

// ------- 乌克兰语关键词（仅兜底路径使用，不改动英文主路径）-------
const UA_ATTACK = /дрон|бпла|ша?хед|ракет|атак|удар|обстріл|обстр[іi]л|знищ|пошкодж|влучил|прил[іi]т/i;
const UA_PURE_TACTICAL = /коордінат|траєктор|геолокац|позиц[іi][яї]\s+ппо|радарн|стартов|маршрут\s+польоту|реальному\s+час/i;
const UA_OFFENSE = /українськ\w*\s+(?:сили|арм|військ|солдат)|бригад|поставк|допомог|навчан|тренув|власн\w*\s+виробництв|нафтопереробн|російськ\w*\s+(?:нафт|завод|територ|ґрунт)/i;
const UA_PLACE = /україн|києв|одес|харк|херсон|донец|луган|запор|крим|севаст|сум|полтав|дніпр|житомир|львів|миколаїв|черкас|черніг|вінниць|хмельниц|рівн|тернопіл|волин|закарпат|івано/i;
const UA_KILL = /загинул|загинули|убит|полягл|жертв/i;
const UA_INJ = /поранен|поранена|поранені|травмован|постраждал/i;
const UA_FAC_RE = /енергетичн|інфраструктур|підстанц|електр|житлов|будівл|завод|фабрик|комбінат|підприємств|мост|лікарн|склад|нафт|трубопровод|газ|тепл|вод|критичн/i;

const UA_WORD = {
  один: 1, одна: 1, одну: 1, одне: 1,
  двоє: 2, дві: 2, два: 2, двох: 2,
  троє: 3, три: 3,
  четверо: 4, чотири: 4,
  "п'ятеро": 5, "п'ять": 5,
  шестеро: 6, "шість": 6,
  семеро: 7, "сім": 7,
  восьмеро: 8, "вісім": 8,
  "дев'ятеро": 9, "дев'ять": 9,
  десятеро: 10, десять: 10,
  дванадцять: 12, дюжина: 12,
};
const UA_NUM = `(\\d[\\d,]*|один|одна|одну|одне|двоє|дві|два|двох|троє|три|четверо|чотири|п'ятеро|п'ять|шестеро|шість|семеро|сім|восьмеро|вісім|дев'ятеро|дев'ять|десятеро|десять|дванадцять|дюжина)`;

function toNumUa(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (/^\d/.test(s)) return parseInt(s.replace(/,/g, ''), 10);
  const w = UA_WORD[s];
  return (w != null) ? w : null;
}
function isAftermathUa(item) {
  const t = `${item.title} ${item.summary}`;
  if (!UA_ATTACK.test(t)) return false;
  if (UA_PURE_TACTICAL.test(t)) return false;
  if (UA_OFFENSE.test(t)) return false;
  return UA_PLACE.test(t) || UA_KILL.test(t) || UA_INJ.test(t) || UA_FAC_RE.test(t);
}
const UA_KILL_PAT = [
  new RegExp(`${UA_NUM}\\s*(?:люд|осіб|цивільн|військов|дітей|людина|жител|мешканц)?\\s*(?:загинул|загинули|убит|полягл|жертв)`, 'i'),
  new RegExp(`(?:загинул|загинули|убит|полягл|жертв)\\w*\\s*(?:люд|осіб|цивільн|військов|дітей|людина|жител|мешканц)?\\s*${UA_NUM}`, 'i'),
];
const UA_INJ_PAT = [
  new RegExp(`${UA_NUM}\\s*(?:люд|осіб|цивільн|військов|дітей|людина|жител|мешканц)?\\s*(?:поранен|поранена|поранені|травмован|постраждал)`, 'i'),
  new RegExp(`(?:поранен|поранена|поранені|травмован|постраждал)\\w*\\s*(?:люд|осіб|цивільн|військов|дітей|людина|жител|мешканц)?\\s*${UA_NUM}`, 'i'),
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
// upperBound 用于拦下明显不属于「单夜对乌发射」的异常数字（年份、累计、俄方口径）。
function maxOfAll(text, patterns, upperBound) {
  let max = null;
  for (const re of patterns) {
    const g = new RegExp(re.source, 'gi');
    let m;
    while ((m = g.exec(text)) !== null) {
      const n = toNum(m[1]);
      if (n != null && (upperBound == null || n <= upperBound) && (max == null || n > max)) max = n;
      if (m.index === g.lastIndex) g.lastIndex += 1;
    }
  }
  return max;
}
// 逐句扫描、跳过 badSentRe 命中的句子后再取最大值。
// 拦截数常出现在独立句（「防空击落 161 架」），不宜强制「对乌」语义，但必须避开俄方战报与
// 周/月累计句——否则「俄方称一周拦截 X 架乌军无人机」会被当成乌方单夜拦截数。
function maxOfAllFiltered(text, patterns, upperBound, badSentRe) {
  let max = null;
  const sentences = String(text).split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    if (badSentRe && badSentRe.test(s)) continue;
    for (const re of patterns) {
      const g = new RegExp(re.source, 'gi');
      let m;
      while ((m = g.exec(s)) !== null) {
        const n = toNum(m[1]);
        if (n != null && (upperBound == null || n <= upperBound) && (max == null || n > max)) max = n;
        if (m.index === g.lastIndex) g.lastIndex += 1;
      }
    }
  }
  return max;
}

// 在一个文本里按给定模式取第一个可解析的伤亡数（支持「数字+动词」与「动词+数字」双向）。
function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) {
      const raw = m[1] || m[2];
      const n = toNum(raw);
      if (n != null) return n;
      const nu = toNumUa(raw); // 乌克兰语数字词（троє/одна/двоє…）回退解析
      if (nu != null) return nu;
    }
  }
  return null;
}
const MISSILE_PAT = [new RegExp(`${NUM_GROUP}\\s*(?:cruise|guided|ballistic|iskander|kalibr)?\\s*missile`, 'i')];
const DRONE_PAT = [new RegExp(`${NUM_GROUP}\\s*(?:shahed|attack|unmanned|reconnaissance|explosive)?\\s*(?:drone|uav)s?\\b`, 'i')];
// 拦截数：只取官方战报里「拦截 / 击落」动词后的数字（如 neutralizes 271 of 317 → 271），不取发射数。
const INTER_DRONE_PAT = [new RegExp(`(?:neutraliz\\w*|intercept\\w*|down\\w*|shot\\s+down|destroy\\w*|suppress\\w*|eliminat\\w*)\\s*${NUM_GROUP}\\s*(?:of\\s+[\\d,]+)?\\s*(?:russian\\s+)?drones?`, 'i')];
const INTER_MISSILE_PAT = [new RegExp(`(?:neutraliz\\w*|intercept\\w*|down\\w*|shot\\s+down|destroy\\w*|suppress\\w*|eliminat\\w*)\\s*${NUM_GROUP}\\s*(?:of\\s+[\\d,]+)?\\s*(?:russian\\s+)?missiles?`, 'i')];

// 单夜「对乌发射」的合理上限：用于拦下年份（如 "by 2027 drone production"）、周/月累计、
// 俄方战报（俄国防部宣称单日拦截 2000+ 架乌方无人机）等混入的异常数字。
// 截至 2025 年底，乌空军记录的单夜最高约为 800+ 架无人机、200 枚导弹级别；此处留足余量，
// 但仍足以拦下 2000+ 这类明显不属于「单夜对乌发射」口径的数字。
const MAX_NIGHT_DRONES = 1500;
const MAX_NIGHT_MISSILES = 300;
// 整句排除项：俄方战报、周/月/年累计、年份累加、乌打俄等。命中整句不采信发射与拦截数字。
// 累计口径是「发射 2027 架 / 165 枚」这类错误的主要来源（如「一周累计 2,700 架无人机、165 枚导弹」），
// 必须逐句排除，而非只在跨报道取最大值时靠上限兜。产能/演习等词不在此列——它们多出现在
// 「计划到 2027 年翻倍产能」这类无对乌语义的句子，靠 AT_UKRAINE 与上限即可拦下，放进这里会误伤
// 「俄罗斯袭击乌克兰生产设施」的正常战报。
const BAD_LAUNCH_SENT = /russian\s+defen[sc]e\s+ministry|russia'?s?\s+defen[sc]e\s+ministry|russia\s+claims|russian\s+state\s+media|\b(?:past|over|in)\s+(?:the\s+)?(?:week|month|year)|\b(?:one|a|last|this|the)\s+week\b|\bper\s+(?:week|month|year)|\bthis\s+(?:week|month|year)|\bsince\s+(?:the\s+)?(?:beginning|start|20\d\d)|\bby\s+20\d\d\b|\buntil\s+20\d\d\b|\bin\s+20\d\d\b|ukrain\w*\s+(?:drone|force|missile)s?\s+(?:target|hit|strike|attack)\s+(?:russia|moscow|crimean)/i;
// 战报类报道识别：命中「防空战果动词 + 数字」或「对乌大规模发射」表述才算战报。
// 刻意不匹配「N drones/missiles」这种裸计数——否则 ISW 战役评估、装备分析这类文章里的
// 背景数字会混进当天窗口，把不同夜的口径拼在一起（线上曾出现「186 架」被 ISW 的「148 架」顶掉），
// 也会让「一周累计 2,700 架」这类统计稿进入战报池而污染发射数。
const BATTLE_RE = /(?:neutrali[sz]\w*|intercept\w*|shot\s+down|downed|destroy\w*|suppress\w*)\s*(?:about\s+|over\s+|nearly\s+|some\s+)?\d+|\d+\s*(?:russian\s+)?(?:shahed|kamikaze|attack|strike)\s+(?:drones?|uavs?)|launch\w*\s+(?:about\s+|over\s+|nearly\s+|some\s+)?\d+\s*(?:shahed|drones?|uavs?|missiles?)|massive\s+(?:drone|missile|combined)|(?:drone|missile|air)\s+attack\s+on\s+ukraine|\d+\s*of\s*\d+\s+(?:russian\s+)?(?:drones?|uavs?|missiles?)/i;
// 「对乌发射」语义：Russian 主语 + 对乌/夜间袭击。
const RU_SUBJECT = /\brussia(?:n)?\b/i;
const AT_UKRAINE = /(?:at|against|toward|towards|into|across|on)\s+(?:ukraine|ukrainian|kyiv|odesa|odessa|kharkiv|dnipro|zaporizhzhia|sumy|poltava|chernihiv|mykolaiv|lviv|kherson|donetsk)|overnight|targeting\s+ukraine|across\s+ukraine/i;

// 逐句提取「对乌发射」的无人机/导弹数：只采信「Russian 主语 + 对乌/夜间袭击」的句子，
// 排除俄方战报、累计口径与产能表述，并做单夜数值上限校验。返回 {drones, missiles}。
// 这是修复「发射 2027 架」这类错误的主闸门：2027 往往来自年份表述，既无对乌语义也超上限。
function extractLaunchCounts(text, requireRussian = true) {
  const out = { drones: null, missiles: null };
  const sentences = String(text).split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    if (BAD_LAUNCH_SENT.test(s)) continue;
    // 所有路径都要求「对乌」语义；严格要求时再加 Russian 主语（更可信）。
    if (!AT_UKRAINE.test(s)) continue;
    if (requireRussian && !RU_SUBJECT.test(s)) continue;
    // (?<![\w-]) 排除「Kh-101 / X-101」等型号编号，避免把型号当成枚数。
    const dRe = new RegExp(`(?<![\\w-])${NUM_GROUP}\\s*(?:shahed|attack|unmanned|reconnaissance|explosive|jet[- ]powered|cruise)?\\s*(?:drone|uav)s?\\b`, 'gi');
    let m;
    while ((m = dRe.exec(s)) !== null) {
      const n = toNum(m[1]);
      if (n != null && n >= 2 && n <= MAX_NIGHT_DRONES && (out.drones == null || n > out.drones)) out.drones = n;
      if (m.index === dRe.lastIndex) dRe.lastIndex += 1;
    }
    const mRe = new RegExp(`(?<![\\w-])${NUM_GROUP}\\s*(?:cruise|guided|ballistic|iskander|kalibr)?\\s*missiles?`, 'gi');
    while ((m = mRe.exec(s)) !== null) {
      const n = toNum(m[1]);
      if (n != null && n >= 1 && n <= MAX_NIGHT_MISSILES && (out.missiles == null || n > out.missiles)) out.missiles = n;
      if (m.index === mRe.lastIndex) mRe.lastIndex += 1;
    }
  }
  return out;
}
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
  // 战报类报道（含「拦截 / 击落」等防空动词）单独成组：发射总数与拦截数只应从这类报道里取。
  // 否则「某地遭无人机袭击致 1 死」这类事件稿里的零散数字会参与跨报道取最大，
  // 把不同夜、不同地区的口径混在一起（此前 2027 / 165 / 101 反复出现的制度性原因）。
  const battle = dedup.filter((it) => BATTLE_RE.test(`${it.title} ${it.summary}`));
  const battlePool = battle.length ? battle : dedup;

  const enriched = battlePool.map((it) => {
    const text = `${it.title} ${it.summary}`;
    // 发射数两级：先要求 Russian 主语（最可信），为空再放宽到仅需「对乌」语义。
    // 两条路径都受句子级排除（累计/俄方/年份）与单夜上限约束，不再有无归属的全文取最大值。
    const strict = extractLaunchCounts(text, true);
    const loose = (strict.drones == null || strict.missiles == null) ? extractLaunchCounts(text, false) : strict;
    return {
      ...it,
      text,
      m: strict.missiles != null ? strict.missiles : loose.missiles,
      d: strict.drones != null ? strict.drones : loose.drones,
      // 拦截数：逐句过滤俄方/累计句后取最大，并受单夜上限约束。
      interD: maxOfAllFiltered(text, INTER_DRONE_PAT, MAX_NIGHT_DRONES, BAD_LAUNCH_SENT),
      interM: maxOfAllFiltered(text, INTER_MISSILE_PAT, MAX_NIGHT_MISSILES, BAD_LAUNCH_SENT),
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

  // 乌通社当天若未发汇总战报（发射/拦截有缺口），从 Kyiv Post 正文补乌空军官方总数。
  // 只补缺口，不覆盖乌通社已有数字；不碰伤亡与目标（那些来自乌通社事件报道，已足够详实）。
  let kpUsed = false;
  if (missiles == null || drones == null || interDrones == null || interMissiles == null) {
    try {
      const kp = await fetchKyivPostTotals(now, windowStart);
      if (kp) {
        if (drones == null && kp.launchD != null) { drones = kp.launchD; kpUsed = true; }
        if (missiles == null && kp.launchM != null) { missiles = kp.launchM; kpUsed = true; }
        if (interDrones == null && kp.interD != null) { interDrones = kp.interD; kpUsed = true; }
        if (interMissiles == null && kp.interM != null) { interMissiles = kp.interM; kpUsed = true; }
        sources.push({ name: KP_NAME + ' · 正文战报', count: 1, url: kp.url });
      }
    } catch (err) {
      console.warn(`[warn] Kyiv Post 发射/拦截数补全失败：${err?.message || err}`);
    }
  }

  // 一致性闸门：拦截数不可能超过发射数。出现矛盾说明两个数字来自不同口径
  // （例如把「俄方拦截乌方无人机」误当成「乌方拦截俄方无人机」），此时丢弃拦截数，
  // 宁可只显示发射数，也不展示自相矛盾的数字。
  if (drones != null && interDrones != null && interDrones > drones) interDrones = null;
  if (missiles != null && interMissiles != null && interMissiles > missiles) interMissiles = null;

  // 伤亡：窗口内各报道明确提及的 killed / injured 累计求和（去重后不同事件近似当日总伤亡）。
  // 注意用 dedup 而非 enriched——伤亡来自事件稿，战报组里通常没有，限定在战报里反而会漏。
  let killedSum = 0;
  let injuredSum = 0;
  let hasCas = false;
  for (const e of dedup) {
    const text = `${e.title} ${e.summary}`;
    const k = firstMatch(text, KILL_PAT);
    const i = firstMatch(text, INJ_PAT);
    if (k != null) { killedSum += k; hasCas = true; }
    if (i != null) { injuredSum += i; hasCas = true; }
  }

  // 重点目标：聚合窗口内所有「设施类」事件报道，逐一翻译摘要后拼接，得到比单条摘要更丰富的罗列，
  // 逼近手工校订的详度（如能源设施、变电站、居民楼停暖、多地断电等分项并列）。最多取 4 条去重报道。
  // 重点目标/代表性来源仍从全部去重报道里挑：战报稿往往只谈总数，设施类事件写在别的稿子里。
  const byNewest = dedup.slice().sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const spine = byNewest[0] || null;
  const facReports = byNewest.filter((e) => FAC_RE.test(`${e.title} ${e.summary}`));
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
    // 翻译后的摘要本身已带句末「。」，拼接前先剥掉末尾句号，再用「；」连接、末尾补一个，避免「。；」重复标点。
    const joined = zhs.map((z) => (z && z.trim()) ? z.trim().replace(/[。.]+$/, '') : '').filter(Boolean);
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
    source: SOURCE_NAME + (kpUsed ? ' + Kyiv Post' : ''),
    sourceType: kpUsed
      ? '乌通社英文 RSS 自动索引；发射/拦截总数由 Kyiv Post 转述的乌空军通报补全（均仅官方公布数字）'
      : '乌通社英文 RSS 自动索引（破例含乌空军战报发射与拦截统计）',
    url: spine ? spine.url : '',
    missiles: missilesStr,
    drones: dronesStr,
    casualties: casualtiesZh,
    targets,
    note: '',
  };
  return { ok: true, sources, items: [item] };
}

// ----------------------------------------------------------------- Interfax 兜底（乌通社维护时）
// 仅取事件级报道的伤亡与重点目标；发射 / 拦截无人机、导弹总数乌通社之外无可信来源，如实标「暂缺」。
async function buildInterfax() {
  let raw;
  try {
    raw = news.parseRss(await news.fetchText(INTERFAX_FEED), INTERFAX_NAME);
  } catch (err) {
    return { ok: false, sources: [{ name: INTERFAX_NAME, error: String(err?.message || err) }], items: [] };
  }
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const candidates = raw.filter((it) => {
    const t = Date.parse(it.publishedAt);
    return Number.isFinite(t) && t <= now && t >= windowStart && isAftermathUa(it);
  });
  const seen = new Set();
  const dedup = [];
  for (const it of candidates) {
    const k = news.urlKey(it.url);
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(it);
  }
  if (!dedup.length) return { ok: true, sources: [{ name: INTERFAX_NAME, count: 0 }], items: [] };

  // 事件级伤亡：跨报道累计求和（去重后各事件近似当日事件伤亡）。
  let killedSum = 0;
  let injuredSum = 0;
  let hasCas = false;
  for (const it of dedup) {
    const text = `${it.title} ${it.summary}`;
    const k = firstMatch(text, UA_KILL_PAT);
    const i = firstMatch(text, UA_INJ_PAT);
    if (k != null) { killedSum += k; hasCas = true; }
    if (i != null) { injuredSum += i; hasCas = true; }
  }

  const byNewest = dedup.slice().sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const spine = byNewest[0] || null;
  const facReports = byNewest.filter((e) => UA_FAC_RE.test(`${e.title} ${e.summary}`));
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
    const joined = zhs.map((z) => (z && z.trim()) ? z.trim().replace(/[。.]+$/, '') : '').filter(Boolean);
    if (joined.length) targets = joined.join('；') + '。';
  }

  const date = kyivDateStr(now);
  const casualtiesZh = hasCas
    ? [killedSum ? `${killedSum} 人死亡` : null, injuredSum ? `${injuredSum} 人受伤` : null].filter(Boolean).join('、')
    : '未公布';
  const item = {
    date,
    title: `俄罗斯对乌袭击事件后果（Interfax 事件级索引，截至 ${date}）`,
    source: INTERFAX_NAME,
    sourceType: 'Interfax-Ukraine 乌克兰语 RSS 事件级索引（乌通社维护期间兜底；发射/拦截总数暂缺）',
    url: spine ? spine.url : '',
    missiles: '乌通社维护中暂缺',
    drones: '乌通社维护中暂缺',
    casualties: casualtiesZh,
    targets,
    note: '乌通社英文 RSS 维护中（HTTP 503），发射/拦截无人机与导弹总数暂无法获取；下列为 Interfax-Ukraine 当日事件级报道汇总的伤亡与重点目标，并非当日总战报。',
  };
  return { ok: true, sources: [{ name: INTERFAX_NAME, count: dedup.length }], items: [item] };
}

// ----------------------------------------------------------------- Kyiv Post 正文兜底（补发射/拦截总数）
// Kyiv Post 的 RSS 摘要只有开头两段、不含乌空军战报数字，须抓正文。为防污染，逐句校验归属：
// 只认「Russian 对乌袭击 + 乌空军通报」的发射总数与「乌方拦截动词 + 数字」的拦截数，
// 排除乌打俄（Moscow/Russia targeted）、周累计（week/month）、俄方战报（Russian Defense Ministry claimed）。
const KP_ARTICLE_TAG = /<article\b[^>]*>([\s\S]*?)<\/article>/i;
// 发射句主语须为 Russian 对乌袭击。
const KP_LAUNCH_SENT = /russian|russia(?:'s)?\s+/i;
// 对乌发射语义：launched X drones at/against/across Ukraine、overnight assault on Ukraine 等。
// ISW 等也转述乌空军战报，未必带 "Air Force reported" 字样，故以「对乌发射」语义放行发射数。
const KP_AT_UKRAINE = /\b(?:at|against|toward|towards|into|across)\s+(?:ukraine|ukrainian|kyiv|odesa|kharkiv|dnipro|zaporizhzhia|chernivtsi)|\bovernight\b/i;
// 归属：乌克兰空军 / 乌克兰防空。拦截战报常写 "Ukrainian air defenses shot down..."。
const KP_UA_AIR = /ukraine'?s?\s+air\s+(?:force|defen[sc]e)|ukrainian\s+air\s+defen[sc]e|air\s+force\s+(?:reported|said|spokes|command)/i;
// 数字捕获组：m[1]=数字，m[2]=武器类型。
// (?<![\w-]) 负向后顾：排除「Kh-101 / X-101 / S-300 / Iskander-M」这类武器型号编号，
// 否则「Kh-101 Missile」会被误读成「101 枚导弹」。
const KP_LAUNCH_NUM = /(?<![\w-])(\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen)\s+(?:russian\s+)?(?:strike\s+|attack\s+|shahed[^\s,]*\s+|jet[- ]powered\s+|cruise\s+|ballistic\s+|guided\s+)?(drone|uav|missile)s?\b/gi;
const KP_INTER_NUM = /(?:shot\s+down(?:\s+or\s+suppress\w*)?|suppress\w*|intercept\w*|neutraliz\w*|destroy\w*)\s+(?<![\w-])(\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen)\s+(?:russian\s+)?(drone|uav|missile)s?\b/gi;
// 一句话里出现这些即判为战术/非对乌/累计/俄方口径，整句排除。
// crashed/debris/poland 等：排除「导弹残骸坠落在第三国并接受调查」这类与对乌发射无关的报道，
// 这类报道常含「Kh-101」「fallen debris」等字样，是型号误读与数字污染的常见来源。
// 时间/事件口径：跨日综述（「本周最大规模袭击」「一天前的那次空袭」）会把其他夜晚的数字带进来。
// 我方窗口只认「单夜/刚过去的一夜」，命中这些词即整句排除。ISW 那句「...against Ukraine overnight.」
// 不受影响，仍是唯一被放行的 ISW 句式（ISW_LINE 已在上面单独豁免）。
// 时间/事件口径：跨日综述（「一夜进入周五那次空袭」「本周最大规模袭击」「一周前那次」）会把别的夜晚的
// 数字带进来。凡是句内出现指向「过去某夜/整整一周前」的时间锚点，就整句排除——即使句子本身带
// 「对乌 + overnight」语义。判别式取「方向性词 + 日期/星期/周期」，避免误伤
// 「launched ... against Ukraine overnight」（无方向词，是我们要的那句）。
const KP_OFFNIGHT_SENT = new RegExp([
  // 指向「过去某夜/某次行动」的时间锚点（含方向词，避免误伤单夜战报）
  '\\b(?:into|on|since|from)\\s+(?:(?:the\\s+)?(?:morning|evening|night)\\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\b',
  '\\b(?:days?|nights?|weeks?|months?)\\s+(?:ago|earlier|before)\\b',
  '\\b(?:last|this|that|previous|earlier)\\s+(?:night|week|month|morning|evening)\\b',
  '\\b\\d{1,2}\\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\\b',
  // 跨夜/多夜口径与「年度最大规模」这类综述
  '\\b(?:during|throughout|across)\\s+(?:the\\s+)?(?:overnight|night)\\b',
  '\\bovernight\\s+and\\s+(?:morning|early\\s+morning)\\b',
  '\\b\\d{1,2}-hour\\s+(?:bombardment|attack|assault)',
  '\\b(?:one\\s+of\\s+)?(?:its\\s+)?largest\\s+(?:aerial\\s+)?(?:assault|attack|strike)s?\\b',
  '\\blargest\\s+(?:aerial\\s+)?(?:assault|attack|strike)s?\\s+of\\s+the\\s+year',
  // 事件先后关系：数字讲的是更早那次行动（桥梁累计、峰会之后、某次打击之前）
  '\\bprior\\s+to\\b', '\\b(?:ahead\\s+of|earlier\\s+than)\\b',
  '\\battacks?\\s+(?:on|against)\\s+(?:ukrainian\\s+)?bridges?',
  '\\b(?:hours?|days?|weeks?)\\s+after\\b', '\\bfollowed\\s+by\\b',
].join('|'), 'i');

const KP_BAD_SENT = /moscow|russian\s+defen[sc]e\s+ministry|russia'?s?\s+defen[sc]e\s+ministry|russian\s+air\s+defen[sc]e|russia\s+claims|russian\s+state\s+media|\b(?:past|over)\s+(?:the\s+)?(?:week|month)|\bin\s+(?:one|a|the)\s+week\b|\bin\s+one\s+week|\bin\s+a\s+week|\bper\s+(?:week|month)|\b(?:this|last)\s+week\b|\bsince\s+(?:the\s+)?beginning|ukrain\w*\s+(?:drone|force|missile)s?\s+(?:target|hit|strike|attack)\s+(?:russia|moscow|crimean)|defen[sc]e\s+company|exercise|crashed|crash(?:ed|es)?\b|debris|fragment|forensic|prosecutor|impact\s+zone|built\s+in|poland|romania|moldova/i;

// 强污染标记：即使命中 ISW 句式也不能采信。累计口径、俄方战报、第三国残骸等都在此列。
const KP_HARD_BAD = /\b(?:past|over|in)\s+(?:one|a|the)?\s*(?:week|month|year)\b|\b(?:one|a)\s+week\b|\bper\s+(?:week|month)|russian\s+defen[sc]e\s+ministry|russia'?s?\s+defen[sc]e\s+ministry|\bpoland\b|\bromania\b|\bmoldova\b|\bby\s+20\d\d\b/i;

async function fetchArticleText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kyiv-live-aftermath/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const m = KP_ARTICLE_TAG.exec(html);
  let body = m ? m[1] : html;
  // 关键：只取正文，剔掉「相关文章 / 热门文章」推荐位。
  // 推荐位里往往混着别的日期的战报标题（如「Russia Fires 84 ...」），
  // 剥完标签后会和正文连成一句，曾被当成当夜发射总数（线上出现过 404 架 / 84 枚）。
  // 原文使用视觉隐藏的可疑链接时也会出现在 body 里，一并去掉。
  body = body
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ')
    // 「More on ...」之类的相关文章列表：div 嵌套深，逐层剥不干净，直接按起点截掉尾部。
    .replace(/<div[^>]*(?:id|class)="[^"]*related-posts[^"]*"[\s\S]*$/i, ' ')
    .replace(/<!--\s*Start additional posts[\s\S]*$/i, ' ')
    .replace(/<div[^>]*(?:class|id)="[^"]*(?:related|popular|more-news|recommend|read-more|trending|sidebar)[^"]*"[^>]*>[\s\S]*?<\/div>/gi, ' ');
  return String(body)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&[a-z]+;|&#\d+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 从战报正文的句子里抽发射与拦截数（返回 {launchD,launchM,interD,interM}）。
// 归属规则：发射数句须含 Russian 对乌袭击主语 + 乌空军归属；拦截数句须含乌方归属与拦截动词。
// 特例：ISW 战役评估类文章常在「关键要点」里用列点写「Russia launched three missiles and 148 drones
// against Ukraine overnight.」——这种句子本身是干净的乌空军口径战报，不该因为标题是「ISW 评估」
// 就被整篇丢弃（否则 148 会顶掉官方 186）。这里让 ISW 篇章走同一套严格归属校验，只放行
// 明确「对乌 + overnight + 发射」语义的句子，背景段落里的零散数字仍被上限/归属拦下。
function extractKpBattle(text) {
  const out = { launchD: null, launchM: null, interD: null, interM: null };
  const sentences = String(text).split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    if (KP_OFFNIGHT_SENT.test(s)) continue; // 跨日综述，数字不属于今夜
    // 豁免只针对 ISW 句式，且该句不得带累计/俄方/第三国等强污染标记（否则「一周累计」句会借道放行）。
    if (KP_BAD_SENT.test(s) && !(ISW_LINE.test(s) && KP_AT_UKRAINE.test(s) && !KP_HARD_BAD.test(s))) continue;
    const hasUaAir = KP_UA_AIR.test(s);
    let m;
    KP_LAUNCH_NUM.lastIndex = 0;
    while ((m = KP_LAUNCH_NUM.exec(s)) !== null) {
      // 发射总数：Russian 主语 + （乌空军归属 或 明确对乌发射语义），排除个位数局部战果。
      if (!(KP_LAUNCH_SENT.test(s) && (hasUaAir || KP_AT_UKRAINE.test(s)))) continue;
      const n = toNum(m[1]);
      const isMissile = /missile/i.test(m[2]);
      const cap = isMissile ? MAX_NIGHT_MISSILES : MAX_NIGHT_DRONES;
      if (n == null || n < 2 || n > cap) continue; // 超单夜上限的视为年份/累计混入
      const slot = isMissile ? 'launchM' : 'launchD';
      if (out[slot] == null || n > out[slot]) out[slot] = n;
    }
    KP_INTER_NUM.lastIndex = 0;
    while ((m = KP_INTER_NUM.exec(s)) !== null) {
      // 拦截数：须带乌方防空归属，避免混入俄方击落乌机数字。
      if (!hasUaAir) continue;
      const n = toNum(m[1]);
      const isMissile = /missile/i.test(m[2]);
      const cap = isMissile ? MAX_NIGHT_MISSILES : MAX_NIGHT_DRONES;
      if (n == null || n < 2 || n > cap) continue;
      const slot = isMissile ? 'interM' : 'interD';
      if (out[slot] == null || n > out[slot]) out[slot] = n;
    }
  }
  return out;
}

// ISW 战役评估篇章的特殊标记：
// - ISW_TITLE：标题识别（便于把这类篇章纳入候选）；
// - ISW_LINE：句内「发射 + 对乌 + 夜间」语义（用于在被 KP_BAD_SENT 误伤时放行）。
// 这两条只放宽「要不要读这篇/这句」，不放宽数值校验——上限与归属校验照旧生效。
const ISW_TITLE = /ISW\s+Russian\s+Offensive|Institute\s+for\s+the\s+Study\s+of\s+War|Campaign\s+Assessment/i;
const ISW_LINE = /(?:launch\w*|fired)\b[^.]{0,80}(?:drone|uav|missile)[^.]{0,60}(?:at|against|toward)\s+ukraine/i;

// 抓 Kyiv Post 正文，提取当日对乌袭击的发射/拦截总数。失败或无干净结果返回 null。
async function fetchKyivPostTotals(now, windowStart) {
  let xml;
  try { xml = await news.fetchText(KP_FEED); } catch { return null; }
  const feed = news.parseRss(xml, KP_NAME);
  // 标题须像对乌袭击战报；排除乌打俄、周累计、军援/测试/演习等。
  const candidates = feed.filter((it) => {
    const t = Date.parse(it.publishedAt);
    if (!(Number.isFinite(t) && t <= now && t >= windowStart)) return false;
    const title = it.title;
    // ISW 战役评估的标题里没有袭击关键词，但正文「关键要点」常含官方夜间发射总数，
    // 是乌通社当日缺汇总战报时最干净的一份补全来源，单独放行。
    if (ISW_TITLE.test(title)) return true;
    if (!/russian|russia|strike|attack|assault|drone|missile|kill|injur|shell/i.test(title)) return false;
    if (KP_BAD_SENT.test(title)) return false;
    return true;
  });
  // 战报信号优先：综合伤亡/对乌袭击/跨城袭击的报道最可能含乌空军发射与拦截总数。
  const battleScore = (it) => {
    const t = it.title;
    let s = 0;
    if (/\bkill|injur|dead|death/i.test(t)) s += 3;
    if (/across ukraine|overnight|assault|massive/i.test(t)) s += 2;
    if (/strike|attack|drone|missile/i.test(t)) s += 1;
    return s;
  };
  candidates.sort((a, b) => (battleScore(b) - battleScore(a)) || (Date.parse(b.publishedAt) - Date.parse(a.publishedAt)));
  const picked = candidates.slice(0, 12);

  const best = { launchD: null, launchM: null, interD: null, interM: null, url: '' };
  for (const it of picked) {
    let text;
    try { text = await fetchArticleText(it.url); } catch { continue; }
    const b = extractKpBattle(text);
    if (b.launchD != null && (best.launchD == null || b.launchD > best.launchD)) { best.launchD = b.launchD; best.url = it.url; }
    if (b.launchM != null && (best.launchM == null || b.launchM > best.launchM)) best.launchM = b.launchM;
    if (b.interD != null && (best.interD == null || b.interD > best.interD)) best.interD = b.interD;
    if (b.interM != null && (best.interM == null || b.interM > best.interM)) best.interM = b.interM;
  }
  if (best.launchD == null && best.launchM == null && best.interD == null && best.interM == null) return null;
  return best;
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
    // 防回退：同一天内，若新结果比缓存里的「更弱」，不要用弱结果覆盖强结果。
    // 「更强」的判据是发射数是否给出（线上实测出现过 186/161 被一轮降级结果 148 顶回去）。
    const prev = readCache();
    if (prev && prev.cachedDate === cachedDate && Array.isArray(prev.items) && prev.items.length) {
      const score = (list) => {
        const d = list[0] && String(list[0].drones || '');
        const m = list[0] && String(list[0].missiles || '');
        return { launch: /发射\s*\d/.test(d) ? 1 : 0, missiles: /发射\s*\d+\s*枚/.test(m) ? 1 : 0 };
      };
      const a = score(prev.items);
      const b = score(items);
      if (a.launch > b.launch || a.missiles > b.missiles) {
        console.log('袭击后果：本轮结果弱于当日缓存（缺发射数），保留缓存不覆盖');
        return;
      }
    }
    fs.writeFileSync(CACHE_FILE, `${JSON.stringify({ cachedDate, generatedAt: new Date().toISOString(), items })}\n`, 'utf8');
  } catch (err) {
    console.warn(`[warn] 袭击后果缓存写入失败：${err?.message || err}`);
  }
}

// 继承（缓存 / 线上快照 / 种子）前的理智检查：字符串里出现的发射/拦截数字必须落在单夜上限内。
// 这样即使历史上写坏过一条快照，也不会被后续每一轮抓取反复继承下去——修好提取逻辑后
// 能靠这个闸门自动跳出「坏数据自我复制」的循环。
function isSaneItem(it) {
  if (!it || typeof it !== 'object') return false;
  const fields = [it.drones, it.missiles].filter((s) => typeof s === 'string' && s);
  for (const s of fields) {
    const nums = String(s).match(/\d[\d,]*/g) || [];
    for (const raw of nums) {
      const n = toNum(raw);
      if (n == null) continue;
      const isMissile = /导弹/.test(s);
      const cap = isMissile ? MAX_NIGHT_MISSILES : MAX_NIGHT_DRONES;
      if (n > cap) return false;
    }
  }
  return true;
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
    // 只继承成品态（date 字段齐全）的条目。抓取失败时的 wrap 分支可能产出缺 date 的残缺条目，
    // 那种条目一旦被继承，会一路以「cached」状态自我复制（线上曾出现 aftermath 停在 11-21 的旧件）。
    return old.filter((it) => it && typeof it.date === 'string' && it.date).slice(0, 1);
  } catch {
    return [];
  }
}

async function getAftermath(force = false) {
  const kd = kyivDateStr();
  const cached = readCache();
  // 当日缓存要能用：既要日期对得上，内容也要过理智检查。
  // 否则历史上写坏的当日缓存会一直生效，修好提取逻辑也看不到变化（线上曾连续 10+ 分钟复用旧结果）。
  if (!force && cached && cached.cachedDate === kd && Array.isArray(cached.items) && cached.items.every(isSaneItem)) {
    console.log(`袭击后果：使用 ${kd} 当日缓存（${cached.items.length} 条）`);
    return wrap(cached.items, cached.generatedAt, 'cached');
  }
  if (!force && cached && cached.cachedDate === kd && !cached.items.every(isSaneItem)) {
    console.warn('[warn] 当日缓存含异常数字，丢弃并重新抓取');
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

  // 乌通社不可用：尝试 Interfax 乌克兰语 RSS 兜底（仅事件级伤亡与重点目标；发射/拦截总数仍缺）。
  try {
    const ifx = await buildInterfax();
    if (ifx.ok && ifx.items.length) {
      console.log(`袭击后果：Interfax 兜底 ${ifx.items.length} 条（partial）`);
      return wrap(ifx.items, new Date().toISOString(), 'partial');
    }
  } catch (err) {
    console.warn(`[warn] 袭击后果 Interfax 兜底失败：${err?.message || err}`);
  }

  // 今日无战报或抓取失败：沿用缓存里最近一次成功结果（可能跨日），明确标注数据源状态。
  if (cached && Array.isArray(cached.items) && cached.items.length && cached.items.every(isSaneItem)) {
    const items = cached.items.map((it) => ({ ...it, note: `乌通社等数据源今日暂未推送战报（或维护中），数据沿用 ${it.date}` }));
    console.log(`袭击后果：沿用缓存 ${cached.cachedDate}（carried）`);
    return wrap(items, cached.generatedAt, 'carried');
  }


  // 完全没有缓存：尝试线上快照继承，再不行用 APK 内置种子。
  // 注意：线上快照很可能正是这次要修正的旧结果（历史错误数字会在这里被「继承」回来，
  // 导致修好的提取逻辑永远看不到效果），所以继承必须先过 sanity 检查，离谱数字直接丢弃。
  const online = (await fallbackFromOnline()).filter(isSaneItem);
  if (online.length) {
    const items = online.map((it) => ({ ...it, note: '乌通社英文 RSS 维护中（HTTP 503），自动索引暂未取得今日数据，显示线上最近一条' }));
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

module.exports = {
  getAftermath, isAftermath, kyivDateStr, build,
  extractKpBattle, fetchArticleText, fetchKyivPostTotals,
  // 导出提取器与上限，便于单测校验（不影响运行时行为）。
  extractLaunchCounts, MAX_NIGHT_DRONES, MAX_NIGHT_MISSILES,
};
