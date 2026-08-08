import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { HourglassIcon, SearchIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { cn } from "~/lib/utils";
import { useThreadShells } from "../../state/entities";
import { Command, CommandGroup, CommandGroupLabel, CommandItem, CommandList } from "../ui/command";
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

/**
 * Popover picking the thread a `/t3-wait` insertion should target. Same
 * interaction contract as the stash menu: arrows to navigate, Enter to pick,
 * Escape to dismiss, capture-phase on window so it wins over the editor.
 * Typing goes to the picker's own filter input, which holds focus while open.
 */
export const ComposerThreadWaitMenu = memo(function ComposerThreadWaitMenu(props: {
  environmentId: EnvironmentId;
  excludeThreadId: ThreadId | null;
  onPick: (entry: ThreadWaitPickerEntry) => void;
  onClose: () => void;
}) {
  const { environmentId, excludeThreadId, onPick, onClose } = props;
  const shells = useThreadShells();
  const [query, setQuery] = useState("");
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const entries = useMemo(
    () => buildThreadWaitPickerEntries({ shells, environmentId, excludeThreadId, query }),
    [environmentId, excludeThreadId, query, shells],
  );

  const highlightedEntry = entries.find((entry) => entry.id === highlightedId) ?? entries[0];

  useEffect(() => {
    // Lexical re-asserts editor focus on the same tick the menu mounts, so a
    // synchronous focus loses the race; take it one frame later.
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (entries.length === 0) return;
    if (!entries.some((entry) => entry.id === highlightedId)) {
      setHighlightedId(entries[0]?.id ?? null);
    }
  }, [entries, highlightedId]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (entries.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        const currentIndex = entries.findIndex((entry) => entry.id === highlightedId);
        const offset = event.key === "ArrowDown" ? 1 : -1;
        const normalizedIndex = currentIndex >= 0 ? currentIndex : offset === 1 ? -1 : 0;
        const nextIndex = (normalizedIndex + offset + entries.length) % entries.length;
        setHighlightedId(entries[nextIndex]?.id ?? null);
        return;
      }
      if (event.key === "Enter") {
        if (!highlightedEntry) return;
        event.preventDefault();
        event.stopPropagation();
        onPick(highlightedEntry);
        return;
      }
      // Route stray typing into the filter even when focus is still held by
      // the composer editor, so filtering works no matter who won the focus
      // race. The input's own keystrokes bubble here too — let those through.
      if (event.target === inputRef.current) return;
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        inputRef.current?.focus();
        setQuery((current) => current + event.key);
        return;
      }
      if (event.key === "Backspace") {
        event.preventDefault();
        event.stopPropagation();
        inputRef.current?.focus();
        setQuery((current) => current.slice(0, -1));
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [entries, highlightedEntry, highlightedId, onClose, onPick]);

  return (
    <Command autoHighlight={false} mode="none">
      <div className="dropdown-glass relative w-full overflow-hidden rounded-[20px]">
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
          <SearchIcon className="size-3.5 shrink-0 text-icon-muted" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Wait for which thread?"
            aria-label="Filter threads to wait for"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-secondary-label"
          />
        </div>
        <CommandList className="max-h-72">
          <CommandGroup>
            <CommandGroupLabel className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-secondary-label">
              <HourglassIcon className="size-3" aria-hidden="true" />
              Wait for thread
            </CommandGroupLabel>
            {entries.length === 0 ? (
              <p className="px-3 pb-3 pt-1 text-secondary-label text-xs">
                {query.trim().length > 0
                  ? "No thread titles match."
                  : "No other threads in this workspace yet."}
              </p>
            ) : (
              entries.map((entry) => (
                <CommandItem
                  key={entry.id}
                  value={entry.id}
                  className={cn(
                    "cursor-pointer select-none gap-2 hover:bg-transparent hover:text-inherit data-highlighted:bg-transparent data-highlighted:text-inherit",
                    highlightedEntry?.id === entry.id && "bg-accent! text-accent-foreground!",
                  )}
                  onMouseMove={() => {
                    if (highlightedId !== entry.id) setHighlightedId(entry.id);
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onClick={() => {
                    onPick(entry);
                  }}
                >
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      ACTIVITY_DOT_CLASS[entry.activity],
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">{entry.title}</span>
                  {ACTIVITY_LABEL[entry.activity] ? (
                    <span className="shrink-0 text-[10px] text-secondary-label">
                      {ACTIVITY_LABEL[entry.activity]}
                    </span>
                  ) : null}
                  <span className="shrink-0 text-secondary-label text-xs">
                    {formatRelativeTimeLabel(entry.updatedAt)}
                  </span>
                </CommandItem>
              ))
            )}
          </CommandGroup>
        </CommandList>
      </div>
    </Command>
  );
});
