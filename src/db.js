import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'data');
const TOKENS_PATH = resolve(DATA_DIR, 'tokens.json');
const CONFIG_PATH = resolve(DATA_DIR, 'config.json');

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

export function readTokens() {
  if (!existsSync(TOKENS_PATH)) return [];
  try {
    const data = readFileSync(TOKENS_PATH, 'utf-8');
    return JSON.parse(data) || [];
  } catch (err) {
    console.warn('[DB] Failed to read tokens.json:', err.message);
    return [];
  }
}

export function saveTokens(tokens) {
  try {
    writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), 'utf-8');
  } catch (err) {
    console.error('[DB] Failed to save tokens.json:', err.message);
  }
}

export function readConfig() {
  const defaultApiKey = process.env.API_KEY || '';
  const defaultAdminPass = process.env.ADMIN_PASSWORD || defaultApiKey || 'admin123';

  if (!existsSync(CONFIG_PATH)) {
    const initConfig = {
      adminPassword: defaultAdminPass,
      apiKey: defaultApiKey,
      maxConcurrentPerToken: 10,
      queueTimeoutMs: 30000,
    };
    try {
      writeFileSync(CONFIG_PATH, JSON.stringify(initConfig, null, 2), 'utf-8');
    } catch (err) {
      console.error('[DB] Failed to initialize config.json:', err.message);
    }
    return initConfig;
  }
  try {
    const data = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(data);
    return {
      adminPassword: (parsed.adminPassword !== undefined && parsed.adminPassword !== '') ? parsed.adminPassword : defaultAdminPass,
      apiKey: parsed.apiKey !== undefined ? parsed.apiKey : defaultApiKey,
      maxConcurrentPerToken: parsed.maxConcurrentPerToken !== undefined ? Number(parsed.maxConcurrentPerToken) : 10,
      queueTimeoutMs: parsed.queueTimeoutMs !== undefined ? Number(parsed.queueTimeoutMs) : 30000,
    };
  } catch (err) {
    console.warn('[DB] Failed to read config.json, returning defaults:', err.message);
    return {
      adminPassword: defaultAdminPass,
      apiKey: defaultApiKey,
      maxConcurrentPerToken: 10,
      queueTimeoutMs: 30000,
    };
  }
}

export function saveConfig(config) {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error('[DB] Failed to save config.json:', err.message);
  }
}
