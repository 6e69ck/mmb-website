export type MediaKind = 'photo' | 'video';
export type MediaFilter = 'all' | 'photos' | 'videos';
export type GalleryItemBase = {
  id: string;
  year: number;
  published: boolean;
  order: number;
  createdAt: string;
  updatedAt: string;
  originalKey?: string;
  thumbnailKey?: string;
};
export type GalleryPhoto = GalleryItemBase & {
  kind: 'photo';
  src: string;
  thumbnail: string;
  width: number;
  height: number;
  hash: string;
  placeholder: string;
  caption: string;
  alt: string;
};
export type GalleryVideo = GalleryItemBase & {
  kind: 'video';
  provider: 'youtube' | 'upload';
  src: string;
  title: string;
  note: string;
  poster?: string;
  contentType?: string;
  width?: number;
  height?: number;
  hash?: string;
  placeholder?: string;
};
export type GalleryItem = GalleryPhoto | GalleryVideo;
export type GalleryCatalog = { schemaVersion: 1; revision: number; updatedAt: string; items: GalleryItem[] };
export type GalleryIndex = { revision: number; years: number[]; photoYears: number[]; videoYears: number[]; total: number; counts: Record<string, { photos: number; videos: number }> };
export type UploadSession = { id: string; key: string; partSize: number; partCount: number };
export type UploadedPart = { partNumber: number; etag: string };
export const CATALOG_KEY = 'gallery/v1/catalog.json';
export const UPLOAD_PREFIX = 'gallery/v1/uploads/';
export const MEDIA_PREFIX = 'media/';
export const PART_SIZE = 8 * 1024 * 1024;
export const MAX_IMAGE_SIZE = 25 * 1024 * 1024;
export const MAX_VIDEO_SIZE = 1024 * 1024 * 1024;
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export const VIDEO_TYPES = ['video/mp4', 'video/webm'] as const;
export function youtubeEmbed(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    let id: string | undefined | null;
    if (url.hostname === 'youtu.be') id = url.pathname.split('/')[1];
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com'].includes(url.hostname)) {
      id = url.searchParams.get('v') || url.pathname.match(/^\/(?:embed|shorts)\/([^/]+)/)?.[1];
    }
    return id && /^[\w-]{11}$/.test(id) ? `https://www.youtube.com/embed/${id}` : null;
  } catch { return null; }
}
export function galleryIndex(catalog: GalleryCatalog, includeDrafts = false): GalleryIndex {
  const items = catalog.items.filter(item => includeDrafts || item.published);
  const years = [...new Set(items.map(item => item.year))].sort((a, b) => b - a);
  const yearsOf = (kind: MediaKind) => years.filter(year => items.some(item => item.kind === kind && item.year === year));
  return {
    revision: catalog.revision, years, photoYears: yearsOf('photo'), videoYears: yearsOf('video'), total: items.length,
    counts: Object.fromEntries(years.map(year => [String(year), { photos: items.filter(item => item.year === year && item.kind === 'photo').length, videos: items.filter(item => item.year === year && item.kind === 'video').length }])),
  };
}
