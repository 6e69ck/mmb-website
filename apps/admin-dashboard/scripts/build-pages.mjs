import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = {
  ...process.env,
  WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || '/tmp/mmb-wrangler-pages-build.log',
  WRANGLER_SEND_METRICS: 'false',
};
// R2 is accessed through the runtime binding. S3 migration credentials have no
// role in either the client build or the compiled Pages Worker.
delete env.ACCESS_KEY_ID;
delete env.ACCESS_KEY_SECRET;
delete env.DISCORD_BOT_TOKEN;

for (const args of [
  ['exec', 'vite', 'build'],
  ['exec', 'wrangler', 'deploy', '--config', 'wrangler.jsonc', '--dry-run', '--env', '', '--outdir', 'dist/worker'],
]) {
  const result = spawnSync('pnpm', args, { cwd: app, env, stdio: 'inherit' });
  if (result.error) throw new Error(`Could not start Pages build command: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status || 1);
}

// Pages advanced mode consumes this ESM module, with env.ASSETS supplied by
// Pages itself. Source maps stay outside the static upload directory.
const worker = await readFile(path.join(app, 'dist/worker/index.js'), 'utf8');
await writeFile(path.join(app, 'dist/client/_worker.js'), worker.replace(/^\/\/# sourceMappingURL=.*(?:\r?\n|$)/gm, ''));
// Dashboard and API routes must pass Access validation before static assets.
// Only the certificate authority's validation path bypasses the Worker.
await writeFile(path.join(app, 'dist/client/_routes.json'), `${JSON.stringify({ version: 1, include: ['/*'], exclude: ['/.well-known/acme-challenge/*'] }, null, 2)}\n`);
console.log('Pages build ready in admin-dashboard/dist/client. No deployment was performed.');
