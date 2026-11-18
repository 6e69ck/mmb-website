import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { encode, decode } from 'blurhash';
import { load } from 'cheerio';
import { createHash } from 'node:crypto';
import { applyJoinUpdates } from '../src/content/join-updates.mjs';
import { applyTeamUpdates } from '../src/content/team-updates.mjs';
import { applyFaqUpdates } from '../src/content/faq-updates.mjs';

const site = JSON.parse(await readFile('src/data/site.json', 'utf8'));
const assets = JSON.parse(await readFile('source-site/asset-manifest.json', 'utf8'));
let images = {};
try { images = JSON.parse(await readFile('src/data/images.json', 'utf8')); } catch {}
const paths = [...new Set(Object.entries(assets).filter(([url]) => !/\/fonts?\//i.test(url)).map(([, path]) => path))].filter(path => /\.(png|jpe?g|webp|gif|svg)$/i.test(path));
let cursor = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (cursor < paths.length) {
    const path = paths[cursor++];
    const bytes = await readFile(`public${path}`);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (images[path]?.digest === digest) continue;
    const input = sharp(bytes, { animated: false });
    const metadata = await input.metadata();
    const { data, info } = await input.rotate().resize(32, 32, { fit: 'inside' }).flatten({ background: '#ffffff' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const hash = encode(new Uint8ClampedArray(data), info.width, info.height, 4, 3);
    const pixels = decode(hash, 32, 24);
    const png = await sharp(Buffer.from(pixels), { raw: { width: 32, height: 24, channels: 4 } }).png().toBuffer();
    const rotated = [5, 6, 7, 8].includes(metadata.orientation);
    images[path] = { digest, hash, width: rotated ? metadata.height : metadata.width, height: rotated ? metadata.width : metadata.height, placeholder: `data:image/png;base64,${png.toString('base64')}` };
  }
}));
await writeFile('src/data/images.json', JSON.stringify(images));

function enhance(html) {
  const $ = load(html, null, false);
  $('img').each((_, el) => {
    const img = $(el), src = img.attr('src'), image = images[src];
    if (!image) throw new Error(`No BlurHash for image: ${src}`);
    // Keep intrinsic sizing stable while the tiny decoded preview is displayed.
    const style = img.attr('style') || '';
    if (/\bwidth\s*:\s*auto\b/i.test(style)) img.attr('style', style.replace(/\bwidth\s*:\s*auto\b/i, `width:${image.width}px`));
    img.attr('width', image.width).attr('height', image.height);
    img.attr('data-blurhash', image.hash).attr('data-image-src', src).attr('src', image.placeholder);
    // Native picture fallback keeps the original images available without JavaScript.
    img.wrap('<picture class="progressive-picture"></picture>');
    img.before($('<source media="(scripting: none)">').attr('srcset', src));
  });
  $('[style*="background-image"]').each((_, el) => {
    const node = $(el);
    const style = node.attr('style');
    const path = style.match(/background-image:\s*url\(['"]?([^)'"\s]+)['"]?\)/)?.[1];
    if (!path || !images[path]) return;
    node.attr('data-blurhash-background', images[path].hash).attr('data-background-src', path);
    node.attr('style', style.replace(/background-image:\s*url\([^)]*\)/, `background-image: url('${images[path].placeholder}')`));
    node.append(`<noscript><style>[data-background-src="${path}"]{background-image:url('${path}')!important}</style></noscript>`);
  });
  $('form').each((_, el) => {
    const form = $(el);
    // Keep the original submit label and all original hidden fields.
    form.find('a.wsite-button').each((_, button) => {
      const a = $(button);
      a.replaceWith(`<button type="submit" class="${a.attr('class')}">${a.html()}</button>`);
    });
    form.find('[aria-required="true"]').attr('required', '');
    form.find('input').each((_, input) => {
      const label = form.find(`label[for="${$(input).attr('id')}"]`).first().text();
      if (/^Email/.test(label)) $(input).attr('type', 'email').attr('autocomplete', 'email');
    });
  });
  return $.html();
}
for (const page of site.pages) {
  if (page.path === '/join.html') page.contentHtml = applyJoinUpdates(page.contentHtml);
  if (page.path === '/our-team.html') page.contentHtml = applyTeamUpdates(page.contentHtml);
  if (page.path === '/faq.html') page.contentHtml = applyFaqUpdates(page.contentHtml);
  if (page.path === '/') {
    const $ = load(page.contentHtml, null, false);
    $('h2').first().find('strong').text('We are the McMaster Marching Band');
    page.contentHtml = $.html();
  }
  page.bannerHtml = enhance(page.bannerHtml || '');
  page.contentHtml = enhance(page.contentHtml);
  page.footerHtml = enhance(page.footerHtml);
}
await writeFile('src/data/prepared-site.json', JSON.stringify(site));
console.log(`BlurHash placeholders ready for ${Object.keys(images).length} images.`);
