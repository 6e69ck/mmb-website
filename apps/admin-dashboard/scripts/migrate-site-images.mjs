import { readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createR2Client } from './r2-s3.mjs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(app, '../..');
try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const s3 = createR2Client({
  endpoint: process.env.R2_ENDPOINT || (process.env.CLOUDFLARE_ACCOUNT_ID ? `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com` : ''),
  accessKeyId: process.env.ACCESS_KEY_ID,
  secretAccessKey: process.env.ACCESS_KEY_SECRET,
});
const bucket = 'mmb-media';
const directory = path.join(root, 'apps/website/public/original');
const statePath = path.join(app, '.migration-images-state.local.json');
const temporaryStatePath = path.join(app, '.migration-images-state.tmp.local.json');
const types = { '.avif': 'image/avif', '.bmp': 'image/bmp', '.gif': 'image/gif', '.ico': 'image/vnd.microsoft.icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.webp': 'image/webp' };
const files = (await readdir(directory)).filter(file => types[path.extname(file).toLowerCase()]).sort();
let state = { destination: s3.destination, uploaded: {} };
try {
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  if (saved.destination === state.destination && saved.uploaded && typeof saved.uploaded === 'object') state = saved;
} catch (error) { if (error.code !== 'ENOENT') throw error; }

await s3.checkBucket(bucket);
let cursor = 0, completed = 0, stopped = false, save = Promise.resolve();
// Keep checkpoint writes serialized even though four uploads run concurrently.
async function upload() {
  while (!stopped) {
    const file = files[cursor++];
    if (!file) return;
    const key = `original/${file}`;
    const body = await readFile(path.join(directory, file));
    const digest = createHash('sha256').update(body).digest('hex');
    if (state.uploaded[key] !== digest) {
      await s3.put(bucket, key, body, { contentType: types[path.extname(file).toLowerCase()], cacheControl: 'public, max-age=31536000, immutable' });
      state.uploaded[key] = digest;
      save = save.then(async () => {
        await writeFile(temporaryStatePath, JSON.stringify(state));
        await rename(temporaryStatePath, statePath);
      });
      await save;
    }
    completed++;
    if (completed % 50 === 0 || completed === files.length) console.log(`Site images: ${completed}/${files.length} uploaded or reused.`);
  }
}
const results = await Promise.allSettled(Array.from({ length: 4 }, () => upload().catch(error => { stopped = true; throw error; })));
await save;
const failure = results.find(result => result.status === 'rejected');
if (failure) throw failure.reason;
console.log(`All ${files.length} website images are stored in ${bucket}/original/. Website deployment was not changed.`);
