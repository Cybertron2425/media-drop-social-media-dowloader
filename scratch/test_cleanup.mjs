import assert from 'node:assert/strict';
import { listPlatforms, resolveAdapter, getAdapter } from '../server/src/platforms/registry.js';
import { analyzeHandler } from '../server/src/controllers/analyzeController.js';

console.log('--- Testing Platform Registry ---');
const platforms = listPlatforms();
console.log('Registered platforms:', platforms);

// Verify ONLY instagram and facebook exist
assert.equal(platforms.length, 2, 'Must have exactly 2 registered platforms');
assert.deepEqual(
  platforms.map((p) => p.id).sort(),
  ['facebook', 'instagram'].sort(),
  'Platforms must be strictly facebook and instagram'
);
console.log('✓ Exactly Instagram and Facebook in registry');

// Verify getAdapter
assert.ok(getAdapter('instagram'), 'getAdapter("instagram") should succeed');
assert.ok(getAdapter('facebook'), 'getAdapter("facebook") should succeed');
assert.equal(getAdapter('youtube'), undefined, 'getAdapter("youtube") must be undefined');
assert.equal(getAdapter('direct'), undefined, 'getAdapter("direct") must be undefined');
assert.equal(getAdapter('generic'), undefined, 'getAdapter("generic") must be undefined');
console.log('✓ getAdapter tests passed');

// Test resolveAdapter
const igPost = resolveAdapter('https://www.instagram.com/p/DDabc123/');
assert.equal(igPost?.constructor.platformId, 'instagram');

const igReel = resolveAdapter('https://www.instagram.com/reel/DDabc123/');
assert.equal(igReel?.constructor.platformId, 'instagram');

const fbVideo = resolveAdapter('https://www.facebook.com/watch/?v=123456789');
assert.equal(fbVideo?.constructor.platformId, 'facebook');

const fbReel = resolveAdapter('https://www.facebook.com/reel/123456789');
assert.equal(fbReel?.constructor.platformId, 'facebook');

const fbWatch = resolveAdapter('https://fb.watch/abcdef123/');
assert.equal(fbWatch?.constructor.platformId, 'facebook');

console.log('✓ Instagram and Facebook URLs resolve correctly');

// Verify all removed platforms do NOT resolve
const removedUrls = [
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://youtu.be/dQw4w9WgXcQ',
  'https://www.youtube.com/shorts/abcdefg',
  'https://www.reddit.com/r/funny/comments/123456/title/',
  'https://vimeo.com/76979871',
  'https://www.tiktok.com/@user/video/7123456789012345678',
  'https://twitter.com/jack/status/20',
  'https://x.com/jack/status/20',
  'https://pinterest.com/pin/123456789/',
  'https://www.terabox.com/s/1abcdefg',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
  'https://example.com/sample.jpg',
  'https://example.com/somepage.html',
];

for (const url of removedUrls) {
  const resolved = resolveAdapter(url);
  assert.equal(resolved, undefined, `URL "${url}" must NOT resolve, but got ${resolved?.constructor?.platformId}`);
}
console.log('✓ All 13 removed platforms/direct/generic URLs return undefined from resolveAdapter');

// Test analyzeHandler with mock request/response
async function testAnalyzeEndpoint(url) {
  return new Promise((resolve) => {
    const req = { body: { url }, id: 'test-req' };
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        resolve({ statusCode: this.statusCode, data });
      },
    };
    analyzeHandler(req, res);
  });
}

const ytResponse = await testAnalyzeEndpoint('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
assert.equal(ytResponse.statusCode, 400);
assert.equal(ytResponse.data.success, false);
assert.equal(ytResponse.data.error, 'This platform is currently not supported.');

const directResponse = await testAnalyzeEndpoint('https://example.com/video.mp4');
assert.equal(directResponse.statusCode, 400);
assert.equal(directResponse.data.success, false);
assert.equal(directResponse.data.error, 'This platform is currently not supported.');

console.log('✓ analyzeHandler returns 400 "This platform is currently not supported." for removed platforms');

console.log('\nALL PLATFORM REGISTRY & ROUTING TESTS PASSED!');
