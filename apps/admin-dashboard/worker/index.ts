import { galleryIndex, MEDIA_PREFIX, CATALOG_KEY, type GalleryCatalog, type GalleryItem } from '@mmb/gallery';
import { authenticate, verifyMutation } from './auth';
import { loadCatalog, presentItem, sortedItems } from './catalog';
import { items, safeMediaKey } from './items';
import { uploads } from './uploads';
import { ApiError, bodyJson, isLocal, json, type Env } from './types';

const publicHeaders = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache, must-revalidate' };
async function publicGallery(request: Request, env: Env, path: string) {
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(405, 'This method is not supported.');
  const { catalog } = await loadCatalog(env.MEDIA);
  const etag = `"gallery-${catalog.revision}"`;
  if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: { ...publicHeaders, ETag: etag } });
  if (path === '/api/gallery') return json(galleryIndex(catalog), 200, { ...publicHeaders, ETag: etag });
  const year = Number(path.match(/^\/api\/gallery\/years\/(\d{4})$/)?.[1]);
  if (!year) throw new ApiError(404, 'Gallery year not found.');
  return json(sortedItems(catalog.items.filter(item => item.published && item.year === year)).map(item => presentItem(item, env)), 200, { ...publicHeaders, ETag: etag });
}
async function media(request: Request, env: Env, path: string) {
  if (!['GET', 'HEAD'].includes(request.method)) throw new ApiError(405, 'This method is not supported.');
  let key: string;
  try { key = safeMediaKey(decodeURIComponent(path.slice(1))); } catch { throw new ApiError(404, 'Media not found.'); }
  const { catalog } = await loadCatalog(env.MEDIA);
  const references = catalog.items.filter(item => item.originalKey === key || item.thumbnailKey === key);
  const publiclyVisible = references.some(item => item.published);
  if (!publiclyVisible) {
    if (!isLocal(request, env) && new URL(request.url).origin !== env.ADMIN_ORIGIN) throw new ApiError(404, 'Media not found.');
    await authenticate(request, env);
    if (!references.length) throw new ApiError(404, 'Media not found.');
  }
  const head = await env.MEDIA.head(key);
  if (!head) throw new ApiError(404, 'Media not found.');
  const headers = new Headers({
    'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff',
    'Content-Type': head.httpMetadata?.contentType || 'application/octet-stream',
    'Cache-Control': publiclyVisible ? 'public, max-age=31536000, immutable' : 'private, no-store',
    ETag: head.httpEtag || `"${head.etag}"`,
  });
  if (request.headers.get('If-None-Match') === headers.get('ETag')) return new Response(null, { status: 304, headers });
  const range = request.headers.get('Range');
  let offset = 0, length = head.size, status = 200;
  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${head.size}` } });
    if (!match[1]) { const suffix = Number(match[2]); if (!suffix) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${head.size}` } }); offset = Math.max(0, head.size - suffix); length = head.size - offset; }
    else { offset = Number(match[1]); const end = match[2] ? Math.min(Number(match[2]), head.size - 1) : head.size - 1; length = end - offset + 1; }
    if (!Number.isSafeInteger(offset) || offset >= head.size || length <= 0) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${head.size}` } });
    status = 206;
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${head.size}`);
  }
  headers.set('Content-Length', String(length));
  if (request.method === 'HEAD') return new Response(null, { status, headers });
  const object = await env.MEDIA.get(key, status === 206 ? { range: { offset, length } } : undefined);
  if (!object || !('body' in object)) throw new ApiError(404, 'Media not found.');
  return new Response(object.body, { status, headers });
}
async function localImport(request: Request, env: Env, path: string) {
  if (!isLocal(request, env)) throw new ApiError(404, 'Not found.');
  if (path === '/api/admin/import/object' && request.method === 'PUT') {
    const key = safeMediaKey(request.headers.get('X-Media-Key'));
    if (!/^media\/imported\/[a-f0-9]{64}\.[a-z0-9]+$/.test(key)) throw new ApiError(400, 'Invalid import object key.');
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 25 * 1024 * 1024) throw new ApiError(413, 'Import file too large.');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (!key.includes(digest)) throw new ApiError(400, 'Import checksum does not match.');
    await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: request.headers.get('Content-Type') || 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' } });
    return json({ key });
  }
  if (path === '/api/admin/import' && request.method === 'POST') {
    const input = await request.text();
    if (input.length > 8 * 1024 * 1024) throw new ApiError(413, 'Import catalog too large.');
    let catalog: GalleryCatalog;
    try { catalog = JSON.parse(input); } catch { throw new ApiError(400, 'Invalid import catalog.'); }
    if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.items) || catalog.items.some(item => !item.id || !['photo', 'video'].includes(item.kind) || !Number.isInteger(item.year))) throw new ApiError(400, 'Invalid import catalog.');
    if ((await loadCatalog(env.MEDIA)).catalog.items.length) throw new ApiError(409, 'The gallery is already initialized; existing edits were preserved.');
    catalog.revision = 1; catalog.updatedAt = new Date().toISOString();
    const saved = await env.MEDIA.put(CATALOG_KEY, JSON.stringify(catalog), { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
    if (!saved) throw new ApiError(409, 'The gallery was already initialized.');
    return json({ imported: catalog.items.length });
  }
  throw new ApiError(404, 'Import action not found.');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url), path = url.pathname.replace(/\/$/, '') || '/';
    try {
      if (request.method === 'OPTIONS' && (path.startsWith('/media/') || path.startsWith('/api/gallery'))) return new Response(null, { status: 204, headers: { ...publicHeaders, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Range, If-None-Match' } });
      if (path === '/api/gallery' || path.startsWith('/api/gallery/years/')) return await publicGallery(request, env, path);
      if (path.startsWith(`/${MEDIA_PREFIX}`)) return await media(request, env, path);
      // The public media hostname never exposes the admin app or write API.
      if (!isLocal(request, env) && url.origin !== env.ADMIN_ORIGIN) throw new ApiError(404, 'Not found.');
      const email = await authenticate(request, env);
      if (!['GET', 'HEAD'].includes(request.method)) verifyMutation(request, env);
      if (path === '/api/admin/session' && request.method === 'GET') return json({ email, mediaOrigin: env.PUBLIC_MEDIA_ORIGIN, mode: isLocal(request, env) ? 'local' : 'production' });
      if (path.startsWith('/api/admin/items')) return await items(request, env, path);
      if (path.startsWith('/api/admin/uploads')) return await uploads(request, env, email, path);
      if (path.startsWith('/api/admin/import')) return await localImport(request, env, path);
      if (path.startsWith('/api/')) throw new ApiError(404, 'API action not found.');
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(405, 'This method is not supported.');
      if (env.ASSETS) {
        const response = await env.ASSETS.fetch(request);
        const headers = new Headers(response.headers);
        headers.set('Cache-Control', 'private, no-cache');
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('Referrer-Policy', 'same-origin');
        headers.set('X-Frame-Options', 'DENY');
        return new Response(response.body, { status: response.status, headers });
      }
      throw new ApiError(404, 'Not found.');
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message }, error.status, path.startsWith('/api/gallery') ? publicHeaders : {});
      console.error('Gallery operation failed', error instanceof Error ? error.message : 'Unknown error');
      return json({ error: 'The gallery service is temporarily unavailable. Please try again.' }, 503, path.startsWith('/api/gallery') ? publicHeaders : {});
    }
  },
};
