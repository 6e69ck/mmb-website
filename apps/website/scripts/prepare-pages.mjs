import { access, cp, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const website = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(website, 'dist');
const output = path.join(website, '.pages-dist');
const imageExtensions = new Set(['.avif', '.bmp', '.gif', '.ico', '.jpg', '.jpeg', '.png', '.svg', '.tif', '.tiff', '.webp']);

// Fail before touching any existing staging output when the website is not built.
await access(path.join(source, 'index.html'));
await rm(output, { recursive: true, force: true });
await cp(source, output, { recursive: true });
let removed = 0;
const originals = path.join(output, 'original');
for (const entry of await readdir(originals, { withFileTypes: true })) {
  if (entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase())) {
    await rm(path.join(originals, entry.name));
    removed++;
  }
}
await writeFile(path.join(output, '_routes.json'), `${JSON.stringify({
  version: 1,
  include: ['/original/*', '/api/gallery*', '/media/*'],
  exclude: [],
}, null, 2)}\n`);
console.log(`Pages staging prepared at ${output}: ${removed} original images will be served from R2; other static assets remain on Pages.`);
