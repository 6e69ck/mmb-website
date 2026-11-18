import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createR2Client } from './r2-s3.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..'), root = path.resolve(app, '../..');
try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const local = process.argv.includes('--local');
const api = process.env.LOCAL_GALLERY_API || 'http://127.0.0.1:8787';
const bucket = 'mmb-media', catalogKey = 'gallery/v1/catalog.json';
const useS3 = !local && Boolean(process.env.ACCESS_KEY_ID || process.env.ACCESS_KEY_SECRET);
const s3 = useS3 ? createR2Client({
  endpoint: process.env.R2_ENDPOINT || (process.env.CLOUDFLARE_ACCOUNT_ID ? `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com` : ''),
  accessKeyId: process.env.ACCESS_KEY_ID,
  secretAccessKey: process.env.ACCESS_KEY_SECRET,
}) : null;
const data = JSON.parse(await readFile(path.join(root, 'apps/website/src/data/gallery.json'), 'utf8'));
const images = JSON.parse(await readFile(path.join(root, 'apps/website/src/data/images.json'), 'utf8'));
const statePath = path.join(app, '.migration-state.json');
const catalogPath = path.join(app, '.wrangler/import/catalog.json');
const existingPath = path.join(app, '.wrangler/import/existing-catalog.json');
await mkdir(path.dirname(catalogPath), { recursive: true });
const mime = ext => ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' })[ext];
const files = new Map(), records = [];
function asset(source) {
  if (!/^\/original\/[a-z0-9]+\.(?:png|jpg|jpeg|webp|gif)$/.test(source)) throw new Error(`Unexpected source image path: ${source}`);
  const metadata = images[source];
  if (!metadata?.digest) throw new Error(`Missing image checksum: ${source}`);
  const ext = path.extname(source), key = `media/imported/${metadata.digest}${ext}`;
  files.set(key, { file: path.join(root, 'apps/website/public', source), contentType: mime(ext) });
  return key;
}
for (const [year, media] of Object.entries(data.albums)) for (const [order, item] of media.entries()) {
  const id = `legacy-${createHash('sha256').update(`${item.kind}:${item.src}`).digest('hex').slice(0, 24)}`;
  const base = { ...item, id, year: Number(year), order, published: true, createdAt: '2026-11-17T00:00:00.000Z', updatedAt: '2026-11-17T00:00:00.000Z' };
  if (item.kind === 'photo') records.push({ ...base, originalKey: asset(item.src), thumbnailKey: asset(item.thumbnail), src: '', thumbnail: '' });
  else records.push({ ...base, provider: 'youtube' });
}
const catalog = { schemaVersion: 1, revision: 1, updatedAt: new Date().toISOString(), items: records };
await writeFile(catalogPath, JSON.stringify(catalog));
const headers = { 'X-Requested-With': 'MMB-Gallery', Origin: api };

function wrangler(args, capture = false) {
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...args], { cwd: app, env: { ...process.env, WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || '/tmp/mmb-wrangler.log' }, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  return result;
}
let account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!account) {
  try { account = JSON.parse(await readFile(path.join(app, 'wrangler.production.local.json'), 'utf8')).account_id; } catch {}
}
// Never reuse upload checkpoints from another account with the same bucket name.
const destination = s3 ? s3.destination : account ? `${account}/${bucket}` : null;
let state = { destination, uploaded: [] };
try { const saved = JSON.parse(await readFile(statePath, 'utf8')); if (destination && saved.destination === destination) state = saved; } catch {}
if (local) {
  const response = await fetch(`${api}/api/admin/items`);
  if (!response.ok) throw new Error('Start pnpm dev before seeding the local gallery.');
  const existing = await response.json();
  if (existing.revision > 0) { console.log('Local gallery already initialized; existing edits preserved.'); process.exit(0); }
} else if (s3) {
  await s3.checkBucket(bucket);
  if (await s3.exists(bucket, catalogKey)) { console.log('Remote gallery already initialized. Existing admin edits were preserved; no import performed.'); process.exit(0); }
} else {
  const check = wrangler(['r2', 'object', 'get', `${bucket}/${catalogKey}`, '--remote', '--file', existingPath], true);
  if (check.status === 0) { console.log('Remote gallery already initialized. Existing admin edits were preserved; no import performed.'); process.exit(0); }
  if (!/(404|10007|does not exist|not found|NoSuchKey)/i.test(`${check.stdout}\n${check.stderr}`)) {
    throw new Error('Could not verify the remote gallery is empty. Check wrangler login and R2 permissions; no objects were changed.');
  }
}
let completed = 0;
for (const [key, { file, contentType }] of files) {
  if (!local && state.uploaded.includes(key)) { completed++; continue; }
  if (local) {
    const response = await fetch(`${api}/api/admin/import/object`, { method: 'PUT', headers: { ...headers, 'X-Media-Key': key, 'Content-Type': contentType }, body: await readFile(file) });
    if (!response.ok) throw new Error(`Local import failed for ${key}: ${await response.text()}`);
  } else {
    if (s3) {
      await s3.put(bucket, key, await readFile(file), { contentType, cacheControl: 'public, max-age=31536000, immutable' });
    } else {
      const result = wrangler(['r2', 'object', 'put', `${bucket}/${key}`, '--remote', '--file', file, '--content-type', contentType, '--cache-control', 'public, max-age=31536000, immutable'], true);
      if (result.status !== 0) throw new Error(`R2 upload failed for ${key}. Completed uploads are checkpointed; rerun this command to resume.`);
    }
    state.uploaded.push(key);
    await writeFile(statePath, JSON.stringify(state));
  }
  completed++;
  if (completed % 25 === 0 || completed === files.size) console.log(`Imported ${completed}/${files.size} image objects.`);
}
if (local) {
  const response = await fetch(`${api}/api/admin/import`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(catalog) });
  if (!response.ok) throw new Error(`Local catalog import failed: ${await response.text()}`);
} else if (s3) {
  await s3.put(bucket, catalogKey, Buffer.from(JSON.stringify(catalog)), { contentType: 'application/json', cacheControl: 'no-store', createOnly: true });
} else {
  // Initialize only after every immutable object is present, before first deployment.
  // Refuse an existing catalog so reruns never overwrite an administrator's edits.
  const check = wrangler(['r2', 'object', 'get', `${bucket}/${catalogKey}`, '--remote', '--file', existingPath], true);
  if (check.status === 0) throw new Error('The remote catalog was initialized during migration; it was preserved. No catalog was overwritten.');
  if (!/(404|10007|does not exist|not found|NoSuchKey)/i.test(`${check.stdout}\n${check.stderr}`)) throw new Error('Could not verify the catalog is still absent. Image objects are uploaded; catalog initialization stopped safely.');
  const result = wrangler(['r2', 'object', 'put', `${bucket}/${catalogKey}`, '--remote', '--file', catalogPath, '--content-type', 'application/json', '--cache-control', 'no-store']);
  if (result.status !== 0) throw new Error('Could not initialize the catalog. Image objects are checkpointed for retry.');
}
console.log(`Gallery initialized with ${records.filter(item => item.kind === 'photo').length} photos and ${records.filter(item => item.kind === 'video').length} videos in ${local ? 'local R2 storage' : bucket}.`);
