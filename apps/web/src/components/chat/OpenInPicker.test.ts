import { AppWindowIcon, FolderClosedIcon } from "lucide-react";
import { describe, expect, it } from "vite-plus/test";

import { FileExplorerIcon, FinderIcon } from "../Icons";
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

  it.each([
    ["MacIntel", "Finder", FinderIcon],
    ["Win32", "File Explorer", FileExplorerIcon],
    ["Linux x86_64", "Files", FolderClosedIcon],
  ] as const)("includes the file manager with its icon on %s", (platform, label, Icon) => {
    expect(resolveOpenInOptions(platform, ["cursor", "vscode", "file-manager"])).toEqual([
      expect.objectContaining({ value: "cursor", label: "Cursor" }),
      expect.objectContaining({ value: "vscode", label: "VS Code" }),
      expect.objectContaining({ value: "file-manager", label, Icon }),
    ]);
  });

  it("omits the file manager when unavailable or using remote editors", () => {
    expect(resolveOpenInOptions("MacIntel", ["vscode"])).toEqual([
      expect.objectContaining({ value: "vscode" }),
    ]);
    expect(resolveOpenInOptions("MacIntel", [])).toEqual([]);
  });
});
