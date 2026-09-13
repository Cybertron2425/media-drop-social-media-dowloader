import http from 'node:http';
import app from '../server/src/app.js';

const s = app.listen(0, '127.0.0.1', async () => {
  const port = s.address().port;
  console.log('Server listening on port', port);

  const post = (p, b) => new Promise(r => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => r({ s: res.statusCode, b: JSON.parse(d) }));
    });
    req.write(JSON.stringify(b)); req.end();
  });

  const get = (p) => new Promise(r => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { r({ s: res.statusCode, h: res.headers, b: JSON.parse(d) }); }
        catch { r({ s: res.statusCode, h: res.headers, len: d.length, sample: d.slice(0, 200) }); }
      });
    });
    req.end();
  });

  try {
    console.log('--- TEST 1: Short video ---');
    const shortA = await post('/api/analyze', { url: 'https://www.youtube.com/shorts/v6-3TBOTTak' });
    console.log('Short analyze:', shortA.s, 'type:', shortA.b.type, 'formats:', shortA.b.formats?.length);
    const shortFmt = shortA.b.formats[0];
    console.log('Short top format:', shortFmt.quality, shortFmt.resolution, 'downloadId:', shortFmt.downloadId);
    const shortVal = await get('/api/download/' + shortFmt.downloadId + '/validate');
    console.log('Short validate:', shortVal.s, shortVal.b);

    console.log('\n--- TEST 2: Normal video (M7FIvfx5J10) ---');
    const normA = await post('/api/analyze', { url: 'https://www.youtube.com/watch?v=M7FIvfx5J10' });
    console.log('Normal analyze:', normA.s, 'type:', normA.b.type, 'formats:', normA.b.formats?.length);
    const normFmt = normA.b.formats[0];
    console.log('Normal top format:', normFmt.quality, normFmt.resolution, 'downloadId:', normFmt.downloadId);
    const normVal = await get('/api/download/' + normFmt.downloadId + '/validate');
    console.log('Normal validate:', normVal.s, normVal.b);

    console.log('\n--- TEST 3: Normal video (aqz-KE-bpKQ) ---');
    const bbbA = await post('/api/analyze', { url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' });
    console.log('BBB analyze:', bbbA.s, 'type:', bbbA.b.type, 'formats:', bbbA.b.formats?.length);
    const bbbFmt = bbbA.b.formats[0];
    console.log('BBB top format:', bbbFmt.quality, bbbFmt.resolution, 'downloadId:', bbbFmt.downloadId);
    const bbbVal = await get('/api/download/' + bbbFmt.downloadId + '/validate');
    console.log('BBB validate:', bbbVal.s, bbbVal.b);

    console.log('\n--- TEST 4: Now test GET /api/download/:downloadId for Short vs Normal ---');
    // Note: each download token can be consumed once. So re-analyze to get fresh tokens
    console.log('Testing Short download...');
    const shortA2 = await post('/api/analyze', { url: 'https://www.youtube.com/shorts/v6-3TBOTTak' });
    const sId = shortA2.b.formats[0].downloadId;
    const shortDl = await get('/api/download/' + sId);
    console.log('Short dl status:', shortDl.s, 'headers:', shortDl.h?.['content-type'], shortDl.h?.['content-disposition'], 'len:', shortDl.len);

    console.log('\nTesting Normal video download (M7FIvfx5J10)...');
    const normA2 = await post('/api/analyze', { url: 'https://www.youtube.com/watch?v=M7FIvfx5J10' });
    const nId = normA2.b.formats[0].downloadId;
    const normDl = await get('/api/download/' + nId);
    console.log('Normal dl status:', normDl.s, 'headers:', normDl.h?.['content-type'], normDl.h?.['content-disposition'], 'len:', normDl.len, 'body:', normDl.b || normDl.sample);

  } catch (err) {
    console.error('Error during test:', err);
  } finally {
    s.close();
  }
});
