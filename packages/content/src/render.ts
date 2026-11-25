import {
  assetPublicUrl,
  richTextToPlainText,
  type ContentImage,
  type DocumentRef,
  type DriveFileEntry,
  type DriveFolderCache,
  type DriveMinutesBlock,
  type InlineNode,
  type PageBlock,
  type PageDocument,
  type RichTextBlock,
  type TeamMember,
} from './schema.ts';
import { isSafeUrl } from './validate.ts';

export type RenderOptions = {
  assetOrigin?: string;
  driveCaches?: Record<string, DriveFolderCache>;
};

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function escapeAttr(value: string): string {
  return escapeHtml(value);
}

function imageSrc(image: ContentImage, assetOrigin?: string): string | null {
  if (image.assetKey) return assetPublicUrl(image.assetKey, assetOrigin);
  if (image.legacyPath) return image.legacyPath;
  return null;
}

function renderImage(image: ContentImage, options: RenderOptions, styleAttr = ''): string {
  const src = imageSrc(image, options.assetOrigin);
  if (!src) return '';
  const dims = `${image.width ? ` width="${image.width}"` : ''}${image.height ? ` height="${image.height}"` : ''}`;
  const hash = image.hash ? ` data-blurhash="${escapeAttr(image.hash)}"` : '';
  const style = styleAttr ? ` style="${escapeAttr(styleAttr)}"` : '';
  const imgTag = `<img src="${escapeAttr(src)}" alt="${escapeAttr(image.alt || '')}"${style} loading="lazy" decoding="async"${dims}${hash} />`;
  if (image.placeholder) {
    return `<span class="progressive-image" style="--image-placeholder: url('${escapeAttr(image.placeholder)}')">${imgTag}</span>`;
  }
  return imgTag;
}

function cleanInternalHref(href: string): string {
  if (href.startsWith('/original/') || href.startsWith('/files/')) return href;
  return href.replace(/^(\/[^?#]+)\.html(?=$|[?#])/, '$1');
}

function renderInlineNodes(nodes: InlineNode[]): string {
  return nodes
    .map(node => {
      let inner = escapeHtml(node.text);
      if (node.italic) inner = `<em>${inner}</em>`;
      if (node.bold) inner = `<strong>${inner}</strong>`;
      if (node.type === 'link') {
        if (!isSafeUrl(node.href)) return inner;
        const href = cleanInternalHref(node.href);
        const external = href.startsWith('https://') || node.newTab;
        const target = external ? ' target="_blank" rel="noopener noreferrer"' : '';
        return `<a href="${escapeAttr(href)}"${target}>${inner}</a>`;
      }
      return inner;
    })
    .join('');
}

function renderRichText(blocks: RichTextBlock[], extraClass = ''): string {
  return blocks
    .map(block => {
      if (block.type === 'paragraph') {
        const html = renderInlineNodes(block.children);
        return `<div class="paragraph${extraClass ? ` ${extraClass}` : ''}">${html || '&nbsp;'}</div>`;
      }
      const tag = block.ordered ? 'ol' : 'ul';
      const items = block.items.map(item => `<li>${renderInlineNodes(item)}</li>`).join('');
      return `<${tag} class="mmb-rich-list">${items}</${tag}>`;
    })
    .join('\n');
}

function sectionWrap(innerHtml: string, background: 'white' | 'gray' = 'white', extraSectionClass = '', extraAttrs = ''): string {
  const bgStyle = background === 'gray' ? 'background-color: #e9e9e9; background-image: none;' : 'background-color: #ffffff; background-image: none;';
  const wrapClass = ['wsite-section-wrap', extraSectionClass].filter(Boolean).join(' ');
  return `<div class="${wrapClass}"${extraAttrs}>
  <div class="wsite-section wsite-body-section" style="height: auto; ${bgStyle}">
    <div class="wsite-section-content">
      <div class="container">
        <div class="wsite-section-elements">
          ${innerHtml}
        </div>
      </div>
    </div>
  </div>
</div>`;
}

function documentUrl(doc: DocumentRef, options: RenderOptions): string {
  if (doc.assetKey) return assetPublicUrl(doc.assetKey, options.assetOrigin);
  if (doc.legacyPath) return doc.legacyPath;
  if (doc.externalUrl && isSafeUrl(doc.externalUrl)) return doc.externalUrl;
  return '#';
}

function formatBytes(sizeBytes?: number): string {
  if (!sizeBytes) return '';
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileBadgeLabel(fileType: DocumentRef['fileType']): string {
  return fileType === 'link' ? 'LINK' : fileType.toUpperCase();
}

function renderDocumentCard(doc: DocumentRef, options: RenderOptions): string {
  const href = documentUrl(doc, options);
  const external = doc.fileType === 'link' || href.startsWith('https://');
  const target = external ? ' target="_blank" rel="noopener noreferrer"' : '';
  const size = formatBytes(doc.sizeBytes);
  const metaParts = [fileBadgeLabel(doc.fileType), size].filter(Boolean).join(' · ');
  const showFilename = doc.filename && doc.filename !== doc.label;
  return `<article class="mmb-doc-card">
  <div class="mmb-doc-badge" aria-hidden="true">${escapeHtml(fileBadgeLabel(doc.fileType))}</div>
  <div class="mmb-doc-info">
    <a class="mmb-doc-title" href="${escapeAttr(href)}"${target}>${escapeHtml(doc.label)}</a>
    <div class="mmb-doc-meta">${showFilename ? `<span>${escapeHtml(doc.filename)}</span> · ` : ''}<span>${escapeHtml(metaParts)}</span></div>
  </div>
  <a class="mmb-doc-action" href="${escapeAttr(href)}"${target} title="${escapeAttr(`Open ${doc.filename || doc.label}`)}">${doc.fileType === 'link' ? 'Open' : 'Download'}</a>
</article>`;
}

function renderTeamMemberCard(member: TeamMember, layout: 'executives' | 'leaders', options: RenderOptions): string {
  const id = `team-${escapeAttr(member.id)}`;
  const portrait = member.photo
    ? `<div class="mmb-team-photo">${renderImage(member.photo, options)}</div>`
    : `<div class="team-placeholder-portrait" aria-hidden="true"><span class="team-placeholder-head"></span><span class="team-placeholder-body"></span></div>`;

  const heading = `<h3 class="wsite-content-title mmb-team-name" id="${id}">${escapeHtml(member.name)}${member.pronouns ? ` <span class="mmb-team-pronouns">${escapeHtml(member.pronouns)}</span>` : ''}</h3>`;

  const subtitle = `<div class="mmb-team-role"><em>${escapeHtml(member.role)}</em>${member.program ? `<br /><em>${escapeHtml(member.program)}</em>` : ''}</div>`;

  const bioHtml = member.bio.length
    ? `<div class="mmb-team-bio">${renderRichText(member.bio)}</div>`
    : '';

  const cardClass = layout === 'leaders' ? 'mmb-team-card team-leader-profile' : 'mmb-team-card';
  return `<article class="${cardClass}" aria-labelledby="${id}">
  ${portrait}
  ${heading}
  ${subtitle}
  ${bioHtml}
</article>`;
}

function sortDriveFiles(files: DriveFileEntry[], sortOrder: DriveMinutesBlock['sortOrder']): DriveFileEntry[] {
  const copy = [...files];
  if (sortOrder === 'name-asc') return copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (sortOrder === 'modified-desc') return copy.sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
  return copy.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
}

function formatIsoDate(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function renderDriveFileList(files: DriveFileEntry[], block: DriveMinutesBlock): string {
  const sorted = sortDriveFiles(files, block.sortOrder);
  if (!sorted.length) return '';
  return `<ul class="mmb-minutes-list">${sorted
    .map(file => {
      const dateStr = block.showDates ? formatIsoDate(file.modifiedTime) : '';
      const sizeStr = formatBytes(file.size);
      const meta = [dateStr, sizeStr].filter(Boolean).join(' · ');
      const href = isSafeUrl(file.webViewLink) ? file.webViewLink : '#';
      return `<li class="mmb-minutes-item">
        <a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer" class="mmb-minutes-link">${escapeHtml(file.name)}</a>
        ${meta ? `<span class="mmb-minutes-meta">${escapeHtml(meta)}</span>` : ''}
      </li>`;
    })
    .join('')}</ul>`;
}

function renderDriveMinutes(block: DriveMinutesBlock, options: RenderOptions): string {
  const cache = block.folderId ? options.driveCaches?.[block.folderId] : undefined;
  const folderHref = block.folderUrl && isSafeUrl(block.folderUrl)
    ? block.folderUrl
    : block.folderId
      ? `https://drive.google.com/drive/folders/${encodeURIComponent(block.folderId)}`
      : '';
  const folderLink = folderHref
    ? `<p class="mmb-drive-folder-link"><a class="mmb-drive-button" href="${escapeAttr(folderHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(block.fallbackLabel || 'Open Google Drive Folder')}</a></p>`
    : '';

  if (!cache || (!cache.rootFiles.length && !cache.subfolders.length)) {
    return `<h2 class="wsite-content-title">${escapeHtml(block.heading)}</h2>
      ${folderLink}
      ${!folderHref ? '<p class="mmb-empty-note">Meeting minutes folder is not configured yet.</p>' : ''}`;
  }

  const parts: string[] = [];
  if (block.groupBySubfolder && cache.subfolders.length) {
    const folders = [...cache.subfolders].sort((a, b) =>
      block.sortOrder === 'name-asc'
        ? a.name.localeCompare(b.name, undefined, { numeric: true })
        : b.name.localeCompare(a.name, undefined, { numeric: true })
    );
    for (const folder of folders) {
      if (!folder.files.length) continue;
      parts.push(`<div class="mmb-minutes-group"><h3 class="mmb-minutes-group-heading">${escapeHtml(folder.name)}</h3>${renderDriveFileList(folder.files, block)}</div>`);
    }
    if (cache.rootFiles.length) {
      parts.push(`<div class="mmb-minutes-group">${folders.length ? '<h3 class="mmb-minutes-group-heading">Other Minutes</h3>' : ''}${renderDriveFileList(cache.rootFiles, block)}</div>`);
    }
  } else {
    const allFiles = [...cache.rootFiles, ...cache.subfolders.flatMap(sub => sub.files)];
    parts.push(renderDriveFileList(allFiles, block));
  }

  return `<div class="mmb-drive-header"><h2 class="wsite-content-title">${escapeHtml(block.heading)}</h2>${folderLink}</div>
    ${parts.join('\n')}`;
}

function renderButtonBarInner(block: Extract<PageBlock, { type: 'button-bar' }>): string {
  const buttons = block.buttons
    .map(btn => {
      const href = isSafeUrl(btn.href) ? cleanInternalHref(btn.href) : '#';
      const targetAttr = href.startsWith('#') ? ` data-faq-target="${escapeAttr(href.slice(1))}"` : href.startsWith('https://') ? ' target="_blank" rel="noopener noreferrer"' : '';
      const cls = btn.style === 'secondary' ? 'faq-audience-button mmb-button-secondary' : 'faq-audience-button';
      return `<a href="${escapeAttr(href)}" class="${cls}"${targetAttr}>${escapeHtml(btn.label)}</a>`;
    })
    .join('');
  return `<nav class="faq-audience-navigation" aria-label="${escapeAttr(block.ariaLabel || 'Section navigation')}">${buttons}</nav>`;
}

function renderHeadingInner(block: Extract<PageBlock, { type: 'heading' }>): string {
  const anchor = block.anchor ? `<span id="${escapeAttr(block.anchor)}" class="mmb-anchor-target"></span>` : '';
  const sub = block.subtitle ? `<p class="mmb-section-subtitle" style="text-align:${block.align};">${escapeHtml(block.subtitle)}</p>` : '';
  return `${anchor}<h2 class="wsite-content-title" style="text-align:${block.align};">${escapeHtml(block.text)}</h2>${sub}`;
}

function renderBlock(block: PageBlock, options: RenderOptions): string {
  switch (block.type) {
    case 'heading':
      return sectionWrap(renderHeadingInner(block), block.background);
    case 'rich-text':
      return sectionWrap(renderRichText(block.content), block.background);
    case 'button-bar':
      return sectionWrap(renderButtonBarInner(block), block.background);
    case 'image': {
      const style = block.maxWidth ? `width:${block.maxWidth}px;max-width:100%` : 'max-width:100%';
      const img = renderImage(block.image, options, style);
      const caption = block.caption ? `<figcaption class="mmb-image-caption">${escapeHtml(block.caption)}</figcaption>` : '';
      return sectionWrap(
        `<figure class="mmb-figure">${img}${caption}</figure>`,
        block.background
      );
    }
    case 'divider': {
      const heights = { sm: 16, md: 32, lg: 56 } as const;
      const line = block.showLine ? '<hr class="mmb-divider-line" />' : `<div class="wsite-spacer" style="height:${heights[block.spacing]}px;"></div>`;
      return `<div class="wsite-section-wrap mmb-divider-wrap"><div class="container">${line}</div></div>`;
    }
    case 'faq-group': {
      const headingId = `faq-${escapeAttr(block.anchor)}`;
      const itemsHtml = block.items
        .map(item => `<article class="mmb-faq-item">
          <h3 class="wsite-content-title mmb-faq-question">${escapeHtml(item.question)}</h3>
          <div class="mmb-faq-answer">${renderRichText(item.answer)}</div>
        </article>`)
        .join('\n');
      return sectionWrap(
        `<span id="${escapeAttr(block.anchor)}" class="mmb-anchor-target"></span>
        <h2 id="${headingId}" class="wsite-content-title" style="text-align:center;">${escapeHtml(block.heading)}</h2>
        <div class="mmb-faq-list">${itemsHtml}</div>`,
        block.background,
        'mmb-faq-section'
      );
    }
    case 'team-group': {
      const headingId = `team-group-${escapeAttr(block.id)}`;
      const sectionClass = block.layout === 'leaders' ? 'team-leaders' : 'team-executives';
      const gridClass = block.layout === 'leaders' ? 'mmb-team-grid mmb-team-leaders-grid' : 'mmb-team-grid mmb-team-executives-grid';
      const cards = block.members.map(member => renderTeamMemberCard(member, block.layout, options)).join('\n');
      const inner = `<h2 id="${headingId}" class="wsite-content-title team-group-heading">${escapeHtml(block.heading)}</h2>
        <div class="${gridClass}">${cards}</div>`;
      const wrapped = sectionWrap(inner, block.layout === 'leaders' ? 'gray' : block.background);
      return `<section class="${sectionClass}" aria-labelledby="${headingId}">${wrapped}</section>`;
    }
    case 'document-list': {
      const subtitle = block.subtitle ? `<p class="mmb-section-subtitle">${escapeHtml(block.subtitle)}</p>` : '';
      const docs = block.documents.length
        ? `<div class="mmb-doc-list">${block.documents.map(doc => renderDocumentCard(doc, options)).join('\n')}</div>`
        : '<p class="mmb-empty-note">No documents listed yet.</p>';
      return sectionWrap(
        `<h2 class="wsite-content-title">${escapeHtml(block.heading)}</h2>${subtitle}${docs}`,
        block.background
      );
    }
    case 'drive-minutes':
      return sectionWrap(renderDriveMinutes(block, options), block.background, 'mmb-drive-section');
    case 'sponsor-grid': {
      const cards = block.sponsors
        .map(sponsor => {
          const img = renderImage(sponsor.logo, options, 'max-width:228px;max-height:160px;width:auto;height:auto;');
          const content = sponsor.href && isSafeUrl(sponsor.href)
            ? `<a href="${escapeAttr(sponsor.href)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeAttr(sponsor.name)}">${img}</a>`
            : img;
          return `<div class="mmb-sponsor-card">${content}<span class="mmb-sponsor-name">${escapeHtml(sponsor.name)}</span></div>`;
        })
        .join('\n');
      return sectionWrap(
        `<h2 class="wsite-content-title">${escapeHtml(block.heading)}</h2>
        <div class="mmb-sponsor-grid">${cards}</div>`,
        block.background
      );
    }
  }
}

export function renderPageHtml(doc: PageDocument, options: RenderOptions = {}): string {
  const sections: string[] = [];
  for (let i = 0; i < doc.blocks.length; i++) {
    const current = doc.blocks[i];
    const next = doc.blocks[i + 1];
    if (current.type === 'heading' && next?.type === 'button-bar' && (current.background || 'white') === (next.background || 'white')) {
      sections.push(sectionWrap(`${renderHeadingInner(current)}\n${renderButtonBarInner(next)}`, current.background));
      i++;
      continue;
    }
    sections.push(renderBlock(current, options));
  }
  const html = sections.join('\n');
  const hasJumpButtons = doc.blocks.some(block => block.type === 'button-bar' && block.buttons.some(btn => btn.href.startsWith('#')));
  if (!hasJumpButtons) return html;
  return `${html}
<script>
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-faq-target]');
    if (!button) return;
    const target = document.getElementById(button.dataset.faqTarget);
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    history.replaceState(null, '', button.getAttribute('href'));
  });
</script>`;
}

export function renderStructuredDataJsonLd(doc: PageDocument): string | null {
  const faqGroups = doc.blocks.filter(block => block.type === 'faq-group');
  if (!faqGroups.length) return null;
  const mainEntity = faqGroups.flatMap(group =>
    group.items.map(item => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: richTextToPlainText(item.answer),
      },
    }))
  );
  if (!mainEntity.length) return null;
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity,
  }).replaceAll('<', '\\u003c');
}
