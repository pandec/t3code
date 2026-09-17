import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ThreadGroup = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  orderKey: TrimmedNonEmptyString,
  // A monotonic timestamp plus a random edit ID gives concurrent edits a stable winner.
  revision: TrimmedNonEmptyString.check(Schema.isPattern(/^\d{16}:[^\s]+$/)),
  // Retained so reconnecting servers cannot resurrect a deleted group.
  deleted: Schema.Boolean,
});
export type ThreadGroup = typeof ThreadGroup.Type;
export const ThreadGroups = Schema.Array(ThreadGroup);
export const SidebarCustomGroupsPosition = Schema.Literals(["above-active", "below-active"]);
export type SidebarCustomGroupsPosition = typeof SidebarCustomGroupsPosition.Type;
