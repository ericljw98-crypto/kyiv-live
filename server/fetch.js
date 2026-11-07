'use strict';

const UA = 'KyivLiveBoard/1.0 (personal civil-information dashboard; low-rate polling)';
const DEFAULT_TIMEOUT = Number(process.env.UPSTREAM_TIMEOUT || 8000);

async function request(url, options = {}) {
  const { timeout = DEFAULT_TIMEOUT, headers = {}, text = false, bearer = '' } = options;
  const finalHeaders = {
    'User-Agent': UA,
    Accept: text ? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' : 'application/json,text/plain;q=0.9,*/*;q=0.8',
    'Accept-Language': 'uk,en;q=0.8',
    ...headers,
  };
  if (bearer) finalHeaders.Authorization = `Bearer ${bearer}`;

  const res = await fetch(url, {
    headers: finalHeaders,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const err = new Error(`upstream ${res.status} for ${new URL(url).host}`);
    err.status = res.status;
    throw err;
  }
  // 统一返回对象：缓存层会对结果做对象展开，字符串必须包一层
  if (text) return { html: await res.text() };
  return res.json();
}

module.exports = { request };
