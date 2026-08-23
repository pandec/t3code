import type { SavedPrompt } from "@t3tools/contracts/settings";
import { ChevronDownIcon, PencilIcon, PlusIcon } from "lucide-react";
import React, { type FormEvent, useEffect, useId, useState } from "react";

import { useSavedPrompts } from "~/hooks/useSavedPrompts";
import { cn, randomUUID } from "~/lib/utils";
import { searchableSetting } from "./settingsSearch";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

interface SavedPromptInput {
  readonly title: string;
  readonly content: string;
}

/** What the editor dialog should open with. `promptId: null` means "add". */
interface SavedPromptEditorRequest {
  readonly promptId: string | null;
  readonly initial: SavedPromptInput;
}

export function PromptsSettings() {
  const { prompts, hasConnectedEnvironment, canEdit, saveAll } = useSavedPrompts();
  const [editorRequest, setEditorRequest] = useState<SavedPromptEditorRequest | null>(null);

  const submitPrompt = (promptId: string | null, input: SavedPromptInput) => {
    if (promptId === null) {
      saveAll((current) => [...current, { id: randomUUID(), ...input }]);
      return;
    }
    saveAll((current) =>
      current.map((prompt) => (prompt.id === promptId ? { ...prompt, ...input } : prompt)),
    );
  };
  const deletePrompt = (promptId: string) => {
    saveAll((current) => current.filter((prompt) => prompt.id !== promptId));
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("prompts")}
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={!canEdit}
            onClick={() =>
              setEditorRequest({ promptId: null, initial: { title: "", content: "" } })
            }
          >
            <PlusIcon className="size-3.5" />
            Add prompt
          </Button>
        }
      >
        <p className="px-3 text-pretty text-sm text-muted-foreground sm:px-4">
          Reusable prompts, synced to every connected environment that supports them. Type{" "}
          <code className="font-mono">/prompt</code> in the composer to insert one, or copy it from
          the command palette.
        </p>
        {hasConnectedEnvironment && !canEdit ? (
          <p className="px-3 pt-2 text-sm text-warning sm:px-4">
            No connected environment supports saved prompts, so the library is read-only right now.
          </p>
        ) : null}
        {prompts.length === 0 ? (
          <p className="px-3 py-2 text-base text-muted-foreground sm:px-4 sm:text-sm">
            No saved prompts yet.
          </p>
        ) : (
          prompts.map((prompt) => (
            <SavedPromptRow
              key={prompt.id}
              prompt={prompt}
              canEdit={canEdit}
              onEdit={() =>
                setEditorRequest({
                  promptId: prompt.id,
                  initial: { title: prompt.title, content: prompt.content },
                })
              }
            />
          ))
        )}
      </SettingsSection>
      <SavedPromptEditorDialog
        request={editorRequest}
        onSubmit={submitPrompt}
        onDelete={deletePrompt}
        onClose={() => setEditorRequest(null)}
      />
    </SettingsPageContainer>
  );
}

function promptPreview(prompt: SavedPrompt): string {
  return prompt.content.split("\n", 1)[0] ?? "";
}

/**
 * Compact saved-prompt row (title + first-line preview), expandable in place
 * to the full content even while the library is read-only. Exported for tests.
 */
export function SavedPromptRow({
  prompt,
  canEdit,
  onEdit,
}: {
  prompt: SavedPrompt;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const contentId = useId();
  return (
    <div className="group rounded-xl px-3 py-2 sm:px-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
        <h3 className="flex min-h-5 min-w-0 flex-1 items-baseline gap-2 text-sm font-medium tracking-[-0.005em] text-foreground">
          <span className="max-w-60 shrink-0 truncate">{prompt.title}</span>
          <span className="min-w-0 flex-1 truncate font-normal text-muted-foreground">
            {promptPreview(prompt)}
          </span>
        </h3>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon-xs"
            variant="ghost-muted"
            className="shrink-0"
            aria-controls={contentId}
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? "Collapse" : "Expand"} ${prompt.title}`}
            onClick={() => setIsExpanded((open) => !open)}
          >
            <ChevronDownIcon
              className={cn("size-3.5 transition-transform", isExpanded && "rotate-180")}
            />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            className="shrink-0 text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
            aria-label={`Edit ${prompt.title}`}
            disabled={!canEdit}
            onClick={onEdit}
          >
            <PencilIcon className="size-3.5" />
          </Button>
        </div>
      </div>
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <CollapsibleContent id={contentId} keepMounted>
          <p className="pt-1.5 pb-1 text-[13px] leading-[1.45] break-words whitespace-pre-wrap text-muted-foreground">
            {prompt.content}
          </p>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/**
 * Add/edit dialog for a saved prompt. The parent owns which prompt (if any)
 * is being edited via `request`; the dialog owns form state and validation.
 */
function SavedPromptEditorDialog({
  request,
  onSubmit,
  onDelete,
  onClose,
}: {
  request: SavedPromptEditorRequest | null;
  onSubmit: (promptId: string | null, input: SavedPromptInput) => void;
  onDelete: (promptId: string) => void;
  onClose: () => void;
}) {
  const formId = React.useId();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const isOpen = request !== null;
  const isEditing = request?.promptId != null;

  // Hydrate the form whenever a new request opens the dialog.
  useEffect(() => {
    if (!request) return;
    setTitle(request.initial.title);
    setContent(request.initial.content);
    setValidationError(null);
  }, [request]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!request) return;
    const trimmedTitle = title.trim();
    const trimmedContent = content.trim();
    if (trimmedTitle.length === 0) {
      setValidationError("Title is required.");
      return;
    }
    if (trimmedContent.length === 0) {
      setValidationError("Content is required.");
      return;
    }
    setValidationError(null);
    onSubmit(request.promptId, { title: trimmedTitle, content: trimmedContent });
    onClose();
  };

  return (
    <>
      <Dialog
        open={isOpen}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{isEditing ? "Edit Prompt" : "Add Prompt"}</DialogTitle>
            <DialogDescription>
              Saved prompts can be inserted into the composer without sending.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form id={formId} className="space-y-4" onSubmit={submit}>
              <div className="space-y-1.5">
                <Label htmlFor="saved-prompt-title">Title</Label>
                <Input
                  id="saved-prompt-title"
                  autoFocus
                  placeholder="Review checklist"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="saved-prompt-content">Content</Label>
                <Textarea
                  id="saved-prompt-content"
                  className="min-h-40"
                  placeholder="Review the change for…"
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                />
              </div>
              {validationError && <p className="text-sm text-destructive">{validationError}</p>}
            </form>
          </DialogPanel>
          <DialogFooter className="dark:border-transparent dark:bg-transparent">
            {isEditing && (
              <Button
                type="button"
                variant="destructive-outline"
                className="mr-auto"
                onClick={() => setDeleteConfirmOpen(true)}
              >
                Delete
              </Button>
            )}
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button form={formId} type="submit">
              {isEditing ? "Save changes" : "Save prompt"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete prompt "{title}"?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (!request?.promptId) return;
                setDeleteConfirmOpen(false);
                onClose();
                onDelete(request.promptId);
              }}
            >
              Delete prompt
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
