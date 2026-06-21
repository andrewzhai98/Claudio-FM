/**
 * BatchManager — 一次 AI 调用生成完整电台内容包，前端慢慢消费
 *
 * 替代旧的"每次操作都调 AI"模式：
 *   旧: program_start(2次) + 每首歌bridge(1次/首) + refill(1次/3首) = 大量AI调用
 *   新: 1次batch调用 → 10首歌 + 3个cold open + 每首intro → 0次额外AI调用直到队列耗尽
 */

const { generateRaw } = require('./llm');
const { buildBatchPrompt } = require('./context');
const { recentPlays } = require('./state');

// ── Batch parsing ────────────────────────────────────────────────────────────
function parseBatchResponse(raw) {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error('[batch] No JSON found in response');
    return null;
  }
  try {
    const data = JSON.parse(jsonMatch[0]);
    return {
      title: data.title || '',
      queue: Array.isArray(data.queue) ? data.queue.map(normalizeQueueEntry).filter(Boolean) : [],
      coldOpens: Array.isArray(data.coldOpens) ? data.coldOpens.map(normalizeColdOpen).filter(Boolean) : [],
      preferences: data.preferences || {},
      reason: data.reason || '',
      generatedAt: Date.now(),
    };
  } catch (err) {
    console.error('[batch] JSON parse error:', err.message);
    return null;
  }
}

function normalizeQueueEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const query = typeof entry.query === 'string' ? entry.query.trim() : '';
  if (!query) return null;
  return {
    query,
    reason: typeof entry.reason === 'string' ? entry.reason.trim() : '',
    intro: typeof entry.intro === 'string' ? entry.intro.trim() : '',
  };
}

function normalizeColdOpen(co) {
  if (!co || !Array.isArray(co.parts)) return null;
  const parts = co.parts
    .filter(p => p && typeof p.text === 'string' && p.text.trim())
    .map(p => ({ part: p.part || 'line', text: p.text.trim() }));
  if (!parts.length) return null;
  return { parts };
}

// ── BatchManager ────────────────────────────────────────────────────────────
class BatchManager {
  constructor() {
    this.currentBatch = null;
    this.consumedIndex = 0;  // How many queue entries have been consumed
  }

  /**
   * Generate a new batch with ONE AI call.
   * @param {string} userInput - User intent or startup message
   * @param {object} options - { djLanguage }
   * @returns {Promise<object|null>} - Parsed batch or null on failure
   */
  async generateBatch(userInput, options = {}) {
    const prompt = buildBatchPrompt(userInput, options);
    console.log(`[batch] Generating batch (${prompt.length} chars, lang=${options.djLanguage || 'en'})...`);

    let raw;
    try {
      raw = await generateRaw(prompt, options);
    } catch (err) {
      console.error('[batch] AI call failed:', err.message);
      return null;
    }

    const batch = parseBatchResponse(raw);
    if (!batch) {
      console.error('[batch] Failed to parse batch response');
      return null;
    }

    console.log(`[batch] Generated: "${batch.title}" | ${batch.queue.length} songs | ${batch.coldOpens.length} cold opens`);

    // Log the queue
    batch.queue.forEach((entry, i) => {
      console.log(`[batch]   ${i + 1}. ${entry.query}${entry.intro ? ` → "${entry.intro.slice(0, 50)}..."` : ''}`);
    });

    this.currentBatch = batch;
    this.consumedIndex = 0;
    return batch;
  }

  /**
   * Get the current batch (or null if none).
   */
  getBatch() {
    return this.currentBatch;
  }

  /**
   * How many uncomsumed tracks remain in the queue.
   */
  remainingTracks() {
    if (!this.currentBatch) return 0;
    return this.currentBatch.queue.length - this.consumedIndex;
  }

  /**
   * Whether we need to generate a new batch.
   * @param {number} threshold - Minimum remaining tracks before refill needed
   */
  needsRefill(threshold = 3) {
    return this.remainingTracks() < threshold;
  }

  /**
   * Get the next N track queries from the batch (and advance consumedIndex).
   * @param {number} count - How many tracks to take
   * @returns {string[]} - Array of search queries
   */
  nextTrackQueries(count = 3) {
    if (!this.currentBatch) return [];
    const start = this.consumedIndex;
    const end = Math.min(start + count, this.currentBatch.queue.length);
    const queries = this.currentBatch.queue.slice(start, end).map(entry => entry.query);
    this.consumedIndex = end;
    return queries;
  }

  /**
   * Peek at the next N track queries WITHOUT consuming them.
   * @param {number} count
   * @returns {string[]}
   */
  peekTrackQueries(count = 3) {
    if (!this.currentBatch) return [];
    const start = this.consumedIndex;
    const end = Math.min(start + count, this.currentBatch.queue.length);
    return this.currentBatch.queue.slice(start, end).map(entry => entry.query);
  }

  /**
   * Get the intro text for a specific queue index (global, not consumed-relative).
   * @param {number} queueIndex - The absolute index in the batch queue
   * @returns {string}
   */
  getIntro(queueIndex) {
    if (!this.currentBatch) return '';
    const entry = this.currentBatch.queue[queueIndex];
    return entry?.intro || '';
  }

  /**
   * Get a cold open by index.
   * @param {number} index - 0 for primary, 1-2 for backups
   * @returns {object|null} - { parts: [{part, text}, ...] }
   */
  getColdOpen(index = 0) {
    if (!this.currentBatch) return null;
    return this.currentBatch.coldOpens[index] || this.currentBatch.coldOpens[0] || null;
  }

  /**
   * Get the batch title.
   */
  getTitle() {
    return this.currentBatch?.title || '';
  }

  /**
   * Get the batch preferences.
   */
  getPreferences() {
    return this.currentBatch?.preferences || {};
  }

  /**
   * Mark tracks as consumed up to a certain index.
   * Useful when tracks were resolved externally.
   * @param {number} count - How many tracks were consumed
   */
  consume(count = 1) {
    this.consumedIndex = Math.min(
      this.consumedIndex + count,
      this.currentBatch?.queue?.length || 0
    );
  }

  /**
   * Clear the current batch.
   */
  clear() {
    this.currentBatch = null;
    this.consumedIndex = 0;
  }
}

// Singleton
const batchManager = new BatchManager();

module.exports = { batchManager, BatchManager, parseBatchResponse };
