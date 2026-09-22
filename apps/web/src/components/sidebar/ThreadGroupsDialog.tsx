import { newThreadGroupOrderKey, planThreadGroupMove } from "./ThreadGroupsDialog.logic";
import { threadGroupSections } from "@t3tools/shared/threadGroups";
import { randomUUID } from "~/lib/utils";
import { cn } from "~/lib/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ThreadGroup } from "@t3tools/contracts";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Active,
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

// The handle is pointer-only; the arrow buttons are the keyboard path, so the
// sortable's default "press space to pick up" instructions would mislead.
const DRAG_ACCESSIBILITY = {
  screenReaderInstructions: {
    draggable: "Drag with a pointer to reorder, or use the Move up and Move down buttons.",
  },
};

/** Attached to each group row's sortable so a drop is applied by the row
 * that owns the name input, letting it fold an unsaved rename into the move. */
interface GroupRowDragData {
  readonly reorder: (planned: ThreadGroup) => void;
}

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
  // Outstanding save count: a drop can be saving while a rename still is.
  const [pendingSaves, setPendingSaves] = useState(0);
  const saving = pendingSaves > 0;
  const save = async (entries: readonly GroupEdit[]) => {
    setPendingSaves((count) => count + 1);
    try {
      return await props.update(entries);
    } finally {
      setPendingSaves((count) => count - 1);
    }
  };
  const editsDisabled = props.disabled || saving;
  // Only a read-only catalog blocks a move. A drop can land while another
  // row's rename is still saving; each save writes its own group record, so
  // the two never overwrite each other.
  const planMove = (index: number, delta: number) =>
    props.disabled ? null : planThreadGroupMove(props.groups, index, delta);
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
    const planned = planMove(from, to - from);
    if (planned) rowDragData(active)?.reorder(planned);
  };
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {/* Focus the popup so Tab starts at the first group control instead of selecting a name. */}
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
            accessibility={DRAG_ACCESSIBILITY}
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
                      planMove={(delta) => planMove(index, delta)}
                      save={save}
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

function rowDragData(active: Active): GroupRowDragData | undefined {
  return active.data.current as GroupRowDragData | undefined;
}

function GroupRow(props: {
  group: ThreadGroup;
  disabled: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  planMove: (delta: number) => ThreadGroup | null;
  save: (entries: readonly GroupEdit[]) => Promise<boolean>;
}) {
  const { group, disabled } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  // A rename folded into a reorder. The name input keeps that text until the
  // catalog catches up, so its blur must not resend it on the pre-move record
  // and undo the reorder.
  const submittedName = useRef<string | null>(null);
  useEffect(() => {
    if (submittedName.current === group.name) submittedName.current = null;
  }, [group.name]);
  const reorder = (planned: ThreadGroup) => {
    const next = inputRef.current?.value.trim() ?? "";
    const name = next && next !== group.name ? next : null;
    submittedName.current = name;
    void props.save([name === null ? planned : { ...planned, name }]).then((success) => {
      if (!success && submittedName.current === name) {
        submittedName.current = null;
        if (name !== null && inputRef.current?.value.trim() === name) {
          inputRef.current.value = group.name;
        }
      }
    });
  };
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: group.id,
    disabled: { draggable: disabled },
    data: { reorder } satisfies GroupRowDragData,
  });
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
        // dnd-kit ignores an already-prevented pointerdown, so it sees the
        // event first. A name being edited in this row then keeps focus and
        // rides along with the move instead of saving separately and racing it.
        onPointerDown={(event) => {
          listeners?.onPointerDown?.(event);
          if (document.activeElement === inputRef.current) event.preventDefault();
        }}
      >
        <GripVerticalIcon className="size-4" />
      </button>
      <Input
        ref={inputRef}
        // Remount on external rename so the uncontrolled value follows the server.
        key={group.name}
        aria-label={`Rename ${group.name}`}
        defaultValue={group.name}
        maxLength={80}
        disabled={disabled}
        onBlur={(event) => {
          const input = event.target;
          const next = input.value.trim();
          if (next === submittedName.current) return;
          if (next && next !== group.name) {
            void props.save([{ ...group, name: next }]).then((success) => {
              if (!success) input.value = group.name;
            });
          } else input.value = group.name;
        }}
      />
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Move ${group.name} up`}
        disabled={disabled || !props.canMoveUp}
        onClick={() => {
          const planned = props.planMove(-1);
          if (planned) reorder(planned);
        }}
      >
        <ArrowUpIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Move ${group.name} down`}
        disabled={disabled || !props.canMoveDown}
        onClick={() => {
          const planned = props.planMove(1);
          if (planned) reorder(planned);
        }}
      >
        <ArrowDownIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Remove ${group.name}`}
        disabled={disabled}
        onClick={() => void props.save([{ ...group, deleted: true }])}
      >
        <TrashIcon />
      </Button>
    </div>
  );
}
