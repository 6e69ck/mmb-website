import { describe, expect, it } from 'vitest';
import {
  extractFilename,
  formatFileSize,
  inferImageFormat,
} from '../src/ImageViewerModal';

describe('extractFilename', () => {
  it('extracts filename from full HTTPS URLs and strips query/hash', () => {
    expect(
      extractFilename('https://media.mmb.nickly.me/media/2025/homecoming-band.jpg?v=42#preview')
    ).toBe('homecoming-band.jpg');
  });

  it('decodes URL-encoded characters cleanly', () => {
    expect(
      extractFilename('https://example.com/assets/Marching%20Band%20(2025).png?download=1')
    ).toBe('Marching Band (2025).png');
  });

  it('handles malformed percent encoding without throwing', () => {
    expect(extractFilename('/media/100%bad%E0%A4%A.jpg')).toBe('100%bad%E0%A4%A.jpg');
  });

  it('extracts filename from root-relative and relative paths', () => {
    expect(extractFilename('/media/2024/drumline.webp?size=full')).toBe('drumline.webp');
    expect(extractFilename('photos/parade.gif#section')).toBe('parade.gif');
    expect(extractFilename('logo.png')).toBe('logo.png');
  });

  it('returns empty string for empty strings, origin-only URLs, trailing slashes, and data URLs', () => {
    expect(extractFilename('')).toBe('');
    expect(extractFilename('   ')).toBe('');
    expect(extractFilename('https://example.com')).toBe('');
    expect(extractFilename('https://example.com/')).toBe('');
    expect(extractFilename('/media/2025/')).toBe('');
    expect(extractFilename('data:image/png;base64,iVBORw0KGgo=')).toBe('');
  });
});

describe('inferImageFormat', () => {
  it('maps standard image MIME types to uppercase format labels', () => {
    expect(inferImageFormat('/media/file', 'image/jpeg')).toBe('JPEG');
    expect(inferImageFormat('/media/file', 'image/jpg')).toBe('JPEG');
    expect(inferImageFormat('/media/file', 'image/png')).toBe('PNG');
    expect(inferImageFormat('/media/file', 'image/webp')).toBe('WEBP');
    expect(inferImageFormat('/media/file', 'image/gif')).toBe('GIF');
    expect(inferImageFormat('/media/file', 'image/svg+xml')).toBe('SVG');
    expect(inferImageFormat('/media/file', 'image/avif')).toBe('AVIF');
  });

  it('handles MIME type parameters and uppercase headers', () => {
    expect(inferImageFormat('/media/asset', 'IMAGE/JPEG; charset=utf-8')).toBe('JPEG');
    expect(inferImageFormat('/media/asset', 'image/png; version=1')).toBe('PNG');
  });

  it('prefers valid image Content-Type over URL extension', () => {
    expect(inferImageFormat('/media/photo.png', 'image/webp')).toBe('WEBP');
  });

  it('falls back to URL file extension when Content-Type is missing or non-image', () => {
    expect(inferImageFormat('/media/parade.png')).toBe('PNG');
    expect(inferImageFormat('/media/parade.webp?v=2#top', null)).toBe('WEBP');
    expect(inferImageFormat('/media/parade.gif', 'application/octet-stream')).toBe('GIF');
    expect(inferImageFormat('/media/parade.jpg')).toBe('JPEG');
    expect(inferImageFormat('/media/parade.jpeg')).toBe('JPEG');
    expect(inferImageFormat('/media/logo.svg')).toBe('SVG');
  });

  it('extracts format from data URLs', () => {
    expect(inferImageFormat('data:image/png;base64,abc123')).toBe('PNG');
    expect(inferImageFormat('data:image/webp;base64,abc123')).toBe('WEBP');
  });

  it('returns empty string when neither MIME type nor extension is available', () => {
    expect(inferImageFormat('https://example.com/media/12345')).toBe('');
    expect(inferImageFormat('/media/.hidden')).toBe('');
    expect(inferImageFormat('')).toBe('');
  });
});

describe('formatFileSize', () => {
  it('formats bytes cleanly', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(842)).toBe('842 B');
    expect(formatFileSize(1023)).toBe('1023 B');
  });

  it('formats kilobytes cleanly', () => {
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(148 * 1024)).toBe('148 KB');
  });

  it('formats megabytes and gigabytes cleanly', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatFileSize(Math.round(2.4 * 1024 * 1024))).toBe('2.4 MB');
    expect(formatFileSize(1024 * 1024 - 1)).toBe('1.0 MB');
    expect(formatFileSize(Math.round(2.5 * 1024 * 1024 * 1024))).toBe('2.50 GB');
  });

  it('returns null for missing or invalid values', () => {
    expect(formatFileSize(undefined)).toBeNull();
    expect(formatFileSize(null)).toBeNull();
    expect(formatFileSize(-10)).toBeNull();
    expect(formatFileSize(Number.NaN)).toBeNull();
    expect(formatFileSize(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
