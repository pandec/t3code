import { type ModelSelection, ProviderDriverKind } from "@t3tools/contracts";

export function withLowSummaryEffort(
  modelSelection: ModelSelection,
  driverKind: ProviderDriverKind,
): ModelSelection {
  const effortOptionId =
    driverKind === ProviderDriverKind.make("codex")
      ? "reasoningEffort"
      : driverKind === ProviderDriverKind.make("claudeAgent")
        ? "effort"
        : driverKind === ProviderDriverKind.make("cursor")
          ? "reasoning"
          : driverKind === ProviderDriverKind.make("opencode")
            ? "variant"
            : null;
  if (effortOptionId === null) return modelSelection;

  return {
    ...modelSelection,
    options: [
      ...(modelSelection.options ?? []).filter((option) => option.id !== effortOptionId),
      { id: effortOptionId, value: "low" },
    ],
  };
}
