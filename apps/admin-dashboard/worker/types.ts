export interface Env {
  MEDIA: R2Bucket;
  ASSETS?: Fetcher;
  ENVIRONMENT: string;
  DEV_AUTH?: string;
  ADMIN_EMAILS: string;
  ADMIN_ORIGIN: string;
  PUBLIC_MEDIA_ORIGIN: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const isLocal = (request: Request, env: Env) => env.ENVIRONMENT === 'development' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname);
export function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...Object.fromEntries(new Headers(headers)) } });
}
export async function boundedBytes(request: Request, maximum: number): Promise<Uint8Array> {
  const declared = request.headers.get('Content-Length');
  if (declared && Number(declared) > maximum) throw new ApiError(413, 'This request is too large.');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new ApiError(413, 'This request is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
export async function bodyJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new ApiError(415, 'Send JSON for this action.');
  const text = new TextDecoder().decode(await boundedBytes(request, 128 * 1024));
  try { const body = JSON.parse(text); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body; }
  catch { throw new ApiError(400, 'This request contains invalid JSON.'); }
}
