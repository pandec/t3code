import type { LinearIssue, LinearIssueState, LinearUser } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

export function linearUserLabel(user: LinearUser | null, fallback: string): string {
  return user === null ? fallback : user.displayName || user.name;
}

/** Linear's own colour for its urgent priority marker; the other levels take the text colour. */
const URGENT_COLOR = "#f2994a";

/**
 * The workflow-state glyphs Linear draws: dashed for backlog, an empty ring before work starts,
 * a half-filled ring while it runs, and filled rings with a check or cross once it ends. The
 * ring takes the state's own colour so a custom workflow reads as it does in Linear.
 */
export function LinearStateIcon({
  state,
  className,
}: {
  state: LinearIssueState;
  className?: string;
}) {
  const ended = state.type === "completed" || state.type === "canceled";
  return (
    <svg
      aria-hidden
      viewBox="0 0 14 14"
      className={cn("size-3.5 shrink-0", className)}
      style={{ color: state.color }}
    >
      <circle
        cx="7"
        cy="7"
        r="6"
        fill={ended ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray={state.type === "backlog" ? "1.6 1.8" : undefined}
      />
      {state.type === "started" ? (
        <path d="M7 7V3.25A3.75 3.75 0 0 1 7 10.75Z" fill="currentColor" />
      ) : null}
      {state.type === "triage" ? <circle cx="7" cy="7" r="1.75" fill="currentColor" /> : null}
      {state.type === "completed" ? (
        <path
          d="M4.4 7.2 6.2 9l3.5-3.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-background"
        />
      ) : null}
      {state.type === "canceled" ? (
        <path
          d="M4.8 4.8 9.2 9.2M9.2 4.8 4.8 9.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          className="text-background"
        />
      ) : null}
    </svg>
  );
}

/**
 * Linear's priority bars: one, two, or three of three lit for low, medium, and high, an orange
 * exclamation tile for urgent, and three faint dashes when no priority is set.
 */
export function LinearPriorityIcon({
  priority,
  className,
}: {
  /** 0 = none, 1 = urgent, 2 = high, 3 = medium, 4 = low. */
  priority: number;
  className?: string;
}) {
  if (priority === 1) {
    return (
      <svg aria-hidden viewBox="0 0 16 16" className={cn("size-3.5 shrink-0", className)}>
        <rect x="1" y="1" width="14" height="14" rx="3" fill={URGENT_COLOR} />
        <path
          d="M8 4.25v4.5M8 11.5v.25"
          className="text-white"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (priority === 0) {
    return (
      <svg aria-hidden viewBox="0 0 16 16" className={cn("size-3.5 shrink-0", className)}>
        {[1.5, 6.5, 11.5].map((x) => (
          <rect key={x} x={x} y="7.25" width="3" height="1.5" rx="0.75" fill="currentColor" />
        ))}
      </svg>
    );
  }
  const lit = priority === 2 ? 3 : priority === 3 ? 2 : 1;
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={cn("size-3.5 shrink-0", className)}>
      {[
        { x: 1.5, y: 9, height: 6 },
        { x: 6.5, y: 5, height: 10 },
        { x: 11.5, y: 1, height: 14 },
      ].map((bar, index) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={bar.y}
          width="3"
          height={bar.height}
          rx="1"
          fill="currentColor"
          opacity={index < lit ? 1 : 0.3}
        />
      ))}
    </svg>
  );
}

export function LinearStateBadge({
  state,
  className,
}: {
  state: LinearIssue["state"];
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 shrink-0 items-center gap-1.5 text-2xs font-medium text-foreground/80",
        className,
      )}
    >
      <LinearStateIcon state={state} className="size-3" />
      <span className="truncate">{state.name}</span>
    </span>
  );
}

export function LinearLabelPill({ label }: { label: LinearIssue["labels"][number] }) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-border/60 px-2 text-xs text-foreground/90">
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: label.color }}
      />
      <span className="truncate">{label.name}</span>
    </span>
  );
}

export function LinearUserAvatar({
  user,
  className,
}: {
  user: LinearUser | null;
  className?: string;
}) {
  const avatarUrl = user?.avatarUrl ?? null;
  if (user === null) {
    return (
      <span
        aria-hidden
        className={cn(
          "size-4 shrink-0 rounded-full border border-dashed border-muted-foreground/60",
          className,
        )}
      />
    );
  }
  return avatarUrl === null ? (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-3xs font-medium text-muted-foreground",
        className,
      )}
    >
      {(user.displayName || user.name).slice(0, 1).toUpperCase()}
    </span>
  ) : (
    <img
      aria-hidden
      alt=""
      src={avatarUrl}
      loading="lazy"
      className={cn("size-4 shrink-0 rounded-full bg-muted object-cover", className)}
    />
  );
}

/**
 * Linear's due dates are calendar days without a zone. Read as a local date so the day never
 * shifts, shown without the year while it is this year's, and flagged once the day has passed.
 */
export function formatLinearDueDate(
  value: string,
  now: Date = new Date(),
): { label: string; overdue: boolean } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const date = new Date(year, month, day);
  // The constructor rolls an impossible day into the next month; treat that as no date.
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
    return null;
  }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return {
    label: date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
    }),
    overdue: date < today,
  };
}
