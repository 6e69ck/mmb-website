import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig } from './config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
try { loadEnvFile(path.join(root, '.env')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

function safeError(error: unknown) {
  let text = error instanceof Error ? error.message : 'Unexpected error';
  for (const key of ['DISCORD_BOT_TOKEN', 'ACCESS_KEY_ID', 'ACCESS_KEY_SECRET', 'CLOUDFLARE_API_TOKEN']) {
    const secret = process.env[key];
    if (secret) text = text.split(secret).join('[redacted]');
  }
  return text;
}

try {
  if (!process.env.DISCORD_BOT_TOKEN || !(process.env.DISCORD_UPLOAD_CHANNEL || process.env.DISCORD_UPLOAD_CHANNEL_ID)) {
    if (!process.argv.includes('--allow-missing')) throw new Error('Add DISCORD_BOT_TOKEN and DISCORD_UPLOAD_CHANNEL to the ignored root .env.');
    console.log('Discord bot is in standby: add DISCORD_BOT_TOKEN and DISCORD_UPLOAD_CHANNEL to the root .env to connect.');
  } else {
    const config = loadConfig();
    if (process.argv.includes('--check-config')) {
      console.log('Discord and R2 configuration is valid. Gallery publishing is enabled. No connection was opened.');
    } else {
      const { createBot } = await import('./bot.js');
      const { R2MediaStore } = await import('./storage.js');
      const { client, shutdown } = createBot(config, new R2MediaStore(config));
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        console.log('Stopping the Discord bot and finishing active uploads…');
        void shutdown().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
      };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      client.on('error', error => console.error(`Discord client: ${safeError(error)}`));
      await client.login(config.token);
      console.log(`Discord bot connected. Monitoring channel ${config.channelId}; photos publish to the gallery.`);
    }
  }
} catch (error) {
  console.error(`Discord bot: ${safeError(error)}`);
  process.exitCode = 1;
}
