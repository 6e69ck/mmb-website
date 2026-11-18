import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const accountId = '79db2b0ac563b88df4a2b011c08b3590';
try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }

let oauth;
try {
  const file = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), '.wrangler/config/default.toml');
  const saved = await readFile(file, 'utf8');
  const value = saved.match(/^oauth_token\s*=\s*("[^"\r\n]+")/m)?.[1];
  if (value) oauth = JSON.parse(value);
} catch {}

// A narrowly scoped Access token can coexist with Wrangler's Pages login.
export const deploymentEnvironment = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_LOG_PATH: '/tmp/mmb-pages-deploy.log', WRANGLER_SEND_METRICS: 'false' };
delete deploymentEnvironment.ACCESS_KEY_ID;
delete deploymentEnvironment.ACCESS_KEY_SECRET;
delete deploymentEnvironment.DISCORD_BOT_TOKEN;
if (oauth) delete deploymentEnvironment.CLOUDFLARE_API_TOKEN;

export async function cloudflare(endpoint, { method = 'GET', body, allowMissing = false } = {}) {
  const access = endpoint.includes('/access/');
  const tokens = access
    ? [process.env.CLOUDFLARE_API_TOKEN, oauth]
    : [oauth, process.env.CLOUDFLARE_API_TOKEN];
  const candidates = [...new Set(tokens.filter(Boolean))];
  if (!candidates.length) throw new Error('Sign in with wrangler login or provide CLOUDFLARE_API_TOKEN in the ignored root .env.');
  for (const [index, token] of candidates.entries()) {
    let response;
    for (let attempt = 0; attempt < 4; attempt++) {
      response = await fetch(`https://api.cloudflare.com/client/v4${endpoint}`, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
      });
      if (response.status !== 429 || attempt === 3) break;
      const retryAfter = response.headers.get('Retry-After');
      const seconds = retryAfter ? Number(retryAfter) : NaN;
      const retryAt = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) : NaN;
      const delay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(retryAt) ? retryAt - Date.now() : 15000 * 2 ** attempt;
      await response.body?.cancel();
      console.log(`Cloudflare rate-limited ${method}; retrying in ${Math.ceil(Math.max(1000, delay) / 1000)} seconds.`);
      await new Promise(resolve => setTimeout(resolve, Math.max(1000, delay)));
    }
    const result = await response.json();
    if ([401, 403].includes(response.status) && index < candidates.length - 1) continue;
    if (response.status === 404 && allowMissing) return null;
    if (!response.ok || !result.success) throw new Error(`Cloudflare ${method} ${endpoint}: HTTP ${response.status}: ${result.errors?.map(error => error.message).join('; ') || 'request failed'}`);
    return result.result;
  }
}
