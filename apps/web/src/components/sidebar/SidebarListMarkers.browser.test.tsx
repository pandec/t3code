import { DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { sidebarMarkerId } from "../Sidebar.logic";
import { SidebarSectionPlaceholder } from "./SidebarListMarkers";

function DraggableThread() {
  const { setNodeRef, listeners, attributes } = useSortable({ id: "thread" });
  return (
    <li ref={setNodeRef}>
      <button {...attributes} {...listeners} type="button">
        Thread near the top
      </button>
    </li>
  );
}

function SidebarList() {
  const [dragging, setDragging] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor));
  return (
    <DndContext sensors={sensors} autoScroll={false} onDragStart={() => setDragging(true)}>
      <SortableContext
        items={["thread", sidebarMarkerId("settled-placeholder")]}
        strategy={verticalListSortingStrategy}
      >
        <ul aria-label="Threads" style={{ height: 200, overflowY: "auto" }}>
          <DraggableThread />
          <li aria-hidden style={{ height: 1000 }} />
          <SidebarSectionPlaceholder
            marker="settled-placeholder"
            label="Settled"
            showHint={dragging}
            isDropTarget={false}
          />
        </ul>
      </SortableContext>
    </DndContext>
  );
}

it("keeps the scroll position when picking up a thread reveals the off-screen Settled hint", async () => {
  await using screen = await render(<SidebarList />, {
    // No routing: this exercises the sortable marker's scroll behavior.
    router: false,
  });
  const list = screen.getByRole("list", { name: "Threads" }).element();
  const thread = screen.getByRole("button", { name: "Thread near the top" }).element();
  const rect = thread.getBoundingClientRect();
  expect(list.scrollTop).toBe(0);

  thread.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      isPrimary: true,
      button: 0,
      pointerId: 1,
      clientX: rect.left + 10,
      clientY: rect.top + 10,
    }),
  );
  try {
    await expect.element(screen.getByText("Settled", { exact: true })).toBeInTheDocument();
    await vi.waitFor(() => expect(list.scrollTop).toBe(0));
    await expect
      .element(screen.getByRole("button", { name: "Thread near the top" }))
      .toBeInViewport();
  } finally {
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
  }
});
