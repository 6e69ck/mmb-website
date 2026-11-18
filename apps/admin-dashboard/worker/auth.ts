import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ApiError, isLocal, type Env } from './types';
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function authenticate(request: Request, env: Env): Promise<string> {
  const allowed = env.ADMIN_EMAILS.split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
  if (isLocal(request, env) && env.DEV_AUTH === 'true') return allowed[0] || 'local-admin@example.test';
  if (!env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com\/?$/.test(env.ACCESS_TEAM_DOMAIN) || !allowed.length) {
    throw new ApiError(503, 'Admin sign-in is not configured yet.');
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new ApiError(401, 'Sign in with your approved email address to continue.');
  const issuer = env.ACCESS_TEAM_DOMAIN.replace(/\/$/, '');
  let keys = keySets.get(issuer);
  if (!keys) { keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)); keySets.set(issuer, keys); }
  try {
    const { payload } = await jwtVerify(token, keys, { issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'] });
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
    if (!allowed.includes(email)) throw new ApiError(403, 'This email address is not an approved gallery administrator.');
    return email;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(401, 'Your sign-in has expired. Sign in again to continue.');
  }
}
export function verifyMutation(request: Request, env: Env) {
  const origin = request.headers.get('Origin');
  const allowed = [env.ADMIN_ORIGIN];
  if (isLocal(request, env)) allowed.push('http://127.0.0.1:5174', 'http://localhost:5174', new URL(request.url).origin);
  if (origin && !allowed.includes(origin)) throw new ApiError(403, 'This action must be made from the admin dashboard.');
  if (request.headers.get('X-Requested-With') !== 'MMB-Gallery') throw new ApiError(403, 'This action must be made from the admin dashboard.');
}
