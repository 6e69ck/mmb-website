import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const env = {
  DISCORD_BOT_TOKEN: 'test-token', DISCORD_UPLOAD_CHANNEL: '123456789012345678',
  R2_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
  ACCESS_KEY_ID: 'test-access', ACCESS_KEY_SECRET: 'test-secret',
};
describe('bot configuration', () => {
  it('uses the existing root env names and automatically publishes to mmb-media', () => {
    expect(loadConfig(env)).toMatchObject({ channelId: env.DISCORD_UPLOAD_CHANNEL, bucket: 'mmb-media', publishToGallery: true, confirmationTtlMs: 60000 });
  });
  it('accepts the explicit CHANNEL_ID spelling too', () => {
    const { DISCORD_UPLOAD_CHANNEL, ...rest } = env;
    expect(loadConfig({ ...rest, DISCORD_UPLOAD_CHANNEL_ID: DISCORD_UPLOAD_CHANNEL }).channelId).toBe(DISCORD_UPLOAD_CHANNEL);
  });
  it('names missing variables without disclosing credentials', () => {
    expect(() => loadConfig({ ...env, ACCESS_KEY_SECRET: '' })).toThrow(/ACCESS_KEY_SECRET/);
    expect(() => loadConfig({ ...env, DISCORD_UPLOAD_CHANNEL: 'not-an-id' })).toThrow(/channel ID/);
  });
  it('refuses endpoints that could receive credentials outside R2', () => {
    for (const R2_ENDPOINT of ['https://example.com', 'http://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com', `${env.R2_ENDPOINT}/mmb-media`]) expect(() => loadConfig({ ...env, R2_ENDPOINT })).toThrow();
  });
});
