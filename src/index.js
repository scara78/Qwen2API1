import { config } from 'dotenv';
config();

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { EventEmitter } from 'events';
import { loadAccounts, initAccountPool, getPoolInfo, getTotalCapacity, acquireToken, addTokenToPool, loginAndAddToken, deleteTokenFromPool, refreshSingleToken } from './auth.js';
import { handleOpenAICompletion, handleOpenAIImageGenerations, recentLogs } from './openai.js';
import { getModels, handleOpenAIModels } from './models.js';
import { getQueueInfo } from './queue.js';
import { readConfig, saveConfig } from './db.js';
import { logInfo, logWarn, readSystemLogs, readSystemLogsPaginated } from './logger.js';

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = dirname(fileURLToPath(import.meta.url));

// CORS — must be FIRST, before auth and body parsing
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-api-key');
  res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Type');
  res.header('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: '50mb' }));

// Static frontend — served at root "/" and also kept at "/admin" for backward compat
app.use(express.static(join(__dirname, '..', 'frontend'), { extensions: ['html'] }));
app.use('/admin', express.static(join(__dirname, '..', 'frontend'), { extensions: ['html'] }));

// API Key / Auth middleware with Dynamic config hot-reloading
app.use((req, res, next) => {
  // Crossover checks: skip admin static files and basic assets
  if (req.path.startsWith('/admin') && !req.path.startsWith('/admin/api')) return next();
  if (req.path === '/favicon.ico') return next();

  const sysConfig = readConfig();

  // 1. Admin API route endpoints (require adminPassword)
  if (req.path.startsWith('/admin/api')) {
    const adminPass = sysConfig.adminPassword || 'admin123';

    const auth = req.headers['authorization'];
    if (auth === `Bearer ${adminPass}`) return next();

    return res.status(401).json({ error: { message: 'Acces admin neautorizat' } });
  }

  // 2. OpenAI proxies /v1/* (require apiKey if set)
  const apiKey = sysConfig.apiKey;
  if (!apiKey) return next(); // No proxy API key configured

  const auth = req.headers['authorization'];
  if (auth === `Bearer ${apiKey}`) return next();

  res.status(401).json({ error: { message: 'Cheie API invalidă' } });
});

// OpenAI compatible Chat Completion proxy endpoint
app.post('/v1/chat/completions', handleOpenAICompletion);

// OpenAI compatible Image Generation proxy endpoint
app.post('/v1/images/generations', handleOpenAIImageGenerations);

// Model list proxy endpoint
app.get('/v1/models', async (req, res) => {
  const slot = acquireToken();
  if (!slot) return res.status(503).json({ error: { message: 'Niciun token disponibil' } });

  try {
    const modelList = await getModels(slot.token);
    res.json(handleOpenAIModels(modelList));
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  } finally {
    slot.release();
  }
});

// Health probe moved to /api/status to avoid conflicting with root SPA
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.0.0',
    pool: getPoolInfo(),
    totalCapacity: getTotalCapacity(),
    queue: getQueueInfo(),
  });
});

// === Admin API Panel Routes ===

// Admin stats: includes pool, queue, system configuration and memory logs/analytics
app.get('/admin/api/stats', (req, res) => {
  const sysConfig = readConfig();
  
  // Calculate average response duration and success rate from recent logs
  const logs = recentLogs;
  let successCount = 0;
  let totalDuration = 0;
  for (const log of logs) {
    if (log.status === 'success') successCount++;
    totalDuration += log.duration;
  }
  const avgDuration = logs.length > 0 ? Math.round(totalDuration / logs.length) : 0;
  const successRate = logs.length > 0 ? Math.round((successCount / logs.length) * 100) : 100;

  res.json({
    status: 'ok',
    version: '2.0.0',
    pool: getPoolInfo(),
    totalCapacity: getTotalCapacity(),
    queue: getQueueInfo(),
    config: {
      apiKey: sysConfig.apiKey,
      adminPassword: sysConfig.adminPassword,
      maxConcurrentPerToken: sysConfig.maxConcurrentPerToken,
      queueTimeoutMs: sysConfig.queueTimeoutMs
    },
    analytics: {
      successRate,
      avgDuration,
      recentLogs: logs
    }
  });
});

// Retrieve persistent system logs (paginated)
app.get('/admin/api/system-logs', (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 100;
    const result = readSystemLogsPaginated(page, limit);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Modify dynamically saved system parameters
app.post('/admin/api/config/update', (req, res) => {
  const { apiKey, adminPassword, maxConcurrentPerToken, queueTimeoutMs } = req.body;
  
  try {
    const sysConfig = readConfig();
    if (apiKey !== undefined) sysConfig.apiKey = apiKey.trim();
    if (adminPassword !== undefined) sysConfig.adminPassword = adminPassword.trim();
    if (maxConcurrentPerToken !== undefined) sysConfig.maxConcurrentPerToken = Number(maxConcurrentPerToken);
    if (queueTimeoutMs !== undefined) sysConfig.queueTimeoutMs = Number(queueTimeoutMs);

    saveConfig(sysConfig);
    res.json({ success: true, message: 'Parametrii sistem salvați și aplicați!' });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Manual manual token insertion
app.post('/admin/api/token/add', async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: { message: 'Token necesar' } });
  }
  try {
    const added = await addTokenToPool(token);
    res.json({ success: true, email: added.email });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Login and acquire token
app.post('/admin/api/token/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: { message: 'Email și parolă necesare' } });
  }
  try {
    const entry = await loginAndAddToken(email, password);
    res.json({ success: true, email: entry.email });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Delete account from memory & local database dynamically
app.delete('/admin/api/token/delete', (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: { message: 'Email necesar' } });
  }
  try {
    const deleted = deleteTokenFromPool(email);
    if (deleted) {
      res.json({ success: true, message: `Contul ${email} a fost șters` });
    } else {
      res.status(404).json({ error: { message: `Nu s-a găsit token pentru ${email}` } });
    }
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Refresh account token dynamically (supports password re-login and manual JWT update)
app.post('/admin/api/token/refresh', async (req, res) => {
  const { email, token } = req.body;
  if (!email) {
    return res.status(400).json({ error: { message: 'Email necesar' } });
  }
  try {
    const result = await refreshSingleToken(email, token);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});



app.listen(PORT, async () => {
  logInfo(`=========================================`);
  logInfo(` Qwen 2API Gateway Activ`);
  logInfo(`   URL Local:     http://localhost:${PORT}`);
  logInfo(`   Panel Admin:   http://localhost:${PORT}/admin`);
  logInfo(`   Endpoint API:  POST /v1/chat/completions`);
  logInfo(`=========================================`);

  const sysConfig = readConfig();
  if (sysConfig.adminPassword === 'admin123') {
    logWarn(`[SECURITATE] Consola admin rulează cu parola IMPLICITĂ: 'admin123'. Setează ADMIN_PASSWORD în variabile de mediu sau schimb-o imediat în panoul Setări!`);
  }
  if (!sysConfig.apiKey) {
    logWarn(`[SECURITATE] Cheia API este goală. Endpoint-urile proxy sunt accesibile public.`);
  }

  loadAccounts();
  await initAccountPool();
});