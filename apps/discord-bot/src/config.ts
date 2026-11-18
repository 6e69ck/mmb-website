export type BotConfig = {
  token: string;
  channelId: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publishToGallery: boolean;
  confirmationTtlMs: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const channelId = env.DISCORD_UPLOAD_CHANNEL || env.DISCORD_UPLOAD_CHANNEL_ID;
  const required = ['DISCORD_BOT_TOKEN', 'R2_ENDPOINT', 'ACCESS_KEY_ID', 'ACCESS_KEY_SECRET'] as const;
  const missing = required.filter(key => !env[key]?.trim());
  if (missing.length || !channelId?.trim()) throw new Error(`Missing bot configuration: ${[...missing, ...(!channelId?.trim() ? ['DISCORD_UPLOAD_CHANNEL'] : [])].join(', ')}. Add these to the ignored root .env.`);
  if (!/^\d{17,20}$/.test(channelId!)) throw new Error('DISCORD_UPLOAD_CHANNEL must be a Discord channel ID.');
  const endpoint = new URL(env.R2_ENDPOINT!);
  if (endpoint.protocol !== 'https:' || !/^[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/.test(endpoint.hostname) || endpoint.pathname !== '/' || endpoint.username || endpoint.password || endpoint.port || endpoint.search || endpoint.hash) {
    throw new Error('R2_ENDPOINT must be the account HTTPS S3 endpoint, without a bucket path.');
  }
  return {
    token: env.DISCORD_BOT_TOKEN!, channelId: channelId!,
    endpoint: endpoint.origin, accessKeyId: env.ACCESS_KEY_ID!, secretAccessKey: env.ACCESS_KEY_SECRET!,
    bucket: 'mmb-media', publishToGallery: true, confirmationTtlMs: 60000,
  };
}
