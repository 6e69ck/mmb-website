import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CONTENT_HISTORY_PREFIX, CONTENT_PAGE_PREFIX, PAGE_SLUGS } from '@mmb/content';
import { extractSeedPages } from '@mmb/content/seed';
import { createR2Client } from './r2-s3.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..');
const root = path.resolve(app, '../..');
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const local = process.argv.includes('--local');
const api = process.env.LOCAL_GALLERY_API || 'http://127.0.0.1:8787';
const bucket = 'mmb-media';

const preparedSite = JSON.parse(await readFile(path.join(root, 'apps/website/src/data/prepared-site.json'), 'utf8'));
const images = JSON.parse(await readFile(path.join(root, 'apps/website/src/data/images.json'), 'utf8'));
const seedPages = extractSeedPages(preparedSite, images);
const pageList = PAGE_SLUGS.map(slug => seedPages[slug]);

if (local) {
  const response = await fetch(`${api}/api/admin/content/import`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'MMB-Gallery',
      Origin: api,
    },
    body: JSON.stringify({ pages: pageList }),
  });
  if (!response.ok) {
    throw new Error(`Local page seeding failed: ${await response.text()}`);
  }
  const result = await response.json();
  console.log(`Local pages seeded: ${result.imported} created, ${result.skipped} existing preserved.`);
  process.exit(0);
}

const useS3 = Boolean(process.env.ACCESS_KEY_ID || process.env.ACCESS_KEY_SECRET);
const s3 = useS3
  ? createR2Client({
      endpoint:
        process.env.R2_ENDPOINT ||
        (process.env.CLOUDFLARE_ACCOUNT_ID ? `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com` : ''),
      accessKeyId: process.env.ACCESS_KEY_ID,
      secretAccessKey: process.env.ACCESS_KEY_SECRET,
    })
  : null;

function wrangler(args, capture = false) {
  return spawnSync('pnpm', ['exec', 'wrangler', ...args], {
    cwd: app,
    env: { ...process.env, WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || '/tmp/mmb-wrangler.log' },
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
}

const importDir = path.join(app, '.wrangler/import/pages');
await mkdir(importDir, { recursive: true });
if (s3) await s3.checkBucket(bucket);

let created = 0;
let preserved = 0;
for (const doc of pageList) {
  const key = `${CONTENT_PAGE_PREFIX}${doc.slug}.json`;
  const historyKey = `${CONTENT_HISTORY_PREFIX}${doc.slug}/rev-${doc.revision}.json`;
  const body = JSON.stringify(doc, null, 2);

  if (s3) {
    if (await s3.exists(bucket, key)) {
      preserved++;
      continue;
    }
    await s3.put(bucket, key, Buffer.from(body), {
      contentType: 'application/json',
      cacheControl: 'no-store',
      createOnly: true,
    });
    await s3.put(bucket, historyKey, Buffer.from(body), {
      contentType: 'application/json',
      cacheControl: 'no-store',
      createOnly: true,
    }).catch(() => {});
    created++;
    continue;
  }

  const checkPath = path.join(importDir, `${doc.slug}.existing.json`);
  const check = wrangler(['r2', 'object', 'get', `${bucket}/${key}`, '--remote', '--file', checkPath], true);
  if (check.status === 0) {
    preserved++;
    continue;
  }
  if (!/(404|10007|does not exist|not found|NoSuchKey)/i.test(`${check.stdout}\n${check.stderr}`)) {
    throw new Error(`Could not verify ${key} is absent before seeding.`);
  }
  const filePath = path.join(importDir, `${doc.slug}.json`);
  await writeFile(filePath, body);
  const putPage = wrangler(['r2', 'object', 'put', `${bucket}/${key}`, '--remote', '--file', filePath, '--content-type', 'application/json', '--cache-control', 'no-store']);
  if (putPage.status !== 0) throw new Error(`Failed to upload ${key} to R2.`);
  wrangler(['r2', 'object', 'put', `${bucket}/${historyKey}`, '--remote', '--file', filePath, '--content-type', 'application/json', '--cache-control', 'no-store'], true);
  created++;
}

console.log(`Remote pages seeded in ${bucket}: ${created} created, ${preserved} existing preserved.`);
