import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

export default defineConfig({
  site: 'https://mmb.nickly.me',
  output: 'static',
  integrations: [react()],
  vite: { server: { strictPort: true } },
  build: { format: 'file' },
});
