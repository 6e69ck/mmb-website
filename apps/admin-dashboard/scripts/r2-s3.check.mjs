import test from 'node:test';
import assert from 'node:assert/strict';
import { createR2Client } from './r2-s3.mjs';

const config = {
  endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
  accessKeyId: 'test-key', secretAccessKey: 'test-secret',
  now: () => new Date('2026-11-17T12:00:00Z'),
};

test('S3 PUT matches an independently calculated SigV4 fixture and signs create-only condition', async () => {
  let request;
  const client = createR2Client({ ...config, fetchImpl: async (url, options) => { request = { url, ...options }; return new Response(null); } });
  await client.put('mmb-media', 'media/test.jpg', Buffer.from('hello'), { contentType: 'image/jpeg', createOnly: true });
  assert.equal(request.url.pathname, '/mmb-media/media/test.jpg');
  assert.equal(request.headers.get('authorization'), 'AWS4-HMAC-SHA256 Credential=test-key/20261117/auto/s3/aws4_request, SignedHeaders=content-type;host;if-none-match;x-amz-content-sha256;x-amz-date, Signature=8316d243f6a423f16fa4c7082bd9b8547e0f5d9f21a46a48eccff10b9f0ede55');
  assert.equal(request.redirect, 'error');
  assert.equal(request.headers.get('if-none-match'), '*');
});

test('credential-bearing requests reject foreign endpoints and missing credentials', () => {
  for (const endpoint of ['', 'http://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com', 'https://example.com', `${config.endpoint}/mmb-media`, `${config.endpoint}?redirect=1`, `${config.endpoint}:444`]) {
    assert.throws(() => createR2Client({ ...config, endpoint }));
  }
  assert.throws(() => createR2Client({ ...config, secretAccessKey: '' }));
});

test('HEAD treats only 404 as absent and refuses permission/server failures', async () => {
  for (const status of [200, 404, 403, 500]) {
    const client = createR2Client({ ...config, fetchImpl: async () => new Response(null, { status }) });
    if (status === 200 || status === 404) assert.equal(await client.exists('mmb-media', 'gallery/v1/catalog.json'), status === 200);
    else await assert.rejects(client.exists('mmb-media', 'gallery/v1/catalog.json'), /object check failed/);
    if (status !== 200) await assert.rejects(client.checkBucket('mmb-media'), /bucket check failed/);
  }
});

test('conditional initialization preserves a catalog created by another writer', async () => {
  const client = createR2Client({ ...config, fetchImpl: async () => new Response(null, { status: 412 }) });
  await assert.rejects(client.put('mmb-media', 'gallery/v1/catalog.json', Buffer.from('{}'), { createOnly: true }), /preserved/);
});

test('connection failures report the cause without exposing credentials', async () => {
  const client = createR2Client({ ...config, fetchImpl: async () => { throw new Error('sensitive details', { cause: { code: 'EAI_AGAIN' } }); } });
  await assert.rejects(client.checkBucket('mmb-media'), error => {
    assert.match(error.message, /EAI_AGAIN/);
    assert.doesNotMatch(error.message, /test-secret|test-key|sensitive/);
    return true;
  });
});
