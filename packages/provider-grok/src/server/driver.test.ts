// @effect-diagnostics nodeBuiltinImport:off - the home-expansion test compares against the real home directory.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { GrokDriver } from "./driver.ts";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";

const layerTest = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Grok must not make an HTTP request")),
    ),
  ),
);

const noSpawner = ChildProcessSpawner.make(() =>
  Effect.die("Disabled Grok must not spawn a process"),
);

// The `#!/bin/sh` stub below cannot be resolved as an executable on Windows.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

it.layer(layerTest)("GrokDriver", (it) => {
  it.effect.skipIf(windowsHost)("updates through the configured executable's own updater", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-driver-" });
      const grokHome = path.join(tempDir, "Grok Home");
      const binaryPath = path.join(grokHome, "bin", "grok");
      yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
      yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
      yield* fs.chmod(binaryPath, 0o755);

      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok-update"),
        displayName: "Grok test",
        enabled: false,
        environment: [{ name: "GROK_HOME", value: grokHome, sensitive: false }],
        config: { ...GrokDriver.defaultConfig(), binaryPath },
      });

      const capabilities = yield* instance.snapshot.resolveMaintenance();
      expect(capabilities.packageName).toBe("@xai-official/grok");
      expect(capabilities.update).toMatchObject({
        command: `'${binaryPath}' update`,
        executable: binaryPath,
        args: ["update"],
      });
      // `grok update` installs under GROK_HOME, so it must target this instance's home.
      expect(capabilities.update?.env?.GROK_HOME).toBe(grokHome);
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );

  it.effect("stays manual-only when the configured executable does not exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-missing-" });
      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok-missing"),
        displayName: "Grok test",
        enabled: false,
        environment: [],
        config: { ...GrokDriver.defaultConfig(), binaryPath: path.join(tempDir, "grok") },
      });
      expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );

  it.effect("launches sessions with the expanded home-relative binary", () =>
    Effect.gen(function* () {
      const launched: Array<string> = [];
      const recordingSpawner = ChildProcessSpawner.make((command) => {
        if (command._tag === "StandardCommand" && command.args.includes("stdio")) {
          launched.push(command.command);
        }
        return Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "grok-driver-test",
            method: "spawn",
          }),
        );
      });
      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok-home"),
        displayName: "Grok test",
        enabled: false,
        environment: [],
        config: { ...GrokDriver.defaultConfig(), binaryPath: "~/bin/grok" },
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recordingSpawner));
      yield* instance.orchestrationAdapter
        .openSession({
          threadId: ThreadId.make("grok-home"),
          providerSessionId: ProviderSessionId.make("grok-home"),
          modelSelection: { instanceId: instance.instanceId, model: "grok-build" },
          runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
          }),
        })
        .pipe(Effect.scoped, Effect.ignore);
      expect(launched).toEqual([NodePath.join(NodeOS.homedir(), "bin/grok")]);
    }).pipe(
      // Keep the launch command unwrapped by the Linux cgroup shim.
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.scoped,
    ),
  );
});
