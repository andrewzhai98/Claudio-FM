const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PYTHON = '/Users/andrew/.workbuddy/binaries/python/versions/3.13.12/bin/python3';
const YTDLP = '/Users/andrew/.workbuddy/binaries/python/versions/3.13.12/bin/yt-dlp';
const TIMEOUT_MS = 60000;
const CACHE_DIR = path.join(__dirname, 'cache', 'music');
const MAX_CACHE_FILES = 10;

// 确保缓存目录存在
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// 清理缓存：超过 MAX_CACHE_FILES 首歌时，删除最旧的文件
function cleanCache() {
  try {
    const files = fs.readdirSync(CACHE_DIR)
      .filter(f => f.endsWith('.mp3') || f.endsWith('.part'))
      .map(f => {
        const p = path.join(CACHE_DIR, f);
        return { name: f, path: p, mtime: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime);

    while (files.length >= MAX_CACHE_FILES) {
      const oldest = files.shift();
      fs.unlinkSync(oldest.path);
      console.log(`[cache] 清理旧缓存: ${oldest.name}`);
    }
  } catch (e) {
    console.error('[cache] 清理失败:', e.message);
  }
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    // 优先用 yt-dlp 可执行文件，否则用 python3 -m yt_dlp
    const useExe = fs.existsSync(YTDLP);
    const proc = useExe
      ? spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(PYTHON, ['-m', 'yt_dlp', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const timer = setTimeout(() => { proc.kill(); reject(new Error('yt-dlp timeout')); }, TIMEOUT_MS);
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => process.stderr.write(d));
    proc.on('close', () => { clearTimeout(timer); resolve(stdout.trim()); });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// 搜索 YouTube 视频 URL
async function searchUrl(query) {
  try {
    const out = await runYtDlp([`ytsearch1:${query}`, '--print', 'webpage_url', '--no-playlist', '--no-warnings']);
    const url = out.split('\n')[0].trim();
    return url.startsWith('http') ? url : null;
  } catch { return null; }
}

// 下载音频到本地缓存，返回本地文件路径
async function downloadAudio(query) {
  const videoUrl = await searchUrl(query);
  if (!videoUrl) return null;
  const id = Math.random().toString(36).slice(2, 10);
  const outPath = path.join(CACHE_DIR, `${id}.mp3`);
  try {
    // 下载为 MP3
    await runYtDlp([
      '-x', '--audio-format', 'mp3', '--audio-quality', '0',
      '--no-playlist', '--no-warnings',
      '-o', outPath,
      videoUrl
    ]);
    if (fs.existsSync(outPath)) {
      cleanCache(); // 下载完后清理旧缓存
      const [title, artist] = query.split(' - ');
      return {
        query,
        title: title?.trim() || query,
        artist: artist?.trim() || '',
        streamUrl: `/api/music/cache/${path.basename(outPath)}`,
        lyrics: null,
      };
    }
  } catch (e) {
    console.error(`[yt-dlp] 下载失败: ${query}`, e.message);
  }
  return null;
}

async function getStreamUrl(query) {
  const track = await getTrack(query);
  return track?.streamUrl || null;
}

async function getTrack(query) {
  return downloadAudio(query);
}

module.exports = { getStreamUrl, getTrack, searchUrl };
