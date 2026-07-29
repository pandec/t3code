import "vite-plus/test/config";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";
import packageJson from "./package.json" with { type: "json" };

const bundledPackagePrefixes = [
  "@pierre/diffs",
  "@t3tools/",
  "effect-acp",
  "effect-codex-app-server",
];

export function shouldBundleCliDependency(id: string): boolean {
  return bundledPackagePrefixes.some((prefix) => id.startsWith(prefix));
}

const repoEnv = loadRepoEnv();
const cliBuildChannel = packageJson.version.includes("-nightly.") ? "nightly" : "latest";
const macLoopbackTransportRetry =
  Effect.runSync(HostProcessPlatform) === "darwin"
    ? {
        count: 2,
        condition:
          /(?:Transport error \([A-Z]+ http:\/\/127\.0\.0\.1:\d+|UND_ERR_SOCKET|other side closed|connect ETIMEDOUT 127\.0\.0\.1)/,
      }
    : 0;

export default mergeConfig(
  baseConfig,
  defineConfig({
    run: {
      tasks: {
        build: {
          command: "node scripts/cli.ts build",
          dependsOn: ["@t3tools/web#build"],
          cache: false,
        },
      },
    },
    pack: {
      entry: ["src/bin.ts"],
      outDir: "dist",
      sourcemap: true,
      clean: true,
      deps: {
        alwaysBundle: shouldBundleCliDependency,
        onlyBundle: false,
      },
      banner: {
        js: "#!/usr/bin/env node\n",
      },
      define: {
        __T3CODE_BUILD_CHANNEL__: JSON.stringify(cliBuildChannel),
        __T3CODE_BUILD_RELAY_URL__: JSON.stringify(repoEnv.T3CODE_RELAY_URL?.trim() ?? ""),
        __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: JSON.stringify(
          repoEnv.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() ?? "",
        ),
        __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__: JSON.stringify(
          repoEnv.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID?.trim() ?? "",
        ),
        __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__: JSON.stringify(
          repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_URL?.trim() ?? "",
        ),
        __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__: JSON.stringify(
          repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET?.trim() ?? "",
        ),
        __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__: JSON.stringify(
          repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN?.trim() ?? "",
        ),
      },
    },
    test: {
      // This suite ran with `fileParallelism: false` to avoid load-sensitive
      // flakes from its sqlite, git, temp-worktree, and orchestration work.
      // That serialization cost more than half the runtime: the same 213 files
      // take 143.2s serialized versus 62.4s at four workers, both fully green.
      // It also never bounded resource use the way it appeared to — the suite
      // spawns git and sqlite children regardless, and peaked at 17 processes
      // even when Vitest was pinned to a single worker. Worker count is now
      // bounded centrally in scripts/lib/vitest-shared.ts instead.
      //
      // Re-verified only on Linux. If parallel files prove flaky here — macOS
      // is the likelier place, given case-insensitive APFS and different
      // temp-dir and fsync behaviour — fix the offending test's isolation
      // rather than reinstating blanket serialization.
      //
      // Server integration tests exercise sqlite, git, and orchestration together.
      // Under package-wide runs they can exceed the default budget on loaded CI hosts.
      hookTimeout: 120_000,
      // macOS intermittently drops the first request to an ephemeral Effect test
      // server under package-wide load. Retry only that loopback transport failure;
      // assertions and persistent server failures still fail normally.
      retry: macLoopbackTransportRetry,
      testTimeout: 120_000,
    },
  }),
);
