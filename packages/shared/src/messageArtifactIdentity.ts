import { sha256 } from "@noble/hashes/sha2";
import * as Hex from "effect/encoding/Hex";

export const messageArtifactTextHash = (value: string): string =>
  Hex.encode(sha256(new TextEncoder().encode(value)));
