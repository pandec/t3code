import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  navigateAfterThreadDeletion,
  requestBulkThreadUnpinConfirmation,
} from "./useThreadActions";
import { toastManager } from "../components/ui/toast";

describe("navigateAfterThreadDeletion", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports a rejected navigation without failing the completed deletion", async () => {
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("navigation-error");

    await expect(
      navigateAfterThreadDeletion(() => Promise.reject(new Error("route unavailable"))),
    ).resolves.toBeUndefined();

    expect(addToast).toHaveBeenCalledOnce();
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Thread deleted, but navigation failed",
        description: "route unavailable",
      }),
    );
  });
});

describe("requestBulkThreadUnpinConfirmation", () => {
  it("skips the dialog when confirmation is disabled", async () => {
    let callCount = 0;
    const result = await requestBulkThreadUnpinConfirmation({
      enabled: false,
      count: 3,
      confirm: async () => {
        callCount += 1;
        return false;
      },
    });

    expect(result).toMatchObject({ _tag: "Success", value: true });
    expect(callCount).toBe(0);
  });

  it("asks once for the whole batch and returns the decision", async () => {
    const messages: string[] = [];
    const result = await requestBulkThreadUnpinConfirmation({
      enabled: true,
      count: 3,
      confirm: async (message) => {
        messages.push(message);
        return false;
      },
    });

    expect(messages).toEqual([
      "Unpin 3 threads?\nThis will move these threads out of your pinned section.",
    ]);
    expect(result).toMatchObject({ _tag: "Success", value: false });
  });

  it("uses the singular label for one pinned row", async () => {
    let message = "";
    await requestBulkThreadUnpinConfirmation({
      enabled: true,
      count: 1,
      confirm: async (nextMessage) => {
        message = nextMessage;
        return true;
      },
    });

    expect(message).toMatch(/^Unpin 1 thread\?/);
  });
});
