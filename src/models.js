import { requestHeaders } from './headers.js';

const BASE_URL = 'https://chat.qwen.ai';
const modelCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 min

async function fetchModels(token) {
  const res = await fetch(`${BASE_URL}/api/models`, {
    headers: {
      'authorization': `Bearer ${token}`,
      ...requestHeaders(),
    },
  });
  const json = await res.json();
  return json.data || [];
}

export async function getModels(token) {
  const cached = modelCache.get(token);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.models;
  
  const models = await fetchModels(token);
  modelCache.set(token, { models, time: Date.now() });
  return models;
}

export function clearModelCache(token = null) {
  if (token) {
    modelCache.delete(token);
  } else {
    modelCache.clear();
  }
}

export function handleOpenAIModels(modelList) {
  const data = [];

  for (const m of modelList) {
    const id = m.id || '';

    const meta = m.info?.meta || {};
    const caps = meta.capabilities || {};
    const chatTypes = meta.chat_type || [];

    const has = {
      vision: !!caps.vision || id.includes('-vl-') || id.includes('vl-max') || id.includes('vl-plus'),
      thinking: !!caps.thinking,
      search: !!caps.search,
      deep_research: chatTypes.includes('deep_research'),
      image_gen: chatTypes.includes('t2i'),
      video_gen: chatTypes.includes('t2v'),
      web_dev: chatTypes.includes('web_dev'),
      slides: chatTypes.includes('slides'),
    };

    const base = { object: 'model', created: 1700000000, owned_by: 'qwen', capabilities: has };

    data.push({ id: m.id, ...base });

    if (has.thinking)       data.push({ id: m.id + '-thinking',      ...base });
    if (has.deep_research)  data.push({ id: m.id + '-deep-research', ...base });
    if (has.image_gen)      data.push({ id: m.id + '-image',         ...base });
    if (has.web_dev)        data.push({ id: m.id + '-webdev',        ...base });
    if (has.slides)         data.push({ id: m.id + '-slides',        ...base });
  }

  return { object: 'list', data };
}