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
  if (!decoded?.exp) return false;
  return decoded.exp * 1000 < Date.now() + 5 * 60 * 1000;
}

const accountPool = [];

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
  accountPool.length = 0;

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
  if (!json.token) throw new Error(`Autentificare eșuată pentru ${email}: ${JSON.stringify(json)}`);
  return json.token;
}

async function ensureToken(entry) {
  if (entry.token && !isTokenExpired(entry.token)) return entry.token;

  if (!entry.password) {
    entry.errorCount++;
    throw new Error(`Token expirat pentru ${entry.email}, lipsește parola pentru reîmprospătare`);
  }

  try {
    entry.token = await login(entry.email, entry.password);
    const decoded = decodeJWT(entry.token);
    entry.expiresAt = (decoded?.exp || 0) * 1000;
    entry.errorCount = 0;
    logInfo(`  Autentificat: ${entry.email}, token expiră la ${new Date(entry.expiresAt).toISOString()}`);
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
  logInfo(`Pool conturi: ${accountPool.length} cont(uri), max ${maxConcurrent} concurente pe cont`);

  for (const entry of accountPool) {
    try {
      await ensureToken(entry);
    } catch (err) {
      logWarn(`  Eșec inițializare ${entry.email}: ${err.message}`);
    }
  }

  setInterval(async () => {
    logInfo('[SĂNĂTATE] Pornire worker auto-vindecare conturi...');
    for (const entry of accountPool) {
      if (entry.errorCount >= 3 || !entry.token || isTokenExpired(entry.token)) {
        if (!entry.password) {
          if (isTokenExpired(entry.token)) {
            logWarn(`[SĂNĂTATE] Token expirat pentru cont manual ${entry.email}, nu se poate auto-vindeca fără parolă.`);
          } else if (entry.errorCount >= 3) {
            logInfo(`[SĂNĂTATE] Cont manual ${entry.email} a atins limita de erori sub token neexpirat. Verificare dinamică...`);
            const isValid = await validateTokenWithQwen(entry.token);
            if (isValid) {
              entry.errorCount = 0;
              logInfo(`[SĂNĂTATE] Cont manual ${entry.email} restaurat cu succes!`);
              saveTokens(accountPool);
            } else {
              logWarn(`[SĂNĂTATE] Validare dinamică eșuată pentru cont manual: ${entry.email}. Token invalid.`);
            }
          }
          continue;
        }
        logInfo(`[SĂNĂTATE] Încercare auto-vindecare pentru cont: ${entry.email}...`);
        try {
          await ensureToken(entry);
          logInfo(`[SĂNĂTATE] Cont ${entry.email} recuperat cu succes!`);
        } catch (err) {
          logWarn(`[SĂNĂTATE] Eșec recuperare cont ${entry.email}: ${err.message}`);
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

export async function addTokenToPool(tokenStr) {
  const token = tokenStr.trim();
  const decoded = decodeJWT(token);
  const email = decoded?.id || 'token-user';

  const isValid = await validateTokenWithQwen(token);
  if (!isValid) {
    throw new Error('Token invalid sau format greșit, nu a trecut validarea prin API oficial!');
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
    throw new Error(`Nu s-a găsit cont pentru ${email}`);
  }

  if (!entry.password) {
    if (!manualTokenStr) {
      throw new Error('Reîmprospătarea contului manual necesită un token nou');
    }
    const token = manualTokenStr.trim();
    const isValid = await validateTokenWithQwen(token);
    if (!isValid) {
      throw new Error('Token nou invalid sau format greșit, nu a trecut validarea prin API oficial!');
    }
    const decoded = decodeJWT(token);
    entry.token = token;
    entry.expiresAt = (decoded?.exp || 0) * 1000;
    entry.errorCount = 0;
    saveTokens(accountPool);
    return { success: true, message: `Token-ul pentru contul manual ${email} a fost actualizat și validat cu succes!` };
  } else {
    const token = await login(entry.email, entry.password);
    const decoded = decodeJWT(token);
    entry.token = token;
    entry.expiresAt = (decoded?.exp || 0) * 1000;
    entry.errorCount = 0;
    saveTokens(accountPool);
    return { success: true, message: `Contul ${email} a fost reautentificat cu parolă, token reîmprospătat!` };
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