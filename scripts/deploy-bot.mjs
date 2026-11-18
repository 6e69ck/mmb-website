import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = { host: 'dev@192.18.151.14', dir: '/home/dev/MMB', branch: 'main', repo: '' };
let dryRun = false;
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (flag === '--dry-run') { dryRun = true; continue; }
  if (flag === '--help') {
    console.log('pnpm deploy:bot [--repo git@host:owner/repo.git] [--branch main] [--host dev@192.18.151.14] [--dir /home/dev/MMB] [--dry-run]');
    process.exit(0);
  }
  const key = flag.slice(2);
  if (!flag.startsWith('--') || !Object.hasOwn(options, key) || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error(`Unknown option or missing value: ${flag}`);
  options[key] = process.argv[++i];
}
if (!options.repo) {
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' });
  if (remote.status !== 0) throw new Error('Add a Git origin or pass --repo with an SSH Git URL.');
  options.repo = remote.stdout.trim();
}
if (!/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.:-]+$/.test(options.host)) throw new Error('Use an SSH destination such as dev@192.18.151.14.');
if (!/^(?:git@[A-Za-z0-9_.-]+:[A-Za-z0-9_./-]+|ssh:\/\/[A-Za-z0-9_.@:/-]+)$/.test(options.repo)) throw new Error('The repository must use a Git SSH URL.');
if (!options.dir.startsWith('/') || path.posix.normalize(options.dir) === '/' || /[\r\n\0]/.test(options.dir)) throw new Error('Use a non-root absolute deployment directory.');
if (spawnSync('git', ['check-ref-format', `refs/heads/${options.branch}`], { cwd: root, stdio: 'ignore' }).status !== 0) throw new Error('Invalid deployment branch.');

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const command = ['bash', '-s', '--', options.repo, options.branch, options.dir].map(quote).join(' ');
if (dryRun) {
  console.log(JSON.stringify({ ...options, process: 'mmb-discord-bot', command, credentialsTransferred: false }, null, 2));
} else {
  const script = await readFile(path.join(root, 'scripts/deploy-bot-server.sh'), 'utf8');
  const result = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', options.host, command], {
    cwd: root, input: script, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (result.error) throw result.error;
  process.exitCode = result.status || (result.signal ? 1 : 0);
}
