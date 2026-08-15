import type { SavedPrompt } from "@t3tools/contracts/settings";
import { NotebookPenIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { cn } from "~/lib/utils";
import { CommandItem } from "../ui/command";
import {
  ComposerPickerShell,
  useComposerPickerKeyboard,
  useComposerPickerQuery,
} from "./composerPickerMenu";
import { buildSavedPromptPickerEntries, savedPromptPreview } from "./composerPromptPicker";

/** Popover picking the saved prompt a `/prompt` insertion should use. */
export const ComposerPromptMenu = memo(function ComposerPromptMenu(props: {
  prompts: ReadonlyArray<SavedPrompt>;
  onPick: (prompt: SavedPrompt) => void;
  onClose: () => void;
}) {
  const { prompts, onPick, onClose } = props;
  const { query, setQuery } = useComposerPickerQuery();
  const entries = useMemo(
    () => buildSavedPromptPickerEntries({ prompts, query }),
    [prompts, query],
  );
  const picker = useComposerPickerKeyboard({ entries, onPick, onClose, setQuery });

  return (
    <ComposerPickerShell
      menuRef={picker.menuRef}
      inputRef={picker.inputRef}
      query={query}
      onQueryChange={setQuery}
      placeholder="Insert which prompt?"
      inputAriaLabel="Filter saved prompts"
      groupIcon={<NotebookPenIcon className="size-3" aria-hidden="true" />}
      groupLabel="Insert prompt"
      emptyState={
        entries.length === 0 ? (
          <p className="px-3 pb-3 pt-1 text-secondary-label text-xs">
            {query.trim().length > 0
              ? "No saved prompts match."
              : "No saved prompts yet. Add them in Settings → Prompts."}
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
          <span className="max-w-60 shrink-0 truncate text-sm">{entry.title}</span>
          <span className="min-w-0 flex-1 truncate text-secondary-label text-xs">
            {savedPromptPreview(entry)}
          </span>
        </CommandItem>
      ))}
    </ComposerPickerShell>
  );
});
