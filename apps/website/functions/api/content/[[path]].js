import { publicContent } from '../../../../admin-dashboard/worker/content.ts';

// Only read-only published page content endpoints are reachable on the public website.
export function onRequest({ request, env }) {
  const path = new URL(request.url).pathname.replace(/\/$/, '');
  if (!/^\/api\/content\/(faq|our-team|budget|constitution|executive-meeting-minutes)$/.test(path)) {
    return new Response('Not found', { status: 404 });
  }
  return publicContent(request, {
    ...env,
    ENVIRONMENT: 'production',
    ADMIN_EMAILS: 'nickly88@pm.me',
    ADMIN_ORIGIN: 'https://admin.mmb.nickly.me',
    PUBLIC_MEDIA_ORIGIN: new URL(request.url).origin,
  }, path);
}
