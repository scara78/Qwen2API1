import { chatHeaders } from './headers.js';
import { reportTokenError, reportTokenSuccess } from './auth.js';

const BASE_URL = 'https://chat.qwen.ai';

export async function createChat(token, model, chatMode = 't2t') {
  const res = await fetch(`${BASE_URL}/api/v2/chats/new`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json',
      'source': 'web',
      'version': '0.2.57',
      'bx-v': '2.5.36',
      'origin': 'https://chat.qwen.ai',
      'referer': 'https://chat.qwen.ai/c/new-chat',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({
      title: '新建对话',
      models: [model],
      chat_mode: chatMode,
      chat_type: chatMode,
      timestamp: Date.now(),
      project_id: '',
    }),
  });
  const json = await res.json();
  const chatId = json.data?.id;
  if (!chatId) throw new Error(`Failed to create chat: ${JSON.stringify(json)}`);
  return chatId;
}

export async function completion({ token, model, messages, chatMode = 't2t', thinkingEnabled = true, searchEnabled = true, size }, signal) {
  const chatId = await createChat(token, model, chatMode);
  const timestamp = Math.floor(Date.now() / 1000);

  const isSpecialMode = chatMode !== 't2t';
  const isImageMode = chatMode === 't2i';
  const isVideoMode = chatMode === 't2v';
  const isDeepResearch = chatMode === 'deep_research';

  const featureConfig = {
    thinking_enabled: isImageMode || isVideoMode ? false : thinkingEnabled,
    output_schema: 'phase',
    research_mode: isDeepResearch ? 'deep' : 'normal',
    auto_thinking: isImageMode || isVideoMode ? false : thinkingEnabled,
    thinking_mode: (isImageMode || isVideoMode || !thinkingEnabled) ? 'Disabled' : 'Auto',
    thinking_format: 'summary',
    auto_search: isImageMode || isVideoMode ? false : searchEnabled,
  };

  const body = {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: chatId,
    chat_mode: chatMode,
    model,
    parent_id: null,
    messages: messages.map(msg => ({
      fid: msg.fid || crypto.randomUUID(),
      parentId: msg.parentId !== undefined ? msg.parentId : null,
      childrenIds: msg.childrenIds || [crypto.randomUUID()],
      role: msg.role,
      content: msg.content,
      user_action: msg.user_action || 'chat',
      files: msg.files || [],
      timestamp: msg.timestamp || timestamp,
      models: msg.models || [model],
      chat_type: msg.chat_type || chatMode,
      feature_config: msg.feature_config || featureConfig,
      extra: msg.extra || { meta: { subChatType: chatMode } },
      sub_chat_type: msg.sub_chat_type || chatMode,
      parent_id: msg.parent_id !== undefined ? msg.parent_id : null,
    })),
    timestamp,
    ...(size ? { size } : {}),
  };

  // Combine the caller's abort signal with a 120-second hard timeout so that
  // Qwen's extended thinking phases (common when tool results are in context)
  // cannot block the response indefinitely.
  const timeoutSignal = AbortSignal.timeout(120_000);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  const res = await fetch(`${BASE_URL}/api/v2/chat/completions?chat_id=${chatId}`, {
    method: 'POST',
    headers: chatHeaders(token, chatId),
    body: JSON.stringify(body),
    signal: combinedSignal,
  });

  if (!res.ok) {
    reportTokenError(token);
    const text = await res.text();
    throw new Error(`Completion failed: ${res.status} ${text}`);
  }

  // Qwen sometimes returns a JSON error with HTTP 200 (e.g. model not found).
  // Detect this by checking Content-Type — real SSE is text/event-stream.
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream') && !contentType.includes('application/octet-stream')) {
    reportTokenError(token);
    const text = await res.text();
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j.data?.details || j.data?.code || j.message || text;
    } catch {}
    throw new Error(`Qwen API error (non-SSE 200): ${detail}`);
  }

  reportTokenSuccess(token);
  return { body: res.body };
}

export async function* parseSSEStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastPhaseStatus = '';
  let nativeFnName = '';
  let nativeFnArgs = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data) continue;

        try {
          const parsed = JSON.parse(data);
          if (parsed['response.created'] || parsed['response.info']) continue;

          // Always yield usage if present before processing choices to prevent
          // usage data from being dropped by a 'continue' statement.
          if (parsed.usage) {
            yield { type: 'usage_update', usage: parsed.usage };
          }

          if (parsed.choices) {
            for (const choice of parsed.choices) {
              const delta = choice.delta;
              if (!delta) continue;

              const phase = delta.phase;
              const status = delta.status;
              const content = delta.content || '';
              const usage = parsed.usage;

              // Deduplicate: skip same phase+status combo
              const key = `${phase}:${status}`;
              if (key === lastPhaseStatus && status === 'typing' && !content) continue;
              lastPhaseStatus = key;

              if (status === 'finished' && phase === 'answer') {
                yield { type: 'done', usage };
                return;
              }

              // Image generation: content is the CDN URL
              if (phase === 'image_gen') {
                if (status === 'finished') continue;
                if (content) {
                  yield { type: 'image', content, usage };
                }
                continue;
              }

              // Deep research phases
              const researchPhases = ['ResearchNotice', 'ResearchPlanning', 'ResearchSearching', 'ResearchReading', 'Writing'];
              if (researchPhases.includes(phase)) {
                if (status === 'finished' && !content) continue;
                const extra = delta.extra || {};
                const drInfo = extra.deep_research || {};
                const stage = drInfo.stage || phase;
                if (content) {
                  yield { type: 'research', content, stage, usage };
                }
                continue;
              }

              // Thinking summary
              if (phase === 'thinking_summary') {
                if (status === 'finished') continue;
                const extra = delta.extra || {};
                const summaryTitle = extra.summary_title?.content?.join('') || '';
                const summaryThought = extra.summary_thought?.content?.join('') || '';
                const thinkingContent = summaryThought || summaryTitle || content;
                if (thinkingContent) {
                  yield { type: 'thinking', content: thinkingContent, usage };
                }
                continue;
              }

              // Native function call (used by thinking models).
              // Qwen streams arguments incrementally in delta.function_call,
              // then sends a role:"function" event when it tries to execute.
              // We intercept here and yield before Qwen's fallback kicks in.
              if (delta.function_call) {
                nativeFnName = delta.function_call.name || nativeFnName;
                // arguments are the full accumulated string each chunk
                if (delta.function_call.arguments !== undefined) {
                  nativeFnArgs = delta.function_call.arguments;
                }
              }

              // role:"function" means Qwen finished streaming the call and
              // tried to execute it (it will fail for custom tools). Yield now.
              if (delta.role === 'function' && nativeFnName) {
                yield { type: 'function_call', name: nativeFnName, arguments: nativeFnArgs, usage };
                return; // stop reading — ignore Qwen's internal fallback
              }

              // Regular answer
              if (phase === 'answer' && content) {
                yield { type: 'content', content, usage };
              }
            }
          }
        } catch {
          // skip unparseable lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
