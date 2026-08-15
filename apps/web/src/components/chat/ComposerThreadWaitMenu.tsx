import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { HourglassIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { cn } from "~/lib/utils";
import { useThreadShells } from "../../state/entities";
import { CommandItem } from "../ui/command";
import {
  ComposerPickerShell,
  useComposerPickerKeyboard,
  useComposerPickerQuery,
} from "./composerPickerMenu";
import {
  buildThreadWaitPickerEntries,
  type ThreadWaitPickerActivity,
  type ThreadWaitPickerEntry,
} from "./composerThreadWaitPicker";

const ACTIVITY_DOT_CLASS: Record<ThreadWaitPickerActivity, string> = {
  running: "bg-success animate-pulse",
  blocked: "bg-warning",
  background: "bg-info",
  idle: "bg-muted-foreground/40",
};

const ACTIVITY_LABEL: Record<ThreadWaitPickerActivity, string | null> = {
  running: "running",
  blocked: "needs input",
  background: "background work",
  idle: null,
};

/** Popover picking the thread a `/t3-wait` insertion should target. */
export const ComposerThreadWaitMenu = memo(function ComposerThreadWaitMenu(props: {
  environmentId: EnvironmentId;
  excludeThreadId: ThreadId | null;
  onPick: (entry: ThreadWaitPickerEntry) => void;
  onClose: () => void;
}) {
  const { environmentId, excludeThreadId, onPick, onClose } = props;
  const shells = useThreadShells();
  const { query, setQuery } = useComposerPickerQuery();

  const entries = useMemo(
    () => buildThreadWaitPickerEntries({ shells, environmentId, excludeThreadId, query }),
    [environmentId, excludeThreadId, query, shells],
  );
  const picker = useComposerPickerKeyboard({ entries, onPick, onClose, setQuery });

  return (
    <ComposerPickerShell
      menuRef={picker.menuRef}
      inputRef={picker.inputRef}
      query={query}
      onQueryChange={setQuery}
      placeholder="Wait for which thread?"
      inputAriaLabel="Filter threads to wait for"
      groupIcon={<HourglassIcon className="size-3" aria-hidden="true" />}
      groupLabel="Wait for thread"
      emptyState={
        entries.length === 0 ? (
          <p className="px-3 pb-3 pt-1 text-secondary-label text-xs">
            {query.trim().length > 0
              ? "No thread titles match."
              : "No other threads in this workspace yet."}
          </p>
        ) : null
      }
    >
      {entries.map((entry) => (
        <CommandItem
          key={entry.id}
          value={entry.id}
          className={cn(
            "cursor-pointer select-none gap-2 hover:bg-transparent hover:text-inherit data-highlighted:bg-transparent data-highlighted:text-inherit",
            picker.highlightedEntry?.id === entry.id && "bg-accent! text-accent-foreground!",
          )}
          onMouseMove={() => {
            if (picker.highlightedId !== entry.id) picker.setHighlightedId(entry.id);
          }}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={() => {
            onPick(entry);
          }}
        >
          <span
            className={cn("size-2 shrink-0 rounded-full", ACTIVITY_DOT_CLASS[entry.activity])}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate text-sm">
            {entry.title.trim().length > 0 ? entry.title : "Untitled thread"}
          </span>
          {ACTIVITY_LABEL[entry.activity] ? (
            <span className="shrink-0 text-[10px] text-secondary-label">
              {ACTIVITY_LABEL[entry.activity]}
            </span>
          ) : null}
          <span className="shrink-0 text-secondary-label text-xs">
            {formatRelativeTimeLabel(entry.updatedAt)}
          </span>
        </CommandItem>
      ))}
    </ComposerPickerShell>
  );
});
