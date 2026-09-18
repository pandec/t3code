import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ThreadGroup = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  orderKey: TrimmedNonEmptyString,
  // Missing on older catalogs; groups default to below Active.
  aboveActive: Schema.optionalKey(Schema.Boolean),
  // A monotonic timestamp plus a random edit ID gives concurrent edits a stable winner.
  revision: TrimmedNonEmptyString.check(Schema.isPattern(/^\d{16}:[^\s]+$/)),
  // Retained so reconnecting servers cannot resurrect a deleted group.
  deleted: Schema.Boolean,
});
export type ThreadGroup = typeof ThreadGroup.Type;
export const ThreadGroups = Schema.Array(ThreadGroup);
