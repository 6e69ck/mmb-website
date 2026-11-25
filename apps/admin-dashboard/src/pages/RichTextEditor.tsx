import { useEffect, useRef, useState } from 'react';
import { escapeAttr, escapeHtml, isSafeUrl, type InlineNode, type RichTextBlock } from '@mmb/content';
import { Icon } from '../ui';

function nodesToEditorHtml(nodes: InlineNode[]): string {
  return nodes
    .map(node => {
      let inner = escapeHtml(node.text);
      if (node.italic) inner = `<em>${inner}</em>`;
      if (node.bold) inner = `<strong>${inner}</strong>`;
      if (node.type === 'link' && isSafeUrl(node.href)) {
        return `<a href="${escapeAttr(node.href)}">${inner}</a>`;
      }
      return inner;
    })
    .join('');
}

function blocksToEditorHtml(blocks: RichTextBlock[]): string {
  if (!blocks.length) return '<p><br></p>';
  return blocks
    .map(block => {
      if (block.type === 'paragraph') {
        const inner = nodesToEditorHtml(block.children);
        return `<p>${inner || '<br>'}</p>`;
      }
      const tag = block.ordered ? 'ol' : 'ul';
      const items = block.items.map(item => `<li>${nodesToEditorHtml(item) || '<br>'}</li>`).join('');
      return `<${tag}>${items}</${tag}>`;
    })
    .join('');
}

function parseInlineElement(node: Node, style: { bold?: boolean; italic?: boolean; href?: string } = {}): InlineNode[] {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.textContent || '').replace(/\u00a0/g, ' ');
    if (!text) return [];
    if (style.href && isSafeUrl(style.href)) {
      return [
        {
          type: 'link',
          text,
          href: style.href,
          ...(style.bold ? { bold: true } : {}),
          ...(style.italic ? { italic: true } : {}),
          ...(style.href.startsWith('https://') ? { newTab: true } : {}),
        },
      ];
    }
    return [
      {
        type: 'text',
        text,
        ...(style.bold ? { bold: true } : {}),
        ...(style.italic ? { italic: true } : {}),
      },
    ];
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (tag === 'br') return [{ type: 'text', text: ' ' }];

  const nextStyle = { ...style };
  if (tag === 'strong' || tag === 'b') nextStyle.bold = true;
  if (tag === 'em' || tag === 'i') nextStyle.italic = true;
  if (tag === 'a') {
    const href = (el.getAttribute('href') || '').trim();
    if (isSafeUrl(href)) nextStyle.href = href;
  }

  const out: InlineNode[] = [];
  el.childNodes.forEach(child => {
    for (const parsed of parseInlineElement(child, nextStyle)) {
      const prev = out[out.length - 1];
      if (
        prev &&
        prev.type === parsed.type &&
        Boolean(prev.bold) === Boolean(parsed.bold) &&
        Boolean(prev.italic) === Boolean(parsed.italic) &&
        (prev.type === 'text' || (parsed.type === 'link' && prev.href === parsed.href))
      ) {
        prev.text += parsed.text;
      } else {
        out.push(parsed);
      }
    }
  });
  return out;
}

function editorDomToBlocks(root: HTMLElement): RichTextBlock[] {
  const blocks: RichTextBlock[] = [];
  let inlineBuffer: Node[] = [];

  const flushInlineBuffer = () => {
    if (!inlineBuffer.length) return;
    const children = inlineBuffer.flatMap(n => parseInlineElement(n));
    inlineBuffer = [];
    if (children.some(c => c.text.trim())) {
      blocks.push({ type: 'paragraph', children });
    }
  };

  root.childNodes.forEach(child => {
    if (child.nodeType !== Node.ELEMENT_NODE) {
      if ((child.textContent || '').trim()) inlineBuffer.push(child);
      return;
    }
    const el = child as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (tag === 'ul' || tag === 'ol') {
      flushInlineBuffer();
      const items: InlineNode[][] = [];
      el.querySelectorAll(':scope > li').forEach(li => {
        const parsed = parseInlineElement(li);
        if (parsed.some(c => c.text.trim())) items.push(parsed);
      });
      if (items.length) blocks.push({ type: 'list', ordered: tag === 'ol', items });
      return;
    }
    if (tag === 'p' || tag === 'div') {
      flushInlineBuffer();
      const children = parseInlineElement(el);
      if (children.some(c => c.text.trim())) {
        blocks.push({ type: 'paragraph', children });
      }
      return;
    }
    inlineBuffer.push(el);
  });

  flushInlineBuffer();
  return blocks.length ? blocks : [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }];
}

type Props = {
  value: RichTextBlock[];
  onChange: (next: RichTextBlock[]) => void;
  placeholder?: string;
  minHeight?: number;
};

export default function RichTextEditor({ value, onChange, placeholder = 'Write content…', minHeight = 92 }: Props) {
  const editorRef = useRef<HTMLDivElement>(null);
  const lastHtml = useRef<string>('');
  const savedRange = useRef<Range | null>(null);
  const [linkPrompt, setLinkPrompt] = useState<{ open: boolean; url: string; label: string; error: string }>({
    open: false,
    url: 'https://',
    label: '',
    error: '',
  });

  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const nextHtml = blocksToEditorHtml(value);
    if (document.activeElement !== el && nextHtml !== lastHtml.current) {
      el.innerHTML = nextHtml;
      lastHtml.current = nextHtml;
    }
  }, [value]);

  const emitChange = () => {
    const el = editorRef.current;
    if (!el) return;
    const parsed = editorDomToBlocks(el);
    lastHtml.current = el.innerHTML;
    onChange(parsed);
  };

  const runCommand = (cmd: string, arg?: string) => {
    editorRef.current?.focus();
    document.execCommand(cmd, false, arg);
    emitChange();
  };

  const openLinkDialog = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      savedRange.current = sel.getRangeAt(0).cloneRange();
      const text = sel.toString();
      setLinkPrompt({ open: true, url: 'https://', label: text, error: '' });
    } else {
      savedRange.current = null;
      setLinkPrompt({ open: true, url: 'https://', label: '', error: '' });
    }
  };

  const applyLink = () => {
    const url = linkPrompt.url.trim();
    if (!isSafeUrl(url)) {
      setLinkPrompt(prev => ({ ...prev, error: 'Use an https://, mailto:, /path, or #anchor URL.' }));
      return;
    }
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (sel && savedRange.current) {
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    }
    if (sel && !sel.isCollapsed) {
      document.execCommand('createLink', false, url);
    } else {
      const label = linkPrompt.label.trim() || url;
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.textContent = label;
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(anchor);
        range.setStartAfter(anchor);
        range.collapse(true);
      } else {
        el.appendChild(anchor);
      }
    }
    setLinkPrompt({ open: false, url: 'https://', label: '', error: '' });
    emitChange();
  };

  return (
    <div className="rte-wrapper">
      <div className="rte-toolbar" role="toolbar" aria-label="Text formatting">
        <button type="button" title="Bold" onMouseDown={e => e.preventDefault()} onClick={() => runCommand('bold')}>
          <Icon name="bold" size={14} />
        </button>
        <button type="button" title="Italic" onMouseDown={e => e.preventDefault()} onClick={() => runCommand('italic')}>
          <Icon name="italic" size={14} />
        </button>
        <button type="button" title="Bulleted list" onMouseDown={e => e.preventDefault()} onClick={() => runCommand('insertUnorderedList')}>
          <Icon name="list" size={14} />
        </button>
        <button type="button" title="Numbered list" onMouseDown={e => e.preventDefault()} onClick={() => runCommand('insertOrderedList')}>
          <Icon name="listOrdered" size={14} />
        </button>
        <button type="button" title="Insert link" onMouseDown={e => e.preventDefault()} onClick={openLinkDialog}>
          <Icon name="link" size={14} />
          <span>Link</span>
        </button>
      </div>
      {linkPrompt.open && (
        <div className="rte-link-popover">
          <div className="rte-link-fields">
            <label>
              <span>Link URL</span>
              <input
                type="text"
                value={linkPrompt.url}
                onChange={e => setLinkPrompt(prev => ({ ...prev, url: e.target.value, error: '' }))}
                placeholder="https://... or /contact"
              />
            </label>
            <label>
              <span>Link text (optional if text selected)</span>
              <input
                type="text"
                value={linkPrompt.label}
                onChange={e => setLinkPrompt(prev => ({ ...prev, label: e.target.value }))}
                placeholder="Text to display"
              />
            </label>
          </div>
          {linkPrompt.error && <p className="rte-link-error">{linkPrompt.error}</p>}
          <div className="rte-link-actions">
            <button type="button" className="button button-secondary button-sm" onClick={() => setLinkPrompt({ open: false, url: 'https://', label: '', error: '' })}>
              Cancel
            </button>
            <button type="button" className="button button-primary button-sm" onClick={applyLink}>
              Apply link
            </button>
          </div>
        </div>
      )}
      <div
        ref={editorRef}
        className="rte-surface"
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        style={{ minHeight }}
        onInput={emitChange}
        onBlur={emitChange}
        onPaste={event => {
          event.preventDefault();
          const text = event.clipboardData.getData('text/plain');
          document.execCommand('insertText', false, text);
        }}
      />
    </div>
  );
}
