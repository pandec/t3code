import {
  resolveLabKind,
  type EnvironmentId,
  type LabEnvironment,
  type LabHistoryItem,
  type LabRecentLease,
  type LabT3State,
  type LabsSnapshot,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { ChevronLeftIcon, FlaskConicalIcon } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { labsEnvironment, useLabsSnapshot } from "../../state/labs";
import { useEnvironmentQuery } from "../../state/query";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  isLabBusy,
  LabActionBar,
  LabReleaseButton,
  useLabCommands,
  type LabCommands,
} from "./LabActions";
import {
  LabOwnerLink,
  LabSummarySentence,
  LiteLabBadge,
  useLabOwnerView,
  useLabOwnerViews,
} from "./LabParts";
import {
  countFreeLabs,
  formatLabAgo,
  isLabHeldByArchivedThread,
  labOperationLabel,
  orderLabEnvironments,
  resolveLabBranch,
  resolveLabChecks,
  summarizeLabEnvironment,
  summarizeLabsAttention,
  type LabCheck,
  type LabCheckState,
  type LabOwnerView,
  type LabSummaryTone,
} from "./labs.logic";
import { useLabsPanelStore, useSelectedLab } from "./labsPanelStore";

/** Hover deepens the row's own tint instead of greying it out. */
const ROW_TINT: Record<LabSummaryTone, string> = {
  free: "bg-success/6 hover:bg-success/12",
  reserved: "bg-info/8 hover:bg-info/16",
  attention: "bg-warning/8 hover:bg-warning/16",
  bad: "bg-destructive/8 hover:bg-destructive/16",
  kept: "bg-muted/60 hover:bg-muted",
  shared: "bg-muted/40 hover:bg-muted/80",
};

const WORD_COLOR: Record<LabSummaryTone, string> = {
  free: "text-success-foreground",
  reserved: "text-info-foreground",
  attention: "text-warning-foreground",
  bad: "text-destructive-foreground",
  kept: "text-warning-foreground",
  shared: "text-muted-foreground",
};

const CHECK_MARK: Record<LabCheckState, string> = {
  ok: "bg-success",
  bad: "bg-destructive",
  off: "border border-muted-foreground/60",
  unknown: "border border-muted-foreground/30",
  na: "border border-muted-foreground/20",
};

const CHECK_BADGE: Record<LabCheckState, "success" | "error" | "outline"> = {
  ok: "success",
  bad: "error",
  off: "outline",
  unknown: "outline",
  na: "outline",
};

/**
 * Fork (SP Labs): the labs overview that replaces the sp-labs dashboard: a list, and a lab's
 * detail on click. It subscribes to the live snapshot only while `visible`.
 */
export function LabsPanel({
  threadRef,
  visible,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly visible: boolean;
}) {
  if (!visible) return null;
  return <VisibleLabsPanel threadRef={threadRef} />;
}

function VisibleLabsPanel({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const environmentId = threadRef.environmentId;
  const snapshot = useLabsSnapshot(environmentId);
  const commands = useLabCommands(environmentId);
  const selectedId = useSelectedLab(threadRef);
  const select = (labId: string | null) => useLabsPanelStore.getState().select(threadRef, labId);
  const data = snapshot.data;
  const owners = useLabOwnerViews(
    environmentId,
    (data?.environments ?? []).map((environment) => environment.lease?.threadId ?? null),
  );

  if (data && !data.configured) {
    return (
      <PanelMessage title="SP Labs is not set up">
        Set the sp-labs directory in Settings → Extras → SP Labs.
      </PanelMessage>
    );
  }
  if (!data) {
    return snapshot.error ? (
      <PanelMessage title="Labs unavailable">{snapshot.error}</PanelMessage>
    ) : (
      <PanelMessage title="Loading labs…" />
    );
  }
  // Ages are measured at the snapshot's arrival: it is pushed at least every poll, so they stay
  // current without a ticking timer.
  const now = snapshot.dataUpdatedAt;
  // The labs project, where "New thread" stages a draft; never the sp-labs project the panel may
  // be open in, which has no Lab mode.
  const labsProjectId = data.projectId;
  const selected = data.environments.find((environment) => environment.id === selectedId);
  if (selected) {
    return (
      <LabDetail
        environmentId={environmentId}
        projectId={labsProjectId}
        environment={selected}
        t3={data.t3[selected.id]}
        commands={commands}
        now={now}
        onBack={() => select(null)}
      />
    );
  }
  return (
    <LabList
      environmentId={environmentId}
      data={data}
      owners={owners}
      commands={commands}
      now={now}
      onOpen={(id) => select(id)}
    />
  );
}

function PanelMessage({
  title,
  children,
}: {
  readonly title: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <FlaskConicalIcon aria-hidden className="size-6 text-muted-foreground/60" />
      <p className="font-medium text-sm">{title}</p>
      {children ? <p className="max-w-64 text-muted-foreground text-xs">{children}</p> : null}
    </div>
  );
}

// ── List ─────────────────────────────────────────────────────────────────

type OwnerViews = ReadonlyMap<string, LabOwnerView>;

const ownerOf = (owners: OwnerViews, environment: LabEnvironment) =>
  (environment.lease?.threadId ? owners.get(environment.lease.threadId) : undefined) ?? null;

function LabList({
  environmentId,
  data,
  owners,
  commands,
  now,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly data: LabsSnapshot;
  readonly owners: OwnerViews;
  readonly commands: LabCommands;
  readonly now: number;
  readonly onOpen: (labId: string) => void;
}) {
  const { groups, shared } = orderLabEnvironments(data.environments);
  const summarized = groups.map((group) => ({
    ...group,
    labs: group.labs.map((environment) => ({
      environment,
      name: environment.name,
      summary: summarizeLabEnvironment(environment, ownerOf(owners, environment), now),
    })),
  }));
  const attention = summarizeLabsAttention(summarized.flatMap((group) => group.labs));
  return (
    <ScrollArea className="h-full min-h-0">
      {/* Centered while shorter than the panel; scrolls normally once taller. */}
      <div className="flex min-h-full flex-col justify-center gap-1 px-2 py-4">
        {attention || data.error ? (
          <div className="flex flex-col gap-1 px-1 pb-3">
            {attention ? (
              <p className="font-medium text-base text-warning-foreground leading-snug">
                {attention}
              </p>
            ) : null}
            {data.error ? (
              <p className="text-destructive-foreground text-xs">{data.error}</p>
            ) : null}
          </div>
        ) : null}
        {summarized.map((group, position) => (
          <section key={group.kind} className="flex flex-col gap-1">
            <h3
              className={cn(
                "px-1 pb-1 font-medium text-muted-foreground text-xs",
                position > 0 && "pt-6",
              )}
            >
              {groups.length > 1 ? (group.kind === "lite" ? "Lite labs" : "Full labs") : "Labs"}
              {" · "}
              {countFreeLabs(group.labs.map((lab) => lab.summary))}
            </h3>
            {group.labs.map(({ environment }) => (
              <LabListRow
                key={environment.id}
                environmentId={environmentId}
                environment={environment}
                owner={ownerOf(owners, environment)}
                t3={data.t3[environment.id]}
                commands={commands}
                now={now}
                onOpen={onOpen}
              />
            ))}
          </section>
        ))}
        {shared.length > 0 ? (
          <h3 className="px-1 pt-6 pb-1 font-medium text-muted-foreground text-xs">
            Shared checkouts
          </h3>
        ) : null}
        {shared.map((environment) => (
          <LabListRow
            key={environment.id}
            environmentId={environmentId}
            environment={environment}
            owner={ownerOf(owners, environment)}
            t3={data.t3[environment.id]}
            commands={commands}
            now={now}
            onOpen={onOpen}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

function LabCheckMarks({ environment }: { readonly environment: LabEnvironment }) {
  return (
    <span className="inline-flex items-center gap-2 text-3xs text-muted-foreground">
      {resolveLabChecks(environment).map((check) => (
        <Tooltip key={check.short}>
          <TooltipTrigger render={<span className="inline-flex items-center gap-1" />}>
            <span aria-hidden className={cn("size-1.5 rounded-full", CHECK_MARK[check.state])} />
            {check.short}
          </TooltipTrigger>
          <TooltipPopup>
            {check.label}: {check.word}
            {check.detail ? `. ${check.detail}` : ""}
          </TooltipPopup>
        </Tooltip>
      ))}
    </span>
  );
}

function labSubtitle(environment: LabEnvironment): string {
  if (environment.kind === "lab") {
    return `ports ${environment.cdpPort}${environment.wxtPort === null ? "" : ` / ${environment.wxtPort}`}`;
  }
  return environment.kind === "staging" ? "main checkout" : "compiled preview";
}

function LabListRow({
  environmentId,
  environment,
  owner,
  t3,
  commands,
  now,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly environment: LabEnvironment;
  readonly owner: LabOwnerView | null;
  readonly t3: LabT3State | undefined;
  readonly commands: LabCommands;
  readonly now: number;
  readonly onOpen: (labId: string) => void;
}) {
  const ownerThreadId = environment.lease?.threadId ?? null;
  const summary = summarizeLabEnvironment(environment, owner, now);
  const branch = resolveLabBranch(environment);
  const open = () => onOpen(environment.id);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${environment.name}: ${summary.word}`}
      onClick={open}
      onKeyDown={onKeyDown}
      className={cn(
        "grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 rounded-lg px-3 py-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        ROW_TINT[summary.tone],
      )}
    >
      <div className="flex min-w-16 flex-col">
        <span className="font-medium text-sm">{environment.name}</span>
        <span className="text-3xs text-muted-foreground">{labSubtitle(environment)}</span>
        {environment.lender ? (
          <span className="text-3xs text-muted-foreground">borrows {environment.lender}</span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className={cn("font-medium text-sm", WORD_COLOR[summary.tone])}>
            {summary.word}
          </span>
          <LabCheckMarks environment={environment} />
        </div>
        <p className="leading-snug">
          <LabSummarySentence
            environmentId={environmentId}
            threadId={ownerThreadId}
            segments={summary.sentence}
          />
        </p>
        {summary.note ? <p className="truncate text-muted-foreground">{summary.note}</p> : null}
      </div>
      <div className="flex min-w-0 max-w-40 flex-col items-end text-right">
        <Tooltip>
          <TooltipTrigger render={<code className="max-w-full truncate font-mono text-3xs" />}>
            {branch.name}
            {branch.dirty ? " ±" : ""}
          </TooltipTrigger>
          <TooltipPopup>
            {branch.fromHandoff ? "Branch at last handoff; HEAD is detached" : "Checked-out branch"}
            {branch.dirty ? ", with uncommitted changes" : ""}
          </TooltipPopup>
        </Tooltip>
        {summary.since ? (
          <span className="text-muted-foreground">{formatLabAgo(summary.since, now)}</span>
        ) : null}
        {isLabHeldByArchivedThread(environment, owner) ? (
          // Its own control inside the clickable row: a click never opens the detail, and the
          // row's key handler already ignores keys from nested controls.
          <span className="mt-1.5" onClick={(event) => event.stopPropagation()}>
            <LabReleaseButton
              environment={environment}
              commands={commands}
              disabled={isLabBusy(commands, t3)}
              emphasized
            />
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="font-medium text-muted-foreground text-xs">{title}</h3>
      {children}
    </section>
  );
}

function LabDetail({
  environmentId,
  projectId,
  environment,
  t3,
  commands,
  now,
  onBack,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly environment: LabEnvironment;
  readonly t3: LabT3State | undefined;
  readonly commands: LabCommands;
  readonly now: number;
  readonly onBack: () => void;
}) {
  const lease = environment.lease;
  const owner = useLabOwnerView(environmentId, lease?.threadId ?? null);
  const summary = summarizeLabEnvironment(environment, owner, now);
  const isLab = environment.kind === "lab";
  const { runtime } = environment;
  return (
    <ScrollArea className="h-full min-h-0">
      <div className="flex flex-col gap-4 px-3 py-3 text-xs">
        <div className="flex flex-col items-start gap-2">
          <Button size="xs" variant="ghost-muted" onClick={onBack}>
            <ChevronLeftIcon />
            All labs
          </Button>
          <div className="flex flex-col gap-1">
            <h2 className="flex items-center gap-2 font-semibold text-lg leading-tight">
              {environment.name}
              {resolveLabKind(environment) === "lite" ? <LiteLabBadge /> : null}
            </h2>
            {environment.lender ? (
              <p className="text-muted-foreground">
                Borrows {environment.lender}'s WorkOS environment and personas.
              </p>
            ) : null}
            <p className="text-sm leading-snug">
              <span className={cn("font-medium", WORD_COLOR[summary.tone])}>{summary.word}</span>
              {". "}
              <LabSummarySentence
                environmentId={environmentId}
                threadId={lease?.threadId ?? null}
                segments={summary.sentence}
              />
            </p>
          </div>
        </div>

        {isLab ? (
          <Section title="Actions">
            <LabActionBar
              environmentId={environmentId}
              projectId={projectId}
              environment={environment}
              t3={t3}
              commands={commands}
              emphasizeRelease={isLabHeldByArchivedThread(environment, owner)}
            />
            {t3?.operation ? (
              <p className="text-info-foreground">{labOperationLabel(t3.operation)}…</p>
            ) : null}
            {t3?.lastUp ? (
              <p className={t3.lastUp.ok ? "text-muted-foreground" : "text-destructive-foreground"}>
                Last start {formatLabAgo(t3.lastUp.at, now)}:{" "}
                {t3.lastUp.ok ? "ok." : (t3.lastUp.detail ?? "failed.")}
              </p>
            ) : null}
          </Section>
        ) : null}

        {isLab ? (
          <Section title="Reservation">
            {lease ? (
              <div className="flex flex-col gap-1">
                <p>
                  {owner && lease.threadId ? (
                    <LabOwnerLink
                      environmentId={environmentId}
                      threadId={lease.threadId}
                      title={owner.title}
                    />
                  ) : (
                    <span className="text-muted-foreground">
                      {lease.threadId ? "Owner thread is not in T3" : "Reserved outside T3"}
                    </span>
                  )}
                  {owner ? (
                    <span className="text-muted-foreground">
                      {" · "}
                      {owner.archived
                        ? "archived"
                        : owner.needsYou
                          ? "waiting for you"
                          : owner.working
                            ? "working now"
                            : `last activity ${formatLabAgo(owner.lastActivityAt, now)}`}
                    </span>
                  ) : null}
                </p>
                {lease.purpose ? <p className="whitespace-pre-wrap">{lease.purpose}</p> : null}
                <p className="text-muted-foreground">taken {formatLabAgo(lease.acquiredAt, now)}</p>
              </div>
            ) : environment.hold ? (
              <p>
                Held for you {formatLabAgo(environment.hold.heldAt, now)}
                {environment.hold.note ? `: “${environment.hold.note}”` : "."}
              </p>
            ) : (
              <p className="text-muted-foreground">Nobody holds this lab.</p>
            )}
          </Section>
        ) : null}

        {isLab && environment.recentLeases.length > 0 ? (
          <LabRecentHolders
            environmentId={environmentId}
            leases={environment.recentLeases}
            now={now}
          />
        ) : null}

        {isLab ? (
          <Section title="Last handoff">
            {environment.handoff ? (
              <div className="flex flex-col gap-1.5 border-s-2 ps-3">
                <p className="whitespace-pre-wrap leading-snug">{environment.handoff.summary}</p>
                <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                  <span>{formatLabAgo(environment.handoff.releasedAt, now)}</span>
                  <Badge
                    size="sm"
                    variant={environment.handoff.disposition === "usable" ? "success" : "error"}
                  >
                    {environment.handoff.disposition === "usable" ? "usable" : "needs repair"}
                  </Badge>
                  <code className="font-mono text-3xs">
                    {environment.handoff.branch}@{environment.handoff.commit.slice(0, 8)}
                  </code>
                </div>
              </div>
            ) : (
              <p className="text-muted-foreground">No handoff recorded.</p>
            )}
          </Section>
        ) : null}

        <Section title={`Runtime, checked ${formatLabAgo(runtime.checkedAt, now)}`}>
          <div className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5">
            {resolveLabChecks(environment).map((check) => (
              <RuntimeCheckRow key={check.short} check={check} />
            ))}
          </div>
          {runtime.operation ? (
            <p className="text-warning-foreground">
              {runtime.operation.command} is running ({runtime.operation.status}), started{" "}
              {formatLabAgo(runtime.operation.startedAt, now)}.
            </p>
          ) : null}
          {runtime.diagnosis.length > 0 ? (
            <ul className="list-disc ps-4 text-warning-foreground">
              {runtime.diagnosis.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </Section>

        <Section title="Checkout">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Branch</dt>
            <dd className="flex flex-wrap items-center gap-1.5">
              {runtime.git ? (
                <>
                  <code className="font-mono text-3xs">
                    {runtime.git.branch === "Detached HEAD" ? "detached" : runtime.git.branch}@
                    {runtime.git.commit.slice(0, 8)}
                  </code>
                  <Badge size="sm" variant={runtime.git.dirty ? "warning" : "success"}>
                    {runtime.git.dirty ? "uncommitted changes" : "clean"}
                  </Badge>
                </>
              ) : (
                <span className="text-muted-foreground">git not readable</span>
              )}
            </dd>
            <dt className="text-muted-foreground">Worktree</dt>
            <dd className="break-all font-mono text-3xs">{environment.worktree}</dd>
            <dt className="text-muted-foreground">Ports</dt>
            <dd>
              Chrome {environment.cdpPort}
              {environment.wxtPort === null ? "" : ` · WXT ${environment.wxtPort}`}
            </dd>
          </dl>
        </Section>

        <LabHistory environmentId={environmentId} envId={environment.id} />
        <LabOutput environmentId={environmentId} envId={environment.id} />
      </div>
    </ScrollArea>
  );
}

function RuntimeCheckRow({ check }: { readonly check: LabCheck }) {
  return (
    <>
      <span className="text-muted-foreground">{check.label}</span>
      <Badge size="sm" variant={CHECK_BADGE[check.state]}>
        {check.word}
      </Badge>
      <span className="text-muted-foreground">{check.detail}</span>
    </>
  );
}

function clockTime(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time)
    ? new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
    : "";
}

function dayLabel(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

function historyLine(item: LabHistoryItem): { title: string; detail: string | null } {
  switch (item.kind) {
    case "command":
      return {
        title: `${item.command ?? "command"}${item.status ? ` · ${item.status}` : ""}`,
        detail: null,
      };
    case "handoff":
      return {
        title: `Handed off · ${item.status === "usable" ? "usable" : "needs repair"}${
          item.branch ? ` · ${item.branch}@${(item.commit ?? "").slice(0, 8)}` : ""
        }`,
        detail: item.summary,
      };
    case "reservation":
      return {
        title: `Reserved · ${item.finishedAt ? "released" : "still open"}`,
        detail: item.purpose,
      };
  }
}

/** The lab's last released reservations, newest first, linked to their threads when T3 knows them. */
function LabRecentHolders({
  environmentId,
  leases,
  now,
}: {
  readonly environmentId: EnvironmentId;
  readonly leases: ReadonlyArray<LabRecentLease>;
  readonly now: number;
}) {
  return (
    <Section title="Recent holders">
      <ol className="flex flex-col gap-1.5">
        {leases.map((lease) => (
          <LabRecentHolder
            key={`${lease.acquiredAt}:${lease.releasedAt}`}
            environmentId={environmentId}
            lease={lease}
            now={now}
          />
        ))}
      </ol>
    </Section>
  );
}

// One row per holder so each owner goes through `useLabOwnerView`, which loads an omitted family.
function LabRecentHolder({
  environmentId,
  lease,
  now,
}: {
  readonly environmentId: EnvironmentId;
  readonly lease: LabRecentLease;
  readonly now: number;
}) {
  const owner = useLabOwnerView(environmentId, lease.threadId);
  return (
    <li className="flex flex-col">
      <p className="min-w-0">
        {owner && lease.threadId ? (
          <LabOwnerLink
            environmentId={environmentId}
            threadId={lease.threadId}
            title={owner.title}
          />
        ) : (
          <span className="text-muted-foreground">
            {lease.threadId ? "Thread not in T3" : "Outside T3"}
          </span>
        )}
        <span className="text-muted-foreground">
          {" · released "}
          {formatLabAgo(lease.releasedAt, now)}
        </span>
      </p>
      {lease.purpose ? <p className="truncate text-muted-foreground">{lease.purpose}</p> : null}
    </li>
  );
}

/** The lab's timeline, fetched when its detail opens. */
function LabHistory({
  environmentId,
  envId,
}: {
  readonly environmentId: EnvironmentId;
  readonly envId: string;
}) {
  const history = useEnvironmentQuery(
    labsEnvironment.history({ environmentId, input: { envId, limit: 30 } }),
  );
  // Each item carries the day heading it starts, if any.
  const items = (history.data?.items ?? []).map((item, position, all) => {
    const day = dayLabel(item.timestamp);
    const previous = all[position - 1];
    return { item, day: previous && dayLabel(previous.timestamp) === day ? null : day };
  });
  return (
    <Section title="History">
      {history.error ? <p className="text-destructive-foreground">{history.error}</p> : null}
      {!history.data && !history.error ? <p className="text-muted-foreground">Loading…</p> : null}
      {history.data && items.length === 0 ? (
        <p className="text-muted-foreground">No history yet.</p>
      ) : null}
      <ol className="flex flex-col gap-1">
        {items.map(({ item, day }) => {
          const line = historyLine(item);
          return (
            <li key={item.id} className="flex flex-col">
              {day ? <span className="pt-1 text-muted-foreground/70">{day}</span> : null}
              <div className="flex min-w-0 gap-3">
                <span className="shrink-0 font-mono text-3xs text-muted-foreground">
                  {clockTime(item.timestamp)}
                </span>
                <div className="flex min-w-0 flex-col">
                  <span>{line.title}</span>
                  {line.detail ? (
                    <span className="line-clamp-3 text-muted-foreground">{line.detail}</span>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

/** Retained WXT and backend output, fetched when the detail opens. */
function LabOutput({
  environmentId,
  envId,
}: {
  readonly environmentId: EnvironmentId;
  readonly envId: string;
}) {
  const logs = useEnvironmentQuery(
    labsEnvironment.logs({ environmentId, input: { envId, limit: 200 } }),
  );
  return (
    <Section title="Output">
      <div className="flex items-center gap-2">
        {logs.data?.message ? <p className="text-muted-foreground">{logs.data.message}</p> : null}
        <Tooltip>
          <TooltipTrigger
            render={<Button size="xs" variant="ghost-muted" onClick={logs.refresh} />}
          >
            Refresh
          </TooltipTrigger>
          <TooltipPopup>Reads the lab's retained output again.</TooltipPopup>
        </Tooltip>
      </div>
      {logs.error ? <p className="text-destructive-foreground">{logs.error}</p> : null}
      {!logs.data && !logs.error ? <p className="text-muted-foreground">Loading…</p> : null}
      {logs.data && logs.data.entries.length === 0 && !logs.data.message ? (
        <p className="text-muted-foreground">Nothing captured.</p>
      ) : null}
      {logs.data && logs.data.entries.length > 0 ? (
        <pre className="max-h-80 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-3xs leading-relaxed">
          {logs.data.entries
            .map((entry, position) => ({ ...entry, id: `${position}:${entry.timestamp}` }))
            .map((entry) => (
              <div
                key={entry.id}
                className={entry.stream === "stderr" ? "text-destructive-foreground" : undefined}
              >
                <span className="text-muted-foreground">{clockTime(entry.timestamp)} </span>
                {entry.text}
              </div>
            ))}
        </pre>
      ) : null}
    </Section>
  );
}
