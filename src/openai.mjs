/**
 * OpenAI Chat Completions <-> Perch model-call translation.
 *
 * Inbound: OpenAI messages/tools are already close to Perch's wire format
 * (verified live: {role, content}, assistant.tool_calls, {role:"tool",tool_call_id},
 * and {type:"function",function:{...}} tool definitions all pass through).
 *
 * Outbound: Perch streams `answer_delta` / `reasoning_delta` / `tool_use_end` /
 * `done`; we re-emit them as OpenAI chat.completion.chunk frames.
 */
import { PERCH_SYSTEM_PREFIX } from './perch-prefix.mjs';
import { config } from './config.mjs';

export function newCompletionId() {
  return `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text ?? '';
        if (part?.type === 'input_text') return part.text ?? '';
        if (part?.type === 'image_url') return '[image omitted: this Perch tier is text-only]';
        return '';
      })
      .join('');
  }
  return '';
}

/**
 * Convert OpenAI messages into Perch messages, prepending the surface-gate
 * system prefix when the request carries (or lacks) a system message.
 */
/**
 * User content: keep image parts in Perch's wire shape instead of flattening them.
 * OBSERVED (2026-10-26, lane=code): `{type:"image_url", image_url:{url}}` with a
 * base64 `data:` URL is accepted and the model reads the image; plain text alone
 * renders as "no image attached". A top-level `images[]` array is ignored.
 */
function userContent(content) {
  if (!Array.isArray(content)) return textFromContent(content);
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text });
      continue;
    }
    const url = part.image_url?.url ?? (typeof part.image_url === 'string' ? part.image_url : null);
    if (part.type === 'image_url' && url) {
      parts.push({ type: 'image_url', image_url: { url } });
      continue;
    }
    // input_image (Responses API) and raw base64 parts
    const inputUrl = part.type === 'input_image' ? (part.image_url ?? part.url ?? null) : null;
    if (inputUrl) {
      parts.push({ type: 'image_url', image_url: { url: inputUrl } });
      continue;
    }
    if (part.type === 'image' && part.data) {
      const mime = part.mimeType || part.mime_type || 'image/png';
      parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${part.data}` } });
    }
  }
  if (!parts.length) return textFromContent(content);
  // Text-only arrays stay strings so the upstream sees the same shape as before.
  if (parts.every((part) => part.type === 'text')) return parts.map((part) => part.text).join(String.fromCharCode(10));
  return parts;
}

export function normalizeMessages(messages, { prefixMode = config.systemPrefix } = {}) {
  const out = [];
  let sawSystem = false;

  for (const message of messages || []) {
    const role = message?.role;
    if (role === 'system' || role === 'developer') {
      sawSystem = true;
      const text = textFromContent(message.content);
      out.push({
        role: 'system',
        content: prefixMode === 'prepend' ? `${PERCH_SYSTEM_PREFIX}\n\n${text}`.trim() : text,
      });
      continue;
    }
    if (role === 'user') {
      out.push({ role: 'user', content: userContent(message.content) });
      continue;
    }
    if (role === 'assistant') {
      const content = textFromContent(message.content);
      const toolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.function?.name, arguments: call.function?.arguments ?? '{}' },
        }))
        : undefined;
      const entry = { role: 'assistant', content };
      if (toolCalls?.length) entry.tool_calls = toolCalls;
      out.push(entry);
      continue;
    }
    if (role === 'tool' || role === 'function') {
      out.push({
        role: 'tool',
        tool_call_id: message.tool_call_id ?? message.name ?? 'call_0',
        content: textFromContent(message.content),
      });
      continue;
    }
    // Unknown role: fold into a user turn rather than dropping the text.
    const text = textFromContent(message?.content);
    if (text) out.push({ role: 'user', content: text });
  }

  if (!sawSystem && prefixMode === 'prepend' && out.length) {
    // No caller system prompt: pair the gate prefix with a neutral instruction so
    // the model does not fall back to the Perch persona in the prefix. Perch only
    // enforces Saffron itself on the chat/worker lanes; config.lane defaults to
    // 'code', where the caller's instruction wins.
    out.unshift({ role: 'system', content: `${PERCH_SYSTEM_PREFIX}

${config.neutralSystem}` });
  }
  return out;
}

function normalizeTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  return tools
    .filter((tool) => tool?.type === 'function' && tool.function?.name)
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.function.name,
        description: tool.function.description ?? '',
        parameters: tool.function.parameters ?? { type: 'object', properties: {} },
      },
    }));
}

function normalizeToolCalls(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((call, index) => {
      const name = call?.function?.name ?? call?.name;
      if (!name) return null;
      const args = call?.function?.arguments ?? call?.arguments;
      return {
        index,
        id: call?.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function',
        function: {
          name,
          arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        },
      };
    })
    .filter(Boolean);
}

function mapFinishReason(reason, hasToolCalls) {
  if (hasToolCalls) return 'tool_calls';
  switch (reason) {
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'tool_calls':
    case 'tool_use':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

export function toOpenAIUsage(usage) {
  if (!usage) return null;
  const prompt = (usage.inputTokens ?? 0);
  const completion = (usage.outputTokens ?? 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage.totalTokens ?? prompt + completion,
    ...(usage.cacheReadInputTokens
      ? { prompt_tokens_details: { cached_tokens: usage.cacheReadInputTokens } }
      : {}),
  };
}

/**
 * Stream a Perch model call to an HTTP response in OpenAI SSE format.
 * Writes to `res` directly; returns the terminal Perch `done` frame.
 */
export async function pipeAsOpenAIStream({ res, id, created, modelName, call, includeUsage = false }) {
  const state = { sentAny: false, toolCalls: [], textLength: 0 };

  const write = (payload) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const chunk = (delta, finishReason = null) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model: modelName,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
  });

  write(chunk({ role: 'assistant', content: '' }));

  const done = await call({
    onEvent: (event) => {
      switch (event.type) {
        case 'answer_delta':
          if (typeof event.text === 'string' && event.text.length) {
            state.sentAny = true;
            state.textLength += event.text.length;
            write(chunk({ content: event.text }));
          }
          break;
        case 'reasoning_delta':
          if (config.exposeReasoning && typeof event.text === 'string' && event.text.length) {
            write(chunk({ reasoning_content: event.text }));
          }
          break;
        case 'tool_use_end':
        case 'tool_call_delta': {
          const calls = normalizeToolCalls(event.toolCalls);
          if (calls.length) state.toolCalls = calls;
          break;
        }
        case 'stream_restart':
          state.textLength = 0;
          state.toolCalls = [];
          break;
        case 'model_call_failed':
          // Transient provider failover upstream; surface as a non-fatal note only.
          break;
        default:
          break;
      }
    },
  });

  const toolCalls = state.toolCalls.length ? state.toolCalls : normalizeToolCalls(done.toolCalls);
  if (toolCalls.length) {
    write(chunk({ tool_calls: toolCalls }));
  }

  const finish = mapFinishReason(done.finishReason, toolCalls.length > 0);
  write(chunk({}, finish));

  if (includeUsage) {
    write({
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelName,
      choices: [],
      usage: toOpenAIUsage(done.usage),
    });
  }

  if (!res.writableEnded) {
    res.write('data: [DONE]\n\n');
    res.end();
  }
  return done;
}

/** Aggregate a Perch model call into a single OpenAI chat.completion object. */
export async function collectCompletion({ id, created, modelName, expectedModelId = null, call }) {
  let text = '';
  let reasoning = '';
  let toolCalls = [];

  const done = await call({
    onEvent: (event) => {
      switch (event.type) {
        case 'answer_delta':
          if (typeof event.text === 'string') text += event.text;
          break;
        case 'reasoning_delta':
          if (config.exposeReasoning && typeof event.text === 'string') reasoning += event.text;
          break;
        case 'tool_use_end':
        case 'tool_call_delta': {
          const calls = normalizeToolCalls(event.toolCalls);
          if (calls.length) toolCalls = calls;
          break;
        }
        case 'stream_restart':
          text = '';
          reasoning = '';
          toolCalls = [];
          break;
        default:
          break;
      }
    },
  });

  if (!toolCalls.length) toolCalls = normalizeToolCalls(done.toolCalls);
  const finalText = typeof done.text === 'string' && done.text.length ? done.text : text;
  const message = { role: 'assistant', content: finalText || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map(({ index, ...call }) => call);
  }

  return {
    id,
    object: 'chat.completion',
    created,
    model: modelName,
    choices: [{
      index: 0,
      message,
      logprobs: null,
      finish_reason: mapFinishReason(done.finishReason, toolCalls.length > 0),
    }],
    usage: toOpenAIUsage(done.usage) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    // Provenance the gateway adds; clients that do not know these keys ignore them.
    perch: {
      model: done.model ?? null,
      provider: done.provider ?? null,
      duration_ms: done.durationMs ?? null,
      context_input_tokens: done.contextInputTokens ?? null,
      // True when the account served a different model than the caller asked
      // for. Perch substitutes silently on plans whose pool cannot serve a pin,
      // so this is the only place a caller can notice it.
      requested: modelName ?? null,
      // Heuristic: a pin's option id embeds the model it addresses
      // (`openrouter-qwen-qwen3-8-max-0902` -> Qwen3.8-Max), so a served model
      // whose name is not contained in the option id means Perch swapped it.
      // Roost tiers resolve server-side by design and are never "substituted".
      substituted: (() => {
        if (!modelName || !done.model || String(modelName).startsWith('perch')) return false;
        const norm = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
        const served = norm(String(done.model).split('/').pop());
        if (!served) return false;
        return !norm(expectedModelId ?? modelName).includes(served)
          && !norm(String(done.model)).includes(norm(modelName));
      })(),
    },
  };
}

export function openAIError(res, status, message, { code = 'perch_error', type = 'invalid_request_error', extra = null } = {}) {
  const body = JSON.stringify({
    error: { message, type, code, param: null, ...(extra ? { perch: extra } : {}) },
  });
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
