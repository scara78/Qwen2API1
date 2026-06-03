import crypto from 'crypto';
import { completion, parseSSEStream } from './chat.js';
import { enqueueRequest, dispatchQueued } from './queue.js';
import { readConfig } from './db.js';
import { reportTokenError } from './auth.js';
import { logInfo, logWarn, logError } from './logger.js';

const MODE_SUFFIXES = {
  '-thinking':       { chatMode: 't2t', forceThinking: true },
  '-deep-research':  { chatMode: 'deep_research' },
  '-image':          { chatMode: 't2i' },
  '-t2i':            { chatMode: 't2i' },
  '-video':          { chatMode: 't2v' },
  '-t2v':            { chatMode: 't2v' },
  '-webdev':         { chatMode: 'web_dev' },
  '-web-dev':        { chatMode: 'web_dev' },
  '-slides':         { chatMode: 'slides' },
};


function parseModelSuffix(model) {
  for (const [suffix, config] of Object.entries(MODE_SUFFIXES)) {
    if (model.endsWith(suffix)) {
      const baseModel = model.slice(0, -suffix.length);
      return { baseModel, chatMode: config.chatMode, forceThinking: config.forceThinking || false };
    }
  }
  return { baseModel: model, chatMode: 't2t', forceThinking: false };
}

function isThinkingEnabled(model, forceThinking, enableThinking) {
  if (forceThinking) return true;
  if (enableThinking) return true;
  return false;
}

function isSearchEnabled(chatMode, enableSearch) {
  if (enableSearch) return true;
  if (chatMode === 'deep_research') return true;
  return false;
}

// ============================================================================
// Baxia Security & Fingerprinting Wrappers (Alibaba Risk Bypass)
// ============================================================================

const BAXIA_VERSION = '2.5.36';
const CACHE_TTL = 4 * 60 * 1000;
let tokenCache = null;
let tokenCacheTime = 0;

function randomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  const randomBytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    result += chars[randomBytes[i] % chars.length];
  }
  return result;
}

function cryptoHash(data) {
  return crypto.createHash('md5').update(data).digest('base64').substring(0, 32);
}

function generateWebGLFingerprint() {
  const renderers = [
    'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.6)',
    'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080, OpenGL 4.6)',
    'ANGLE (AMD, AMD Radeon RX 580, OpenGL 4.6)',
  ];
  return { renderer: renderers[Math.floor(Math.random() * renderers.length)], vendor: 'Google Inc. (Intel)' };
}

async function collectFingerprintData() {
  const platforms = ['Win32', 'Linux x86_64', 'MacIntel'];
  const languages = ['en-US', 'zh-CN', 'en-GB'];
  const canvas = cryptoHash(crypto.randomBytes(32));
  
  return {
    p: platforms[Math.floor(Math.random() * platforms.length)],
    l: languages[Math.floor(Math.random() * languages.length)],
    hc: 4 + Math.floor(Math.random() * 12),
    dm: [4, 8, 16, 32][Math.floor(Math.random() * 4)],
    to: [-480, -300, 0, 60, 480][Math.floor(Math.random() * 5)],
    sw: 1920 + Math.floor(Math.random() * 200),
    sh: 1080 + Math.floor(Math.random() * 100),
    cd: 24,
    pr: [1, 1.25, 1.5, 2][Math.floor(Math.random() * 4)],
    wf: generateWebGLFingerprint().renderer.substring(0, 20),
    cf: canvas,
    af: (124.04347527516074 + Math.random() * 0.001).toFixed(14),
    ts: Date.now(),
    r: Math.random(),
  };
}

function encodeBaxiaToken(data) {
  const jsonStr = JSON.stringify(data);
  return `${BAXIA_VERSION.replace(/\./g, '')}!${Buffer.from(jsonStr).toString('base64')}`;
}

async function getBaxiaTokens() {
  const now = Date.now();
  if (tokenCache && (now - tokenCacheTime) < CACHE_TTL) {
    return tokenCache;
  }
  
  const bxUa = encodeBaxiaToken(await collectFingerprintData());
  let bxUmidToken;
  try {
    const resp = await fetch('https://sg-wum.alibaba.com/w/wu.json', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(3000),
    });
    bxUmidToken = resp.headers.get('etag') || 'T2gA' + randomString(40);
  } catch {
    bxUmidToken = 'T2gA' + randomString(40);
  }
  
  const result = { bxUa, bxUmidToken, bxV: BAXIA_VERSION };
  tokenCache = result;
  tokenCacheTime = now;
  return result;
}

// ============================================================================
// Multimodal Attachment Parsing & Aliyun OSS PUT Signer
// ============================================================================

function normalizeInputString(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (lower === '[undefined]' || lower === 'undefined' || lower === '[null]' || lower === 'null') {
    return '';
  }
  return trimmed;
}

function decodeBase64ToBytes(base64) {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const matched = dataUrl.match(/^data:([^;,]+)?;base64,(.+)$/i);
  if (!matched) return null;
  return {
    mimeType: (matched[1] || 'application/octet-stream').toLowerCase(),
    bytes: decodeBase64ToBytes(matched[2]),
  };
}

function inferFileCategory(mimeType, explicitType) {
  if (explicitType === 'image' || explicitType === 'audio' || explicitType === 'video' || explicitType === 'document') {
    return explicitType;
  }
  const mime = (mimeType || 'application/octet-stream').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

function fileExtensionFromMime(mimeType) {
  const mime = (mimeType || 'application/octet-stream').toLowerCase();
  const mapping = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'application/json': 'json',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/mp4': 'm4a',
    'audio/ogg': 'ogg',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
    'video/avi': 'avi',
  };
  return mapping[mime] || 'bin';
}

function inferFilename(rawFilename, mimeType) {
  const name = normalizeInputString(rawFilename);
  if (name) return name;
  return `attachment-${crypto.randomUUID()}.${fileExtensionFromMime(mimeType)}`;
}

async function getAttachmentBytes(attachment) {
  const dataParsed = parseDataUrl(attachment.source);
  if (dataParsed) {
    return {
      bytes: dataParsed.bytes,
      mimeType: attachment.mimeType || dataParsed.mimeType,
      filename: inferFilename(attachment.filename, attachment.mimeType || dataParsed.mimeType),
    };
  }

  if (/^https?:\/\//i.test(attachment.source)) {
    const resp = await fetch(attachment.source);
    if (!resp.ok) {
      throw new Error(`Failed to fetch attachment URL: ${resp.status}`);
    }
    const mimeType = attachment.mimeType || resp.headers.get('content-type') || 'application/octet-stream';
    const bytes = new Uint8Array(await resp.arrayBuffer());
    return {
      bytes,
      mimeType,
      filename: inferFilename(attachment.filename, mimeType),
    };
  }

  const maybeBase64 = attachment.source.replace(/\s+/g, '');
  const bytes = decodeBase64ToBytes(maybeBase64);
  const mimeType = attachment.mimeType || 'application/octet-stream';
  return {
    bytes,
    mimeType,
    filename: inferFilename(attachment.filename, mimeType),
  };
}

async function requestUploadToken(token, file, baxiaTokens) {
  const filetype = inferFileCategory(file.mimeType, file.explicitType);
  const resp = await fetch('https://chat.qwen.ai/api/v2/files/getstsToken', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'bx-ua': baxiaTokens.bxUa,
      'bx-umidtoken': baxiaTokens.bxUmidToken,
      'bx-v': baxiaTokens.bxV,
      'source': 'web',
      'timezone': new Date().toUTCString(),
      'Referer': 'https://chat.qwen.ai/',
      'x-request-id': crypto.randomUUID(),
    },
    body: JSON.stringify({
      filename: file.filename,
      filesize: file.bytes.length,
      filetype,
    }),
  });

  const data = await resp.json();
  if (!resp.ok || !data?.success || !data?.data?.file_url) {
    throw new Error(`Failed to get upload token: ${resp.status} ${JSON.stringify(data)}`);
  }

  return {
    tokenData: data.data,
    filetype,
  };
}

function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function formatOssDate(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

function formatOssDateScope(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function sha256Hex(input) {
  const bytes = typeof input === 'string' ? Buffer.from(input) : input;
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function hmacSha256(key, content) {
  const message = typeof content === 'string' ? Buffer.from(content) : content;
  return crypto.createHmac('sha256', key).update(message).digest();
}

function buildOssSignedHeaders(uploadUrl, tokenData, file) {
  const parsedUrl = new URL(uploadUrl);
  const query = parsedUrl.searchParams;
  const credentialFromQuery = decodeURIComponent(query.get('x-oss-credential') || '');
  const credentialParts = credentialFromQuery.split('/');

  const dateScope = credentialParts[1] || formatOssDateScope();
  const region = credentialParts[2] || 'ap-southeast-1';
  const xOssDate = query.get('x-oss-date') || formatOssDate();

  const hostParts = parsedUrl.hostname.split('.');
  const bucket = hostParts.length > 0 ? hostParts[0] : '';
  const objectPath = parsedUrl.pathname || '/';
  const canonicalUri = bucket ? `/${bucket}${objectPath}` : objectPath;
  const xOssUserAgent = 'aliyun-sdk-js/6.23.0';
  const canonicalHeaders = [
    `content-type:${file.mimeType}`,
    'x-oss-content-sha256:UNSIGNED-PAYLOAD',
    `x-oss-date:${xOssDate}`,
    `x-oss-security-token:${tokenData.security_token}`,
    `x-oss-user-agent:${xOssUserAgent}`,
  ].join('\n') + '\n';
  const canonicalRequest = [
    'PUT',
    canonicalUri,
    '',
    canonicalHeaders,
    '',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const credentialScope = `${dateScope}/${region}/oss/aliyun_v4_request`;
  const stringToSign = [
    'OSS4-HMAC-SHA256',
    xOssDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmacSha256(Buffer.from(`aliyun_v4${tokenData.access_key_secret}`), dateScope);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, 'oss');
  const kSigning = hmacSha256(kService, 'aliyun_v4_request');
  const signature = toHex(hmacSha256(kSigning, stringToSign));

  return {
    'Accept': '*/*',
    'Content-Type': file.mimeType,
    'authorization': `OSS4-HMAC-SHA256 Credential=${tokenData.access_key_id}/${credentialScope},SignedHeaders=content-type;x-oss-content-sha256;x-oss-date;x-oss-security-token;x-oss-user-agent,Signature=${signature}`,
    'x-oss-content-sha256': 'UNSIGNED-PAYLOAD',
    'x-oss-date': xOssDate,
    'x-oss-security-token': tokenData.security_token,
    'x-oss-user-agent': xOssUserAgent,
    'Referer': 'https://chat.qwen.ai/',
  };
}

async function uploadFileToQwenOss(file, tokenData) {
  const uploadUrl = typeof tokenData.file_url === 'string' ? tokenData.file_url.split('?')[0] : '';
  if (!uploadUrl) {
    throw new Error('Upload failed: missing upload URL');
  }
  const signedHeaders = buildOssSignedHeaders(tokenData.file_url, tokenData, file);
  const resp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: signedHeaders,
    body: file.bytes,
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Upload failed with status ${resp.status}${detail ? `: ${detail}` : ''}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensureUploadStatusForNonVideo(token, filetype, baxiaTokens) {
  if (filetype === 'video') return;
  const maxAttempts = 30;
  let lastPayload = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await fetch('https://chat.qwen.ai/api/v2/users/status', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${token}`,
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'bx-v': baxiaTokens.bxV,
        'source': 'web',
        'timezone': new Date().toUTCString(),
        'Referer': 'https://chat.qwen.ai/',
        'x-request-id': crypto.randomUUID(),
      },
      body: JSON.stringify({
        typarms: {
          typarm1: 'web',
          typarm2: '',
          typarm3: 'prod',
          typarm4: 'qwen_chat',
          typarm5: 'product',
          orgid: 'tongyi',
        }
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`Upload status check failed with status ${resp.status}${detail ? `: ${detail}` : ''}`);
    }
    const payload = await resp.json().catch(() => ({}));
    lastPayload = payload;
    if (payload?.data === true) {
      return;
    }
    if (attempt < maxAttempts) {
      await sleep(1000);
    }
  }
  throw new Error(`Upload status not ready for non-video file${lastPayload ? `: ${JSON.stringify(lastPayload)}` : ''}`);
}

async function parseDocumentIfNeeded(token, qwenFilePayload, filetype, file, baxiaTokens) {
  if (filetype !== 'document') return;
  const resp = await fetch('https://chat.qwen.ai/api/v2/files/parse', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'bx-ua': baxiaTokens.bxUa,
      'bx-umidtoken': baxiaTokens.bxUmidToken,
      'bx-v': baxiaTokens.bxV,
      'source': 'web',
      'timezone': new Date().toUTCString(),
      'Referer': 'https://chat.qwen.ai/',
      'x-request-id': crypto.randomUUID(),
    },
    body: JSON.stringify({ file_id: qwenFilePayload.id }),
  });
  const detail = await resp.text().catch(() => '');
  if (!resp.ok) {
    throw new Error(`Document parse failed with status ${resp.status}${detail ? `: ${detail}` : ''}`);
  }
  let payload = {};
  try {
    payload = detail ? JSON.parse(detail) : {};
  } catch {}
  if (payload && payload.success === false) {
    throw new Error(`Document parse rejected${payload?.msg ? `: ${payload.msg}` : ''}`);
  }
}

function extractUploadedFileId(fileUrl) {
  try {
    const pathname = decodeURIComponent(new URL(fileUrl).pathname);
    const filename = pathname.split('/').pop() || '';
    if (filename.includes('_')) {
      return filename.split('_')[0];
    }
  } catch {}
  return crypto.randomUUID();
}

function buildQwenFilePayload(file, tokenData, filetype) {
  const now = Date.now();
  const id = normalizeInputString(tokenData?.file_id) || extractUploadedFileId(tokenData.file_url);
  const isDocument = filetype === 'document';
  const showType = isDocument ? 'file' : filetype;
  const fileClass = isDocument ? 'document' : (filetype === 'image' ? 'vision' : filetype);
  const fileSize = file.bytes.length;
  const fileMimeType = file.mimeType;
  const uploadTaskId = crypto.randomUUID();
  return {
    type: showType,
    file: {
      created_at: now,
      data: {},
      filename: file.filename,
      hash: null,
      id,
      meta: {
        name: file.filename,
        size: fileSize,
        content_type: fileMimeType,
      },
      update_at: now,
    },
    id,
    url: tokenData.file_url,
    name: file.filename,
    collection_name: '',
    progress: 0,
    status: 'uploaded',
    is_uploading: false,
    error: '',
    showType,
    file_class: fileClass,
    itemId: crypto.randomUUID(),
    greenNet: 'success',
    size: fileSize,
    file_type: fileMimeType,
    uploadTaskId,
  };
}

async function uploadAttachments(token, attachments, baxiaTokens) {
  const files = [];
  for (let i = 0; i < attachments.length; i++) {
    const rawAttachment = attachments[i];
    const loaded = await getAttachmentBytes(rawAttachment);
    loaded.explicitType = rawAttachment.explicitType;
    
    const { tokenData, filetype } = await requestUploadToken(token, loaded, baxiaTokens);
    await uploadFileToQwenOss(loaded, tokenData);
    const qwenFilePayload = buildQwenFilePayload(loaded, tokenData, filetype);
    await ensureUploadStatusForNonVideo(token, filetype, baxiaTokens);
    await parseDocumentIfNeeded(token, qwenFilePayload, filetype, loaded, baxiaTokens);
    if (filetype === 'document') {
      await ensureUploadStatusForNonVideo(token, filetype, baxiaTokens);
    }
    files.push(qwenFilePayload);
  }
  return files;
}

// ============================================================================
// Multimodal Input Parsing Helpers
// ============================================================================

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeLegacyFiles(message) {
  const attachments = [];
  const candidates = [...toArray(message?.attachments), ...toArray(message?.files)];
  for (const item of candidates) {
    if (!item) continue;
    const source = normalizeInputString(item.data || item.file_data || item.url || item.file_url);
    if (!source) continue;
    attachments.push({
      source,
      filename: normalizeInputString(item.filename) || normalizeInputString(item.name),
      mimeType: normalizeInputString(item.mime_type) || normalizeInputString(item.content_type) || normalizeInputString(item.type),
      explicitType: item.type,
    });
  }
  return attachments;
}

function pushTextPart(parts, value) {
  const text = normalizeInputString(value);
  if (text) {
    parts.push(text);
  }
}

function normalizeContentParts(content) {
  if (typeof content === 'string') {
    const text = normalizeInputString(content);
    return {
      text,
      attachments: [],
    };
  }

  if (!Array.isArray(content)) {
    return {
      text: '',
      attachments: [],
    };
  }

  const textParts = [];
  const attachments = [];

  for (const part of content) {
    if (!part) continue;
    if (typeof part === 'string') {
      pushTextPart(textParts, part);
      continue;
    }

    const type = part.type || '';
    if (type === 'text' || type === 'input_text') {
      pushTextPart(textParts, part.text || part.input_text);
      continue;
    }

    if (type === 'image_url' || type === 'input_image') {
      const imageUrl = normalizeInputString(
        part.image_url?.url ||
        part.image_url ||
        part.url ||
        part.file_url ||
        part.file_data
      );
      if (imageUrl) {
        attachments.push({
          source: imageUrl,
          filename: normalizeInputString(part.filename) || normalizeInputString(part.name),
          mimeType: normalizeInputString(part.mime_type) || normalizeInputString(part.content_type),
          explicitType: 'image',
        });
      }
      continue;
    }

    if (type === 'file' || type === 'input_file' || type === 'audio' || type === 'input_audio' || type === 'video' || type === 'input_video') {
      const fileSource = normalizeInputString(part.file_data || part.url || part.file_url || part.data);
      if (fileSource) {
        const normalizedFilename = normalizeInputString(part.filename) || normalizeInputString(part.name);
        const normalizedMimeType = normalizeInputString(part.mime_type) || normalizeInputString(part.content_type);
        const explicitType = type.includes('audio') ? 'audio' : (type.includes('video') ? 'video' : undefined);
        attachments.push({
          source: fileSource,
          filename: normalizedFilename,
          mimeType: normalizedMimeType,
          explicitType,
        });
      }
      continue;
    }

    if (typeof part.text === 'string') {
      pushTextPart(textParts, part.text);
    }
  }

  return {
    text: textParts.join('\n'),
    attachments,
  };
}

function parseIncomingMessageAttachments(message) {
  const parsed = normalizeContentParts(message?.content);
  return {
    text: parsed.text,
    attachments: [...parsed.attachments, ...normalizeLegacyFiles(message)],
  };
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(c => c.type === 'text').map(c => c.text || '').join('');
  }
  return '';
}

// Pre-process messages to flatten system prompts and reconstruct tool calls.
//
// Qwen Web's "new-chat + messages[]" API only accepts a SINGLE initial message.
// For multi-turn conversations we collapse the entire history into one user
// message so Qwen sees context without hitting the "too many messages" limit.
function preprocessMessages(messages) {
  let systemPrompt = '';
  const turns = []; // { role, content, files }

  for (const m of messages) {
    if (m.role === 'system') {
      systemPrompt += (typeof m.content === 'string' ? m.content : extractText(m.content)) + '\n';
      continue;
    }

    let content = typeof m.content === 'string' ? m.content : extractText(m.content);

    // Reconstruct assistant's <tool_call> tags from OpenAI tool_calls array
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const callsText = m.tool_calls.map(tc => {
        const functionName = tc.function?.name || '';
        let args = tc.function?.arguments || '{}';
        if (typeof args === 'object') args = JSON.stringify(args);
        return `<tool_call>{"name": "${functionName}", "arguments": ${args}}</tool_call>`;
      }).join('\n');
      content = (content ? content + '\n' : '') + callsText;
    }

    // Map tool/function → user (Qwen Web doesn't know the tool role)
    let role = m.role;
    if (role === 'function' || role === 'tool') {
      role = 'user';
      const toolLabel = m.name || m.tool_call_id || 'tool';
      content = `[Tool Result: ${toolLabel}]\n${content || ''}`;
    }

    turns.push({ role, content: content || '', files: m.files || [] });
  }

  // Fallback: if only a system prompt was given
  if (turns.length === 0 && systemPrompt) {
    return [{ role: 'user', content: systemPrompt.trim(), files: [] }];
  }

  // ── Single-turn fast path ────────────────────────────────────────────────
  // One non-system message: just merge system prompt into it if present.
  if (turns.length === 1) {
    const t = turns[0];
    const content = systemPrompt
      ? `[System Instructions]\n${systemPrompt.trim()}\n\n[User Input]\n${t.content}`
      : t.content;
    return [{ role: t.role, content, files: t.files }];
  }

  // ── Multi-turn collapse ──────────────────────────────────────────────────
  // Qwen Web's new-chat API rejects multi-message arrays.  Collapse the
  // entire conversation history into one structured user message so the
  // model has full context without hitting the "too many messages" limit.
  const parts = [];

  if (systemPrompt) {
    parts.push(`[System Instructions]\n${systemPrompt.trim()}`);
  }

  parts.push('[Conversation History]');

  for (const t of turns) {
    if (t.role === 'user') {
      parts.push(`\n[User]\n${t.content}`);
    } else if (t.role === 'assistant') {
      // Show tool calls in a readable way; hide the raw XML from the prompt
      const tcMatch = t.content.match(/<tool_call>([\s\S]*?)<\/tool_call>/g);
      if (tcMatch) {
        const calls = tcMatch.map(raw => {
          try {
            const inner = raw.replace(/<\/?tool_call>/g, '').trim();
            const p = JSON.parse(inner);
            return `  → called ${p.name}(${JSON.stringify(p.arguments)})`;
          } catch { return `  → ${raw}`; }
        }).join('\n');
        const textPart = t.content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
        parts.push(`\n[Assistant]\n${textPart ? textPart + '\n' : ''}${calls}`);
      } else {
        parts.push(`\n[Assistant]\n${t.content}`);
      }
    } else {
      // Already mapped tool → user above; kept here for safety
      parts.push(`\n[${t.role}]\n${t.content}`);
    }
  }

  // Determine whether the last turn was a tool result or a regular user message
  const lastTurn = turns[turns.length - 1];
  const isToolResult = lastTurn.content.startsWith('[Tool Result:');
  if (isToolResult) {
    parts.push('\n\nUsing the conversation history and tool results above, please provide your final answer to the user.');
  } else {
    parts.push('\n\nPlease continue the conversation by responding to the latest user message.');
  }

  return [{ role: 'user', content: parts.join('\n'), files: [] }];
}

// Build standard official Qwen Web Chat tree-chained messages structure
function buildQwenMessages(messages, model, chatMode, timestamp, thinkingEnabled = true, searchEnabled = true) {
  const processed = preprocessMessages(messages);
  const qwenMsgs = [];
  
  // Pre-generate UUIDs for nodes to build the exact pointer chain
  const uuids = Array.from({ length: processed.length + 1 }, () => crypto.randomUUID());

  for (let i = 0; i < processed.length; i++) {
    const msg = processed[i];
    const currentFid = uuids[i];
    const nextFid = uuids[i + 1];
    const prevFid = i === 0 ? null : uuids[i - 1];

    qwenMsgs.push({
      fid: currentFid,
      parentId: prevFid,
      childrenIds: [nextFid],
      role: msg.role,
      content: msg.content,
      user_action: 'chat',
      files: msg.files || [],
      timestamp,
      models: [model],
      chat_type: chatMode,
      feature_config: {
        thinking_enabled: chatMode === 't2t' ? thinkingEnabled : false,
        output_schema: 'phase',
        research_mode: chatMode === 'deep_research' ? 'deep' : 'normal',
        auto_thinking: chatMode === 't2t' ? thinkingEnabled : false,
        thinking_mode: chatMode === 't2t' ? (thinkingEnabled ? 'Auto' : 'Disabled') : 'Disabled',
        thinking_format: 'summary',
        auto_search: chatMode === 't2t' ? searchEnabled : true,
      },
      extra: { meta: { subChatType: chatMode } },
      sub_chat_type: chatMode,
      parent_id: prevFid,
    });
  }
  return qwenMsgs;
}

// Capped memory requests queue for live monitoring dashboard
export const recentLogs = [];

export function recordLog({ model, duration, status, account, tokens }) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString() + ` (${now.toLocaleDateString()})`;
  recentLogs.push({
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    time: timeStr,
    model,
    duration: Math.round(duration),
    status,
    account: account || 'unknown',
    tokens: tokens || 0
  });

  if (recentLogs.length > 50) {
    recentLogs.shift();
  }
}

export async function handleOpenAICompletion(req, res) {
  const { model, messages, stream = false, tools } = req.body;
  const startTime = Date.now();

  if (!model || !messages || !messages.length) {
    return res.status(400).json({ error: { message: 'model and messages are required' } });
  }

  const { baseModel, chatMode, forceThinking } = parseModelSuffix(model);

  // Video generation (t2v) is an async web-UI-only feature in Qwen.
  // The SSE closes immediately with empty content; the video result is delivered
  // exclusively through Qwen's internal WebSocket/push mechanism — no REST polling
  // endpoint exists. Reject early with a clear explanation.
  if (chatMode === 't2v') {
    return res.status(501).json({
      error: {
        message:
          'Video generation (t2v / -video mode) is not supported via this API proxy. ' +
          'Qwen generates videos asynchronously and delivers the result only through ' +
          'its proprietary web-UI push mechanism; no REST polling endpoint is available. ' +
          'Use the Qwen web interface at https://chat.qwen.ai for video generation.',
        type: 'not_implemented',
        code: 'video_generation_unsupported',
      },
    });
  }

  const hasCustomTools = Array.isArray(tools) && tools.length > 0;

  // When the conversation contains tool results (second+ turn in a tool-call loop),
  // Qwen can enter a very long thinking phase (200+ s) even on non-thinking models
  // because it tries to reason over the entire collapsed conversation including tool outputs.
  // Disable thinking mode whenever we are processing tool results so the answer
  // comes back promptly.
  const hasToolResults = Array.isArray(messages) && messages.some(m => m.role === 'tool' || m.role === 'function');
  const thinkingEnabled = (hasCustomTools && hasToolResults)
    ? false
    : isThinkingEnabled(model, forceThinking, req.body.enable_thinking);
  const searchEnabled = isSearchEnabled(chatMode, req.body.enable_search);
  
  const timestamp = Math.floor(Date.now() / 1000);
  const processedMessages = [...messages];
  if (hasCustomTools) {
    const toolInstructions = `[SYSTEM INSTRUCTION]
You are a helpful assistant equipped with the following external tools. 
If you decide to call any tool, you MUST output exactly in the following XML format:
<tool_call>{"name": "tool_name", "arguments": {"arg1": "val1"}}</tool_call>
Do not add any text before or after the <tool_call> tag. If no tool is needed, respond normally.

Here is the list of available tools in JSON format:
${JSON.stringify(tools, null, 2)}`;
    
    const firstMsg = processedMessages[0];
    if (firstMsg && firstMsg.role === 'system') {
      processedMessages[0] = { ...firstMsg, content: `${toolInstructions}\n\n${firstMsg.content}` };
    } else {
      processedMessages.unshift({ role: 'system', content: toolInstructions });
    }
  }

  // Extract all plain text and attachments from incoming messages
  const messagesWithAttachments = [];
  let hasAnyAttachments = false;
  for (const m of processedMessages) {
    const parsed = parseIncomingMessageAttachments(m);
    messagesWithAttachments.push({
      role: m.role,
      content: parsed.text,
      attachments: parsed.attachments,
      originalContent: m.content
    });
    if (parsed.attachments.length > 0) {
      hasAnyAttachments = true;
    }
  }

  let baxiaTokens = null;
  if (hasAnyAttachments) {
    try {
      baxiaTokens = await getBaxiaTokens();
    } catch (err) {
      logWarn(`Baxia fingerprint collection failed: ${err.message}. Proceeding without signature...`);
    }
  }

  const requestId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let result;
  let slot;
  const excludeEmails = [];
  const maxAttempts = 3;
  let lastError = null;

  // For streaming: flush SSE headers immediately so the proxy/browser
  // doesn't time out while we wait for the queue + Qwen API.
  let heartbeat = null;
  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Keep the connection alive with SSE comments every 15 s
    heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': keep-alive\n\n');
    }, 15000);
  }

  const controller = new AbortController();

  // In Node.js 24, req.on('close') fires immediately after the request body is consumed
  // (even before any response is written). Use req.socket.on('close') instead, which
  // only fires when the actual TCP connection closes (i.e. client truly disconnected).
  const onDisconnect = () => {
    // Ignore socket close if we already finished the response cleanly
    if (res.writableEnded) return;
    logInfo(`[CLIENT DISCONNECT] Client closed connection for request ${requestId}. Aborting upstream stream...`);
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    controller.abort();
    if (slot) {
      slot.release();
      slot = null;
    }
    dispatchQueued();
  };
  req.socket.on('close', onDisconnect);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (controller.signal.aborted) break;
    try {
      const config = readConfig();
      const timeoutMs = config.queueTimeoutMs || 30000;
      
      slot = await enqueueRequest(timeoutMs, excludeEmails, controller.signal);
      if (controller.signal.aborted) {
        if (slot) {
          slot.release();
          slot = null;
        }
        dispatchQueued();
        break;
      }

      try {
        // Dynamic file uploads utilizing the specific account's allocated token
        if (hasAnyAttachments) {
          for (const m of messagesWithAttachments) {
            if (m.attachments && m.attachments.length > 0) {
              m.files = await uploadAttachments(slot.token, m.attachments, baxiaTokens);
            } else {
              m.files = [];
            }
          }
        }

        const qwenMessages = buildQwenMessages(messagesWithAttachments, baseModel, chatMode, timestamp, thinkingEnabled, searchEnabled);

        result = await completion({
          token: slot.token,
          model: baseModel,
          messages: qwenMessages,
          chatMode,
          thinkingEnabled,
          searchEnabled,
        }, controller.signal);
        result.slot = slot;
        break; // Success! Break out of the retry loop.
      } catch (err) {
        if (controller.signal.aborted) {
          logInfo(`[RETRY] Request aborted during attempt ${attempt}, skipping retry...`);
          break;
        }
        const failedEmail = slot.account?.email || 'unknown';
        reportTokenError(slot.token);
        slot.release();
        dispatchQueued();
        
        excludeEmails.push(failedEmail);
        slot = null; // Clear slot reference to prevent double release in finally block
        lastError = err;
        logWarn(`[RETRY] Attempt ${attempt} failed on ${failedEmail}: ${err.message}. Trying next available account...`);
      }
    } catch (err) {
      lastError = err;
      logWarn(`[RETRY] Queue slot acquisition failed on attempt ${attempt}: ${err.message}`);
      break; // Queue timeout or size overflow, no need to keep trying
    }
  }

  if (!result) {
    const duration = Date.now() - startTime;
    recordLog({ model, duration, status: 'failed', account: excludeEmails.join(' -> ') || 'unknown', tokens: 0 });
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    if (stream) {
      // Headers already sent — send error as SSE event then close
      const errMsg = `All account routing attempts failed. Last error: ${lastError?.message}`;
      res.write(`data: ${JSON.stringify({ error: { message: errMsg } })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    return res.status(502).json({ error: { message: `All account routing attempts failed. Last error: ${lastError?.message}` } });
  }

  const { body: streamBody } = result;

  try {
    if (stream) {
      // Headers already sent above — just clear heartbeat and start writing chunks
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }

      res.write(`data: ${JSON.stringify({
        id: requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      })}\n\n`);

      let totalTokens = 0;
      let finalUsage = null;
      let toolCallBuffer = '';
      let isBufferingToolCall = false;
      let toolCallEmitted = false;

      for await (const event of parseSSEStream(streamBody)) {
        // Native function_call from thinking models — emit directly and stop.
        if (event.type === 'function_call') {
          const callId = 'call_' + Math.random().toString(36).slice(2, 10);
          res.write(`data: ${JSON.stringify({
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: callId,
                  type: 'function',
                  function: { name: event.name, arguments: event.arguments }
                }]
              },
              finish_reason: 'tool_calls',
            }],
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          toolCallEmitted = true;
          break;
        }

        if (event.type === 'content') {
          const content = event.content;
          if (hasCustomTools) {
            toolCallBuffer += content;
            if (!isBufferingToolCall && toolCallBuffer.includes('<tool_call>')) {
              isBufferingToolCall = true;
            }

            if (isBufferingToolCall) {
              if (toolCallBuffer.includes('</tool_call>')) {
                isBufferingToolCall = false;
                const startIdx = toolCallBuffer.indexOf('<tool_call>');
                const endIdx = toolCallBuffer.indexOf('</tool_call>');

                if (startIdx > 0) {
                  const plainText = toolCallBuffer.slice(0, startIdx);
                  res.write(`data: ${JSON.stringify({
                    id: requestId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{ index: 0, delta: { content: plainText }, finish_reason: null }],
                  })}\n\n`);
                }

                const rawJson = toolCallBuffer.slice(startIdx + 11, endIdx).trim();
                try {
                  const parsedCall = JSON.parse(rawJson);
                  const toolName = parsedCall.name;
                  const toolArgs = typeof parsedCall.arguments === 'object' ? JSON.stringify(parsedCall.arguments) : parsedCall.arguments || '{}';

                  res.write(`data: ${JSON.stringify({
                    id: requestId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{
                      index: 0,
                      delta: {
                        tool_calls: [{
                          index: 0,
                          id: 'call_' + Math.random().toString(36).slice(2, 10),
                          type: 'function',
                          function: {
                            name: toolName,
                            arguments: toolArgs
                          }
                        }]
                      },
                      finish_reason: 'tool_calls'
                    }],
                  })}\n\n`);
                  toolCallEmitted = true;
                } catch (e) {
                  res.write(`data: ${JSON.stringify({
                    id: requestId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{ index: 0, delta: { content: toolCallBuffer }, finish_reason: null }],
                  })}\n\n`);
                }
                toolCallBuffer = '';
              }
            } else {
              const possibleStart = '<tool_call>';
              let shouldWait = false;
              for (let len = 1; len < possibleStart.length; len++) {
                if (toolCallBuffer.endsWith(possibleStart.slice(0, len))) {
                  shouldWait = true;
                  break;
                }
              }

              if (!shouldWait) {
                res.write(`data: ${JSON.stringify({
                  id: requestId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [{ index: 0, delta: { content: toolCallBuffer }, finish_reason: null }],
                })}\n\n`);
                toolCallBuffer = '';
              }
            }
          } else {
            res.write(`data: ${JSON.stringify({
              id: requestId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { content }, finish_reason: null }],
            })}\n\n`);
          }
        } else if (event.type === 'thinking') {
          res.write(`data: ${JSON.stringify({
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { reasoning_content: event.content }, finish_reason: null }],
          })}\n\n`);
        } else if (event.type === 'image') {
          res.write(`data: ${JSON.stringify({
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: event.content }, finish_reason: null }],
          })}\n\n`);
        } else if (event.type === 'research') {
          res.write(`data: ${JSON.stringify({
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { reasoning_content: `[${event.stage}] ${event.content}` }, finish_reason: null }],
          })}\n\n`);
        } else if (event.type === 'usage_update') {
          finalUsage = event.usage;
        } else if (event.type === 'done') {
          const u = event.usage || finalUsage;
          const promptTokens = u?.input_tokens || 0;
          const completionTokens = u?.output_tokens || 0;
          totalTokens = promptTokens + completionTokens;

          // Skip the stop chunk if we already emitted tool_calls — clients
          // stop reading after finish_reason:"tool_calls" and a second chunk
          // with finish_reason:"stop" can confuse some frameworks.
          if (!toolCallEmitted) {
            res.write(`data: ${JSON.stringify({
              id: requestId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: {}, finish_reason: hasCustomTools && toolCallBuffer ? 'tool_calls' : 'stop' }],
              usage: event.usage ? {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: totalTokens,
              } : undefined,
            })}\n\n`);
          }
          res.write('data: [DONE]\n\n');
        }
      }

      // Flush remaining toolCallBuffer if it exists
      if (hasCustomTools && toolCallBuffer) {
        res.write(`data: ${JSON.stringify({
          id: requestId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { content: toolCallBuffer }, finish_reason: 'stop' }],
        })}\n\n`);
      }

      res.end();

      const duration = Date.now() - startTime;
      recordLog({ model, duration, status: 'success', account: slot.account?.email, tokens: totalTokens });
    } else {
      let fullContent = '';
      let fullThinking = '';
      let usage = null;

      let nativeFunctionCall = null;

      for await (const event of parseSSEStream(streamBody)) {
        if (event.type === 'function_call') {
          // Thinking model used native function calling — capture and stop.
          nativeFunctionCall = { name: event.name, arguments: event.arguments };
          usage = event.usage;
          break;
        } else if (event.type === 'content' || event.type === 'image') {
          fullContent += event.content;
        } else if (event.type === 'thinking' || event.type === 'research') {
          const prefix = event.type === 'research' ? `[${event.stage}] ` : '';
          fullThinking += prefix + event.content;
        } else if (event.type === 'usage_update' || event.type === 'done') {
          usage = event.usage || usage;
        }
      }

      // Fast-path for native function calls (thinking models)
      if (nativeFunctionCall) {
        const callId = 'call_' + Math.random().toString(36).slice(2, 10);
        const promptTokens = usage?.input_tokens || 0;
        const completionTokens = usage?.output_tokens || 0;
        return res.json({
          id: requestId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: callId,
                type: 'function',
                function: { name: nativeFunctionCall.name, arguments: nativeFunctionCall.arguments }
              }]
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
        });
      }

      const promptTokens = usage?.input_tokens || 0;
      const completionTokens = usage?.output_tokens || 0;
      const totalTokens = promptTokens + completionTokens;

      // Strip inline <think>...</think> blocks emitted by some Qwen models;
      // move their content into fullThinking so the answer is clean.
      fullContent = fullContent.replace(/<think>([\s\S]*?)<\/think>/g, (_, inner) => {
        fullThinking += inner.trim() + '\n';
        return '';
      }).trim();

      let toolCalls = null;
      let finishReason = 'stop';

      if (hasCustomTools && fullContent.includes('<tool_call>')) {
        // Find the LAST complete <tool_call>...</tool_call> block to avoid
        // matching partial mentions that appear inside thinking text.
        const lastEnd = fullContent.lastIndexOf('</tool_call>');
        const lastStart = lastEnd > -1 ? fullContent.lastIndexOf('<tool_call>', lastEnd) : -1;
        const startIdx = lastStart;
        const endIdx = lastEnd;
        if (endIdx > startIdx) {
          const rawJson = fullContent.slice(startIdx + 11, endIdx).trim();
          try {
            const parsedCall = JSON.parse(rawJson);
            const toolName = parsedCall.name;
            const toolArgs = typeof parsedCall.arguments === 'object' ? JSON.stringify(parsedCall.arguments) : parsedCall.arguments || '{}';
            
            toolCalls = [{
              id: 'call_' + Math.random().toString(36).slice(2, 10),
              type: 'function',
              function: {
                name: toolName,
                arguments: toolArgs
              }
            }];
            finishReason = 'tool_calls';
            
            const before = fullContent.slice(0, startIdx);
            const after = fullContent.slice(endIdx + 12);
            fullContent = (before + after).trim();
          } catch (e) {
            // keep content as-is if parse fails
          }
        }
      }

      const response = {
        id: requestId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: fullContent,
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
            ...(fullThinking ? { reasoning_content: fullThinking } : {}),
          },
          finish_reason: finishReason,
        }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens,
        },
      };
      res.json(response);

      const duration = Date.now() - startTime;
      recordLog({ model, duration, status: 'success', account: slot.account?.email, tokens: totalTokens });
    }
  } catch (err) {
    logError(`Stream error: ${err.message}`);
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    
    const duration = Date.now() - startTime;
    recordLog({ model, duration, status: 'failed', account: slot?.account?.email, tokens: 0 });

    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message } });
    } else {
      // SSE already open — send error chunk then close
      try {
        res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
        res.write('data: [DONE]\n\n');
      } catch {}
      res.end();
    }
  } finally {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    req.socket.off('close', onDisconnect);
    if (slot) {
      slot.release();
    }
    dispatchQueued();
  }
}

// ============================================================================
// OpenAI Standard Image Generations Endpoint (/v1/images/generations)
// ============================================================================

function tryParseRatioString(size) {
  const text = normalizeInputString(size);
  if (!text) return null;
  const m = text.toLowerCase().match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return `${w}:${h}`;
}

function tryParseOpenAiImageSize(size) {
  const text = normalizeInputString(size);
  if (!text) return null;
  const m = text.toLowerCase().match(/^(\d{2,5})\s*x\s*(\d{2,5})$/);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function mapOpenAiImageSizeToQwenRatio(size) {
  const ratio = tryParseRatioString(size);
  if (ratio) {
    const validRatios = ['1:1', '16:9', '9:16', '4:3', '3:4'];
    if (validRatios.includes(ratio)) return ratio;
  }
  
  const parsed = tryParseOpenAiImageSize(size);
  if (!parsed) return '1:1';
  const { width, height } = parsed;
  const r = width / height;

  const candidates = [
    { key: '1:1', r: 1 },
    { key: '16:9', r: 16 / 9 },
    { key: '9:16', r: 9 / 16 },
    { key: '4:3', r: 4 / 3 },
    { key: '3:4', r: 3 / 4 },
  ];

  let best = candidates[0];
  let bestDiff = Infinity;
  for (const c of candidates) {
    const diff = Math.abs(r - c.r);
    if (diff < bestDiff) {
      best = c;
      bestDiff = diff;
    }
  }
  return best.key;
}

async function fetchImageAsBase64(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch image: HTTP ${resp.status}`);
  }
  const arrayBuffer = await resp.arrayBuffer();
  return Buffer.from(arrayBuffer).toString('base64');
}

export async function handleOpenAIImageGenerations(req, res) {
  const startTime = Date.now();
  const prompt = normalizeInputString(req.body.prompt);
  if (!prompt) {
    return res.status(400).json({ error: { message: 'prompt is required', type: 'invalid_request_error' } });
  }

  const responseFormat = normalizeInputString(req.body.response_format) || 'url';
  if (responseFormat !== 'url' && responseFormat !== 'b64_json') {
    return res.status(400).json({ error: { message: 'response_format must be one of url or b64_json', type: 'invalid_request_error' } });
  }

  const actualModel = normalizeInputString(req.body.model) || 'qwen-max';
  const nRaw = req.body.n;
  let n = Number.isFinite(nRaw) ? Number(nRaw) : Number.parseInt(String(nRaw || ''), 10);
  if (!Number.isFinite(n) || n <= 0) n = 1;
  if (n > 10) n = 10;

  const qwenRatio = mapOpenAiImageSizeToQwenRatio(req.body.size);
  
  const finalModel = actualModel.endsWith('-image') || actualModel.endsWith('-t2i') ? actualModel : `${actualModel}-image`;
  const { baseModel, chatMode } = parseModelSuffix(finalModel);

  let slot;
  const excludeEmails = [];
  const maxAttempts = 3;
  let lastError = null;
  let result = null;

  const controller = new AbortController();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (controller.signal.aborted) break;
    try {
      const config = readConfig();
      const timeoutMs = config.queueTimeoutMs || 30000;
      slot = await enqueueRequest(timeoutMs, excludeEmails, controller.signal);
      if (controller.signal.aborted) {
        if (slot) {
          slot.release();
          slot = null;
        }
        dispatchQueued();
        break;
      }

      try {
        const qwenMessages = buildQwenMessages([{ role: 'user', content: prompt }], baseModel, chatMode, Math.floor(Date.now() / 1000), false, false);

        result = await completion({
          token: slot.token,
          model: baseModel,
          messages: qwenMessages,
          chatMode,
          thinkingEnabled: false,
          searchEnabled: false,
          size: qwenRatio,
        }, controller.signal);
        result.slot = slot;
        break;
      } catch (err) {
        if (controller.signal.aborted) {
          logInfo(`[RETRY IMAGE] Request aborted during attempt ${attempt}, skipping retry...`);
          break;
        }
        const failedEmail = slot.account?.email || 'unknown';
        reportTokenError(slot.token);
        slot.release();
        dispatchQueued();
        excludeEmails.push(failedEmail);
        slot = null;
        lastError = err;
        logWarn(`[RETRY IMAGE] Attempt ${attempt} failed: ${err.message}. Trying next account...`);
      }
    } catch (err) {
      lastError = err;
      logWarn(`[RETRY IMAGE] Queue acquisition failed: ${err.message}`);
      break;
    }
  }

  if (!result) {
    const duration = Date.now() - startTime;
    recordLog({ model: finalModel, duration, status: 'failed', account: excludeEmails.join(' -> ') || 'unknown', tokens: 0 });
    return res.status(502).json({ error: { message: `All account routing attempts failed. Last error: ${lastError?.message}` } });
  }

  const { body: streamBody } = result;

  try {
    const urls = [];
    for await (const event of parseSSEStream(streamBody)) {
      if (event.type === 'image' && event.content) {
        const cleanedUrl = event.content.trim();
        if (cleanedUrl && /^https?:\/\//i.test(cleanedUrl)) {
          urls.push(cleanedUrl);
        }
      }
    }

    const uniqueUrls = Array.from(new Set(urls));
    if (uniqueUrls.length === 0) {
      throw new Error('Upstream did not return any valid image URLs.');
    }

    const selectedUrls = uniqueUrls.slice(0, n);
    const created = Math.floor(Date.now() / 1000);

    if (responseFormat === 'url') {
      res.json({
        created,
        data: selectedUrls.map(u => ({ url: u })),
      });
    } else {
      // b64_json format
      const b64List = [];
      for (const u of selectedUrls) {
        b64List.push(await fetchImageAsBase64(u));
      }
      res.json({
        created,
        data: b64List.map(b64 => ({ b64_json: b64 })),
      });
    }

    const duration = Date.now() - startTime;
    recordLog({ model: finalModel, duration, status: 'success', account: slot.account?.email, tokens: 0 });
  } catch (err) {
    logError(`Image generation failed: ${err.message}`);
    const duration = Date.now() - startTime;
    recordLog({ model: finalModel, duration, status: 'failed', account: slot.account?.email, tokens: 0 });
    res.status(500).json({ error: { message: err.message, type: 'api_error' } });
  } finally {
    if (slot) {
      slot.release();
    }
    dispatchQueued();
  }
}
