import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

describe("WebSocket RPC contracts", () => {
  it("rejects server-internal commands sent to dispatchCommand", () => {
    const dispatchCommand = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    if (dispatchCommand === undefined) throw new Error("dispatchCommand is not registered");
    const decode = Schema.decodeUnknownExit(dispatchCommand.payloadSchema);

    expect(
      Exit.isFailure(
        decode({
          type: "checkpoint.rollback.fail",
          commandId: "forged-rollback-failure",
          threadId: "thread-1",
          requestId: "rollback-1",
          message: "Forged failure.",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decode({
          type: "checkpoint.rollback",
          commandId: "rollback-1",
          threadId: "thread-1",
          scopeId: "scope-1",
          checkpointId: "checkpoint-1",
        }),
      ),
    ).toBe(true);
    // Fork: only the server may vouch that a provider session moved itself.
    expect(
      Exit.isFailure(
        decode({
          type: "thread.workspace.follow-session",
          commandId: "forged-follow",
          threadId: "thread-1",
          worktreePath: "/repo-b",
          branch: null,
          expectedWorktreePath: "/repo-a",
          providerSessionId: "provider-session-1",
          providerSessionCreatedAt: "2026-10-04T10:00:00.000Z",
        }),
      ),
    ).toBe(true);
    // Nor smuggle the session through a client metadata update.
    const metadataUpdate = decode({
      type: "thread.metadata.update",
      commandId: "metadata-1",
      threadId: "thread-1",
      worktreePath: "/repo-b",
      providerSessionId: "provider-session-1",
    });
    if (!Exit.isSuccess(metadataUpdate)) throw new Error("metadata update was rejected");
    expect("providerSessionId" in metadataUpdate.value).toBe(false);
  });

  it("lets the server pick a new worktree's folder", () => {
    const createWorktree = WsRpcGroup.requests.get(WS_METHODS.vcsCreateWorktree);
    if (createWorktree === undefined) throw new Error("vcs.createWorktree is not registered");
    const decode = Schema.decodeUnknownExit(createWorktree.payloadSchema);
    const request = { cwd: "/repo", refName: "main", newRefName: "feature/x" };

    expect(Exit.isSuccess(decode({ ...request, path: null }))).toBe(true);
    expect(Exit.isFailure(decode({ ...request, path: "/repo/.git/hooks" }))).toBe(true);
  });
});
