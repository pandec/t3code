import {
  CommandId,
  OrchestratorMcpFailure,
  type ThreadGroup,
  type ThreadId,
} from "@t3tools/contracts";
import { pinOrderKeyBetween } from "@t3tools/client-runtime/state/thread-sort";
import {
  nextThreadGroupRevision,
  threadGroupId,
  threadGroupSections,
  visibleThreadGroups,
} from "@t3tools/shared/threadGroups";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { unavailable } from "./threadAccess.ts";

/** A group as agents see it; Active is the entry with id null. */
export interface ThreadGroupRef {
  readonly id: string;
  readonly name: string;
}

export interface ThreadGroupListEntry {
  readonly id: string | null;
  readonly name: string;
  readonly threadCount: number;
}

/**
 * Fork: the custom sidebar thread groups agents may list, create, and move
 * threads into. The catalog lives in server settings and membership in the
 * `thread.custom-group.set` command, written exactly as the web client does;
 * thread launch tools validate a group with `requireGroup` and set it at creation.
 * Callers check thread access first; rename, delete, and reorder stay in the UI.
 */
export class ThreadGroupsMcpService extends Context.Service<
  ThreadGroupsMcpService,
  {
    readonly list: () => Effect.Effect<
      { readonly groups: ReadonlyArray<ThreadGroupListEntry> },
      OrchestratorMcpFailure
    >;
    readonly create: (
      name: string,
    ) => Effect.Effect<
      { readonly group: ThreadGroupRef; readonly created: boolean },
      OrchestratorMcpFailure
    >;
    readonly moveThread: (input: {
      readonly threadId: ThreadId;
      readonly groupId: string | null;
    }) => Effect.Effect<
      {
        readonly threadId: ThreadId;
        readonly group: ThreadGroupRef | null;
        readonly previousGroup: ThreadGroupRef | null;
        readonly changed: boolean;
      },
      OrchestratorMcpFailure
    >;
    /** Checks that a group exists and is not deleted, for tools that create threads in it. */
    readonly requireGroup: (
      groupId: string,
    ) => Effect.Effect<ThreadGroupRef, OrchestratorMcpFailure>;
  }
>()("t3/mcp/ThreadGroupsMcpService") {}

const groupRef = (group: ThreadGroup | null | undefined): ThreadGroupRef | null =>
  group == null ? null : { id: group.id, name: group.name };

/** Same rule as the web dialog's newThreadGroupOrderKey: new groups start at the bottom. */
const newGroupOrderKey = (groups: ReadonlyArray<ThreadGroup>) =>
  pinOrderKeyBetween(
    groups.filter((group) => group.aboveActive !== true).at(-1)?.orderKey ?? null,
    null,
  ) ?? "n";

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const settings = yield* ServerSettings.ServerSettingsService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  // Serializes the exact-name check with the write so concurrent creates of
  // one name yield one group.
  const createLock = yield* Semaphore.make(1);

  const catalog = settings.getSettings.pipe(
    Effect.map((current) => current.threadGroups),
    Effect.mapError(unavailable),
  );
  const randomId = crypto.randomUUIDv4.pipe(Effect.orDie);
  const findGroup = Effect.fn("ThreadGroupsMcpService.findGroup")(function* (
    groups: ReadonlyArray<ThreadGroup>,
    groupId: string,
  ) {
    const group = groups.find((candidate) => candidate.id === groupId);
    if (group === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The group was not found or was deleted. List groups for valid ids.",
      });
    }
    return group;
  });

  const list = Effect.fn("ThreadGroupsMcpService.list")(function* () {
    const groups = visibleThreadGroups(yield* catalog);
    const snapshot = yield* threads
      .getShellSnapshot({ location: "active" })
      .pipe(Effect.mapError(unavailable));
    const counts = new Map<string | null, number>();
    for (const thread of snapshot.threads) {
      if (thread.archivedAt !== null || thread.lineage.relationshipToParent === "subagent") {
        continue;
      }
      const groupId = threadGroupId(thread, groups);
      counts.set(groupId, (counts.get(groupId) ?? 0) + 1);
    }
    return {
      groups: threadGroupSections(groups).map((group) => ({
        id: group?.id ?? null,
        name: group?.name ?? "Active",
        threadCount: counts.get(group?.id ?? null) ?? 0,
      })),
    };
  });

  const create = Effect.fn("ThreadGroupsMcpService.create")(function* (name: string) {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "Pass a non-empty group name.",
      });
    }
    return yield* createLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* catalog;
        const groups = visibleThreadGroups(current);
        const existing = groups.find((group) => group.name === trimmed);
        if (existing !== undefined) return { group: groupRef(existing)!, created: false };
        const group = {
          id: yield* randomId,
          name: trimmed,
          deleted: false,
          orderKey: newGroupOrderKey(groups),
          revision: nextThreadGroupRevision(
            current,
            yield* Clock.currentTimeMillis,
            yield* randomId,
          ),
        } satisfies ThreadGroup;
        yield* settings
          .updateSettings({ threadGroups: [group] })
          .pipe(Effect.mapError(unavailable));
        return { group: groupRef(group)!, created: true };
      }),
    );
  });

  const moveThread = Effect.fn("ThreadGroupsMcpService.moveThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly groupId: string | null;
  }) {
    const groups = visibleThreadGroups(yield* catalog);
    const target = input.groupId === null ? null : yield* findGroup(groups, input.groupId);
    const shell = yield* threads.getThreadShell(input.threadId).pipe(Effect.mapError(unavailable));
    if (shell === null || shell.deletedAt !== null) {
      return yield* new OrchestratorMcpFailure({
        code: "thread_not_found",
        message: "The thread was not found.",
      });
    }
    const currentGroupId = threadGroupId(shell, groups);
    const previousGroup = groupRef(groups.find((group) => group.id === currentGroupId));
    const changed = currentGroupId !== (target?.id ?? null);
    if (changed) {
      yield* threads
        .dispatch({
          type: "thread.custom-group.set",
          commandId: CommandId.make(`mcp:${yield* randomId}`),
          threadId: input.threadId,
          customGroupId: target?.id ?? null,
        })
        .pipe(Effect.mapError(unavailable));
    }
    return { threadId: input.threadId, group: groupRef(target), previousGroup, changed };
  });

  const requireGroup = Effect.fn("ThreadGroupsMcpService.requireGroup")(function* (
    groupId: string,
  ) {
    return groupRef(yield* findGroup(visibleThreadGroups(yield* catalog), groupId))!;
  });

  return ThreadGroupsMcpService.of({ list, create, moveThread, requireGroup });
});

export const layer = Layer.effect(ThreadGroupsMcpService, make);
