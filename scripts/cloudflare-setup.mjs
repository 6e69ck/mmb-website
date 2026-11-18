import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Access is configured before publishing the admin. Media migrations preserve
// an existing catalog and reuse checksum-addressed upload checkpoints.
for (const args of [
  ['scripts/configure-access.mjs'],
  ['apps/admin-dashboard/scripts/migrate-gallery.mjs'],
  ['apps/admin-dashboard/scripts/migrate-site-images.mjs'],
  ['scripts/deploy-pages.mjs'],
]) {
  const result = spawnSync(process.execPath, args, { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
