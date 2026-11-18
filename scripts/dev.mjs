import { spawn } from 'node:child_process';
const turbo = spawn('pnpm', ['exec', 'turbo', 'run', 'dev'], { stdio: 'inherit', env: { ...process.env, WRANGLER_LOG_PATH: '/tmp/mmb-wrangler-dev.log', WRANGLER_SEND_METRICS: 'false' } });
let seeding;
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; turbo.kill(signal); seeding?.kill(signal); });
turbo.on('exit', code => { stopping = true; process.exitCode = code || 0; });
for (let attempt = 0; attempt < 45 && !stopping; attempt++) {
  try {
    const response = await fetch('http://127.0.0.1:8787/api/admin/items', { signal: AbortSignal.timeout(1000) });
    if (response.ok) {
      const existing = await response.json();
      if (existing.revision === 0) {
        console.log('Preparing the existing gallery in local R2 storage (once per fresh checkout)…');
        seeding = spawn('pnpm', ['--filter', '@mmb/admin-dashboard', 'gallery:seed-local'], { stdio: 'inherit' });
        await new Promise(resolve => seeding.on('exit', resolve));
      }
      break;
    }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 1000));
}
