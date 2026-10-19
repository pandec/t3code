import { useAtomValue } from "@effect/atom-react";
import { readCustomModelIcons, reportedModelIcon } from "@t3tools/client-runtime/customModelIcons";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

import { serverEnvironment } from "../state/server";

/** Fork: the instance's custom-model icon for a model its provider reported at runtime. */
export function useReportedModelIcon(
  environmentId: EnvironmentId,
  providerInstanceId: ProviderInstanceId,
  model: string | null | undefined,
): string | undefined {
  return useAtomValue(serverEnvironment.settingsValueAtom(environmentId), (settings) =>
    reportedModelIcon(
      readCustomModelIcons(settings?.providerInstances?.[providerInstanceId]?.config),
      model,
    ),
  );
}
