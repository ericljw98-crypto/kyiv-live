#!/usr/bin/env node
'use strict';

// 从公开新闻 RSS 搜集「袭击后果」报道候选，供人工校订后写入 data/aftermath.json。
//
// 这个脚本只生成候选清单（标题、链接、发布时间、来源），不抽取、不推断任何
// 数字：公开报道里「发射 172 架」与「击落 149 架」、不同来源的伤亡口径经常
// 出现在同一段文字里，自动正则抽取必然把拦截数当成发射数。数字一律由人工
// 对照原文校订，未经校订的条目不会进入快照，也不会显示到手机上。
//
// 用法： npm run aftermath:candidates [-- --days 14]
// 输出： data/aftermath-candidates.json

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'aftermath-candidates.json');
const QUERIES = [
  '基辅 袭击 导弹 无人机 伤亡',
  '基辅 空袭 伤亡',
  '乌克兰 空袭 无人机 导弹',
  'Kyiv attack missiles drones casualties',
];
const dayArg = process.argv.indexOf('--days');
const DAYS = Math.max(1, Math.min(180, Number(process.argv[dayArg + 1]) || 45));
const SINCE = Date.now() - DAYS * 24 * 60 * 60 * 1000;

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}
function tag(block, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? decode(m[1]) : '';
}
// Bing 新闻 RSS 的 link 是 apiclick.aspx 跳转，原文直链在 url 参数里。
function directUrl(u) {
  try {
    const target = new URL(u).searchParams.get('url');
    if (target && /^https?:\/\//i.test(target)) return target;
  } catch { /* 已是直链或格式异常时原样保留 */ }
  return u;
}

async function fetchRss(query) {
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kyiv-live-index/1.0)' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  if (!/<rss\b|<feed\b/i.test(xml)) throw new Error('返回内容不是 RSS');
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  return blocks.map((b) => {
    const published = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated');
    const ts = Date.parse(published);
    return {
      title: tag(b, 'title'),
      url: directUrl(tag(b, 'link')),
      publishedAt: Number.isFinite(ts) ? new Date(ts).toISOString() : '',
      source: tag(b, 'News:Source') || tag(b, 'source') || '公开新闻聚合',
      summary: tag(b, 'description').slice(0, 180),
      query,
    };
  }).filter((it) => it.title && /^https?:\/\//i.test(it.url));
}

async function main() {
  const seen = new Set();
  const all = [];
  const failures = [];
  for (const q of QUERIES) {
    try {
      for (const it of await fetchRss(q)) {
        const key = it.url.replace(/[?#].*$/, '');
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(it);
      }
    } catch (err) {
      failures.push(`${q}：${err.message}`);
    }
  }
  if (!all.length) {
    // 抓取失败时保留上一份候选，避免用一个空文件覆盖已有线索。
    console.warn(`[warn] 未取得任何候选（${failures.join('；') || 'RSS 无结果'}），保留上一份候选文件。`);
    process.exit(1);
  }
  let items = all.filter((it) => {
    const ts = Date.parse(it.publishedAt);
    return !Number.isFinite(ts) || ts >= SINCE;
  });
  // 时间窗内恰好没有报道时保留全部候选，并在结果里标注，避免搜集结果为空。
  const relaxed = items.length === 0;
  if (relaxed) items = all;
  items.sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));
  const out = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    note: '候选清单只含标题、链接、发布时间与来源。数字必须对照原文人工校订后写入 data/aftermath.json，未校订条目不会进入快照。',
    queries: QUERIES,
    days: DAYS,
    relaxedDateWindow: relaxed,
    failures,
    items: items.slice(0, 60),
  };
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  console.log(`已生成 ${out.items.length} 条候选：${path.relative(ROOT, OUT)}`
    + (relaxed ? '（时间窗内无结果，已放宽日期）' : '')
    + (failures.length ? `（${failures.length} 个查询失败）` : ''));
}

main().catch((err) => {
  console.error(`候选搜集失败：${err.message}`);
  process.exit(1);
});
