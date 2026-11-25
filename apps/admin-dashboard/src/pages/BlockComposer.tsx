import { useEffect, useState } from 'react';
import {
  createDefaultBlock,
  newBlockId,
  type DriveFolderCache,
  type PageBlock,
  type PageBlockType,
} from '@mmb/content';
import { Icon } from '../ui';
import { type AdminMode } from './asset-urls';
import { BlockEditorBody } from './BlockEditors';
import { useDragAutoScroll } from './useDragAutoScroll';

const BLOCK_CATALOG: Array<{ type: PageBlockType; label: string; description: string }> = [
  { type: 'faq-group', label: 'FAQ Group', description: 'Section with jump-button anchor and Q&A list' },
  { type: 'team-group', label: 'Team Group', description: 'Executives or 2×2 Section Leaders roster' },
  { type: 'document-list', label: 'Document List', description: 'Year/category section with downloadable PDFs or XLSX' },
  { type: 'drive-minutes', label: 'Google Drive Minutes', description: 'Auto-synced folder listing from Google Drive' },
  { type: 'sponsor-grid', label: 'Sponsor Grid', description: 'Grid of sponsor logos and optional links' },
  { type: 'heading', label: 'Section Heading', description: 'Centered or left-aligned title with optional anchor' },
  { type: 'rich-text', label: 'Rich Text', description: 'Formatted paragraphs, lists, and inline links' },
  { type: 'button-bar', label: 'Jump / Action Buttons', description: 'Row of maroon CTA or section jump buttons' },
  { type: 'image', label: 'Image', description: 'Photo with BlurHash progressive loading and caption' },
  { type: 'divider', label: 'Spacer / Divider', description: 'Vertical spacing or horizontal divider rule' },
];

export type DropPosition = 'before' | 'after';

export function reorderBlocks<T>(
  items: T[],
  fromIndex: number,
  targetIndex: number,
  position: DropPosition
): T[] {
  if (fromIndex < 0 || fromIndex >= items.length || targetIndex < 0 || targetIndex >= items.length) {
    return items;
  }
  const rawInsert = position === 'after' ? targetIndex + 1 : targetIndex;
  const toIndex = fromIndex < rawInsert ? rawInsert - 1 : rawInsert;
  if (toIndex === fromIndex) return items;
  const copy = [...items];
  const [moved] = copy.splice(fromIndex, 1);
  copy.splice(toIndex, 0, moved);
  return copy;
}

function blockLabel(block: PageBlock): string {
  switch (block.type) {
    case 'heading': return `Heading: ${block.text || 'Untitled'}`;
    case 'rich-text': return 'Rich Text';
    case 'button-bar': return `Button Bar (${block.buttons.length})`;
    case 'image': return `Image: ${block.image.alt || 'Photo'}`;
    case 'divider': return `Spacer (${block.spacing})`;
    case 'faq-group': return `FAQ: ${block.heading} (${block.items.length})`;
    case 'team-group': return `Team: ${block.heading} (${block.members.length})`;
    case 'document-list': return `Documents: ${block.heading} (${block.documents.length})`;
    case 'drive-minutes': return `Google Drive: ${block.heading}`;
    case 'sponsor-grid': return `Sponsors: ${block.heading} (${block.sponsors.length})`;
  }
}

export default function BlockComposer({
  blocks,
  mode,
  onChange,
  driveCaches,
  onDriveCacheUpdated,
  driveConfigured,
  rearrangeMode = false,
}: {
  blocks: PageBlock[];
  mode: AdminMode;
  onChange: (next: PageBlock[]) => void;
  driveCaches: Record<string, DriveFolderCache>;
  onDriveCacheUpdated: (cache: DriveFolderCache) => void;
  driveConfigured: boolean;
  rearrangeMode?: boolean;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{ index: number; position: DropPosition } | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [insertAt, setInsertAt] = useState<number | null>(null);

  useDragAutoScroll(rearrangeMode && dragIndex !== null);

  useEffect(() => {
    if (!rearrangeMode) {
      setDragIndex(null);
      setDropTarget(null);
    } else {
      setInsertAt(null);
    }
  }, [rearrangeMode]);

  const moveBlock = (from: number, to: number) => {
    if (to < 0 || to >= blocks.length || from === to) return;
    const copy = [...blocks];
    const [moved] = copy.splice(from, 1);
    copy.splice(to, 0, moved);
    onChange(copy);
  };

  const insertBlock = (index: number, type: PageBlockType) => {
    const copy = [...blocks];
    copy.splice(index, 0, createDefaultBlock(type));
    onChange(copy);
    setInsertAt(null);
  };

  const duplicateBlock = (index: number) => {
    const source = blocks[index];
    const cloned = structuredClone(source);
    cloned.id = newBlockId();
    const copy = [...blocks];
    copy.splice(index + 1, 0, cloned);
    onChange(copy);
  };

  if (rearrangeMode) {
    return (
      <div className="block-composer" data-mode="rearrange">
        {blocks.length === 0 ? (
          <div className="block-card" style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--muted)', fontSize: '13px' }}>
            No blocks on this page yet. Switch to Edit blocks to add content.
          </div>
        ) : (
          <>
            <p style={{ margin: '0 0 4px', color: 'var(--muted)', fontSize: '12px' }}>
              Drag blocks to reorder them, or use the Up and Down buttons.
            </p>
            {blocks.map((block, index) => {
              const isDragging = dragIndex === index;
              const rawInsert =
                dropTarget && dropTarget.index === index
                  ? dropTarget.position === 'after'
                    ? index + 1
                    : index
                  : null;
              const isValidTarget =
                dragIndex !== null &&
                rawInsert !== null &&
                rawInsert !== dragIndex &&
                rawInsert !== dragIndex + 1;
              const showBefore = isValidTarget && dropTarget?.position === 'before';
              const showAfter = isValidTarget && dropTarget?.position === 'after';

              return (
                <article
                  key={block.id}
                  draggable
                  className={`block-card ${isValidTarget ? 'is-drop-target' : ''}`}
                  data-drop-position={showBefore ? 'before' : showAfter ? 'after' : undefined}
                  style={{
                    opacity: isDragging ? 0.45 : 1,
                    cursor: 'grab',
                    boxShadow: showBefore
                      ? '0 -3px 0 0 var(--maroon)'
                      : showAfter
                        ? '0 3px 0 0 var(--maroon)'
                        : undefined,
                  }}
                  onDragStart={e => {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', String(index));
                    setDragIndex(index);
                  }}
                  onDragEnd={() => {
                    setDragIndex(null);
                    setDropTarget(null);
                  }}
                  onDragOver={e => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (dragIndex === null) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const position: DropPosition = e.clientY >= rect.top + rect.height / 2 ? 'after' : 'before';
                    setDropTarget(prev =>
                      prev && prev.index === index && prev.position === position ? prev : { index, position }
                    );
                  }}
                  onDragLeave={e => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                      setDropTarget(prev => (prev?.index === index ? null : prev));
                    }
                  }}
                  onDrop={e => {
                    e.preventDefault();
                    if (dragIndex !== null) {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const position: DropPosition = e.clientY >= rect.top + rect.height / 2 ? 'after' : 'before';
                      const next = reorderBlocks(blocks, dragIndex, index, position);
                      if (next !== blocks) onChange(next);
                    }
                    setDragIndex(null);
                    setDropTarget(null);
                  }}
                >
                  <header className="block-card-header" style={{ borderBottom: 0 }}>
                    <span className="block-drag-handle" title="Drag to reorder block" aria-hidden="true">
                      <Icon name="grip" size={16} />
                    </span>
                    <span className="nested-index" style={{ minWidth: '24px' }}>
                      #{index + 1}
                    </span>
                    <div className="block-title-toggle" style={{ cursor: 'grab' }}>
                      <strong>{blockLabel(block)}</strong>
                      <span className="block-type-pill">{block.type}</span>
                    </div>
                    <div className="block-card-actions">
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Move block up"
                        disabled={index === 0}
                        onClick={() => moveBlock(index, index - 1)}
                      >
                        <Icon name="up" size={16} />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Move block down"
                        disabled={index === blocks.length - 1}
                        onClick={() => moveBlock(index, index + 1)}
                      >
                        <Icon name="down" size={16} />
                      </button>
                    </div>
                  </header>
                </article>
              );
            })}
          </>
        )}
      </div>
    );
  }

  const renderInsertSlot = (index: number) => (
    <div className="insert-slot" key={`insert-${index}`}>
      {insertAt === index ? (
        <div className="block-picker">
          <div className="block-picker-head">
            <strong>Choose a block to insert</strong>
            <button type="button" className="icon-button" aria-label="Close block picker" onClick={() => setInsertAt(null)}>
              <Icon name="close" size={16} />
            </button>
          </div>
          <div className="block-picker-grid">
            {BLOCK_CATALOG.map(entry => (
              <button
                key={entry.type}
                type="button"
                className="block-picker-option"
                onClick={() => insertBlock(index, entry.type)}
              >
                <strong>{entry.label}</strong>
                <span>{entry.description}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <button type="button" className="insert-slot-button" onClick={() => setInsertAt(index)}>
          <Icon name="plus" size={14} />
          <span>Add block here</span>
        </button>
      )}
    </div>
  );

  return (
    <div className="block-composer" data-mode="edit">
      {renderInsertSlot(0)}
      {blocks.map((block, index) => {
        const isCollapsed = Boolean(collapsed[block.id]);
        return (
          <div key={block.id} className="block-composer-item-wrap">
            <article className="block-card">
              <header className="block-card-header" style={isCollapsed ? { borderBottom: 0 } : undefined}>
                <button
                  type="button"
                  className="block-title-toggle"
                  aria-expanded={!isCollapsed}
                  onClick={() => setCollapsed(prev => ({ ...prev, [block.id]: !prev[block.id] }))}
                >
                  <strong>{blockLabel(block)}</strong>
                  <span className="block-type-pill">{block.type}</span>
                </button>
                <div className="block-card-actions">
                  {'background' in block && (
                    <select
                      aria-label="Section background"
                      className="block-bg-select"
                      value={block.background || 'white'}
                      onChange={e =>
                        onChange(
                          blocks.map(b =>
                            b.id === block.id ? ({ ...b, background: e.target.value === 'gray' ? 'gray' : 'white' } as PageBlock) : b
                          )
                        )
                      }
                    >
                      <option value="white">White bg</option>
                      <option value="gray">Gray bg</option>
                    </select>
                  )}
                  <button type="button" className="icon-button" aria-label="Duplicate block" onClick={() => duplicateBlock(index)}>
                    <Icon name="copy" size={16} />
                  </button>
                  <button
                    type="button"
                    className="icon-button danger"
                    aria-label="Delete block"
                    onClick={() => onChange(blocks.filter(b => b.id !== block.id))}
                  >
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              </header>
              {!isCollapsed && (
                <div className="block-card-body">
                  <BlockEditorBody
                    block={block}
                    mode={mode}
                    onChange={updated => onChange(blocks.map(b => (b.id === block.id ? updated : b)))}
                    driveCaches={driveCaches}
                    onDriveCacheUpdated={onDriveCacheUpdated}
                    driveConfigured={driveConfigured}
                  />
                </div>
              )}
            </article>
            {renderInsertSlot(index + 1)}
          </div>
        );
      })}
    </div>
  );
}
