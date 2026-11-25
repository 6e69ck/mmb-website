import {
  CONTENT_ASSET_PREFIX,
  PAGE_METADATA,
  extractDriveFolderId,
  isPageSlug,
  type ContentImage,
  type DocumentFileType,
  type DocumentRef,
  type InlineNode,
  type PageBlock,
  type PageDocument,
  type PageSlug,
  type RichTextBlock,
  type SectionBackground,
} from './schema.ts';

export class ContentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentValidationError';
  }
}

export function isSafeUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const value = raw.trim();
  if (!value || value.length > 2048) return false;
  if (/[\u0000-\u001F\u007F]/.test(value)) return false;
  if (value.startsWith('#')) return /^#[a-zA-Z0-9_-]{1,80}$/.test(value);
  if (value.startsWith('/')) return !value.startsWith('//') && !value.startsWith('/\\');
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'mailto:';
  } catch {
    return false;
  }
}

export function isSafeContentAssetKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 240 &&
    !value.includes('..') &&
    /^content\/assets\/[0-9a-f-]{36}\/[\w.-]+$/i.test(value)
  );
}

export function isSafeLegacyPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 240 &&
    !value.includes('..') &&
    /^\/original\/[\w.-]+$/.test(value)
  );
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContentValidationError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function cleanText(value: unknown, label: string, max: number, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new ContentValidationError(`${label} is required.`);
    return '';
  }
  if (typeof value !== 'string') throw new ContentValidationError(`${label} must be text.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new ContentValidationError(`${label} is required.`);
  if (trimmed.length > max) throw new ContentValidationError(`${label} must be ${max} characters or fewer.`);
  return trimmed;
}

function cleanRawInlineText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new ContentValidationError(`${label} must be text.`);
  if (value.length > max) throw new ContentValidationError(`${label} must be ${max} characters or fewer.`);
  return value;
}

function cleanId(value: unknown, label: string): string {
  const id = cleanText(value, label, 80, true);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new ContentValidationError(`${label} contains invalid characters.`);
  return id;
}

function cleanAnchor(value: unknown, label: string): string {
  const anchor = cleanText(value, label, 80);
  if (!anchor) return '';
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(anchor)) {
    throw new ContentValidationError(`${label} must start with a letter and use only letters, numbers, hyphens, or underscores.`);
  }
  return anchor;
}

function cleanBackground(value: unknown): SectionBackground {
  return value === 'gray' ? 'gray' : 'white';
}

function validateInlineNodes(nodes: unknown, label: string): InlineNode[] {
  if (!Array.isArray(nodes)) throw new ContentValidationError(`${label} must be a list of text spans.`);
  if (nodes.length > 500) throw new ContentValidationError(`${label} has too many inline segments.`);
  return nodes.map((raw, index) => {
    const node = asObject(raw, `${label}[${index}]`);
    const bold = node.bold === true ? true : undefined;
    const italic = node.italic === true ? true : undefined;
    if (node.type === 'text') {
      return {
        type: 'text',
        text: cleanRawInlineText(node.text, `${label} text`, 10_000),
        ...(bold ? { bold } : {}),
        ...(italic ? { italic } : {}),
      };
    }
    if (node.type === 'link') {
      const text = cleanRawInlineText(node.text, `${label} link text`, 500);
      if (!text.trim()) throw new ContentValidationError(`${label} link text cannot be empty.`);
      const href = cleanText(node.href, `${label} link URL`, 2048, true);
      if (!isSafeUrl(href)) {
        throw new ContentValidationError(`${label} link URL must start with https://, mailto:, /, or #.`);
      }
      const newTab = node.newTab === true ? true : undefined;
      return {
        type: 'link',
        text,
        href,
        ...(bold ? { bold } : {}),
        ...(italic ? { italic } : {}),
        ...(newTab ? { newTab } : {}),
      };
    }
    throw new ContentValidationError(`${label} contains an unsupported inline type.`);
  });
}

function validateRichText(value: unknown, label: string): RichTextBlock[] {
  if (!Array.isArray(value)) throw new ContentValidationError(`${label} must be a rich-text array.`);
  if (value.length > 100) throw new ContentValidationError(`${label} has too many paragraphs.`);
  return value.map((raw, index) => {
    const item = asObject(raw, `${label}[${index}]`);
    if (item.type === 'paragraph') {
      return { type: 'paragraph', children: validateInlineNodes(item.children, `${label} paragraph`) };
    }
    if (item.type === 'list') {
      if (!Array.isArray(item.items)) throw new ContentValidationError(`${label} list items must be an array.`);
      if (item.items.length > 100) throw new ContentValidationError(`${label} list has too many items.`);
      return {
        type: 'list',
        ordered: item.ordered === true,
        items: item.items.map((entry, itemIndex) => validateInlineNodes(entry, `${label} list item ${itemIndex + 1}`)),
      };
    }
    throw new ContentValidationError(`${label} contains an unsupported rich-text block.`);
  });
}

function validateImage(raw: unknown, label: string, requireSource = false): ContentImage {
  const obj = asObject(raw, label);
  const assetKey = obj.assetKey !== undefined && obj.assetKey !== '' ? String(obj.assetKey) : undefined;
  const legacyPath = obj.legacyPath !== undefined && obj.legacyPath !== '' ? String(obj.legacyPath) : undefined;
  if (assetKey && !isSafeContentAssetKey(assetKey)) {
    throw new ContentValidationError(`${label} has an invalid uploaded image key.`);
  }
  if (legacyPath && !isSafeLegacyPath(legacyPath)) {
    throw new ContentValidationError(`${label} has an invalid legacy image path.`);
  }
  if (requireSource && !assetKey && !legacyPath) {
    throw new ContentValidationError(`${label} must include an uploaded or existing image.`);
  }
  const alt = cleanText(obj.alt, `${label} alt text`, 500);
  const width = obj.width !== undefined ? Number(obj.width) : undefined;
  const height = obj.height !== undefined ? Number(obj.height) : undefined;
  if (width !== undefined && (!Number.isSafeInteger(width) || width <= 0 || width > 65000)) {
    throw new ContentValidationError(`${label} width is invalid.`);
  }
  if (height !== undefined && (!Number.isSafeInteger(height) || height <= 0 || height > 65000)) {
    throw new ContentValidationError(`${label} height is invalid.`);
  }
  const hash = obj.hash !== undefined ? cleanText(obj.hash, `${label} BlurHash`, 150) : undefined;
  const placeholder = obj.placeholder !== undefined ? cleanText(obj.placeholder, `${label} placeholder`, 32768) : undefined;
  if (placeholder && !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(placeholder)) {
    throw new ContentValidationError(`${label} placeholder must be a valid PNG data URI.`);
  }
  return {
    ...(assetKey ? { assetKey } : {}),
    ...(legacyPath ? { legacyPath } : {}),
    alt,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(hash ? { hash } : {}),
    ...(placeholder ? { placeholder } : {}),
  };
}

const VALID_DOC_TYPES = new Set<DocumentFileType>(['pdf', 'xlsx', 'xls', 'csv', 'docx', 'link']);

function validateDocumentRef(raw: unknown, label: string): DocumentRef {
  const obj = asObject(raw, label);
  const id = cleanId(obj.id, `${label} id`);
  const docLabel = cleanText(obj.label, `${label} label`, 240, true);
  const filename = cleanText(obj.filename, `${label} filename`, 240, true);
  const assetKey = obj.assetKey !== undefined && obj.assetKey !== '' ? String(obj.assetKey) : undefined;
  const legacyPath = obj.legacyPath !== undefined && obj.legacyPath !== '' ? String(obj.legacyPath) : undefined;
  const externalUrl = obj.externalUrl !== undefined && obj.externalUrl !== '' ? cleanText(obj.externalUrl, `${label} URL`, 2048) : undefined;

  if (assetKey && !isSafeContentAssetKey(assetKey)) {
    throw new ContentValidationError(`${label} has an invalid asset key.`);
  }
  if (legacyPath && !isSafeLegacyPath(legacyPath)) {
    throw new ContentValidationError(`${label} has an invalid legacy file path.`);
  }
  if (externalUrl && !isSafeUrl(externalUrl)) {
    throw new ContentValidationError(`${label} external URL must use https://.`);
  }
  if (!assetKey && !legacyPath && !externalUrl) {
    throw new ContentValidationError(`${label} must have an uploaded file, legacy file, or external URL.`);
  }

  const fileType = cleanText(obj.fileType, `${label} file type`, 16, true) as DocumentFileType;
  if (!VALID_DOC_TYPES.has(fileType)) {
    throw new ContentValidationError(`${label} has an unsupported file type.`);
  }
  const sizeBytes = obj.sizeBytes !== undefined ? Number(obj.sizeBytes) : undefined;
  if (sizeBytes !== undefined && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)) {
    throw new ContentValidationError(`${label} file size is invalid.`);
  }

  return {
    id,
    label: docLabel,
    filename,
    ...(assetKey ? { assetKey } : {}),
    ...(legacyPath ? { legacyPath } : {}),
    ...(externalUrl ? { externalUrl } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    fileType,
  };
}

export function validateBlock(raw: unknown, index: number): PageBlock {
  const obj = asObject(raw, `Block ${index + 1}`);
  const id = cleanId(obj.id, `Block ${index + 1} id`);
  const background = cleanBackground(obj.background);

  switch (obj.type) {
    case 'heading': {
      const text = cleanText(obj.text, 'Heading text', 240, true);
      const subtitle = cleanText(obj.subtitle, 'Heading subtitle', 500);
      const align = obj.align === 'center' ? 'center' : 'left';
      const anchor = cleanAnchor(obj.anchor, 'Heading anchor');
      return {
        id,
        type: 'heading',
        text,
        ...(subtitle ? { subtitle } : {}),
        align,
        ...(anchor ? { anchor } : {}),
        background,
      };
    }
    case 'rich-text':
      return {
        id,
        type: 'rich-text',
        content: validateRichText(obj.content, 'Rich text block'),
        background,
      };
    case 'button-bar': {
      if (!Array.isArray(obj.buttons) || !obj.buttons.length || obj.buttons.length > 10) {
        throw new ContentValidationError('Button bar must have between 1 and 10 buttons.');
      }
      const ariaLabel = cleanText(obj.ariaLabel, 'Button bar label', 120);
      return {
        id,
        type: 'button-bar',
        ...(ariaLabel ? { ariaLabel } : {}),
        background,
        buttons: obj.buttons.map((rawBtn, btnIndex) => {
          const btn = asObject(rawBtn, `Button ${btnIndex + 1}`);
          const href = cleanText(btn.href, `Button ${btnIndex + 1} link`, 2048, true);
          if (!isSafeUrl(href)) {
            throw new ContentValidationError(`Button ${btnIndex + 1} link must start with https://, mailto:, /, or #.`);
          }
          return {
            id: cleanId(btn.id, `Button ${btnIndex + 1} id`),
            label: cleanText(btn.label, `Button ${btnIndex + 1} label`, 80, true),
            href,
            style: btn.style === 'secondary' ? 'secondary' : 'primary',
          };
        }),
      };
    }
    case 'image': {
      const image = validateImage(obj.image, 'Image block', true);
      const caption = cleanText(obj.caption, 'Image caption', 500);
      const maxWidth = obj.maxWidth !== undefined ? Number(obj.maxWidth) : undefined;
      if (maxWidth !== undefined && (!Number.isSafeInteger(maxWidth) || maxWidth < 40 || maxWidth > 2000)) {
        throw new ContentValidationError('Image max width must be between 40 and 2000 pixels.');
      }
      return {
        id,
        type: 'image',
        image,
        ...(caption ? { caption } : {}),
        ...(maxWidth !== undefined ? { maxWidth } : {}),
        background,
      };
    }
    case 'divider': {
      const spacing = obj.spacing === 'sm' || obj.spacing === 'lg' ? obj.spacing : 'md';
      return { id, type: 'divider', spacing, showLine: obj.showLine === true };
    }
    case 'faq-group': {
      if (!Array.isArray(obj.items) || obj.items.length > 100) {
        throw new ContentValidationError('FAQ group must contain 0 to 100 questions.');
      }
      const anchor = cleanAnchor(obj.anchor, 'FAQ section anchor');
      if (!anchor) throw new ContentValidationError('FAQ section anchor is required.');
      return {
        id,
        type: 'faq-group',
        anchor,
        buttonLabel: cleanText(obj.buttonLabel, 'FAQ jump button label', 80, true),
        heading: cleanText(obj.heading, 'FAQ section heading', 200, true),
        background,
        items: obj.items.map((rawItem, itemIndex) => {
          const item = asObject(rawItem, `FAQ item ${itemIndex + 1}`);
          return {
            id: cleanId(item.id, `FAQ item ${itemIndex + 1} id`),
            question: cleanText(item.question, `FAQ question ${itemIndex + 1}`, 400, true),
            answer: validateRichText(item.answer, `FAQ answer ${itemIndex + 1}`),
          };
        }),
      };
    }
    case 'team-group': {
      if (!Array.isArray(obj.members) || obj.members.length > 100) {
        throw new ContentValidationError('Team group must contain 0 to 100 members.');
      }
      const layout = obj.layout === 'leaders' ? 'leaders' : 'executives';
      return {
        id,
        type: 'team-group',
        heading: cleanText(obj.heading, 'Team group heading', 160, true),
        layout,
        background,
        members: obj.members.map((rawMember, memberIndex) => {
          const member = asObject(rawMember, `Team member ${memberIndex + 1}`);
          const pronouns = cleanText(member.pronouns, `Member ${memberIndex + 1} pronouns`, 60);
          const program = cleanText(member.program, `Member ${memberIndex + 1} program`, 160);
          const photo =
            member.photo && typeof member.photo === 'object' && ((member.photo as Record<string, unknown>).assetKey || (member.photo as Record<string, unknown>).legacyPath)
              ? validateImage(member.photo, `Member ${memberIndex + 1} photo`, true)
              : undefined;
          return {
            id: cleanId(member.id, `Member ${memberIndex + 1} id`),
            name: cleanText(member.name, `Member ${memberIndex + 1} name`, 120, true),
            ...(pronouns ? { pronouns } : {}),
            role: cleanText(member.role, `Member ${memberIndex + 1} role`, 160, true),
            ...(program ? { program } : {}),
            bio: Array.isArray(member.bio) ? validateRichText(member.bio, `Member ${memberIndex + 1} bio`) : [],
            ...(photo ? { photo } : {}),
          };
        }),
      };
    }
    case 'document-list': {
      if (!Array.isArray(obj.documents) || obj.documents.length > 100) {
        throw new ContentValidationError('Document list must contain 0 to 100 documents.');
      }
      const subtitle = cleanText(obj.subtitle, 'Document list subtitle', 300);
      return {
        id,
        type: 'document-list',
        heading: cleanText(obj.heading, 'Document list heading', 200, true),
        ...(subtitle ? { subtitle } : {}),
        background,
        documents: obj.documents.map((doc, docIndex) => validateDocumentRef(doc, `Document ${docIndex + 1}`)),
      };
    }
    case 'drive-minutes': {
      const folderUrl = cleanText(obj.folderUrl, 'Google Drive folder URL', 2048);
      const folderId = folderUrl ? extractDriveFolderId(folderUrl) : cleanText(obj.folderId, 'Folder ID', 120);
      if (folderUrl && !folderId) {
        throw new ContentValidationError('Enter a valid https://drive.google.com/drive/folders/... link.');
      }
      const fallbackLabel = cleanText(obj.fallbackLabel, 'Folder button label', 160);
      const sortOrder =
        obj.sortOrder === 'name-asc' || obj.sortOrder === 'modified-desc' ? obj.sortOrder : 'name-desc';
      return {
        id,
        type: 'drive-minutes',
        heading: cleanText(obj.heading, 'Meeting minutes heading', 200, true),
        folderUrl: folderUrl || (folderId ? `https://drive.google.com/drive/folders/${folderId}` : ''),
        folderId: folderId || '',
        ...(fallbackLabel ? { fallbackLabel } : {}),
        groupBySubfolder: obj.groupBySubfolder !== false,
        sortOrder,
        showDates: obj.showDates !== false,
        background,
      };
    }
    case 'sponsor-grid': {
      if (!Array.isArray(obj.sponsors) || obj.sponsors.length > 60) {
        throw new ContentValidationError('Sponsor grid must contain 0 to 60 sponsors.');
      }
      return {
        id,
        type: 'sponsor-grid',
        heading: cleanText(obj.heading, 'Sponsors heading', 160, true),
        background,
        sponsors: obj.sponsors.map((rawSponsor, sIndex) => {
          const sponsor = asObject(rawSponsor, `Sponsor ${sIndex + 1}`);
          const href = cleanText(sponsor.href, `Sponsor ${sIndex + 1} URL`, 2048);
          if (href && !isSafeUrl(href)) {
            throw new ContentValidationError(`Sponsor ${sIndex + 1} URL must start with https:// or /.`);
          }
          return {
            id: cleanId(sponsor.id, `Sponsor ${sIndex + 1} id`),
            name: cleanText(sponsor.name, `Sponsor ${sIndex + 1} name`, 120, true),
            ...(href ? { href } : {}),
            logo: validateImage(sponsor.logo, `Sponsor ${sIndex + 1} logo`, true),
          };
        }),
      };
    }
    default:
      throw new ContentValidationError(`Block ${index + 1} has an unknown block type.`);
  }
}

export function validatePageInput(
  slug: string,
  raw: unknown
): { seo: PageDocument['seo']; blocks: PageBlock[]; commitMessage?: string } {
  if (!isPageSlug(slug)) {
    throw new ContentValidationError('Unknown editable page.');
  }
  const obj = asObject(raw, 'Page payload');
  const rawSeo = asObject(obj.seo ?? {}, 'SEO settings');
  const meta = PAGE_METADATA[slug as PageSlug];
  const title = cleanText(rawSeo.title, 'Page title', 160) || meta.defaultTitle;
  const description = cleanText(rawSeo.description, 'Page meta description', 320);

  if (!Array.isArray(obj.blocks)) {
    throw new ContentValidationError('Page blocks must be an array.');
  }
  if (obj.blocks.length > 80) {
    throw new ContentValidationError('A page can have at most 80 blocks.');
  }

  const seenIds = new Set<string>();
  const blocks = obj.blocks.map((block, index) => {
    const validated = validateBlock(block, index);
    if (seenIds.has(validated.id)) {
      throw new ContentValidationError(`Duplicate block id "${validated.id}".`);
    }
    seenIds.add(validated.id);
    return validated;
  });

  const commitMessage = cleanText(obj.commitMessage, 'Commit message', 240);
  return {
    seo: { title, description },
    blocks,
    ...(commitMessage ? { commitMessage } : {}),
  };
}

export function validateStoredPageDocument(raw: unknown): PageDocument {
  const obj = asObject(raw, 'Stored page document');
  if (obj.schemaVersion !== 1 || typeof obj.slug !== 'string' || !isPageSlug(obj.slug)) {
    throw new ContentValidationError('Unsupported stored page format.');
  }
  if (!Number.isSafeInteger(obj.revision) || (obj.revision as number) < 0) {
    throw new ContentValidationError('Invalid page revision number.');
  }
  const { seo, blocks } = validatePageInput(obj.slug, obj);
  const updatedAt = cleanText(obj.updatedAt, 'updatedAt', 64, true);
  const updatedBy = cleanText(obj.updatedBy, 'updatedBy', 200, true);
  const gitSha = typeof obj.gitSha === 'string' && /^[a-f0-9]{7,64}$/i.test(obj.gitSha) ? obj.gitSha : undefined;
  const commitMessage = typeof obj.commitMessage === 'string' ? obj.commitMessage.slice(0, 240) : undefined;
  return {
    schemaVersion: 1,
    slug: obj.slug,
    revision: obj.revision as number,
    ...(gitSha ? { gitSha } : {}),
    ...(commitMessage ? { commitMessage } : {}),
    updatedAt,
    updatedBy,
    seo,
    blocks,
  };
}

export { CONTENT_ASSET_PREFIX };
