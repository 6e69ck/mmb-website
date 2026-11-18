import { spawnSync } from 'node:child_process';

const steps = [
  ['Cloudflare Pages (website and admin)', ['deploy:pages']],
  ['Discord bot (server and PM2)', ['deploy:bot']],
];

for (const [label, args] of steps) {
  console.log(`\nDeploying ${label}…`);
  const result = spawnSync('pnpm', args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} deployment failed (exit ${result.status ?? 'unknown'}).`);
  }
}

console.log('\nAll MMB projects deployed successfully.');
