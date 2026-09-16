import { pinOrderKeyBetween } from "@t3tools/client-runtime/state/thread-sort";
import { planThreadGroupMove } from "./ThreadGroupsDialog.logic";
import { randomUUID } from "~/lib/utils";
import { useRef, useState } from "react";
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
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {/* "none" focuses the popup itself so Tab starts at the first group's name;
          the default would land in that input and select its text. */}
      <DialogPopup initialFocus={props.initialFocus === "new-group" ? newGroupInputRef : false}>
        <DialogHeader>
          <DialogTitle>Thread groups</DialogTitle>
          <DialogDescription>
            Organize threads across projects and connected environments. Removing a group keeps its
            threads.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {props.groups.map((group, index) => (
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
                disabled={props.disabled || saving || index === props.groups.length - 1}
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
          ))}
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
                  orderKey: pinOrderKeyBetween(props.groups.at(-1)?.orderKey ?? null, null) ?? "n",
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
