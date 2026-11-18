import { CATALOG_KEY, type GalleryCatalog, type GalleryItem } from '@mmb/gallery';
import { ApiError, type Env } from './types';
export async function loadCatalog(bucket: R2Bucket): Promise<{ catalog: GalleryCatalog; etag?: string }> {
  const object = await bucket.get(CATALOG_KEY);
  if (!object) return { catalog: { schemaVersion: 1, revision: 0, updatedAt: new Date(0).toISOString(), items: [] } };
  let catalog: GalleryCatalog;
  try { catalog = await object.json<GalleryCatalog>(); } catch { throw new ApiError(503, 'The gallery catalog could not be read.'); }
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.items) || !Number.isSafeInteger(catalog.revision)) throw new ApiError(503, 'The gallery catalog format is not supported.');
  return { catalog, etag: object.etag };
}
export async function mutateCatalog<T>(bucket: R2Bucket, change: (catalog: GalleryCatalog) => T) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { catalog, etag } = await loadCatalog(bucket);
    const value = change(catalog);
    catalog.revision++;
    catalog.updatedAt = new Date().toISOString();
    const saved = await bucket.put(CATALOG_KEY, JSON.stringify(catalog), {
      httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
      onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' },
    });
    if (saved) return { value, revision: catalog.revision, catalog };
  }
  throw new ApiError(409, 'Another admin is updating the gallery. Refresh and try again.');
}
export function mediaUrl(key: string, env: Env) { return `${env.PUBLIC_MEDIA_ORIGIN.replace(/\/$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`; }
export function presentItem(item: GalleryItem, env: Env): GalleryItem {
  if (!item.originalKey) return item;
  if (item.kind === 'photo') return { ...item, src: mediaUrl(item.originalKey, env), thumbnail: mediaUrl(item.thumbnailKey || item.originalKey, env) };
  return { ...item, src: mediaUrl(item.originalKey, env), ...(item.thumbnailKey ? { poster: mediaUrl(item.thumbnailKey, env) } : {}) };
}
export function sortedItems(items: GalleryItem[]) { return [...items].sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)); }
