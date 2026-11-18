import { spawnSync } from 'node:child_process';
const result = spawnSync('pnpm', ['exec', 'turbo', 'run', 'build'], { stdio: 'inherit', env: { ...process.env, WRANGLER_LOG_PATH: '/tmp/mmb-wrangler-build.log', WRANGLER_SEND_METRICS: 'false' } });
if (result.status !== 0) process.exit(result.status || 1);
if (process.argv.includes('--qa')) {
  const qa = spawnSync(process.execPath, ['scripts/browser-qa.mjs'], { stdio: 'inherit' });
  if (qa.status !== 0) process.exit(qa.status || 1);
}
