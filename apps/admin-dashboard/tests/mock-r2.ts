import { createHash, randomUUID } from 'node:crypto';

type Metadata = Record<string, string>;
type HttpMetadata = { contentType?: string; cacheControl?: string; contentDisposition?: string; contentEncoding?: string; contentLanguage?: string; cacheExpiry?: Date };
type Stored = { bytes: Uint8Array; etag: string; uploaded: Date; httpMetadata: HttpMetadata; customMetadata: Metadata };
type PutOptions = { onlyIf?: Headers | { etagMatches?: string; etagDoesNotMatch?: string }; httpMetadata?: HttpMetadata; customMetadata?: Metadata };
type Range = { offset?: number; length?: number; suffix?: number };
type Part = { partNumber: number; etag: string };

async function bytesOf(value: unknown): Promise<Uint8Array> {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ReadableStream) return new Uint8Array(await new Response(value).arrayBuffer());
  if (value === null || value === undefined) return new Uint8Array();
  throw new TypeError('Unsupported mock R2 body');
}

export class MockR2 {
  readonly objects = new Map<string, Stored>();
  readonly uploads = new Map<string, { key: string; options: PutOptions; parts: Map<number, { bytes: Uint8Array; etag: string }> }>();
  readonly deleted: string[] = [];
  conditionalConflicts = 0;

  private view(key: string, stored: Stored, range?: Range, body = false) {
    let offset = range?.suffix ? Math.max(0, stored.bytes.length - range.suffix) : (range?.offset ?? 0);
    let length = range?.suffix ? stored.bytes.length - offset : Math.min(range?.length ?? stored.bytes.length - offset, stored.bytes.length - offset);
    offset = Math.max(0, offset); length = Math.max(0, length);
    const selected = stored.bytes.slice(offset, offset + length);
    const metadata = {
      key, version: stored.etag, size: stored.bytes.length, etag: stored.etag,
      httpEtag: `"${stored.etag}"`, uploaded: stored.uploaded, storageClass: 'Standard',
      httpMetadata: { ...stored.httpMetadata }, customMetadata: { ...stored.customMetadata },
      checksums: {}, range: range ? { offset, length } : undefined,
      writeHttpMetadata(headers: Headers) {
        const names: Record<string, string> = { contentType: 'content-type', cacheControl: 'cache-control', contentDisposition: 'content-disposition', contentEncoding: 'content-encoding', contentLanguage: 'content-language' };
        for (const [key, value] of Object.entries(stored.httpMetadata)) if (typeof value === 'string' && names[key]) headers.set(names[key], value);
      },
    };
    if (!body) return metadata;
    return {
      ...metadata,
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(selected); controller.close(); } }),
      bodyUsed: false,
      arrayBuffer: async () => selected.buffer,
      text: async () => new TextDecoder().decode(selected),
      json: async <T = unknown>() => JSON.parse(new TextDecoder().decode(selected)) as T,
      blob: async () => new Blob([selected], { type: stored.httpMetadata.contentType }),
    };
  }

  async head(key: string) { const stored = this.objects.get(key); return stored ? this.view(key, stored) : null; }

  async get(key: string, options: { range?: Range | Headers; onlyIf?: Headers | { etagMatches?: string; etagDoesNotMatch?: string } } = {}) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    const condition = options.onlyIf;
    const match = condition instanceof Headers ? condition.get('if-match') : condition?.etagMatches;
    const noneMatch = condition instanceof Headers ? condition.get('if-none-match') : condition?.etagDoesNotMatch;
    if ((match && match !== '*' && match.replaceAll('"', '') !== stored.etag) || (noneMatch && (noneMatch === '*' || noneMatch.replaceAll('"', '') === stored.etag))) return this.view(key, stored);
    let range: Range | undefined;
    if (options.range instanceof Headers) {
      const match = options.range.get('range')?.match(/^bytes=(\d*)-(\d*)$/);
      if (match) range = match[1] ? { offset: Number(match[1]), length: match[2] ? Number(match[2]) - Number(match[1]) + 1 : undefined } : { suffix: Number(match[2]) };
    } else range = options.range;
    return this.view(key, stored, range, true);
  }

  async put(key: string, value: unknown, options: PutOptions = {}) {
    const bytes = await bytesOf(value);
    const current = this.objects.get(key);
    const condition = options.onlyIf;
    const match = condition instanceof Headers ? condition.get('if-match') : condition?.etagMatches;
    const noneMatch = condition instanceof Headers ? condition.get('if-none-match') : condition?.etagDoesNotMatch;
    if ((match && (!current || (match !== '*' && match.replaceAll('"', '') !== current.etag))) || (noneMatch && current && (noneMatch === '*' || noneMatch.replaceAll('"', '') === current.etag))) {
      this.conditionalConflicts++;
      return null;
    }
    const etag = createHash('sha256').update(bytes).digest('hex');
    const stored = { bytes, etag, uploaded: new Date(), httpMetadata: { ...options.httpMetadata }, customMetadata: { ...options.customMetadata } };
    this.objects.set(key, stored);
    return this.view(key, stored);
  }

  async delete(keys: string | string[]) {
    for (const key of typeof keys === 'string' ? [keys] : keys) { this.deleted.push(key); this.objects.delete(key); }
  }

  async list(options: { prefix?: string; limit?: number; cursor?: string } = {}) {
    const all = [...this.objects].filter(([key]) => key.startsWith(options.prefix || '')).sort(([a], [b]) => a.localeCompare(b));
    const offset = Number(options.cursor || 0), limit = options.limit || 1000;
    return { objects: all.slice(offset, offset + limit).map(([key, stored]) => this.view(key, stored)), truncated: offset + limit < all.length, cursor: offset + limit < all.length ? String(offset + limit) : undefined, delimitedPrefixes: [] };
  }

  async createMultipartUpload(key: string, options: PutOptions = {}) {
    const uploadId = randomUUID();
    this.uploads.set(uploadId, { key, options, parts: new Map() });
    return this.resumeMultipartUpload(key, uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string) {
    const find = () => {
      const upload = this.uploads.get(uploadId);
      if (!upload || upload.key !== key) throw new Error('Multipart upload does not exist');
      return upload;
    };
    return {
      key, uploadId,
      uploadPart: async (partNumber: number, value: unknown) => {
        const upload = find(), bytes = await bytesOf(value), etag = createHash('sha256').update(bytes).digest('hex');
        upload.parts.set(partNumber, { bytes, etag });
        return { partNumber, etag };
      },
      complete: async (parts: Part[]) => {
        const upload = find();
        const selected = parts.map(part => {
          const stored = upload.parts.get(part.partNumber);
          if (!stored || stored.etag !== part.etag) throw new Error('Invalid multipart part');
          return stored.bytes;
        });
        const bytes = new Uint8Array(selected.reduce((sum, part) => sum + part.length, 0));
        let offset = 0;
        for (const part of selected) { bytes.set(part, offset); offset += part.length; }
        const object = await this.put(key, bytes, upload.options);
        this.uploads.delete(uploadId);
        return object;
      },
      abort: async () => { find(); this.uploads.delete(uploadId); },
    };
  }
}
