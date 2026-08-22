import { SearchIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";

import { Command, CommandGroup, CommandGroupLabel, CommandList } from "../ui/command";
import { useThreadPaneId } from "../thread-split/threadPaneContext";
import { isThreadPaneActive } from "../thread-split/threadSplitStore";

/** Filter-query state for a composer picker; feed the filtered entries into
    `useComposerPickerKeyboard` below. */
export function useComposerPickerQuery(): {
  readonly query: string;
  readonly setQuery: Dispatch<SetStateAction<string>>;
} {
  const [query, setQuery] = useState("");
  return { query, setQuery };
}

/**
 * Shared interaction contract for the composer's slash-command pickers
 * (`/t3-wait`, `/prompt`): arrows to navigate, Enter to pick, Escape to
 * dismiss, capture-phase on window so it wins over the editor. Typing goes
 * to the picker's own filter input, which holds focus while open.
 */
export function useComposerPickerKeyboard<T extends { readonly id: string }>(input: {
  /** The entries currently displayed, i.e. already filtered by the query. */
  readonly entries: ReadonlyArray<T>;
  readonly onPick: (entry: T) => void;
  readonly onClose: () => void;
  readonly setQuery: Dispatch<SetStateAction<string>>;
}): {
  readonly highlightedEntry: T | undefined;
  readonly highlightedId: string | null;
  readonly setHighlightedId: (id: string | null) => void;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly menuRef: RefObject<HTMLDivElement | null>;
} {
  const { entries, onPick, onClose, setQuery } = input;
  const threadPaneId = useThreadPaneId();
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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
      // Split view: only the active pane's picker owns the window keys.
      if (!isThreadPaneActive(threadPaneId)) return;
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
  }, [entries, highlightedEntry, highlightedId, onClose, onPick, setQuery, threadPaneId]);

  return { highlightedEntry, highlightedId, setHighlightedId, inputRef, menuRef };
}

/** Shared chrome for a composer picker: filter input, group label, list. */
export function ComposerPickerShell(props: {
  readonly menuRef: RefObject<HTMLDivElement | null>;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly placeholder: string;
  readonly inputAriaLabel: string;
  readonly groupIcon: ReactNode;
  readonly groupLabel: string;
  readonly emptyState: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Command autoHighlight={false} mode="none">
      <div
        ref={props.menuRef}
        className="dropdown-glass relative w-full overflow-hidden rounded-[20px]"
      >
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
          <SearchIcon className="size-3.5 shrink-0 text-icon-muted" aria-hidden="true" />
          <input
            ref={props.inputRef}
            value={props.query}
            onChange={(event) => props.onQueryChange(event.target.value)}
            placeholder={props.placeholder}
            aria-label={props.inputAriaLabel}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-secondary-label"
          />
        </div>
        <CommandList className="max-h-72">
          <CommandGroup>
            <CommandGroupLabel className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-secondary-label">
              {props.groupIcon}
              {props.groupLabel}
            </CommandGroupLabel>
            {props.emptyState ?? props.children}
          </CommandGroup>
        </CommandList>
      </div>
    </Command>
  );
}
