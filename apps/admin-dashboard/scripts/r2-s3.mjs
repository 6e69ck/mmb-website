import { createHash, createHmac } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// This migration client deliberately supports only R2 HEAD and PUT operations.
// Credentials are sent only in signed headers to a validated Cloudflare endpoint.
export function createR2Client({ endpoint, accessKeyId, secretAccessKey, fetchImpl = fetch, now = () => new Date() }) {
  if (!endpoint) throw new Error('Set R2_ENDPOINT to the S3 API endpoint in your bucket settings.');
  const origin = new URL(endpoint);
  if (origin.protocol !== 'https:' || !/^[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/.test(origin.hostname) || origin.port || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('R2_ENDPOINT must be your HTTPS account S3 endpoint, without a bucket or object path.');
  }
  if (!accessKeyId || !secretAccessKey) throw new Error('Set both ACCESS_KEY_ID and ACCESS_KEY_SECRET in the root .env.');

  async function request(method, bucket, key = '', { body = Buffer.alloc(0), headers = {} } = {}) {
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Invalid R2 bucket name.');
    const url = new URL(`/${encode(bucket)}${key ? `/${key.split('/').map(encode).join('/')}` : ''}`, origin);
    const timestamp = now().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = timestamp.slice(0, 8), scope = `${date}/auto/s3/aws4_request`;
    const signed = new Headers(headers);
    signed.set('host', url.host);
    signed.set('x-amz-date', timestamp);
    signed.set('x-amz-content-sha256', hash(body));
    const entries = [...signed.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const signedHeaders = entries.map(([name]) => name).join(';');
    const canonicalHeaders = entries.map(([name, value]) => `${name}:${value.trim().replace(/\s+/g, ' ')}\n`).join('');
    const canonical = [method, url.pathname, '', canonicalHeaders, signedHeaders, hash(body)].join('\n');
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), 'auto'), 's3'), 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(`AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`).digest('hex');
    signed.set('authorization', `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`);
    // Redirects must never forward signed credentials to another destination.
    let response;
    try {
      response = await fetchImpl(url, { method, headers: signed, ...(method === 'PUT' ? { body } : {}), redirect: 'error', signal: AbortSignal.timeout(60000) });
    } catch (error) {
      throw new Error(`R2 ${method} could not connect (${error.cause?.code || error.name}). No authentication result was received.`);
    }
    await response.body?.cancel();
    return response;
  }

  return {
    destination: `${origin.origin}/mmb-media`,
    async checkBucket(bucket) {
      const response = await request('HEAD', bucket);
      if (!response.ok) throw new Error(`R2 bucket check failed (HTTP ${response.status}); verify endpoint and bucket permissions.`);
    },
    async exists(bucket, key) {
      const response = await request('HEAD', bucket, key);
      if (response.status === 404) return false;
      if (!response.ok) throw new Error(`R2 object check failed (HTTP ${response.status}); no objects were changed by this check.`);
      return true;
    },
    async put(bucket, key, body, { contentType, cacheControl, createOnly = false } = {}) {
      const headers = { 'content-type': contentType || 'application/octet-stream' };
      if (cacheControl) headers['cache-control'] = cacheControl;
      if (createOnly) headers['if-none-match'] = '*';
      const response = await request('PUT', bucket, key, { body, headers });
      if (response.status === 412) throw new Error('An object already exists; its contents were preserved.');
      if (!response.ok) throw new Error(`R2 upload failed (HTTP ${response.status}). Completed uploads are checkpointed; rerun to resume.`);
    },
  };
}
