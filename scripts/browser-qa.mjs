import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../apps/website/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
const chromiumBinary = (await import(require.resolve('@sparticuz/chromium'))).default;
const sharp = require('sharp');
const API = process.env.GALLERY_API_URL || 'http://127.0.0.1:8787';
const SITE = process.env.WEBSITE_PREVIEW_URL || 'http://127.0.0.1:4323';
const ADMIN = process.env.ADMIN_PREVIEW_URL || 'http://127.0.0.1:5174';
await mkdir('/tmp/mmb-monorepo-qa', { recursive: true });
const browser = await chromium.launch({ executablePath: await chromiumBinary.executablePath(), args: chromiumBinary.args, headless: true });
const created = new Set();
const errors = [];
const original = await (await fetch(`${API}/api/admin/items`)).json();
assert.ok(original.items.length >= 384, 'Local R2 should contain the original gallery before browser QA.');
const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'MMB-Gallery', Origin: ADMIN };
const catalog = async () => (await (await fetch(`${API}/api/admin/items`)).json()).items;
const index = async () => (await (await fetch(`${API}/api/gallery`)).json());
const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const admin = await browserContext.newPage();
const site = await browserContext.newPage();
for (const page of [admin, site]) {
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return [new URL(API).origin, new URL(SITE).origin, new URL(ADMIN).origin, 'https://mmb.nickly.me'].includes(url.origin) || !url.protocol.startsWith('http') ? route.continue() : route.abort();
  });
}
const stamp = `Gallery QA ${Date.now()}`;
try {
  await admin.goto(ADMIN, { waitUntil: 'networkidle' });
  await expect(admin.getByRole('heading', { name: 'Your media' })).toBeVisible();
  await expect(admin.getByText('384 items in your library')).toBeVisible();
  await admin.screenshot({ path: '/tmp/mmb-monorepo-qa/admin-desktop.png' });
  await admin.getByRole('button', { name: 'Add media', exact: true }).click();
  let dialog = admin.getByRole('dialog');
  await dialog.getByLabel('Year', { exact: true }).fill('2037');
  await dialog.getByLabel('Caption', { exact: true }).fill(stamp);
  await dialog.getByLabel(/^Image description/).fill('A maroon test image');
  await dialog.getByLabel('Publish immediately').uncheck();
  const fixture = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#7a003c' } }).png().toBuffer();
  await dialog.locator('input[type=file]').setInputFiles({ name: 'qa-photo.png', mimeType: 'image/png', buffer: fixture });
  await dialog.getByRole('button', { name: 'Save hidden item', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  let item = (await catalog()).find(item => item.kind === 'photo' && item.caption === stamp);
  assert.ok(item && !item.published && item.hash && item.originalKey && item.thumbnailKey);
  created.add(item.id);
  assert.ok(!(await index()).years.includes(2037), 'Drafts must stay out of the public gallery.');
  await admin.getByRole('textbox', { name: 'Search gallery' }).fill(stamp);
  let card = admin.locator('.admin-media-card').filter({ hasText: stamp });
  await card.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(card.locator('.visibility-badge')).toHaveText('Published');
  await site.goto(`${SITE}/gallery.html`, { waitUntil: 'networkidle' });
  await expect(site.getByRole('combobox', { name: 'Select gallery year' })).toHaveValue('2037');
  await expect(site.locator('.gallery-mosaic img[data-image-ready=true]')).toHaveCount(1);
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  dialog = admin.getByRole('dialog');
  await dialog.getByLabel('Year', { exact: true }).fill('2038');
  await dialog.getByLabel('Caption', { exact: true }).fill(`${stamp} edited`);
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await site.reload({ waitUntil: 'networkidle' });
  await expect(site.getByRole('combobox', { name: 'Select gallery year' })).toHaveValue('2038');
  await expect(site.locator('.mosaic-tile figcaption')).toHaveText(`${stamp} edited`);
  await card.getByRole('button', { name: 'Hide', exact: true }).click();
  await expect(card.locator('.visibility-badge')).toHaveText('Hidden');
  await site.reload({ waitUntil: 'networkidle' });
  await expect(site.getByRole('combobox', { name: 'Select gallery year' })).toHaveValue('2025');
  await card.getByRole('button', { name: 'Remove', exact: true }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Remove item', exact: true }).click();
  await expect(admin.getByRole('dialog')).not.toBeVisible();
  assert.ok(!(await catalog()).some(candidate => candidate.id === item.id));
  created.delete(item.id);
  assert.equal((await fetch(item.src)).status, 404, 'Removed images should no longer be served.');

  await admin.getByRole('textbox', { name: 'Search gallery' }).fill('');
  await admin.getByRole('button', { name: 'Add media', exact: true }).click();
  dialog = admin.getByRole('dialog');
  await dialog.getByRole('button', { name: 'YouTube link', exact: true }).click();
  await dialog.getByLabel('YouTube link', { exact: true }).fill('https://youtu.be/wsR4jiXsO6M');
  await dialog.getByLabel('Year', { exact: true }).fill('2039');
  await dialog.getByLabel('Video title', { exact: true }).fill(`${stamp} video`);
  await dialog.getByRole('button', { name: 'Add to gallery', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  item = (await catalog()).find(item => item.kind === 'video' && item.title === `${stamp} video`);
  assert.ok(item?.provider === 'youtube'); created.add(item.id);
  await site.reload({ waitUntil: 'networkidle' });
  await expect(site.getByRole('combobox', { name: 'Select gallery year' })).toHaveValue('2039');
  await expect(site.locator('.gallery-mosaic iframe')).toHaveAttribute('src', 'https://www.youtube.com/embed/wsR4jiXsO6M');

  // Record a tiny real WebM in the browser to exercise video upload, poster
  // extraction, multipart completion, native playback, and byte-range delivery.
  const videoBytes = await admin.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 64;
    const context = canvas.getContext('2d'); context.fillStyle = '#7a003c'; context.fillRect(0, 0, 96, 64);
    const stream = canvas.captureStream(5), recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks = [];
    const finished = new Promise(resolve => { recorder.ondataavailable = event => chunks.push(event.data); recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })); });
    recorder.start();
    await new Promise(resolve => setTimeout(resolve, 200)); context.fillStyle = '#fdbf57'; context.fillRect(10, 10, 30, 30);
    await new Promise(resolve => setTimeout(resolve, 400)); recorder.stop();
    const blob = await finished; stream.getTracks().forEach(track => track.stop());
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  await admin.getByRole('button', { name: 'Add media', exact: true }).click();
  dialog = admin.getByRole('dialog');
    await dialog.getByLabel('Year', { exact: true }).fill('2040');
  await dialog.locator('input[type=file]').setInputFiles({ name: 'qa-video.webm', mimeType: 'video/webm', buffer: Buffer.from(videoBytes) });
  await dialog.getByLabel('Video title', { exact: true }).fill(`${stamp} uploaded video`);
  await dialog.getByRole('button', { name: 'Add to gallery', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  item = (await catalog()).find(item => item.kind === 'video' && item.title === `${stamp} uploaded video`);
  assert.ok(item?.provider === 'upload' && item.poster && item.hash); created.add(item.id);
  const range = await fetch(item.src, { headers: { Range: 'bytes=0-15' } });
  assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 16);
  await site.reload({ waitUntil: 'networkidle' });
  await expect(site.getByRole('combobox', { name: 'Select gallery year' })).toHaveValue('2040');
  await expect(site.locator('.gallery-mosaic video')).toHaveAttribute('src', item.src);
  await site.waitForFunction(() => document.querySelector('.gallery-mosaic video')?.readyState >= 1);

  for (const width of [320, 768, 1440]) {
    await admin.setViewportSize({ width, height: 900 });
    await site.setViewportSize({ width, height: 900 });
    for (const page of [admin, site]) assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `Horizontal overflow at ${width}px`);
    await admin.screenshot({ path: `/tmp/mmb-monorepo-qa/admin-${width}.png` });
  }
  assert.deepEqual(errors, [], 'There should be no browser JavaScript errors.');
  console.log('Browser QA passed: local R2 import; real photo and video uploads with BlurHash; video range playback; draft/publish/edit/hide/remove; new years without rebuilding; YouTube creation; responsive dashboard and public gallery.');
} finally {
  for (const item of await catalog()) if (created.has(item.id) || (item.kind === 'photo' ? item.caption : item.title).startsWith(stamp)) {
    await fetch(`${API}/api/admin/items/${item.id}`, { method: 'DELETE', headers, body: JSON.stringify({ expectedUpdatedAt: item.updatedAt }) });
  }
  await writeFile('/tmp/mmb-monorepo-qa/result.json', JSON.stringify({ errors, finalItems: (await catalog()).length, originalItems: original.items.length }, null, 2));
  await browser.close();
}
