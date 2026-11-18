import galleryWorker from '../../../admin-dashboard/worker/index.ts';

export function onRequest({ request, env }) {
  return galleryWorker.fetch(request, {
    ...env,
    ENVIRONMENT: 'production',
    ADMIN_EMAILS: 'nickly88@pm.me',
    ADMIN_ORIGIN: 'https://admin.mmb.nickly.me',
    PUBLIC_MEDIA_ORIGIN: new URL(request.url).origin,
  });
}
