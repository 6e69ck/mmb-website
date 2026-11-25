import {
  PAGE_PATH_TO_SLUG,
  renderPageHtml,
  renderStructuredDataJsonLd,
} from '@mmb/content';
import { loadDriveCachesForPage, loadPage } from '../../admin-dashboard/worker/content.ts';
import { isDriveCacheStale, syncDriveFolder } from '../../admin-dashboard/worker/drive.ts';
import type { Env } from '../../admin-dashboard/worker/types.ts';

interface PagesMiddlewareContext {
  request: Request;
  env: Env;
  next(): Promise<Response>;
  waitUntil(promise: Promise<unknown>): void;
}

interface RewriterElement {
  setInnerContent(content: string, options?: { html?: boolean }): void;
  setAttribute(name: string, value: string): void;
  append(content: string, options?: { html?: boolean }): void;
}

interface EdgeHtmlRewriter {
  on(selector: string, handlers: { element(el: RewriterElement): void }): EdgeHtmlRewriter;
  transform(response: Response): Response;
}

declare const HTMLRewriter: new () => EdgeHtmlRewriter;

export async function onRequest(context: PagesMiddlewareContext): Promise<Response> {
  const { request, env } = context;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return context.next();
  }

  const url = new URL(request.url);
  const path = url.pathname === '/' ? '/' : url.pathname.replace(/\/$/, '');
  if (path.endsWith('.html') && PAGE_PATH_TO_SLUG[path]) {
    return Response.redirect(`${url.origin}${path.slice(0, -5)}${url.search}`, 308);
  }
  const slug = PAGE_PATH_TO_SLUG[path];
  if (!slug || !env.MEDIA) {
    return context.next();
  }

  let loaded;
  try {
    loaded = await loadPage(env.MEDIA, slug);
  } catch {
    return context.next();
  }
  if (!loaded.exists) {
    return context.next();
  }

  const response = await context.next();
  if (response.status !== 200 || !response.headers.get('content-type')?.includes('text/html')) {
    return response;
  }

  const doc = loaded.page;
  const driveCaches = await loadDriveCachesForPage(env.MEDIA, doc);

  if (env.GOOGLE_DRIVE_API_KEY?.trim()) {
    for (const block of doc.blocks) {
      if (block.type === 'drive-minutes' && block.folderId) {
        const cache = driveCaches[block.folderId] ?? null;
        if (isDriveCacheStale(cache)) {
          context.waitUntil(syncDriveFolder(env, block.folderId).catch(() => {}));
        }
      }
    }
  }

  const bodyHtml = renderPageHtml(doc, { driveCaches });
  const jsonLd = renderStructuredDataJsonLd(doc);

  let rewriter = new HTMLRewriter()
    .on('title', {
      element(el: RewriterElement) {
        el.setInnerContent(doc.seo.title);
      },
    })
    .on('meta[name="description"]', {
      element(el: RewriterElement) {
        el.setAttribute('content', doc.seo.description);
      },
    })
    .on('#wsite-content', {
      element(el: RewriterElement) {
        el.setInnerContent(bodyHtml, { html: true });
      },
    });

  if (jsonLd) {
    rewriter = rewriter.on('head', {
      element(el: RewriterElement) {
        el.append(`<script type="application/ld+json">${jsonLd}</script>`, { html: true });
      },
    });
  }

  const transformed = rewriter.transform(response);
  const headers = new Headers(transformed.headers);
  headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  headers.set('ETag', `"page-${slug}-${doc.revision}"`);
  return new Response(transformed.body, { status: transformed.status, headers });
}
