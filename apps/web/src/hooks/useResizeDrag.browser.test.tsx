import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { useResizeDrag } from "./useResizeDrag";

let captured = false;

function rail() {
  const element = document.querySelector<HTMLButtonElement>("button[data-rail]")!;
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
  captured = false;
  // Frames never run, so only the pointer-up commit can resize.
  using _frames = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  const firstFinish = vi.fn();
  const secondFinish = vi.fn();
  const resizeWidth = vi.fn((width: number) => width);
  const cleanup = vi.fn();
  function Harness({ finish }: { finish: typeof firstFinish }) {
    const handlers = useResizeDrag<HTMLButtonElement>(() => ({
      width: 200,
      edge: "right",
      bounds: { min: 100, max: 500 },
      resize: resizeWidth,
      finish,
      cleanup,
    }));
    const { refresh: _refresh, ...events } = handlers;
    return <button type="button" data-rail {...events} />;
  }

  await using screen = await render(<Harness finish={firstFinish} />, {
    // A bare hook harness with no links.
    router: false,
  });
  pointer("pointerdown", 100);
  pointer("pointermove", 130);
  expect(resizeWidth).not.toHaveBeenCalled();

  await screen.rerender(<Harness finish={secondFinish} />);
  pointer("pointerup", 145);
  expect(resizeWidth).toHaveBeenCalledWith(245);
  expect(firstFinish).toHaveBeenCalledExactlyOnceWith(245, true);
  expect(secondFinish).not.toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(document.body.style.cursor).toBe("");

  pointer("lostpointercapture", 145);
  expect(firstFinish).toHaveBeenCalledOnce();
});
