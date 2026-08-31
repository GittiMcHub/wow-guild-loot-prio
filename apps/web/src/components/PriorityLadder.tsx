import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { CatalogEntry, DraftEntry } from '../lib/builder-types';

interface Props {
  entries: DraftEntry[];
  effectiveCapacity: number;
  blockedCharacterIds: Set<string>;
  catalogByItemId: Map<number, CatalogEntry>;
  characterNameById: Map<string, string>;
  onReorder: (next: DraftEntry[]) => void;
  onRemove: (key: string) => void;
  onNoteChange: (key: string, note: string) => void;
}

/**
 * The priority ladder (§11.2): drag-and-drop ordered list, rank = array
 * position. Keyboard-operable via @dnd-kit's KeyboardSensor (arrow-key
 * reorder), satisfying the §13 accessibility requirement.
 */
export function PriorityLadder({
  entries,
  effectiveCapacity,
  blockedCharacterIds,
  catalogByItemId,
  characterNameById,
  onReorder,
  onRemove,
  onNoteChange,
}: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = entries.findIndex((e) => e.key === active.id);
    const newIndex = entries.findIndex((e) => e.key === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    onReorder(arrayMove(entries, oldIndex, newIndex));
  }

  return (
    <div>
      <p className="mb-2 text-sm text-zinc-400">
        {entries.length} of {effectiveCapacity}
      </p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={entries.map((e) => e.key)} strategy={verticalListSortingStrategy}>
          <ol className="space-y-1">
            {entries.map((entry, i) => (
              <LadderRow
                key={entry.key}
                rank={i + 1}
                entry={entry}
                blocked={blockedCharacterIds.has(entry.characterId) && entry.slot === 'OFF_HAND'}
                item={catalogByItemId.get(entry.itemId)}
                characterName={characterNameById.get(entry.characterId) ?? '?'}
                onRemove={() => onRemove(entry.key)}
                onNoteChange={(note) => onNoteChange(entry.key, note)}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      {entries.length === 0 && <p className="text-sm text-zinc-500">Nothing ranked yet — add a wish below.</p>}
    </div>
  );
}

function LadderRow({
  rank,
  entry,
  item,
  blocked,
  characterName,
  onRemove,
  onNoteChange,
}: {
  rank: number;
  entry: DraftEntry;
  item: CatalogEntry | undefined;
  blocked: boolean;
  characterName: string;
  onRemove: () => void;
  onNoteChange: (note: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: entry.key });
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-2 rounded border px-2 py-2 ${
        blocked ? 'border-amber-700 bg-amber-950/30' : 'border-zinc-800 bg-zinc-900'
      } ${isDragging ? 'opacity-60' : ''}`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${item?.name ?? 'item'}, currently rank ${rank}`}
        className="cursor-grab select-none rounded px-1 py-1 text-zinc-500 hover:text-zinc-300 active:cursor-grabbing"
      >
        ⠿
      </button>
      <span className="w-8 shrink-0 font-mono text-lg text-emerald-400">#{rank}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{item?.name ?? `Item ${entry.itemId}`}</p>
        <p className="truncate text-xs text-zinc-500">
          {entry.slot} · {characterName}
          {blocked && ' · blocked — two-handed weapon uses both hands'}
        </p>
      </div>
      <input
        value={entry.note ?? ''}
        onChange={(e) => onNoteChange(e.target.value)}
        placeholder="note"
        className="hidden w-28 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs sm:block"
      />
      <button type="button" onClick={onRemove} aria-label="Remove" className="rounded px-2 py-1 text-zinc-500 hover:text-red-400">
        ✕
      </button>
    </li>
  );
}
