import { createHash } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { encode, decode } from 'blurhash';
import { CATALOG_KEY, MAX_IMAGE_SIZE, type GalleryCatalog, type GalleryPhoto } from '@mmb/gallery';
import type { MessageTarget, UploadMessageInput, AttachmentInput, MediaStore } from './contracts.js';

type StorageConfig = { endpoint: string; accessKeyId: string; secretAccessKey: string; bucket: string; publishToGallery: boolean };
type Entry = { attachmentId: string; id: string; originalKey: string; thumbnailKey?: string; record?: GalleryPhoto };
type Manifest = MessageTarget & { schemaVersion: 1; authorId: string; state: 'pending' | 'ready' | 'deleting' | 'deleted'; entries: Entry[] };
type Snapshot<T> = { value: T; etag: string };
const formats: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const imageOptions = { limitInputPixels: 40_000_000, failOn: 'error' as const, pages: 1 };
const status = (error: unknown) => (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
const missing = (error: unknown) => status(error) === 404 || ['NoSuchKey', 'NotFound'].includes((error as { name?: string })?.name || '');
const conflict = (error: unknown) => [409, 412].includes(status(error) || 0);
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const emptyCatalog = (): GalleryCatalog => ({ schemaVersion: 1, revision: 0, updatedAt: new Date(0).toISOString(), items: [] });

function targetKey(target: MessageTarget) {
  if (![target.guildId, target.channelId, target.messageId].every(value => /^\d{1,22}$/.test(value))) throw new Error('Invalid Discord message identifiers.');
  return `gallery/v1/discord/messages/${target.guildId}/${target.channelId}/${target.messageId}.json`;
}
function itemId(target: MessageTarget, attachmentId: string) {
  const bytes = Buffer.from(digest(`${target.guildId}/${target.channelId}/${target.messageId}/${attachmentId}`).slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function download(attachment: AttachmentInput) {
  const url = new URL(attachment.url);
  if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) || url.username || url.password || url.port || url.hash) {
    throw new Error('Images must be HTTPS attachments hosted by Discord.');
  }
  if (!Number.isSafeInteger(attachment.size) || attachment.size <= 0 || attachment.size > MAX_IMAGE_SIZE) throw new Error('Each Discord image must be 25 MB or smaller.');
  let response: Response;
  try { response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) }); }
  catch { throw new Error('The Discord image could not be downloaded. Please retry.'); }
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('The Discord image could not be downloaded. Please retry.'); }
  const declared = response.headers.get('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_IMAGE_SIZE)) {
    await response.body.cancel(); throw new Error('Each Discord image must be 25 MB or smaller.');
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > MAX_IMAGE_SIZE) { await reader.cancel(); throw new Error('Each Discord image must be 25 MB or smaller.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!length || length !== attachment.size) throw new Error('The Discord attachment is incomplete or its size changed. Please retry.');
  return Buffer.concat(chunks, length);
}

async function prepareImage(bytes: Buffer) {
  try {
    const metadata = await sharp(bytes, imageOptions).metadata();
    const contentType = formats[metadata.format || ''];
    if (!contentType || !metadata.width || !metadata.height || metadata.width * metadata.height > 40_000_000) throw new Error('unsupported');
    // Decode even in storage-only mode: metadata alone cannot validate an image.
    const thumbnail = await sharp(bytes, imageOptions).rotate().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 86 }).toBuffer();
    const pixels = await sharp(thumbnail).resize(32, 24, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
    const hash = encode(new Uint8ClampedArray(pixels), 32, 24, 4, 3);
    const placeholder = await sharp(Buffer.from(decode(hash, 32, 24)), { raw: { width: 32, height: 24, channels: 4 } }).png().toBuffer();
    const rotated = metadata.orientation && metadata.orientation >= 5;
    return { contentType, thumbnail, width: rotated ? metadata.height : metadata.width, height: rotated ? metadata.width : metadata.height, hash, placeholder: `data:image/png;base64,${placeholder.toString('base64')}` };
  } catch { throw new Error('Use a valid JPEG, PNG, WebP, or GIF image with no more than 40 million pixels.'); }
}

export class R2MediaStore implements MediaStore {
  private readonly client: S3Client;
  private readonly queues = new Map<string, Promise<unknown>>();
  private activeUploads = 0;
  private readonly uploadWaiters: (() => void)[] = [];
  constructor(private readonly config: StorageConfig, client?: S3Client) {
    const endpoint = new URL(config.endpoint);
    if (endpoint.protocol !== 'https:' || !/^[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/.test(endpoint.hostname) || endpoint.pathname !== '/' || endpoint.username || endpoint.password || endpoint.port || endpoint.search || endpoint.hash) throw new Error('Invalid Cloudflare R2 endpoint.');
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket) || !config.accessKeyId || !config.secretAccessKey) throw new Error('R2 bucket and credentials are required.');
    this.client = client || new S3Client({ region: 'auto', endpoint: endpoint.origin, forcePathStyle: true, maxAttempts: 3, requestHandler: { connectionTimeout: 10000, requestTimeout: 30000, throwOnRequestTimeout: true }, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED', credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } });
  }
  private serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(key) || Promise.resolve()).catch(() => {}).then(action);
    this.queues.set(key, result);
    void result.finally(() => { if (this.queues.get(key) === result) this.queues.delete(key); }).catch(() => {});
    return result;
  }
  private async limitedUpload<T>(action: () => Promise<T>): Promise<T> {
    if (this.activeUploads >= 2) await new Promise<void>(resolve => this.uploadWaiters.push(resolve));
    else this.activeUploads++;
    try { return await action(); }
    finally { const next = this.uploadWaiters.shift(); if (next) next(); else this.activeUploads--; }
  }
  private async read<T>(key: string): Promise<Snapshot<T> | null> {
    try {
      const object = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
      if (!object.Body || !object.ETag) throw new Error('R2 returned an incomplete object.');
      const raw = await object.Body.transformToString();
      if (raw.length > 16 * 1024 * 1024) throw new Error('R2 gallery metadata is too large.');
      return { value: JSON.parse(raw) as T, etag: object.ETag };
    } catch (error) { if (missing(error)) return null; throw error; }
  }
  private async writeManifest(key: string, value: Manifest, etag?: string) {
    const result = await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: key, Body: JSON.stringify(value), ContentType: 'application/json', CacheControl: 'no-store', ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }) }));
    if (!result.ETag) throw new Error('The Discord message checkpoint could not be confirmed. Please retry.');
    return result.ETag;
  }
  private async catalog(change?: (catalog: GalleryCatalog) => boolean): Promise<GalleryCatalog> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const snapshot = await this.read<GalleryCatalog>(CATALOG_KEY);
      const catalog = snapshot?.value || emptyCatalog();
      if (catalog.schemaVersion !== 1 || !Number.isSafeInteger(catalog.revision) || !Array.isArray(catalog.items)) throw new Error('The gallery catalog is invalid; nothing was overwritten.');
      if (!change || !change(catalog)) return catalog;
      catalog.revision++;
      catalog.updatedAt = new Date().toISOString();
      try {
        await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: CATALOG_KEY, Body: JSON.stringify(catalog), ContentType: 'application/json', CacheControl: 'no-store', ...(snapshot ? { IfMatch: snapshot.etag } : { IfNoneMatch: '*' }) }));
        return catalog;
      } catch (error) { if (!conflict(error)) throw error; }
    }
    throw new Error('Other administrators are editing the gallery. Please retry this message.');
  }
  private async immutable(key: string, bytes: Buffer, contentType: string, input: UploadMessageInput) {
    const sha256 = digest(bytes);
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: key, Body: bytes, ContentType: contentType, CacheControl: 'public, max-age=31536000, immutable', Metadata: { sha256, discordauthor: input.authorId, discordmessage: input.messageId }, IfNoneMatch: '*' }));
    } catch (error) {
      if (!conflict(error)) throw error;
      const existing = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }));
      if (existing.Metadata?.sha256 !== sha256) throw new Error('A different object already owns this Discord attachment key; it was preserved.');
    }
  }
  private async manifest(key: string, target: MessageTarget) {
    const snapshot = await this.read<Manifest>(key);
    if (snapshot && (snapshot.value.schemaVersion !== 1 || snapshot.value.guildId !== target.guildId || snapshot.value.channelId !== target.channelId || snapshot.value.messageId !== target.messageId || !['pending', 'ready', 'deleting', 'deleted'].includes(snapshot.value.state) || !Array.isArray(snapshot.value.entries))) throw new Error('The Discord upload checkpoint is invalid; it was preserved.');
    if (snapshot) for (const entry of snapshot.value.entries) {
      const prefix = `media/discord/${target.guildId}/${target.channelId}/${target.messageId}/${entry.attachmentId}`;
      if (!/^\d{1,22}$/.test(entry.attachmentId) || entry.id !== itemId(target, entry.attachmentId) || entry.originalKey !== `${prefix}/original` || (entry.thumbnailKey !== undefined && entry.thumbnailKey !== `${prefix}/preview.jpg`) || (entry.record && (entry.record.id !== entry.id || entry.record.originalKey !== entry.originalKey || entry.record.thumbnailKey !== entry.thumbnailKey))) throw new Error('The Discord upload checkpoint has invalid media ownership; it was preserved.');
    }
    return snapshot;
  }
  uploadMessage(input: UploadMessageInput): Promise<{ uploaded: number }> {
    const key = targetKey(input);
    return this.serial(key, () => this.limitedUpload(async () => {
      if (!/^\d{1,22}$/.test(input.authorId) || !Number.isFinite(input.createdAt.getTime()) || input.createdAt.getUTCFullYear() < 1900 || input.createdAt.getUTCFullYear() > 2100 || !Array.isArray(input.attachments) || input.attachments.length > 10) throw new Error('Invalid Discord upload metadata.');
      if (!input.attachments.length) return { uploaded: 0 };
      if (input.attachments.some(attachment => !/^\d{1,22}$/.test(attachment.id)) || new Set(input.attachments.map(attachment => attachment.id)).size !== input.attachments.length) throw new Error('Discord attachment identifiers must be unique.');
      let snapshot = await this.manifest(key, input);
      if (snapshot?.value.state === 'deleted' || snapshot?.value.state === 'deleting') return { uploaded: 0 };
      if (snapshot && (snapshot.value.authorId !== input.authorId || input.attachments.length !== snapshot.value.entries.length || snapshot.value.entries.some(entry => !input.attachments.some(attachment => attachment.id === entry.attachmentId)))) throw new Error('This message checkpoint belongs to different attachments and was preserved.');
      if (snapshot?.value.state === 'ready') return { uploaded: snapshot.value.entries.length };
      const manifest: Manifest = snapshot?.value || { schemaVersion: 1, guildId: input.guildId, channelId: input.channelId, messageId: input.messageId, authorId: input.authorId, state: 'pending', entries: input.attachments.map(attachment => {
        const prefix = `media/discord/${input.guildId}/${input.channelId}/${input.messageId}/${attachment.id}`;
        return { attachmentId: attachment.id, id: itemId(input, attachment.id), originalKey: `${prefix}/original`, ...(this.config.publishToGallery ? { thumbnailKey: `${prefix}/preview.jpg` } : {}) };
      }) };
      let etag = snapshot?.etag || await this.writeManifest(key, manifest);
      for (const entry of manifest.entries) {
        if (entry.record) continue;
        const attachment = input.attachments.find(attachment => attachment.id === entry.attachmentId)!;
        const bytes = await download(attachment), prepared = await prepareImage(bytes);
        await this.immutable(entry.originalKey, bytes, prepared.contentType, input);
        if (entry.thumbnailKey) await this.immutable(entry.thumbnailKey, prepared.thumbnail, 'image/jpeg', input);
        const createdAt = input.createdAt.toISOString(), caption = input.caption.slice(0, 2000);
        entry.record = { id: entry.id, kind: 'photo', year: input.createdAt.getUTCFullYear(), published: true, order: input.createdAt.getTime(), createdAt, updatedAt: new Date().toISOString(), originalKey: entry.originalKey, thumbnailKey: entry.thumbnailKey, src: '', thumbnail: '', width: prepared.width, height: prepared.height, hash: prepared.hash, placeholder: prepared.placeholder, caption, alt: (caption || attachment.filename).slice(0, 500) };
        etag = await this.writeManifest(key, manifest, etag);
      }
      if (this.config.publishToGallery) await this.catalog(catalog => {
        let changed = false;
        for (const entry of manifest.entries) {
          const existing = catalog.items.find(item => item.id === entry.id);
          if (existing) { if (existing.originalKey !== entry.originalKey) throw new Error('A gallery identifier is already in use; the existing item was preserved.'); continue; }
          catalog.items.push(entry.record!); changed = true;
        }
        return changed;
      });
      manifest.state = 'ready';
      await this.writeManifest(key, manifest, etag);
      return { uploaded: manifest.entries.length };
    }));
  }
  hasMessage(input: MessageTarget): Promise<boolean> {
    const key = targetKey(input);
    return this.serial(key, async () => { const saved = await this.manifest(key, input); return Boolean(saved && saved.value.state !== 'deleted'); });
  }
  deleteMessage(input: MessageTarget): Promise<void> {
    const key = targetKey(input);
    return this.serial(key, async () => {
      const snapshot = await this.manifest(key, input);
      if (!snapshot || snapshot.value.state === 'deleted') return;
      const manifest = snapshot.value;
      manifest.state = 'deleting';
      const etag = await this.writeManifest(key, manifest, snapshot.etag);
      const owned = new Map(manifest.entries.map(entry => [entry.id, entry.originalKey]));
      await this.catalog(catalog => {
        const before = catalog.items.length;
        catalog.items = catalog.items.filter(item => owned.get(item.id) !== item.originalKey || !owned.has(item.id));
        return catalog.items.length !== before;
      });
      for (const objectKey of new Set(manifest.entries.flatMap(entry => [entry.originalKey, entry.thumbnailKey].filter((key): key is string => Boolean(key))))) {
        // Refresh before deletion so references from intervening admin edits are
        // preserved. Discord-owned media keys are never reused for new uploads.
        const catalog = await this.catalog();
        if (catalog.items.some(item => item.originalKey === objectKey || item.thumbnailKey === objectKey)) continue;
        await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: objectKey }));
      }
      manifest.state = 'deleted';
      await this.writeManifest(key, manifest, etag);
    });
  }
}
