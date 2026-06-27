/**
 * Gemini Balance Lite - 单文件版 (Cloudflare Workers _worker.js 部署) - 升级强化版 V4 (自适应配额与个人羊毛增强版)
 *
 * 原项目: https://github.com/tech-shrimp/gemini-balance-lite
 * 维护修改: ZERO
 *
 * 集成与改进说明:
 *  1. 自适应配额管理 (针对 5xx/429 自动学习真实的 RPM/RPD 并动态调优，避免硬编码)
 *  2. 智能 Key 轮询与平滑调度 (基于评分系统，优先使用高成功率、配额充裕的 Key，具备冷却与自动恢复机制)
 *  3. 请求特征随机化与节流机制 (模拟真实客户端，减少被检测和封禁的风险)
 *  4. 增强型 /stats 统计面板 (汇总、按 Key 细化统计、实时配额与耗尽时间预测)
 *  5. 手动 /probe 探测路由 (自动测试修复处于 FAILED 状态的 Key)
 *  6. 完整保留原版 V3 的所有功能 (包含 OpenAI 兼容、SSE 转换、思维链/思考模式控制、/verify、CORS、安全访问等)
 *  7. 新增：智能 KV 缓存 (减少免费配额消耗)
 */

// ============================================================
//  思考内容显示模式配置
// ============================================================
const THINKING_MODE = {
  HIDDEN: 'hidden',       // 完全隐藏思考内容
  SEPARATE: 'separate',   // 作为独立字段 reasoning_content
  INLINE: 'inline'        // 用 XML 标签包装后合并到 content
};
// 【修复】默认使用 SEPARATE 模式，在独立字段返回思考内容
// sanitize 函数会过滤掉意外的系统标签，只保留 API 返回的思考
const DEFAULT_THINKING_MODE = THINKING_MODE.SEPARATE;

// ============================================================
//  智能缓存（极简版）
// ============================================================
const CACHE_TTL = 3600; // 缓存 1 小时

async function getCacheKey(req, model) {
  const key = JSON.stringify({ 
    model: model, 
    messages: req.messages, 
    temperature: req.temperature,
    max_tokens: req.max_tokens 
  });
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

async function getCache(cacheKey, env) {
  if (!env.GEMINI_DATA) return null;
  try {
    const data = await env.GEMINI_DATA.get(cacheKey); // default text
    if (data) console.log(`[Cache Hit] 节省配额`);
    return data;
  } catch (e) { return null; }
}

async function setCache(cacheKey, response, env, ctx) {
  if (!env.GEMINI_DATA) return;
  try {
    const promise = env.GEMINI_DATA.put(cacheKey, response, { expirationTtl: CACHE_TTL });
    if (ctx) ctx.waitUntil(promise);
    else await promise;
  } catch (e) {}
}

function shouldCache(req) {
  return !req.stream && !req.tools && (req.temperature || 0) <= 0.9;
}

// ============================================================
//  内容清洗与安全过滤
// ============================================================

/**
 * 获取并验证思考模式配置
 */
function getThinkingMode(env) {
  const mode = env?.THINKING_DISPLAY_MODE?.toLowerCase();
  if (mode && Object.values(THINKING_MODE).includes(mode)) {
    return mode;
  }
  return DEFAULT_THINKING_MODE;
}

/**
 * 清洗流式响应块，移除意外泄露的系统思考标签
 */
function sanitizeStreamChunk(chunk) {
  if (typeof chunk !== 'string') return chunk;
  return chunk.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
}

/**
 * 清洗完整响应内容
 */
function sanitizeContent(content) {
  if (typeof content !== 'string') return content;
  
  // 简单去重逻辑
  const paragraphs = content.split('\n\n');
  const seen = new Set();
  const deduplicated = [];
  
  for (const para of paragraphs) {
    const normalized = para.trim();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      deduplicated.push(para);
    }
  }
  
  return deduplicated.join('\n\n');
}

// ============================================================
//  自适应配额与状态管理配置
// ============================================================
const QUOTA_CONFIG = {
  DEFAULT_RPM: 15,
  DEFAULT_RPD: 1500,
  
  SAFE_BUFFER_RPM: 0.85,
  SAFE_BUFFER_RPD: 0.90,
  
  CONFIDENCE_THRESHOLD: 3,
  PROBE_INTERVAL: 3600000,
  
  STATUS: {
    ACTIVE: 'active',
    COOLING: 'cooling',
    EXHAUSTED: 'exhausted',
    FAILED: 'failed',
    UNKNOWN: 'unknown'
  }
};

let KEY_STATES = new Map();

// ============================================================
//  基础辅助函数
// ============================================================
const KEY_PREFIX_LEN = 8;
function keyPrefix(key) {
  return key?.slice(0, KEY_PREFIX_LEN) || "unknown";
}

function checkAuth(request, env) {
  const AUTH_TOKEN = env.AUTH_TOKEN;
  if (AUTH_TOKEN === "YOUR_SECRET_TOKEN") return true;
  const authHeader = request.headers.get("X-Auth-Token");
  if (!AUTH_TOKEN || AUTH_TOKEN === "YOUR_SECRET_TOKEN") {
    console.error("[Security] AUTH_TOKEN not configured! All requests will be rejected.");
    return false;
  }
}

function getNextMinuteReset() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 
                        now.getHours(), now.getMinutes() + 1, 0, 0);
  return next.toISOString();
}

function getNextDayReset() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 
                                  now.getUTCDate() + 1, 0, 0, 0, 0));
  return next.toISOString();
}

// ============================================================
//  Key 状态的维护与初始化
// ============================================================
function createKeyState(keyId) {
  return {
    keyId: keyPrefix(keyId),
    rpm: {
      limit: null,
      estimated: QUOTA_CONFIG.DEFAULT_RPM,
      confidence: 'low',
      used: 0,
      resetAt: getNextMinuteReset(),
      last429At: null,
      hitCount: 0
    },
    rpd: {
      limit: null,
      estimated: QUOTA_CONFIG.DEFAULT_RPD,
      confidence: 'low',
      used: 0,
      resetAt: getNextDayReset(),
      last429At: null,
      hitCount: 0
    },
    status: QUOTA_CONFIG.STATUS.UNKNOWN,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    totalRequests: 0,
    totalSuccesses: 0,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    lastSuccessAt: null,
    lastProbeAt: null,
    history: []
  };
}

async function loadKeyStateFromKV(env, key) {
  if (!env || !env.KV_STATS) return null;
  try {
    const saved = await env.KV_STATS.get(`key_state:${keyPrefix(key)}`, { type: 'json' });
    return saved;
  } catch (e) {
    console.error('[KV Load Error]', e);
    return null;
  }
}

async function saveKeyStateToKV(env, state) {
  if (!env || !env.KV_STATS) return;
  const now = Date.now();
  const lastWrite = state._lastKVWrite || 0;
  if (now - lastWrite < 2000) return;
  state._lastKVWrite = now;
  try {
    await env.KV_STATS.put(
      `key_state:${state.keyId}`,
      JSON.stringify(state),
      { expirationTtl: 86400 * 7 }
    );
  } catch (e) {
    console.error("[KV Save Error]", e);
  }
}
}

async function initializeKeyStates(apiKeys, env) {
  if (!apiKeys || apiKeys.length === 0) return;
  for (const key of apiKeys) {
    if (!KEY_STATES.has(key)) {
      const savedState = await loadKeyStateFromKV(env, key);
      if (savedState) {
        KEY_STATES.set(key, savedState);
      } else {
        KEY_STATES.set(key, createKeyState(key));
      }
    }
  }
}

async function maintainKeyStates() {
  const now = new Date();
  for (const [key, state] of KEY_STATES.entries()) {
    if (now >= new Date(state.rpm.resetAt)) {
      state.rpm.used = 0;
      state.rpm.resetAt = getNextMinuteReset();
      if (state.status === QUOTA_CONFIG.STATUS.COOLING) {
        state.status = QUOTA_CONFIG.STATUS.ACTIVE;
      }
    }
    if (now >= new Date(state.rpd.resetAt)) {
      state.rpd.used = 0;
      state.rpd.resetAt = getNextDayReset();
      if (state.status === QUOTA_CONFIG.STATUS.EXHAUSTED) {
        state.status = QUOTA_CONFIG.STATUS.ACTIVE;
      }
    }
  }
}

// ============================================================
//  智能选 Key 算法与防检测模块
// ============================================================
async function selectBestKey(apiKeys, env) {
  const now = new Date();
  const candidates = [];
  
  for (const key of apiKeys) {
    const state = KEY_STATES.get(key);
    if (!state) continue;
    
    if (state.status === QUOTA_CONFIG.STATUS.FAILED) {
      if (state.lastProbeAt && (now - new Date(state.lastProbeAt) < QUOTA_CONFIG.PROBE_INTERVAL)) {
        continue;
      }
    }
    if (state.status === QUOTA_CONFIG.STATUS.EXHAUSTED) {
      continue;
    }
    
    if (state.rpm.used / state.rpm.estimated >= QUOTA_CONFIG.SAFE_BUFFER_RPM) {
      state.status = QUOTA_CONFIG.STATUS.COOLING;
      continue;
    }
    if (state.rpd.used / state.rpd.estimated >= QUOTA_CONFIG.SAFE_BUFFER_RPD) {
      state.status = QUOTA_CONFIG.STATUS.EXHAUSTED;
      continue;
    }
    
    const rpmRemaining = state.rpm.estimated - state.rpm.used;
    const rpdRemaining = state.rpd.estimated - state.rpd.used;
    const score = calculateKeyScore(state, rpmRemaining, rpdRemaining);
    
    candidates.push({ key, state, score });
  }
  
  if (candidates.length === 0) {
    return null;
  }
  
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].key;
}

function calculateKeyScore(state, rpmRemaining, rpdRemaining) {
  let score = 100;
  score += Math.min(rpmRemaining * 2, 50);
  score += Math.min(rpdRemaining / 10, 30);
  
  if (state.rpm.confidence === 'high') score += 20;
  if (state.totalRequests > 0) {
    const rate = state.totalSuccesses / state.totalRequests;
    score += rate * 60;
  }
  
  score += state.consecutiveSuccesses * 2;
  score -= state.consecutiveFailures * 15;
  
  if (state.status === QUOTA_CONFIG.STATUS.FAILED) {
    score -= 80;
  }
  return score;
}

async function randomDelay() {
  const delay = Math.random() * 900 + 100;
  await new Promise(r => setTimeout(r, delay));
}

function getRandomUserAgent() {
  const uas = [
    'genai-js/0.21.0',
    'genai-js/0.20.1',
    'google-genai-python/1.0.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  ];
  return uas[Math.floor(Math.random() * uas.length)];
}

async function shouldThrottle(state) {
  const ratio = state.rpm.used / state.rpm.estimated;
  if (ratio >= 0.8) {
    await new Promise(r => setTimeout(r, 1200));
  } else if (ratio >= 0.6) {
    await new Promise(r => setTimeout(r, 600));
  }
}

// ============================================================
//  自适应学习与响应打点系统
// ============================================================
function addToHistory(state, event) {
  event.timestamp = new Date().toISOString();
  state.history.unshift(event);
  if (state.history.length > 10) state.history.pop();
}

async function handleResponseAndLearn(response, key, state, env, context) {
  if (!state) return;
  state.lastUsedAt = new Date().toISOString();
  
  if (response.ok) {
    state.consecutiveSuccesses++;
    state.consecutiveFailures = 0;
    state.totalSuccesses++;
    state.lastSuccessAt = new Date().toISOString();
    
    if (state.status === QUOTA_CONFIG.STATUS.FAILED || state.status === QUOTA_CONFIG.STATUS.UNKNOWN) {
      state.status = QUOTA_CONFIG.STATUS.ACTIVE;
    }
    
    if (state.rpm.used / state.rpm.estimated >= 0.95 && state.rpm.confidence !== 'high') {
      state.rpm.estimated = Math.floor(state.rpm.estimated * 1.2);
    }
    
    addToHistory(state, { type: 'success', status: response.status });
  } else {
    state.consecutiveSuccesses = 0;
    state.consecutiveFailures++;
    
    if (response.status === 429) {
      await learn429Limit(response, state);
      addToHistory(state, { type: 'rate_limit', status: 429 });
    } else if (response.status === 403 || response.status === 401) {
      if (state.consecutiveFailures >= 2) {
        state.status = QUOTA_CONFIG.STATUS.FAILED;
      }
      addToHistory(state, { type: 'auth_error', status: response.status });
    } else {
      if (state.consecutiveFailures >= 5) {
        state.status = QUOTA_CONFIG.STATUS.FAILED;
      }
      addToHistory(state, { type: 'error', status: response.status });
    }
  }
  
  if (context && env?.KV_STATS) {
    context.waitUntil(saveKeyStateToKV(env, state));
  }
}

async function learn429Limit(response, state) {
  const limitType = await detect429Type(response);
  const quota = state[limitType];
  
  quota.hitCount++;
  quota.last429At = new Date().toISOString();
  
  if (quota.limit === null || quota.used <= quota.limit) {
    quota.limit = quota.used > 0 ? quota.used : quota.estimated;
    if (quota.hitCount >= QUOTA_CONFIG.CONFIDENCE_THRESHOLD) {
      quota.confidence = 'high';
    } else {
      quota.confidence = 'medium';
    }
    
    const buffer = limitType === 'rpm' ? QUOTA_CONFIG.SAFE_BUFFER_RPM : QUOTA_CONFIG.SAFE_BUFFER_RPD;
    quota.estimated = Math.floor(quota.limit * buffer);
  }
  
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter) {
    const resetTime = new Date(Date.now() + parseInt(retryAfter) * 1000);
    quota.resetAt = resetTime.toISOString();
  }
  
  if (limitType === 'rpm') {
    state.status = QUOTA_CONFIG.STATUS.COOLING;
  } else {
    state.status = QUOTA_CONFIG.STATUS.EXHAUSTED;
  }
}

async function detect429Type(response) {
  const reason = response.headers.get('X-Goog-Reason') || '';
  if (reason.toLowerCase().includes('minute')) return 'rpm';
  if (reason.toLowerCase().includes('day') || reason.toLowerCase().includes('daily')) return 'rpd';
  
  const retryAfter = parseInt(response.headers.get('Retry-After') || '0');
  if (retryAfter > 0 && retryAfter <= 120) return 'rpm';
  if (retryAfter > 120) return 'rpd';
  
  try {
    const errorBody = await response.clone().json();
    const message = errorBody.error?.message || '';
    if (message.toLowerCase().includes('minute')) return 'rpm';
    if (message.toLowerCase().includes('day')) return 'rpd';
  } catch (e) {}
  
  return 'rpm';
}

// ============================================================
//  辅助函数：获取统计信息（增强版）
// ============================================================
async function handleStats(request, env) {
  if (!checkAuth(request, env)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { 
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "summary";
  
  if (action === "summary") {
    const summary = {
      timestamp: new Date().toISOString(),
      total_keys: KEY_STATES.size,
      keys_by_status: { active: 0, cooling: 0, exhausted: 0, failed: 0, unknown: 0 },
      capacity: { rpm_total: 0, rpm_used: 0, rpd_total: 0, rpd_used: 0 },
      performance: { total_requests: 0, total_successes: 0, success_rate: '0%' }
    };
    
    for (const [key, state] of KEY_STATES.entries()) {
      summary.keys_by_status[state.status]++;
      summary.capacity.rpm_total += state.rpm.estimated;
      summary.capacity.rpm_used += state.rpm.used;
      summary.capacity.rpd_total += state.rpd.estimated;
      summary.capacity.rpd_used += state.rpd.used;
      summary.performance.total_requests += state.totalRequests;
      summary.performance.total_successes += state.totalSuccesses;
    }
    
    if (summary.performance.total_requests > 0) {
      summary.performance.success_rate = 
        ((summary.performance.total_successes / summary.performance.total_requests) * 100).toFixed(2) + '%';
    }
    
    return new Response(JSON.stringify(summary, null, 2), {
      status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
  
  if (action === "keys") {
    const keysDetails = [];
    for (const [key, state] of KEY_STATES.entries()) {
      keysDetails.push({
        key_id: state.keyId,
        status: state.status,
        rpm: state.rpm,
        rpd: state.rpd,
        total_requests: state.totalRequests,
        success_rate: state.totalRequests > 0 ? ((state.totalSuccesses / state.totalRequests) * 100).toFixed(1) + '%' : '0%',
        consecutive_failures: state.consecutiveFailures,
        history: state.history
      });
    }
    return new Response(JSON.stringify(keysDetails, null, 2), {
      status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  if (!env.KV_STATS) {
    return new Response(JSON.stringify({ error: "KV_STATS not bound" }), { 
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
  
  try {
    const date = url.searchParams.get("date") || new Date().toISOString().split('T')[0];
    const list = await env.KV_STATS.list({ prefix: `usage:${date}:` });
    const dataPromises = list.keys.map(key => env.KV_STATS.get(key.name, { type: "json" }));
    const dataResults = await Promise.all(dataPromises);
    
    const stats = [];
    for (let i = 0; i < list.keys.length; i++) {
      const data = dataResults[i];
      if (data) {
        stats.push({
          key_prefix: list.keys[i].name.replace(`usage:${date}:`, ''),
          ...data
        });
      }
    }
    
    return new Response(JSON.stringify({
      date,
      total_keys: stats.length,
      total_requests: stats.reduce((sum, s) => sum + (s.requests || 0), 0),
      total_errors: stats.reduce((sum, s) => sum + (s.errors || 0), 0),
      keys: stats
    }, null, 2), {
      status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ============================================================
//  失败 Key 定时探测重试逻辑
// ============================================================
async function probeFailedKeys(env, context) {
  const now = new Date();
  const results = [];
  
  for (const [key, state] of KEY_STATES.entries()) {
    if (state.status !== QUOTA_CONFIG.STATUS.FAILED) continue;
    
    state.lastProbeAt = now.toISOString();
    const isAlive = await testKey(key);
    
    if (isAlive) {
      state.status = QUOTA_CONFIG.STATUS.ACTIVE;
      state.consecutiveFailures = 0;
      results.push({ key: state.keyId, status: 'recovered' });
    } else {
      results.push({ key: state.keyId, status: 'still_failed' });
    }
    
    if (context && env?.KV_STATS) {
      context.waitUntil(saveKeyStateToKV(env, state));
    }
  }
  return results;
}

async function testKey(key) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
  const body = { "contents": [{ "role": "user", "parts": [{ "text": "Hi" }] }] };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-goog-api-key': key },
      body: JSON.stringify(body)
    });
    return response.ok;
  } catch (e) {
    return false;
  }
}

// ============================================================
//  Section 1: handleRequest
// ============================================================
async function handleRequest(request, env, context) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const search = url.search;

  if (!checkAuth(request, env)) {
    return new Response('Unauthorized - Invalid X-Auth-Token Header', { status: 401 });
  }

  if (pathname === '/' || pathname === '/index.html') {
    return new Response('Proxy is Running! More Details: https://github.com/tech-shrimp/gemini-balance-lite', {
      status: 200, headers: { 'Content-Type': 'text/html' }
    });
  }

  if (pathname === '/verify' && request.method === 'POST') {
    return handleVerification(request, env);
  }

  if (pathname === '/stats' && request.method === 'GET') {
    return handleStats(request, env);
  }

  if (pathname === '/probe' && request.method === 'POST') {
    const results = await probeFailedKeys(env, context);
    return new Response(JSON.stringify({ results }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  if (pathname.endsWith("/chat/completions") || pathname.endsWith("/completions") || pathname.endsWith("/embeddings") || pathname.endsWith("/models")) {
    return handleOpenAI(request, env, context);
  }

  const targetUrl = `https://generativelanguage.googleapis.com${pathname}${search}`;

  try {
    const headers = new Headers();
    let apiKeys = [];
    
    for (const [key, value] of request.headers.entries()) {
      if (key.trim().toLowerCase() === 'x-goog-api-key') {
        apiKeys = value.split(',').map(k => k.trim()).filter(k => k);
      } else {
        if (key.trim().toLowerCase() === 'content-type') {
          headers.set(key, value);
        }
      }
    }

    if (apiKeys.length === 0) {
      return new Response('Missing x-goog-api-key in request headers.', { status: 400 });
    }

    await initializeKeyStates(apiKeys, env);
    await maintainKeyStates();

    const cachedBody = request.body ? await request.arrayBuffer() : null;
    
    let response;
    let selectedKey;
    let retries = 0;
    const MAX_RETRIES = parseInt(env.MAX_RETRIES) || 2;
    const usedKeys = new Set();

    while (retries <= MAX_RETRIES) {
      const availableKeys = apiKeys.filter(k => !usedKeys.has(k));
      const keyPool = availableKeys.length > 0 ? availableKeys : apiKeys;
      
      selectedKey = await selectBestKey(keyPool, env);
      if (!selectedKey) {
        selectedKey = keyPool[Math.floor(Math.random() * keyPool.length)];
      }

      usedKeys.add(selectedKey);
      headers.set('x-goog-api-key', selectedKey);
      
      const state = KEY_STATES.get(selectedKey);
      if (state) {
        state.rpm.used++;
        state.rpd.used++;
        await shouldThrottle(state);
      }

      headers.set('x-goog-api-client', getRandomUserAgent());
      await randomDelay();

      response = await fetch(targetUrl, {
        method: request.method,
        headers: headers,
        body: cachedBody
      });

      if (state) {
        await handleResponseAndLearn(response, selectedKey, state, env, context);
      }

      const shouldRetry = !response.ok && 
                         retries < MAX_RETRIES && 
                         (response.status >= 500 || response.status === 429);

      if (response.ok || !shouldRetry) {
        break;
      }

      retries++;
    }

    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete('transfer-encoding');
    responseHeaders.delete('connection');
    responseHeaders.delete('keep-alive');
    responseHeaders.delete('content-encoding');
    responseHeaders.set('Referrer-Policy', 'no-referrer');

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders
    });
  } catch (error) {
    console.error('Failed to fetch:', error);
    return new Response('Internal Server Error', {
      status: 500, headers: { 'Content-Type': 'text/plain' }
    });
  }
}

// ============================================================
//  Section 2: verify_keys
// ============================================================
async function verifyKey(key, controller) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
  const body = { "contents": [{ "role": "user", "parts": [{ "text": "Hello" }] }] };
  let result;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-goog-api-key': key },
      body: JSON.stringify(body)
    });
    if (response.ok) {
      await response.text();
      result = { key: keyPrefix(key), status: 'GOOD' };
    } else {
      const errorData = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
      result = { key: keyPrefix(key), status: 'BAD', error: errorData.error?.message || 'Unknown error' };
    }
  } catch (e) {
    result = { key: keyPrefix(key), status: 'ERROR', error: e.message };
  }
  controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(result) + '\n\n'));
}

async function handleVerification(request, env) {
  if (!checkAuth(request, env)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { 
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const apiKeysHeader = request.headers.get('x-goog-api-key');
    if (!apiKeysHeader) {
      return new Response(JSON.stringify({ error: 'Missing x-goog-api-key header.' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }
    const keys = apiKeysHeader.split(',').map(k => k.trim()).filter(Boolean);

    const stream = new ReadableStream({
      async start(controller) {
        const verificationPromises = keys.map(key => verifyKey(key, controller));
        await Promise.all(verificationPromises);
        controller.close();
      }
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'An unexpected error occurred: ' + e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ============================================================
//  Section 3: OpenAI 兼容端点
// ============================================================
class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
  }
}

const fixCors = ({ headers, status, statusText }) => {
  headers = new Headers(headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return { headers, status, statusText };
};

const handleOPTIONS = async () => {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Auth-Token, x-goog-api-key",
      "Access-Control-Max-Age": "86400",
    }
  });
};

const BASE_URL = "https://generativelanguage.googleapis.com";
const API_VERSION = "v1beta";
const API_CLIENT = "genai-js/0.21.0";

const makeHeaders = (apiKey, more) => ({
  "x-goog-api-client": API_CLIENT,
  ...(apiKey && { "x-goog-api-key": apiKey }),
  ...more
});

async function handleOpenAI(request, env, context) {
  if (request.method === "OPTIONS") {
    return handleOPTIONS();
  }
  const errHandler = (err) => {
    console.error(err);
    return new Response(err.message, fixCors({ status: err.status ?? 500 }));
  };
  try {
    const auth = request.headers.get("Authorization");
    let apiKey = auth?.split(" ")[1];
    let apiKeys = [];
    if (apiKey) {
      apiKeys = apiKey.split(',').map(k => k.trim()).filter(k => k);
    }
    
    if (apiKeys.length === 0) {
      throw new HttpError("Missing API Key in Authorization header", 400);
    }

    await initializeKeyStates(apiKeys, env);
    await maintainKeyStates();

    let selectedKey = await selectBestKey(apiKeys, env);
    if (!selectedKey) {
      selectedKey = apiKeys[Math.floor(Math.random() * apiKeys.length)];
    }

    const assert = (success) => {
      if (!success) {
        throw new HttpError("The specified HTTP method is not allowed for the requested resource", 400);
      }
    };
    const { pathname } = new URL(request.url);
    switch (true) {
      case pathname.endsWith("/chat/completions"):
        assert(request.method === "POST");
        return handleCompletions(await request.json(), selectedKey, env, context).catch(errHandler);
      case pathname.endsWith("/embeddings"):
        assert(request.method === "POST");
        return handleEmbeddings(await request.json(), selectedKey, env, context).catch(errHandler);
      case pathname.endsWith("/models"):
        assert(request.method === "GET");
        return handleModels(selectedKey, env, context).catch(errHandler);
      default:
        throw new HttpError("404 Not Found", 404);
    }
  } catch (err) {
    return errHandler(err);
  }
}

async function handleModels(apiKey, env, context) {
  const state = KEY_STATES.get(apiKey);
  if (state) {
    state.rpm.used++;
    state.rpd.used++;
  }

  const response = await fetch(`${BASE_URL}/${API_VERSION}/models`, {
    headers: makeHeaders(apiKey),
  });

  if (state) {
    await handleResponseAndLearn(response, apiKey, state, env, context);
  }

  let { body } = response;
  if (response.ok) {
    const { models } = JSON.parse(await response.text());
    body = JSON.stringify({
      object: "list",
      data: models.map(({ name }) => ({
        id: name.replace("models/", ""),
        object: "model",
        created: 0,
        owned_by: "",
      })),
    }, null, "  ");
  }
  return new Response(body, fixCors(response));
}

const DEFAULT_EMBEDDINGS_MODEL = "text-embedding-004";
async function handleEmbeddings(req, apiKey, env, context) {
  if (typeof req.model !== "string") {
    throw new HttpError("model is not specified", 400);
  }
  let model;
  if (req.model.startsWith("models/")) {
    model = req.model;
  } else {
    if (!req.model.startsWith("gemini-")) {
      req.model = DEFAULT_EMBEDDINGS_MODEL;
    }
    model = "models/" + req.model;
  }
  if (!Array.isArray(req.input)) {
    req.input = [req.input];
  }
  
  const MAX_RETRIES = parseInt(env.MAX_RETRIES) || 2;
  let response;
  let retries = 0;
  const state = KEY_STATES.get(apiKey);
  
  while (retries <= MAX_RETRIES) {
    if (state) {
      state.rpm.used++;
      state.rpd.used++;
      await shouldThrottle(state);
    }

    const headers = makeHeaders(apiKey, { "Content-Type": "application/json" });
    headers['x-goog-api-client'] = getRandomUserAgent();
    await randomDelay();

    response = await fetch(`${BASE_URL}/${API_VERSION}/${model}:batchEmbedContents`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        "requests": req.input.map(text => ({
          model,
          content: { parts: { text } },
          outputDimensionality: req.dimensions,
        }))
      })
    });
    
    if (state) {
      await handleResponseAndLearn(response, apiKey, state, env, context);
    }

    const shouldRetry = !response.ok && retries < MAX_RETRIES && 
                       (response.status >= 500 || response.status === 429);
    if (response.ok || !shouldRetry) break;
    retries++;
  }
  
  let { body } = response;
  if (response.ok) {
    const { embeddings } = JSON.parse(await response.text());
    body = JSON.stringify({
      object: "list",
      data: embeddings.map(({ values }, index) => ({
        object: "embedding",
        index,
        embedding: values,
      })),
      model: req.model,
    }, null, "  ");
  }
  return new Response(body, fixCors(response));
}

const DEFAULT_MODEL = "gemini-2.5-flash";
async function handleCompletions(req, apiKey, env, context) {
  let model = DEFAULT_MODEL;
  switch (true) {
    case typeof req.model !== "string":
      break;
    case req.model.startsWith("models/"):
      model = req.model.substring(7);
      break;
    case req.model.startsWith("gemini-"):
    case req.model.startsWith("gemma-"):
    case req.model.startsWith("learnlm-"):
      model = req.model;
  }

  // 检查缓存
  let cacheKey = null;
  if (shouldCache(req)) {
    cacheKey = await getCacheKey(req, model);
    const cached = await getCache(cacheKey, env);
    if (cached) {
      return new Response(cached, {
        status: 200,
        headers: { 
          'Content-Type': 'application/json',
          'X-Cache': 'HIT',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  }

  let body = await transformRequest(req);
  const extra = req.extra_body?.google;
  if (extra) {
    if (extra.safety_settings) {
      body.safetySettings = extra.safety_settings;
    }
    if (extra.cached_content) {
      body.cachedContent = extra.cached_content;
    }
    if (extra.thinking_config) {
      body.generationConfig.thinkingConfig = extra.thinking_config;
    }
  }
  switch (true) {
    case model.endsWith(":search"):
      model = model.substring(0, model.length - 7);
    case req.model.endsWith("-search-preview"):
    case req.tools?.some(tool => tool.function?.name === 'googleSearch'):
      body.tools = body.tools || [];
      body.tools.push({ googleSearch: {} });
  }
  const TASK = req.stream ? "streamGenerateContent" : "generateContent";
  let url = `${BASE_URL}/${API_VERSION}/models/${model}:${TASK}`;
  if (req.stream) { url += "?alt=sse"; }
  
  const MAX_RETRIES = parseInt(env.MAX_RETRIES) || 2;
  let response;
  let retries = 0;
  const state = KEY_STATES.get(apiKey);
  
  while (retries <= MAX_RETRIES) {
    if (state) {
      state.rpm.used++;
      state.rpd.used++;
      await shouldThrottle(state);
    }

    const headers = makeHeaders(apiKey, { "Content-Type": "application/json" });
    headers['x-goog-api-client'] = getRandomUserAgent();
    await randomDelay();

    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    
    if (state) {
      await handleResponseAndLearn(response, apiKey, state, env, context);
    }

    const shouldRetry = !response.ok && retries < MAX_RETRIES && 
                       (response.status >= 500 || response.status === 429);
    if (response.ok || !shouldRetry) break;
    retries++;
  }

  body = response.body;
  if (response.ok) {
    let id = "chatcmpl-" + generateId();
    const shared = {};
    if (req.stream) {
      body = response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TransformStream({
          transform: parseStream,
          flush: parseStreamFlush,
          buffer: "",
          shared,
        }))
        .pipeThrough(new TransformStream({
          transform: toOpenAiStream,
          flush: toOpenAiStreamFlush,
          streamIncludeUsage: req.stream_options?.include_usage,
          model, id, last: [],
          shared,
          env,
        }))
        .pipeThrough(new TextEncoderStream());
    } else {
      body = await response.text();
      try {
        body = JSON.parse(body);
        if (!body.candidates) {
          throw new Error("Invalid completion object");
        }
      } catch (err) {
        return new Response(body, fixCors(response));
      }
      body = processCompletionsResponse(body, model, id, env);
      
      // 存入缓存
      if (cacheKey) await setCache(cacheKey, body, env, context);

      try {
        const parsed = JSON.parse(body);
        if (parsed.choices) {
          parsed.choices.forEach((choice, idx) => {
            if (choice.message?.content) {
              const original = choice.message.content;
              const cleaned = sanitizeContent(original);
              if (original !== cleaned) {
                console.warn(`[Sanitize] Cleaned content for choice ${idx}`);
                choice.message.content = cleaned;
              }
            }
          });
        }
        body = JSON.stringify(parsed);
      } catch (e) {
        console.error('[Sanitize] Failed to parse response for cleaning:', e);
      }
    }
  }
  
  return new Response(body, fixCors(response));
}

const adjustProps = (schemaPart) => {
  if (typeof schemaPart !== "object" || schemaPart === null) return;
  if (Array.isArray(schemaPart)) {
    schemaPart.forEach(adjustProps);
  } else {
    if (schemaPart.type === "object" && schemaPart.properties && schemaPart.additionalProperties === false) {
      delete schemaPart.additionalProperties;
    }
    Object.values(schemaPart).forEach(adjustProps);
  }
};
const adjustSchema = (schema) => {
  const obj = schema[schema.type];
  delete obj.strict;
  return adjustProps(schema);
};

const harmCategory = [
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_CIVIC_INTEGRITY",
];
const safetySettings = harmCategory.map(category => ({
  category,
  threshold: "BLOCK_NONE",
}));
const fieldsMap = {
  frequency_penalty: "frequencyPenalty",
  max_completion_tokens: "maxOutputTokens",
  max_tokens: "maxOutputTokens",
  n: "candidateCount",
  presence_penalty: "presencePenalty",
  seed: "seed",
  stop: "stopSequences",
  temperature: "temperature",
  top_k: "topK",
  top_p: "topP",
};
const thinkingBudgetMap = {
  low: 1024,
  medium: 8192,
  high: 24576,
};
const transformConfig = (req) => {
  let cfg = {};
  for (let key in req) {
    const matchedKey = fieldsMap[key];
    if (matchedKey) {
      cfg[matchedKey] = req[key];
    }
  }
  if (req.response_format) {
    switch (req.response_format.type) {
      case "json_schema":
        adjustSchema(req.response_format);
        cfg.responseSchema = req.response_format.json_schema?.schema;
        if (cfg.responseSchema && "enum" in cfg.responseSchema) {
          cfg.responseMimeType = "text/x.enum";
          break;
        }
      case "json_object":
        cfg.responseMimeType = "application/json";
        break;
      case "text":
        cfg.responseMimeType = "text/plain";
        break;
      default:
        throw new HttpError("Unsupported response_format.type", 400);
    }
  }
  if (req.reasoning_effort) {
    cfg.thinkingConfig = { 
      thinkingBudget: thinkingBudgetMap[req.reasoning_effort],
      includeThoughts: true
    };
  }
  return cfg;
};

const ab2b64 = (ab) => {
  const bytes = new Uint8Array(ab);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
};

const parseImg = async (url) => {
  let mimeType, data;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText} (${url})`);
      }
      mimeType = response.headers.get("content-type");
      data = ab2b64(await response.arrayBuffer());
    } catch (err) {
      throw new Error("Error fetching image: " + err.toString());
    }
  } else {
    const match = url.match(/^data:(?<mimeType>.*?)(;base64)?,(?<data>.*)$/);
    if (!match) {
      throw new HttpError("Invalid image data: " + url, 400);
    }
    ({ mimeType, data } = match.groups);
  }
  return {
    inlineData: {
      mimeType,
      data,
    },
  };
};

const transformFnResponse = ({ content, tool_call_id }, parts) => {
  if (!parts.calls) {
    throw new HttpError("No function calls found in the previous message", 400);
  }
  
  let response;
  if (typeof content === "string") {
    try {
      response = JSON.parse(content);
    } catch (err) {
      response = content;
    }
  } else {
    response = content;
  }
  
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    response = { result: response };
  }
  
  if (!tool_call_id) {
    throw new HttpError("tool_call_id not specified", 400);
  }
  const { i, name } = parts.calls[tool_call_id] ?? {};
  if (!name) {
    throw new HttpError("Unknown tool_call_id: " + tool_call_id, 400);
  }
  if (parts[i]) {
    throw new HttpError("Duplicated tool_call_id: " + tool_call_id, 400);
  }
  parts[i] = {
    functionResponse: {
      id: tool_call_id.startsWith("call_") ? null : tool_call_id,
      name,
      response,
    }
  };
};

const transformFnCalls = ({ tool_calls }) => {
  const calls = {};
  const parts = tool_calls.map(({ function: { arguments: argstr, name }, id, type, thought_signature }, i) => {
    if (type !== "function") {
      throw new HttpError(`Unsupported tool_call type: "${type}"`, 400);
    }
    let args;
    // 类型安全的参数解析
    if (argstr === null || argstr === undefined) {
      args = {};
    } else if (typeof argstr === 'object') {
      args = argstr;
    } else if (typeof argstr === 'string') {
      if (argstr.trim() === "") {
        args = {};
      } else {
        try {
          args = JSON.parse(argstr);
        } catch (err) {
          throw new HttpError(`Invalid function arguments: unable to parse JSON. Original value: "${argstr.substring(0, 100)}...", Error: ${err.message}`, 400);
        }
      }
    } else {
      throw new HttpError(`Invalid function arguments: expected string or object, got ${typeof argstr}`, 400);
    }
    calls[id] = { i, name };
    const part = {
      functionCall: {
        id: id.startsWith("call_") ? null : id,
        name,
        args,
      }
    };
    part.thought_signature = thought_signature || "skip_thought_signature_validator";
    return part;
  });
  parts.calls = calls;
  return parts;
};

const transformMsg = async ({ content }) => {
  const parts = [];
  if (!Array.isArray(content)) {
    parts.push({ text: content });
    return parts;
  }
  for (const item of content) {
    switch (item.type) {
      case "text":
        parts.push({ text: item.text });
        break;
      case "image_url":
        parts.push(await parseImg(item.image_url.url));
        break;
      case "input_audio":
        parts.push({
          inlineData: {
            mimeType: "audio/" + item.input_audio.format,
            data: item.input_audio.data,
          }
        });
        break;
      default:
        throw new HttpError(`Unknown "content" item type: "${item.type}"`, 400);
    }
  }
  if (content.every(item => item.type === "image_url")) {
    parts.push({ text: "" });
  }
  return parts;
};

const transformMessages = async (messages) => {
  if (!messages) return;
  const contents = [];
  let system_instruction;
  for (let item of messages) {
    if (item.role === 'assistant' && item.reasoning_content) {
      const cleanedItem = { ...item };
      delete cleanedItem.reasoning_content;
      item = cleanedItem;
    }
    
    switch (item.role) {
      case "system":
        system_instruction = { parts: await transformMsg(item) };
        continue;
      case "tool":
        {
          let { role, parts } = contents[contents.length - 1] ?? {};
          if (role !== "function") {
            const calls = parts?.calls;
            parts = []; parts.calls = calls;
            contents.push({ role: "function", parts });
          }
          transformFnResponse(item, parts);
          continue;
        }
      case "assistant":
        item.role = "model";
        break;
      case "user":
        break;
      default:
        throw new HttpError(`Unknown message role: "${item.role}"`, 400);
    }
    contents.push({
      role: item.role,
      parts: item.tool_calls ? transformFnCalls(item) : await transformMsg(item)
    });
  }
  if (system_instruction) {
    if (!contents[0]?.parts.some(part => part.text)) {
      contents.unshift({ role: "user", parts: { text: " " } });
    }
  }
  return { system_instruction, contents };
};

const transformTools = (req) => {
  let tools, tool_config;
  if (req.tools) {
    const funcs = req.tools.filter(tool => tool.type === "function" && tool.function?.name !== 'googleSearch');
    if (funcs.length > 0) {
      try {
        funcs.forEach(adjustSchema);
        tools = [{ function_declarations: funcs.map(schema => schema.function) }];
      } catch (err) {
        throw new HttpError("Invalid tool schema: " + err.message, 400);
      }
    }
  }
  if (req.tool_choice) {
    const allowed_function_names = req.tool_choice?.type === "function" ? [req.tool_choice?.function?.name] : undefined;
    if (allowed_function_names || typeof req.tool_choice === "string") {
      tool_config = {
        function_calling_config: {
          mode: allowed_function_names ? "ANY" : req.tool_choice.toUpperCase(),
          allowed_function_names
        }
      };
    }
  }
  return { tools, tool_config };
};

const transformRequest = async (req) => ({
  ...await transformMessages(req.messages),
  safetySettings,
  generationConfig: transformConfig(req),
  ...transformTools(req),
});

const generateId = () => {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const randomChar = () => characters[Math.floor(Math.random() * characters.length)];
  return Array.from({ length: 29 }, randomChar).join("");
};

const reasonsMap = {
  "STOP": "stop",
  "MAX_TOKENS": "length",
  "SAFETY": "content_filter",
  "RECITATION": "content_filter",
};
// 清洗 Gemini 返回的可能包含 Markdown 代码块的 JSON
const cleanMarkdownJSON = (value) => {
  if (typeof value === "string") {
    // 移除 ```json ... ``` 或 ``` ... ``` 包裹
    return value.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
  }
  return value;
};

const SEP = "\n\n|>";
const transformCandidates = (key, cand, env) => {
  const message = { role: "assistant", content: [], reasoning_content: [] };
  const processedTexts = new Set();
  
  for (const part of cand.content?.parts ?? []) {
    if (part.functionCall) {
      const fc = part.functionCall;
      message.tool_calls = message.tool_calls ?? [];
      const toolCall = {
        id: fc.id ?? "call_" + generateId(),
        type: "function",
        function: { name: fc.name, arguments: typeof fc.args === "string" ? cleanMarkdownJSON(fc.args) : JSON.stringify(fc.args) },
      };
      if (part.thought_signature) {
        toolCall.thought_signature = part.thought_signature;
      }
      message.tool_calls.push(toolCall);
    } else if (part.text) {
      const textHash = part.text.substring(0, 100);
      if (processedTexts.has(textHash)) {
        console.warn('[Deduplication] Skipped duplicate part.text');
        continue;
      }
      processedTexts.add(textHash);
      
      if (part.thought === true) {
        message.reasoning_content.push(part.text);
      } else if (!part.thought) {
        message.content.push(part.text);
      }
      if (part.thought_signature) {
        message.thought_signature = part.thought_signature;
      }
    }
  }
  
  const thinkingMode = getThinkingMode(env);
  
  if (message.reasoning_content.length > 0) {
    const thinkingText = message.reasoning_content.join(SEP);
    switch (thinkingMode) {
      case THINKING_MODE.HIDDEN:
        delete message.reasoning_content;
        break;
      case THINKING_MODE.SEPARATE:
        message.reasoning_content = thinkingText;
        break;
      case THINKING_MODE.INLINE:
      default:
        message.content.push(`<thinking>\n${thinkingText}\n</thinking>`);
        delete message.reasoning_content;
        break;
    }
  } else {
    delete message.reasoning_content;
  }
  
  const uniqueContent = [...new Set(message.content)];
  message.content = uniqueContent.join(SEP) || null;
  
  return {
    index: cand.index || 0,
    [key]: message,
    logprobs: null,
    finish_reason: message.tool_calls ? "tool_calls" : reasonsMap[cand.finishReason] || cand.finishReason,
  };
};

const transformCandidatesMessage = (cand, env) => transformCandidates("message", cand, env);
const transformCandidatesDelta = (cand, env) => transformCandidates("delta", cand, env);

const transformUsage = (data) => ({
  completion_tokens: data.candidatesTokenCount,
  prompt_tokens: data.promptTokenCount,
  total_tokens: data.totalTokenCount
});

const checkPromptBlock = (choices, promptFeedback, key) => {
  if (choices.length) return;
  if (promptFeedback?.blockReason) {
    choices.push({
      index: 0,
      [key]: null,
      finish_reason: "content_filter",
    });
  }
  return true;
};

const processCompletionsResponse = (data, model, id, env) => {
  const obj = {
    id,
    choices: data.candidates.map(c => transformCandidatesMessage(c, env)),
    created: Math.floor(Date.now() / 1000),
    model: data.modelVersion ?? model,
    object: "chat.completion",
    usage: data.usageMetadata && transformUsage(data.usageMetadata),
  };
  if (obj.choices.length === 0) {
    checkPromptBlock(obj.choices, data.promptFeedback, "message");
  }
  
  obj.choices = obj.choices.map(choice => {
    if (choice.message?.content) {
      choice.message.content = sanitizeContent(choice.message.content);
    }
    return choice;
  });
  
  return JSON.stringify(obj);
};

const responseLineRE = /^data: (.*)(?:\n\n|\r\r|\r\n\r\n)/;
const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB 限制
function parseStream(chunk, controller) {
  this.buffer += chunk;
  if (this.buffer.length > MAX_BUFFER_SIZE) {
    controller.error(new Error(`Stream buffer overflow: exceeded ${MAX_BUFFER_SIZE} bytes.`));
    return;
  }
  do {
    const match = this.buffer.match(responseLineRE);
    if (!match) break;
    controller.enqueue(match[1]);
    this.buffer = this.buffer.substring(match[0].length);
  } while (true);
}
function parseStreamFlush(controller) {
  if (this.buffer) {
    controller.enqueue(this.buffer);
    this.shared.is_buffers_rest = true;
  }
}

const delimiter = "\n\n";
const sseline = (obj) => {
  obj.created = Math.floor(Date.now() / 1000);
  return "data: " + JSON.stringify(obj) + delimiter;
};
function toOpenAiStream(line, controller) {
  let data;
  try {
    data = JSON.parse(line);
    if (!data.candidates) {
      throw new Error("Invalid completion chunk object");
    }
  } catch (err) {
    if (!this.shared.is_buffers_rest) { line += delimiter; }
    line = sanitizeStreamChunk(line);
    controller.enqueue(line);
    return;
  }
  const obj = {
    id: this.id,
    choices: data.candidates.map(c => transformCandidatesDelta(c, this.env)),
    model: data.modelVersion ?? this.model,
    object: "chat.completion.chunk",
    usage: data.usageMetadata && this.streamIncludeUsage ? null : undefined,
  };
  if (checkPromptBlock(obj.choices, data.promptFeedback, "delta")) {
    controller.enqueue(sseline(obj));
    return;
  }
  const cand = obj.choices[0];
  cand.index = cand.index || 0;
  
  if (cand.delta && data.candidates[0]?.content?.parts) {
      const thinkingMode = getThinkingMode(this.env);
      let chunkReasoningContent = '';
      let chunkRegularContent = '';
      
      for (const part of data.candidates[0].content.parts) {
          if (part?.thought === true && part?.text) {
              chunkReasoningContent += part.text;
          } else if (part?.text && !part?.thought) {
              chunkRegularContent += part.text;
          }
      }
      
      if (thinkingMode === THINKING_MODE.HIDDEN) {
          if (chunkRegularContent) {
              cand.delta.content = chunkRegularContent;
          }
      } else if (thinkingMode === THINKING_MODE.SEPARATE) {
          if (chunkReasoningContent) {
              cand.delta.reasoning_content = chunkReasoningContent;
          }
          if (chunkRegularContent) {
              cand.delta.content = chunkRegularContent;
          }
      } else {
          if (chunkReasoningContent) {
              cand.delta.content = `<thinking>${chunkReasoningContent}</thinking>\n`;
          }
          if (chunkRegularContent) {
              cand.delta.content = (cand.delta.content || '') + chunkRegularContent;
          }
      }
  }
  
  const finish_reason = cand.finish_reason;
  cand.finish_reason = null;
  if (!this.last[cand.index]) {
    controller.enqueue(sseline({
      ...obj,
      choices: [{ ...cand, tool_calls: undefined, delta: { role: "assistant", content: "" } }],
    }));
  }
  delete cand.delta.role;
  if ("content" in cand.delta || "reasoning_content" in cand.delta) {
    controller.enqueue(sseline(obj));
  }
  cand.finish_reason = finish_reason;
  if (data.usageMetadata && this.streamIncludeUsage) {
    obj.usage = transformUsage(data.usageMetadata);
  }
  cand.delta = {};
  this.last[cand.index] = obj;
}
function toOpenAiStreamFlush(controller) {
  if (this.last.length > 0) {
    for (const obj of this.last) {
      controller.enqueue(sseline(obj));
    }
    controller.enqueue("data: [DONE]" + delimiter);
  }
}

export default {
  async fetch(req, env, context) {
    return handleRequest(req, env, context);
  }
};
