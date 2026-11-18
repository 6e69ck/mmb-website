import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { load } from 'cheerio';

const site = JSON.parse(await readFile('src/data/site.json', 'utf8'));
const images = JSON.parse(await readFile('src/data/images.json', 'utf8'));
const albums = new Map();
const seen = new Map();
const sources = {};
const photoKey = src => images[src]?.digest || src;

function add(year, photo) {
  const key = photoKey(photo.src);
  if (seen.has(key)) {
    const existing = seen.get(key);
    if (photo.caption && !existing.caption) existing.caption = photo.caption;
    sources[photo.src] = existing.src;
    return;
  }
  if (!albums.has(year)) albums.set(year, []);
  albums.get(year).push(photo);
  seen.set(key, photo);
  sources[photo.src] = photo.src;
}
function photoFrom($, el) {
  const a = $(el), img = a.find('img').first();
  const src = a.attr('href'), thumb = img.attr('src');
  const metadata = images[thumb];
  if (!metadata || !images[src]) throw new Error(`Missing gallery image: ${src}`);
  const caption = a.closest('.galleryInnerImageHolder').find('.galleryCaptionInnerText').text().trim();
  return { kind: 'photo', src, thumbnail: thumb, width: metadata.width, height: metadata.height, hash: metadata.hash, placeholder: metadata.placeholder, caption, alt: caption || img.attr('alt') || '' };
}
for (const page of site.pages.filter(p => /^\/mmbs-\d{4}\.html$/.test(p.path))) {
  const year = Number(page.path.match(/\d{4}/)[0]);
  const $ = load(page.contentHtml);
  for (const el of $('a[rel^="lightbox"]').toArray()) add(year, photoFrom($, el));
}
// Preserve the main archive too; some photographs only exist on this page.
const archive = load(site.pages.find(p => p.path === '/gallery.html').contentHtml);
let archiveYear = 2024;
for (const el of archive('a[rel^="lightbox"]').toArray()) {
  const photo = photoFrom(archive, el);
  const year = photo.caption.match(/\b20\d{2}\b/)?.[0];
  if (year) archiveYear = Number(year);
  add(archiveYear, photo);
}
const photoYears = [...albums.keys()].sort((a, b) => b - a);
const videoSource = load(site.pages.find(p => p.path === '/videos.html').contentHtml);
const videos = [];
let title = '', note = '';
videoSource('h2, .paragraph, iframe').each((_, el) => {
  const node = videoSource(el);
  if (el.tagName === 'h2') { title = node.text().trim(); note = ''; }
  else if (el.tagName === 'iframe') {
    const year = Number(title.match(/\b20\d{2}\b/)?.[0]);
    if (!year) throw new Error(`Missing year for video: ${title}`);
    videos.push({ kind: 'video', src: node.attr('src'), title, note, year });
    if (!albums.has(year)) albums.set(year, []);
  } else if (node.text().trim()) note = node.text().trim();
});
// Distribute videos among photographs so each year's mosaic contains both.
for (const year of albums.keys()) {
  const photos = albums.get(year);
  const yearVideos = videos.filter(video => video.year === year);
  const mixed = [];
  while (photos.length || yearVideos.length) {
    if (yearVideos.length) mixed.push(yearVideos.shift());
    mixed.push(...photos.splice(0, Math.max(6, Math.ceil(photos.length / Math.max(1, yearVideos.length)))));
  }
  albums.set(year, mixed);
}
const years = [...albums.keys()].sort((a, b) => b - a);
const videoYears = [...new Set(videos.map(video => video.year))].sort((a, b) => b - a);
await mkdir('public/gallery/albums', { recursive: true });
for (const [year, photos] of albums) await writeFile(`public/gallery/albums/${year}.json`, JSON.stringify(photos));
await writeFile('src/data/gallery.json', JSON.stringify({ years, photoYears, videoYears, albums: Object.fromEntries(albums), sources }));
console.log(`Prepared ${seen.size} unique photos and ${videos.length} videos across ${years.length} years; original captions and video notes retained.`);
