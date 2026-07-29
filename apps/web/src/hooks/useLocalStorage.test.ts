import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  getLocalStorageItem,
  LocalStorageOperationError,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "./useLocalStorage";

function createStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    ...overrides,
  };
}

// The module resolves its storage on every call, so a plain global stub is
// enough — no module re-import needed for it to take effect.
function useStorage(storage: Storage) {
  vi.stubGlobal("window", { localStorage: storage });
  vi.stubGlobal("localStorage", storage);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local storage errors", () => {
  it("preserves read failure context", () => {
    const cause = new Error("storage unavailable");
    useStorage(
      createStorage({
        getItem: () => {
          throw cause;
        },
      }),
    );

    try {
      getLocalStorageItem("read-key", Schema.String);
      expect.unreachable("expected the read to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LocalStorageOperationError);
      expect(error).toMatchObject({
        operation: "read",
        storageKey: "read-key",
        cause,
      });
    }
  });

  it("preserves decode failure context", () => {
    useStorage(createStorage({ getItem: () => "not-json" }));

    try {
      getLocalStorageItem("decode-key", Schema.String);
      expect.unreachable("expected decoding to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LocalStorageOperationError);
      expect(error).toMatchObject({
        operation: "decode",
        storageKey: "decode-key",
        cause: expect.anything(),
      });
    }
  });

  it("preserves write failure context", () => {
    const cause = new Error("storage quota exceeded");
    useStorage(
      createStorage({
        setItem: () => {
          throw cause;
        },
      }),
    );

    try {
      setLocalStorageItem("write-key", "value", Schema.String);
      expect.unreachable("expected the write to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LocalStorageOperationError);
      expect(error).toMatchObject({
        operation: "write",
        storageKey: "write-key",
        cause,
      });
    }
  });

  it("preserves removal failure context", () => {
    const cause = new Error("storage unavailable");
    useStorage(
      createStorage({
        removeItem: () => {
          throw cause;
        },
      }),
    );

    try {
      removeLocalStorageItem("remove-key");
      expect.unreachable("expected the removal to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LocalStorageOperationError);
      expect(error).toMatchObject({
        operation: "remove",
        storageKey: "remove-key",
        cause,
      });
    }
  });
});
