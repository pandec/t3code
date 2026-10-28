import {
  type EnvironmentId,
  LAB_DEFAULT_BASE_REF,
  type LabEnvironment,
  type LabKind,
  resolveLabKind,
} from "@t3tools/contracts";
import { FlaskConicalIcon } from "lucide-react";
import { memo, useId, useState } from "react";

import { cn } from "~/lib/utils";
import type { DraftLabIntent } from "../../composerDraftStore";
import { useLabsSnapshot } from "../../state/labs";
import { ComposerContextLabel } from "../ComposerContextLabel";
import { ComposerControl } from "../chat/ComposerControl";
import { useComposerMenuProps } from "../chat/composerEventScope";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "../chat/threadDetailsPanelStyles";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Radio, RadioGroup } from "../ui/radio-group";
import { LabAvailabilityBadge, LabOwnerLink, LiteLabBadge, useLabOwnerThread } from "./LabParts";
import { resolveDraftLabKind, resolveLabAvailability } from "./labs.logic";

/** Radio values for "First free full/lite lab"; lab ids never take this form. */
const AUTO_LAB_VALUES: Record<LabKind, string> = { full: "auto:full", lite: "auto:lite" };

function intentLabel(intent: DraftLabIntent): string {
  const lab = intent.labId ?? `First free ${resolveDraftLabKind(intent)}`;
  const name = intent.branchName.trim();
  if (intent.branchMode === "continue") return `${lab} · ${name || "choose branch"}`;
  return `${lab} · ${name || "new branch"} from ${intent.baseRef.trim() || LAB_DEFAULT_BASE_REF}`;
}

/** The branch a lab was last left on: its standing handoff, else its checkout. */
function lastLabBranch(environment: LabEnvironment | undefined): string | null {
  const branch = environment?.handoff?.branch ?? environment?.runtime.git?.branch ?? null;
  return branch && branch !== "Detached HEAD" && branch !== "master" ? branch : null;
}

/**
 * Fork (SP Labs): Lab mode's lab and branch choice, standing in for the branch selector. Nothing
 * is reserved here; the first send reserves the lab and prepares the branch.
 */
export const LabWorkspacePicker = memo(function LabWorkspacePicker({
  environmentId,
  intent,
  onIntentChange,
  displayMode = "toolbar",
  className,
}: {
  readonly environmentId: EnvironmentId;
  readonly intent: DraftLabIntent;
  readonly onIntentChange: (next: DraftLabIntent) => void;
  readonly displayMode?: "toolbar" | "panel";
  readonly className?: string;
}) {
  const composerMenuProps = useComposerMenuProps();
  const snapshot = useLabsSnapshot(environmentId);
  const labs = (snapshot.data?.environments ?? []).filter(
    (environment) => environment.kind === "lab",
  );
  const selected = labs.find((environment) => environment.id === intent.labId);
  const suggestedBranch = lastLabBranch(selected);
  const fieldId = useId();
  const update = (patch: Partial<DraftLabIntent>) => onIntentChange({ ...intent, ...patch });
  const isPanel = displayMode === "panel";
  const label = intentLabel(intent);
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          isPanel ? (
            <ThreadDetailsControl part="row" aria-label="Lab and branch" />
          ) : (
            <ComposerControl
              size="xs"
              aria-label="Lab and branch"
              className={cn("min-w-0", className)}
              data-composer-context-control
            />
          )
        }
      >
        <FlaskConicalIcon className={isPanel ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3"} />
        {isPanel ? (
          <span className="min-w-0 truncate">{label}</span>
        ) : (
          <ComposerContextLabel>{label}</ComposerContextLabel>
        )}
      </PopoverTrigger>
      <PopoverPopup
        side={isPanel ? "bottom" : "top"}
        align={isPanel ? "start" : "end"}
        width="md"
        padding="compact"
        {...(isPanel ? {} : composerMenuProps)}
      >
        <div className="flex flex-col gap-3 text-xs">
          <section className="flex flex-col gap-1.5">
            <h3 className="font-medium text-muted-foreground">Lab</h3>
            {snapshot.error && labs.length === 0 ? (
              <p className="text-destructive-foreground">{snapshot.error}</p>
            ) : null}
            <RadioGroup
              value={intent.labId ?? AUTO_LAB_VALUES[resolveDraftLabKind(intent)]}
              onValueChange={(value) =>
                update(
                  value === AUTO_LAB_VALUES.full || value === AUTO_LAB_VALUES.lite
                    ? { labId: null, labKind: value === AUTO_LAB_VALUES.full ? "full" : "lite" }
                    : { labId: String(value) },
                )
              }
            >
              {(["lite", "full"] as const).map((kind) => (
                <label key={kind} className="flex cursor-pointer items-center gap-2 py-0.5">
                  <Radio value={AUTO_LAB_VALUES[kind]} />
                  <span>First free {kind} lab</span>
                </label>
              ))}
              {labs.map((environment) => {
                const availability = resolveLabAvailability(environment);
                return (
                  <label
                    key={environment.id}
                    className={cn(
                      "flex cursor-pointer items-start gap-2 py-0.5",
                      availability !== "free" && "opacity-70",
                    )}
                  >
                    <Radio value={environment.id} disabled={availability !== "free"} />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-1.5">
                        <span className="font-medium">{environment.name}</span>
                        {resolveLabKind(environment) === "lite" ? <LiteLabBadge /> : null}
                        <LabAvailabilityBadge availability={availability} />
                      </span>
                      <LabPickerDetail
                        environmentId={environmentId}
                        environment={environment}
                        onOpenOwner={() => setOpen(false)}
                      />
                    </span>
                  </label>
                );
              })}
              {!snapshot.data && !snapshot.error ? (
                <p className="text-muted-foreground">Loading labs…</p>
              ) : null}
            </RadioGroup>
          </section>
          <section className="flex flex-col gap-1.5">
            <h3 className="font-medium text-muted-foreground">Branch</h3>
            <RadioGroup
              value={intent.branchMode}
              onValueChange={(value) =>
                update({ branchMode: value === "continue" ? "continue" : "create" })
              }
            >
              <label className="flex cursor-pointer items-center gap-2 py-0.5">
                <Radio value="create" />
                New branch
              </label>
              <label className="flex cursor-pointer items-center gap-2 py-0.5">
                <Radio value="continue" />
                Continue an existing branch
              </label>
            </RadioGroup>
            <div className="flex flex-col gap-1.5">
              <Input
                id={`${fieldId}-branch`}
                size="sm"
                aria-label={intent.branchMode === "create" ? "New branch name" : "Branch"}
                placeholder={
                  intent.branchMode === "create"
                    ? "Name it, or leave empty to name it from the task"
                    : "Branch to check out"
                }
                spellCheck={false}
                autoComplete="off"
                value={intent.branchName}
                onChange={(event) => update({ branchName: event.target.value })}
              />
              {intent.branchMode === "create" ? (
                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-muted-foreground">from</span>
                  <Input
                    size="sm"
                    aria-label="Base branch"
                    placeholder={LAB_DEFAULT_BASE_REF}
                    spellCheck={false}
                    autoComplete="off"
                    value={intent.baseRef}
                    onChange={(event) => update({ baseRef: event.target.value })}
                  />
                </div>
              ) : null}
              {suggestedBranch && suggestedBranch !== intent.branchName.trim() ? (
                <Button
                  size="xs"
                  variant="ghost-muted"
                  className="self-start"
                  onClick={() => update({ branchMode: "continue", branchName: suggestedBranch })}
                >
                  Continue {selected?.name}'s last branch: {suggestedBranch}
                </Button>
              ) : null}
            </div>
          </section>
        </div>
      </PopoverPopup>
    </Popover>
  );
});

/** Free labs need no explanation; a reservation names its owner, a hold its note. */
function LabPickerDetail({
  environmentId,
  environment,
  onOpenOwner,
}: {
  readonly environmentId: EnvironmentId;
  readonly environment: LabEnvironment;
  readonly onOpenOwner: () => void;
}) {
  const ownerThreadId = environment.lease?.threadId ?? null;
  const owner = useLabOwnerThread(environmentId, ownerThreadId);
  if (environment.lease) {
    return owner && ownerThreadId ? (
      <span className="min-w-0 truncate">
        <LabOwnerLink
          environmentId={environmentId}
          threadId={ownerThreadId}
          title={owner.title}
          onOpen={onOpenOwner}
        />
      </span>
    ) : (
      <span className="text-muted-foreground">Reserved outside T3</span>
    );
  }
  if (environment.hold) {
    return (
      <span className="truncate text-muted-foreground">
        {environment.hold.note ? `“${environment.hold.note}”` : "Held for you"}
      </span>
    );
  }
  return null;
}
