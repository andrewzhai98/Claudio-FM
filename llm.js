const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 120000);
const DEFAULT_PROVIDER = process.env.LLM_PROVIDER || 'deepseek';
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const DEEPSEEK_REASONING_EFFORT = process.env.DEEPSEEK_REASONING_EFFORT || '';
const DEEPSEEK_THINKING = process.env.DEEPSEEK_THINKING || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash-latest';
const QWEN_BASE_URL = process.env.QWEN_BASE_URL || 'https://bailian.aliyuncs.com/compatible-mode/v1';
const QWEN_MODEL = process.env.QWEN_MODEL || 'qwen-turbo';
const GROQ_BASE_URL = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// ── Helpers ──────────────────────────────────────────────────────────────────
function isQuotaError(err) {
  const msg = (err?.message || String(err)).toLowerCase();
  return msg.includes('429') || msg.includes('quota') || msg.includes('too many requests') || msg.includes('rate limit');
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function loadOpenAI() {
  try {
    const mod = await import('openai');
    return mod.default || mod.OpenAI || mod;
  } catch {
    throw new Error('OpenAI SDK not installed. Run `npm install openai`.');
  }
}

// ── Raw text providers (return string, no parsing) ──────────────────────────
async function geminiText(prompt, options = {}) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const modelName = options.model || process.env.GEMINI_MODEL || GEMINI_MODEL;
  const model = genAI.getGenerativeModel({ model: modelName });
  const startAt = Date.now();
  console.log(`[LLM:gemini] model ${modelName}, prompt ${prompt.length} chars...`);
  const result = await withTimeout(
    model.generateContent(['You are Claudio FM. Return strict JSON only.\n\n' + prompt]),
    options.timeoutMs || DEFAULT_TIMEOUT_MS,
    `Gemini timed out after ${Math.round((options.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)}s`
  );
  const elapsed = ((Date.now() - startAt) / 1000).toFixed(1);
  const raw = result.response.text().trim() || '';
  console.log(`[LLM:gemini] response (${elapsed}s) ${raw.length} chars`);
  if (!raw) console.warn('[LLM:gemini] empty response');
  return raw;
}

async function groqText(prompt, options = {}) {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');
  const OpenAI = await loadOpenAI();
  const client = new OpenAI({ baseURL: GROQ_BASE_URL, apiKey: process.env.GROQ_API_KEY });
  const model = options.model || process.env.GROQ_MODEL || GROQ_MODEL;
  const startAt = Date.now();
  console.log(`[LLM:groq] model ${model}, prompt ${prompt.length} chars...`);
  const completion = await withTimeout(
    client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: 'You are Claudio FM. Return strict JSON only.' },
        { role: 'user', content: prompt },
      ],
      stream: false,
    }),
    options.timeoutMs || DEFAULT_TIMEOUT_MS,
    `Groq timed out after ${Math.round((options.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)}s`
  );
  const elapsed = ((Date.now() - startAt) / 1000).toFixed(1);
  const raw = completion.choices?.[0]?.message?.content?.trim() || '';
  console.log(`[LLM:groq] response (${elapsed}s) ${raw.length} chars`);
  if (!raw) console.warn('[LLM:groq] empty response');
  return raw;
}

async function deepseekText(prompt, options = {}) {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY not set');
  const OpenAI = await loadOpenAI();
  const client = new OpenAI({
    baseURL: process.env.DEEPSEEK_BASE_URL || DEEPSEEK_BASE_URL,
    apiKey: process.env.DEEPSEEK_API_KEY,
  });
  const model = options.model || process.env.DEEPSEEK_MODEL || DEEPSEEK_MODEL;
  const startAt = Date.now();
  console.log(`[LLM:deepseek] model ${model}, prompt ${prompt.length} chars...`);
  const request = {
    model,
    messages: [
      { role: 'system', content: 'You are Claudio FM. Return strict JSON only.' },
      { role: 'user', content: prompt },
    ],
    stream: false,
  };
  if (DEEPSEEK_THINKING) request.thinking = { type: DEEPSEEK_THINKING };
  if (DEEPSEEK_REASONING_EFFORT) request.reasoning_effort = DEEPSEEK_REASONING_EFFORT;
  const completion = await withTimeout(
    client.chat.completions.create(request),
    options.timeoutMs || DEFAULT_TIMEOUT_MS,
    `DeepSeek timed out after ${Math.round((options.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)}s`
  );
  const elapsed = ((Date.now() - startAt) / 1000).toFixed(1);
  const raw = completion.choices?.[0]?.message?.content?.trim() || '';
  console.log(`[LLM:deepseek] response (${elapsed}s) ${raw.length} chars`);
  if (!raw) console.warn('[LLM:deepseek] empty response');
  return raw;
}

async function qwenText(prompt, options = {}) {
  if (!process.env.QWEN_API_KEY) throw new Error('QWEN_API_KEY not set');
  const OpenAI = await loadOpenAI();
  const client = new OpenAI({
    baseURL: process.env.QWEN_BASE_URL || QWEN_BASE_URL,
    apiKey: process.env.QWEN_API_KEY,
  });
  const model = options.model || process.env.QWEN_MODEL || QWEN_MODEL;
  const startAt = Date.now();
  console.log(`[LLM:qwen] model ${model}, prompt ${prompt.length} chars...`);
  const completion = await withTimeout(
    client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: 'You are Claudio FM. Return strict JSON only.' },
        { role: 'user', content: prompt },
      ],
      stream: false,
    }),
    options.timeoutMs || DEFAULT_TIMEOUT_MS,
    `Qwen timed out after ${Math.round((options.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)}s`
  );
  const elapsed = ((Date.now() - startAt) / 1000).toFixed(1);
  const raw = completion.choices?.[0]?.message?.content?.trim() || '';
  console.log(`[LLM:qwen] response (${elapsed}s) ${raw.length} chars`);
  if (!raw) console.warn('[LLM:qwen] empty response');
  return raw;
}

function claudeCliText(prompt, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const startAt = Date.now();
  console.log(`[LLM:claude_cli] prompt ${prompt.length} chars...`);
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', prompt], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Claude subprocess timed out'));
    }, timeoutMs);
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); process.stderr.write(d); });
    proc.on('close', () => {
      clearTimeout(timer);
      const elapsed = ((Date.now() - startAt) / 1000).toFixed(1);
      const raw = stdout.trim();
      console.log(`[LLM:claude_cli] response (${elapsed}s) ${raw.length} chars`);
      if (!raw) console.warn('[LLM:claude_cli] empty response');
      resolve(raw);
    });
    proc.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── generateRaw: returns raw text, with Groq fallback for Gemini ────────────
async function generateRaw(prompt, options = {}) {
  const provider = options.provider || DEFAULT_PROVIDER;

  if (provider === 'gemini') {
    try {
      return await geminiText(prompt, options);
    } catch (err) {
      if (isQuotaError(err) && process.env.GROQ_API_KEY) {
        console.warn('[LLM:gemini] 429 quota exceeded, falling back to Groq...');
        return await groqText(prompt, options);
      }
      throw err;
    }
  }
  if (provider === 'groq') return groqText(prompt, options);
  if (provider === 'deepseek') return deepseekText(prompt, options);
  if (provider === 'qwen') return qwenText(prompt, options);
  if (provider === 'claude_cli') return claudeCliText(prompt, options);
  throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
}

// ── generateJson: returns parsed JSON (backward compat) ─────────────────────
async function generateJson(prompt, options = {}) {
  let raw;
  try {
    raw = await generateRaw(prompt, options);
  } catch (err) {
    // Final fallback: if all providers fail with quota error, return empty
    if (isQuotaError(err)) {
      console.error('[LLM] All providers exhausted (quota). Returning fallback.');
      return {
        title: '', say: '', play: [], segments: [], intros: [],
        reason: 'quota_exceeded', mode: '',
      };
    }
    throw err;
  }
  const parsed = parseResponse(raw);
  logParsedResponse(parsed, raw);
  return parsed;
}

// ── Parsing ─────────────────────────────────────────────────────────────────
function parseResponse(raw) {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        title: parsed.title || '',
        say: parsed.say || '',
        play: Array.isArray(parsed.play) ? parsed.play : [],
        segments: Array.isArray(parsed.segments) ? parsed.segments : [],
        intros: Array.isArray(parsed.intros) ? parsed.intros : [],
        reason: parsed.reason || '',
        mode: parsed.mode || '',
      };
    } catch {}
  }
  return { title: '', say: raw || 'Okay.', play: [], segments: [], intros: [], reason: '', segue: '', mode: '' };
}

function logParsedResponse(parsed, raw) {
  const firstSegment = parsed.segments?.find(s => s?.text)?.text || parsed.say || '';
  const preview = firstSegment.slice(0, 60);
  console.log(`[LLM] parsed -> "${parsed.title || 'untitled'}" | ${parsed.play?.length || 0} tracks | ${parsed.segments?.length || 0} segments | "${preview}${preview.length >= 60 ? '...' : ''}"`);
  if (!raw) console.warn('[LLM] warning: empty raw response');
}

module.exports = { generateJson, generateRaw, parseResponse, isQuotaError };
