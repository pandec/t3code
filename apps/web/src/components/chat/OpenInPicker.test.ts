import { AppWindowIcon } from "lucide-react";
import { describe, expect, it } from "vite-plus/test";

import { resolveOpenInOptions } from "./OpenInPicker";

describe("resolveOpenInOptions", () => {
  it.each(["MacIntel", "Win32", "Linux x86_64"] as const)(
    "labels the file manager as the default app for a file target on %s",
    (platform) => {
      expect(resolveOpenInOptions(platform, ["vscode", "file-manager"], "file")).toEqual([
        expect.objectContaining({ value: "vscode", label: "VS Code" }),
        expect.objectContaining({
          value: "file-manager",
          label: "Default app",
          Icon: AppWindowIcon,
          kind: "generic",
        }),
      ]);
    },
  );
});
