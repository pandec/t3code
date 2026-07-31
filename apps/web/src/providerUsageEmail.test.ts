import { describe, expect, it } from "vite-plus/test";

import { formatProviderUsageEmail, newestProviderUsageObservedAt } from "./providerUsageEmail";

describe("formatProviderUsageEmail", () => {
  it("shows the address in full unless masking is requested", () => {
    // Masking is opt-in (Extras -> Provider usage), so the default must be the
    // untouched address.
    expect(formatProviderUsageEmail("bartosz@gmail.com")).toBe("bartosz@gmail.com");
    expect(formatProviderUsageEmail("bartosz@gmail.com", false)).toBe("bartosz@gmail.com");
  });

  it("masks to a fixed width so it leaks neither the local part nor its length", () => {
    expect(formatProviderUsageEmail("bartosz@gmail.com", true)).toBe("b•••@gmail.com");
    expect(formatProviderUsageEmail("bd@gmail.com", true)).toBe("b•••@gmail.com");
  });

  it("degrades safely when the value is not an address", () => {
    // Never echo an unrecognised value back verbatim while masking is on.
    expect(formatProviderUsageEmail("not-an-email", true)).toBe("n•••");
    expect(formatProviderUsageEmail("", true)).toBe("•••");
  });
});

describe("newestProviderUsageObservedAt", () => {
  it("reports the newest observation, or 0 when there is nothing", () => {
    expect(newestProviderUsageObservedAt(undefined)).toBe(0);
    expect(newestProviderUsageObservedAt([])).toBe(0);
    expect(newestProviderUsageObservedAt([{ observedAt: 5 }, { observedAt: 9 }])).toBe(9);
  });

  it("does not advance when a refresh returned nothing new", () => {
    // The refresh RPC succeeds even if every probe failed, so an unchanged
    // newest-observation is how the client tells "refreshed" from "no-op".
    const before = newestProviderUsageObservedAt([{ observedAt: 9 }]);
    const after = newestProviderUsageObservedAt([{ observedAt: 9 }]);
    expect(after <= before).toBe(true);
  });
});
