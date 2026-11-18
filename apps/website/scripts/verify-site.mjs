import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { load } from 'cheerio';
import { isBlurhashValid } from 'blurhash';
import { applyJoinUpdates } from '../src/content/join-updates.mjs';
import { applyTeamUpdates } from '../src/content/team-updates.mjs';
import { applyFaqUpdates } from '../src/content/faq-updates.mjs';

const site = JSON.parse(await readFile('src/data/prepared-site.json', 'utf8'));
const imageData = JSON.parse(await readFile('src/data/images.json', 'utf8'));
const galleryData = JSON.parse(await readFile('src/data/gallery.json', 'utf8'));
const galleryMedia = Object.values(galleryData.albums).flat();
const galleryPhotos = galleryMedia.filter(item => item.kind === 'photo');
const sourceAssets = JSON.parse(await readFile('source-site/asset-manifest.json', 'utf8'));
const clean = node => { const clone = node.clone(); clone.find('script, style, noscript').remove(); return clone.text().replace(/\s+/g, ' ').trim(); };
let imageCount = 0;
for (const page of site.pages) {
  const file = page.path === '/' ? 'index.html' : page.path.slice(1);
  const original = load(await readFile(`source-site/${file}`, 'utf8'));
  if (page.path === '/join.html') original('#wsite-content').html(applyJoinUpdates(original('#wsite-content').html()));
  if (page.path === '/our-team.html') original('#wsite-content').html(applyTeamUpdates(original('#wsite-content').html()));
  if (page.path === '/faq.html') original('#wsite-content').html(applyFaqUpdates(original('#wsite-content').html()));
  if (page.path === '/') original('#wsite-content h2').first().find('strong').text('We are the McMaster Marching Band');
  const built = load(await readFile(`dist/${file}`, 'utf8'));
  const isGallery = ['/gallery.html', '/media.html', '/videos.html'].includes(page.path) || /^\/mmbs-\d{4}\.html$/.test(page.path);
  if (!isGallery) assert.equal(clean(built('#wsite-content')), clean(original('#wsite-content')), `${file}: body text changed`);
  else {
    assert.equal(built('#gallery-heading').text(), 'Gallery', `${file}: missing gallery`);
    assert.deepEqual(built('.gallery-year-select option').map((_, el) => Number(built(el).attr('value'))).get(), page.path === '/videos.html' ? galleryData.videoYears : galleryData.years, `${file}: available years`);
    for (const el of original('a[rel^="lightbox"]').toArray()) {
      const src = original(el).attr('href');
      const local = sourceAssets[new URL(src, site.origin).href];
      assert.ok(galleryData.sources[local], `${file}: original photo missing ${src}`);
      const caption = original(el).closest('.galleryInnerImageHolder').find('.galleryCaptionInnerText').text().trim();
      if (caption) assert.ok(galleryPhotos.some(photo => photo.caption === caption), `${file}: original caption missing`);
    }
    if (page.path === '/videos.html') {
      for (const iframe of original('#wsite-content iframe').toArray()) {
        const url = new URL(original(iframe).attr('src'), site.origin).href;
        assert.ok(galleryMedia.some(item => item.kind === 'video' && item.src === url), `Original video missing: ${url}`);
      }
      for (const caption of original('#wsite-content h2, #wsite-content .paragraph').toArray()) {
        const text = original(caption).text().trim();
        if (text) assert.ok(galleryMedia.some(item => item.kind === 'video' && (item.title === text || item.note === text)), `Original video title/note missing: ${text}`);
      }
    }
  }
  assert.equal(clean(built('.banner-wrap')), clean(original('.banner-wrap')), `${file}: banner text changed`);
  assert.equal(built('.site-footer-bottom p').text(), 'Copyright © 2026 McMaster Marching Band | All Rights Reserved', `${file}: footer date`);
  for (const href of ['/join.html', '/contact.html', '/gallery.html', '/events.html', '/budget.html', '/constitution.html', '/executive-meeting-minutes.html']) assert.ok(built(`.site-footer a[href="${href}"]`).length, `${file}: useful footer link missing ${href}`);
  assert.equal(built('title').text(), original('title').text(), `${file}: title changed`);
  for (const img of built('img').toArray()) {
    const node = built(img);
    if (node.attr('src') !== site.logo) {
      assert.ok(isBlurhashValid(node.attr('data-blurhash') || '').result, `${file}: missing BlurHash`);
      assert.match(node.parent('.progressive-image').attr('style') || '', /--image-placeholder:.*data:image\/png;base64,/, `${file}: missing placeholder`);
    }
    assert.ok(node.attr('width') && node.attr('height'), `${file}: missing image dimensions`);
    assert.ok(node.attr('src')?.startsWith('/'), `${file}: missing native image source`);
    await access(`dist${node.attr('src')}`);
    imageCount++;
  }
  for (const el of built('[href], [data-background-src]').toArray()) {
    const value = built(el).attr('href') || built(el).attr('data-background-src');
    if (value?.startsWith('/original/')) await access(`dist${value}`);
    else if (value?.startsWith('/') && !value.startsWith('//') && value !== '/') await access(`dist${new URL(value, site.origin).pathname}`);
  }
  for (const el of original('#wsite-content form input[name], #wsite-content form textarea[name], #wsite-content form select[name]').toArray()) {
    const name = original(el).attr('name');
    assert.ok(built('#wsite-content [name]').toArray().some(input => built(input).attr('name') === name), `${file}: form field ${name} lost`);
  }
}
for (const [path, image] of Object.entries(imageData)) assert.ok(isBlurhashValid(image.hash).result, path);
console.log(`Verified all ${site.pages.length} pages: preserved text with approved join-page updates; original titles and form fields; local links; ${imageCount} image instances; ${Object.keys(imageData).length} valid BlurHashes.`);
