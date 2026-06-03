import { createHash } from 'crypto';
import { readTokens, saveTokens, readConfig } from './db.js';
import { requestHeaders } from './headers.js';
import { logInfo, logWarn, logError } from './logger.js';

const BASE_URL = 'https://chat.qwen.ai';

function sha256(text) {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

function decodeJWT(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64').toString());
  } catch { return null; }
}

function isTokenExpired(token) {
  const decoded = decodeJWT(token);
  if (!decoded?.exp) return false; // Default to not expired if exp is missing to avoid error-locking manual keys
  return decoded.exp * 1000 < Date.now() + 5 * 60 * 1000; // 5 min buffer
}

// Account entry: { email, password, token, expiresAt, errorCount, activeRequests }
const accountPool = [];

// Validate token directly with Qwen official models endpoint
export async function validateTokenWithQwen(token) {
  try {
    const res = await fetch(`${BASE_URL}/api/models`, {
      headers: {
        'authorization': `Bearer ${token}`,
        'source': 'web',
        'version': '0.2.57',
        'accept': 'application/json',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
      }
    });
    if (!res.ok) return false;
    const json = await res.json();
    return Array.isArray(json.data);
  } catch {
    return false;
  }
}

export function loadAccounts() {
  accountPool.length = 0; // Clear pool

  // 1. First, load from the JSON database
  const dbTokens = readTokens();
  if (dbTokens && dbTokens.length > 0) {
    for (const entry of dbTokens) {
      accountPool.push({
        email: entry.email,
        password: entry.password || null,
        token: entry.token || null,
        expiresAt: entry.expiresAt || 0,
        errorCount: entry.errorCount || 0,
        activeRequests: 0,
      });
    }
    return accountPool;
  }

  // 2. Fallback: Load from environment variables and import to DB
  const accountsStr = process.env.QWEN_ACCOUNTS?.trim();
  const tokensStr = process.env.QWEN_TOKENS?.trim();
  const tempPool = [];

  if (accountsStr) {
    for (const entry of accountsStr.split(',')) {
      const [email, ...passParts] = entry.trim().split(':');
      const password = passParts.join(':');
      if (email && password) {
        tempPool.push({ email, password, token: null, expiresAt: 0, errorCount: 0, activeRequests: 0 });
      }
    }
  }

  if (tokensStr) {
    for (const token of tokensStr.split(',').map(t => t.trim()).filter(Boolean)) {
      const decoded = decodeJWT(token);
      tempPool.push({
        email: decoded?.id || 'token-user',
        password: null,
        token,
        expiresAt: (decoded?.exp || 0) * 1000,
        errorCount: 0,
        activeRequests: 0,
      });
    }
  }

  if (tempPool.length > 0) {
    for (const entry of tempPool) {
      accountPool.push(entry);
    }
    // Sync back to database
    saveTokens(accountPool);
  }

  return accountPool;
}

async function login(email, password) {
  const res = await fetch(`${BASE_URL}/api/v1/auths/signin`, {
    method: 'POST',
    headers: requestHeaders(),
    body: JSON.stringify({ email, password: sha256(password) }),
  });
  const json = await res.json();
  if (!json.token) throw new Error(`Login failed for ${email}: ${JSON.stringify(json)}`);
  return json.token;
}

async function ensureToken(entry) {
  if (entry.token && !isTokenExpired(entry.token)) return entry.token;

  if (!entry.password) {
    entry.errorCount++;
    throw new Error(`Token expired for ${entry.email}, no password to refresh`);
  }

  try {
    entry.token = await login(entry.email, entry.password);
    const decoded = decodeJWT(entry.token);
    entry.expiresAt = (decoded?.exp || 0) * 1000;
    entry.errorCount = 0;
    logInfo(`  Logged in: ${entry.email}, token expires ${new Date(entry.expiresAt).toISOString()}`);
    // Sync to database
    saveTokens(accountPool);
    return entry.token;
  } catch (err) {
    entry.errorCount++;
    throw err;
  }
}

export async function initAccountPool() {
  const config = readConfig();
  const maxConcurrent = config.maxConcurrentPerToken || 10;
  logInfo(`Account pool: ${accountPool.length} account(s), max ${maxConcurrent} concurrent each`);

  for (const entry of accountPool) {
    try {
      await ensureToken(entry);
    } catch (err) {
      logWarn(`  Failed to init ${entry.email}: ${err.message}`);
    }
  }

  // Start periodic self-healing health check worker (runs every 5 minutes)
  setInterval(async () => {
    logInfo('[HEALTH] Starting self-healing account recovery worker...');
    for (const entry of accountPool) {
      if (entry.errorCount >= 3 || !entry.token || isTokenExpired(entry.token)) {
        if (!entry.password) {
          if (isTokenExpired(entry.token)) {
            logWarn(`[HEALTH] Token expired for manual account ${entry.email}, but cannot self-heal without password.`);
          } else if (entry.errorCount >= 3) {
            logInfo(`[HEALTH] Manual account ${entry.email} reached error limit under unexpired token. Running dynamic validation check...`);
            const isValid = await validateTokenWithQwen(entry.token);
            if (isValid) {
              entry.errorCount = 0;
              logInfo(`[HEALTH] Successfully restored manual account: ${entry.email}!`);
              saveTokens(accountPool);
            } else {
              logWarn(`[HEALTH] Dynamic validation failed for manual account: ${entry.email}. Token is invalid.`);
            }
          }
          continue;
        }
        logInfo(`[HEALTH] Attempting self-healing recovery for account: ${entry.email}...`);
        try {
          await ensureToken(entry);
          logInfo(`[HEALTH] Successfully recovered account: ${entry.email}!`);
        } catch (err) {
          logWarn(`[HEALTH] Failed to recover account ${entry.email}: ${err.message}`);
        }
      }
    }
  }, 5 * 60 * 1000);
}

export function acquireToken(excludeEmails = []) {
  const config = readConfig();
  const maxConcurrent = config.maxConcurrentPerToken || 10;
  let candidates = accountPool.filter(t => t.errorCount < 3 && t.activeRequests < maxConcurrent && t.token && !excludeEmails.includes(t.email));

  if (candidates.length === 0) {
    candidates = accountPool.filter(t => t.activeRequests < maxConcurrent && t.token && !excludeEmails.includes(t.email));
  }
  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => a.activeRequests - b.activeRequests);
  const chosen = candidates[0];
  chosen.activeRequests++;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    chosen.activeRequests = Math.max(0, chosen.activeRequests - 1);
  };

  return { token: chosen.token, account: chosen, release };
}

export function reportTokenError(token) {
  const entry = accountPool.find(t => t.token === token);
  if (entry) {
    entry.errorCount++;
    saveTokens(accountPool);
  }
}

export function reportTokenSuccess(token) {
  const entry = accountPool.find(t => t.token === token);
  if (entry && entry.errorCount > 0) {
    entry.errorCount = 0;
    saveTokens(accountPool);
  }
}

export async function refreshToken(entry) {
  return ensureToken(entry);
}

// Add token to pool with Qwen official verification before adding
export async function addTokenToPool(tokenStr) {
  const token = tokenStr.trim();
  const decoded = decodeJWT(token);
  const email = decoded?.id || 'token-user';

  // 1. Perform Qwen official API verification
  const isValid = await validateTokenWithQwen(token);
  if (!isValid) {
    throw new Error('令牌失效或格式错误，无法通过官方接口校验！');
  }

  const existing = accountPool.find(t => t.token === token || t.email === email);
  if (existing) {
    existing.token = token;
    existing.expiresAt = (decoded?.exp || 0) * 1000;
    existing.errorCount = 0;
    saveTokens(accountPool);
    return existing;
  }

  const entry = {
    email,
    password: null,
    token,
    expiresAt: (decoded?.exp || 0) * 1000,
    errorCount: 0,
    activeRequests: 0,
  };
  accountPool.push(entry);
  saveTokens(accountPool);
  return entry;
}

export async function loginAndAddToken(email, password) {
  const token = await login(email, password);
  const decoded = decodeJWT(token);
  const existing = accountPool.find(t => t.email === email);
  if (existing) {
    existing.token = token;
    existing.password = password;
    existing.expiresAt = (decoded?.exp || 0) * 1000;
    existing.errorCount = 0;
    saveTokens(accountPool);
    return existing;
  }
  const entry = {
    email,
    password,
    token,
    expiresAt: (decoded?.exp || 0) * 1000,
    errorCount: 0,
    activeRequests: 0,
  };
  accountPool.push(entry);
  saveTokens(accountPool);
  return entry;
}

// Physical token deletion from memory and JSON database
export function deleteTokenFromPool(email) {
  const idx = accountPool.findIndex(t => t.email === email);
  if (idx !== -1) {
    accountPool.splice(idx, 1);
    saveTokens(accountPool);
    return true;
  }
  return false;
}

export async function refreshSingleToken(email, manualTokenStr = null) {
  const entry = accountPool.find(t => t.email === email);
  if (!entry) {
    throw new Error(`未找到账户为 ${email} 的记录`);
  }

  if (!entry.password) {
    // Manual token account
    if (!manualTokenStr) {
      throw new Error('手动录入账户刷新需要提供新的 token');
    }
    const token = manualTokenStr.trim();
    const isValid = await validateTokenWithQwen(token);
    if (!isValid) {
      throw new Error('新令牌失效或格式错误，无法通过官方接口校验！');
    }
    const decoded = decodeJWT(token);
    entry.token = token;
    entry.expiresAt = (decoded?.exp || 0) * 1000;
    entry.errorCount = 0;
    saveTokens(accountPool);
    return { success: true, message: `手动账户 ${email} 的令牌已成功更新并校验通过！` };
  } else {
    // Password login account
    const token = await login(entry.email, entry.password);
    const decoded = decodeJWT(token);
    entry.token = token;
    entry.expiresAt = (decoded?.exp || 0) * 1000;
    entry.errorCount = 0;
    saveTokens(accountPool);
    return { success: true, message: `账户 ${email} 已通过官方密码重新登录，令牌已刷新！` };
  }
}

export function getPoolInfo() {
  const config = readConfig();
  const maxConcurrent = config.maxConcurrentPerToken || 10;
  return accountPool.map(t => ({
    email: t.email,
    hasToken: !!t.token,
    expiresAt: t.expiresAt ? new Date(t.expiresAt).toISOString() : null,
    errorCount: t.errorCount,
    activeRequests: t.activeRequests,
    maxConcurrent: maxConcurrent,
    isManual: !t.password,
  }));
}

export function getTotalCapacity() {
  const config = readConfig();
  const maxConcurrent = config.maxConcurrentPerToken || 10;
  return accountPool.filter(t => t.errorCount < 3 && t.token).length * maxConcurrent;
}