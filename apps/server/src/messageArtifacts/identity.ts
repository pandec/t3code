// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

const MESSAGE_SUMMARY_RECIPE_VERSION = 1;

export const messageArtifactTextHash = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");

export const MESSAGE_SUMMARY_RECIPE_HASH = messageArtifactTextHash(
  String(MESSAGE_SUMMARY_RECIPE_VERSION),
);
