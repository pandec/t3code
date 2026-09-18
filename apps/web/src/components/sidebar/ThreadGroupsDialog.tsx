import { newThreadGroupOrderKey, planThreadGroupMove } from "./ThreadGroupsDialog.logic";
import { threadGroupSections } from "@t3tools/shared/threadGroups";
import { randomUUID } from "~/lib/utils";
import { useMemo, useRef, useState } from "react";
import type { ThreadGroup } from "@t3tools/contracts";
import { useThreadGroups } from "~/hooks/useThreadGroups";
import { useThreadGroupsDialog } from "./threadGroupsDialogStore";
import { ArrowDownIcon, ArrowUpIcon, TrashIcon } from "lucide-react";
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
  const move = (index: number, delta: number) => {
    const group = planThreadGroupMove(props.groups, index, delta);
    if (group) void save([group]);
  };
  // Groups render around a fixed Active divider; arrows move across it.
  const sections = useMemo(() => threadGroupSections(props.groups), [props.groups]);
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
          {sections.map((group, index) =>
            group === null ? (
              <div
                key="active-divider"
                role="separator"
                aria-label="Active"
                className="flex items-center gap-2 text-xs font-medium text-muted-foreground"
              >
                <div className="h-px flex-1 bg-border" />
                <span>Active</span>
                <div className="h-px flex-1 bg-border" />
              </div>
            ) : (
              <div key={`${group.id}:${group.name}`} className="flex items-center gap-2">
                <Input
                  aria-label={`Rename ${group.name}`}
                  defaultValue={group.name}
                  maxLength={80}
                  disabled={props.disabled || saving}
                  onBlur={(event) => {
                    const next = event.target.value.trim();
                    if (next && next !== group.name) {
                      const input = event.target;
                      void save([{ ...group, name: next }]).then((success) => {
                        if (!success) input.value = group.name;
                      });
                    } else event.target.value = group.name;
                  }}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${group.name} up`}
                  disabled={props.disabled || saving || index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${group.name} down`}
                  disabled={props.disabled || saving || index === sections.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDownIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${group.name}`}
                  disabled={props.disabled || saving}
                  onClick={() => void save([{ ...group, deleted: true }])}
                >
                  <TrashIcon />
                </Button>
              </div>
            ),
          )}
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
              disabled={props.disabled || saving}
            />
            <Button type="submit" disabled={props.disabled || saving || !name.trim()}>
              Create
            </Button>
          </form>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
