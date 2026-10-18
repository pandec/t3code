import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useResizeDrag } from "./useResizeDrag";

let root: Root;
let container: HTMLDivElement;
let captured = false;

beforeEach(() => {
  captured = false;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Frames never run, so only the pointer-up commit can resize.
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function rail() {
  const element = container.querySelector<HTMLButtonElement>("button")!;
  // Synthetic pointers have no active pointer for the browser to capture.
  element.setPointerCapture = () => {
    captured = true;
  };
  element.hasPointerCapture = () => captured;
  element.releasePointerCapture = () => {
    captured = false;
  };
  return element;
}

function pointer(
  type: "pointerdown" | "pointermove" | "pointerup" | "lostpointercapture",
  clientX: number,
) {
  rail().dispatchEvent(
    new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX }),
  );
}

it("commits the final pointer position through the session that started the drag", async () => {
  const firstFinish = vi.fn();
  const secondFinish = vi.fn();
  const resizeWidth = vi.fn((width: number) => width);
  const cleanup = vi.fn();
  function Harness({ finish }: { finish: typeof firstFinish }) {
    const handlers = useResizeDrag<HTMLButtonElement>(() => ({
      width: 200,
      edge: "right",
      resize: resizeWidth,
      finish,
      cleanup,
    }));
    const { refresh: _refresh, ...events } = handlers;
    return <button type="button" {...events} />;
  }

  await act(async () => root.render(<Harness finish={firstFinish} />));
  pointer("pointerdown", 100);
  pointer("pointermove", 130);
  expect(resizeWidth).not.toHaveBeenCalled();

  await act(async () => root.render(<Harness finish={secondFinish} />));
  pointer("pointerup", 145);
  expect(resizeWidth).toHaveBeenCalledWith(245);
  expect(firstFinish).toHaveBeenCalledExactlyOnceWith(245, true);
  expect(secondFinish).not.toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(document.body.style.cursor).toBe("");

  pointer("lostpointercapture", 145);
  expect(firstFinish).toHaveBeenCalledOnce();
});
