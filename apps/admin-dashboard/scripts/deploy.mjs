import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const result = spawnSync(process.execPath, ['scripts/deploy-pages.mjs', '--admin'], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status || 0;
