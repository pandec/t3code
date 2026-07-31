import { describe, expect, it } from "vite-plus/test";

import { formatProviderUsageEmail } from "./providerUsageEmail";

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
