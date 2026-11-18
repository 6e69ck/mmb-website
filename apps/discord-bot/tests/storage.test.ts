import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { isBlurhashValid } from 'blurhash';
import { CATALOG_KEY, MAX_IMAGE_SIZE, type GalleryCatalog, type GalleryPhoto } from '@mmb/gallery';
import { R2MediaStore } from '../src/storage.js';
import type { UploadMessageInput } from '../src/contracts.js';

const config = { endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com', accessKeyId: 'test-access-key', secretAccessKey: 'test-secret', bucket: 'mmb-media', publishToGallery: true };
const target = { guildId: '111111111111111111', channelId: '222222222222222222', messageId: '333333333333333333' };
const manifestKey = (messageId = target.messageId) => `gallery/v1/discord/messages/${target.guildId}/${target.channelId}/${messageId}.json`;
let png: Buffer;
const failure = (code: number) => Object.assign(new Error(`Mock S3 HTTP ${code}`), { $metadata: { httpStatusCode: code } });
type Stored = { body: Buffer; etag: string; contentType?: string; metadata?: Record<string, string> };
class MockS3 {
  objects = new Map<string, Stored>();
  events: string[] = [];
  catalogConflict = false;
  failPut: string | undefined;
  failDelete = false;
  sequence = 0;
  put(key: string, body: Buffer | string, contentType?: string, metadata?: Record<string, string>) {
    const object = { body: Buffer.from(body), etag: `"${++this.sequence}-${createHash('sha256').update(body).digest('hex')}"`, contentType, metadata };
    this.objects.set(key, object); return object;
  }
  value<T = any>(key: string): T { return JSON.parse(this.objects.get(key)!.body.toString()); }
  async send(command: { constructor: { name: string }; input: any }): Promise<any> {
    const input = command.input, key = input.Key as string, operation = command.constructor.name;
    this.events.push(`${operation}:${key}`);
    if (operation === 'GetObjectCommand') {
      const object = this.objects.get(key); if (!object) throw failure(404);
      return { ETag: object.etag, Body: { transformToString: async () => object.body.toString() } };
    }
    if (operation === 'HeadObjectCommand') {
      const object = this.objects.get(key); if (!object) throw failure(404);
      return { ETag: object.etag, Metadata: object.metadata };
    }
    if (operation === 'PutObjectCommand') {
      if (this.failPut && key.includes(this.failPut)) { this.failPut = undefined; throw failure(503); }
      if (key === CATALOG_KEY && this.catalogConflict) {
        this.catalogConflict = false;
        this.put(key, JSON.stringify({ schemaVersion: 1, revision: 1, updatedAt: new Date().toISOString(), items: [adminItem()] }));
      }
      const previous = this.objects.get(key);
      if ((input.IfNoneMatch === '*' && previous) || (input.IfMatch && previous?.etag !== input.IfMatch)) throw failure(412);
      const object = this.put(key, input.Body, input.ContentType, input.Metadata);
      return { ETag: object.etag };
    }
    if (operation === 'DeleteObjectCommand') {
      if (this.failDelete) { this.failDelete = false; throw failure(503); }
      this.objects.delete(key); return {};
    }
    throw new Error(`Unexpected mock command: ${operation}`);
  }
}
const adminItem = (): GalleryPhoto => ({ id: 'admin-photo', kind: 'photo', year: 2026, published: false, order: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', originalKey: 'media/uploads/admin/original.png', thumbnailKey: 'media/uploads/admin/preview.jpg', src: '', thumbnail: '', width: 1, height: 1, hash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', placeholder: 'data:image/png;base64,AA==', caption: 'Keep administrator edits', alt: '' });
const store = (mock: MockS3, publishToGallery = true) => new R2MediaStore({ ...config, publishToGallery }, mock as unknown as S3Client);
function input(overrides: Partial<UploadMessageInput> = {}): UploadMessageInput {
  return { ...target, authorId: '444444444444444444', createdAt: new Date('2026-03-04T12:00:00Z'), caption: 'A rehearsal caption, verbatim!', attachments: [{ id: '555555555555555555', url: 'https://cdn.discordapp.com/attachments/123/456/rehearsal.png?ex=abc&hm=signature', filename: 'rehearsal.png', contentType: 'image/jpeg', size: png.length }], ...overrides };
}
function imageFetch() { return vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(png), { headers: { 'Content-Length': String(png.length) } }))); }
beforeAll(async () => { png = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#720d2d' } }).png().toBuffer(); });
afterEach(() => vi.unstubAllGlobals());

describe('Discord R2 storage and publication', () => {
  it('publishes actual decoded image types, thumbnails and BlurHash while preserving captions', async () => {
    imageFetch(); const mock = new MockS3(), media = store(mock);
    expect(await media.uploadMessage(input())).toEqual({ uploaded: 1 });
    const catalog = mock.value<GalleryCatalog>(CATALOG_KEY), item = catalog.items[0] as GalleryPhoto;
    expect(catalog.revision).toBe(1);
    expect(item).toMatchObject({ kind: 'photo', year: 2026, published: true, caption: 'A rehearsal caption, verbatim!', width: 8, height: 6 });
    expect(isBlurhashValid(item.hash).result).toBe(true);
    expect(item.placeholder).toMatch(/^data:image\/png;base64,/);
    expect(mock.objects.get(item.originalKey!)?.contentType).toBe('image/png');
    expect(mock.objects.get(item.thumbnailKey!)?.contentType).toBe('image/jpeg');
    expect((await sharp(Buffer.from(item.placeholder.split(',')[1], 'base64')).metadata()).width).toBe(32);
    expect(await media.hasMessage(target)).toBe(true);
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  it('deduplicates replayed messages after restart and never resurrects a confirmed deletion', async () => {
    imageFetch(); const mock = new MockS3();
    await store(mock).uploadMessage(input());
    const before = mock.events.length;
    expect(await store(mock).uploadMessage(input())).toEqual({ uploaded: 1 });
    expect(mock.events.slice(before).every(event => event.startsWith('GetObjectCommand:'))).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    await store(mock).deleteMessage(target);
    expect(await store(mock).hasMessage(target)).toBe(false);
    expect(await store(mock).uploadMessage(input())).toEqual({ uploaded: 0 });
    expect(mock.value<GalleryCatalog>(CATALOG_KEY).items).toHaveLength(0);
    expect([...mock.objects.keys()].filter(key => key.startsWith('media/'))).toHaveLength(0);
  });

  it('retries catalog CAS conflicts and preserves another administrator’s additions', async () => {
    imageFetch(); const mock = new MockS3(); mock.catalogConflict = true;
    await store(mock).uploadMessage(input());
    const catalog = mock.value<GalleryCatalog>(CATALOG_KEY);
    expect(catalog.items).toHaveLength(2);
    expect(catalog.items.find(item => item.id === 'admin-photo')).toEqual(adminItem());
    expect(catalog.revision).toBe(2);
  });

  it('recovers a failed catalog save from persistent media checkpoints without downloading twice', async () => {
    imageFetch(); const mock = new MockS3(); mock.failPut = CATALOG_KEY;
    await expect(store(mock).uploadMessage(input())).rejects.toThrow('503');
    expect(mock.value(manifestKey()).state).toBe('pending');
    expect(await store(mock).uploadMessage(input())).toEqual({ uploaded: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mock.value<GalleryCatalog>(CATALOG_KEY).items).toHaveLength(1);
  });

  it('deletes partial image uploads after restart and retries interrupted cleanup', async () => {
    imageFetch(); const mock = new MockS3(); mock.failPut = '/preview.jpg';
    await expect(store(mock).uploadMessage(input())).rejects.toThrow('503');
    expect([...mock.objects.keys()].filter(key => key.startsWith('media/'))).toHaveLength(1);
    mock.failDelete = true;
    await expect(store(mock).deleteMessage(target)).rejects.toThrow('503');
    expect(mock.value(manifestKey()).state).toBe('deleting');
    await store(mock).deleteMessage(target);
    await store(mock).deleteMessage(target);
    expect([...mock.objects.keys()].filter(key => key.startsWith('media/'))).toHaveLength(0);
    expect(mock.value(manifestKey()).state).toBe('deleted');
  });

  it('removes only this message’s catalog items before deleting unreferenced objects', async () => {
    imageFetch(); const mock = new MockS3(), media = store(mock); await media.uploadMessage(input());
    const catalog = mock.value<GalleryCatalog>(CATALOG_KEY), botItem = catalog.items[0];
    const other = { ...adminItem(), originalKey: botItem.originalKey };
    catalog.items.push(other); mock.put(CATALOG_KEY, JSON.stringify(catalog));
    const originalKey = botItem.originalKey!, previewKey = botItem.thumbnailKey!;
    const offset = mock.events.length;
    await media.deleteMessage(target);
    expect(mock.value<GalleryCatalog>(CATALOG_KEY).items).toEqual([other]);
    expect(mock.objects.has(originalKey)).toBe(true);
    expect(mock.objects.has(previewKey)).toBe(false);
    const events = mock.events.slice(offset);
    expect(events.indexOf(`PutObjectCommand:${CATALOG_KEY}`)).toBeLessThan(events.indexOf(`DeleteObjectCommand:${previewKey}`));
  });

  it('serializes upload and deletion of the same message', async () => {
    imageFetch(); const mock = new MockS3(), media = store(mock);
    await Promise.all([media.uploadMessage(input()), media.deleteMessage(target)]);
    expect(await media.hasMessage(target)).toBe(false);
    expect(mock.value<GalleryCatalog>(CATALOG_KEY).items).toHaveLength(0);
  });

  it('bounds concurrent message downloads to avoid unbounded image decoding memory', async () => {
    let active = 0, maximum = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active--;
      return new Response(new Uint8Array(png));
    }));
    const mock = new MockS3(), media = store(mock);
    await Promise.all(['333333333333333331', '333333333333333332', '333333333333333333', '333333333333333334'].map(messageId => media.uploadMessage(input({ messageId }))));
    expect(maximum).toBeLessThanOrEqual(2);
    expect(mock.value<GalleryCatalog>(CATALOG_KEY).items).toHaveLength(4);
  });

  it('can store validated images privately without publishing a gallery catalog', async () => {
    imageFetch(); const mock = new MockS3(); await store(mock, false).uploadMessage(input());
    expect(mock.objects.has(CATALOG_KEY)).toBe(false);
    expect([...mock.objects.keys()].filter(key => key.startsWith('media/'))).toHaveLength(1);
    expect(await store(mock, false).hasMessage(target)).toBe(true);
  });
});

describe('Discord image download boundaries', () => {
  it('rejects non-Discord, non-HTTPS and credential-bearing URLs without fetching them', async () => {
    imageFetch();
    for (const url of ['http://cdn.discordapp.com/image.png', 'https://example.com/image.png', 'https://cdn.discordapp.com.example.com/image.png', 'https://user:pass@cdn.discordapp.com/image.png', 'https://cdn.discordapp.com:444/image.png']) {
      const value = input(); value.attachments[0].url = url;
      await expect(store(new MockS3()).uploadMessage(value)).rejects.toThrow('HTTPS attachments hosted by Discord');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects oversized attachments and oversized streamed bodies, canceling the reader', async () => {
    imageFetch(); const oversized = input(); oversized.attachments[0].size = MAX_IMAGE_SIZE + 1;
    await expect(store(new MockS3()).uploadMessage(oversized)).rejects.toThrow('25 MB');
    expect(fetch).not.toHaveBeenCalled();
    let canceled = false;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_IMAGE_SIZE + 1)); }, cancel() { canceled = true; } }))));
    const mock = new MockS3();
    await expect(store(mock).uploadMessage(input())).rejects.toThrow('25 MB');
    expect(canceled).toBe(true);
    expect([...mock.objects.keys()].some(key => key.startsWith('media/'))).toBe(false);
  });

  it('rejects arbitrary files disguised as photos before writing media objects', async () => {
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)));
    const value = input(); value.attachments[0].size = bytes.length;
    const mock = new MockS3();
    await expect(store(mock).uploadMessage(value)).rejects.toThrow('valid JPEG, PNG, WebP, or GIF');
    expect([...mock.objects.keys()].some(key => key.startsWith('media/'))).toBe(false);
  });

  it('preserves corrupted message ownership metadata instead of deleting arbitrary objects', async () => {
    imageFetch(); const mock = new MockS3(); await store(mock).uploadMessage(input());
    const value = mock.value(manifestKey()); value.entries[0].originalKey = 'media/uploads/someone-else/image.png';
    mock.put(manifestKey(), JSON.stringify(value));
    const count = mock.events.length;
    await expect(store(mock).deleteMessage(target)).rejects.toThrow('invalid media ownership');
    expect(mock.events.slice(count).some(event => event.startsWith('DeleteObjectCommand:'))).toBe(false);
  });
});
