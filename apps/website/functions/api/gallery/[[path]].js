import galleryWorker from '../../../../admin-dashboard/worker/index.ts';

// Only the published gallery routes are reachable through the public website.
export function onRequest({ request, env }) {
  const path = new URL(request.url).pathname.replace(/\/$/, '');
  if (!/^\/api\/gallery(?:\/years\/\d{4})?$/.test(path)) return new Response('Not found', { status: 404 });
  return galleryWorker.fetch(request, {
    ...env,
    ENVIRONMENT: 'production',
    ADMIN_EMAILS: 'nickly88@pm.me',
    ADMIN_ORIGIN: 'https://admin.mmb.nickly.me',
    PUBLIC_MEDIA_ORIGIN: new URL(request.url).origin,
  });
}
