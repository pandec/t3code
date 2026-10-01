import type { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";

export const resolveManagedCodexHomeLayout = Effect.fn("resolveManagedCodexHomeLayout")(function* (
  stateDir: string,
  instanceId: ProviderInstanceId,
  config: CodexSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const path = yield* Path.Path;
  return yield* resolveCodexHomeLayout(
    {
      ...config,
      shadowHomePath:
        config.shadowHomePath.trim() ||
        (instanceId === "codex"
          ? ""
          : path.join(stateDir, "providers", "codex", instanceId, "shadow")),
    },
    environment,
  );
});
