import { useRelativeTimeState } from "../../hooks/useRelativeTimeState";

// The compact counterpart of RelativeTime ("4m", "1d", "now") for dense sidebar
// rows, where every row carries the same implicit "ago". Like RelativeTime it
// keeps counting: a label formatted inline would stay frozen under the compiler.
export function CompactRelativeTime(props: { timestamp: string }) {
  const relative = useRelativeTimeState(props.timestamp);
  if (relative.status !== "relative") return null;
  return relative.value === "just now" ? "now" : relative.value;
}
