import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import { stripAppImageRuntimeEnv } from "@t3tools/shared/appImageRuntimeEnv";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomeVariable } from "./pathExpansion.ts";
import { withoutThreadEnvironment } from "./threadEnvironment.ts";

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  // Drivers retain a stable environment snapshot for the instance lifetime.
  // Commands the agent runs inherit this env; the AppImage mount's libraries would shadow the system's.
  // Fork: the server's own thread identity is never part of a provider instance's environment.
  const next = withoutThreadEnvironment(stripAppImageRuntimeEnv(baseEnv));
  const home = yield* HostProcess.HomeDirectory;
  const windows = (yield* HostProcess.Platform) === "win32";
  for (const variable of environment ?? []) {
    // An unresolved secret reference carries no value; the registry resolves it for the provider.
    if (typeof variable.value !== "string") continue;
    // Windows reads names without regard to case, and a child gets the first spelling in sort
    // order. Upper case sorts first, so the configured value wins even where a spawn merges the
    // parent environment back in.
    const name = windows ? variable.name.toUpperCase() : variable.name;
    if (windows) {
      for (const inherited of Object.keys(next)) {
        if (inherited.toUpperCase() === name) delete next[inherited];
      }
    }
    next[name] = expandHomeVariable(name, variable.value, home);
  }
  return next;
});
