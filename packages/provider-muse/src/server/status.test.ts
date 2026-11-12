import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { MuseSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import type { MuseSdkHost } from "./sdk.ts";
import { COMPACT_SLASH_COMMAND } from "@t3tools/provider-core/server/snapshotProbe";
import { checkMuseProviderStatus } from "./status.ts";

const settings = Schema.decodeSync(MuseSettings);
const makeHost = (catalog: Record<string, unknown>) => {
  const host: MuseSdkHost = {
    initializeResult: { grantedCapabilities: [] },
    connection: {
      request: vi.fn(async () => catalog),
      command: vi.fn(async () => ({})),
      mintCommandId: () => "test-command",
      onNotification: () => {},
      onServerRequest: () => {},
      onProtocolError: () => {},
      closed: new Promise(() => {}),
    },
    exited: new Promise(() => {}),
    close: vi.fn(async () => {}),
  };
  return host;
};
const metaCatalog = {
  providerId: "meta",
  models: [
    {
      modelId: "muse-wonder-1.0",
      displayLabel: "muse-wonder-1.0",
      providerId: "meta",
      isDefault: true,
    },
    {
      modelId: "foreign-model",
      displayLabel: "Another provider",
      providerId: "another",
      isDefault: false,
    },
  ],
};

const fakeCli = (source = 'process.stdout.write("muse 1.0.3-R2198.1\\n");') =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-status-test-" });
    return writeFakeCli({ directory, name: "muse", source });
  });

it.layer(NodeServices.layer)("Muse status", (it) => {
  it.effect("does not expose CLI stderr or start an SDK host after a failed version check", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli(
          'process.stderr.write("secret-test-value");process.exit(2);',
        );
        const createHost = vi.fn(async () => makeHost(metaCatalog));
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          undefined,
          undefined,
          createHost,
        );
        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("error");
        expect(snapshot.message).not.toContain("secret-test-value");
        expect(createHost).not.toHaveBeenCalled();
      }),
    ),
  );

  it.effect("discovers the Meta catalog without treating it as authentication proof", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli(
          'process.stdout.write(process.argv.includes("usage") ? JSON.stringify({ allowance: { weekly: { usedPercent: 7 } } }) : "muse 1.0.3-R2198.1\\n");',
        );
        const host = makeHost(metaCatalog);
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath, customModels: ["muse-custom"] }),
          undefined,
          undefined,
          async () => host,
        );
        expect(snapshot.status).toBe("ready");
        expect(snapshot.message).toBeUndefined();
        expect(snapshot.slashCommands).toEqual([COMPACT_SLASH_COMMAND]);
        expect(snapshot.auth).toEqual({ status: "unknown" });
        expect(snapshot.version).toBe("1.0.3-R2198.1");
        expect(snapshot.usageLimits?.windows).toEqual([
          { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 7 },
        ]);
        expect(snapshot.models.map((model) => model.slug)).toEqual([
          "muse-wonder-1.0",
          "muse-custom",
        ]);
        expect(snapshot.models.map((model) => model.name)).toEqual([
          "Muse Wonder 1.0",
          "muse-custom",
        ]);
        const descriptor = snapshot.models[0]?.capabilities?.optionDescriptors?.[0];
        expect(
          descriptor?.type === "select" && descriptor.options.map((option) => option.id),
        ).toEqual(["low", "medium", "high", "xhigh", "max"]);
        expect(host.connection.request).toHaveBeenCalledWith("model/list", {});
        expect(host.connection.command).not.toHaveBeenCalled();
        expect(host.close).toHaveBeenCalledOnce();
      }),
    ),
  );

  it.effect("pokes an idle allowance with one unlogged turn, then rereads usage", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli(`
          const fs = await import("node:fs");
          const marker = new URL("./poked", import.meta.url);
          const args = process.argv.slice(2);
          if (args[0] === "exec") {
            fs.writeFileSync(marker, args.join(" "));
          } else if (args[0] === "usage") {
            process.stdout.write(JSON.stringify(fs.existsSync(marker)
              ? { allowance: { weekly: { usedPercent: 18 } } }
              : { allowance: null, reason: "server_sent_no_usage" }));
          } else {
            process.stdout.write("muse 1.0.3-R2198.1\\n");
          }
        `);
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          undefined,
          undefined,
          async () => makeHost(metaCatalog),
        );
        expect(snapshot.usageLimits?.windows).toEqual([
          { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 18 },
        ]);
        const fs = yield* FileSystem.FileSystem;
        const pokeArgs = yield* fs.readFileString(binaryPath.replace(/muse(\.cmd)?$/, "poked"));
        expect(pokeArgs).toContain("--no-session-log");
      }),
    ),
  );

  it.effect("backs off a poke that leaves the allowance idle until the window passes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli(`
          const fs = await import("node:fs");
          const args = process.argv.slice(2);
          if (args[0] === "exec") {
            fs.appendFileSync(new URL("./pokes", import.meta.url), "poke\\n");
          } else if (args[0] === "usage") {
            process.stdout.write(JSON.stringify({ allowance: null, reason: "server_sent_no_usage" }));
          } else {
            process.stdout.write("muse 1.0.3-R2198.1\\n");
          }
        `);
        const pokeNotBeforeMs = yield* Ref.make(0);
        const probe = checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          undefined,
          undefined,
          async () => makeHost(metaCatalog),
          pokeNotBeforeMs,
        );
        const fs = yield* FileSystem.FileSystem;
        const pokeCount = fs
          .readFileString(binaryPath.replace(/muse(\.cmd)?$/, "pokes"))
          .pipe(Effect.map((log) => log.trim().split("\n").length));

        yield* probe;
        yield* probe;
        expect(yield* pokeCount).toBe(1);
        yield* TestClock.adjust("5 hours");
        yield* probe;
        expect(yield* pokeCount).toBe(2);
      }),
    ),
  );

  it.effect("keeps an empty discovered catalog empty instead of advertising a fallback model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli();
        const host = makeHost({ providerId: "meta", models: [] });
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          undefined,
          undefined,
          async () => host,
        );
        expect(snapshot.status).toBe("warning");
        expect(snapshot.models).toEqual([]);
        expect(host.close).toHaveBeenCalledOnce();
      }),
    ),
  );
});
