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
const withKey = (managementKey: string): ProviderInstanceConfig => ({
  driver: ProviderDriverKind.make("codex"),
  usageSource: {
    kind: "cliproxyapi",
    managementKey,
    ...(managementKey === "" ? { managementKeyRedacted: true } : {}),
  },
});
const save = (instance: ProviderInstanceConfig) => ({
  models: instance,
  key: providerInstanceKey(instance),
});

describe("provider instance saves", () => {
  it("retires a replied save when another writer changes only a variable value", () => {
    const sent = save(withFoo("b"));
    const replied = settleProviderInstanceSave(
      addProviderInstanceSave(new Map(), instanceId, sent, withFoo("a")),
      instanceId,
      sent,
      true,
    );

    expect(reconcileProviderInstanceSaves(replied, { [instanceId]: withFoo("a") })).toBe(replied);
    expect(reconcileProviderInstanceSaves(replied, { [instanceId]: withFoo("c") }).size).toBe(0);
  });

  it("keeps a later save to the same plain variable when the earlier one echoes", () => {
    const b = save(withFoo("b"));
    const c = save(withFoo("c"));
    const pending = addProviderInstanceSave(
      addProviderInstanceSave(new Map(), instanceId, b, withFoo("a")),
      instanceId,
      c,
      withFoo("a"),
    );

    const echoed = reconcileProviderInstanceSaves(pending, { [instanceId]: withFoo("b") });
    expect(echoed.get(instanceId)?.saves.map((entry) => entry.models)).toEqual([c.models]);
  });

  it("retires a key replacement on reply, since it reads back like the stored envelope", () => {
    const sent = save(withKey("new-key"));
    const pending = addProviderInstanceSave(new Map(), instanceId, sent, withKey(""));

    expect(settleProviderInstanceSave(pending, instanceId, sent, true, withKey("")).size).toBe(0);
  });

  it("keeps a key save when the keyless enable before it echoes", () => {
    const keyless: ProviderInstanceConfig = {
      driver: ProviderDriverKind.make("codex"),
      usageSource: { kind: "cliproxyapi", managementKey: "" },
    };
    const enable = save(keyless);
    const withNewKey = save(withKey("new-key"));
    const pending = addProviderInstanceSave(
      addProviderInstanceSave(new Map(), instanceId, enable, undefined),
      instanceId,
      withNewKey,
      undefined,
    );

    const echoed = reconcileProviderInstanceSaves(pending, { [instanceId]: keyless });
    expect(echoed.get(instanceId)?.saves.map((entry) => entry.models)).toEqual([withNewKey.models]);
  });

  it("waits for echoes when a key-only reply follows an earlier outstanding save", () => {
    const rename = save({ ...withKey(""), displayName: "B" });
    const restore = save(withKey("new-key"));
    const pending = addProviderInstanceSave(
      addProviderInstanceSave(new Map(), instanceId, rename, withKey("")),
      instanceId,
      restore,
      withKey(""),
    );

    const settled = settleProviderInstanceSave(pending, instanceId, restore, true, withKey(""));
    expect(settled.get(instanceId)?.saves).toHaveLength(2);
  });
});
