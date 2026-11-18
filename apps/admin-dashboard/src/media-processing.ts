import { encode, decode } from 'blurhash';
import { IMAGE_TYPES, VIDEO_TYPES, MAX_IMAGE_SIZE, MAX_VIDEO_SIZE } from '@mmb/gallery';

export type ProcessedMedia = { thumbnail: File; width: number; height: number; hash: string; placeholder: string };

export function validateFile(file: File, kind: 'photo' | 'video'): void {
  const allowed: readonly string[] = kind === 'photo' ? IMAGE_TYPES : VIDEO_TYPES;
  if (!allowed.includes(file.type)) throw new Error(kind === 'photo' ? `${file.name}: please choose a JPEG, PNG, WebP, or GIF photo.` : `${file.name}: please choose an MP4 or WebM video.`);
  if (!file.size) throw new Error(`${file.name} is empty.`);
  const max = kind === 'photo' ? MAX_IMAGE_SIZE : MAX_VIDEO_SIZE;
  if (file.size > max) throw new Error(`${file.name} is too large. ${kind === 'photo' ? 'Photos can be up to 25 MB.' : 'Videos can be up to 1 GB.'}`);
}

function abortCheck(signal: AbortSignal) { signal.throwIfAborted(); }

async function canvasMedia(source: CanvasImageSource, width: number, height: number, name: string, signal: AbortSignal): Promise<ProcessedMedia> {
  abortCheck(signal);
  const scale = Math.min(1, 1200 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Your browser could not prepare this image. Please try another browser.');
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const thumbnail = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The photo preview could not be created.')), 'image/jpeg', .86));
  const sample = document.createElement('canvas'); sample.width = 32; sample.height = 24;
  const sampleContext = sample.getContext('2d')!;
  sampleContext.drawImage(canvas, 0, 0, 32, 24);
  const hash = encode(sampleContext.getImageData(0, 0, 32, 24).data, 32, 24, 4, 3);
  sampleContext.putImageData(new ImageData(new Uint8ClampedArray(decode(hash, 32, 24)), 32, 24), 0, 0);
  abortCheck(signal);
  return { thumbnail: new File([thumbnail], `${name.replace(/\.[^.]+$/, '')}-preview.jpg`, { type: 'image/jpeg' }), width, height, hash, placeholder: sample.toDataURL('image/png') };
}

export async function processPhoto(file: File, signal: AbortSignal): Promise<ProcessedMedia> {
  validateFile(file, 'photo'); abortCheck(signal);
  const image = await createImageBitmap(file);
  try { return await canvasMedia(image, image.width, image.height, file.name, signal); }
  finally { image.close(); }
}

function videoEvent(video: HTMLVideoElement, event: 'loadedmetadata' | 'loadeddata' | 'seeked', signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timer); video.removeEventListener(event, ready); video.removeEventListener('error', failed); signal.removeEventListener('abort', aborted); };
    const ready = () => { clean(); resolve(); };
    const failed = () => { clean(); reject(new Error('This video could not be previewed. Please use an MP4 or WebM that plays in your browser.')); };
    const aborted = () => { clean(); reject(signal.reason || new DOMException('Canceled', 'AbortError')); };
    const timer = window.setTimeout(failed, 20000);
    video.addEventListener(event, ready, { once: true }); video.addEventListener('error', failed, { once: true }); signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

export async function processVideo(file: File, signal: AbortSignal): Promise<ProcessedMedia> {
  validateFile(file, 'video'); abortCheck(signal);
  const video = document.createElement('video');
  const url = URL.createObjectURL(file);
  video.muted = true; video.playsInline = true; video.preload = 'auto';
  try {
    const metadata = videoEvent(video, 'loadedmetadata', signal);
    video.src = url;
    await metadata;
    const frameTime = Number.isFinite(video.duration) ? Math.min(1, Math.max(0, video.duration / 2)) : 0;
    if (frameTime > 0) {
      const seek = videoEvent(video, 'seeked', signal); video.currentTime = frameTime; await seek;
    } else if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) await videoEvent(video, 'loadeddata', signal);
    if (!video.videoWidth || !video.videoHeight) throw new Error('The video does not have a readable picture.');
    return await canvasMedia(video, video.videoWidth, video.videoHeight, file.name, signal);
  } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
}
