import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { confirmMock, readLocalApiMock, getClientSettingsMock, ensureHydratedMock } = vi.hoisted(
  () => {
    const confirmMock = vi.fn<(message: string, options?: unknown) => Promise<boolean>>();
    const readLocalApiMock = vi.fn<
      () =>
        | {
            dialogs: { confirm: (message: string, options?: unknown) => Promise<boolean> };
          }
        | undefined
    >();
    const getClientSettingsMock = vi.fn<() => { confirmTerminalClose: boolean }>();
    const ensureHydratedMock = vi.fn<() => Promise<void>>();
    return { confirmMock, readLocalApiMock, getClientSettingsMock, ensureHydratedMock };
  },
);

vi.mock("~/localApi", () => ({
  readLocalApi: () => readLocalApiMock(),
}));

vi.mock("~/hooks/useSettings", () => ({
  ensureClientSettingsHydrated: () => ensureHydratedMock(),
  getClientSettings: () => getClientSettingsMock(),
}));

import { confirmTerminalClose, isTerminalCloseConfirmPending } from "./terminalCloseConfirm";

/** Lets the helper get past its hydration await before assertions run. */
async function flushHydration() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("terminal close confirmation", () => {
  beforeEach(() => {
    confirmMock.mockReset();
    readLocalApiMock.mockReset();
    readLocalApiMock.mockReturnValue({ dialogs: { confirm: confirmMock } });
    getClientSettingsMock.mockReset();
    getClientSettingsMock.mockReturnValue({ confirmTerminalClose: true });
    ensureHydratedMock.mockReset();
    ensureHydratedMock.mockResolvedValue(undefined);
  });

  it("tracks pending state until the confirmation settles", async () => {
    let settle: (value: boolean) => void = () => undefined;
    confirmMock.mockImplementation(() => new Promise<boolean>((resolve) => (settle = resolve)));

    expect(isTerminalCloseConfirmPending()).toBe(false);

    const confirmation = confirmTerminalClose(["Terminal 1"]);
    await flushHydration();
    expect(isTerminalCloseConfirmPending()).toBe(true);

    settle(true);
    await expect(confirmation).resolves.toBe(true);
    expect(isTerminalCloseConfirmPending()).toBe(false);
  });

  it("clears pending state and resolves false when the dialog rejects", async () => {
    let reject: (reason?: unknown) => void = () => undefined;
    confirmMock.mockImplementation(
      () =>
        new Promise<boolean>((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );

    const confirmation = confirmTerminalClose(["Terminal 1"]);
    await flushHydration();
    expect(isTerminalCloseConfirmPending()).toBe(true);

    reject(new Error("dialog failed"));
    await expect(confirmation).resolves.toBe(false);
    expect(isTerminalCloseConfirmPending()).toBe(false);
  });

  it("names every terminal in a multi-terminal close", async () => {
    confirmMock.mockResolvedValue(true);

    await expect(confirmTerminalClose(["Terminal 1", "Development server"])).resolves.toBe(true);
    expect(confirmMock).toHaveBeenCalledWith(
      [
        "Close 2 terminals?",
        'This stops their running processes and clears their histories: "Terminal 1", "Development server".',
      ].join("\n"),
      { variant: "destructive" },
    );
  });

  it("closes without prompting when the confirmation setting is off", async () => {
    getClientSettingsMock.mockReturnValue({ confirmTerminalClose: false });

    await expect(confirmTerminalClose(["Terminal 1"])).resolves.toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(isTerminalCloseConfirmPending()).toBe(false);
  });

  it("reads the setting only after client settings hydrate", async () => {
    // A cold start holds the schema default until the persisted value lands.
    getClientSettingsMock.mockReturnValue({ confirmTerminalClose: true });
    let finishHydration: () => void = () => undefined;
    ensureHydratedMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishHydration = () => {
            getClientSettingsMock.mockReturnValue({ confirmTerminalClose: false });
            resolve();
          };
        }),
    );

    const confirmation = confirmTerminalClose(["Terminal 1"]);
    finishHydration();

    await expect(confirmation).resolves.toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("closes without prompting when no local API is available", async () => {
    readLocalApiMock.mockReturnValue(undefined);

    await expect(confirmTerminalClose(["Terminal 1"])).resolves.toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
  });
});
