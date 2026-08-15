import type { SavedPrompt } from "@t3tools/contracts/settings";
import { NotebookPenIcon, SearchIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { Command, CommandGroup, CommandGroupLabel, CommandItem, CommandList } from "../ui/command";
import { buildSavedPromptPickerEntries, savedPromptPreview } from "./composerPromptPicker";

/**
 * Popover picking the saved prompt a `/prompt` insertion should use. Same
 * interaction contract as the thread-wait menu: arrows to navigate, Enter to
 * pick, Escape to dismiss, capture-phase on window so it wins over the
 * editor. Typing goes to the picker's own filter input.
 */
export const ComposerPromptMenu = memo(function ComposerPromptMenu(props: {
  prompts: ReadonlyArray<SavedPrompt>;
  onPick: (prompt: SavedPrompt) => void;
  onClose: () => void;
}) {
  const { prompts, onPick, onClose } = props;
  const [query, setQuery] = useState("");
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const entries = useMemo(
    () => buildSavedPromptPickerEntries({ prompts, query }),
    [prompts, query],
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

  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Interacting anywhere outside the menu hands control back — the picker
    // must never behave like a modal keyboard trap.
    const handler = (event: PointerEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      onClose();
    };
    window.addEventListener("pointerdown", handler, true);
    return () => window.removeEventListener("pointerdown", handler, true);
  }, [onClose]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      // During IME composition the keys belong to the IME, not the picker.
      if (event.isComposing || event.keyCode === 229) return;
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
        event.preventDefault();
        event.stopPropagation();
        if (highlightedEntry) onPick(highlightedEntry);
        return;
      }
      // Route stray typing into the filter when the composer editor held on
      // to focus despite the input grab, so filtering works no matter who won
      // the focus race. Typing aimed anywhere else in the app stays theirs.
      if (event.target === inputRef.current) return;
      const fromComposerEditor =
        event.target instanceof HTMLElement &&
        event.target.closest("[data-chat-composer-form]") !== null;
      if (!fromComposerEditor) return;
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
      <div ref={menuRef} className="dropdown-glass relative w-full overflow-hidden rounded-[20px]">
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
          <SearchIcon className="size-3.5 shrink-0 text-icon-muted" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Insert which prompt?"
            aria-label="Filter saved prompts"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-secondary-label"
          />
        </div>
        <CommandList className="max-h-72">
          <CommandGroup>
            <CommandGroupLabel className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-secondary-label">
              <NotebookPenIcon className="size-3" aria-hidden="true" />
              Insert prompt
            </CommandGroupLabel>
            {entries.length === 0 ? (
              <p className="px-3 pb-3 pt-1 text-secondary-label text-xs">
                {query.trim().length > 0
                  ? "No saved prompts match."
                  : "No saved prompts yet. Add them in Settings → Prompts."}
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
                  <span className="min-w-0 shrink-0 truncate text-sm">{entry.title}</span>
                  <span className="min-w-0 flex-1 truncate text-secondary-label text-xs">
                    {savedPromptPreview(entry)}
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
