import { expect, it } from "vite-plus/test";

import { attachTimelineViewport, type TimelineNavigation } from "./timelineViewport";

it("routes document scroll keys to the active pane and local keys to their own timeline", () => {
  const primary = document.createElement("div");
  const secondary = document.createElement("div");
  for (const node of [primary, secondary]) {
    node.style.overflowY = "auto";
    Object.defineProperties(node, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 100 },
    });
    node.scrollTop = 100;
  }
  document.body.append(primary, secondary);
  let active = "primary";
  const primaryViewport = attachTimelineViewport(primary, {
    hearsDocumentKeys: () => active === "primary",
  });
  const secondaryViewport = attachTimelineViewport(secondary, {
    hearsDocumentKeys: () => active === "secondary",
  });
  using _cleanup = {
    [Symbol.dispose]() {
      primaryViewport.dispose();
      secondaryViewport.dispose();
      primary.remove();
      secondary.remove();
    },
  };
  const primaryEvents: TimelineNavigation[] = [];
  const secondaryEvents: TimelineNavigation[] = [];
  primaryViewport.subscribe((event) => primaryEvents.push(event));
  secondaryViewport.subscribe((event) => secondaryEvents.push(event));
  const scrollKey = () => new KeyboardEvent("keydown", { key: "PageUp", bubbles: true });

  document.body.dispatchEvent(scrollKey());
  expect(primaryEvents).toEqual([{ source: "key", key: "PageUp", direction: "up" }]);
  expect(secondaryEvents).toEqual([]);

  active = "secondary";
  document.body.dispatchEvent(scrollKey());
  expect(primaryEvents).toHaveLength(1);
  expect(secondaryEvents).toHaveLength(1);

  primary.dispatchEvent(scrollKey());
  expect(primaryEvents).toHaveLength(2);
  expect(secondaryEvents).toHaveLength(1);

  primaryViewport.dispose();
  active = "primary";
  document.body.dispatchEvent(scrollKey());
  expect(primaryEvents).toHaveLength(2);
  expect(secondaryEvents).toHaveLength(1);
});
