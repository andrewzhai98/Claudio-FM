const fs = require('fs');
const path = require('path');
const { recentPlays, recentMessages } = require('./state');

function readFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

function sharedContext({ includeTaste = true, includeDialog = true, recentPlayLimit = 20 } = {}) {
  const persona = readFile(path.join(__dirname, 'prompts/dj-persona.md'));
  const taste = readFile(path.join(__dirname, 'user/taste.md'));
  const routines = readFile(path.join(__dirname, 'user/routines.md'));
  const moodRules = readFile(path.join(__dirname, 'user/mood-rules.md'));
  const now = new Date();
  const tz = process.env.TZ || 'Europe/London';
  const env = `当前时间：${now.toLocaleString('en-GB', { timeZone: tz })}`;
  const plays = recentPlays(recentPlayLimit);
  const historyText = plays.length
    ? plays.map(p => `- ${p.title}${p.artist ? ' — ' + p.artist : ''}`).join('\n')
    : '（暂无播放记录）';
  const messages = includeDialog ? recentMessages(8) : [];
  const dialogText = messages.length
    ? messages.map(m => `${m.role === 'user' ? '用户' : 'Claudio'}: ${m.content}`).join('\n')
    : '';

  return [
    persona,
    includeTaste ? `# 用户音乐品味\n${taste}` : '',
    routines ? `# 用户作息\n${routines}` : '',
    moodRules ? `# 情绪规则\n${moodRules}` : '',
    `# 环境\n${env}`,
    `# 最近播放历史（最近${recentPlayLimit}首）\n${historyText}`,
    dialogText ? `# 最近 on-air / call-in 历史\n${dialogText}` : '',
  ].filter(Boolean).join('\n\n');
}

function normalizeDjLanguage(language) {
  return language === 'zh' ? 'zh' : 'en';
}

function djLanguageInstruction(language, scope = 'spoken segment text') {
  if (normalizeDjLanguage(language) === 'zh') {
    return `All ${scope} must be in natural, restrained Chinese. Keep song titles and artist names in their original language for accurate music search.`;
  }
  return `All ${scope} must be in English unless the listener explicitly requests Chinese.`;
}

function coldOpenLengthInstruction(language) {
  return normalizeDjLanguage(language) === 'zh'
    ? 'Cold open 要简洁自然，像真实电台 DJ。每段 30-60 字，总共 3-5 段。避免冗长介绍，直接带入音乐。'
    : 'Cold open should be concise and natural, like a real radio DJ. Each part 20-40 words, total 3-5 parts. Avoid long introductions, lead directly into the music.';
}

function bridgeLengthInstruction(language) {
  return normalizeDjLanguage(language) === 'zh'
    ? 'Bridge 要简短有节奏感，20-40 字。可以是一句评价、一个过渡、或者干脆 silence。记住：音乐才是主角，你的话是点缀。'
    : 'Bridge should be short and rhythmic, 15-25 words. Can be a quick comment, a transition, or silence. Remember: music is the star, your voice is the seasoning.';
}

function buildPrompt(userInput, queueState = '', options = {}) {
  const djLanguage = normalizeDjLanguage(options.djLanguage);
  const intentText = options.mode === 'speech-only'
    ? 'Intent: speech-only / no-music. Do not recommend, replace, or add songs. Return an empty play array and one immediate quick_touch segment only if Claudio should speak.'
    : 'Intent: music radio segment. Unless the user asked for one specific song, return a mini set of 2-3 playable songs.';

  const parts = [
    sharedContext(),
    queueState ? `# 当前队列状态\n${queueState}` : '',
    `# 当前请求意图\n${intentText}`,
    `# 用户输入\n${userInput}`,
    [
      'Strictly output JSON only, with no extra text.',
      djLanguageInstruction(djLanguage),
      'The "title" should use the same language as the DJ narration.',
      'The "play" array may keep song titles and artist names in their original language for accurate music search.',
      'For speech-only / no-music requests, "play" must be [] and segments must not alter the queue.',
      'Default to 2–3 songs per set unless the user asks for one specific track.',
      'Do not repeat any song from the recent play history or current queue. Do not include the same song twice in one play array.',
      'Avoid artists that appear in the most recent 5 played songs unless the listener explicitly asked for that artist.',
      '"title" is a 2–4 word evocative segment name (or "" if nothing fits).',
      'Return "segments" as an array of radio script actions. Supported types: cold_open, bridge, quick_touch, back_announce, silence. Supported positions: before_track, between_tracks, after_track, immediate.',
      'For normal music sets, include a cold open before trackIndex 0 unless silence is clearly better. Write it as 3–5 consecutive cold_open segments, each with one sentence, the same position/trackIndex, and optional part values: anchor, heart, turn, image, invitation.',
      coldOpenLengthInstruction(djLanguage),
      `Bridge segments should be bound between tracks with afterTrackIndex and beforeTrackIndex. ${bridgeLengthInstruction(djLanguage)}`,
      'Vary your rhythm: do not narrate every track the same way. If your recent on-air lines in the dialog history were long, keep this one short or silent. The music is the point; your voice frames it.',
      '{"title":"program moment name","play":["song - artist"],"segments":[{"type":"cold_open","part":"anchor","position":"before_track","trackIndex":0,"text":"One sentence of DJ narration."},{"type":"cold_open","part":"turn","position":"before_track","trackIndex":0,"text":"One sentence that continues the opening."},{"type":"cold_open","part":"invitation","position":"before_track","trackIndex":0,"text":"One short sentence into the music."},{"type":"bridge","position":"between_tracks","afterTrackIndex":0,"beforeTrackIndex":1,"text":"bridge over track 1 outro into track 2"},{"type":"silence","position":"between_tracks","afterTrackIndex":1,"beforeTrackIndex":2,"text":""}],"reason":"internal reason"}',
    ].join('\n'),
  ];

  return parts.filter(Boolean).join('\n\n');
}

function buildProgramStartPrompt(userInput, queueState = '', options = {}) {
  const djLanguage = normalizeDjLanguage(options.djLanguage);
  return [
    sharedContext(),
    queueState ? `# 当前队列状态\n${queueState}` : '',
    `# 电台任务\nprogram_start：开播。只生成节目标题、2-3 首歌、以及 cold_open 句级播报。不要生成 bridge、back_announce 或 quick_touch。`,
    `# 用户输入 / 启动意图\n${userInput}`,
    [
      'Strictly output JSON only, with no extra text.',
      djLanguageInstruction(djLanguage, 'cold_open segment text'),
      'The "title" should use the same language as the DJ narration.',
      'Return only: title, play, segments, reason.',
      'The "play" array must contain 2-3 songs in "song title - artist" format. Keep original-language titles/artists for search.',
      'Do not repeat any song from the recent play history or current queue. Do not include the same song twice in one play array.',
      'Avoid artists that appear in the most recent 5 played songs unless the listener explicitly asked for that artist.',
      'The "segments" array must contain only cold_open segments for trackIndex 0.',
      'Write 3-5 consecutive cold_open segments, each one sentence, same position before_track and trackIndex 0.',
      coldOpenLengthInstruction(djLanguage),
      'Use optional part values: anchor, heart, turn, image, invitation.',
      'The cold open must feel like an on-air host opening a station, not an assistant explaining recommendations.',
      '{"title":"program moment name","play":["song - artist"],"segments":[{"type":"cold_open","groupId":"open_0","part":"anchor","position":"before_track","trackIndex":0,"text":"One sentence."},{"type":"cold_open","groupId":"open_0","part":"turn","position":"before_track","trackIndex":0,"text":"One sentence."},{"type":"cold_open","groupId":"open_0","part":"invitation","position":"before_track","trackIndex":0,"text":"One short sentence into the music."}],"reason":"internal reason"}',
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}

function buildColdOpenForTracksPrompt({ programTitle = '', tracks = [], userInput = '', djLanguage = 'en' } = {}) {
  const normalizedLanguage = normalizeDjLanguage(djLanguage);
  const trackText = tracks.length
    ? tracks.map((track, i) => `${i}. ${track.title || track.query}${track.artist ? ' — ' + track.artist : ''}`).join('\n')
    : '（无可播放歌曲）';

  return [
    sharedContext({ includeDialog: true, recentPlayLimit: 12 }),
    `# 电台任务\ncold_open_for_resolved_tracks：根据已经确认可播放的真实歌曲生成开场播报。`,
    programTitle ? `# 当前节目标题\n${programTitle}` : '',
    userInput ? `# 用户输入 / 启动意图\n${userInput}` : '',
    `# 已确认可播放歌曲（必须以此为准）\n${trackText}`,
    [
      'Strictly output JSON only, with no extra text.',
      'Return only: {"segments":[...],"reason":"internal reason"}.',
      djLanguageInstruction(normalizedLanguage, 'cold_open segment text'),
      'The opening is for trackIndex 0 and must introduce the first confirmed playable track.',
      'If you mention a song title or artist, it must exactly be from the confirmed playable song list above.',
      'Do not mention or describe any song that is not in the confirmed playable song list.',
      'The "segments" array must contain only cold_open segments for trackIndex 0.',
      'Write 3-5 consecutive cold_open segments, each one sentence, same position before_track and trackIndex 0.',
      coldOpenLengthInstruction(normalizedLanguage),
      'Use optional part values: anchor, heart, turn, image, invitation.',
      '{"segments":[{"type":"cold_open","groupId":"open_0","part":"anchor","position":"before_track","trackIndex":0,"text":"One sentence about the exact first confirmed track."},{"type":"cold_open","groupId":"open_0","part":"turn","position":"before_track","trackIndex":0,"text":"One sentence that stays accurate to the confirmed tracks."},{"type":"cold_open","groupId":"open_0","part":"invitation","position":"before_track","trackIndex":0,"text":"One short sentence into the first track."}],"reason":"internal reason"}',
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}

function buildMusicRefillPrompt({ programTitle = '', currentTrack = null, queue = [], count = 3 } = {}) {
  const queueText = queue.length
    ? queue.map((t, i) => `${i + 1}. ${t.title || t.query}${t.artist ? ' — ' + t.artist : ''}`).join('\n')
    : '（当前队列为空）';
  const currentText = currentTrack ? `${currentTrack.title || currentTrack.query}${currentTrack.artist ? ' — ' + currentTrack.artist : ''}` : 'unknown';
  return [
    sharedContext({ includeDialog: false, recentPlayLimit: 20 }),
    `# 电台任务\nmusic_refill：只为当前电台补 ${count} 首歌。不要生成任何听众可见 DJ 播报。`,
    `# 当前节目\n${programTitle || 'Untitled program'}`,
    `# 当前正在播\n${currentText}`,
    `# 当前前端队列\n${queueText}`,
    [
      'Strictly output JSON only, with no extra text.',
      'Return only: {"play":["song - artist"],"reason":"internal reason"}.',
      `Return ${count} songs unless the queue context makes fewer safer.`,
      'Do not include segments, say, intros, or listener-facing explanations.',
      'Keep song titles and artist names in original language for accurate search.',
      'Do not repeat any song from the current queue or recent play history.',
      'Do not include the same song twice in one play array.',
      'Avoid artists that appear in the most recent 5 played songs unless the listener explicitly asked for that artist.',
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}

function buildBridgePrompt({ programTitle = '', afterTrack, beforeTrack, afterTrackIndex, beforeTrackIndex, recentLines = '', djLanguage = 'en' }) {
  const normalizedLanguage = normalizeDjLanguage(djLanguage);
  const afterText = `${afterTrack?.title || afterTrack?.query || 'previous track'}${afterTrack?.artist ? ' — ' + afterTrack.artist : ''}`;
  const beforeText = `${beforeTrack?.title || beforeTrack?.query || 'next track'}${beforeTrack?.artist ? ' — ' + beforeTrack.artist : ''}`;
  return [
    sharedContext({ includeTaste: false, includeDialog: false, recentPlayLimit: 8 }),
    `# 电台任务\nbridge_generation：只生成从上一首到下一首的歌曲缝隙播报，或明确选择 silence。`,
    `# 当前节目\n${programTitle || 'Untitled program'}`,
    `# 上一首\nindex ${afterTrackIndex}: ${afterText}`,
    `# 下一首\nindex ${beforeTrackIndex}: ${beforeText}`,
    recentLines ? `# 最近播报摘要\n${recentLines}` : '',
    [
      'Strictly output JSON only, with no extra text.',
      djLanguageInstruction(normalizedLanguage, 'bridge segment text'),
      'Return only {"segments":[...],"reason":"internal reason"}.',
      'Output either 1-3 sentence-level bridge segments OR one silence segment.',
      'For bridge segments, use the same groupId, position between_tracks, and exact afterTrackIndex/beforeTrackIndex provided.',
      bridgeLengthInstruction(normalizedLanguage),
      'Allowed bridge part values: back_announce, pivot, handoff.',
      'Do not write a recommendation explanation. This is live radio at the seam.',
      'If there is nothing worth saying, return one silence segment with text "".',
      `{"segments":[{"type":"bridge","groupId":"bridge_${afterTrackIndex}_${beforeTrackIndex}","part":"back_announce","position":"between_tracks","afterTrackIndex":${afterTrackIndex},"beforeTrackIndex":${beforeTrackIndex},"text":"One sentence."},{"type":"bridge","groupId":"bridge_${afterTrackIndex}_${beforeTrackIndex}","part":"handoff","position":"between_tracks","afterTrackIndex":${afterTrackIndex},"beforeTrackIndex":${beforeTrackIndex},"text":"One sentence into the next track."}],"reason":"internal reason"}`,
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}

function buildBatchPrompt(userInput, options = {}) {
  const djLanguage = normalizeDjLanguage(options.djLanguage);
  const langInstruction = djLanguageInstruction(djLanguage, 'all spoken text (cold open parts and intros)');
  const coldOpenLen = coldOpenLengthInstruction(djLanguage);
  const introLen = djLanguage === 'zh'
    ? 'Each intro should be 1-2 sentences in Chinese, usually 30-60 characters.'
    : 'Each intro should be 1-2 sentences in English, usually 15-35 words.';

  return [
    sharedContext(),
    `# Radio task\nbatch_generation: Generate a complete radio content package in ONE response. This will be consumed gradually by the station — no further AI calls needed until the queue runs low.`,
    `# User input / startup intent\n${userInput}`,
    [
      'Strictly output JSON only, with no extra text.',
      langInstruction,
      `The "title" should use the same language as the DJ narration. 2-4 words, evocative.`,
      'Return a JSON object with this EXACT structure:',
      '{',
      '  "title": "program moment name",',
      '  "queue": [',
      '    {',
      '      "query": "Song Title - Artist Name",',
      '      "reason": "internal reason why this song fits (1 sentence)",',
      '      "intro": "DJ segue text to introduce this song on air (1-2 sentences)"',
      '    }',
      '    // ... exactly 10 entries',
      '  ],',
      '  "coldOpens": [',
      '    {',
      '      "parts": [',
      '        {"part": "anchor", "text": "Opening sentence that hooks the listener."},',
      '        {"part": "heart", "text": "Sentence connecting to the mood or moment."},',
      '        {"part": "turn", "text": "Sentence that pivots toward the music."},',
      '        {"part": "image", "text": "Vivid image or concrete detail."},',
      '        {"part": "invitation", "text": "Short sentence into the first track."}',
      '      ]',
      '    }',
      '    // ... exactly 3 cold open variations',
      '  ],',
      '  "preferences": {',
      '    "mood": "current mood descriptor",',
      '    "energy": "low|low-medium|medium|medium-high|high",',
      '    "themes": ["theme1", "theme2", "theme3"]',
      '  },',
      '  "reason": "internal reason"',
      '}',
      '',
      'Rules:',
      'The "queue" array MUST contain exactly 10 songs in "song title - artist" format.',
      'Keep song titles and artist names in their original language for accurate music search.',
      'Do not repeat any song from the recent play history. Do not include the same song twice.',
      'Avoid artists that appear in the most recent 5 played songs unless the listener explicitly asked.',
      coldOpenLen,
      introLen,
      'The first cold open (coldOpens[0]) is the primary opening; coldOpens[1] and coldOpens[2] are backup variations with different tones.',
      'Each "intro" in the queue is what the DJ says to segue INTO that song (before it plays). The intro for queue[0] is not used (the cold open covers it).',
      'Intros should reference the actual song title/artist where natural, like a real radio DJ would.',
      'The cold open must feel like an on-air host opening a station, not an assistant explaining recommendations.',
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}

module.exports = { buildPrompt, buildProgramStartPrompt, buildColdOpenForTracksPrompt, buildMusicRefillPrompt, buildBridgePrompt, buildBatchPrompt };
