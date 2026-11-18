import { spawnSync } from 'node:child_process';
for (const [command, args] of [
  [process.execPath, ['scripts/capture-source.mjs']],
  [process.execPath, ['scripts/prepare-images.mjs']],
  [process.execPath, ['scripts/prepare-gallery.mjs']],
  ['pnpm', ['exec', 'astro', 'build']],
  [process.execPath, ['scripts/verify-site.mjs']],
  ...(process.argv.includes('--qa') ? [[process.execPath, ['scripts/browser-qa.mjs']]] : []),
  ...(process.argv.includes('--qa-team') ? [[process.execPath, ['scripts/browser-qa.mjs', '--team']]] : []),
]) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
