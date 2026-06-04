/**
 * Unified LLM client — Ollama · OpenAI · Anthropic · OpenRouter · Custom
 * Config stored in config/llm.yml (user layer, never overwritten by updates).
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import yaml from 'js-yaml';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', '..', 'config', 'llm.yml');

// ── Provider metadata ─────────────────────────────────────────────

export const PROVIDER_MODELS = {
  ollama:     ['qwen3:14b', 'qwen3:8b', 'qwen2.5:14b', 'llama3.2:3b', 'mistral:7b'],
  openai:     ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo'],
  anthropic:  ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-8'],
  openrouter: [
    'google/gemini-flash-1.5',
    'google/gemini-2.5-flash',
    'anthropic/claude-3.5-sonnet',
    'meta-llama/llama-3.3-70b-instruct:free',
    'mistralai/mistral-7b-instruct:free',
  ],
  custom: [],
};

export const PROVIDER_LABELS = {
  ollama:     'Ollama (локальный)',
  openai:     'OpenAI',
  anthropic:  'Anthropic',
  openrouter: 'OpenRouter',
  custom:     'Свой URL',
};

// ── Config I/O ────────────────────────────────────────────────────

export function loadLlmConfig() {
  const env = process.env;
  const rawHost = env.OLLAMA_HOST || 'http://localhost:11434';
  const defaults = {
    provider:    'ollama',
    model:       env.OLLAMA_MODEL || 'qwen3:14b',
    ollama_host: (rawHost.startsWith('http://') || rawHost.startsWith('https://'))
                   ? rawHost.replace(/\/$/, '')
                   : `http://${rawHost.replace(/\/$/, '')}`,
    api_key:     '',
    base_url:    '',
  };
  if (!existsSync(CONFIG_PATH)) return defaults;
  try {
    const saved = yaml.load(readFileSync(CONFIG_PATH, 'utf-8')) || {};
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

export function saveLlmConfig(cfg) {
  const toSave = { ...cfg };
  writeFileSync(CONFIG_PATH, yaml.dump(toSave, { lineWidth: 120 }), 'utf-8');
}

// ── Internal helpers ──────────────────────────────────────────────

function resolveBaseUrl(cfg) {
  switch (cfg.provider) {
    case 'ollama':     return `${(cfg.ollama_host || 'http://localhost:11434').replace(/\/$/, '')}/v1`;
    case 'openai':     return 'https://api.openai.com/v1';
    case 'anthropic':  return 'https://api.anthropic.com';
    case 'openrouter': return 'https://openrouter.ai/api/v1';
    case 'custom':     return (cfg.base_url || '').replace(/\/$/, '');
    default:           return 'http://localhost:11434/v1';
  }
}

function buildHeaders(cfg) {
  const h = { 'Content-Type': 'application/json' };
  if (cfg.provider === 'anthropic') {
    if (cfg.api_key) h['x-api-key'] = cfg.api_key;
    h['anthropic-version'] = '2023-06-01';
  } else if (cfg.api_key) {
    h['Authorization'] = `Bearer ${cfg.api_key}`;
  }
  if (cfg.provider === 'openrouter') {
    h['HTTP-Referer'] = 'https://github.com/career-ops/career-ops';
    h['X-Title']      = 'career-ops';
  }
  return h;
}

// Strip Qwen-specific /no_think directive for providers that don't understand it
function prepareMessages(messages, cfg) {
  const isQwen = cfg.provider === 'ollama' && (cfg.model || '').toLowerCase().includes('qwen');
  if (isQwen) return messages;
  return messages.map(m => ({
    ...m,
    content: typeof m.content === 'string'
      ? m.content.replace(/^\/no_think\n?/m, '')
      : m.content,
  }));
}

// ── Non-streaming chat ────────────────────────────────────────────

export async function chat(messages, options = {}, cfg = null) {
  if (!cfg) cfg = loadLlmConfig();
  const msgs = prepareMessages(messages, cfg);
  const { temperature = 0.3, maxTokens = 4096 } = options;

  if (cfg.provider === 'anthropic') return _chatAnthropic(msgs, { temperature, maxTokens }, cfg);

  const res = await fetch(`${resolveBaseUrl(cfg)}/chat/completions`, {
    method:  'POST',
    headers: buildHeaders(cfg),
    body:    JSON.stringify({ model: cfg.model, messages: msgs, stream: false, temperature, max_tokens: maxTokens }),
    signal:  AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content || '';
}

async function _chatAnthropic(messages, { temperature, maxTokens }, cfg) {
  const sys  = messages.find(m => m.role === 'system');
  const msgs = messages.filter(m => m.role !== 'system');
  const body = { model: cfg.model, max_tokens: maxTokens, messages: msgs };
  if (sys) body.system = sys.content;
  if (temperature != null) body.temperature = temperature;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: buildHeaders(cfg), body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return (await res.json()).content?.[0]?.text || '';
}

// ── Streaming chat ────────────────────────────────────────────────

export async function streamChat(messages, options = {}, onToken, cfg = null) {
  if (!cfg) cfg = loadLlmConfig();
  const msgs = prepareMessages(messages, cfg);
  const { temperature = 0.3, maxTokens = 8192 } = options;

  if (cfg.provider === 'anthropic') return _streamAnthropic(msgs, { temperature, maxTokens }, onToken, cfg);

  const res = await fetch(`${resolveBaseUrl(cfg)}/chat/completions`, {
    method:  'POST',
    headers: buildHeaders(cfg),
    body:    JSON.stringify({ model: cfg.model, messages: msgs, stream: true, temperature, max_tokens: maxTokens }),
    signal:  AbortSignal.timeout(300000),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);

  const reader = res.body.getReader(), decoder = new TextDecoder();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value).split('\n')) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      try {
        const token = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || '';
        if (token) { result += token; onToken(token); }
      } catch {}
    }
  }
  return result;
}

async function _streamAnthropic(messages, { temperature, maxTokens }, onToken, cfg) {
  const sys  = messages.find(m => m.role === 'system');
  const msgs = messages.filter(m => m.role !== 'system');
  const body = { model: cfg.model, max_tokens: maxTokens, messages: msgs, stream: true };
  if (sys) body.system = sys.content;
  if (temperature != null) body.temperature = temperature;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: buildHeaders(cfg), body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);

  const reader = res.body.getReader(), decoder = new TextDecoder();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value).split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const evt = JSON.parse(line.slice(6));
        if (evt.type === 'content_block_delta') {
          const token = evt.delta?.text || '';
          if (token) { result += token; onToken(token); }
        }
      } catch {}
    }
  }
  return result;
}

// ── Connection test ───────────────────────────────────────────────

export async function testConnection(cfg) {
  try {
    const text = await chat([{ role: 'user', content: 'Reply with exactly: OK' }], { temperature: 0, maxTokens: 10 }, cfg);
    return { ok: true, response: text.trim().slice(0, 80) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
