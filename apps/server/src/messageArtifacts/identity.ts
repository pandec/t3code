import { messageArtifactTextHash } from "@t3tools/shared/messageArtifactIdentity";

export { messageArtifactTextHash };

const MESSAGE_SUMMARY_RECIPE_VERSION = 1;

export const MESSAGE_SUMMARY_RECIPE_HASH = messageArtifactTextHash(
  String(MESSAGE_SUMMARY_RECIPE_VERSION),
);
