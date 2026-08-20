import { afterEach, describe, expect, it } from "@effect/vitest";
import type { ThreadLifecycleIntent } from "@t3tools/client-runtime/state/thread-lifecycle-outbox-model";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { vi } from "vite-plus/test";

const persistedFiles = new Map<string, string>();

vi.mock("expo-file-system", () => {
  class Directory {
    readonly uri: string;

    constructor(base: string | { readonly uri: string }, name: string) {
      const baseUri = typeof base === "string" ? base : base.uri;
      this.uri = name.length === 0 ? baseUri : `${baseUri}/${name}`;
    }

    create(): void {}

    list(): ReadonlyArray<File> {
      const prefix = `${this.uri}/`;
      return [...persistedFiles.keys()]
        .filter((uri) => uri.startsWith(prefix) && !uri.slice(prefix.length).includes("/"))
        .map((uri) => new File(this, uri.slice(prefix.length)));
    }
  }

  class File {
    uri: string;

    constructor(directory: { readonly uri: string }, name: string) {
      this.uri = `${directory.uri}/${name}`;
    }

    get name(): string {
      return this.uri.slice(this.uri.lastIndexOf("/") + 1);
    }

    get parentDirectory(): Directory {
      const separator = this.uri.lastIndexOf("/");
      return new Directory(this.uri.slice(0, separator), "");
    }

    get exists(): boolean {
      return persistedFiles.has(this.uri);
    }

    create(): void {
      persistedFiles.set(this.uri, "");
    }

    write(contents: string): void {
      persistedFiles.set(this.uri, contents);
    }

    moveSync(destination: File): void {
      const contents = persistedFiles.get(this.uri) ?? "";
      persistedFiles.delete(this.uri);
      persistedFiles.set(destination.uri, contents);
      this.uri = destination.uri;
    }

    delete(): void {
      persistedFiles.delete(this.uri);
    }

    async text(): Promise<string> {
      return persistedFiles.get(this.uri) ?? "";
    }
  }

  return {
    Paths: { document: "file:///document" },
    Directory,
    File,
  };
});

import { expoThreadLifecycleOutboxStorage } from "./thread-lifecycle-outbox-storage";

function intent(): ThreadLifecycleIntent {
  const threadId = ThreadId.make("thread-1");
  return {
    environmentId: EnvironmentId.make("environment-1"),
    threadId,
    desiredArchived: true,
    requiresDispatch: false,
    dispatchAttempted: false,
    commandId: CommandId.make("command-archive"),
    createdAt: "2026-08-20T10:02:00.000Z",
    baselineArchivedAt: null,
    thread: {
      id: threadId,
      projectId: ProjectId.make("project-1"),
      title: "Offline archive",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-08-20T10:00:00.000Z",
      updatedAt: "2026-08-20T10:01:00.000Z",
      archivedAt: null,
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      settledOverride: null,
      settledAt: null,
    },
  };
}

afterEach(() => persistedFiles.clear());

describe("thread lifecycle outbox storage", () => {
  it("atomically round-trips and removes one persisted row", async () => {
    const queued = intent();

    await expoThreadLifecycleOutboxStorage.write(queued);

    expect([...persistedFiles.keys()]).toEqual([
      "file:///document/thread-lifecycle-outbox/environment-1%3Athread-1.json",
    ]);
    expect(await expoThreadLifecycleOutboxStorage.load()).toEqual([queued]);

    await expoThreadLifecycleOutboxStorage.remove(queued);
    expect(await expoThreadLifecycleOutboxStorage.load()).toEqual([]);
  });
});
