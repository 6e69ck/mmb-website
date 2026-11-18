import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverScript = path.join(root, 'scripts/deploy-bot-server.sh');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 20000, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

test('deploy driver defaults to origin and the requested server without connecting', () => {
  const result = run(process.execPath, ['scripts/deploy-bot.mjs', '--dry-run'], { cwd: root });
  const plan = JSON.parse(result);
  assert.equal(plan.host, 'dev@192.18.151.14');
  assert.equal(plan.dir, '/home/dev/MMB');
  assert.equal(plan.repo, run('git', ['remote', 'get-url', 'origin'], { cwd: root }));
  assert.equal(plan.credentialsTransferred, false);
  assert.match(plan.command, /bash.*-s/);
});

test('SSH command preserves shell characters in a deployment path as literal arguments', () => {
  const directory = "/tmp/mmb 'quoted' $(printf unexpected); directory";
  const plan = JSON.parse(run(process.execPath, ['scripts/deploy-bot.mjs', '--dry-run', '--dir', directory], { cwd: root }));
  const result = run('bash', ['-c', plan.command], { input: 'printf \'%s\\n\' "$@"\n' });
  assert.deepEqual(result.split('\n'), [plan.repo, 'main', directory]);
});

test('server deployment preserves secrets, pulls fast-forward, and starts only the bot', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mmb-deploy-test-'));
  try {
    const source = path.join(temporary, 'source'), bare = path.join(temporary, 'remote.git');
    const target = path.join(temporary, 'server checkout'), bin = path.join(temporary, 'bin');
    const log = path.join(temporary, 'commands.log');
    await Promise.all([source, target, bin].map(dir => mkdir(dir)));
    run('git', ['init', '--quiet', '--bare', '--initial-branch=main', bare]);
    run('git', ['init', '--quiet', '--initial-branch=main', source]);
    run('git', ['config', 'user.name', 'Deploy Test'], { cwd: source });
    run('git', ['config', 'user.email', 'deploy-test@example.invalid'], { cwd: source });
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.26.2' }));
    await writeFile(path.join(source, '.gitignore'), '.env\ndist/\n');
    await writeFile(path.join(source, '.gitattributes'), '* text=auto eol=lf\n');
    await writeFile(path.join(source, 'version.txt'), 'first\n');
    await writeFile(path.join(source, 'ecosystem.config.cjs'), 'module.exports = {};\n');
    run('git', ['add', '.'], { cwd: source });
    run('git', ['commit', '--quiet', '-m', 'First test release'], { cwd: source });
    run('git', ['push', '--quiet', bare, 'main'], { cwd: source });
    await writeFile(path.join(target, '.env'), 'DISCORD_BOT_TOKEN=test-only-secret\n');
    const scripts = {
      git: '#!/usr/bin/env bash\nfor arg in "$@"; do case "$arg" in --initial-branch*|--show-current) echo "Unsupported old Git option" >&2; exit 129;; esac; done\nexec "$MMB_TEST_REAL_GIT" "$@"\n',
      'fake-ssh': '#!/usr/bin/env bash\nexec git-upload-pack "$MMB_TEST_BARE"\n',
      pnpm: `#!/usr/bin/env bash
set -e
if [[ "$*" = --version ]]; then printf '10.26.2\\n'; exit; fi
printf 'pnpm %s\\n' "$*" >> "$MMB_TEST_LOG"
if [[ "$*" = *' build' ]]; then
  [[ "$MMB_TEST_FAIL_BUILD" != 1 ]] || exit 42
  mkdir -p apps/discord-bot/dist
  printf 'if (!process.argv.includes("--check-config")) process.exit(9);\\n' > apps/discord-bot/dist/index.js
fi
`,
      corepack: '#!/usr/bin/env bash\nshift\nexec "$(dirname "$0")/pnpm" "$@"\n',
      pm2: '#!/usr/bin/env bash\nprintf "pm2 %s\\n" "$*" >> "$MMB_TEST_LOG"\n',
    };
    for (const [name, content] of Object.entries(scripts)) await writeFile(path.join(bin, name), content, { mode: 0o755 });
    const nvmDirectory = path.join(temporary, 'nvm');
    const oldBin = path.join(temporary, 'old-node');
    const newBin = path.join(nvmDirectory, 'versions/node/v24.21.0/bin');
    const nvmSelection = path.join(temporary, 'nvm-selection');
    await mkdir(oldBin); await mkdir(newBin, { recursive: true });
    await writeFile(path.join(oldBin, 'node'), '#!/usr/bin/env bash\nif [[ "$1" = -e ]]; then exit 1; fi\nif [[ "$1" = --version ]]; then echo v20.18.0; exit; fi\nexec "$MMB_TEST_REAL_NODE" "$@"\n', { mode: 0o755 });
    await writeFile(path.join(newBin, 'node'), '#!/usr/bin/env bash\nexec "$MMB_TEST_REAL_NODE" "$@"\n', { mode: 0o755 });
    await writeFile(path.join(nvmDirectory, 'nvm.sh'), 'nvm() { export PATH="$NVM_DIR/versions/node/$3/bin:$PATH"; printf "%s" "$3" > "$MMB_TEST_NVM_SELECTION"; }\nif [[ "$1" != --no-use ]]; then export PATH="$MMB_TEST_OLD_BIN:$PATH"; fi\n');
    const realGit = run('which', ['git']);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_SSH_COMMAND: path.join(bin, 'fake-ssh'), GIT_SSH_VARIANT: 'ssh', MMB_TEST_BARE: bare, MMB_TEST_LOG: log, NVM_DIR: nvmDirectory, MMB_TEST_NVM_SELECTION: nvmSelection, MMB_TEST_REAL_NODE: process.execPath, MMB_TEST_OLD_BIN: oldBin, MMB_TEST_REAL_GIT: realGit };
    const repo = 'git@example.invalid:test/MMB.git';
    const deploy = extra => spawnSync('bash', [serverScript, repo, 'main', target], { encoding: 'utf8', env: { ...env, ...extra }, timeout: 20000 });
    let result = deploy();
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(await readFile(path.join(target, '.env'), 'utf8'), 'DISCORD_BOT_TOKEN=test-only-secret\n');
    assert.equal((await stat(path.join(target, '.env'))).mode & 0o777, 0o600);
    let commands = await readFile(log, 'utf8');
    assert.match(commands, /--filter @mmb\/discord-bot\.\.\. install --frozen-lockfile --prod=false/);
    assert.match(commands, /pm2 startOrRestart .*ecosystem\.config\.cjs --only mmb-discord-bot --update-env/);
    assert.match(commands, /pm2 save/);
    assert.doesNotMatch(commands, /website|admin-dashboard|test-only-secret/);
    assert.match(result.stdout, /Remote runtime on .*: v(?:2[2-9]|[3-9][0-9])\./, 'A compatible PATH runtime must not be downgraded by NVM.');
    assert.equal(await readFile(nvmSelection, 'utf8').catch(() => null), null, 'Compatible Node must not load the older NVM default.');
    await writeFile(path.join(source, 'version.txt'), 'second\n');
    run('git', ['add', '.'], { cwd: source });
    run('git', ['commit', '--quiet', '-m', 'Second test release'], { cwd: source });
    run('git', ['push', '--quiet', bare, 'main'], { cwd: source });
    result = deploy(); assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(await readFile(path.join(target, 'version.txt'), 'utf8'), 'second\n');
    assert.equal(await readFile(path.join(target, '.env'), 'utf8'), 'DISCORD_BOT_TOKEN=test-only-secret\n');
    result = deploy({ PATH: `${oldBin}:${env.PATH}` });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(await readFile(nvmSelection, 'utf8'), 'v24.21.0', 'An old PATH runtime must select a compatible installed NVM version.');
    commands = await readFile(log, 'utf8'); const pm2Count = commands.split('\n').filter(line => line.startsWith('pm2 ')).length;
    await writeFile(path.join(target, 'version.txt'), 'server edit\n');
    result = deploy(); assert.notEqual(result.status, 0); assert.match(result.stderr, /tracked server changes/);
    run('git', ['restore', 'version.txt'], { cwd: target });
    result = deploy({ MMB_TEST_FAIL_BUILD: '1' }); assert.notEqual(result.status, 0);
    assert.equal((await readFile(log, 'utf8')).split('\n').filter(line => line.startsWith('pm2 ')).length, pm2Count, 'Failed checks/builds must never restart PM2.');
    await rm(path.join(source, 'ecosystem.config.cjs'));
    run('git', ['add', '.'], { cwd: source });
    run('git', ['commit', '--quiet', '-m', 'Fixture without deployment config'], { cwd: source });
    run('git', ['push', '--quiet', bare, 'main'], { cwd: source });
    const beforeMissingConfig = await readFile(log, 'utf8');
    result = deploy(); assert.notEqual(result.status, 0); assert.match(result.stderr, /missing ecosystem.config.cjs/);
    assert.equal(await readFile(log, 'utf8'), beforeMissingConfig, 'Missing deployment config must fail before dependency installs and PM2 commands.');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
