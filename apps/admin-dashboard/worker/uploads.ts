import { IMAGE_TYPES, VIDEO_TYPES, MAX_IMAGE_SIZE, MAX_VIDEO_SIZE, PART_SIZE, UPLOAD_PREFIX, type UploadedPart } from '@mmb/gallery';
import { ApiError, bodyJson, boundedBytes, json, type Env } from './types';
import { loadCatalog } from './catalog';
type Session = { id: string; key: string; uploadId: string; contentType: string; size: number; owner: string; createdAt: number };
const allowedTypes = [...IMAGE_TYPES, ...VIDEO_TYPES] as readonly string[];
async function sessionFor(id: string, env: Env, email: string) {
  if (!/^[\w-]{36}$/.test(id)) throw new ApiError(404, 'Upload not found.');
  const object = await env.MEDIA.get(`${UPLOAD_PREFIX}${id}.json`);
  if (!object) throw new ApiError(404, 'Upload not found or already finished.');
  const session = await object.json<Session>();
  if (session.owner !== email) throw new ApiError(403, 'This upload belongs to another administrator.');
  if (Date.now() - session.createdAt > 60 * 60 * 1000) throw new ApiError(410, 'This upload expired. Please upload the file again.');
  return session;
}
function validSignature(bytes: Uint8Array, type: string) {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/png') return [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  if (type === 'image/gif') return ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
  if (type === 'image/webp') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
  if (type === 'video/mp4') return ascii(4, 8) === 'ftyp';
  return type === 'video/webm' && [0x1a, 0x45, 0xdf, 0xa3].every((byte, index) => bytes[index] === byte);
}
export async function uploads(request: Request, env: Env, email: string, path: string) {
  if (path === '/api/admin/uploads/discard' && request.method === 'POST') {
    const body = await bodyJson(request);
    if (!Array.isArray(body.keys) || body.keys.length > 40 || body.keys.some(key => typeof key !== 'string' || !/^media\/uploads\/[\w-]{36}\/[\w.-]+$/.test(key))) throw new ApiError(400, 'Invalid unused upload list.');
    const { catalog } = await loadCatalog(env.MEDIA);
    const referenced = new Set(catalog.items.flatMap(item => [item.originalKey, item.thumbnailKey]));
    let removed = 0;
    for (const key of [...new Set(body.keys as string[])]) {
      if (referenced.has(key)) continue;
      const object = await env.MEDIA.head(key);
      if (!object) continue;
      if (object.customMetadata?.uploadedBy !== email) throw new ApiError(403, 'This upload belongs to another administrator.');
      await env.MEDIA.delete(key); removed++;
    }
    return json({ removed });
  }
  if (path === '/api/admin/uploads' && request.method === 'POST') {
    const body = await bodyJson(request);
    const contentType = String(body.contentType || '');
    if (!allowedTypes.includes(contentType)) throw new ApiError(400, 'Upload a JPEG, PNG, WebP, GIF, MP4, or WebM file.');
    const size = Number(body.size), maximum = contentType.startsWith('image/') ? MAX_IMAGE_SIZE : MAX_VIDEO_SIZE;
    if (!Number.isSafeInteger(size) || size <= 0 || size > maximum) throw new ApiError(400, contentType.startsWith('image/') ? 'Photos must be 25 MB or smaller.' : 'Videos must be 1 GB or smaller.');
    if (typeof body.filename !== 'string' || !body.filename.trim()) throw new ApiError(400, 'Choose a file to upload.');
    const filename = body.filename.normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/\.{2,}/g, '.').slice(-100) || 'upload';
    const id = crypto.randomUUID(), key = `media/uploads/${id}/${filename}`;
    const upload = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' }, customMetadata: { uploadedBy: email } });
    const session: Session = { id, key, uploadId: upload.uploadId, contentType, size, owner: email, createdAt: Date.now() };
    await env.MEDIA.put(`${UPLOAD_PREFIX}${id}.json`, JSON.stringify(session), { httpMetadata: { contentType: 'application/json' } });
    return json({ id, key, partSize: PART_SIZE, partCount: Math.ceil(size / PART_SIZE) }, 201);
  }
  const match = path.match(/^\/api\/admin\/uploads\/([\w-]+)(?:\/(parts\/(\d+)|complete))?$/);
  if (!match) throw new ApiError(404, 'Upload action not found.');
  const session = await sessionFor(match[1], env, email);
  const upload = env.MEDIA.resumeMultipartUpload(session.key, session.uploadId);
  if (match[3] && request.method === 'PUT') {
    const number = Number(match[3]), count = Math.ceil(session.size / PART_SIZE);
    if (number < 1 || number > count || !Number.isSafeInteger(number)) throw new ApiError(400, 'Invalid upload part number.');
    const expected = number === count ? session.size - PART_SIZE * (count - 1) : PART_SIZE;
    const declared = request.headers.get('Content-Length');
    if (declared && Number(declared) !== expected) throw new ApiError(400, 'The upload part has the wrong size.');
    const bytes = await boundedBytes(request, expected);
    if (bytes.byteLength !== expected) throw new ApiError(400, 'The upload part has the wrong size.');
    if (number === 1 && !validSignature(bytes, session.contentType)) throw new ApiError(400, 'This file does not match its declared format.');
    return json(await upload.uploadPart(number, bytes));
  }
  if (match[2] === 'complete' && request.method === 'POST') {
    const body = await bodyJson(request);
    const parts = body.parts as UploadedPart[];
    const count = Math.ceil(session.size / PART_SIZE);
    if (!Array.isArray(parts) || parts.length !== count || parts.some((part, index) => !part || part.partNumber !== index + 1 || typeof part.etag !== 'string' || !part.etag || part.etag.length > 200)) throw new ApiError(400, 'The upload is incomplete. Retry the missing parts.');
    try {
      const object = await upload.complete(parts);
      if (object.size !== session.size) { await env.MEDIA.delete(session.key); throw new ApiError(400, 'The completed upload has the wrong size.'); }
    } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, 'The upload could not be completed. Please try uploading again.'); }
    await env.MEDIA.delete(`${UPLOAD_PREFIX}${session.id}.json`);
    return json({ key: session.key });
  }
  if (!match[2] && request.method === 'DELETE') {
    try { await upload.abort(); } finally { await env.MEDIA.delete(`${UPLOAD_PREFIX}${session.id}.json`); }
    return json({ aborted: true });
  }
  throw new ApiError(405, 'This method is not supported.');
}
