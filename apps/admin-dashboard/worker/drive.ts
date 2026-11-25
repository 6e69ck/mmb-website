import {
  CONTENT_DRIVE_CACHE_PREFIX,
  DRIVE_CACHE_TTL_MS,
  type DriveFileEntry,
  type DriveFolderCache,
  type DriveFolderGroup,
} from '@mmb/content';
import { ApiError, type Env } from './types';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

export function driveCacheKey(folderId: string): string {
  return `${CONTENT_DRIVE_CACHE_PREFIX}${folderId}.json`;
}

export async function loadDriveCache(bucket: R2Bucket, folderId: string): Promise<DriveFolderCache | null> {
  if (!/^[a-zA-Z0-9_-]{10,120}$/.test(folderId)) return null;
  const obj = await bucket.get(driveCacheKey(folderId));
  if (!obj) return null;
  try {
    return await obj.json<DriveFolderCache>();
  } catch {
    return null;
  }
}

export function isDriveCacheStale(cache: DriveFolderCache | null, ttlMs = DRIVE_CACHE_TTL_MS): boolean {
  if (!cache?.syncedAt) return true;
  const ts = Date.parse(cache.syncedAt);
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts > ttlMs;
}

type RawDriveFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
};

async function queryDriveChildren(folderId: string, apiKey: string): Promise<RawDriveFile[]> {
  const q = `'${folderId}' in parents and trashed = false`;
  const params = new URLSearchParams({
    q,
    fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink)',
    orderBy: 'name_natural desc',
    pageSize: '100',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
    key: apiKey,
  });
  const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`);
  if (response.status === 403 || response.status === 404) {
    throw new ApiError(400, 'Could not read that Google Drive folder. Verify the folder ID and make sure it is shared as "Anyone with the link can view".');
  }
  if (!response.ok) {
    throw new ApiError(503, 'Google Drive is temporarily unavailable. Please try again.');
  }
  const data = (await response.json()) as { files?: RawDriveFile[] };
  return Array.isArray(data.files) ? data.files : [];
}

function normalizeEntry(raw: RawDriveFile): DriveFileEntry | null {
  if (!raw.id || !raw.name || !raw.mimeType) return null;
  const sizeNum = raw.size !== undefined ? Number(raw.size) : undefined;
  return {
    id: raw.id,
    name: raw.name,
    mimeType: raw.mimeType,
    modifiedTime: raw.modifiedTime || '',
    ...(sizeNum !== undefined && Number.isFinite(sizeNum) ? { size: sizeNum } : {}),
    webViewLink: raw.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(raw.id)}/view`,
  };
}

export async function syncDriveFolder(env: Env, folderId: string): Promise<DriveFolderCache> {
  if (!/^[a-zA-Z0-9_-]{10,120}$/.test(folderId)) {
    throw new ApiError(400, 'Invalid Google Drive folder ID.');
  }
  const apiKey = env.GOOGLE_DRIVE_API_KEY?.trim();
  if (!apiKey) {
    throw new ApiError(503, 'Google Drive sync is not configured yet (missing GOOGLE_DRIVE_API_KEY).');
  }

  const children = await queryDriveChildren(folderId, apiKey);
  const rootFiles: DriveFileEntry[] = [];
  const rawSubfolders: Array<{ id: string; name: string }> = [];

  for (const child of children) {
    if (child.mimeType === FOLDER_MIME && child.id && child.name) {
      rawSubfolders.push({ id: child.id, name: child.name });
    } else {
      const entry = normalizeEntry(child);
      if (entry) rootFiles.push(entry);
    }
  }

  const subfolders: DriveFolderGroup[] = await Promise.all(
    rawSubfolders.slice(0, 20).map(async folder => {
      const subChildren = await queryDriveChildren(folder.id, apiKey);
      const files = subChildren
        .filter(item => item.mimeType !== FOLDER_MIME)
        .map(normalizeEntry)
        .filter((item): item is DriveFileEntry => Boolean(item));
      return { id: folder.id, name: folder.name, files };
    })
  );

  const cache: DriveFolderCache = {
    folderId,
    syncedAt: new Date().toISOString(),
    rootFiles,
    subfolders,
  };
  await env.MEDIA.put(driveCacheKey(folderId), JSON.stringify(cache), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
  });
  return cache;
}
