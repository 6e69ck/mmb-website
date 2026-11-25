import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import {
  newBlockId,
  type FaqGroupBlock,
  type FaqItem,
  type ImageBlock,
  type PageBlock,
} from '@mmb/content';
import { uploadContentAsset } from '../api';
import ImageViewerModal, { extractFilename, type ImageViewerItem } from '../ImageViewerModal';
import { processPhoto } from '../media-processing';
import { Icon } from '../ui';
import { resolveImageUrl, type AdminMode } from './asset-urls';
import RichTextEditor from './RichTextEditor';
import { useDragAutoScroll } from './useDragAutoScroll';
import './faq-editor.css';

type AudienceKey = 'students' | 'organizers';
export type FaqDropPlacement = 'before' | 'after';

type DropTarget = {
  index: number;
  placement: FaqDropPlacement;
};

const INTERACTIVE_TARGET_SELECTOR =
  'input, textarea, select, button, a, [contenteditable="true"], .rte-wrapper';

function findFaqGroup(blocks: PageBlock[], anchor: AudienceKey): FaqGroupBlock {
  const existing = blocks.find(
    (b): b is FaqGroupBlock => b.type === 'faq-group' && (b.anchor === anchor || b.id === `faq-${anchor}`)
  );
  if (existing) return existing;
  return {
    id: `faq-${anchor}`,
    type: 'faq-group',
    anchor,
    buttonLabel: anchor === 'students' ? 'Students' : 'Organizers',
    heading: anchor === 'students' ? 'FAQ for Students' : 'FAQ for Event Organizers',
    background: 'white',
    items: [],
  };
}

function findPhotoBlock(blocks: PageBlock[]): ImageBlock | undefined {
  return blocks.find((b): b is ImageBlock => b.type === 'image');
}

function rebuildFaqBlocks(
  prevBlocks: PageBlock[],
  students: FaqGroupBlock,
  organizers: FaqGroupBlock,
  photo?: ImageBlock
): PageBlock[] {
  const heading = prevBlocks.find(b => b.type === 'heading') ?? {
    id: 'faq-heading',
    type: 'heading' as const,
    text: 'FAQ',
    align: 'center' as const,
    background: 'white' as const,
  };
  const nav = {
    id: 'faq-nav',
    type: 'button-bar' as const,
    ariaLabel: 'FAQ audiences',
    background: 'white' as const,
    buttons: [
      { id: 'faq-btn-1', label: students.buttonLabel || 'Students', href: `#${students.anchor}`, style: 'primary' as const },
      { id: 'faq-btn-2', label: organizers.buttonLabel || 'Organizers', href: `#${organizers.anchor}`, style: 'primary' as const },
    ],
  };
  const extraBlocks = prevBlocks.filter(
    b => b.id !== heading.id && b.type !== 'button-bar' && b.id !== students.id && b.id !== organizers.id && b.id !== photo?.id
  );
  return [
    heading,
    nav,
    students,
    ...(photo ? [photo] : []),
    organizers,
    ...extraBlocks,
  ];
}

function resolveFaqInsertIndex(
  length: number,
  fromIndex: number,
  targetIndex: number,
  placement: FaqDropPlacement
): number | null {
  if (
    !Number.isInteger(fromIndex) ||
    !Number.isInteger(targetIndex) ||
    fromIndex < 0 ||
    fromIndex >= length ||
    targetIndex < 0 ||
    targetIndex >= length
  ) {
    return null;
  }
  const rawInsertIndex = placement === 'before' ? targetIndex : targetIndex + 1;
  const insertIndex = fromIndex < rawInsertIndex ? rawInsertIndex - 1 : rawInsertIndex;
  return insertIndex === fromIndex ? null : insertIndex;
}

export function reorderFaqItems<T>(
  items: T[],
  fromIndex: number,
  targetIndex: number,
  placement: FaqDropPlacement
): T[] {
  const insertIndex = resolveFaqInsertIndex(items.length, fromIndex, targetIndex, placement);
  if (insertIndex === null) return items;
  const copy = [...items];
  const [moved] = copy.splice(fromIndex, 1);
  copy.splice(insertIndex, 0, moved);
  return copy;
}

function computeDropPlacement(
  clientY: number,
  rect: Pick<DOMRect, 'top' | 'height'>
): FaqDropPlacement {
  const midpoint = rect.top + rect.height / 2;
  return clientY < midpoint ? 'before' : 'after';
}

function summarizeAnswer(answer: FaqItem['answer']): string {
  const parts: string[] = [];
  for (const block of answer) {
    if (block.type === 'paragraph') {
      const text = block.children.map(node => node.text).join('').trim();
      if (text) parts.push(text);
    } else if (block.type === 'list') {
      for (const item of block.items) {
        const text = item.map(node => node.text).join('').trim();
        if (text) parts.push(text);
      }
    }
    if (parts.join(' ').length > 160) break;
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export default function FaqEditor({
  blocks,
  mode,
  onChange,
  rearrangeMode = false,
}: {
  blocks: PageBlock[];
  mode: AdminMode;
  onChange: (next: PageBlock[]) => void;
  rearrangeMode?: boolean;
}) {
  const [audience, setAudience] = useState<AudienceKey>('students');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [viewingPhoto, setViewingPhoto] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState('');
  const dragIndexRef = useRef<number | null>(null);
  const armedCardRef = useRef<HTMLElement | null>(null);

  useDragAutoScroll(rearrangeMode && dragIndex !== null);

  const studentsGroup = findFaqGroup(blocks, 'students');
  const organizersGroup = findFaqGroup(blocks, 'organizers');
  const photoBlock = findPhotoBlock(blocks);
  const activeGroup = audience === 'students' ? studentsGroup : organizersGroup;

  const clearDragState = () => {
    dragIndexRef.current = null;
    setDragIndex(null);
    setDropTarget(null);
    if (armedCardRef.current) {
      armedCardRef.current.draggable = false;
      armedCardRef.current = null;
    }
  };

  useEffect(() => {
    if (!rearrangeMode) {
      clearDragState();
    }
  }, [rearrangeMode]);

  const switchAudience = (next: AudienceKey) => {
    if (next !== audience) {
      clearDragState();
      setAudience(next);
    }
  };

  const updateGroup = (updated: FaqGroupBlock) => {
    const nextStudents = audience === 'students' ? updated : studentsGroup;
    const nextOrganizers = audience === 'organizers' ? updated : organizersGroup;
    onChange(rebuildFaqBlocks(blocks, nextStudents, nextOrganizers, photoBlock));
  };

  const applyReorder = (fromIndex: number, targetIndex: number, placement: FaqDropPlacement) => {
    const nextItems = reorderFaqItems(activeGroup.items, fromIndex, targetIndex, placement);
    if (nextItems !== activeGroup.items) {
      updateGroup({ ...activeGroup, items: nextItems });
    }
  };

  const handleCardMouseDown = (e: MouseEvent<HTMLElement>) => {
    const target = e.target as HTMLElement | null;
    if (!target || target.closest(INTERACTIVE_TARGET_SELECTOR)) {
      e.currentTarget.draggable = false;
      if (armedCardRef.current === e.currentTarget) {
        armedCardRef.current = null;
      }
      return;
    }
    if (target.closest('.faq-drag-handle')) {
      return;
    }
    e.currentTarget.draggable = true;
    armedCardRef.current = e.currentTarget;
  };

  const handleCardMouseUp = (e: MouseEvent<HTMLElement>) => {
    if (dragIndexRef.current === null) {
      e.currentTarget.draggable = false;
      if (armedCardRef.current === e.currentTarget) {
        armedCardRef.current = null;
      }
    }
  };

  const handleDragStart = (e: DragEvent<HTMLElement>, item: FaqItem, idx: number) => {
    const target = e.target as HTMLElement | null;
    if (target && target.closest(INTERACTIVE_TARGET_SELECTOR)) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.id);
    const cardEl = e.currentTarget.closest<HTMLElement>('.faq-question-card');
    if (cardEl && typeof e.dataTransfer.setDragImage === 'function') {
      const rect = cardEl.getBoundingClientRect();
      const offsetX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const offsetY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
      e.dataTransfer.setDragImage(cardEl, offsetX, offsetY);
    }
    dragIndexRef.current = idx;
    setDragIndex(idx);
    setDropTarget(null);
  };

  const handleCardDragOver = (e: DragEvent<HTMLElement>, idx: number) => {
    const fromIndex = dragIndexRef.current;
    if (fromIndex === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const placement = computeDropPlacement(e.clientY, e.currentTarget.getBoundingClientRect());
    const validInsert = resolveFaqInsertIndex(activeGroup.items.length, fromIndex, idx, placement);
    if (validInsert === null) {
      setDropTarget(prev => (prev === null ? prev : null));
      return;
    }
    setDropTarget(prev =>
      prev && prev.index === idx && prev.placement === placement ? prev : { index: idx, placement }
    );
  };

  const handleCardDrop = (e: DragEvent<HTMLElement>, idx: number) => {
    const fromIndex = dragIndexRef.current;
    if (fromIndex === null) return;
    e.preventDefault();
    e.stopPropagation();
    const placement = computeDropPlacement(e.clientY, e.currentTarget.getBoundingClientRect());
    applyReorder(fromIndex, idx, placement);
    clearDragState();
  };

  const handleStackDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (dragIndexRef.current === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleStackDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (dragIndexRef.current === null) return;
    const nextTarget = e.relatedTarget as Node | null;
    if (!nextTarget || !e.currentTarget.contains(nextTarget)) {
      setDropTarget(null);
    }
  };

  const handleStackDrop = (e: DragEvent<HTMLDivElement>) => {
    const fromIndex = dragIndexRef.current;
    if (fromIndex === null) return;
    e.preventDefault();
    if (dropTarget) {
      applyReorder(fromIndex, dropTarget.index, dropTarget.placement);
    }
    clearDragState();
  };

  const updateItem = (itemId: string, patch: Partial<FaqItem>) => {
    updateGroup({
      ...activeGroup,
      items: activeGroup.items.map(item => (item.id === itemId ? { ...item, ...patch } : item)),
    });
  };

  const addQuestion = () => {
    updateGroup({
      ...activeGroup,
      items: [
        ...activeGroup.items,
        {
          id: newBlockId(),
          question: `${activeGroup.items.length + 1}. New question?`,
          answer: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
        },
      ],
    });
  };

  const handlePhotoUpload = async (file: File) => {
    setUploadingPhoto(true);
    setPhotoError('');
    const controller = new AbortController();
    try {
      const processed = await processPhoto(file, controller.signal);
      const uploaded = await uploadContentAsset(file, controller.signal);
      const nextPhoto: ImageBlock = {
        id: photoBlock?.id || 'faq-photo',
        type: 'image',
        maxWidth: photoBlock?.maxWidth || 450,
        background: 'gray',
        image: {
          assetKey: uploaded.assetKey,
          alt: photoBlock?.image.alt || 'McMaster Marching Band',
          width: processed.width,
          height: processed.height,
          hash: processed.hash,
          placeholder: processed.placeholder,
        },
      };
      onChange(rebuildFaqBlocks(blocks, studentsGroup, organizersGroup, nextPhoto));
    } catch (caught) {
      setPhotoError(caught instanceof Error ? caught.message : 'Could not upload photo.');
    } finally {
      setUploadingPhoto(false);
    }
  };

  const photoSrc = resolveImageUrl(photoBlock?.image, mode);
  const photoViewerItem: ImageViewerItem | null = photoSrc
    ? {
        src: photoSrc,
        alt: photoBlock?.image.alt || 'FAQ divider',
        filename:
          extractFilename(photoBlock?.image.assetKey || photoBlock?.image.legacyPath || photoSrc) ||
          undefined,
        width: photoBlock?.image.width,
        height: photoBlock?.image.height,
      }
    : null;

  return (
    <div className="faq-editor-root">
      <div className="faq-editor-tabs" role="tablist" aria-label="FAQ sections">
        <button
          type="button"
          role="tab"
          aria-selected={audience === 'students'}
          className={audience === 'students' ? 'is-active' : ''}
          onClick={() => switchAudience('students')}
        >
          <span>FAQ for Students</span>
          <span className="faq-tab-count">{studentsGroup.items.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={audience === 'organizers'}
          className={audience === 'organizers' ? 'is-active' : ''}
          onClick={() => switchAudience('organizers')}
        >
          <span>FAQ for Event Organizers</span>
          <span className="faq-tab-count">{organizersGroup.items.length}</span>
        </button>
      </div>

      <section className="faq-questions-panel" aria-label={activeGroup.heading}>
        <div className="faq-panel-header">
          <div>
            <h2>{activeGroup.heading}</h2>
            <p>
              {rearrangeMode
                ? 'Drag any question card to reorder this section, or use the arrow buttons.'
                : 'Edit questions and answers. Switch to the Rearrange tab to change question order.'}
            </p>
          </div>
          {!rearrangeMode && (
            <button type="button" className="button button-primary" onClick={addQuestion}>
              <Icon name="plus" size={15} /> Add question
            </button>
          )}
        </div>

        {!activeGroup.items.length ? (
          <div className="faq-empty-box">
            <p>No questions in this section yet.</p>
            {!rearrangeMode && (
              <button type="button" className="button button-secondary button-sm" onClick={addQuestion}>
                <Icon name="plus" size={14} /> Add the first question
              </button>
            )}
          </div>
        ) : rearrangeMode ? (
          <div
            className="faq-items-stack faq-rearrange-stack"
            onDragOver={handleStackDragOver}
            onDragLeave={handleStackDragLeave}
            onDrop={handleStackDrop}
          >
            {activeGroup.items.map((item, idx) => {
              const isDragging = dragIndex === idx;
              const isDropBefore = dropTarget?.index === idx && dropTarget.placement === 'before';
              const isDropAfter = dropTarget?.index === idx && dropTarget.placement === 'after';
              const snippet = summarizeAnswer(item.answer);
              const cardClassName = [
                'faq-question-card',
                'faq-rearrange-card',
                isDragging ? 'is-dragging' : '',
                isDropBefore ? 'is-drop-before' : '',
                isDropAfter ? 'is-drop-after' : '',
              ]
                .filter(Boolean)
                .join(' ');

              return (
                <article
                  key={item.id}
                  className={cardClassName}
                  onMouseDown={handleCardMouseDown}
                  onMouseUp={handleCardMouseUp}
                  onDragStart={e => handleDragStart(e, item, idx)}
                  onDragEnd={clearDragState}
                  onDragOver={e => handleCardDragOver(e, idx)}
                  onDrop={e => handleCardDrop(e, idx)}
                >
                  <div className="faq-rearrange-row">
                    <span
                      className="faq-drag-handle"
                      draggable
                      title="Drag to reorder question"
                      aria-label={`Drag question ${idx + 1} to reorder`}
                    >
                      <Icon name="grip" size={16} />
                      <span className="nested-index">Q{idx + 1}</span>
                    </span>
                    <div className="faq-rearrange-summary">
                      <strong className="faq-rearrange-question">
                        {item.question.trim() || 'Untitled question'}
                      </strong>
                      {snippet && <span className="faq-rearrange-snippet">{snippet}</span>}
                    </div>
                    <div className="nested-actions">
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Move question up"
                        disabled={idx === 0}
                        onClick={() => applyReorder(idx, idx - 1, 'before')}
                      >
                        <Icon name="up" size={15} />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Move question down"
                        disabled={idx === activeGroup.items.length - 1}
                        onClick={() => applyReorder(idx, idx + 1, 'after')}
                      >
                        <Icon name="down" size={15} />
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="faq-items-stack">
            {activeGroup.items.map((item, idx) => (
              <article key={item.id} className="faq-question-card faq-edit-card">
                <div className="faq-question-head">
                  <span className="nested-index faq-edit-index">Q{idx + 1}</span>
                  <input
                    className="faq-question-input"
                    aria-label={`Question ${idx + 1}`}
                    value={item.question}
                    placeholder="Enter question…"
                    onChange={e => updateItem(item.id, { question: e.target.value })}
                  />
                  <div className="nested-actions">
                    <button
                      type="button"
                      className="icon-button danger"
                      aria-label="Remove question"
                      onClick={() =>
                        updateGroup({
                          ...activeGroup,
                          items: activeGroup.items.filter(q => q.id !== item.id),
                        })
                      }
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                </div>
                <RichTextEditor
                  value={item.answer}
                  onChange={answer => updateItem(item.id, { answer })}
                  placeholder="Write answer…"
                  minHeight={82}
                />
              </article>
            ))}
          </div>
        )}
      </section>

      {!rearrangeMode && (
        <section className="faq-photo-section">
          <button
            type="button"
            className="faq-photo-toggle"
            aria-expanded={photoOpen}
            onClick={() => setPhotoOpen(open => !open)}
          >
            <span>Section Divider Photo</span>
            <Icon name={photoOpen ? 'up' : 'down'} size={16} />
          </button>
          {photoOpen && (
            <div className="faq-photo-card">
              <div className="faq-photo-preview">
                {photoSrc ? (
                  <button
                    type="button"
                    className="image-preview-trigger"
                    onClick={() => setViewingPhoto(true)}
                    aria-label="View full divider photo"
                    title="Click to view full image"
                  >
                    <img src={photoSrc} alt={photoBlock?.image.alt || 'FAQ divider'} />
                  </button>
                ) : (
                  <span>No photo</span>
                )}
              </div>
              <div className="faq-photo-fields">
                <div className="asset-action-row">
                  <label className="button button-secondary button-sm file-picker">
                    <Icon name="upload" size={14} />
                    <span>{uploadingPhoto ? 'Uploading…' : photoSrc ? 'Replace divider photo' : 'Upload divider photo'}</span>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      disabled={uploadingPhoto}
                      onChange={e => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file) void handlePhotoUpload(file);
                      }}
                    />
                  </label>
                  {photoSrc && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setViewingPhoto(true)}
                    >
                      <Icon name="eye" size={14} /> View full image
                    </button>
                  )}
                </div>
                {photoBlock && (
                  <label>
                    <span>Alt description</span>
                    <input
                      value={photoBlock.image.alt}
                      onChange={e => {
                        const nextPhoto: ImageBlock = {
                          ...photoBlock,
                          image: { ...photoBlock.image, alt: e.target.value },
                        };
                        onChange(rebuildFaqBlocks(blocks, studentsGroup, organizersGroup, nextPhoto));
                      }}
                    />
                  </label>
                )}
                {photoError && <span className="inline-error">{photoError}</span>}
              </div>
            </div>
          )}
        </section>
      )}
      {viewingPhoto && photoViewerItem && (
        <ImageViewerModal item={photoViewerItem} onClose={() => setViewingPhoto(false)} />
      )}
    </div>
  );
}
