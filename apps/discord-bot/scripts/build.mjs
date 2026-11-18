import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await build({
  absWorkingDir: app, entryPoints: ['src/index.ts'], outfile: 'dist/index.js', bundle: true,
  platform: 'node', target: 'node22', format: 'esm', packages: 'external',
  alias: { '@mmb/gallery': path.resolve(app, '../../packages/gallery/src/index.ts') },
  sourcemap: true,
});
