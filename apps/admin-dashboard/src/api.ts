import type { UploadSession, UploadedPart } from '@mmb/gallery';

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && typeof options.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (options.method && options.method !== 'GET') headers.set('X-Requested-With', 'MMB-Gallery');
  const response = await fetch(path, { credentials: 'same-origin', redirect: 'manual', ...options, headers });
  if (response.type === 'opaqueredirect' || [301, 302, 303, 307, 308].includes(response.status)) throw new ApiError('Your sign-in has expired. Please sign in again to continue.', 401);
  const data = await response.json().catch(() => null) as ({ error?: string } & T) | null;
  if (!response.ok) throw new ApiError(data?.error || (response.status === 401 || response.status === 403 ? 'Please sign in with an authorized administrator account.' : 'That change could not be saved. Please try again.'), response.status);
  if (!data) throw new ApiError('The server returned an unexpected response. Please refresh and try again.', response.status);
  return data;
}

export async function uploadFile(file: File, signal: AbortSignal, progress: (fraction: number) => void): Promise<string> {
  const session = await api<UploadSession>('/api/admin/uploads', {
    method: 'POST', body: JSON.stringify({ filename: file.name, contentType: file.type, size: file.size }), signal,
  });
  try {
    const parts: UploadedPart[] = [];
    for (let number = 1; number <= session.partCount; number++) {
      const start = (number - 1) * session.partSize;
      parts.push(await api<UploadedPart>(`/api/admin/uploads/${session.id}/parts/${number}`, {
        method: 'PUT', body: file.slice(start, Math.min(file.size, start + session.partSize)), signal,
      }));
      progress(Math.min(file.size, start + session.partSize) / file.size);
    }
    const result = await api<{ key: string }>(`/api/admin/uploads/${session.id}/complete`, {
      method: 'POST', body: JSON.stringify({ parts }), signal,
    });
    return result.key;
  } catch (error) {
    await api(`/api/admin/uploads/${session.id}`, { method: 'DELETE' }).catch(() => {});
    // Completion may have reached the server immediately before cancellation.
    // Discard also covers that response-loss case; referenced items are protected.
    await api('/api/admin/uploads/discard', { method: 'POST', body: JSON.stringify({ keys: [session.key] }) }).catch(() => {});
    throw error;
  }
}

export type UploadedContentAsset = {
  assetKey: string;
  url: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
};

export async function uploadContentAsset(file: File, signal?: AbortSignal): Promise<UploadedContentAsset> {
  const contentType = inferUploadMime(file);
  return api<UploadedContentAsset>('/api/admin/content/assets', {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'X-Filename': encodeURIComponent(file.name),
    },
    body: file,
    signal,
  });
}

function inferUploadMime(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (ext === 'xls') return 'application/vnd.ms-excel';
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === 'csv') return 'text/csv';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'application/octet-stream';
}
