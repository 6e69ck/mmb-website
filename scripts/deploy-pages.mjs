import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { accountId, cloudflare, deploymentEnvironment, root } from './cloudflare-client.mjs';
import { connectDomain } from './pages-domain.mjs';

const flags = process.argv.slice(2);
const website = flags.includes('--website') || !flags.length;
const admin = flags.includes('--admin') || !flags.length;
if (!website && !admin) throw new Error('Choose --website, --admin, or no flags for both.');
const wrangler = path.join(root, 'apps/admin-dashboard/node_modules/.bin/wrangler');
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env: deploymentEnvironment, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Deployment command failed (exit ${result.status}).`);
}

async function publish(folder, hostname) {
  const app = path.join(root, 'apps', folder);
  const config = JSON.parse(await readFile(path.join(app, 'wrangler.pages.jsonc'), 'utf8'));
  if (folder === 'admin-dashboard') {
    let access;
    try { access = JSON.parse(await readFile(path.join(app, 'access.production.local.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!access?.ACCESS_AUD || !access?.ACCESS_TEAM_DOMAIN) {
      if (!flags.includes('--locked-admin')) throw new Error('Configure Cloudflare Access before deploying the admin dashboard, or use --locked-admin to deploy with editing disabled.');
      console.log('Deploying admin with all administration disabled until Cloudflare Access is configured.');
    } else Object.assign(config.vars, access);
  }
  let project = await cloudflare(`/accounts/${accountId}/pages/projects/${config.name}`, { allowMissing: true });
  if (!project) project = await cloudflare(`/accounts/${accountId}/pages/projects`, { method: 'POST', body: { name: config.name, production_branch: 'main' } });
  // Pages only reads the standard configuration filename. Isolate it from the
  // existing Worker development config instead of replacing tracked files.
  const staging = path.join(app, '.pages-project');
  await mkdir(staging, { recursive: true });
  config.pages_build_output_dir = path.relative(staging, path.resolve(app, config.pages_build_output_dir));
  delete config.$schema;
  await writeFile(path.join(staging, 'wrangler.jsonc'), JSON.stringify(config, null, 2));
  run(wrangler, ['pages', 'deploy', config.pages_build_output_dir, '--project-name', config.name, '--branch', 'main', '--commit-dirty=true'], staging);
  await connectDomain(project, hostname);
}

if (website) {
  if (!flags.includes('--skip-build')) run('pnpm', ['--filter', '@mmb/website', 'build'], root);
  run(process.execPath, ['scripts/prepare-pages.mjs'], path.join(root, 'apps/website'));
  run(wrangler, ['pages', 'functions', 'build', 'functions', '--outdir', '.pages-dist/_worker.js'], path.join(root, 'apps/website'));
  await publish('website', 'mmb.nickly.me');
}
if (admin) {
  run(process.execPath, ['scripts/build-pages.mjs'], path.join(root, 'apps/admin-dashboard'));
  await publish('admin-dashboard', 'admin.mmb.nickly.me');
}
