interface OriginalImageObject {
  body: ReadableStream<Uint8Array>;
  size: number;
  httpEtag: string;
  httpMetadata?: { contentType?: string };
}

interface OriginalImageBucket {
  head(key: string): Promise<Omit<OriginalImageObject, 'body'> | null>;
  get(key: string): Promise<OriginalImageObject | null>;
}

interface OriginalImageContext {
  request: Request;
  env: { MEDIA: OriginalImageBucket };
  next(): Promise<Response>;
}

const contentTypes: Record<string, string> = {
  avif: 'image/avif', bmp: 'image/bmp', gif: 'image/gif', ico: 'image/vnd.microsoft.icon',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml',
  tif: 'image/tiff', tiff: 'image/tiff', webp: 'image/webp',
};

export async function onRequest(context: OriginalImageContext): Promise<Response> {
  const { request } = context;
  let filename: string;
  try { filename = decodeURIComponent(new URL(request.url).pathname.slice('/original/'.length)); }
  catch { return new Response('Not found', { status: 404 }); }
  // The captured assets are flat files. Never permit decoded separators or traversal.
  if (!/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(filename)) return new Response('Not found', { status: 404 });
  const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  const contentType = contentTypes[extension];
  // Fonts, stylesheets, PDFs, and other original assets stay on Pages static hosting.
  if (!contentType) return context.next();
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });

  try {
    const bucket = context.env.MEDIA;
    const key = `original/${filename}`;
    const conditional = request.headers.get('If-None-Match');
    let fetched: OriginalImageObject | null = null;
    const object = request.method === 'HEAD' || conditional ? await bucket.head(key) : (fetched = await bucket.get(key));
    if (!object) return new Response('Not found', { status: 404 });
    const headers = new Headers({
      'Content-Type': object.httpMetadata?.contentType || contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      ETag: object.httpEtag,
    });
    const matches = conditional?.split(',').some(tag => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === object.httpEtag);
    if (matches) return new Response(null, { status: 304, headers });
    headers.set('Content-Length', String(object.size));
    if (request.method === 'HEAD') return new Response(null, { headers });
    const bodyObject = fetched || await bucket.get(key);
    if (!bodyObject) return new Response('Not found', { status: 404 });
    return new Response(bodyObject.body, { headers });
  } catch {
    return new Response('Image temporarily unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
