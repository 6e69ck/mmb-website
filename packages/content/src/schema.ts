export const PAGE_SLUGS = [
  'faq',
  'our-team',
  'budget',
  'constitution',
  'executive-meeting-minutes',
] as const;

export type PageSlug = (typeof PAGE_SLUGS)[number];

export type PageMetadata = {
  slug: PageSlug;
  path: string;
  label: string;
  defaultTitle: string;
  defaultDescription: string;
};

export const PAGE_METADATA: Record<PageSlug, PageMetadata> = {
  faq: {
    slug: 'faq',
    path: '/faq',
    label: 'FAQ',
    defaultTitle: 'FAQ - MMB',
    defaultDescription: 'Frequently asked questions for students and event organizers about the McMaster Marching Band.',
  },
  'our-team': {
    slug: 'our-team',
    path: '/our-team',
    label: 'Our Team',
    defaultTitle: 'Our Team - MMB',
    defaultDescription: 'Meet the executives and section leaders of the McMaster Marching Band.',
  },
  budget: {
    slug: 'budget',
    path: '/budget',
    label: 'Budget',
    defaultTitle: 'Budget - MMB',
    defaultDescription: 'Annual budgets and financial statements for the McMaster Marching Band.',
  },
  constitution: {
    slug: 'constitution',
    path: '/constitution',
    label: 'Constitution',
    defaultTitle: 'Constitution - MMB',
    defaultDescription: 'Constitution and bylaws of the McMaster Marching Band.',
  },
  'executive-meeting-minutes': {
    slug: 'executive-meeting-minutes',
    path: '/executive-meeting-minutes',
    label: 'Meeting Minutes',
    defaultTitle: 'Executive Meeting Minutes - MMB',
    defaultDescription: 'Executive meeting minutes and sponsors of the McMaster Marching Band.',
  },
};

export const PAGE_PATH_TO_SLUG: Record<string, PageSlug> = Object.fromEntries(
  PAGE_SLUGS.flatMap(slug => {
    const cleanPath = PAGE_METADATA[slug].path;
    const htmlPath = `${cleanPath}.html`;
    return [
      [cleanPath, slug],
      [htmlPath, slug],
    ];
  })
);

export const CONTENT_PAGE_PREFIX = 'content/v1/pages/';
export const CONTENT_HISTORY_PREFIX = 'content/v1/history/';
export const CONTENT_DRIVE_CACHE_PREFIX = 'content/v1/cache/drive/';
export const CONTENT_ASSET_PREFIX = 'content/assets/';
export const DRIVE_CACHE_TTL_MS = 15 * 60 * 1000;

export const CONTENT_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

export const CONTENT_DOC_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

export const MAX_CONTENT_ASSET_SIZE = 25 * 1024 * 1024;

export type InlineTextNode = {
  type: 'text';
  text: string;
  bold?: boolean;
  italic?: boolean;
};

export type InlineLinkNode = {
  type: 'link';
  text: string;
  href: string;
  bold?: boolean;
  italic?: boolean;
  newTab?: boolean;
};

export type InlineNode = InlineTextNode | InlineLinkNode;

export type RichTextBlock =
  | {
      type: 'paragraph';
      children: InlineNode[];
    }
  | {
      type: 'list';
      ordered: boolean;
      items: InlineNode[][];
    };

export type ContentImage = {
  assetKey?: string;
  legacyPath?: string;
  alt: string;
  width?: number;
  height?: number;
  hash?: string;
  placeholder?: string;
};

export type DocumentFileType = 'pdf' | 'xlsx' | 'xls' | 'csv' | 'docx' | 'link';

export type DocumentRef = {
  id: string;
  label: string;
  filename: string;
  assetKey?: string;
  legacyPath?: string;
  externalUrl?: string;
  sizeBytes?: number;
  fileType: DocumentFileType;
};

export type SectionBackground = 'white' | 'gray';

export type HeadingBlock = {
  id: string;
  type: 'heading';
  text: string;
  subtitle?: string;
  align: 'left' | 'center';
  anchor?: string;
  background?: SectionBackground;
};

export type RichTextPageBlock = {
  id: string;
  type: 'rich-text';
  content: RichTextBlock[];
  background?: SectionBackground;
};

export type ButtonBarBlock = {
  id: string;
  type: 'button-bar';
  ariaLabel?: string;
  background?: SectionBackground;
  buttons: Array<{
    id: string;
    label: string;
    href: string;
    style?: 'primary' | 'secondary';
  }>;
};

export type ImageBlock = {
  id: string;
  type: 'image';
  image: ContentImage;
  caption?: string;
  maxWidth?: number;
  background?: SectionBackground;
};

export type DividerBlock = {
  id: string;
  type: 'divider';
  spacing: 'sm' | 'md' | 'lg';
  showLine?: boolean;
};

export type FaqItem = {
  id: string;
  question: string;
  answer: RichTextBlock[];
};

export type FaqGroupBlock = {
  id: string;
  type: 'faq-group';
  anchor: string;
  buttonLabel: string;
  heading: string;
  background?: SectionBackground;
  items: FaqItem[];
};

export type TeamMember = {
  id: string;
  name: string;
  pronouns?: string;
  role: string;
  program?: string;
  bio: RichTextBlock[];
  photo?: ContentImage;
  status?: 'active';
};

export type TeamGroupBlock = {
  id: string;
  type: 'team-group';
  heading: string;
  layout: 'executives' | 'leaders';
  background?: SectionBackground;
  members: TeamMember[];
};

export type DocumentListBlock = {
  id: string;
  type: 'document-list';
  heading: string;
  subtitle?: string;
  background?: SectionBackground;
  documents: DocumentRef[];
};

export type DriveMinutesBlock = {
  id: string;
  type: 'drive-minutes';
  heading: string;
  folderUrl: string;
  folderId: string;
  fallbackLabel?: string;
  groupBySubfolder: boolean;
  sortOrder: 'name-desc' | 'name-asc' | 'modified-desc';
  showDates: boolean;
  background?: SectionBackground;
};

export type SponsorItem = {
  id: string;
  name: string;
  href?: string;
  logo: ContentImage;
};

export type SponsorGridBlock = {
  id: string;
  type: 'sponsor-grid';
  heading: string;
  background?: SectionBackground;
  sponsors: SponsorItem[];
};

export type PageBlock =
  | HeadingBlock
  | RichTextPageBlock
  | ButtonBarBlock
  | ImageBlock
  | DividerBlock
  | FaqGroupBlock
  | TeamGroupBlock
  | DocumentListBlock
  | DriveMinutesBlock
  | SponsorGridBlock;

export type PageBlockType = PageBlock['type'];

export type PageSeo = {
  title: string;
  description: string;
};

export type PageDocument = {
  schemaVersion: 1;
  slug: PageSlug;
  revision: number;
  gitSha?: string;
  commitMessage?: string;
  updatedAt: string;
  updatedBy: string;
  seo: PageSeo;
  blocks: PageBlock[];
};

export type DriveFileEntry = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: number;
  webViewLink: string;
};

export type DriveFolderGroup = {
  id: string;
  name: string;
  files: DriveFileEntry[];
};

export type DriveFolderCache = {
  folderId: string;
  syncedAt: string;
  error?: string;
  rootFiles: DriveFileEntry[];
  subfolders: DriveFolderGroup[];
};

export function isPageSlug(value: string): value is PageSlug {
  return (PAGE_SLUGS as readonly string[]).includes(value);
}

export function extractDriveFolderId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^[a-zA-Z0-9_-]{10,120}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' || !['drive.google.com', 'docs.google.com'].includes(url.hostname)) {
      return null;
    }
    const folderMatch = url.pathname.match(/\/folders\/([a-zA-Z0-9_-]{10,120})/);
    if (folderMatch?.[1]) return folderMatch[1];
    const queryId = url.searchParams.get('id');
    if (queryId && /^[a-zA-Z0-9_-]{10,120}$/.test(queryId)) return queryId;
    return null;
  } catch {
    return null;
  }
}

export function assetPublicUrl(assetKey: string, origin = ''): string {
  const relative = assetKey.startsWith(CONTENT_ASSET_PREFIX)
    ? `/files/${assetKey.slice(CONTENT_ASSET_PREFIX.length)}`
    : assetKey;
  const encoded = relative
    .split('/')
    .map((segment, index) => (index === 0 && segment === '' ? '' : encodeURIComponent(segment)))
    .join('/');
  return origin ? `${origin.replace(/\/+$/, '')}${encoded}` : encoded;
}

export function collectPageAssetKeys(doc: PageDocument): string[] {
  const keys = new Set<string>();
  const addImage = (img?: ContentImage) => {
    if (img?.assetKey) keys.add(img.assetKey);
  };
  for (const block of doc.blocks) {
    switch (block.type) {
      case 'image':
        addImage(block.image);
        break;
      case 'team-group':
        for (const member of block.members) addImage(member.photo);
        break;
      case 'document-list':
        for (const item of block.documents) {
          if (item.assetKey) keys.add(item.assetKey);
        }
        break;
      case 'sponsor-grid':
        for (const sponsor of block.sponsors) addImage(sponsor.logo);
        break;
      default:
        break;
    }
  }
  return [...keys];
}

export function richTextToPlainText(blocks: RichTextBlock[]): string {
  return blocks
    .map(block => {
      if (block.type === 'paragraph') {
        return block.children.map(node => node.text).join('');
      }
      return block.items.map(item => item.map(node => node.text).join('')).join(' ');
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function newBlockId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `blk-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createDefaultBlock(type: PageBlockType): PageBlock {
  const id = newBlockId();
  switch (type) {
    case 'heading':
      return { id, type: 'heading', text: 'New section heading', align: 'left', background: 'white' };
    case 'rich-text':
      return {
        id,
        type: 'rich-text',
        background: 'white',
        content: [{ type: 'paragraph', children: [{ type: 'text', text: 'Add text here.' }] }],
      };
    case 'button-bar':
      return {
        id,
        type: 'button-bar',
        ariaLabel: 'Quick links',
        background: 'white',
        buttons: [{ id: newBlockId(), label: 'Learn more', href: '#top', style: 'primary' }],
      };
    case 'image':
      return {
        id,
        type: 'image',
        background: 'white',
        image: { alt: 'McMaster Marching Band photo' },
        maxWidth: 450,
      };
    case 'divider':
      return { id, type: 'divider', spacing: 'md', showLine: false };
    case 'faq-group':
      return {
        id,
        type: 'faq-group',
        anchor: 'general',
        buttonLabel: 'General',
        heading: 'FAQ Section',
        background: 'white',
        items: [
          {
            id: newBlockId(),
            question: 'New question?',
            answer: [{ type: 'paragraph', children: [{ type: 'text', text: 'Answer goes here.' }] }],
          },
        ],
      };
    case 'team-group':
      return {
        id,
        type: 'team-group',
        heading: 'Team Members',
        layout: 'executives',
        background: 'white',
        members: [
          {
            id: newBlockId(),
            name: 'New Member',
            role: 'Role',
            bio: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
          },
        ],
      };
    case 'document-list':
      return {
        id,
        type: 'document-list',
        heading: '2026-2027',
        background: 'white',
        documents: [],
      };
    case 'drive-minutes':
      return {
        id,
        type: 'drive-minutes',
        heading: 'Executive Meeting Minutes',
        folderUrl: '',
        folderId: '',
        fallbackLabel: 'Open Executive Meeting Minutes Folder in Google Drive',
        groupBySubfolder: true,
        sortOrder: 'name-desc',
        showDates: true,
        background: 'white',
      };
    case 'sponsor-grid':
      return {
        id,
        type: 'sponsor-grid',
        heading: 'Our Sponsors',
        background: 'white',
        sponsors: [],
      };
  }
}
