import { newThreadGroupOrderKey, planThreadGroupMove } from "./ThreadGroupsDialog.logic";
import { threadGroupSections } from "@t3tools/shared/threadGroups";
import { randomUUID } from "~/lib/utils";
import { cn } from "~/lib/utils";
import { useMemo, useRef, useState } from "react";
import type { ThreadGroup } from "@t3tools/contracts";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useThreadGroups } from "~/hooks/useThreadGroups";
import { useThreadGroupsDialog } from "./threadGroupsDialogStore";
import { ArrowDownIcon, ArrowUpIcon, GripVerticalIcon, TrashIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";

type GroupEdit = Omit<ThreadGroup, "revision">;

const ACTIVE_DIVIDER_ID = "active-divider";

/** Mounted once at the app root; opened through `openThreadGroupsDialog`. */
export function ThreadGroupsDialogHost() {
  const request = useThreadGroupsDialog((state) => state.request);
  const close = useThreadGroupsDialog((state) => state.close);
  const customGroups = useThreadGroups();
  if (!request) return null;
  return (
    <ThreadGroupsDialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      initialFocus={request.focus}
      groups={customGroups.groups}
      disabled={!customGroups.canEdit}
      update={customGroups.update}
    />
  );
}

export function ThreadGroupsDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialFocus: "new-group" | "none";
  groups: readonly ThreadGroup[];
  disabled: boolean;
  update: (entries: readonly GroupEdit[]) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const newGroupInputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  const save = async (entries: readonly GroupEdit[]) => {
    setSaving(true);
    try {
      return await props.update(entries);
    } finally {
      setSaving(false);
    }
  };
  const editsDisabled = props.disabled || saving;
  const move = (index: number, delta: number) => {
    if (editsDisabled) return;
    const group = planThreadGroupMove(props.groups, index, delta);
    if (group) void save([group]);
  };
  // Groups render around a fixed Active divider; arrows and drags move across it.
  const sections = useMemo(() => threadGroupSections(props.groups), [props.groups]);
  const rowIds = useMemo(
    () => sections.map((group) => (group === null ? ACTIVE_DIVIDER_ID : group.id)),
    [sections],
  );
  // A small distance threshold keeps a plain click on the handle from
  // starting a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = rowIds.indexOf(String(active.id));
    const to = rowIds.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    move(from, to - from);
  };
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {/* "none" focuses the popup itself so Tab starts at the first group's name;
          the default would land in that input and select its text. */}
      <DialogPopup
        ref={popupRef}
        initialFocus={props.initialFocus === "new-group" ? newGroupInputRef : popupRef}
      >
        <DialogHeader>
          <DialogTitle>Thread groups</DialogTitle>
          <DialogDescription>
            Organize threads across projects and connected environments. Groups above the divider
            show before Active in the sidebar. Removing a group keeps its threads.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragEnd={onDragEnd}
          >
            <SortableContext items={rowIds} strategy={verticalListSortingStrategy}>
              <div className="space-y-3">
                {sections.map((group, index) =>
                  group === null ? (
                    <ActiveDividerRow key={ACTIVE_DIVIDER_ID} />
                  ) : (
                    <GroupRow
                      key={group.id}
                      group={group}
                      disabled={editsDisabled}
                      canMoveUp={index > 0}
                      canMoveDown={index < sections.length - 1}
                      onMove={(delta) => move(index, delta)}
                      onRename={(next) => save([{ ...group, name: next }])}
                      onRemove={() => void save([{ ...group, deleted: true }])}
                    />
                  ),
                )}
              </div>
            </SortableContext>
          </DndContext>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim() || saving) return;
              void save([
                {
                  id: randomUUID(),
                  name: name.trim(),
                  deleted: false,
                  orderKey: newThreadGroupOrderKey(props.groups),
                },
              ]).then((success) => {
                if (success) setName("");
              });
            }}
          >
            <Input
              ref={newGroupInputRef}
              aria-label="New group name"
              placeholder="New group name"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              disabled={editsDisabled}
            />
            <Button type="submit" disabled={editsDisabled || !name.trim()}>
              Create
            </Button>
          </form>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/** The divider is a sortable slot that cannot be picked up, so dragged
 * groups shift it like any other row and crossing it changes sides. */
function ActiveDividerRow() {
  const { setNodeRef, transform, transition } = useSortable({
    id: ACTIVE_DIVIDER_ID,
    disabled: { draggable: true },
  });
  return (
    <div
      ref={setNodeRef}
      role="separator"
      aria-label="Active"
      className="flex items-center gap-2 text-xs font-medium text-muted-foreground"
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <div className="h-px flex-1 bg-border" />
      <span>Active</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function GroupRow(props: {
  group: ThreadGroup;
  disabled: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (delta: number) => void;
  onRename: (name: string) => Promise<boolean>;
  onRemove: () => void;
}) {
  const { group, disabled } = props;
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: group.id, disabled: { draggable: disabled } });
  return (
    <div
      ref={setNodeRef}
      className={cn("flex items-center gap-2", isDragging && "relative z-10 opacity-80")}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        aria-label={`Drag ${group.name} to reorder`}
        disabled={disabled}
        className="flex size-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:text-foreground disabled:cursor-default disabled:opacity-50 active:cursor-grabbing"
        {...attributes}
        {...listeners}
        // Keep focus where it is: a blur on a just-edited name would save the
        // rename and race the reorder that this press starts.
        onPointerDown={(event) => {
          event.preventDefault();
          listeners?.onPointerDown?.(event);
        }}
      >
        <GripVerticalIcon className="size-4" />
      </button>
      <Input
        // Remount on external rename so the uncontrolled value follows the server.
        key={group.name}
        aria-label={`Rename ${group.name}`}
        defaultValue={group.name}
        maxLength={80}
        disabled={disabled}
        onBlur={(event) => {
          const next = event.target.value.trim();
          if (next && next !== group.name) {
            const input = event.target;
            void props.onRename(next).then((success) => {
              if (!success) input.value = group.name;
            });
          } else event.target.value = group.name;
        }}
      />
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Move ${group.name} up`}
        disabled={disabled || !props.canMoveUp}
        onClick={() => props.onMove(-1)}
      >
        <ArrowUpIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Move ${group.name} down`}
        disabled={disabled || !props.canMoveDown}
        onClick={() => props.onMove(1)}
      >
        <ArrowDownIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Remove ${group.name}`}
        disabled={disabled}
        onClick={props.onRemove}
      >
        <TrashIcon />
      </Button>
    </div>
  );
}
