import {
  PAGE_METADATA,
  extractDriveFolderId,
  type ContentImage,
  type DocumentFileType,
  type DocumentRef,
  type FaqItem,
  type InlineNode,
  type PageBlock,
  type PageDocument,
  type PageSlug,
  type RichTextBlock,
  type TeamMember,
} from './schema.ts';

export type SeedSitePage = {
  path: string;
  title: string;
  description: string;
  contentHtml: string;
};

export type SeedImageMeta = {
  hash: string;
  width: number;
  height: number;
  placeholder: string;
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  zwj: '',
  zwnj: '',
};

function decodeEntities(input: string): string {
  return input
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, code: string) => {
      if (code.startsWith('#x') || code.startsWith('#X')) {
        const num = Number.parseInt(code.slice(2), 16);
        return num === 0x200b ? '' : Number.isFinite(num) ? String.fromCodePoint(num) : match;
      }
      if (code.startsWith('#')) {
        const num = Number.parseInt(code.slice(1), 10);
        return num === 0x200b ? '' : Number.isFinite(num) ? String.fromCodePoint(num) : match;
      }
      return code in NAMED_ENTITIES ? NAMED_ENTITIES[code] : match;
    });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/[ \t\r\n]+/g, ' ')
    .trim();
}

function parseAttr(tag: string, name: string): string {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = tag.match(re);
  return decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? '');
}

function parseInlineHtml(html: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  const tokenRe = /(<\/?(?:a|strong|b|em|i)\b[^>]*>|<br\s*\/?>|<[^>]+>)/gi;
  let bold = 0;
  let italic = 0;
  let currentLink: { href: string; newTab?: boolean } | null = null;
  let lastIndex = 0;

  const pushText = (raw: string) => {
    const text = decodeEntities(raw).replace(/\s+/g, ' ');
    if (!text) return;
    if (currentLink) {
      const existing = nodes[nodes.length - 1];
      if (existing && existing.type === 'link' && existing.href === currentLink.href) {
        existing.text += text;
        return;
      }
      nodes.push({
        type: 'link',
        text,
        href: currentLink.href,
        ...(bold > 0 ? { bold: true } : {}),
        ...(italic > 0 ? { italic: true } : {}),
        ...(currentLink.newTab ? { newTab: true } : {}),
      });
      return;
    }
    const last = nodes[nodes.length - 1];
    if (last && last.type === 'text' && Boolean(last.bold) === (bold > 0) && Boolean(last.italic) === (italic > 0)) {
      last.text += text;
    } else {
      nodes.push({
        type: 'text',
        text,
        ...(bold > 0 ? { bold: true } : {}),
        ...(italic > 0 ? { italic: true } : {}),
      });
    }
  };

  for (const match of html.matchAll(tokenRe)) {
    const index = match.index ?? 0;
    if (index > lastIndex) pushText(html.slice(lastIndex, index));
    const tag = match[0];
    const lower = tag.toLowerCase();
    if (lower.startsWith('<strong') || lower === '<b>' || lower.startsWith('<b ')) bold++;
    else if (lower === '</strong>' || lower === '</b>') bold = Math.max(0, bold - 1);
    else if (lower.startsWith('<em') || lower === '<i>' || lower.startsWith('<i ')) italic++;
    else if (lower === '</em>' || lower === '</i>') italic = Math.max(0, italic - 1);
    else if (lower.startsWith('<a ') || lower === '<a>') {
      const rawHref = parseAttr(tag, 'href').trim();
      if (rawHref) {
        const href = !rawHref.startsWith('/original/') && !rawHref.startsWith('/files/')
          ? rawHref.replace(/^(\/[^?#]+)\.html(?=$|[?#])/, '$1')
          : rawHref;
        currentLink = { href, newTab: parseAttr(tag, 'target') === '_blank' };
      }
    } else if (lower === '</a>') {
      currentLink = null;
    } else if (lower.startsWith('<br')) {
      pushText(' ');
    }
    lastIndex = index + tag.length;
  }
  if (lastIndex < html.length) pushText(html.slice(lastIndex));

  if (nodes.length) {
    nodes[0].text = nodes[0].text.replace(/^\s+/, '');
    nodes[nodes.length - 1].text = nodes[nodes.length - 1].text.replace(/\s+$/, '');
  }
  return nodes.filter(node => node.text.length > 0);
}

function toRichText(html: string): RichTextBlock[] {
  const children = parseInlineHtml(html);
  return children.length ? [{ type: 'paragraph', children }] : [];
}

function buildImage(src: string, alt: string, images: Record<string, SeedImageMeta>): ContentImage {
  const meta = images[src];
  return {
    legacyPath: src,
    alt: alt || 'Picture',
    ...(meta
      ? { width: meta.width, height: meta.height, hash: meta.hash, placeholder: meta.placeholder }
      : {}),
  };
}

function parseFaq(page: SeedSitePage, images: Record<string, SeedImageMeta>, timestamp: string): PageDocument {
  const html = page.contentHtml;
  const navMatches = [...html.matchAll(/<a[^>]*href="#([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].map(m => ({
    anchor: m[1],
    label: stripTags(m[2]),
  }));

  const imgMatch = html.match(/<img[^>]*src="(\/original\/[^"]+)"[^>]*>/i);
  const dividerImg = imgMatch
    ? buildImage(imgMatch[1], parseAttr(imgMatch[0], 'alt') || 'McMaster Marching Band', images)
    : undefined;

  const parseQuestions = (segment: string, prefix: string): FaqItem[] => {
    const blocks = [...segment.matchAll(/<(h2|div)\b[^>]*class="[^"]*(?:wsite-content-title|paragraph)[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi)];
    const items: FaqItem[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const text = stripTags(blocks[i][2]);
      if (/^\d+\.\s+/.test(text) && i + 1 < blocks.length) {
        items.push({
          id: `${prefix}-q${items.length + 1}`,
          question: text,
          answer: toRichText(blocks[i + 1][2]),
        });
        i++;
      }
    }
    return items;
  };

  const studentsStart = html.indexOf('FAQ for Students');
  const organizersStart = html.indexOf('FAQ for Event Organizers');
  const studentsSegment = studentsStart >= 0 && organizersStart > studentsStart ? html.slice(studentsStart, organizersStart) : '';
  const organizersSegment = organizersStart >= 0 ? html.slice(organizersStart) : '';

  const blocks: PageBlock[] = [
    {
      id: 'faq-heading',
      type: 'heading',
      text: 'FAQ',
      align: 'center',
      background: 'white',
    },
    {
      id: 'faq-nav',
      type: 'button-bar',
      ariaLabel: 'FAQ audiences',
      background: 'white',
      buttons: (navMatches.length
        ? navMatches
        : [
            { anchor: 'students', label: 'Students' },
            { anchor: 'organizers', label: 'Organizers' },
          ]
      ).map((btn, idx) => ({
        id: `faq-btn-${idx + 1}`,
        label: btn.label,
        href: `#${btn.anchor}`,
        style: 'primary' as const,
      })),
    },
    {
      id: 'faq-students',
      type: 'faq-group',
      anchor: 'students',
      buttonLabel: 'Students',
      heading: 'FAQ for Students',
      background: 'white',
      items: parseQuestions(studentsSegment, 'students'),
    },
    ...(dividerImg
      ? [
          {
            id: 'faq-photo',
            type: 'image' as const,
            image: dividerImg,
            maxWidth: 450,
            background: 'gray' as const,
          },
        ]
      : []),
    {
      id: 'faq-organizers',
      type: 'faq-group',
      anchor: 'organizers',
      buttonLabel: 'Organizers',
      heading: 'FAQ for Event Organizers',
      background: 'white',
      items: parseQuestions(organizersSegment, 'organizers'),
    },
  ];

  return {
    schemaVersion: 1,
    slug: 'faq',
    revision: 1,
    commitMessage: 'Initial seed from static website',
    updatedAt: timestamp,
    updatedBy: 'system-seed',
    seo: {
      title: page.title || PAGE_METADATA.faq.defaultTitle,
      description: page.description || PAGE_METADATA.faq.defaultDescription,
    },
    blocks,
  };
}

function parseTeam(page: SeedSitePage, images: Record<string, SeedImageMeta>, timestamp: string): PageDocument {
  const html = page.contentHtml;
  const leadersMarker = html.indexOf('<section class="team-leaders');
  const execHtml = leadersMarker >= 0 ? html.slice(0, leadersMarker) : html;
  const leaderHtml = leadersMarker >= 0 ? html.slice(leadersMarker) : '';

  const executives: TeamMember[] = [];
  for (const tdMatch of execHtml.matchAll(/<td\b[^>]*class="[^"]*wsite-multicol-col[^"]*"[^>]*>([\s\S]*?)<\/td>/gi)) {
    const cell = tdMatch[1];
    const imgMatch = cell.match(/<img[^>]*src="(\/original\/[^"]+)"[^>]*>/i);
    const h2Match = cell.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
    const paraMatch = cell.match(/<div\b[^>]*class="[^"]*paragraph[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (!h2Match || !paraMatch) continue;

    const rawTitle = h2Match[1];
    const pronounsMatch = rawTitle.match(/\(([^)]+)\)/);
    const pronouns = pronounsMatch ? `(${stripTags(pronounsMatch[1])})` : undefined;
    const name = stripTags(rawTitle.replace(/<font[^>]*>\s*\([^)]+\)\s*<\/font>/i, ''));

    const lines = paraMatch[1]
      .split(/<br\s*\/?>/i)
      .map(part => part.trim())
      .filter(Boolean);
    const role = lines[0] ? stripTags(lines[0]) : 'Executive';
    let program: string | undefined;
    let bioParts = lines.slice(1);
    if (lines[1] && /^<em\b|^<font\b[^>]*>\s*<em\b/i.test(lines[1])) {
      program = stripTags(lines[1]);
      bioParts = lines.slice(2);
    }

    executives.push({
      id: `exec-${executives.length + 1}`,
      name,
      ...(pronouns ? { pronouns } : {}),
      role,
      ...(program ? { program } : {}),
      bio: toRichText(bioParts.join(' ')),
      ...(imgMatch ? { photo: buildImage(imgMatch[1], name, images) } : {}),
    });
  }

  const leaders: TeamMember[] = [];
  for (const tdMatch of leaderHtml.matchAll(/<td\b[^>]*team-leader-profile[^>]*>([\s\S]*?)<\/td>/gi)) {
    const cell = tdMatch[1];
    const h2Match = cell.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
    const statusMatch = cell.match(/<div\b[^>]*team-placeholder-status[^>]*>([\s\S]*?)<\/div>/i);
    if (!h2Match || !statusMatch) continue;
    const headingText = stripTags(h2Match[1]);
    const statusText = stripTags(statusMatch[1]);
    leaders.push({
      id: `leader-${leaders.length + 1}`,
      name: headingText,
      role: statusText,
      bio: [],
    });
  }

  return {
    schemaVersion: 1,
    slug: 'our-team',
    revision: 1,
    commitMessage: 'Initial seed from static website',
    updatedAt: timestamp,
    updatedBy: 'system-seed',
    seo: {
      title: page.title || PAGE_METADATA['our-team'].defaultTitle,
      description: page.description || PAGE_METADATA['our-team'].defaultDescription,
    },
    blocks: [
      {
        id: 'team-executives',
        type: 'team-group',
        heading: 'Executives',
        layout: 'executives',
        background: 'white',
        members: executives,
      },
      {
        id: 'team-leaders',
        type: 'team-group',
        heading: 'Section Leaders',
        layout: 'leaders',
        background: 'gray',
        members: leaders,
      },
    ],
  };
}

function inferDocType(filename: string, rawType?: string): DocumentFileType {
  const candidate = (rawType || filename.split('.').pop() || '').trim().toLowerCase();
  if (candidate === 'pdf' || candidate === 'xlsx' || candidate === 'xls' || candidate === 'csv' || candidate === 'docx') {
    return candidate;
  }
  return 'pdf';
}

function parseSizeBytes(raw: string): number | undefined {
  const match = raw.match(/(\d+(?:\.\d+)?)\s*(kb|mb|b)/i);
  if (!match) return undefined;
  const num = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 'mb') return Math.round(num * 1024 * 1024);
  if (unit === 'kb') return Math.round(num * 1024);
  return Math.round(num);
}

function extractDocumentRefs(segment: string, idPrefix: string): DocumentRef[] {
  const docs: DocumentRef[] = [];
  const seenHrefs = new Set<string>();
  const cardRe = /<div><div style="margin:\s*10px 0 0 -10px">([\s\S]*?)<hr style="clear:\s*both/gi;
  for (const match of segment.matchAll(cardRe)) {
    const chunk = match[1];
    const linkMatch = chunk.match(/<a[^>]*href="(\/original\/[^"]+)"[^>]*>/i);
    if (!linkMatch) continue;
    const href = linkMatch[1];
    if (seenHrefs.has(href)) continue;
    seenHrefs.add(href);
    const titleAttr = parseAttr(linkMatch[0], 'title').replace(/^Download file:\s*/i, '').trim();
    const boldMatch = chunk.match(/<b>([\s\S]*?)<\/b>/i);
    const filename = stripTags(boldMatch?.[1] || titleAttr || href.split('/').pop() || 'document');
    const sizeMatch = chunk.match(/<td>File Size:\s*<\/td>\s*<td>([^<]+)<\/td>/i);
    const typeMatch = chunk.match(/<td>File Type:\s*<\/td>\s*<td>([^<]+)<\/td>/i);
    docs.push({
      id: `${idPrefix}-doc-${docs.length + 1}`,
      label: filename,
      filename,
      legacyPath: href,
      sizeBytes: sizeMatch ? parseSizeBytes(sizeMatch[1]) : undefined,
      fileType: inferDocType(filename, typeMatch?.[1]),
    });
  }
  return docs;
}

function parseBudget(page: SeedSitePage, timestamp: string): PageDocument {
  const html = page.contentHtml;
  const headings = [...html.matchAll(/<h2\b[^>]*class="[^"]*wsite-content-title[^"]*"[^>]*>([\s\S]*?)<\/h2>/gi)];
  const blocks: PageBlock[] = headings.map((match, idx) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = idx + 1 < headings.length ? (headings[idx + 1].index ?? html.length) : html.length;
    const yearLabel = stripTags(match[1]);
    return {
      id: `budget-year-${idx + 1}`,
      type: 'document-list',
      heading: yearLabel,
      background: 'white',
      documents: extractDocumentRefs(html.slice(start, end), `budget-${idx + 1}`),
    };
  });

  return {
    schemaVersion: 1,
    slug: 'budget',
    revision: 1,
    commitMessage: 'Initial seed from static website',
    updatedAt: timestamp,
    updatedBy: 'system-seed',
    seo: {
      title: page.title || PAGE_METADATA.budget.defaultTitle,
      description: page.description || PAGE_METADATA.budget.defaultDescription,
    },
    blocks,
  };
}

function parseConstitution(page: SeedSitePage, timestamp: string): PageDocument {
  const html = page.contentHtml;
  const bylawsIndex = html.indexOf('>Bylaws<');
  const topSegment = bylawsIndex >= 0 ? html.slice(0, bylawsIndex) : html;
  const bylawsSegment = bylawsIndex >= 0 ? html.slice(bylawsIndex) : '';
  const topHeadingMatch = topSegment.match(/<h2\b[^>]*class="[^"]*wsite-content-title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i);
  const topHeading = topHeadingMatch ? stripTags(topHeadingMatch[1]) : 'McMaster Marching Band Constitution';

  const blocks: PageBlock[] = [
    {
      id: 'constitution-main',
      type: 'document-list',
      heading: topHeading,
      background: 'white',
      documents: extractDocumentRefs(topSegment, 'constitution'),
    },
    {
      id: 'constitution-bylaws',
      type: 'document-list',
      heading: 'Bylaws',
      background: 'white',
      documents: extractDocumentRefs(bylawsSegment, 'bylaws'),
    },
  ];

  return {
    schemaVersion: 1,
    slug: 'constitution',
    revision: 1,
    commitMessage: 'Initial seed from static website',
    updatedAt: timestamp,
    updatedBy: 'system-seed',
    seo: {
      title: page.title || PAGE_METADATA.constitution.defaultTitle,
      description: page.description || PAGE_METADATA.constitution.defaultDescription,
    },
    blocks,
  };
}

function parseMinutes(page: SeedSitePage, images: Record<string, SeedImageMeta>, timestamp: string): PageDocument {
  const html = page.contentHtml;
  const driveLinkMatch = html.match(/<a[^>]*href="(https:\/\/drive\.google\.com\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
  const folderUrl = driveLinkMatch?.[1] || 'https://drive.google.com/drive/folders/1_5ueL5hj6w3SNRasgjQZLyDqu044NoUA';
  const folderId = extractDriveFolderId(folderUrl) || '1_5ueL5hj6w3SNRasgjQZLyDqu044NoUA';
  const sponsors = [...html.matchAll(/<img[^>]*src="(\/original\/[^"]+)"[^>]*>/gi)].map((match, idx) => ({
    id: `sponsor-${idx + 1}`,
    name: `Sponsor ${idx + 1}`,
    logo: buildImage(match[1], `Sponsor ${idx + 1}`, images),
  }));

  const blocks: PageBlock[] = [
    {
      id: 'minutes-drive',
      type: 'drive-minutes',
      heading: 'Executive Meeting Minutes',
      folderUrl,
      folderId,
      fallbackLabel: 'Open Executive Meeting Minutes Folder in Google Drive',
      groupBySubfolder: true,
      sortOrder: 'name-desc',
      showDates: true,
      background: 'white',
    },
    ...(sponsors.length
      ? [
          {
            id: 'minutes-sponsors',
            type: 'sponsor-grid' as const,
            heading: 'Our Sponsors',
            background: 'white' as const,
            sponsors,
          },
        ]
      : []),
  ];

  return {
    schemaVersion: 1,
    slug: 'executive-meeting-minutes',
    revision: 1,
    commitMessage: 'Initial seed from static website',
    updatedAt: timestamp,
    updatedBy: 'system-seed',
    seo: {
      title: PAGE_METADATA['executive-meeting-minutes'].defaultTitle,
      description: page.description || PAGE_METADATA['executive-meeting-minutes'].defaultDescription,
    },
    blocks,
  };
}

export function extractSeedPages(
  preparedSite: { pages: SeedSitePage[] },
  images: Record<string, SeedImageMeta>,
  timestamp = new Date().toISOString()
): Record<PageSlug, PageDocument> {
  const byPath = new Map(preparedSite.pages.map(page => [page.path, page]));
  const getPage = (path: string) => {
    const page = byPath.get(path);
    if (!page) throw new Error(`Missing page ${path} in prepared-site.json`);
    return page;
  };

  return {
    faq: parseFaq(getPage('/faq.html'), images, timestamp),
    'our-team': parseTeam(getPage('/our-team.html'), images, timestamp),
    budget: parseBudget(getPage('/budget.html'), timestamp),
    constitution: parseConstitution(getPage('/constitution.html'), timestamp),
    'executive-meeting-minutes': parseMinutes(getPage('/executive-meeting-minutes.html'), images, timestamp),
  };
}
