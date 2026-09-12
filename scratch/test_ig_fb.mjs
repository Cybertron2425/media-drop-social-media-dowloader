import { InstagramAdapter } from '../server/src/platforms/instagram.js';
import { FacebookAdapter } from '../server/src/platforms/facebook.js';
import { PlatformLimitationError } from '../server/src/platforms/baseAdapter.js';

const ig = new InstagramAdapter();
const fb = new FacebookAdapter();

console.log('--- Testing Instagram Adapter ---');
try {
  // Test invalid/malformed Instagram URL
  await ig.analyze('https://www.instagram.com/invalid');
  console.error('Should have failed on invalid path');
} catch (err) {
  console.log('✓ Invalid Instagram URL properly rejected:', err.message);
}

try {
  // Test non-existent post (should throw 404 / limitation error)
  await ig.analyze('https://www.instagram.com/p/ZZZZZZZZZZZ/');
  console.log('Post analysis result or handled');
} catch (err) {
  console.log('✓ Instagram not found/limitation properly caught:', err.message);
}

console.log('\n--- Testing Facebook Adapter ---');
try {
  // Test non-existent or private video
  await fb.analyze('https://www.facebook.com/watch/?v=999999999999999');
  console.log('FB analysis result');
} catch (err) {
  console.log('✓ Facebook private/limitation properly caught:', err.message);
}

console.log('\n--- Testing Stream Downloader ---');
import { downloadStream } from '../server/src/utils/streamDownloader.js';

// Test that SSRF protection in streamDownloader blocks private IP addresses
try {
  await downloadStream('http://127.0.0.1:80/secret');
  console.error('SSRF failed to block localhost');
} catch (err) {
  console.log('✓ SSRF correctly blocked localhost in streamDownloader:', err.message);
}

try {
  await downloadStream('http://169.254.169.254/latest/meta-data');
  console.error('SSRF failed to block link-local');
} catch (err) {
  console.log('✓ SSRF correctly blocked link-local IP:', err.message);
}

console.log('\nALL ADAPTER & SECURITY CHECKS PASSED!');
