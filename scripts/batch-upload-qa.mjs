import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const require = createRequire(new URL('../apps/website/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
const binary = (await import(require.resolve('@sparticuz/chromium'))).default;
const sharp = require('sharp');
const ADMIN = 'http://127.0.0.1:5174', API = 'http://127.0.0.1:8787';
const headers = { Origin: ADMIN, 'Content-Type': 'application/json', 'X-Requested-With': 'MMB-Gallery' };
const catalog = async () => (await (await fetch(`${API}/api/admin/items`)).json()).items;
const before = await catalog(), stamp = `Batch QA ${Date.now()}`;
await mkdir('/tmp/mmb-batch-qa', { recursive: true });
const browser = await chromium.launch({ executablePath: await binary.executablePath(), args: binary.args, headless: true });
const errors = [];
let sessionStarts = 0, lostResponse = false, lostRequestId;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/admin/uploads', route => { if (route.request().method() === 'POST') sessionStarts++; return route.continue(); });
  await page.route('**/api/admin/items', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON();
    if (!lostResponse && body.originalKey?.endsWith('/batch-photo-0.png')) {
      lostResponse = true; lostRequestId = body.clientRequestId;
      const saved = await route.fetch(); assert.equal(saved.status(), 201);
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Simulated lost save response; retry this file.' }) });
    }
    return route.continue();
  });
  await page.goto(ADMIN, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Your media' })).toBeVisible();
  await expect(page.getByText('Make the next memory.', { exact: true })).toHaveCount(0);
  await expect(page.getByText("The band's story", { exact: true })).toHaveCount(0);
  await expect(page.getByText('Add the moments that make MMB, MMB.', { exact: true })).toHaveCount(0);
  await expect(page.locator('.admin-wordmark img')).toHaveAttribute('src', 'https://mmb.nickly.me/original/6477f7b65c749071b5d7.png');
  const video = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 64;
    const context = canvas.getContext('2d'); context.fillStyle = '#7a003c'; context.fillRect(0, 0, 96, 64);
    const stream = canvas.captureStream(5), recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks = [];
    const ready = new Promise(resolve => { recorder.ondataavailable = event => chunks.push(event.data); recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })); });
    recorder.start(); await new Promise(resolve => setTimeout(resolve, 500)); recorder.stop();
    const blob = await ready; stream.getTracks().forEach(track => track.stop());
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#7a003c' } }).png().toBuffer();
  const photo = i => ({ name: `batch-photo-${i}.png`, mimeType: 'image/png', buffer: png });
  const movie = { name: 'batch-performance.webm', mimeType: 'video/webm', buffer: Buffer.from(video) };
  await page.getByRole('button', { name: 'Add media', exact: true }).click();
  let dialog = page.getByRole('dialog'); const picker = dialog.locator('input[type=file]');
  assert.equal(await picker.getAttribute('multiple'), '');
  assert.match(await picker.getAttribute('accept'), /image\/png.*video\/mp4.*video\/webm/);
  await picker.setInputFiles(Array.from({ length: 101 }, (_, i) => photo(i)));
  await expect(dialog.getByRole('alert')).toContainText('up to 100');
  await expect(dialog.locator('.selected-files li')).toHaveCount(0);
  await picker.setInputFiles(Array.from({ length: 100 }, (_, i) => photo(i)));
  await expect(dialog.locator('.selected-files li')).toHaveCount(100);
  await picker.setInputFiles(movie);
  await expect(dialog.getByRole('alert')).toContainText('up to 100');
  await expect(dialog.locator('.selected-files li')).toHaveCount(100);
  await dialog.getByRole('button', { name: 'Remove batch-photo-99.png from selection', exact: true }).click();
  await picker.setInputFiles(movie);
  await expect(dialog.locator('.selected-files li')).toHaveCount(100);
  await expect(dialog.locator('.batch-summary')).toContainText('99 photos · 1 video');
  await dialog.getByLabel('Year', { exact: true }).fill('2041');
  await dialog.getByLabel('Caption / video title', { exact: true }).fill(stamp);
  await dialog.getByLabel('Publish immediately').uncheck();
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Dashboard overflow at ${width}`);
    assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `Uploader overflow at ${width}`);
    await page.screenshot({ path: `/tmp/mmb-batch-qa/selection-${width}.png` });
  }
  await dialog.getByRole('button', { name: 'Save hidden item', exact: true }).click();
  console.log('Uploading a real 100-file batch to local R2 (99 photos and 1 video)…');
  await expect(dialog.getByRole('alert')).toContainText('99 of 100 files added.', { timeout: 180000 });
  await expect(dialog.getByRole('button', { name: 'Retry remaining files', exact: true })).toBeEnabled();
  assert.ok(lostResponse && lostRequestId, 'The test must exercise a save response lost after commit.');
  let created = (await catalog()).filter(item => (item.kind === 'photo' ? item.caption : item.title) === stamp);
  assert.equal(created.length, 100); assert.equal(created.filter(item => item.kind === 'video').length, 1);
  assert.ok(created.every(item => !item.published && item.hash && item.placeholder && item.originalKey && item.thumbnailKey));
  const startsBeforeRetry = sessionStarts;
  await dialog.getByRole('button', { name: 'Retry remaining files', exact: true }).click();
  await expect(dialog).not.toBeVisible({ timeout: 20000 });
  created = (await catalog()).filter(item => (item.kind === 'photo' ? item.caption : item.title) === stamp);
  assert.equal(created.length, 100, 'Retry must not create a duplicate after a lost response.');
  assert.equal(created.filter(item => item.id === lostRequestId).length, 1);
  assert.equal(sessionStarts, startsBeforeRetry, 'Retry reuses staged media rather than uploading again.');
  const index = await (await fetch(`${API}/api/gallery`)).json(); assert.ok(!index.years.includes(2041), 'The hidden batch must stay out of the public gallery.');
  // Cancel while both files are in flight, then discard any unused objects.
  await page.route('**/api/admin/uploads/*/parts/*', async route => { await new Promise(resolve => setTimeout(resolve, 900)); await route.continue().catch(() => {}); });
  await page.getByRole('button', { name: 'Add media', exact: true }).click(); dialog = page.getByRole('dialog');
  await dialog.locator('input[type=file]').setInputFiles([photo(200), photo(201)]);
  await dialog.getByLabel('Caption', { exact: true }).fill(`${stamp} canceled`);
  const partRequested = page.waitForRequest(request => /\/api\/admin\/uploads\/[^/]+\/parts\//.test(request.url()));
  await dialog.getByRole('button', { name: 'Add to gallery', exact: true }).click(); await partRequested;
  await dialog.getByRole('button', { name: 'Cancel upload', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Upload stopped.', { timeout: 20000 });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(dialog).not.toBeVisible();
  assert.ok(!(await catalog()).some(item => (item.kind === 'photo' ? item.caption : item.title) === `${stamp} canceled`));
  assert.deepEqual(errors, []);
  console.log('Batch QA passed: 100 mixed files; 101-file rejection; append/remove; real R2 and BlurHash; lost-response retry without duplicates or reuploads; cancellation; responsive layout; requested logo and slogan changes.');
} finally {
  for (const item of await catalog()) if ((item.kind === 'photo' ? item.caption : item.title).startsWith(stamp)) {
    const response = await fetch(`${API}/api/admin/items/${item.id}`, { method: 'DELETE', headers, body: JSON.stringify({ expectedUpdatedAt: item.updatedAt }) });
    assert.ok(response.ok, 'Test upload cleanup must succeed.');
  }
  await writeFile('/tmp/mmb-batch-qa/result.json', JSON.stringify({ errors, finalItems: (await catalog()).length, originalItems: before.length, lostResponse, sessionStarts }, null, 2));
  await browser.close();
}
