import { YoutubeAdapter } from '../server/src/platforms/youtube.js';
import { execFile } from 'child_process';
import util from 'util';
import fs from 'fs';

const execFileAsync = util.promisify(execFile);
const adapter = new YoutubeAdapter();
const ffprobePath = 'C:\\media-downloader\\server\\node_modules\\@ffprobe-installer\\win32-x64\\ffprobe.exe';

async function probe(filePath) {
  const { stdout } = await execFileAsync(ffprobePath, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,codec_name',
    '-of', 'json',
    filePath
  ]);
  const data = JSON.parse(stdout);
  return data.streams[0];
}

async function testVideo(url, targetQualities) {
  console.log('\n========================================');
  console.log('Testing video:', url);
  const info = await adapter.analyze(url);
  console.log('Title:', info.title);
  console.log('Available qualities:', info.formats.map(f => f.quality).join(', '));

  const results = [];

  for (const q of targetQualities) {
    const fmt = info.formats.find(f => f.quality.toLowerCase().includes(q.toLowerCase()));
    if (!fmt) {
      console.log(`[SKIP] ${q} not available in analyzed formats`);
      results.push({ quality: q, result: 'NOT_AVAILABLE' });
      continue;
    }
    console.log(`\n--> Testing quality: ${q} (format id=${fmt.id}, itag=${fmt.meta?.videoItag || fmt.meta?.progItag})`);
    try {
      const res = await adapter.download(url, {
        formatId: fmt.id,
        sourceUrl: url,
        meta: { mimeType: fmt.mimeType, ...fmt.meta }
      });
      const tempPath = res._tempFilePath;
      if (!tempPath || !fs.existsSync(tempPath)) {
        console.error(`[FAIL] No temp file returned for ${q}`);
        results.push({ quality: q, result: 'NO_FILE' });
        continue;
      }
      const p = await probe(tempPath);
      console.log(`[PASS] ${q} downloaded successfully! Resolution: ${p.width}x${p.height}, Codec: ${p.codec_name}, Size: ${(res.sizeBytes/1024/1024).toFixed(1)}MB`);
      results.push({
        quality: q,
        selectedItag: fmt.meta?.videoItag || fmt.meta?.progItag,
        resolution: `${p.width}x${p.height}`,
        codec: p.codec_name,
        sizeMb: (res.sizeBytes / 1024 / 1024).toFixed(1),
        result: 'PASS'
      });
      res.stream.destroy();
      fs.promises.unlink(tempPath).catch(() => {});
    } catch (err) {
      console.error(`[ERROR] ${q} failed:`, err.message);
      results.push({ quality: q, result: 'ERROR', error: err.message });
    }
  }
  return results;
}

const normalResults = await testVideo('https://www.youtube.com/watch?v=WO2b03Zdu4Q', ['2160p', '1440p', '1080p', '720p', '480p', '360p']);
const shortsResults = await testVideo('https://www.youtube.com/shorts/27XnIdWyqLs', ['1080p', '720p', '360p']);

console.log('\n\n================ FINAL RESULTS ================');
console.log('Normal YouTube:');
console.table(normalResults);
console.log('Shorts:');
console.table(shortsResults);
