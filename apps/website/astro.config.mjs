import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import { load } from 'cheerio';
import {
  PAGE_PATH_TO_SLUG,
  renderPageHtml,
  renderStructuredDataJsonLd,
} from '@mmb/content';

function liveContentDevPlugin() {
  return {
    name: 'mmb-live-content-dev',
    configureServer(server) {
      const apiBase = process.env.PUBLIC_GALLERY_API_URL || 'http://127.0.0.1:8787';

      server.middlewares.use(async (req, res, next) => {
        const reqUrl = req.url || '/';
        if ((req.method === 'GET' || req.method === 'HEAD') && reqUrl.startsWith('/files/')) {
          try {
            const upstream = await fetch(`${apiBase}${reqUrl}`, { signal: AbortSignal.timeout(5000) });
            res.statusCode = upstream.status;
            upstream.headers.forEach((value, key) => {
              if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
                res.setHeader(key, value);
              }
            });
            const buffer = Buffer.from(await upstream.arrayBuffer());
            res.end(buffer);
            return;
          } catch {
            res.statusCode = 502;
            res.end('Local file service unavailable');
            return;
          }
        }

        const [pathnameRaw, searchPart = ''] = reqUrl.split('?');
        const pathname = pathnameRaw.replace(/\/$/, '') || '/';
        const accept = String(req.headers.accept || '');
        if (
          req.method === 'GET' &&
          accept.includes('text/html') &&
          !pathname.startsWith('/original/') &&
          !pathname.startsWith('/files/') &&
          pathname.endsWith('.html')
        ) {
          const cleanLocation = (pathname.slice(0, -5) || '/') + (searchPart ? `?${searchPart}` : '');
          res.writeHead(302, { Location: cleanLocation });
          res.end();
          return;
        }
        const slug = PAGE_PATH_TO_SLUG[pathname];
        if (!slug || req.method !== 'GET' || !accept.includes('text/html')) {
          next();
          return;
        }

        let livePayload = null;
        try {
          const liveRes = await fetch(`${apiBase}/api/content/${slug}`, { signal: AbortSignal.timeout(1500) });
          if (liveRes.ok) {
            livePayload = await liveRes.json();
          }
        } catch {
          // Fall back to static Astro HTML when local worker is unavailable
        }

        if (!livePayload?.page) {
          next();
          return;
        }

        const pageDoc = livePayload.page;
        const driveCaches = livePayload.driveCaches || {};
        const chunks = [];
        const origWriteHead = res.writeHead.bind(res);
        const origFlushHeaders = res.flushHeaders?.bind(res);
        const origWrite = res.write.bind(res);
        const origEnd = res.end.bind(res);
        let captured = true;

        const restoreResponseMethods = () => {
          res.writeHead = origWriteHead;
          if (origFlushHeaders) res.flushHeaders = origFlushHeaders;
          res.write = origWrite;
          res.end = origEnd;
        };

        res.writeHead = (statusCode, statusMessageOrHeaders, maybeHeaders) => {
          if (!captured) return origWriteHead(statusCode, statusMessageOrHeaders, maybeHeaders);
          res.statusCode = statusCode;
          const headers = typeof statusMessageOrHeaders === 'object' && statusMessageOrHeaders !== null
            ? statusMessageOrHeaders
            : maybeHeaders;
          if (headers && typeof headers === 'object') {
            for (const [key, value] of Object.entries(headers)) {
              if (key.toLowerCase() !== 'content-length' && value !== undefined) {
                res.setHeader(key, value);
              }
            }
          }
          return res;
        };

        if (origFlushHeaders) {
          res.flushHeaders = () => {
            if (!captured) origFlushHeaders();
          };
        }

        const toBuffer = (chunk, encoding) => {
          if (Buffer.isBuffer(chunk)) return chunk;
          if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          return Buffer.from(String(chunk), encoding);
        };

        res.write = (chunk, encodingOrCb, cb) => {
          if (!captured) return origWrite(chunk, encodingOrCb, cb);
          if (chunk) {
            const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
            chunks.push(toBuffer(chunk, encoding));
          }
          const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
          if (typeof callback === 'function') callback();
          return true;
        };

        res.end = (chunk, encodingOrCb, cb) => {
          if (!captured) return origEnd(chunk, encodingOrCb, cb);
          captured = false;
          restoreResponseMethods();
          if (chunk && typeof chunk !== 'function') {
            const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
            chunks.push(toBuffer(chunk, encoding));
          }
          const callback = typeof chunk === 'function' ? chunk : typeof encodingOrCb === 'function' ? encodingOrCb : cb;
          const raw = Buffer.concat(chunks);
          const contentType = String(res.getHeader('content-type') || '');
          const contentEncoding = res.getHeader('content-encoding');
          if (res.statusCode !== 200 || !contentType.includes('text/html') || contentEncoding) {
            return origEnd(raw, callback);
          }
          const $ = load(raw.toString('utf8'));
          $('title').text(pageDoc.seo.title);
          $('meta[name="description"]').attr('content', pageDoc.seo.description);
          const jsonLd = renderStructuredDataJsonLd(pageDoc);
          if (jsonLd) $('head').append(`<script type="application/ld+json">${jsonLd}</script>`);
          $('#wsite-content').html(renderPageHtml(pageDoc, { driveCaches }));
          const output = Buffer.from($.html(), 'utf8');
          if (!res.headersSent) {
            res.removeHeader('content-length');
            res.setHeader('content-length', output.byteLength);
          }
          return origEnd(output, callback);
        };

        next();
      });
    },
  };
}

export default defineConfig({
  site: 'https://mmb.nickly.me',
  output: 'static',
  integrations: [react()],
  vite: {
    plugins: [liveContentDevPlugin()],
    server: { strictPort: true },
  },
  build: { format: 'file' },
});
