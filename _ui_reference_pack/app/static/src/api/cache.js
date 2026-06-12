// 简单内存缓存层
// 依赖：api() (api/client.js)

const _cache = {};
const _cacheTs = {};
const _CACHE_TTL = 60_000;

function invalidate(...keys) {
  keys.forEach(k => { delete _cache[k]; delete _cacheTs[k]; });
}

async function fetchCached(key, url) {
  const now = Date.now();
  if (_cache[key] !== undefined && now - (_cacheTs[key] || 0) < _CACHE_TTL) return _cache[key];
  _cache[key] = await api(url);
  _cacheTs[key] = now;
  return _cache[key];
}
