import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  type LabEnvironment,
  type LabLinkState,
  type LabT3State,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { ChevronRightIcon, FlaskConicalIcon, GitBranchIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { labsEnvironment, useLabsSnapshot } from "../../state/labs";
import { useEnvironmentQuery } from "../../state/query";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "../Sidebar.logic";
import { useOpenThreadInPane } from "../thread-split/useOpenThreadInPane";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  LabReservationActions,
  LabStackActions,
  NewThreadInLabButton,
  useLabCommands,
  type LabCommands,
} from "./LabActions";
import { LabAvailabilityBadge, LabHealthDot, useLabOwnerThread } from "./LabParts";
import {
  labOperationLabel,
  resolveLabAvailability,
  resolveLabStackHealth,
  type LabHealthTone,
} from "./labs.logic";

const OWNER_STATUS_LABELS: Record<SidebarThreadStatus, string> = {
  approval: "Needs approval",
  input: "Needs input",
  working: "Working",
  monitoring: "Monitoring",
  waiting: "Idle",
  failed: "Failed",
  limited: "Usage limited",
  ready: "Idle",
};

/**
 * Fork (SP Labs): the labs overview that replaces the sp-labs dashboard. It subscribes to the
 * live snapshot only while `visible`; a hidden or reopened tab reads nothing.
 */
export function LabsPanel({
  environmentId,
  projectId,
  visible,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly visible: boolean;
}) {
  if (!visible) return null;
  return <VisibleLabsPanel environmentId={environmentId} projectId={projectId} />;
}

function VisibleLabsPanel({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
}) {
  const snapshot = useLabsSnapshot(environmentId);
  const commands = useLabCommands(environmentId);
  const data = snapshot.data;

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

  const labs = data.environments.filter((environment) => environment.kind === "lab");
  const counts = labs.reduce(
    (total, environment) => {
      total[resolveLabAvailability(environment)] += 1;
      return total;
    },
    { free: 0, reserved: 0, held: 0, unavailable: 0 },
  );
  // The labs project, where "New thread here" stages a draft.
  const labsProjectId = data.projectId ?? projectId;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-baseline justify-between gap-3 border-b px-3 py-2 text-xs">
        <span className="text-muted-foreground">
          {counts.free} free · {counts.reserved} reserved · {counts.held} held
        </span>
        {data.checkedAt ? (
          <span className="text-muted-foreground/70">
            checked {formatRelativeTimeLabel(data.checkedAt)}
          </span>
        ) : null}
      </div>
      {data.error ? (
        <p className="border-b px-3 py-2 text-destructive-foreground text-xs">{data.error}</p>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col">
          {data.environments.map((environment) => (
            <LabRow
              key={environment.id}
              environmentId={environmentId}
              projectId={labsProjectId}
              environment={environment}
              t3={data.t3[environment.id]}
              commands={commands}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function PanelMessage({
  title,
  children,
}: {
  readonly title: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <FlaskConicalIcon aria-hidden className="size-6 text-muted-foreground/60" />
      <p className="font-medium text-sm">{title}</p>
      {children ? <p className="max-w-64 text-muted-foreground text-xs">{children}</p> : null}
    </div>
  );
}

function LabRow({
  environmentId,
  projectId,
  environment,
  t3,
  commands,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly environment: LabEnvironment;
  readonly t3: LabT3State | undefined;
  readonly commands: LabCommands;
}) {
  const health = resolveLabStackHealth(environment, t3);
  const { runtime } = environment;
  const isLab = environment.kind === "lab";
  return (
    <section className="flex flex-col gap-2 border-b px-3 py-3 text-xs">
      <div className="flex items-center gap-2">
        <LabHealthDot tone={health.tone} />
        <span className="font-medium text-sm">{environment.name}</span>
        {isLab ? <LabAvailabilityBadge availability={resolveLabAvailability(environment)} /> : null}
        <span className="text-muted-foreground">{health.label}</span>
        <span className="ms-auto font-mono text-3xs text-muted-foreground/70">
          cdp {environment.cdpPort}
          {environment.wxtPort === null ? "" : ` · wxt ${environment.wxtPort}`}
        </span>
      </div>

      {environment.lease ? (
        <LabOwnerLine environmentId={environmentId} environment={environment} />
      ) : null}

      {runtime.git ? (
        <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <GitBranchIcon className="size-3 shrink-0" />
          <span className="min-w-0 truncate font-mono">{runtime.git.branch}</span>
          <span className="font-mono text-muted-foreground/70">
            @{runtime.git.commit.slice(0, 7)}
          </span>
          {runtime.git.dirty ? (
            <span className="text-warning-foreground">· uncommitted changes</span>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
        <HealthItem
          label="Chrome"
          tone={linkTone(runtime.chrome.state)}
          detail={runtime.chrome.detail}
        />
        {isLab ? (
          <HealthItem label="WXT" tone={linkTone(runtime.wxt.state)} detail={runtime.wxt.detail} />
        ) : null}
        <HealthItem
          label="Backend"
          tone={
            runtime.backend.state === "ready"
              ? "ok"
              : runtime.backend.state === "error"
                ? "error"
                : "off"
          }
          detail={runtime.backend.detail}
        />
        <HealthItem label="Extension" tone="off" detail={runtime.extension.detail} />
      </div>

      {t3?.operation ? (
        <p className="text-info-foreground">T3: {labOperationLabel(t3.operation)}…</p>
      ) : null}
      {runtime.operation && !t3?.operation ? (
        <p className="text-info-foreground">
          Running <span className="font-mono">{runtime.operation.command}</span> since{" "}
          {formatRelativeTimeLabel(runtime.operation.startedAt)}
        </p>
      ) : null}
      {t3?.lastUp ? (
        <p className={t3.lastUp.ok ? "text-muted-foreground" : "text-destructive-foreground"}>
          Last start {formatRelativeTimeLabel(t3.lastUp.at)}:{" "}
          {t3.lastUp.ok ? "ok" : (t3.lastUp.detail ?? "failed")}
        </p>
      ) : null}
      {runtime.diagnosis.length > 0 ? (
        <ul className="list-disc ps-4 text-warning-foreground">
          {runtime.diagnosis.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}

      {environment.hold ? (
        <p className="text-warning-foreground">
          Held{environment.hold.note ? `: “${environment.hold.note}”` : ""}
        </p>
      ) : null}
      {environment.handoff ? (
        <div className="flex flex-col gap-0.5 rounded-md bg-muted/50 px-2 py-1.5">
          <span className="font-medium text-muted-foreground">
            Standing handoff
            {environment.handoff.disposition === "needs-repair" ? " · needs repair" : ""}
          </span>
          <span className="whitespace-pre-wrap">{environment.handoff.summary}</span>
          <span className="font-mono text-3xs text-muted-foreground/70">
            {environment.handoff.branch} @{environment.handoff.commit.slice(0, 7)} · released{" "}
            {formatRelativeTimeLabel(environment.handoff.releasedAt)}
          </span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1">
        {isLab ? (
          <NewThreadInLabButton
            environmentId={environmentId}
            projectId={projectId}
            environment={environment}
          />
        ) : null}
        <LabStackActions environment={environment} t3={t3} commands={commands} />
        <LabReservationActions
          environmentId={environmentId}
          environment={environment}
          t3={t3}
          commands={commands}
        />
      </div>

      <LabDetails environmentId={environmentId} environment={environment} />
    </section>
  );
}

function linkTone(state: LabLinkState): LabHealthTone {
  return state === "up" ? "ok" : state === "down" ? "off" : "warn";
}

function HealthItem({
  label,
  tone,
  detail,
}: {
  readonly label: string;
  readonly tone: LabHealthTone;
  readonly detail: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex items-center gap-1" />}>
        <LabHealthDot tone={tone} className="size-1.5" />
        {label}
      </TooltipTrigger>
      <TooltipPopup>{detail || label}</TooltipPopup>
    </Tooltip>
  );
}

function LabOwnerLine({
  environmentId,
  environment,
}: {
  readonly environmentId: EnvironmentId;
  readonly environment: LabEnvironment;
}) {
  const lease = environment.lease;
  const owner = useLabOwnerThread(environmentId, lease?.threadId ?? null);
  const openThread = useOpenThreadInPane();
  if (!lease) return null;
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 items-center gap-1.5">
        {owner ? (
          <>
            <Button
              size="xs"
              variant="link"
              className="min-w-0 justify-start"
              onClick={() => openThread(scopeThreadRef(environmentId, ThreadId.make(owner.id)))}
            >
              <span className="truncate">{owner.title}</span>
            </Button>
            <span className="shrink-0 text-muted-foreground">
              {OWNER_STATUS_LABELS[resolveSidebarThreadStatus(owner)]}
              {owner.archivedAt ? " · archived" : ""}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">
            {lease.threadId ? "Owner outside T3" : "Reserved outside T3"}
          </span>
        )}
      </div>
      <span className="truncate text-muted-foreground">
        {lease.purpose} · since {formatRelativeTimeLabel(lease.acquiredAt)}
      </span>
    </div>
  );
}

/** History and retained output, fetched only while expanded. */
function LabDetails({
  environmentId,
  environment,
}: {
  readonly environmentId: EnvironmentId;
  readonly environment: LabEnvironment;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
        <ChevronRightIcon className={cn("size-3", open && "rotate-90")} />
        History and output
      </CollapsibleTrigger>
      <CollapsiblePanel animate={false}>
        {open ? <LabHistoryAndLogs environmentId={environmentId} envId={environment.id} /> : null}
      </CollapsiblePanel>
    </Collapsible>
  );
}

function LabHistoryAndLogs({
  environmentId,
  envId,
}: {
  readonly environmentId: EnvironmentId;
  readonly envId: string;
}) {
  const history = useEnvironmentQuery(
    labsEnvironment.history({ environmentId, input: { envId, limit: 20 } }),
  );
  const logs = useEnvironmentQuery(
    labsEnvironment.logs({ environmentId, input: { envId, limit: 200 } }),
  );
  return (
    <div className="flex flex-col gap-3 pt-2">
      <div className="flex flex-col gap-1">
        <span className="font-medium text-muted-foreground">History</span>
        {history.error ? <p className="text-destructive-foreground">{history.error}</p> : null}
        {history.data?.items.length === 0 ? (
          <p className="text-muted-foreground">Nothing recorded yet.</p>
        ) : null}
        {history.data?.items.map((item) => (
          <div key={item.id} className="flex min-w-0 gap-2">
            <span className="shrink-0 font-mono text-muted-foreground/70">
              {formatRelativeTimeLabel(item.timestamp)}
            </span>
            <span className="min-w-0 truncate">
              {item.kind === "command"
                ? `${item.command ?? "command"}${item.status ? ` · ${item.status}` : ""}`
                : item.kind === "reservation"
                  ? `reserved${item.purpose ? `: ${item.purpose}` : ""}`
                  : `handoff${item.summary ? `: ${item.summary}` : ""}`}
            </span>
          </div>
        ))}
        {!history.data && !history.error ? <p className="text-muted-foreground">Loading…</p> : null}
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="font-medium text-muted-foreground">Output</span>
          <Button size="xs" variant="ghost-muted" onClick={logs.refresh}>
            Refresh
          </Button>
        </div>
        {logs.error ? <p className="text-destructive-foreground">{logs.error}</p> : null}
        {logs.data?.message ? <p className="text-muted-foreground">{logs.data.message}</p> : null}
        {logs.data && logs.data.entries.length > 0 ? (
          <pre className="max-h-64 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-3xs leading-relaxed">
            {logs.data.entries.map((entry) => `[${entry.stream}] ${entry.text}`).join("\n")}
          </pre>
        ) : null}
        {!logs.data && !logs.error ? <p className="text-muted-foreground">Loading…</p> : null}
      </div>
    </div>
  );
}
