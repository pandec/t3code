import type { PointerEvent } from "react";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { useResizeDrag } from "./useResizeDrag";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("commits the final pointer position through the session that started the drag", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", { body: { style: { removeProperty: vi.fn() } } });
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const firstFinish = vi.fn();
  const secondFinish = vi.fn();
  const resizeWidth = vi.fn((width: number) => width);
  const cleanup = vi.fn();
  let handlers: ReturnType<typeof useResizeDrag<HTMLButtonElement>> | undefined;
  function Harness({ finish }: { finish: typeof firstFinish }) {
    handlers = useResizeDrag(() => ({
      width: 200,
      edge: "right",
      resize: resizeWidth,
      finish,
      cleanup,
    }));
    return null;
  }
  const rail = {
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => true,
    releasePointerCapture: vi.fn(),
  };
  const event = (clientX: number) =>
    ({
      currentTarget: rail,
      pointerId: 1,
      clientX,
      button: 0,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    }) as unknown as PointerEvent<HTMLButtonElement>;
  await act(async () => {
    renderer = create(<Harness finish={firstFinish} />);
  });
  handlers!.onPointerDown(event(100));
  handlers!.onPointerMove(event(130));
  expect(resizeWidth).not.toHaveBeenCalled();
  await act(async () => {
    renderer!.update(<Harness finish={secondFinish} />);
  });
  handlers!.onPointerUp(event(145));
  expect(resizeWidth).toHaveBeenCalledWith(245);
  expect(firstFinish).toHaveBeenCalledWith(245, true);
  expect(secondFinish).not.toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalledOnce();
  handlers!.onLostPointerCapture(event(145));
  expect(firstFinish).toHaveBeenCalledOnce();
});
