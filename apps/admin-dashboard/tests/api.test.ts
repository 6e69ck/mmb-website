import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../worker/index';
import { CATALOG_KEY, MAX_IMAGE_SIZE, MAX_VIDEO_SIZE, PART_SIZE } from '@mmb/gallery';
import { MockR2 } from './mock-r2';

const ORIGIN = 'http://localhost:8787';
const MEDIA_ORIGIN = 'https://media.mmb.nickly.me';
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
const PLACEHOLDER = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`;
const HASH = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj';

type Env = Record<string, unknown> & { MEDIA: MockR2 };
let env: Env;
const context = { waitUntil() {}, passThroughOnException() {} };

function request(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string>; origin?: string; host?: string; raw?: boolean } = {}) {
  const method = options.method || 'GET';
  const headers: Record<string, string> = {
    ...(method === 'GET' || method === 'HEAD' ? {} : { 'Content-Type': options.raw ? 'application/octet-stream' : 'application/json', 'X-Requested-With': 'MMB-Gallery' }),
    Origin: options.origin || ORIGIN, ...options.headers,
  };
  const body = options.body === undefined ? undefined : options.raw ? options.body as BodyInit : JSON.stringify(options.body);
  const init = { method, headers, body };
  if (body instanceof ReadableStream) Object.assign(init, { duplex: 'half' });
  const req = new Request(new URL(path, options.host || ORIGIN), init);
  return (worker as unknown as { fetch(req: Request, env: Env, context: unknown): Promise<Response> }).fetch(req, env, context);
}

async function json(path: string, method = 'GET', body?: unknown) {
  const response = await request(path, { method, body });
  const data = await response.json() as Record<string, any>;
  return { response, data };
}

async function upload(filename = 'rehearsal.png', contentType = 'image/png', bytes = PNG) {
  const started = await json('/api/admin/uploads', 'POST', { filename, contentType, size: bytes.byteLength });
  expect(started.response.status, JSON.stringify(started.data)).toBe(201);
  const session = started.data as { id: string; key: string; partSize: number; partCount: number };
  const partResponse = await request(`/api/admin/uploads/${session.id}/parts/1`, { method: 'PUT', body: bytes, raw: true, headers: { 'Content-Length': String(bytes.byteLength) } });
  expect(partResponse.status).toBe(200);
  const part = await partResponse.json();
  const completed = await json(`/api/admin/uploads/${session.id}/complete`, 'POST', { parts: [part] });
  expect(completed.response.status, JSON.stringify(completed.data)).toBe(200);
  expect(completed.data.key).toBe(session.key);
  return session.key;
}

async function photo(published = true) {
  const originalKey = await upload(), thumbnailKey = await upload('rehearsal-thumbnail.png');
  const result = await json('/api/admin/items', 'POST', { kind: 'photo', year: 2026, caption: 'First rehearsal', alt: 'The band rehearsing', published, originalKey, thumbnailKey, width: 1, height: 1, hash: HASH, placeholder: PLACEHOLDER });
  expect(result.response.status, JSON.stringify(result.data)).toBe(201);
  return result.data.item;
}

beforeEach(() => {
  env = {
    ENVIRONMENT: 'development', DEV_AUTH: 'true',
    ADMIN_EMAILS: 'nickly88@pm.me', PUBLIC_MEDIA_ORIGIN: MEDIA_ORIGIN,
    ADMIN_ORIGIN: ORIGIN, WEBSITE_ORIGIN: 'http://localhost:4322', MEDIA: new MockR2(),
  };
});

describe('admin authentication and request boundaries', () => {
  it('does not allow a development bypass in production, even on localhost', async () => {
    env.ENVIRONMENT = 'production';
    expect((await request('/api/admin/items')).status).toBeGreaterThanOrEqual(400);
    expect((await request('/api/admin/uploads', { method: 'POST', body: { filename: 'test.png', contentType: 'image/png', size: 10 } })).status).toBeGreaterThanOrEqual(400);
    expect(env.MEDIA.objects.size).toBe(0);
  });

  it('does not trust an unsigned Access JWT with the allowed email', async () => {
    env.ENVIRONMENT = 'production';
    Object.assign(env, { ACCESS_TEAM_DOMAIN: 'https://mmb.cloudflareaccess.com', TEAM_DOMAIN: 'https://mmb.cloudflareaccess.com', CF_ACCESS_TEAM_DOMAIN: 'https://mmb.cloudflareaccess.com', ACCESS_AUD: 'test-audience', POLICY_AUD: 'test-audience', CF_ACCESS_AUD: 'test-audience' });
    const token = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify({ email: 'nickly88@pm.me', aud: ['test-audience'], exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.`;
    const response = await request('/api/admin/items', { headers: { 'Cf-Access-Jwt-Assertion': token } });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects cross-origin mutations before writing to R2', async () => {
    const response = await request('/api/admin/items', { method: 'POST', origin: 'https://unrelated.example', body: { kind: 'video', provider: 'youtube', year: 2026, title: 'Test', note: '', published: true, url: 'https://youtu.be/wsR4jiXsO6M' } });
    expect(response.status).toBe(403);
    expect(env.MEDIA.objects.size).toBe(0);
  });

  it('does not grant the local bypass to another hostname', async () => {
    const response = await request('/api/admin/items', { host: 'https://admin.mmb.nickly.me' });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe('gallery publication and concurrent updates', () => {
  it('reuses a client request UUID when photo saves are retried concurrently', async () => {
    const originalKey = await upload(), thumbnailKey = await upload('retry-thumbnail.png');
    const clientRequestId = crypto.randomUUID();
    const body = { clientRequestId, kind: 'photo', year: 2026, caption: 'Saved once', originalKey, thumbnailKey, width: 1, height: 1, hash: HASH, placeholder: PLACEHOLDER };
    const responses = await Promise.all(Array.from({ length: 3 }, () => json('/api/admin/items', 'POST', body)));
    for (const response of responses) {
      expect(response.response.status).toBe(201);
      expect(response.data.item.id).toBe(clientRequestId);
      expect(response.data.item).toEqual(responses[0].data.item);
    }
    const edited = await json(`/api/admin/items/${clientRequestId}`, 'PATCH', { caption: 'Later admin edit', expectedUpdatedAt: responses[0].data.item.updatedAt });
    expect(edited.response.status).toBe(200);
    const retried = await json('/api/admin/items', 'POST', { ...body, clientRequestId: clientRequestId.toUpperCase() });
    expect(retried.response.status).toBe(201);
    expect(retried.data.item).toEqual(edited.data.item);
    expect((await json('/api/admin/items')).data.items).toHaveLength(1);
    expect((await json('/api/gallery')).data.total).toBe(1);
  });

  it('rejects reusing a photo request UUID with different uploaded files', async () => {
    const originalKey = await upload(), thumbnailKey = await upload('original-thumbnail.png');
    const body = { clientRequestId: crypto.randomUUID(), kind: 'photo', year: 2026, caption: 'Original', originalKey, thumbnailKey, width: 1, height: 1, hash: HASH, placeholder: PLACEHOLDER };
    const original = await json('/api/admin/items', 'POST', body);
    expect(original.response.status).toBe(201);
    const otherKey = await upload('different.png');
    for (const change of [{ originalKey: otherKey }, { thumbnailKey: otherKey }, { year: 2025 }]) {
      const result = await json('/api/admin/items', 'POST', { ...body, ...change });
      expect(result.response.status).toBe(409);
    }
    expect((await json('/api/admin/items', 'POST', { clientRequestId: body.clientRequestId, kind: 'video', provider: 'youtube', year: 2026, title: 'Different kind', url: 'https://youtu.be/wsR4jiXsO6M' })).response.status).toBe(409);
    expect((await json('/api/admin/items')).data.items).toEqual([original.data.item]);
  });

  it('deduplicates equivalent YouTube links and rejects request UUID reuse for a different video', async () => {
    const body = { clientRequestId: crypto.randomUUID(), kind: 'video', provider: 'youtube', year: 2026, title: 'Original', note: '', url: 'https://youtu.be/wsR4jiXsO6M' };
    const original = await json('/api/admin/items', 'POST', body);
    expect(original.response.status).toBe(201);
    const retried = await json('/api/admin/items', 'POST', { ...body, url: 'https://www.youtube.com/watch?v=wsR4jiXsO6M' });
    expect(retried.response.status).toBe(201);
    expect(retried.data.item).toEqual(original.data.item);
    for (const change of [{ url: 'https://youtu.be/QvJfQF5oQJM' }, { year: 2025 }]) {
      expect((await json('/api/admin/items', 'POST', { ...body, ...change })).response.status).toBe(409);
    }
    expect((await json('/api/admin/items')).data.items).toEqual([original.data.item]);
  });

  it('rejects malformed client request UUIDs without creating catalog entries', async () => {
    const body = { kind: 'video', provider: 'youtube', year: 2026, title: 'Test', url: 'https://youtu.be/wsR4jiXsO6M' };
    for (const clientRequestId of ['', null, 123, 'legacy-gallery-id', '00000000-0000-0000-0000-000000000000']) {
      expect((await json('/api/admin/items', 'POST', { ...body, clientRequestId })).response.status).toBe(400);
    }
    expect(env.MEDIA.objects.has(CATALOG_KEY)).toBe(false);
  });

  it('creates a draft, publishes it, updates its year and title, then removes it', async () => {
    const created = await json('/api/admin/items', 'POST', { kind: 'video', provider: 'youtube', year: 2025, title: 'Charity concert', note: 'The band starts at 0:16.', published: false, url: 'https://youtu.be/wsR4jiXsO6M' });
    expect(created.response.status).toBe(201);
    expect((await json('/api/gallery')).data.total).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 2));
    const published = await json(`/api/admin/items/${created.data.item.id}`, 'PATCH', { published: true, year: 2026, title: 'Charity concert 2026', expectedUpdatedAt: created.data.item.updatedAt });
    expect(published.response.status).toBe(200);
    const index = await json('/api/gallery');
    expect(index.data.years).toEqual([2026]);
    expect(index.data.videoYears).toEqual([2026]);
    expect(index.data.counts['2026'].videos).toBe(1);
    const album = await request('/api/gallery/years/2026');
    expect(await album.json()).toEqual([expect.objectContaining({ id: created.data.item.id, title: 'Charity concert 2026', note: 'The band starts at 0:16.', src: 'https://www.youtube.com/embed/wsR4jiXsO6M' })]);
    const removed = await json(`/api/admin/items/${created.data.item.id}`, 'DELETE', { expectedUpdatedAt: published.data.item.updatedAt });
    expect(removed.response.status).toBe(200);
    expect((await json('/api/gallery')).data.total).toBe(0);
    expect((await json('/api/admin/items')).data.items).toHaveLength(0);
  });

  it('keeps both administrators’ concurrent additions', async () => {
    const add = (title: string, url: string) => json('/api/admin/items', 'POST', { kind: 'video', provider: 'youtube', year: 2026, title, note: '', published: true, url });
    const [first, second] = await Promise.all([add('First addition', 'https://youtu.be/wsR4jiXsO6M'), add('Second addition', 'https://youtu.be/QvJfQF5oQJM')]);
    expect(first.response.status).toBe(201);
    expect(second.response.status).toBe(201);
    const result = await json('/api/admin/items');
    expect(result.data.items.map((item: { title: string }) => item.title).sort()).toEqual(['First addition', 'Second addition']);
    expect(result.data.revision).toBe(2);
  });

  it('rejects stale edits instead of overwriting newer metadata', async () => {
    const created = await json('/api/admin/items', 'POST', { kind: 'video', provider: 'youtube', year: 2026, title: 'Original', note: '', published: true, url: 'https://youtu.be/wsR4jiXsO6M' });
    await new Promise(resolve => setTimeout(resolve, 2));
    expect((await json(`/api/admin/items/${created.data.item.id}`, 'PATCH', { title: 'First editor', expectedUpdatedAt: created.data.item.updatedAt })).response.status).toBe(200);
    const conflict = await json(`/api/admin/items/${created.data.item.id}`, 'PATCH', { title: 'Stale editor', expectedUpdatedAt: created.data.item.updatedAt });
    expect(conflict.response.status).toBe(409);
    expect((await json('/api/admin/items')).data.items[0].title).toBe('First editor');
  });

  it('rejects external embed URLs instead of treating arbitrary HTML as video', async () => {
    const response = await json('/api/admin/items', 'POST', { kind: 'video', provider: 'youtube', year: 2026, title: 'Bad embed', note: '', published: true, url: 'https://unrelated.example/embed/wsR4jiXsO6M' });
    expect(response.response.status).toBe(400);
    expect(env.MEDIA.objects.has(CATALOG_KEY)).toBe(false);
  });
});

describe('R2 uploads and public media', () => {
  it('uploads originals and thumbnails, retaining BlurHash metadata in public items', async () => {
    const item = await photo();
    const response = await request('/api/gallery/years/2026');
    expect(await response.json()).toEqual([expect.objectContaining({ id: item.id, kind: 'photo', hash: HASH, placeholder: PLACEHOLDER, caption: 'First rehearsal', width: 1, height: 1 })]);
    expect(item.src).toBe(`${MEDIA_ORIGIN}/${item.originalKey}`);
    expect(item.thumbnail).toBe(`${MEDIA_ORIGIN}/${item.thumbnailKey}`);
  });

  it('discards only completed unused uploads owned by the current administrator', async () => {
    const key = await upload('cancelled-selection.png');
    expect((await env.MEDIA.head(key))?.customMetadata.uploadedBy).toBe('nickly88@pm.me');
    const discarded = await json('/api/admin/uploads/discard', 'POST', { keys: [key, key] });
    expect(discarded.response.status).toBe(200);
    expect(discarded.data.removed).toBe(1);
    expect(await env.MEDIA.head(key)).toBeNull();
    const repeated = await json('/api/admin/uploads/discard', 'POST', { keys: [key] });
    expect(repeated.response.status).toBe(200);
    expect(repeated.data.removed).toBe(0);
  });

  it('preserves referenced original and thumbnail objects when cleaning up a cancelled edit', async () => {
    const item = await photo(false);
    const unused = await upload('unused-replacement.png');
    const discarded = await json('/api/admin/uploads/discard', 'POST', { keys: [item.originalKey, item.thumbnailKey, unused] });
    expect(discarded.response.status).toBe(200);
    expect(discarded.data.removed).toBe(1);
    expect(await env.MEDIA.head(item.originalKey)).not.toBeNull();
    expect(await env.MEDIA.head(item.thumbnailKey)).not.toBeNull();
    expect(await env.MEDIA.head(unused)).toBeNull();
    expect((await json('/api/admin/items')).data.items).toEqual([expect.objectContaining({ id: item.id, originalKey: item.originalKey, thumbnailKey: item.thumbnailKey })]);
  });

  it('rejects attempts to discard another administrator’s upload', async () => {
    const key = await upload('another-admins-photo.png');
    env.ADMIN_EMAILS = 'second-admin@example.test';
    const discarded = await json('/api/admin/uploads/discard', 'POST', { keys: [key] });
    expect(discarded.response.status).toBe(403);
    expect(await env.MEDIA.head(key)).not.toBeNull();
    expect(env.MEDIA.deleted).not.toContain(key);
  });

  it('rejects JSON above the request limit without modifying gallery storage', async () => {
    const result = await json('/api/admin/items', 'POST', { kind: 'video', provider: 'youtube', year: 2026, title: 'Large request', note: 'x'.repeat(128 * 1024), published: true, url: 'https://youtu.be/wsR4jiXsO6M' });
    expect(result.response.status).toBe(413);
    expect(env.MEDIA.objects.size).toBe(0);
    expect(env.MEDIA.uploads.size).toBe(0);
  });

  it('cancels an oversized streaming part before sending bytes to R2', async () => {
    const { data, response } = await json('/api/admin/uploads', 'POST', { filename: 'streamed-video.mp4', contentType: 'video/mp4', size: PART_SIZE + 4 });
    expect(response.status).toBe(201);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(PART_SIZE + 1)); },
      cancel() { cancelled = true; },
    });
    const result = await request(`/api/admin/uploads/${data.id}/parts/1`, { method: 'PUT', body, raw: true });
    expect(result.status).toBe(413);
    expect(cancelled).toBe(true);
    expect([...env.MEDIA.uploads.values()][0].parts.size).toBe(0);
    expect(await env.MEDIA.head(data.key)).toBeNull();
    expect((await json(`/api/admin/uploads/${data.id}`, 'DELETE')).response.status).toBe(200);
  });

  it('blocks draft media publicly but permits an authenticated admin preview', async () => {
    const item = await photo(false);
    const publicResponse = await request(`/${item.originalKey}`, { host: MEDIA_ORIGIN });
    expect([401, 403, 404]).toContain(publicResponse.status);
    const preview = await request(`/${item.originalKey}`);
    expect(preview.status).toBe(200);
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(PNG);
  });

  it('serves byte ranges for published media and hides catalog objects', async () => {
    const item = await photo(true);
    const ranged = await request(`/${item.originalKey}`, { host: MEDIA_ORIGIN, headers: { Range: 'bytes=0-7' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('Content-Range')).toBe(`bytes 0-7/${PNG.length}`);
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(PNG.slice(0, 8));
    expect((await request(`/${CATALOG_KEY}`, { host: MEDIA_ORIGIN })).status).toBe(404);
  });

  it('rejects unsupported types and files above the declared size limits', async () => {
    for (const input of [
      { filename: 'script.svg', contentType: 'image/svg+xml', size: 100 },
      { filename: 'large.png', contentType: 'image/png', size: MAX_IMAGE_SIZE + 1 },
      { filename: 'large.mp4', contentType: 'video/mp4', size: MAX_VIDEO_SIZE + 1 },
      { filename: 'empty.png', contentType: 'image/png', size: 0 },
    ]) expect((await json('/api/admin/uploads', 'POST', input)).response.status).toBe(400);
    expect(env.MEDIA.uploads.size).toBe(0);
  });

  it('rejects invalid parts and can abort an unfinished upload', async () => {
    const { data, response } = await json('/api/admin/uploads', 'POST', { filename: 'video.mp4', contentType: 'video/mp4', size: PART_SIZE + 4 });
    expect(response.status).toBe(201);
    expect(data.partCount).toBe(2);
    expect((await request(`/api/admin/uploads/${data.id}/parts/3`, { method: 'PUT', body: Uint8Array.of(1), raw: true })).status).toBe(400);
    expect((await request(`/api/admin/uploads/${data.id}/parts/1`, { method: 'PUT', body: Uint8Array.of(1), raw: true })).status).toBe(400);
    expect((await json(`/api/admin/uploads/${data.id}/complete`, 'POST', { parts: [] })).response.status).toBe(400);
    expect((await json(`/api/admin/uploads/${data.id}`, 'DELETE')).response.status).toBe(200);
    expect(env.MEDIA.uploads.size).toBe(0);
    expect([404, 410]).toContain((await request(`/api/admin/uploads/${data.id}/parts/1`, { method: 'PUT', body: Uint8Array.of(1), raw: true })).status);
  });
});
