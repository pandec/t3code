import type { LinearIssue, LinearUser } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

export function linearUserLabel(user: LinearUser | null, fallback: string): string {
  return user === null ? fallback : user.displayName || user.name;
}

/** Linear reports a hex colour per workflow state; the badge carries it so states read as they do in Linear. */
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
        "inline-flex min-w-0 shrink-0 items-center gap-1.5 text-[11px] font-medium text-foreground/80",
        className,
      )}
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: state.color }}
      />
      <span className="truncate">{state.name}</span>
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
  return avatarUrl === null ? (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[8px] font-medium text-muted-foreground",
        className,
      )}
    >
      {(user?.displayName ?? user?.name ?? "?").slice(0, 1).toUpperCase()}
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
