require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');

const { route } = require('./router');
const { buildPrompt, buildProgramStartPrompt, buildColdOpenForTracksPrompt, buildMusicRefillPrompt, buildBridgePrompt } = require('./context');
const { callClaude } = require('./claude');
const { synthesize } = require('./tts');
const { getTrack } = require('./music');
const { addPlay, addMessage, recentPlays, getPref } = require('./state');
const { batchManager } = require('./batch');
const scheduler = require('./scheduler');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/stream' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'pwa')));

// ── WebSocket broadcast ──────────────────────────────────────────────────────
const clients = new Set();

wss.on('connection', ws => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// ── Current playback state ───────────────────────────────────────────────────
let nowPlaying = null;

// 音频流代理：存储 trackId → 实际 streamUrl 的映射
const streamProxyMap = new Map();
function registerStreamProxy(tracks) {
  for (const t of tracks) {
    if (t.streamUrl && t.streamUrl.includes('googlevideo.com')) {
      const id = Math.random().toString(36).slice(2, 10);
      streamProxyMap.set(id, t.streamUrl);
      t.streamUrl = `/api/stream/${id}`;
    }
  }
}

const STATION_NAME = 'Claudio FM';
const PROGRAM_NAME = 'Evening Drive';
const REFILL_TRACK_COUNT = 3;
const PROGRAM_START_ID_TEXT = 'This is Claudio.';
const TRACK_REPEAT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const ARTIST_RECENT_WINDOW = 5;
const MAX_TTS_TEXT_LENGTH = 200;  // 防止 TTS 截断的最大文本长度（中文字符）

const stationState = {
  programId: null,
  sessionTitle: '',
  tracks: [],
  generationJobs: [],
  jobKeys: new Set(),
  workerRunning: false,
};

function normalizeDjLanguage(value) {
  return value === 'zh' ? 'zh' : 'en';
}

function buildAnnouncement(result, tracks, failedTracks, speechOnly) {
  const firstSegmentText = result.segments?.find(s => s?.text)?.text;
  if (firstSegmentText) return firstSegmentText.trim();
  if (result.say) return result.say.trim();
  if (!speechOnly && !tracks.length && failedTracks.length) {
    return "I couldn't get a clean playable link for that set, so I'm keeping the current signal alive.";
  }
  return '';
}

function programStartIdSegment(programId) {
  return {
    id: `${programId}_station_id`,
    type: 'cold_open',
    groupId: 'open_0',
    part: 'station_id',
    partIndex: 0,
    position: 'before_track',
    trackIndex: 0,
    text: PROGRAM_START_ID_TEXT,
  };
}

function makeSegmentId(index) {
  return `seg_${Date.now()}_${index}`;
}

function normalizeSegment(raw, index, trackCount) {
  if (!raw || typeof raw !== 'object') return null;
  const allowedTypes = new Set(['cold_open', 'bridge', 'quick_touch', 'back_announce', 'silence']);
  const allowedPositions = new Set(['before_track', 'between_tracks', 'after_track', 'immediate']);
  const type = allowedTypes.has(raw.type) ? raw.type : 'quick_touch';
  const defaultPosition = type === 'bridge' ? 'between_tracks' : type === 'cold_open' ? 'before_track' : 'immediate';
  const position = allowedPositions.has(raw.position) ? raw.position : defaultPosition;
  const segment = {
    id: raw.id || makeSegmentId(index),
    type,
    position,
    text: typeof raw.text === 'string' ? raw.text.trim() : '',
    status: type === 'silence' ? 'silent' : 'pending',
  };

  if (typeof raw.groupId === 'string' && raw.groupId.trim()) segment.groupId = raw.groupId.trim();
  if (typeof raw.part === 'string' && raw.part.trim()) segment.part = raw.part.trim();
  if (Number.isInteger(raw.partIndex)) segment.partIndex = Math.max(0, raw.partIndex);
  if (Number.isInteger(raw.partCount)) segment.partCount = Math.max(1, raw.partCount);

  if (Number.isInteger(raw.trackIndex)) {
    segment.trackIndex = Math.max(0, Math.min(raw.trackIndex, Math.max(0, trackCount - 1)));
  }
  if (Number.isInteger(raw.afterTrackIndex)) {
    segment.afterTrackIndex = Math.max(0, Math.min(raw.afterTrackIndex, Math.max(0, trackCount - 1)));
  }
  if (Number.isInteger(raw.beforeTrackIndex)) {
    segment.beforeTrackIndex = Math.max(0, Math.min(raw.beforeTrackIndex, Math.max(0, trackCount - 1)));
  }

  if (position === 'before_track' && segment.trackIndex === undefined) segment.trackIndex = 0;
  if (position === 'between_tracks') {
    if (segment.afterTrackIndex === undefined) segment.afterTrackIndex = Math.max(0, (segment.beforeTrackIndex ?? index) - 1);
    if (segment.beforeTrackIndex === undefined) segment.beforeTrackIndex = Math.min(trackCount - 1, segment.afterTrackIndex + 1);
  }
  if (!trackCount && ['before_track', 'between_tracks', 'after_track'].includes(position)) {
    segment.position = 'immediate';
    delete segment.trackIndex;
    delete segment.afterTrackIndex;
    delete segment.beforeTrackIndex;
  }
  return segment;
}

function splitSentences(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const pieces = normalized.match(/[^.!?。！？]+[.!?。！？"'’”)\]]*/g);
  return (pieces || [normalized]).map(s => s.trim()).filter(Boolean);
}

function expandColdOpenParts(segments) {
  const defaultParts = ['anchor', 'heart', 'turn', 'image', 'invitation'];
  const expanded = [];

  for (const segment of segments) {
    if (segment.type !== 'cold_open' || !segment.text || segment.part) {
      expanded.push(segment);
      continue;
    }

    const sentences = splitSentences(segment.text);
    if (sentences.length <= 1) {
      expanded.push(segment);
      continue;
    }

    const groupId = segment.groupId || segment.id || makeSegmentId(expanded.length);
    sentences.forEach((text, partIndex) => {
      expanded.push({
        ...segment,
        id: `${groupId}_${partIndex}`,
        groupId,
        part: defaultParts[partIndex] || 'line',
        partIndex,
        partCount: sentences.length,
        text,
      });
    });
  }

  return expanded;
}

function normalizeSegments(result, tracks, speechOnly, failedTracks) {
  const trackCount = tracks.length;
  let segments = Array.isArray(result.segments)
    ? result.segments.map((s, i) => normalizeSegment(s, i, trackCount)).filter(Boolean)
    : [];

  if (!segments.length) {
    if (result.say) {
      segments.push(normalizeSegment({
        type: speechOnly ? 'quick_touch' : 'cold_open',
        position: speechOnly ? 'immediate' : 'before_track',
        trackIndex: 0,
        text: result.say,
      }, 0, trackCount));
    }
    if (!speechOnly && Array.isArray(result.intros)) {
      result.intros.forEach((text, i) => {
        if (i === 0 || !text) return;
        segments.push(normalizeSegment({
          type: 'bridge',
          position: 'between_tracks',
          afterTrackIndex: i - 1,
          beforeTrackIndex: i,
          text,
        }, segments.length, trackCount));
      });
    }
  }

  if (!speechOnly && !trackCount && failedTracks.length && !segments.some(s => s?.text)) {
    segments.push(normalizeSegment({
      type: 'quick_touch',
      position: 'immediate',
      text: "I couldn't get a clean playable link for that set, so I'm keeping the current signal alive.",
    }, segments.length, trackCount));
  }

  return expandColdOpenParts(segments.filter(Boolean)).map((segment, index) => ({
    ...segment,
    id: segment.id || makeSegmentId(index),
  }));
}

async function synthesizeSegments(segments) {
  for (const segment of segments) {
    if (segment.type === 'silence' || !segment.text) {
      segment.status = 'silent';
      continue;
    }
    
    // 检查文本长度，防止 TTS 截断
    if (segment.text.length > MAX_TTS_TEXT_LENGTH) {
      console.warn(`[TTS] 文本过长 (${segment.text.length} 字)，截断到 ${MAX_TTS_TEXT_LENGTH} 字: "${segment.text.slice(0, 50)}..."`);
      segment.text = segment.text.slice(0, MAX_TTS_TEXT_LENGTH) + '…';
    }
    
    try {
      console.log(`[TTS] 合成 ${segment.type} (${segment.text.length} 字): "${segment.text.slice(0, 50)}…"`);
      const f = await synthesize(segment.text);
      segment.ttsUrl = '/api/tts/' + path.basename(f);
      segment.status = 'ready';
      console.log(`[TTS] ${segment.type} 完成 → ${path.basename(f)}`);
    } catch (err) {
      segment.status = 'tts_failed';
      segment.error = err.message;
      console.error(`[TTS] ${segment.type} 合成失败:`, err.message);
    }
  }
  return segments;
}

function applyLegacyTrackIntrosFromSegments(tracks, segments) {
  for (const segment of segments) {
    if (!segment.ttsUrl || !segment.text) continue;
    if (segment.position === 'between_tracks' && Number.isInteger(segment.beforeTrackIndex)) {
      const track = tracks[segment.beforeTrackIndex];
      if (track && !track.introTtsUrl) {
        track.introTtsUrl = segment.ttsUrl;
        track.introTranscript = segment.text;
        track.segmentId = segment.id;
      }
    }
  }
}

function makeProgramId() {
  return `program_${Date.now()}`;
}

function callerTtsOptions() {
  return {
    role: 'caller',
    provider: process.env.CALLER_TTS_PROVIDER || process.env.TTS_PROVIDER || 'volcengine',
    apiKey: process.env.CALLER_TTS_API_KEY || process.env.VOLCENGINE_TTS_API_KEY,
    endpoint: process.env.CALLER_TTS_ENDPOINT || process.env.VOLCENGINE_TTS_ENDPOINT,
    resourceId: process.env.CALLER_TTS_RESOURCE_ID || process.env.VOLCENGINE_TTS_RESOURCE_ID,
    voiceType: process.env.CALLER_TTS_VOICE_TYPE || process.env.VOLCENGINE_TTS_VOICE_TYPE,
    voiceId: process.env.CALLER_FISH_VOICE_ID || process.env.FISH_VOICE_ID,
    voice: process.env.CALLER_KOKORO_VOICE || process.env.KOKORO_VOICE,
    model: process.env.CALLER_KOKORO_MODEL || process.env.KOKORO_MODEL,
    baseUrl: process.env.CALLER_KOKORO_API_BASE || process.env.KOKORO_API_BASE,
    format: process.env.CALLER_TTS_FORMAT || process.env.VOLCENGINE_TTS_FORMAT,
    sampleRate: process.env.CALLER_TTS_SAMPLE_RATE || process.env.VOLCENGINE_TTS_SAMPLE_RATE,
    additions: process.env.CALLER_TTS_ADDITIONS || process.env.VOLCENGINE_TTS_ADDITIONS,
  };
}

function trackLabel(track) {
  if (!track) return '';
  return `${track.title || track.query || ''}${track.artist ? ' — ' + track.artist : ''}`.trim();
}

function normalizeTrackText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trackIdentity(track) {
  const title = normalizeTrackText(track?.title || track?.query || '');
  const artist = normalizeTrackText(track?.artist || '');
  return artist ? `${title}::${artist}` : title;
}

function trackUrlIdentity(track) {
  return String(track?.streamUrl || track?.source_url || '').trim();
}

function parseRequestedTrack(query) {
  const parts = String(query || '').split(/\s+-\s+/);
  return {
    title: parts[0]?.trim() || String(query || '').trim(),
    artist: parts.slice(1).join(' - ').trim(),
  };
}

function trackMatchesRequest(requested, resolved) {
  const requestedTitle = normalizeTrackText(requested.title);
  const requestedArtist = normalizeTrackText(requested.artist);
  const resolvedTitle = normalizeTrackText(resolved.title);
  const resolvedArtist = normalizeTrackText(resolved.artist);
  if (!requestedTitle || !resolvedTitle) return true;

  const titleMatches = requestedTitle === resolvedTitle ||
    requestedTitle.includes(resolvedTitle) ||
    resolvedTitle.includes(requestedTitle);
  const artistMatches = !requestedArtist || !resolvedArtist ||
    requestedArtist === resolvedArtist ||
    requestedArtist.includes(resolvedArtist) ||
    resolvedArtist.includes(requestedArtist);

  return titleMatches && artistMatches;
}

function shouldSkipTrack(track, avoidState) {
  const identity = trackIdentity(track);
  const urlIdentity = trackUrlIdentity(track);
  const artist = normalizeTrackText(track.artist);
  if (!identity) return { skip: false };

  if (avoidState.batchTrackKeys.has(identity) || (urlIdentity && avoidState.batchUrlKeys.has(urlIdentity))) {
    return { skip: true, reason: 'same batch duplicate' };
  }
  if (avoidState.queueTrackKeys.has(identity) || (urlIdentity && avoidState.queueUrlKeys.has(urlIdentity))) {
    return { skip: true, reason: 'already in current queue' };
  }
  if (avoidState.cooldownTrackKeys.has(identity) || (urlIdentity && avoidState.cooldownUrlKeys.has(urlIdentity))) {
    return { skip: true, reason: 'played within 24h' };
  }
  if (artist && avoidState.recentArtistKeys.has(artist)) {
    return { skip: true, reason: `artist appeared in recent ${ARTIST_RECENT_WINDOW}` };
  }
  return { skip: false };
}

function createTrackAvoidState(extraQueue = []) {
  const queueTracks = [
    ...stationState.tracks,
    ...(Array.isArray(extraQueue) ? extraQueue : []),
  ];
  const queueTrackKeys = new Set(queueTracks.map(trackIdentity).filter(Boolean));
  const queueUrlKeys = new Set(queueTracks.map(trackUrlIdentity).filter(Boolean));
  const recent = recentPlays(50);
  const cutoff = Date.now() - TRACK_REPEAT_COOLDOWN_MS;
  const cooldownTracks = recent.filter(track => Number(track.played_at) >= cutoff);
  return {
    batchTrackKeys: new Set(),
    batchUrlKeys: new Set(),
    queueTrackKeys,
    queueUrlKeys,
    cooldownTrackKeys: new Set(cooldownTracks.map(trackIdentity).filter(Boolean)),
    cooldownUrlKeys: new Set(cooldownTracks.map(trackUrlIdentity).filter(Boolean)),
    recentArtistKeys: new Set(recent.slice(0, ARTIST_RECENT_WINDOW).map(track => normalizeTrackText(track.artist)).filter(Boolean)),
  };
}

function normalizeTracksForPrompt(tracks = []) {
  return tracks.map(track => ({
    query: track.query || trackLabel(track),
    title: track.title || track.query || '',
    artist: track.artist || '',
  }));
}

async function resolveRequestedTracks(requestedTracks, options = {}) {
  const tracks = [];
  const failedTracks = [];
  const avoidState = options.skipAvoid ? null : createTrackAvoidState(options.queue || []);
  for (let i = 0; i < requestedTracks.length; i++) {
    const query = requestedTracks[i];
    const track = await getTrack(query);
    if (track?.streamUrl) {
      const requested = parseRequestedTrack(query);
      if (!trackMatchesRequest(requested, track)) {
        failedTracks.push(`${query} (resolved mismatch: ${track.title}${track.artist ? ' — ' + track.artist : ''})`);
        console.log(`[音乐] ↷ ${i + 1}/${requestedTracks.length} 跳过错配: 请求 "${query}"，返回 "${track.title}${track.artist ? ' — ' + track.artist : ''}"`);
        continue;
      }
      const payloadTrack = {
        query,
        title: track.title || requested.title || query,
        artist: track.artist || requested.artist || '',
        streamUrl: track.streamUrl,
      };
      if (avoidState) {
        const skip = shouldSkipTrack(payloadTrack, avoidState);
        if (skip.skip) {
          failedTracks.push(`${query} (${skip.reason})`);
          console.log(`[音乐] ↷ ${i + 1}/${requestedTracks.length} 跳过重复: ${payloadTrack.title}${payloadTrack.artist ? ' — ' + payloadTrack.artist : ''} | ${skip.reason}`);
          continue;
        }
        avoidState.batchTrackKeys.add(trackIdentity(payloadTrack));
        const urlIdentity = trackUrlIdentity(payloadTrack);
        if (urlIdentity) avoidState.batchUrlKeys.add(urlIdentity);
      }
      tracks.push(payloadTrack);
      addPlay({ title: payloadTrack.title, artist: payloadTrack.artist, source_url: payloadTrack.streamUrl });
      console.log(`[音乐] ✓ ${i + 1}/${requestedTracks.length} 找到: ${payloadTrack.title}${payloadTrack.artist ? ' — ' + payloadTrack.artist : ''}`);
    } else {
      failedTracks.push(query);
      console.log(`[音乐] ✗ ${i + 1}/${requestedTracks.length} 未找到: ${query}`);
    }
  }
  registerStreamProxy(tracks);
  return { tracks, failedTracks };
}

function enqueueJob(job) {
  const key = job.key || `${job.type}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  if (stationState.jobKeys.has(key)) {
    console.log(`[jobs] 跳过重复任务 ${key}`);
    return false;
  }
  stationState.jobKeys.add(key);
  stationState.generationJobs.push({ ...job, key });
  console.log(`[jobs] 入队 ${key}`);
  drainJobs();
  return true;
}

async function drainJobs() {
  if (stationState.workerRunning) return;
  stationState.workerRunning = true;
  while (stationState.generationJobs.length) {
    const job = stationState.generationJobs.shift();
    try {
      console.log(`[jobs] 开始 ${job.key}`);
      await runJob(job);
      console.log(`[jobs] 完成 ${job.key}`);
    } catch (err) {
      console.error(`[jobs] 失败 ${job.key}:`, err.message);
      broadcast({ type: 'job-status', key: job.key, jobType: job.type, status: 'failed', error: err.message });
    } finally {
      stationState.jobKeys.delete(job.key);
    }
  }
  stationState.workerRunning = false;
}

async function runJob(job) {
  if (job.type === 'program_start') return runProgramStartJob(job);
  if (job.type === 'music_refill') return runMusicRefillJob(job);
  if (job.type === 'bridge_generation') return runBridgeGenerationJob(job);
  throw new Error(`Unknown job type: ${job.type}`);
}

function enqueueBridgeJobs({ programId, sessionTitle, tracks, startIndex = 0, previousTrack = null, previousIndex = null, djLanguage = 'en' }) {
  // DEPRECATED: Bridges are now pre-generated from batch intros.
  // This function is kept as a no-op for backward compatibility.
  console.log('[bridge] Skipped enqueueBridgeJobs (batch mode: bridges pre-generated)');
}

// ── Batch bridge segment creation ────────────────────────────────────────────
// Creates bridge segments from pre-generated batch intros (0 AI calls).
// batchStartIndex: the batch queue index of the first track in this slice
// queueStartIndex: the front-end queue position of the first track in this slice
// trackCount: number of tracks in this slice
// hasPreviousTrack: whether there's a track before queueStartIndex (for the first bridge)
function createBatchBridgeSegments(batchStartIndex, queueStartIndex, trackCount, hasPreviousTrack) {
  const segments = [];
  const startK = hasPreviousTrack ? 0 : 1;

  for (let k = startK; k < trackCount; k++) {
    const batchIdx = batchStartIndex + k;
    const intro = batchManager.getIntro(batchIdx);
    if (!intro) continue;

    segments.push({
      id: `batch_bridge_${batchIdx}`,
      type: 'bridge',
      groupId: `bridge_${queueStartIndex + k - 1}_${queueStartIndex + k}`,
      position: 'between_tracks',
      afterTrackIndex: queueStartIndex + k - 1,
      beforeTrackIndex: queueStartIndex + k,
      text: intro,
    });
  }

  return segments;
}

async function runProgramStartJob(job) {
  const programId = makeProgramId();

  // ── ONE AI call: generate batch (10 songs + 3 cold opens + intros) ──
  console.log('[电台] program_start: 生成 batch（1 次 AI 调用）...');
  const batch = await batchManager.generateBatch(
    job.input || 'Open the station.',
    { djLanguage: job.djLanguage }
  );

  let tracks = [];
  let failedTracks = [];
  let segments = [];
  let sessionTitle = '';
  let reason = 'batch';

  if (batch && batch.queue.length > 0) {
    // Batch success: consume first 3 tracks
    const batchStartIndex = batchManager.consumedIndex;
    const queries = batchManager.nextTrackQueries(3);
    console.log(`[电台] batch 消费 ${queries.length} 首: ${queries.join(', ')}`);
    const result = await resolveRequestedTracks(queries);
    tracks = result.tracks;
    failedTracks = result.failedTracks;
    sessionTitle = batch.title || '';

    // Create cold open segments from batch.coldOpens[0]
    const coldOpen = batchManager.getColdOpen(0);
    const coldOpenSegments = [];
    if (coldOpen) {
      coldOpen.parts.forEach((part, i) => {
        coldOpenSegments.push({
          id: `${programId}_cold_${i}`,
          type: 'cold_open',
          groupId: 'open_0',
          part: part.part,
          position: 'before_track',
          trackIndex: 0,
          text: part.text,
        });
      });
    }

    // Create bridge segments from batch intros (0 AI calls!)
    const bridgeSegments = createBatchBridgeSegments(batchStartIndex, 0, tracks.length, false);

    // Combine: station ID + cold open + bridges
    const allSegments = [
      programStartIdSegment(programId),
      ...coldOpenSegments,
      ...bridgeSegments,
    ];

    segments = await synthesizeSegments(normalizeSegments({ segments: allSegments }, tracks, false, failedTracks));
  } else {
    // Batch failed: fallback to recent plays (no AI, no DJ content)
    console.log('[电台] batch 生成失败，兜底：从最近播放记录中选取曲目');
    const recent = recentPlays().reverse().slice(0, 20);
    const fallbackQueries = [];
    for (const entry of recent) {
      if (fallbackQueries.length >= 3) break;
      const q = entry.query || entry.title || '';
      if (q && !fallbackQueries.includes(q)) fallbackQueries.push(q);
    }
    if (!fallbackQueries.length) {
      fallbackQueries.push('Never Gonna Give You Up', 'Bohemian Rhapsody', 'Blinding Lights');
    }
    const result = await resolveRequestedTracks(fallbackQueries, { skipAvoid: true });
    tracks = result.tracks;
    failedTracks = result.failedTracks;
    sessionTitle = 'Music Mode';
    reason = 'fallback';
  }

  stationState.programId = programId;
  stationState.sessionTitle = sessionTitle;
  stationState.tracks = tracks;
  if (tracks.length) nowPlaying = { title: tracks[0].title, artist: tracks[0].artist, startedAt: Date.now() };
  addMessage('claudio', segments.filter(s => s.text).map(s => s.text).join('\n\n'));

  const payload = {
    type: 'program-start',
    programId,
    tracks,
    segments,
    sessionTitle,
    stationName: STATION_NAME,
    programName: PROGRAM_NAME,
    failedTracks,
    reason,
  };
  broadcast(payload);

  // NO enqueueBridgeJobs — bridges are pre-generated in segments!
  console.log(`[电台] program_start 完成: ${tracks.length} 首 | ${segments.length} 段播报 | reason=${reason}`);
  return payload;
}

async function runMusicRefillJob(job) {
  const programId = job.programId || stationState.programId || makeProgramId();
  const queue = normalizeTracksForPrompt(job.queue || stationState.tracks);
  const startIndex = Number.isInteger(job.queueLength) ? job.queueLength : stationState.tracks.length;
  const previousTrack = job.previousTrack || stationState.tracks[stationState.tracks.length - 1] || null;
  const previousIndex = Number.isInteger(job.previousIndex) ? job.previousIndex : startIndex - 1;

  let tracks = [];
  let failedTracks = [];
  let reason = 'batch';

  // ── Check if batch has remaining tracks (0 AI calls!) ──
  if (batchManager.needsRefill(3)) {
    // Batch exhausted: generate new batch (1 AI call for 10 songs)
    console.log('[电台] music_refill: batch 余量不足，生成新 batch（1 次 AI 调用）...');
    const refillContext = previousTrack
      ? `Continue the station. Currently playing: ${trackLabel(previousTrack)}. Pick up where we left off with fresh tracks that flow naturally from the current vibe.`
      : 'Continue the station with fresh tracks.';
    const newBatch = await batchManager.generateBatch(refillContext, { djLanguage: job.djLanguage });

    if (!newBatch) {
      // Fallback: use recent plays (no AI)
      console.log('[电台] music_refill: batch 生成失败，兜底选取曲目');
      const recent = recentPlays().reverse().slice(0, 20);
      const fallbackQueries = [];
      for (const entry of recent) {
        if (fallbackQueries.length >= 3) break;
        const q = entry.query || entry.title || '';
        if (q && !fallbackQueries.includes(q)) fallbackQueries.push(q);
      }
      if (!fallbackQueries.length) {
        fallbackQueries.push('Never Gonna Give You Up', 'Bohemian Rhapsody', 'Blinding Lights');
      }
      const result = await resolveRequestedTracks(fallbackQueries, { queue, skipAvoid: true });
      tracks = result.tracks;
      failedTracks = result.failedTracks;
      reason = 'fallback';
    }
  }

  // Consume tracks from batch (if not already set by fallback)
  if (!tracks.length && !failedTracks.length) {
    const batchStartIndex = batchManager.consumedIndex;
    const queries = batchManager.nextTrackQueries(3);
    console.log(`[电台] music_refill: batch 消费 ${queries.length} 首: ${queries.join(', ')}`);
    const result = await resolveRequestedTracks(queries, { queue });
    tracks = result.tracks;
    failedTracks = result.failedTracks;

    // Create bridge segments from batch intros (0 AI calls!)
    const bridgeSegments = createBatchBridgeSegments(batchStartIndex, startIndex, tracks.length, !!previousTrack);

    // Synthesize TTS for bridge segments
    if (bridgeSegments.length) {
      const segments = await synthesizeSegments(normalizeSegments(
        { segments: bridgeSegments },
        new Array(Math.max(startIndex + tracks.length, 1)).fill(null),
        false,
        []
      ));
      // Broadcast bridge segments (same format as old segment-ready)
      broadcast({
        type: 'segment-ready',
        programId,
        segments,
      });
      if (segments.some(s => s.text)) addMessage('claudio', segments.filter(s => s.text).map(s => s.text).join('\n\n'));
    }
  }

  stationState.programId = programId;
  stationState.sessionTitle = job.sessionTitle || stationState.sessionTitle || batchManager.getTitle() || '';
  stationState.tracks = [...stationState.tracks, ...tracks];

  const payload = {
    type: 'tracks-ready',
    programId,
    tracks,
    startIndex,
    failedTracks,
    reason,
  };
  broadcast(payload);

  // NO enqueueBridgeJobs — bridges are pre-generated from batch intros!
  console.log(`[电台] music_refill 完成: +${tracks.length} 首 | reason=${reason}`);
  return payload;
}

async function runBridgeGenerationJob(job) {
  const prompt = buildBridgePrompt({
    programTitle: job.sessionTitle || stationState.sessionTitle,
    afterTrack: job.afterTrack,
    beforeTrack: job.beforeTrack,
    afterTrackIndex: job.afterTrackIndex,
    beforeTrackIndex: job.beforeTrackIndex,
    djLanguage: job.djLanguage,
  });
  const result = await callClaude(prompt);
  let segments = await synthesizeSegments(normalizeSegments(
    result,
    new Array(Math.max(job.beforeTrackIndex + 1, 1)).fill(null),
    false,
    []
  ));
  segments = segments.filter(segment =>
    segment.position === 'between_tracks' &&
    segment.afterTrackIndex === job.afterTrackIndex &&
    segment.beforeTrackIndex === job.beforeTrackIndex
  );
  if (!segments.length) {
    segments = [normalizeSegment({
      type: 'silence',
      position: 'between_tracks',
      afterTrackIndex: job.afterTrackIndex,
      beforeTrackIndex: job.beforeTrackIndex,
      text: '',
    }, 0, job.beforeTrackIndex + 1)];
  }
  broadcast({
    type: 'segment-ready',
    programId: job.programId || stationState.programId,
    segments,
  });
  if (segments.some(s => s.text)) addMessage('claudio', segments.filter(s => s.text).map(s => s.text).join('\n\n'));
  return segments;
}

// ── Radio engine — core segment runner ───────────────────────────────────────
async function runRadioSegment(userInput, intent = {}, skipHistory = false) {
  const src = intent.source || 'user';
  console.log(`\n[电台] ── 节目段开始 ── 来源: ${src}`);
  console.log(`[电台] 输入: "${userInput.slice(0, 80)}${userInput.length > 80 ? '…' : ''}"`);

  if (!skipHistory) addMessage('user', userInput);
  const speechOnly = intent.mode === 'speech-only';

  // ── Speech-only mode: keep existing flow (1 AI call with Groq fallback) ──
  if (speechOnly) {
    const prompt = buildPrompt(userInput, nowPlaying ? JSON.stringify(nowPlaying) : '', {
      mode: intent.mode,
      djLanguage: intent.djLanguage,
    });
    const result = await callClaude(prompt);

    console.log(`[电台] speech-only 回复 → "${(result.say || '').slice(0, 80)}"`);
    const isQuotaExceeded = result.reason === 'quota_exceeded';
    const segments = isQuotaExceeded ? [] : await synthesizeSegments(normalizeSegments(result, [], true, []));
    const firstPlayableSegment = segments.find(s => s.ttsUrl && s.text && s.type !== 'silence');
    const announcement = isQuotaExceeded ? '' : buildAnnouncement({ ...result, segments }, [], [], true);
    if (!isQuotaExceeded) addMessage('claudio', announcement || result.say || '');
    const ttsUrl = firstPlayableSegment?.ttsUrl || null;

    const payload = {
      type: 'now-playing',
      ttsUrl,
      tracks: [],
      segments,
      sessionTitle: isQuotaExceeded ? '' : (result.title || ''),
      transcript: announcement,
      djNote: result.say,
      reason: result.reason,
      mode: 'speech-only',
      status: 'speaking',
      stationName: STATION_NAME,
      programName: PROGRAM_NAME,
      trigger: intent.source || 'user',
      failedTracks: [],
    };
    broadcast(payload);
    console.log(`[电台] ── speech-only 广播完成 ──\n`);
    return payload;
  }

  // ── Music mode: use batch system (1 AI call for 10 songs + scripts) ──
  console.log('[电台] music mode: 生成 batch（1 次 AI 调用）...');
  const batch = await batchManager.generateBatch(userInput, { djLanguage: intent.djLanguage });

  let tracks = [];
  let failedTracks = [];
  let segments = [];
  let sessionTitle = '';
  let reason = 'batch';

  if (batch && batch.queue.length > 0) {
    const batchStartIndex = batchManager.consumedIndex;
    const queries = batchManager.nextTrackQueries(3);
    console.log(`[电台] batch 消费 ${queries.length} 首: ${queries.join(', ')}`);
    const result = await resolveRequestedTracks(queries);
    tracks = result.tracks;
    failedTracks = result.failedTracks;
    sessionTitle = batch.title || '';

    // Create cold open segments (relative indices — front-end will offset)
    const coldOpen = batchManager.getColdOpen(0);
    const coldOpenSegments = [];
    if (coldOpen) {
      coldOpen.parts.forEach((part, i) => {
        coldOpenSegments.push({
          id: `seg_cold_${Date.now()}_${i}`,
          type: 'cold_open',
          groupId: 'open_0',
          part: part.part,
          position: 'before_track',
          trackIndex: 0,
          text: part.text,
        });
      });
    }

    // Create bridge segments (relative indices)
    const bridgeSegments = createBatchBridgeSegments(batchStartIndex, 0, tracks.length, false);

    const allSegments = [...coldOpenSegments, ...bridgeSegments];
    segments = await synthesizeSegments(normalizeSegments({ segments: allSegments }, tracks, false, failedTracks));
    applyLegacyTrackIntrosFromSegments(tracks, segments);
  } else {
    // Fallback: use recent plays (no AI, no DJ content)
    console.log('[电台] batch 生成失败，兜底选取曲目');
    const recent = recentPlays().reverse().slice(0, 20);
    const fallbackQueries = [];
    for (const entry of recent) {
      if (fallbackQueries.length >= 3) break;
      const q = entry.query || entry.title || '';
      if (q && !fallbackQueries.includes(q)) fallbackQueries.push(q);
    }
    if (!fallbackQueries.length) {
      fallbackQueries.push('Never Gonna Give You Up', 'Bohemian Rhapsody', 'Blinding Lights');
    }
    const result = await resolveRequestedTracks(fallbackQueries, { skipAvoid: true });
    tracks = result.tracks;
    failedTracks = result.failedTracks;
    sessionTitle = 'Music Mode';
    reason = 'fallback';
  }

  const firstPlayableSegment = segments.find(s => s.ttsUrl && s.text && s.type !== 'silence');
  const announcement = reason === 'fallback' ? '' : buildAnnouncement({ segments }, tracks, failedTracks, false);
  const spokenSummary = reason === 'fallback' ? '' : segments.filter(s => s.text).map(s => s.text).join('\n\n');
  if (reason !== 'fallback') addMessage('claudio', spokenSummary || announcement || '');
  const ttsUrl = firstPlayableSegment?.ttsUrl || null;

  if (tracks.length) {
    nowPlaying = { title: tracks[0].title, artist: tracks[0].artist, startedAt: Date.now() };
  }

  const payload = {
    type: 'now-playing',
    ttsUrl,
    tracks,
    segments,
    sessionTitle,
    transcript: announcement,
    djNote: '',
    reason,
    mode: 'music',
    status: tracks.length ? 'queued' : 'speaking',
    stationName: STATION_NAME,
    programName: PROGRAM_NAME,
    trigger: intent.source || 'user',
    failedTracks,
  };

  broadcast(payload);
  console.log(`[电台] ── 广播完成 ── 入队 ${tracks.length} 首 | 失败 ${failedTracks.length} 首 | reason=${reason}\n`);
  return payload;
}

async function handleClaudeRequest(userInput, res, intent = {}, skipHistory = false) {
  try {
    const payload = await runRadioSegment(userInput, intent, skipHistory);
    res.setHeader('Content-Type', 'application/json');
    res.json(payload);
  } catch (err) {
    console.error('[chat]', err);
    res.status(500).json({ error: err.message });
  }
}

// ── HTTP Routes ──────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message, autoRefill, djLanguage } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const intent = route(message);
  intent.source = autoRefill ? 'autoRefill' : 'user';
  intent.djLanguage = normalizeDjLanguage(djLanguage);

  if (intent.action === 'next') {
    broadcast({ type: 'control', action: 'next' });
    return res.json({ action: 'next' });
  }
  if (intent.action === 'pause') {
    broadcast({ type: 'control', action: 'pause' });
    return res.json({ action: 'pause' });
  }
  if (intent.action === 'resume') {
    broadcast({ type: 'control', action: 'resume' });
    return res.json({ action: 'resume' });
  }
  if (intent.action === 'volume') {
    broadcast({ type: 'control', action: 'volume', delta: intent.delta });
    return res.json({ action: 'volume', delta: intent.delta });
  }

  if (intent.mode !== 'speech-only') {
    enqueueJob({
      type: 'program_start',
      key: `program_start:${Date.now()}`,
      input: intent.message,
      source: autoRefill ? 'autoRefill' : 'user',
      djLanguage: intent.djLanguage,
    });
    return res.json({ queued: true, jobType: 'program_start' });
  }

  await handleClaudeRequest(intent.message, res, intent, !!autoRefill);
});

app.post('/api/radio/refill', (req, res) => {
  const {
    programId,
    sessionTitle,
    currentTrack,
    previousTrack,
    previousIndex,
    queue = [],
    queueLength,
    djLanguage,
  } = req.body || {};
  const effectiveProgramId = programId || stationState.programId || makeProgramId();
  const effectiveQueueLength = Number.isInteger(queueLength) ? queueLength : Array.isArray(queue) ? queue.length : stationState.tracks.length;
  const key = `music_refill:${effectiveProgramId}`;
  const accepted = enqueueJob({
    type: 'music_refill',
    key,
    programId: effectiveProgramId,
    sessionTitle: sessionTitle || stationState.sessionTitle,
    currentTrack,
    previousTrack,
    previousIndex,
    queue: Array.isArray(queue) ? queue : [],
    queueLength: effectiveQueueLength,
    count: REFILL_TRACK_COUNT,
    djLanguage: normalizeDjLanguage(djLanguage),
  });
  res.json({ queued: accepted, jobType: 'music_refill', programId: effectiveProgramId });
});

app.get('/api/now', (req, res) => {
  res.json(nowPlaying || { playing: false });
});

app.get('/api/next', async (req, res) => {
  broadcast({ type: 'control', action: 'next' });
  res.json({ action: 'next' });
});

app.get('/api/taste', (req, res) => {
  try {
    const content = fs.readFileSync(path.join(__dirname, 'user/taste.md'), 'utf-8');
    res.type('text/plain').send(content);
  } catch {
    res.status(404).json({ error: 'taste.md not found' });
  }
});

app.get('/api/plan/today', (req, res) => {
  const plan = getPref('today_plan');
  res.json(plan || { message: '今日计划尚未生成' });
});

app.post('/api/tts/caller', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'text required' });
  if (text.length > 800) return res.status(400).json({ error: 'text too long' });

  try {
    const f = await synthesize(text, callerTtsOptions());
    res.json({ ttsUrl: '/api/tts/' + path.basename(f) });
  } catch (err) {
    console.error('[caller-tts]', err);
    res.status(500).json({ error: err.message });
  }
});

// Serve cached TTS files
app.get('/api/tts/:filename', (req, res) => {
  const file = path.join(__dirname, 'cache/tts', req.params.filename);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

// Serve cached music files
app.get('/api/music/cache/:filename', (req, res) => {
  const file = path.join(__dirname, 'cache/music', req.params.filename);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.setHeader('Content-Type', 'audio/mpeg');
  res.sendFile(file);
});

// 音频流代理：绕过浏览器 CORS/格式限制
app.get('/api/stream/:id', async (req, res) => {
  const streamUrl = streamProxyMap.get(req.params.id);
  if (!streamUrl) return res.status(404).end();
  try {
    const proto = streamUrl.startsWith('https') ? https : http;
    // 转发浏览器发来的 Range 等请求头
    const headers = {
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.youtube.com/',
    };
    if (req.headers.range) headers['Range'] = req.headers.range;
    if (req.headers['accept-encoding']) headers['Accept-Encoding'] = req.headers['accept-encoding'];

    const r = await new Promise((resolve, reject) => {
      const opts = new URL(streamUrl);
      const req2 = proto.get(streamUrl, { headers }, resolve);
      req2.on('error', reject);
      req2.setTimeout(15000, () => { req2.destroy(); reject(new Error('timeout')); });
    });
    // 转发状态码和响应头
    res.status(r.statusCode);
    for (const [k, v] of Object.entries(r.headers)) {
      const key = k.toLowerCase();
      if (key === 'transfer-encoding') continue;
      if (key === 'content-length' && req.headers.range) continue; // Range 请求时 Node 会自动算
      res.setHeader(k, v);
    }
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'audio/webm');
    if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-cache');
    r.pipe(res);
  } catch (err) {
    console.error('[proxy]', err.message);
    res.status(502).end();
  }
});

// ── Boot ─────────────────────────────────────────────────────────────────────
scheduler.init(broadcast, runRadioSegment);

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`\n[电台] Claudio FM 启动 → http://localhost:${PORT}`);
  console.log(`[电台] 等待调度器或用户触发…\n`);
});
