import {
  ComposerContextId,
  EnvironmentId,
  ThreadId,
  type ComposerContextRecord,
} from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import { previewAnnotationContextId } from "../../lib/composerContextRecords";
import { toKindScopedComposerContextId } from "../../lib/composerContextReferences";
import { planMessageContextRestore } from "./messageContextRestore";

const environmentId = EnvironmentId.make("environment-local");
const threadId = ThreadId.make("thread:rewind");
const id = (value: string) => ComposerContextId.make(value);
const chip = (record: ComposerContextRecord) =>
  formatComposerContextReference({
    kind: record.kind,
    contextId: record.contextId,
    label: record.label,
  });

const terminal: ComposerContextRecord = {
  version: 1,
  kind: "terminal",
  contextId: id("terminal_old"),
  label: "build 2",
  terminalId: "terminal-1",
  terminalLabel: "build",
  lineStart: 2,
  lineEnd: 2,
  text: "error TS2322",
};
const review: ComposerContextRecord = {
  version: 1,
  kind: "review-comment",
  contextId: id("review-comment_old"),
  label: "app.ts 4",
  sectionId: "section-1",
  sectionTitle: "Changes",
  filePath: "src/app.ts",
  startIndex: 4,
  endIndex: 4,
  rangeLabel: "4",
  text: "Rename this",
  diff: "+const a = 1;",
};
const image: ComposerContextRecord = {
  version: 1,
  kind: "image",
  contextId: id("image_old"),
  label: "shot.png",
  attachmentId: "attachment-shot",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 10,
};
const annotation: ComposerContextRecord = {
  version: 1,
  kind: "preview-annotation",
  contextId: id("preview-annotation_old"),
  label: "Make it blue",
  annotationId: "annotation-old",
  pageUrl: "http://localhost:5173/",
  pageTitle: null,
  comment: "Make it blue",
  targetSummary: "1 element",
  styleChanges: [],
  screenshotContextId: id("image_old"),
};
const localThread: ComposerContextRecord = {
  version: 1,
  kind: "thread",
  contextId: id("thread_local"),
  label: "Spec",
  environmentId,
  threadId: ThreadId.make("thread:spec"),
  title: "Spec",
};
const foreignThread: ComposerContextRecord = {
  ...localThread,
  contextId: id("thread_foreign"),
  label: "Elsewhere",
  environmentId: EnvironmentId.make("environment-other"),
};
const mention: ComposerContextRecord = {
  version: 1,
  kind: "mention",
  contextId: id("mention_readme"),
  label: "README.md",
  path: "README.md",
};

let nextId = 0;
const plan = (
  text: string,
  records: ReadonlyArray<ComposerContextRecord>,
  options: { readonly labelUnmatchedReferences?: boolean } = {},
) =>
  planMessageContextRestore({
    text,
    records,
    threadId,
    environmentId,
    attachmentLocalIds: new Map([["attachment-shot", "local-shot"]]),
    existingTerminalContexts: [],
    makeId: () => `fresh-${++nextId}`,
    ...options,
  });

describe("planMessageContextRestore", () => {
  it("rebuilds each chip's payload and points the text at the rebuilt context", () => {
    const restore = plan(
      `Check ${chip(terminal)} and ${chip(review)} with ${chip(image)} and ${chip(localThread)}`,
      [terminal, review, image, localThread],
    );
    expect(restore.terminalContexts).toHaveLength(1);
    expect(restore.terminalContexts[0]).toMatchObject({ text: "error TS2322", lineStart: 2 });
    expect(restore.reviewComments).toHaveLength(1);
    expect(restore.reviewComments[0]).toMatchObject({ text: "Rename this" });
    expect(restore.threadContexts).toEqual([localThread]);
    const referenced = collectComposerContextReferences(restore.text).map(
      (reference) => reference.contextId,
    );
    expect(referenced).toEqual([
      toKindScopedComposerContextId("terminal", restore.terminalContexts[0]!.id),
      toKindScopedComposerContextId("review-comment", restore.reviewComments[0]!.id),
      toKindScopedComposerContextId("image", "local-shot"),
      localThread.contextId,
    ]);
  });

  it("keeps an annotation linked to its restored screenshot", () => {
    const restore = plan(chip(annotation), [annotation, image]);
    expect(restore.previewAnnotations).toHaveLength(1);
    expect(restore.previewAnnotations[0]!.id).toBe("local-shot");
    expect(collectComposerContextReferences(restore.text)[0]?.contextId).toBe(
      previewAnnotationContextId("local-shot"),
    );
  });

  it("turns chips it cannot rebuild into their labels", () => {
    const removedImage = { ...image, contextId: id("image_gone"), attachmentId: "gone" };
    const restore = plan(`${chip(foreignThread)} ${chip(mention)} ${chip(removedImage)}`, [
      foreignThread,
      mention,
      removedImage,
    ]);
    expect(restore.text).toBe("Elsewhere README.md shot.png");
    expect(restore.threadContexts).toEqual([]);
  });

  it("leaves references without a record alone unless asked to label them", () => {
    const text = `Keep ${chip(terminal)}`;
    expect(plan(text, []).text).toBe(text);
    expect(plan(text, [], { labelUnmatchedReferences: true }).text).toBe("Keep build 2");
  });

  it("reuses a terminal excerpt the destination draft already holds", () => {
    const restore = planMessageContextRestore({
      text: chip(terminal),
      records: [terminal],
      threadId,
      environmentId,
      attachmentLocalIds: new Map(),
      existingTerminalContexts: [
        {
          id: "existing",
          threadId,
          createdAt: "2026-10-04T00:00:00.000Z",
          terminalId: "terminal-1",
          terminalLabel: "build",
          lineStart: 2,
          lineEnd: 2,
          text: "error TS2322",
        },
      ],
    });
    expect(restore.terminalContexts).toEqual([]);
    expect(collectComposerContextReferences(restore.text)[0]?.contextId).toBe(
      toKindScopedComposerContextId("terminal", "existing"),
    );
  });
});
