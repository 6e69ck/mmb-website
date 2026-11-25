import { publicContentFile } from '../../../admin-dashboard/worker/content.ts';

export function onRequest({ request, env }) {
  const path = new URL(request.url).pathname;
  return publicContentFile(request, {
    ...env,
    ENVIRONMENT: 'production',
    ADMIN_EMAILS: 'nickly88@pm.me',
    ADMIN_ORIGIN: 'https://admin.mmb.nickly.me',
    PUBLIC_MEDIA_ORIGIN: new URL(request.url).origin,
  }, path);
}
