import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { load } from 'cheerio';

const origin = 'https://www.mcmastermarchingband.com';
const refresh = process.argv.includes('--refresh');
const exists = async path => access(path).then(() => true, () => false);
for (const dir of ['source-site', 'src/data', 'public/original']) await mkdir(dir, { recursive: true });
if (!refresh && !process.argv.includes('--reprocess') && await exists('src/data/site.json') && JSON.parse(await readFile('src/data/site.json', 'utf8')).schemaVersion === 3) {
  console.log('Using captured website. Run pnpm capture --refresh to recapture.');
  process.exit(0);
}
async function request(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (!res.ok) throw new Error(`${res.status}: ${url}`);
      return res;
    } catch (error) { if (attempt === 2) throw error; }
  }
}
const absolute = (url, base = origin) => new URL(url, base).href;
const pagePath = url => {
  const u = new URL(url, origin);
  if (u.hostname !== new URL(origin).hostname || u.search || u.hash) return null;
  return u.pathname === '/' || /^\/[a-z0-9-]+\.html$/.test(u.pathname) ? u.pathname : null;
};
const originals = new Map();
const queue = ['/'];
while (queue.length) {
  const path = queue.shift();
  if (originals.has(path)) continue;
  const name = path === '/' ? 'index.html' : path.slice(1);
  let html;
  if (!refresh && await exists(`source-site/${name}`)) html = await readFile(`source-site/${name}`, 'utf8');
  else {
    html = await (await request(origin + path)).text();
    await writeFile(`source-site/${name}`, html);
  }
  originals.set(path, html);
  const $ = load(html);
  $('.desktop-nav a[href], #wsite-content a[href]').each((_, el) => {
    const next = pagePath($(el).attr('href'));
    if (next && !originals.has(next) && !queue.includes(next)) queue.push(next);
  });
  console.log(`Captured ${path}`);
}
const assetMap = new Map();
if (!refresh && await exists('source-site/asset-manifest.json')) {
  for (const [url, local] of Object.entries(JSON.parse(await readFile('source-site/asset-manifest.json', 'utf8')))) if (local.startsWith('/original/')) assetMap.set(url, Promise.resolve(local));
}
const failures = [];
async function asset(url, base = origin) {
  if (!url || /^(data:|#|mailto:|tel:|javascript:)/i.test(url)) return url;
  const full = absolute(url, base);
  if (assetMap.has(full)) return assetMap.get(full);
  const pending = (async () => {
    const u = new URL(full);
    const ext = u.pathname.match(/\.[a-z0-9]{1,6}$/i)?.[0] || '';
    const path = `/original/${createHash('sha256').update(full).digest('hex').slice(0, 20)}${ext}`;
    try {
      if (refresh || !await exists(`public${path}`)) {
        const res = await request(full);
        if (ext === '.css' || res.headers.get('content-type')?.includes('text/css')) {
          let css = await res.text();
          for (const match of [...css.matchAll(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g)]) css = css.replace(match[0], `url("${await asset(match[2], full)}")`);
          await writeFile(`public${path}`, css);
        } else await writeFile(`public${path}`, Buffer.from(await res.arrayBuffer()));
      }
      return path;
    } catch (error) {
      failures.push({ url: full, error: error.message });
      return full;
    }
  })();
  assetMap.set(full, pending);
  return pending;
}
const $home = load(originals.get('/'));
function navItems(list) {
  return list.children('li').toArray().map(el => {
    const a = $home(el).children('a');
    return { label: a.children('.wsite-menu-title').length ? a.children('.wsite-menu-title').text().trim() : a.text().trim(), href: a.attr('href'), children: navItems($home(el).children('.wsite-menu-wrap').children('ul')) };
  });
}
const navigation = navItems($home('.desktop-nav > ul').first());
const logo = await asset($home('.logo img').attr('src'));
const pages = [];
for (const [path, html] of originals) {
  const $ = load(html);
  const content = $('#wsite-content');
  if (!content.length) throw new Error(`Missing page content: ${path}`);
  const footer = $('.footer-wrap').first();
  const root = $('<div></div>').append($('.banner-wrap').first().clone()).append(content.clone()).append(footer.clone());
  root.find('script').remove();
  root.find('*').each((_, el) => {
    for (const key of Object.keys(el.attribs || {})) if (/^on/i.test(key)) $(el).removeAttr(key);
  });
  root.find('a[href*="/cdn-cgi/l/email-protection"]').each((_, el) => {
    const data = $(el).attr('href').split('#')[1];
    if (data) { const bytes = Buffer.from(data, 'hex'); $(el).attr('href', 'mailto:' + [...bytes.subarray(1)].map(b => String.fromCharCode(b ^ bytes[0])).join('')); }
  });
  const jobs = [];
  root.find('[src], a[href], [style], object[data]').each((_, el) => {
    jobs.push(async () => {
      const node = $(el);
      for (const attr of ['src', 'href', 'data']) {
        const value = node.attr(attr);
        if (!value) continue;
        if (/\.(?:jpe?g|png|gif|webp|svg|ico|pdf|xlsx?|docx?|woff2?|ttf)(?:[?#]|$)/i.test(value)) node.attr(attr, await asset(value));
        else if (attr === 'src' || attr === 'data') node.attr(attr, absolute(value));
        else if (value.startsWith(origin)) node.attr(attr, value.slice(origin.length) || '/');
      }
      let style = node.attr('style');
      if (style) {
        for (const match of [...style.matchAll(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g)]) style = style.replace(match[0], `url('${await asset(match[2])}')`);
        node.attr('style', style);
      }
    });
  });
  let cursor = 0;
  await Promise.all(Array.from({ length: 6 }, async () => { while (cursor < jobs.length) await jobs[cursor++](); }));
  const stylesheets = [];
  for (const el of $('head link[rel="stylesheet"]').toArray()) {
    const href = $(el).attr('href');
    if (href && !/fancybox/.test(href)) {
      const local = await asset(href);
      if (!stylesheets.includes(local)) stylesheets.push(local);
    }
  }
  root.find('form').each((_, el) => {
    const action = $(el).attr('action');
    if (action) $(el).attr('action', absolute(action));
  });
  root.find('a[target="_blank"]').attr('rel', 'noopener noreferrer');
  root.find('iframe').each((i, el) => {
    $(el).attr('loading', 'lazy');
    if (!$(el).attr('title')) $(el).attr('title', `${$('title').text()} — ${i + 1}`);
  });
  root.find('img').attr('loading', 'lazy').attr('decoding', 'async');
  const contentHtml = root.find('#wsite-content').html();
  const footerHtml = root.find('.footer-wrap').html();
  const textRoot = load(`<div id="wsite-content">${contentHtml}</div>`);
  const text = content.clone(); text.find('script').remove();
  if (textRoot('#wsite-content').text() !== text.text()) throw new Error(`Text changed: ${path}`);
  pages.push({ path, title: $('title').text(), description: $('meta[property="og:description"]').attr('content') || '', bodyClass: $('body').attr('class'), stylesheets, inlineStyles: $('head style').map((_, el) => $(el).html()).get(), bannerHtml: root.find('.banner-wrap').prop('outerHTML') || '', contentHtml, footerHtml, originalText: text.text() });
  console.log(`Prepared ${path}`);
}
await writeFile('src/data/site.json', JSON.stringify({ schemaVersion: failures.length ? 0 : 3, origin, capturedAt: new Date().toISOString(), logo, navigation, pages }, null, 2));
await writeFile('source-site/asset-manifest.json', JSON.stringify(Object.fromEntries(await Promise.all([...assetMap].map(async ([url, local]) => [url, await local]))), null, 2));
await writeFile('source-site/capture-report.json', JSON.stringify({ pages: pages.length, assets: assetMap.size, failures }, null, 2));
console.log(`Captured ${pages.length} pages and ${assetMap.size} assets; ${failures.length} asset failures.`);
if (failures.length) process.exitCode = 1;
