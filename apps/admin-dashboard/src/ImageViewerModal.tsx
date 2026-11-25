import { useEffect, useRef, useState } from 'react';
import { Icon } from './ui';
import './image-viewer.css';

export type ImageViewerItem = {
  src: string;
  alt?: string;
  filename?: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
  format?: string;
};

const MIME_FORMAT_MAP: Record<string, string> = {
  'image/jpeg': 'JPEG',
  'image/jpg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WEBP',
  'image/gif': 'GIF',
  'image/svg+xml': 'SVG',
  'image/avif': 'AVIF',
  'image/bmp': 'BMP',
  'image/tiff': 'TIFF',
  'image/x-icon': 'ICO',
  'image/vnd.microsoft.icon': 'ICO',
  'image/heic': 'HEIC',
  'image/heif': 'HEIF',
};

const EXT_FORMAT_MAP: Record<string, string> = {
  jpg: 'JPEG',
  jpeg: 'JPEG',
  jpe: 'JPEG',
  jfif: 'JPEG',
  tif: 'TIFF',
  tiff: 'TIFF',
};

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function extractFilename(src: string): string {
  const trimmed = src.trim();
  if (!trimmed || /^data:/i.test(trimmed)) return '';

  let pathname = '';
  try {
    const parsed = new URL(trimmed, 'http://localhost');
    if (parsed.protocol === 'data:') return '';
    pathname = parsed.pathname;
  } catch {
    pathname = trimmed.split('#')[0].split('?')[0];
  }

  if (!pathname || pathname.endsWith('/')) return '';
  const lastSlash = pathname.lastIndexOf('/');
  const segment = lastSlash >= 0 ? pathname.slice(lastSlash + 1) : pathname;
  return segment ? safeDecode(segment).trim() : '';
}

function formatFromMime(contentType?: string | null): string {
  if (!contentType) return '';
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (!mime.startsWith('image/')) return '';
  if (MIME_FORMAT_MAP[mime]) return MIME_FORMAT_MAP[mime];
  const subtype = mime.slice('image/'.length).split('+')[0].replace(/^x-/, '');
  return subtype ? subtype.toUpperCase() : '';
}

export function inferImageFormat(src: string, contentType?: string | null): string {
  const fromHeader = formatFromMime(contentType);
  if (fromHeader) return fromHeader;

  const trimmed = src.trim();
  const dataMatch = trimmed.match(/^data:(image\/[^;,]+)/i);
  if (dataMatch) {
    const fromData = formatFromMime(dataMatch[1]);
    if (fromData) return fromData;
  }

  const filename = extractFilename(trimmed);
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === filename.length - 1) return '';

  const ext = filename.slice(dotIndex + 1).toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(ext)) return '';
  return EXT_FORMAT_MAP[ext] ?? ext.toUpperCase();
}

export function formatFileSize(bytes?: number | null): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  const kb = bytes / 1024;
  if (Math.round(kb) < 1024) {
    const value = kb >= 10 ? String(Math.round(kb)) : String(Number(kb.toFixed(1)));
    return `${value} KB`;
  }

  const mb = bytes / (1024 * 1024);
  if (mb < 1024) {
    const value = mb >= 100 ? String(Math.round(mb)) : mb.toFixed(1);
    return `${value} MB`;
  }

  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(2)} GB`;
}

type ResolvedHeadMeta = {
  src: string;
  sizeBytes?: number;
  contentType?: string;
};

type NaturalDimensions = {
  src: string;
  width: number;
  height: number;
};

export function ImageViewerModal({
  item,
  onClose,
}: {
  item: ImageViewerItem;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [naturalSize, setNaturalSize] = useState<NaturalDimensions | null>(null);
  const [headMeta, setHeadMeta] = useState<ResolvedHeadMeta | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    return () => {
      if (dialog?.open) dialog.close();
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);

  useEffect(() => {
    setLoadFailed(false);
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
      setNaturalSize({
        src: item.src,
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
    }
  }, [item.src]);

  useEffect(() => {
    const needsSize = item.sizeBytes == null;
    const needsFormat = !item.format?.trim();
    if ((!needsSize && !needsFormat) || !item.src || /^data:/i.test(item.src.trim())) {
      return;
    }

    const controller = new AbortController();
    void fetch(item.src, { method: 'HEAD', signal: controller.signal })
      .then(response => {
        if (!response.ok || controller.signal.aborted) return;
        const lengthHeader = response.headers.get('content-length');
        const parsedLength = lengthHeader !== null ? Number(lengthHeader) : NaN;
        const sizeBytes =
          Number.isFinite(parsedLength) && parsedLength >= 0 ? parsedLength : undefined;
        const contentType = response.headers.get('content-type') || undefined;
        if (sizeBytes !== undefined || contentType) {
          setHeadMeta({ src: item.src, sizeBytes, contentType });
        }
      })
      .catch(() => {
        // Silently ignore CORS, network, or abort failures
      });

    return () => controller.abort();
  }, [item.src, item.sizeBytes, item.format]);

  const activeNatural = naturalSize?.src === item.src ? naturalSize : null;
  const activeHead = headMeta?.src === item.src ? headMeta : null;

  const displayFilename = item.filename?.trim() || extractFilename(item.src) || 'Image';
  const resolvedWidth = item.width && item.width > 0 ? item.width : activeNatural?.width;
  const resolvedHeight = item.height && item.height > 0 ? item.height : activeNatural?.height;
  const dimensionsLabel =
    resolvedWidth && resolvedHeight ? `${resolvedWidth} × ${resolvedHeight} px` : null;
  const formatLabel =
    item.format?.trim().toUpperCase() ||
    inferImageFormat(item.src, activeHead?.contentType) ||
    null;
  const sizeLabel = formatFileSize(
    item.sizeBytes != null ? item.sizeBytes : activeHead?.sizeBytes
  );

  const metaParts = [dimensionsLabel, formatLabel, sizeLabel].filter(
    (part): part is string => Boolean(part)
  );

  return (
    <dialog
      ref={dialogRef}
      className="image-viewer-modal"
      aria-label={`Image preview: ${displayFilename}`}
      onCancel={event => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onClick={event => {
        event.stopPropagation();
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="image-viewer-stage"
        onClick={event => {
          if (event.target === event.currentTarget) {
            onClose();
          }
        }}
      >
        <div className="image-viewer-topbar">
          <a
            className="image-viewer-raw-link"
            href={item.src}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span>Open raw image</span>
            <Icon name="arrow" size={14} />
          </a>
          <button
            type="button"
            className="image-viewer-close"
            aria-label="Close image viewer"
            onClick={onClose}
          >
            <Icon name="close" size={20} />
          </button>
        </div>

        <div className="image-viewer-canvas">
          {loadFailed ? (
            <div className="image-viewer-error" role="alert">
              <Icon name="image" size={32} />
              <p>Could not load image preview.</p>
              <a
                className="image-viewer-raw-link"
                href={item.src}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span>Open raw image</span>
                <Icon name="arrow" size={14} />
              </a>
            </div>
          ) : (
            <img
              ref={imgRef}
              key={item.src}
              className="image-viewer-img"
              src={item.src}
              alt={item.alt || displayFilename}
              onLoad={event => {
                const target = event.currentTarget;
                if (target.naturalWidth > 0 && target.naturalHeight > 0) {
                  setNaturalSize({
                    src: item.src,
                    width: target.naturalWidth,
                    height: target.naturalHeight,
                  });
                }
              }}
              onError={() => setLoadFailed(true)}
            />
          )}
        </div>

        <aside className="image-viewer-info" aria-label="Image details">
          <div className="image-viewer-filename" title={displayFilename}>
            {displayFilename}
          </div>
          {metaParts.length > 0 && (
            <dl className="image-viewer-meta">
              {dimensionsLabel && (
                <div>
                  <dt>Dimensions</dt>
                  <dd>{dimensionsLabel}</dd>
                </div>
              )}
              {formatLabel && (
                <div>
                  <dt>Format</dt>
                  <dd>{formatLabel}</dd>
                </div>
              )}
              {sizeLabel && (
                <div>
                  <dt>Size</dt>
                  <dd>{sizeLabel}</dd>
                </div>
              )}
            </dl>
          )}
        </aside>
      </div>
    </dialog>
  );
}

export default ImageViewerModal;
