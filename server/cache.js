'use strict';

// TTL 缓存：命中直接返回；上游失败时返回上次成功值并标记 stale=true，
// 让前端明确显示「数据延迟」，绝不把陈旧数据伪装成实时数据。
const store = new Map();
const FAILURE_COOLDOWN = 15000;

async function cached(key, ttlMs, loader) {
  const now = Date.now();
  const entry = store.get(key);

  if (entry && entry.pending) return entry.pending;
  if (entry && entry.value && now - entry.at < ttlMs) {
    return { ...entry.value, stale: false };
  }

  const task = (async () => {
    try {
      const value = await loader();
      store.set(key, { at: Date.now(), value });
      return { ...value, stale: false };
    } catch (err) {
      const previous = store.get(key);
      if (previous && previous.value) {
        // 故障冷却，避免每个前端请求都去打上游
        previous.at = Date.now() - ttlMs + FAILURE_COOLDOWN;
        delete previous.pending;
        return { ...previous.value, stale: true, warning: err.message };
      }
      store.delete(key);
      throw err;
    }
  })();

  store.set(key, { ...(entry || {}), pending: task });
  return task;
}

function cacheStats() {
  return [...store.entries()].map(([key, e]) => ({
    key,
    ageSeconds: e.value ? Math.round((Date.now() - e.at) / 1000) : null,
    hasData: Boolean(e.value),
  }));
}

module.exports = { cached, cacheStats };
