import { IMAGE_TYPES, VIDEO_TYPES, youtubeEmbed, type GalleryItem } from '@mmb/gallery';
import { isBlurhashValid } from 'blurhash';
import { ApiError, bodyJson, json, type Env } from './types';
import { loadCatalog, mutateCatalog, presentItem, sortedItems } from './catalog';
const imageTypes = IMAGE_TYPES as readonly string[], videoTypes = VIDEO_TYPES as readonly string[];
function text(value: unknown, name: string, max: number, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > max) throw new ApiError(400, `${name} must be text of ${max} characters or fewer.`);
  return value.trim();
}
function year(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1900 || value > 2100) throw new ApiError(400, 'Choose a year between 1900 and 2100.');
  return value;
}
function publication(value: unknown, fallback = true) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new ApiError(400, 'Choose whether the item is published.');
  return value;
}
function imageMetadata(body: Record<string, unknown>) {
  const width = Number(body.width), height = Number(body.height);
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 65000)) throw new ApiError(400, 'The image dimensions are invalid.');
  const hash = text(body.hash, 'Image preview', 150);
  if (!isBlurhashValid(hash).result) throw new ApiError(400, 'The image preview is invalid.');
  const placeholder = text(body.placeholder, 'Image placeholder', 32768);
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(placeholder)) throw new ApiError(400, 'The image placeholder is invalid.');
  return { width, height, hash, placeholder };
}
export function safeMediaKey(value: unknown) {
  if (typeof value !== 'string' || !/^media\/[\w./-]+$/.test(value) || value.includes('..') || value.length > 240) throw new ApiError(400, 'This media file is not a valid gallery upload.');
  return value;
}
async function uploadedFile(key: string, env: Env, types: readonly string[]) {
  const file = await env.MEDIA.head(key);
  if (!file || !types.includes(file.httpMetadata?.contentType || '')) throw new ApiError(400, 'Finish uploading a supported media file before saving.');
  return file;
}
function itemId(value: unknown) {
  if (value === undefined) return crypto.randomUUID();
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiError(400, 'The upload request identifier must be a valid UUID.');
  }
  return value.toLowerCase();
}
function sameCreation(existing: GalleryItem, incoming: GalleryItem) {
  if (existing.kind !== incoming.kind || existing.year !== incoming.year || existing.originalKey !== incoming.originalKey || existing.thumbnailKey !== incoming.thumbnailKey) return false;
  if (existing.kind === 'video' && incoming.kind === 'video') {
    return existing.provider === incoming.provider && (existing.provider !== 'youtube' || existing.src === incoming.src);
  }
  return true;
}
export async function createItem(body: Record<string, unknown>, env: Env): Promise<GalleryItem> {
  const now = new Date().toISOString();
  const base = { id: itemId(body.clientRequestId), year: year(body.year), published: publication(body.published), order: Date.now(), createdAt: now, updatedAt: now };
  if (body.kind === 'photo') {
    const originalKey = safeMediaKey(body.originalKey), thumbnailKey = safeMediaKey(body.thumbnailKey);
    await Promise.all([uploadedFile(originalKey, env, imageTypes), uploadedFile(thumbnailKey, env, imageTypes)]);
    const caption = text(body.caption, 'Caption', 2000);
    return { ...base, ...imageMetadata(body), kind: 'photo', originalKey, thumbnailKey, src: '', thumbnail: '', caption, alt: text(body.alt, 'Image description', 500, caption.slice(0, 500)) };
  }
  if (body.kind === 'video') {
    const title = text(body.title, 'Video title', 240);
    if (!title) throw new ApiError(400, 'Give this video a title.');
    const note = text(body.note, 'Video notes', 4000);
    if (body.provider === 'youtube') {
      const src = youtubeEmbed(text(body.url, 'YouTube link', 2048));
      if (!src) throw new ApiError(400, 'Paste a valid HTTPS YouTube video link.');
      return { ...base, kind: 'video', provider: 'youtube', src, title, note };
    }
    if (body.provider === 'upload') {
      const originalKey = safeMediaKey(body.originalKey);
      const file = await uploadedFile(originalKey, env, videoTypes);
      const thumbnailKey = body.thumbnailKey ? safeMediaKey(body.thumbnailKey) : undefined;
      if (thumbnailKey) await uploadedFile(thumbnailKey, env, imageTypes);
      return { ...base, kind: 'video', provider: 'upload', src: '', title, note, originalKey, contentType: file.httpMetadata?.contentType, ...(thumbnailKey ? { thumbnailKey, ...imageMetadata(body) } : {}) };
    }
  }
  throw new ApiError(400, 'Choose a photo, uploaded video, or YouTube video.');
}
function patchItem(item: GalleryItem, body: Record<string, unknown>): GalleryItem {
  if (body.expectedUpdatedAt !== item.updatedAt) throw new ApiError(409, 'This item was changed by another admin. Refresh before saving.');
  const updated = { ...item, updatedAt: new Date(Math.max(Date.now(), Date.parse(item.updatedAt) + 1)).toISOString() };
  if (body.year !== undefined) updated.year = year(body.year);
  if (body.published !== undefined) updated.published = publication(body.published);
  if (body.order !== undefined) {
    if (typeof body.order !== 'number' || !Number.isFinite(body.order) || Math.abs(body.order) > Number.MAX_SAFE_INTEGER) throw new ApiError(400, 'This sort position is invalid.');
    updated.order = body.order;
  }
  if (updated.kind === 'photo') {
    if (body.caption !== undefined) updated.caption = text(body.caption, 'Caption', 2000);
    if (body.alt !== undefined) updated.alt = text(body.alt, 'Image description', 500);
  } else {
    if (body.title !== undefined) { updated.title = text(body.title, 'Video title', 240); if (!updated.title) throw new ApiError(400, 'Give this video a title.'); }
    if (body.note !== undefined) updated.note = text(body.note, 'Video notes', 4000);
  }
  return updated;
}
export async function items(request: Request, env: Env, path: string) {
  if (path === '/api/admin/items' && request.method === 'GET') {
    const { catalog } = await loadCatalog(env.MEDIA);
    return json({ revision: catalog.revision, items: sortedItems(catalog.items).map(item => presentItem(item, env)) });
  }
  if (path === '/api/admin/items' && request.method === 'POST') {
    const item = await createItem(await bodyJson(request), env);
    const result = await mutateCatalog(env.MEDIA, catalog => {
      const existing = catalog.items.find(candidate => candidate.id === item.id);
      if (existing) {
        if (!sameCreation(existing, item)) throw new ApiError(409, 'This upload request identifier is already used for a different gallery item.');
        return existing;
      }
      catalog.items.push(item);
      return item;
    });
    return json({ item: presentItem(result.value, env), revision: result.revision }, 201);
  }
  const id = path.match(/^\/api\/admin\/items\/([\w-]+)$/)?.[1];
  if (!id) throw new ApiError(404, 'Gallery item not found.');
  const body = await bodyJson(request);
  if (request.method === 'PATCH') {
    const result = await mutateCatalog(env.MEDIA, catalog => {
      const index = catalog.items.findIndex(item => item.id === id);
      if (index < 0) throw new ApiError(404, 'This gallery item no longer exists.');
      catalog.items[index] = patchItem(catalog.items[index], body);
      return catalog.items[index];
    });
    return json({ item: presentItem(result.value, env), revision: result.revision });
  }
  if (request.method === 'DELETE') {
    const result = await mutateCatalog(env.MEDIA, catalog => {
      const item = catalog.items.find(item => item.id === id);
      if (!item) throw new ApiError(404, 'This gallery item no longer exists.');
      if (body.expectedUpdatedAt !== item.updatedAt) throw new ApiError(409, 'This item was changed by another admin. Refresh before removing it.');
      catalog.items = catalog.items.filter(candidate => candidate.id !== id);
      return item;
    });
    const referenced = new Set(result.catalog.items.flatMap(item => [item.originalKey, item.thumbnailKey].filter(Boolean)));
    const obsolete = [...new Set([result.value.originalKey, result.value.thumbnailKey])].filter((key): key is string => Boolean(key && !referenced.has(key)));
    try { if (obsolete.length) await env.MEDIA.delete(obsolete); } catch { console.warn('Gallery item removed; unused media cleanup needs retry.'); }
    return json({ removed: true, revision: result.revision });
  }
  throw new ApiError(405, 'This method is not supported.');
}
