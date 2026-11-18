import { IMAGE_TYPES, VIDEO_TYPES } from '@mmb/gallery';
import { validateFile } from './media-processing';

export const MAX_UPLOAD_FILES = 100;
export function mediaKind(file: File): 'photo' | 'video' {
  if ((IMAGE_TYPES as readonly string[]).includes(file.type)) return 'photo';
  if ((VIDEO_TYPES as readonly string[]).includes(file.type)) return 'video';
  throw new Error(`${file.name}: choose a JPEG, PNG, WebP, GIF, MP4, or WebM file.`);
}
export function fileKey(file: File) { return JSON.stringify([file.name, file.size, file.type, file.lastModified]); }
export function mergeFiles(current: File[], incoming: File[]): File[] {
  const unique = new Map(current.map(file => [fileKey(file), file]));
  for (const file of incoming) {
    validateFile(file, mediaKind(file));
    if (!unique.has(fileKey(file))) unique.set(fileKey(file), file);
  }
  if (unique.size > MAX_UPLOAD_FILES) throw new Error('Choose up to 100 photos and videos per upload. Your current selection has been kept.');
  return [...unique.values()];
}
