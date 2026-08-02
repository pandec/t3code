import { ProviderInstanceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import {
  createModelSelection,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

import {
  getClaudeModelCapabilities,
  normalizeClaudeCliEffort,
  resolveClaudeApiModelId,
} from "./ClaudeProvider.ts";

const INSTANCE_ID = ProviderInstanceId.make("claudeAgent");

it("exposes an effort descriptor with default high for custom models", () => {
  const descriptors = getProviderOptionDescriptors({
    caps: getClaudeModelCapabilities("gpt-5.6-sol"),
  });
  const effort = descriptors.find((descriptor) => descriptor.id === "effort");
  assert.isDefined(effort);
  assert.equal(effort?.type, "select");
  if (effort?.type === "select") {
    assert.deepEqual(
      effort.options.map((option) => option.id),
      ["low", "medium", "high"],
    );
  }
  assert.equal(getProviderOptionCurrentValue(effort), "high");
});

it("keeps built-in model capabilities unchanged", () => {
  const descriptors = getProviderOptionDescriptors({
    caps: getClaudeModelCapabilities("claude-fable-5"),
  });
  const effort = descriptors.find((descriptor) => descriptor.id === "effort");
  assert.equal(effort?.type, "select");
  if (effort?.type === "select") {
    assert.deepEqual(
      effort.options.map((option) => option.id),
      ["low", "medium", "high", "xhigh", "max", "ultracode", "ultrathink"],
    );
  }
});

it("rewrites custom model ids with the selected effort suffix", () => {
  for (const effort of ["low", "medium", "high"]) {
    assert.equal(
      resolveClaudeApiModelId(
        createModelSelection(INSTANCE_ID, "gpt-5.6-sol", [{ id: "effort", value: effort }]),
      ),
      `gpt-5.6-sol(${effort})`,
    );
  }
});

it("rewrites custom model ids with the default effort when none is selected", () => {
  assert.equal(
    resolveClaudeApiModelId(createModelSelection(INSTANCE_ID, "gpt-5.6-sol")),
    "gpt-5.6-sol(high)",
  );
});

it("passes pre-suffixed custom model ids through and ignores the effort option", () => {
  assert.equal(
    resolveClaudeApiModelId(
      createModelSelection(INSTANCE_ID, "gpt-5.6-sol(medium)", [{ id: "effort", value: "high" }]),
    ),
    "gpt-5.6-sol(medium)",
  );
});

it("keeps built-in model id resolution unchanged", () => {
  assert.equal(
    resolveClaudeApiModelId(createModelSelection(INSTANCE_ID, "claude-opus-4-7")),
    "claude-opus-4-7",
  );
  assert.equal(
    resolveClaudeApiModelId(
      createModelSelection(INSTANCE_ID, "claude-opus-5", [{ id: "contextWindow", value: "1m" }]),
    ),
    "claude-opus-5[1m]",
  );
});

it("never yields a Claude-native effort for custom models", () => {
  for (const effort of ["low", "medium", "high"]) {
    assert.equal(normalizeClaudeCliEffort(effort, "gpt-5.6-sol"), undefined);
  }
  assert.equal(normalizeClaudeCliEffort("high", "gpt-5.6-sol(high)"), undefined);
});

it("still yields Claude-native effort for built-in models", () => {
  assert.equal(normalizeClaudeCliEffort("high", "claude-opus-5"), "high");
  assert.equal(normalizeClaudeCliEffort("ultracode", "claude-fable-5"), "xhigh");
});

it("yields no effort when the model is unknown", () => {
  assert.equal(normalizeClaudeCliEffort("high", undefined), undefined);
  assert.equal(normalizeClaudeCliEffort("high", null), undefined);
});
