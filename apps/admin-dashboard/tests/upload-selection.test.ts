import { describe, expect, it } from 'vitest';
import { fileKey, mediaKind, mergeFiles } from '../src/upload-selection';

const photo = (index: number) => new File(['photo'], `photo-${index}.png`, { type: 'image/png', lastModified: 1 });
const video = (index: number) => new File(['video'], `video-${index}.webm`, { type: 'video/webm', lastModified: 1 });

describe('mixed media upload selection', () => {
  it('accepts 100 photos or a mixed 100-file batch without dropping videos', () => {
    expect(mergeFiles([], Array.from({ length: 100 }, (_, i) => photo(i)))).toHaveLength(100);
    const mixed = mergeFiles([], [...Array.from({ length: 98 }, (_, i) => photo(i)), video(1), video(2)]);
    expect(mixed).toHaveLength(100);
    expect(mixed.filter(file => mediaKind(file) === 'video')).toHaveLength(2);
  });
  it('rejects a 101st file without changing the existing selection', () => {
    const current = Array.from({ length: 100 }, (_, i) => photo(i));
    expect(() => mergeFiles(current, [video(1)])).toThrow(/up to 100/);
    expect(current).toHaveLength(100);
  });
  it('appends additional selections and ignores exact reselected files', () => {
    const first = photo(1);
    const result = mergeFiles([first], [photo(1), photo(2), video(1)]);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(first);
    expect(new Set(result.map(fileKey)).size).toBe(3);
  });
  it('rejects unsupported and empty files without silently discarding them', () => {
    expect(() => mergeFiles([], [new File(['text'], 'notes.txt', { type: 'text/plain' })])).toThrow(/notes.txt/);
    expect(() => mergeFiles([], [new File([], 'empty.mp4', { type: 'video/mp4' })])).toThrow(/empty/);
  });
});
