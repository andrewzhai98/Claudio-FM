const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { spawn, exec } = require('child_process');

const CACHE_DIR = path.join(__dirname, 'cache/tts');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const VOLCENGINE_DEFAULT_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';

function md5(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

function cachePath(text, provider = process.env.TTS_PROVIDER || 'volcengine', options = {}) {
  const voice = getVoiceForProvider(provider, options);
  const role = options.role || 'station';
  const ext = provider === 'mac' ? 'm4a' : 'mp3';
  return path.join(CACHE_DIR, `${md5(`${role}:${provider}:${voice}:${text}`)}.${ext}`);
}

function synthesize(text, options = {}) {
  const provider = options.provider || process.env.TTS_PROVIDER || 'volcengine';
  const cached = cachePath(text, provider, options);
  if (fs.existsSync(cached)) {
    console.log(`[TTS] 缓存命中 → ${path.basename(cached)}`);
    return Promise.resolve(cached);
  }

  const preview = text.slice(0, 40) + (text.length > 40 ? '…' : '');
  console.log(`[TTS] 合成中 (${provider}${options.role ? `/${options.role}` : ''})："${preview}"`);
  const startAt = Date.now();

  let promise;
  if (provider === 'volcengine') {
    promise = synthesizeVolcengine(text, cached, options);
  } else if (provider === 'fish') {
    promise = synthesizeFish(text, cached, options);
  } else if (provider === 'mac') {
    promise = synthesizeMac(text, cached, options);
  } else if (provider === 'edge') {
    promise = synthesizeEdge(text, cached, options);
  } else {
    promise = synthesizeKokoro(text, cached, options);
  }

  return promise.then(p => {
    console.log(`[TTS] 完成 (${((Date.now() - startAt) / 1000).toFixed(1)}s) → ${path.basename(p)}`);
    return p;
  });
}

function getVoiceForProvider(provider, options = {}) {
  if (provider === 'fish') return options.voiceId || process.env.FISH_VOICE_ID || '';
  if (provider === 'volcengine') return options.voiceType || process.env.VOLCENGINE_TTS_VOICE_TYPE || '';
  return options.voice || process.env.KOKORO_VOICE || '';
}

function buildVolcenginePayload(text, options = {}) {
  const voiceType = options.voiceType || process.env.VOLCENGINE_TTS_VOICE_TYPE;
  if (!voiceType) {
    throw new Error('VOLCENGINE_TTS_VOICE_TYPE not set');
  }

  return {
    req_params: {
      text,
      speaker: voiceType,
      additions: options.additions || process.env.VOLCENGINE_TTS_ADDITIONS || JSON.stringify({
        disable_markdown_filter: true,
        enable_language_detector: true,
        enable_latex_tn: true,
        disable_default_bit_rate: true,
        max_length_to_filter_parenthesis: 0,
        cache_config: {
          text_type: 1,
          use_cache: true,
        },
      }),
      audio_params: {
        format: options.format || process.env.VOLCENGINE_TTS_FORMAT || 'mp3',
        sample_rate: Number(options.sampleRate || process.env.VOLCENGINE_TTS_SAMPLE_RATE || 24000),
      },
    },
  };
}

function extractJsonObjects(text) {
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  const rest = depth > 0 && start !== -1 ? text.slice(start) : '';
  return { objects, rest };
}

async function synthesizeVolcengine(text, outPath, options = {}) {
  const apiKey = options.apiKey || process.env.VOLCENGINE_TTS_API_KEY;

  if (!apiKey) {
    throw new Error('VOLCENGINE_TTS_API_KEY not set');
  }

  const resourceId = options.resourceId || process.env.VOLCENGINE_TTS_RESOURCE_ID;
  const endpoint = options.endpoint || process.env.VOLCENGINE_TTS_ENDPOINT || VOLCENGINE_DEFAULT_ENDPOINT;
  const headers = {
    'Content-Type': 'application/json',
    'X-Api-Key': apiKey,
    'X-Api-Request-Id': crypto.randomUUID(),
    'Connection': 'keep-alive',
  };
  if (resourceId) {
    headers['X-Api-Resource-Id'] = resourceId;
  }
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildVolcenginePayload(text, options)),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Volcengine TTS error ${res.status}: ${err}`);
  }

  const audioChunks = [];
  let buffer = '';
  const decoder = new TextDecoder();

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const parsed = extractJsonObjects(buffer);
    buffer = parsed.rest;

    for (const raw of parsed.objects) {
      const msg = JSON.parse(raw);
      if (msg.code && msg.code !== 20000000) {
        throw new Error(`Volcengine TTS response error ${msg.code}: ${msg.message || ''}`);
      }
      if (msg.data) {
        audioChunks.push(Buffer.from(msg.data, 'base64'));
      }
    }
  }

  buffer += decoder.decode();
  const parsed = extractJsonObjects(buffer);
  for (const raw of parsed.objects) {
    const msg = JSON.parse(raw);
    if (msg.code && msg.code !== 20000000) {
      throw new Error(`Volcengine TTS response error ${msg.code}: ${msg.message || ''}`);
    }
    if (msg.data) {
      audioChunks.push(Buffer.from(msg.data, 'base64'));
    }
  }

  if (!audioChunks.length) {
    throw new Error('Volcengine TTS returned no audio data');
  }

  fs.writeFileSync(outPath, Buffer.concat(audioChunks));
  return outPath;
}

function synthesizeFish(text, outPath, options = {}) {
  const apiKey = options.apiKey || process.env.FISH_API_KEY;
  const voiceId = options.voiceId || process.env.FISH_VOICE_ID;

  if (!apiKey || !voiceId) {
    return Promise.reject(new Error('FISH_API_KEY or FISH_VOICE_ID not set'));
  }

  const body = JSON.stringify({
    text,
    reference_id: voiceId,
    format: 'mp3',
    mp3_bitrate: 128,
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.fish.audio',
      path: '/v1/tts',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      if (res.statusCode !== 200) {
        let err = '';
        res.on('data', d => { err += d; });
        res.on('end', () => reject(new Error(`Fish Audio TTS error ${res.statusCode}: ${err}`)));
        return;
      }
      const out = fs.createWriteStream(outPath);
      res.pipe(out);
      out.on('finish', () => resolve(outPath));
      out.on('error', reject);
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function synthesizeKokoro(text, outPath, options = {}) {
  const baseUrl = (options.baseUrl || process.env.KOKORO_API_BASE || 'http://127.0.0.1:8880').replace(/\/+$/, '');
  const voice = options.voice || process.env.KOKORO_VOICE || 'zf_xiaoxiao';
  const model = options.model || process.env.KOKORO_MODEL || 'kokoro';

  const res = await fetch(`${baseUrl}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      voice,
      input: text,
      response_format: 'mp3',
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Kokoro TTS error ${res.status}: ${err}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

module.exports = { synthesize, cachePath };

function getEdgeVoice(role, options = {}) {
  if (role === 'caller' || options.role === 'caller') {
    return options.voice || process.env.EDGE_CALLER_VOICE || 'zh-CN-YunxiNeural';
  }
  return options.voice || process.env.EDGE_DJ_VOICE || 'en-US-AndrewMultilingualNeural';
}

async function synthesizeEdge(text, outPath, options = {}) {
  const voice = getEdgeVoice(options.role, options);
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [
      '-m', 'edge_tts',
      '--text', text,
      '--voice', voice,
      '--write-media', outPath,
    ]);
    let stderr = '';
    proc.stderr?.on('data', d => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`edge-tts exited with code ${code}: ${stderr}`));
      resolve(outPath);
    });
    proc.on('error', reject);
  });
}

function getMacVoice(role, options = {}) {
  if (role === 'caller' || options.role === 'caller') {
    return options.voiceType || process.env.MAC_CALLER_VOICE || 'Ting-Ting';
  }
  return options.voiceType || process.env.MAC_DJ_VOICE || 'Samantha';
}

async function synthesizeMac(text, outPath, options = {}) {
  const voice = getMacVoice(options.role, options);
  const tmpAiff = outPath + '.aiff';

  return new Promise((resolve, reject) => {
    const proc = spawn('/usr/bin/say', ['-v', voice, '-o', tmpAiff, text]);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`mac say exited with code ${code}`));
      // Use afconvert (built into macOS) to convert aiff to m4a (AAC)
      exec(`afconvert -f m4af -d aac "${tmpAiff}" "${outPath}"`, (err) => {
        try { fs.unlinkSync(tmpAiff); } catch (e) {}
        if (err) return reject(new Error('afconvert failed: ' + err.message));
        resolve(outPath);
      });
    });
    proc.on('error', reject);
  });
}
