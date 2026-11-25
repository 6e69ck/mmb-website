import {
  CONTENT_ASSET_PREFIX,
  CONTENT_DOC_TYPES,
  CONTENT_HISTORY_PREFIX,
  CONTENT_IMAGE_TYPES,
  CONTENT_PAGE_PREFIX,
  MAX_CONTENT_ASSET_SIZE,
  PAGE_METADATA,
  PAGE_SLUGS,
  assetPublicUrl,
  collectPageAssetKeys,
  extractDriveFolderId,
  isPageSlug,
  isSafeContentAssetKey,
  validatePageInput,
  validateStoredPageDocument,
  type DriveFolderCache,
  type PageDocument,
  type PageSlug,
} from '@mmb/content';
import { authenticate } from './auth';
import { isDriveCacheStale, loadDriveCache, syncDriveFolder } from './drive';
import {
  commitPageToGitHub,
  getPageVersionFromGitHub,
  isGitHubConfigured,
  listPageHistoryFromGitHub,
  type PageVersionSummary,
} from './github';
import { ApiError, bodyJson, boundedBytes, isLocal, json, type Env } from './types';

const publicHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-cache, must-revalidate',
};

const CONTENT_ALLOWED_TYPES = [
  ...CONTENT_IMAGE_TYPES,
  ...CONTENT_DOC_TYPES,
] as readonly string[];

const INLINE_SERVE_TYPES = new Set<string>([
  ...CONTENT_IMAGE_TYPES,
  'application/pdf',
]);

export function pageStorageKey(slug: PageSlug): string {
  return `${CONTENT_PAGE_PREFIX}${slug}.json`;
}

export function defaultPageDocument(slug: PageSlug): PageDocument {
  const meta = PAGE_METADATA[slug];
  return {
    schemaVersion: 1,
    slug,
    revision: 0,
    updatedAt: new Date(0).toISOString(),
    updatedBy: 'unseeded',
    seo: {
      title: meta.defaultTitle,
      description: meta.defaultDescription,
    },
    blocks: [],
  };
}

export async function loadPage(
  bucket: R2Bucket,
  slug: PageSlug
): Promise<{ page: PageDocument; etag?: string; exists: boolean }> {
  const obj = await bucket.get(pageStorageKey(slug));
  if (!obj) return { page: defaultPageDocument(slug), exists: false };
  let raw: unknown;
  try {
    raw = await obj.json();
  } catch {
    throw new ApiError(503, `Stored content for ${slug} could not be read.`);
  }
  try {
    return { page: validateStoredPageDocument(raw), etag: obj.etag, exists: true };
  } catch {
    throw new ApiError(503, `Stored content for ${slug} has an unsupported format.`);
  }
}

export async function loadDriveCachesForPage(
  bucket: R2Bucket,
  doc: PageDocument
): Promise<Record<string, DriveFolderCache>> {
  const folderIds = [
    ...new Set(
      doc.blocks
        .filter(block => block.type === 'drive-minutes' && Boolean(block.folderId))
        .map(block => (block.type === 'drive-minutes' ? block.folderId : ''))
        .filter(Boolean)
    ),
  ];
  const entries = await Promise.all(
    folderIds.map(async id => {
      const cache = await loadDriveCache(bucket, id);
      return cache ? ([id, cache] as const) : null;
    })
  );
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, DriveFolderCache] => Boolean(entry)));
}

function sanitizeAssetFilename(rawName: string): string {
  const cleaned = rawName
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^-+|-+$/g, '')
    .slice(-100);
  return cleaned || 'upload';
}

function validContentAssetSignature(bytes: Uint8Array, type: string): boolean {
  if (!bytes.length) return false;
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/png') return [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b);
  if (type === 'image/gif') return ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
  if (type === 'image/webp') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
  if (type === 'application/pdf') return ascii(0, 5) === '%PDF-';
  if (
    type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05) && (bytes[3] === 0x04 || bytes[3] === 0x06);
  }
  if (type === 'application/vnd.ms-excel') {
    return [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((b, i) => bytes[i] === b);
  }
  if (type === 'text/csv') {
    if (bytes.some(b => b === 0)) return false;
    try {
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

async function isContentAssetReferenced(bucket: R2Bucket, assetKey: string): Promise<boolean> {
  const results = await Promise.all(
    PAGE_SLUGS.map(async slug => {
      try {
        const { page, exists } = await loadPage(bucket, slug);
        return exists && collectPageAssetKeys(page).includes(assetKey);
      } catch {
        return false;
      }
    })
  );
  return results.some(Boolean);
}

export async function publicContent(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new ApiError(405, 'This method is not supported.');
  }
  const slug = path.replace(/^\/api\/content\//, '');
  if (!isPageSlug(slug)) {
    throw new ApiError(404, 'Page content not found.');
  }
  const { page, exists } = await loadPage(env.MEDIA, slug);
  if (!exists) {
    throw new ApiError(404, 'Page content has not been initialized yet.');
  }
  const driveCaches = await loadDriveCachesForPage(env.MEDIA, page);
  const driveStamp = Object.values(driveCaches)
    .map(c => c.syncedAt)
    .sort()
    .join(',');
  const etag = `"content-${slug}-${page.revision}${driveStamp ? `-${driveStamp}` : ''}"`;
  if (request.headers.get('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers: { ...publicHeaders, ETag: etag } });
  }
  return json({ page, driveCaches }, 200, { ...publicHeaders, ETag: etag });
}

export async function publicContentFile(request: Request, env: Env, path: string): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) {
    throw new ApiError(405, 'This method is not supported.');
  }
  let decodedSubpath: string;
  try {
    decodedSubpath = decodeURIComponent(path.slice('/files/'.length));
  } catch {
    throw new ApiError(404, 'File not found.');
  }
  const key = `${CONTENT_ASSET_PREFIX}${decodedSubpath}`;
  if (!isSafeContentAssetKey(key)) {
    throw new ApiError(404, 'File not found.');
  }

  const referenced = await isContentAssetReferenced(env.MEDIA, key);
  if (!referenced) {
    if (!isLocal(request, env) && new URL(request.url).origin !== env.ADMIN_ORIGIN) {
      throw new ApiError(404, 'File not found.');
    }
    await authenticate(request, env);
  }

  const head = await env.MEDIA.head(key);
  if (!head) throw new ApiError(404, 'File not found.');

  const contentType = head.httpMetadata?.contentType || 'application/octet-stream';
  const filename = key.split('/').pop() || 'file';
  const disposition = INLINE_SERVE_TYPES.has(contentType)
    ? 'inline'
    : `attachment; filename="${filename.replaceAll('"', '')}"`;

  const etag = head.httpEtag || `"${head.etag}"`;
  const headers = new Headers({
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': contentType,
    'Content-Disposition': disposition,
    'Cache-Control': referenced ? 'public, max-age=31536000, immutable' : 'private, no-store',
    ETag: etag,
  });

  if (request.headers.get('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers });
  }
  headers.set('Content-Length', String(head.size));
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });

  const object = await env.MEDIA.get(key);
  if (!object || !('body' in object)) throw new ApiError(404, 'File not found.');
  return new Response(object.body, { status: 200, headers });
}

async function listR2History(bucket: R2Bucket, slug: PageSlug, limit = 25): Promise<PageVersionSummary[]> {
  const prefix = `${CONTENT_HISTORY_PREFIX}${slug}/rev-`;
  const listed = await bucket.list({ prefix, limit: 100 });
  const versions: Array<{ rev: number; summary: PageVersionSummary }> = [];
  for (const obj of listed.objects) {
    const revMatch = obj.key.match(/\/rev-(\d+)\.json$/);
    if (!revMatch) continue;
    const rev = Number(revMatch[1]);
    const stored = await bucket.get(obj.key);
    if (!stored) continue;
    try {
      const parsed = validateStoredPageDocument(await stored.json());
      versions.push({
        rev,
        summary: {
          versionId: `rev-${rev}`,
          shortId: `v${rev}`,
          message: parsed.commitMessage || `Revision ${rev}`,
          author: parsed.updatedBy,
          timestamp: parsed.updatedAt,
          source: 'r2',
        },
      });
    } catch {
      // Skip malformed historical snapshot
    }
  }
  return versions
    .sort((a, b) => b.rev - a.rev)
    .slice(0, limit)
    .map(item => item.summary);
}

async function getR2HistoryVersion(bucket: R2Bucket, slug: PageSlug, versionId: string): Promise<PageDocument> {
  const match = versionId.match(/^rev-(\d+)$/);
  if (!match) throw new ApiError(400, 'Invalid revision identifier.');
  const obj = await bucket.get(`${CONTENT_HISTORY_PREFIX}${slug}/rev-${match[1]}.json`);
  if (!obj) throw new ApiError(404, 'Requested revision was not found.');
  try {
    return validateStoredPageDocument(await obj.json());
  } catch {
    throw new ApiError(503, 'Stored revision could not be parsed.');
  }
}

async function savePage(
  env: Env,
  slug: PageSlug,
  input: {
    seo: PageDocument['seo'];
    blocks: PageDocument['blocks'];
    commitMessage?: string;
    expectedRevision?: number;
    expectedGitSha?: string;
  },
  email: string
): Promise<{ page: PageDocument; driveCaches: Record<string, DriveFolderCache> }> {
  const current = await loadPage(env.MEDIA, slug);
  if (input.expectedRevision !== undefined && input.expectedRevision !== current.page.revision) {
    throw new ApiError(409, 'This page was updated by another administrator. Refresh before saving.');
  }

  const nextRevision = current.page.revision + 1;
  const commitMessage = input.commitMessage || `Update ${PAGE_METADATA[slug].label} (rev ${nextRevision})`;
  const now = new Date(Math.max(Date.now(), Date.parse(current.page.updatedAt) + 1)).toISOString();

  const nextDoc: PageDocument = {
    schemaVersion: 1,
    slug,
    revision: nextRevision,
    ...(current.page.gitSha ? { gitSha: current.page.gitSha } : {}),
    commitMessage,
    updatedAt: now,
    updatedBy: email,
    seo: input.seo,
    blocks: input.blocks,
  };

  if (isGitHubConfigured(env)) {
    const committed = await commitPageToGitHub(env, slug, nextDoc, {
      authorEmail: email,
      commitMessage,
      expectedGitSha: input.expectedGitSha ?? current.page.gitSha,
    });
    nextDoc.gitSha = committed.fileSha;
  }

  const serialized = JSON.stringify(nextDoc, null, 2);
  const saved = await env.MEDIA.put(pageStorageKey(slug), serialized, {
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
    onlyIf: current.etag ? { etagMatches: current.etag } : { etagDoesNotMatch: '*' },
  });
  if (!saved) {
    throw new ApiError(409, 'Another administrator just published changes to this page. Refresh and try again.');
  }

  await env.MEDIA.put(`${CONTENT_HISTORY_PREFIX}${slug}/rev-${nextRevision}.json`, serialized, {
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
  });

  // Trigger a Drive sync if the page has Drive blocks and cache is missing/stale
  if (env.GOOGLE_DRIVE_API_KEY?.trim()) {
    for (const block of nextDoc.blocks) {
      if (block.type === 'drive-minutes' && block.folderId) {
        const cached = await loadDriveCache(env.MEDIA, block.folderId);
        if (isDriveCacheStale(cached)) {
          await syncDriveFolder(env, block.folderId).catch(() => {});
        }
      }
    }
  }

  const driveCaches = await loadDriveCachesForPage(env.MEDIA, nextDoc);
  return { page: nextDoc, driveCaches };
}

export async function adminPages(request: Request, env: Env, email: string, path: string): Promise<Response> {
  if (path === '/api/admin/pages' && request.method === 'GET') {
    const pages = await Promise.all(
      PAGE_SLUGS.map(async slug => {
        const meta = PAGE_METADATA[slug];
        const { page, exists } = await loadPage(env.MEDIA, slug);
        return {
          slug,
          label: meta.label,
          path: meta.path,
          seeded: exists,
          revision: page.revision,
          gitSha: page.gitSha || null,
          updatedAt: page.updatedAt,
          updatedBy: page.updatedBy,
          title: page.seo.title,
          blockCount: page.blocks.length,
        };
      })
    );
    return json({
      pages,
      historyProvider: isGitHubConfigured(env) ? 'github' : 'r2',
      driveConfigured: Boolean(env.GOOGLE_DRIVE_API_KEY?.trim()),
    });
  }

  const detailMatch = path.match(/^\/api\/admin\/pages\/([a-z0-9-]+)(?:\/(history|rollback)(?:\/([a-zA-Z0-9_-]+))?)?$/);
  if (!detailMatch) throw new ApiError(404, 'Page endpoint not found.');

  const slug = detailMatch[1];
  if (!isPageSlug(slug)) throw new ApiError(404, 'Editable page not found.');
  const action = detailMatch[2];
  const versionId = detailMatch[3];

  if (!action) {
    if (request.method === 'GET') {
      const { page, exists } = await loadPage(env.MEDIA, slug);
      const driveCaches = await loadDriveCachesForPage(env.MEDIA, page);
      return json({
        page,
        seeded: exists,
        driveCaches,
        historyProvider: isGitHubConfigured(env) ? 'github' : 'r2',
        driveConfigured: Boolean(env.GOOGLE_DRIVE_API_KEY?.trim()),
      });
    }
    if (request.method === 'PUT') {
      const body = await bodyJson(request, 512 * 1024);
      let validated;
      try {
        validated = validatePageInput(slug, body);
      } catch (err) {
        throw new ApiError(400, err instanceof Error ? err.message : 'Invalid page content.');
      }
      const expectedRevision = body.expectedRevision !== undefined ? Number(body.expectedRevision) : undefined;
      if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
        throw new ApiError(400, 'Invalid expectedRevision.');
      }
      const expectedGitSha = typeof body.expectedGitSha === 'string' && body.expectedGitSha ? body.expectedGitSha : undefined;
      const result = await savePage(env, slug, { ...validated, expectedRevision, expectedGitSha }, email);
      return json(result);
    }
    throw new ApiError(405, 'This method is not supported.');
  }

  if (action === 'history' && request.method === 'GET') {
    if (versionId) {
      const page = isGitHubConfigured(env)
        ? await getPageVersionFromGitHub(env, slug, versionId)
        : await getR2HistoryVersion(env.MEDIA, slug, versionId);
      return json({ page });
    }
    const versions = isGitHubConfigured(env)
      ? await listPageHistoryFromGitHub(env, slug)
      : await listR2History(env.MEDIA, slug);
    return json({ versions, provider: isGitHubConfigured(env) ? 'github' : 'r2' });
  }

  if (action === 'rollback' && !versionId && request.method === 'POST') {
    const body = await bodyJson(request, 2 * 1024 * 1024);
    const targetVersion = typeof body.versionId === 'string' ? body.versionId.trim() : '';
    if (!targetVersion) throw new ApiError(400, 'Choose a version to restore.');
    const targetDoc = isGitHubConfigured(env)
      ? await getPageVersionFromGitHub(env, slug, targetVersion)
      : await getR2HistoryVersion(env.MEDIA, slug, targetVersion);
    const expectedRevision = body.expectedRevision !== undefined ? Number(body.expectedRevision) : undefined;
    const expectedGitSha = typeof body.expectedGitSha === 'string' && body.expectedGitSha ? body.expectedGitSha : undefined;
    const customMsg = typeof body.commitMessage === 'string' ? body.commitMessage.trim().slice(0, 240) : '';
    const commitMessage = customMsg || `Restore ${PAGE_METADATA[slug].label} to ${targetVersion.slice(0, 7)}`;
    const result = await savePage(
      env,
      slug,
      {
        seo: targetDoc.seo,
        blocks: targetDoc.blocks,
        commitMessage,
        expectedRevision,
        expectedGitSha,
      },
      email
    );
    return json(result);
  }

  throw new ApiError(405, 'This method is not supported.');
}

export async function adminContentAssets(request: Request, env: Env, email: string, path: string): Promise<Response> {
  if (path !== '/api/admin/content/assets' || request.method !== 'POST') {
    throw new ApiError(404, 'Asset action not found.');
  }
  const contentType = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!CONTENT_ALLOWED_TYPES.includes(contentType)) {
    throw new ApiError(400, 'Upload a JPEG, PNG, WebP, GIF, PDF, XLSX, XLS, DOCX, or CSV file.');
  }
  let rawFilename = request.headers.get('X-Filename') || 'upload';
  try {
    rawFilename = decodeURIComponent(rawFilename);
  } catch {
    // Keep raw value if malformed URI encoding
  }
  const filename = sanitizeAssetFilename(rawFilename);
  const bytes = await boundedBytes(request, MAX_CONTENT_ASSET_SIZE);
  if (!bytes.length) throw new ApiError(400, 'Uploaded file is empty.');
  if (!validContentAssetSignature(bytes, contentType)) {
    throw new ApiError(400, 'This file does not match its declared format.');
  }

  const id = crypto.randomUUID();
  const assetKey = `${CONTENT_ASSET_PREFIX}${id}/${filename}`;
  await env.MEDIA.put(assetKey, bytes, {
    httpMetadata: {
      contentType,
      cacheControl: 'public, max-age=31536000, immutable',
    },
    customMetadata: {
      uploadedBy: email,
      originalFilename: filename,
    },
  });

  return json(
    {
      assetKey,
      url: assetPublicUrl(assetKey),
      filename,
      contentType,
      sizeBytes: bytes.byteLength,
    },
    201
  );
}

export async function adminDriveSync(request: Request, env: Env, path: string): Promise<Response> {
  if (path !== '/api/admin/drive/sync' || request.method !== 'POST') {
    throw new ApiError(404, 'Drive sync action not found.');
  }
  const body = await bodyJson(request, 2 * 1024 * 1024);
  const rawInput = typeof body.folderUrl === 'string' ? body.folderUrl : typeof body.folderId === 'string' ? body.folderId : '';
  const folderId = extractDriveFolderId(rawInput);
  if (!folderId) {
    throw new ApiError(400, 'Enter a valid Google Drive folder URL or folder ID.');
  }
  const cache = await syncDriveFolder(env, folderId);
  return json({ cache });
}

export async function adminContentImport(request: Request, env: Env, path: string): Promise<Response> {
  if (!isLocal(request, env)) throw new ApiError(404, 'Not found.');
  if (path !== '/api/admin/content/import' || request.method !== 'POST') {
    throw new ApiError(404, 'Content import action not found.');
  }
  const body = await bodyJson(request, 2 * 1024 * 1024);
  if (!Array.isArray(body.pages)) {
    throw new ApiError(400, 'Provide a pages array to import.');
  }
  let imported = 0;
  let skipped = 0;
  for (const rawPage of body.pages) {
    let doc: PageDocument;
    try {
      doc = validateStoredPageDocument(rawPage);
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : 'Invalid seed page.');
    }
    const serialized = JSON.stringify(doc, null, 2);
    const putResult = await env.MEDIA.put(pageStorageKey(doc.slug), serialized, {
      httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
      onlyIf: { etagDoesNotMatch: '*' },
    });
    if (putResult) {
      await env.MEDIA.put(`${CONTENT_HISTORY_PREFIX}${doc.slug}/rev-${doc.revision}.json`, serialized, {
        httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
      });
      imported++;
    } else {
      skipped++;
    }
  }
  return json({ imported, skipped });
}
