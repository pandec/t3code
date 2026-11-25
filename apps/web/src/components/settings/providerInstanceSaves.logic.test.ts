import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addProviderInstanceSave,
  providerInstanceKey,
  reconcileProviderInstanceSaves,
  settleProviderInstanceSave,
} from "./providerInstanceSaves.logic";

const instanceId = ProviderInstanceId.make("codex");
const withFoo = (value: string): ProviderInstanceConfig => ({
  driver: ProviderDriverKind.make("codex"),
  environment: [{ name: "FOO", value, sensitive: false }],
});

describe("provider instance saves", () => {
  it("retires a replied save when another writer changes only a masked value", () => {
    const sent = { models: withFoo("b"), key: providerInstanceKey(withFoo("b")) };
    const replied = settleProviderInstanceSave(
      addProviderInstanceSave(new Map(), instanceId, sent, withFoo("a")),
      instanceId,
      sent,
      true,
    );

    expect(reconcileProviderInstanceSaves(replied, { [instanceId]: withFoo("a") })).toBe(replied);
    expect(reconcileProviderInstanceSaves(replied, { [instanceId]: withFoo("c") }).size).toBe(0);
  });
});
