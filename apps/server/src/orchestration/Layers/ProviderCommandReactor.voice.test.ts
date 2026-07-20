import { describe, expect, it } from "vite-plus/test";

import { withInputOriginNotice } from "./ProviderCommandReactor.ts";

describe("withInputOriginNotice", () => {
  it("adds a provider-only caution to voice-transcribed messages", () => {
    expect(withInputOriginNotice("change the cash key", "voice-transcription")).toBe(
      "change the cash key\n\n<voice_transcription_notice>This message was transcribed from speech and may contain recognition errors. If any wording, names, identifiers, or code seem implausible, ask the user a brief follow-up question instead of guessing.</voice_transcription_notice>",
    );
  });

  it("leaves typed messages unchanged", () => {
    expect(withInputOriginNotice("change the cache key", undefined)).toBe("change the cache key");
  });
});
