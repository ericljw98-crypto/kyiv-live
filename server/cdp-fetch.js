'use strict';

// 通过本机 Chrome 的 DevTools 协议（CDP）拉取页面原始响应，绕过目标站点的 WAF/反爬。
// 适用于服务端直接 fetch 被 403 / 反爬墙拦截的站点（如美国驻乌克兰使馆 RSS）。
// 默认连 127.0.0.1:9222（本机 Chrome 须带 --remote-debugging-port=9222 启动）；
// 也可经环境变量 CDP_HTTP 指向 ngrok 等转发地址（Host 头统一设为 localhost 以通过 Chrome 校验）。
//
// 与 cdp_search2.js 的区别：后者取 innerText 做检索，本模块取 Network.getResponseBody
// 拿原始响应体（XML/JSON 等），用于结构化解析。

const http = require('node:http');
const WS = globalThis.WebSocket || (() => { throw new Error('当前 Node 无全局 WebSocket'); })();

const DEFAULT_BASE = process.env.CDP_HTTP || 'http://127.0.0.1:9222';
const CDP_HOST = 'localhost:9222';

function httpJson(method, pathname, base) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(pathname, base); } catch (e) { return reject(e); }
    const req = http.request(
      {
        method,
        host: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        headers: { Host: CDP_HOST, Accept: 'application/json' },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(d)); }
          catch (e) { reject(new Error(`CDP 响应非 JSON：${d.slice(0, 120)}`)); }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('CDP HTTP 超时')); });
    req.end();
  });
}
const httpGetJson = (p, b) => httpJson('GET', p, b);

function cdpSession(wsUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WS(wsUrl); } catch (e) { return reject(e); }
    const pending = new Map();
    let msgId = 0;
    const state = { requestId: null, navLoaderId: null, loadFired: false };
    const waiters = { body: null };
    const timers = [];

    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      try { ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { pending.delete(id); reject(e); }
      timers.push(setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP 指令超时：${method}`)); }
      }, timeoutMs));
    });

    ws.onopen = () => resolve({ ws, send, pending, state, waiters, timers });
    ws.onerror = (e) => reject(new Error(`WebSocket 错误：${e?.message || e}`));

    ws.onmessage = (ev) => {
      const data = ev.data;
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
        return;
      }
      if (m.method === 'Network.responseReceived') {
        // 部分 Chrome 版本在该事件里不回报 resourceType，故改为：优先匹配本次导航的
        // loaderId，否则退而取首个响应的 requestId（即主文档）。
        const rid = m.params?.requestId;
        if (rid && (!state.requestId || rid === state.navLoaderId)) state.requestId = rid;
      } else if (m.method === 'Network.loadingFinished') {
        if (m.params.requestId === state.requestId && waiters.body) {
          const w = waiters.body; waiters.body = null; w.resolve(m.params.requestId);
        }
      }
    };

    timers.push(setTimeout(() => reject(new Error('CDP 会话超时')), timeoutMs));
  });
}

// 返回页面原始响应体（字符串）。失败时抛错，由调用方降级处理。
async function cdpFetchText(url, { base = DEFAULT_BASE, timeoutMs = 25000 } = {}) {
  let tab;
  try { tab = await httpJson('PUT', '/json/new', base); }
  catch (e) { throw new Error(`无法打开 CDP 标签页（${base} 不可达）：${e.message}`); }
  if (!tab || !tab.webSocketDebuggerUrl) throw new Error('CDP 未返回有效的 WebSocket 地址');

  const { ws, send, pending, state, waiters, timers } = await cdpSession(tab.webSocketDebuggerUrl, timeoutMs);

  try {
    await send('Network.enable');
    await send('Page.enable');
    const nav = await send('Page.navigate', { url });
    if (nav && nav.errorText) throw new Error(`导航失败：${nav.errorText}`);
    state.navLoaderId = nav?.loaderId || null;

    const rid = await new Promise((resolve, reject) => {
      waiters.body = { resolve, reject };
      timers.push(setTimeout(() => reject(new Error('等待页面响应超时')), timeoutMs));
    });

    const resp = await send('Network.getResponseBody', { requestId: rid });
    let text = resp?.body || '';
    if (resp?.base64Encoded) text = Buffer.from(text, 'base64').toString('utf8');
    return text;
  } finally {
    try { ws.close(); } catch { /* ignore */ }
    timers.forEach(clearTimeout);
    httpGetJson(`/json/close/${tab.id}`, base).catch(() => {});
  }
}

module.exports = { cdpFetchText, DEFAULT_BASE };
