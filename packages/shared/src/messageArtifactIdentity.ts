import { sha256 } from "@noble/hashes/sha2";
import * as Encoding from "effect/Encoding";

export const messageArtifactTextHash = (value: string): string =>
  Encoding.encodeHex(sha256(new TextEncoder().encode(value)));
