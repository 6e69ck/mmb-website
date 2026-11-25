import { assetPublicUrl, type ContentImage, type DocumentRef } from '@mmb/content';

export type AdminMode = 'local' | 'production';

export function siteOriginFor(mode: AdminMode): string {
  return mode === 'local' ? 'http://127.0.0.1:4323' : 'https://mmb.nickly.me';
}

export function resolveImageUrl(image: ContentImage | undefined, mode: AdminMode): string | null {
  if (!image) return null;
  if (image.assetKey) return assetPublicUrl(image.assetKey);
  if (image.legacyPath) return `${siteOriginFor(mode)}${image.legacyPath}`;
  return null;
}

export function resolveDocumentUrl(doc: DocumentRef, mode: AdminMode): string | null {
  if (doc.assetKey) return assetPublicUrl(doc.assetKey);
  if (doc.legacyPath) return `${siteOriginFor(mode)}${doc.legacyPath}`;
  if (doc.externalUrl) return doc.externalUrl;
  return null;
}
