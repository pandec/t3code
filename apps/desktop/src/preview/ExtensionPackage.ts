// @effect-diagnostics nodeBuiltinImport:off -- CRX3 proofs carry DER ECDSA signatures that WebCrypto cannot verify, and zip entries need raw inflate.
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const UPDATE_SERVICE_URL = "https://clients2.google.com/service/update2/crx";
const MAX_CRX_BYTES = 256 * 1024 * 1024;
const MAX_UPDATE_CHECK_BYTES = 1024 * 1024;
const UPDATE_CHECK_TIMEOUT = "30 seconds";
const DOWNLOAD_TIMEOUT = "10 minutes";
const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export class ExtensionPackageError extends Schema.TaggedError<ExtensionPackageError>()(
  "ExtensionPackageError",
  {
    stage: Schema.Literals(["updateCheck", "download", "signature", "archive", "manifest"]),
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export const isExtensionPackageError = Schema.is(ExtensionPackageError);

const fail = (stage: ExtensionPackageError["stage"], reason: string): never => {
  throw new ExtensionPackageError({ stage, reason });
};

/** Chrome spells an id as the first 16 bytes of a SHA-256 in the letters a-p. */
export const extensionIdFromHash = (hash: Uint8Array): string =>
  Buffer.from(hash.subarray(0, 16))
    .toString("hex")
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));

const extensionIdFromPublicKey = (der: Uint8Array) =>
  extensionIdFromHash(NodeCrypto.createHash("sha256").update(der).digest());

const VERSION_PATTERN = /^\d{1,9}(\.\d{1,9}){0,3}$/;

/** Orders Chrome-style dotted versions; missing parts count as zero. */
export const compareVersions = (left: string, right: string): number => {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
};

/** Chrome downloads Web Store packages from these hosts, only over https. */
const isGoogleDownloadUrl = (url: URL): boolean =>
  url.protocol === "https:" &&
  url.username === "" &&
  url.password === "" &&
  url.port === "" &&
  (url.hostname === "clients2.google.com" ||
    url.hostname === "clients2.googleusercontent.com" ||
    url.hostname.endsWith(".gvt1.com"));

export type UpdateCheckResult =
  | { readonly _tag: "NoUpdate" }
  | {
      readonly _tag: "Update";
      readonly version: string;
      readonly codebase: URL;
      readonly sha256: string | undefined;
      readonly size: number | undefined;
    };

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const readAttributes = (tag: string): Map<string, string> => {
  const attributes = new Map<string, string>();
  for (const [, name, value] of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
    attributes.set(
      name!,
      value!.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => XML_ENTITIES[entity]!),
    );
  }
  return attributes;
};

/** Reads the update2 "gupdate" response for one extension. */
export const parseUpdateCheck = (xml: string, extensionId: string): UpdateCheckResult => {
  if (!/<gupdate\b[^>]*\bprotocol="2\.0"/.test(xml)) fail("updateCheck", "Unexpected response");
  const app = [...xml.matchAll(/<app\b([^>]*)>([\s\S]*?)<\/app>/g)].find(
    ([, attributes]) => readAttributes(attributes!).get("appid") === extensionId,
  );
  if (app === undefined) return fail("updateCheck", "The response does not mention the extension");
  const appStatus = readAttributes(app[1]!).get("status");
  if (appStatus !== "ok") {
    return fail("updateCheck", `The update service answered ${safeStatus(appStatus)}`);
  }
  const updateCheck = /<updatecheck\b([^>]*)\/?>/.exec(app[2]!);
  if (updateCheck === null) return fail("updateCheck", "The response has no update check");
  const attributes = readAttributes(updateCheck[1]!);
  const status = attributes.get("status");
  if (status === "noupdate") return { _tag: "NoUpdate" };
  if (status !== "ok") {
    return fail("updateCheck", `The update service answered ${safeStatus(status)}`);
  }
  const version = attributes.get("version") ?? "";
  if (!VERSION_PATTERN.test(version)) fail("updateCheck", "The offered version is invalid");
  let codebase: URL;
  try {
    codebase = new URL(attributes.get("codebase") ?? "");
  } catch {
    return fail("updateCheck", "The download address is invalid");
  }
  if (!isGoogleDownloadUrl(codebase)) {
    fail("updateCheck", "The download address is not a Google https host");
  }
  const sha256 = attributes.get("hash_sha256")?.toLowerCase();
  if (sha256 !== undefined && !/^[0-9a-f]{64}$/.test(sha256)) {
    fail("updateCheck", "The download hash is invalid");
  }
  const sizeText = attributes.get("size");
  const size = sizeText === undefined ? undefined : Number(sizeText);
  if (size !== undefined && (!Number.isSafeInteger(size) || size <= 0 || size > MAX_CRX_BYTES)) {
    fail("updateCheck", "The download size is invalid");
  }
  return { _tag: "Update", version, codebase, sha256, size };
};

const safeStatus = (status: string | undefined) =>
  status !== undefined && /^[\w-]{1,40}$/.test(status) ? `"${status}"` : "with an error";

interface ProtoField {
  readonly field: number;
  readonly bytes?: Uint8Array;
}

const readVarint = (bytes: Uint8Array, start: number): [number, number] => {
  let value = 0;
  let offset = start;
  for (let shift = 0; shift < 35; shift += 7) {
    const byte = bytes[offset++];
    if (byte === undefined) return fail("signature", "The package header is truncated");
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [value, offset];
  }
  return fail("signature", "The package header is malformed");
};

/** Just enough protobuf for CRX3 headers: length-delimited fields, skipping scalar ones. */
const readProto = (bytes: Uint8Array): ReadonlyArray<ProtoField> => {
  const fields: Array<ProtoField> = [];
  let offset = 0;
  while (offset < bytes.length) {
    const [tag, afterTag] = readVarint(bytes, offset);
    const field = Math.floor(tag / 8);
    const wireType = tag % 8;
    offset = afterTag;
    if (wireType === 0) {
      offset = readVarint(bytes, offset)[1];
      fields.push({ field });
    } else if (wireType === 1 || wireType === 5) {
      offset += wireType === 1 ? 8 : 4;
      fields.push({ field });
    } else if (wireType === 2) {
      const [length, afterLength] = readVarint(bytes, offset);
      if (afterLength + length > bytes.length) fail("signature", "The package header is truncated");
      fields.push({ field, bytes: bytes.subarray(afterLength, afterLength + length) });
      offset = afterLength + length;
    } else {
      fail("signature", "The package header is malformed");
    }
  }
  if (offset !== bytes.length) fail("signature", "The package header is truncated");
  return fields;
};

const bytesOf = (fields: ReadonlyArray<ProtoField>, field: number) =>
  fields
    .filter((entry) => entry.field === field && entry.bytes !== undefined)
    .map((entry) => entry.bytes!);

const CRX3_SIGNED_DATA_PREFIX = Buffer.from("CRX3 SignedData\x00", "latin1");
const CRX3_RSA_PROOF = 2;
const CRX3_ECDSA_PROOF = 3;
const CRX3_SIGNED_HEADER_DATA = 10000;

export interface VerifiedCrx {
  /** The developer key, as the `key` Chrome expects in an unpacked manifest. */
  readonly publicKey: string;
  readonly archive: Uint8Array;
}

/** Verifies a CRX3 the way Chrome does before installing it, for one expected extension id. */
export const verifyCrx3 = (crx: Uint8Array, extensionId: string): VerifiedCrx => {
  const buffer = Buffer.from(crx.buffer, crx.byteOffset, crx.byteLength);
  if (buffer.length < 12 || buffer.toString("latin1", 0, 4) !== "Cr24") {
    fail("signature", "The download is not a Chrome extension package");
  }
  if (buffer.readUInt32LE(4) !== 3) fail("signature", "Only CRX3 packages are supported");
  const headerSize = buffer.readUInt32LE(8);
  if (headerSize > MAX_HEADER_BYTES || 12 + headerSize > buffer.length) {
    fail("signature", "The package header is truncated");
  }
  const header = readProto(buffer.subarray(12, 12 + headerSize));
  const archive = buffer.subarray(12 + headerSize);
  const [signedHeaderData, ...extraSignedData] = bytesOf(header, CRX3_SIGNED_HEADER_DATA);
  if (signedHeaderData === undefined || extraSignedData.length > 0) {
    return fail("signature", "The package has no signed id");
  }
  const [crxId, ...extraIds] = bytesOf(readProto(signedHeaderData), 1);
  if (crxId?.length !== 16 || extraIds.length > 0) {
    return fail("signature", "The package has no signed id");
  }
  if (extensionIdFromHash(crxId) !== extensionId) {
    fail("signature", "The package is signed for another extension");
  }
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedHeaderData.length);
  const signedData = [CRX3_SIGNED_DATA_PREFIX, length, signedHeaderData, archive];
  const proofs = [
    ...bytesOf(header, CRX3_RSA_PROOF).map((proof) => ({ proof, rsa: true })),
    ...bytesOf(header, CRX3_ECDSA_PROOF).map((proof) => ({ proof, rsa: false })),
  ];
  let developerKey: Uint8Array | undefined;
  for (const { proof, rsa } of proofs) {
    const fields = readProto(proof);
    const [key] = bytesOf(fields, 1);
    const [signature] = bytesOf(fields, 2);
    if (key === undefined || signature === undefined) fail("signature", "A signature is malformed");
    let publicKey: NodeCrypto.KeyObject;
    try {
      publicKey = NodeCrypto.createPublicKey({
        key: Buffer.from(key!),
        format: "der",
        type: "spki",
      });
    } catch {
      return fail("signature", "A signature key is malformed");
    }
    if (publicKey.asymmetricKeyType !== (rsa ? "rsa" : "ec")) {
      fail("signature", "A signature key has the wrong type");
    }
    const verifier = NodeCrypto.createVerify("sha256");
    for (const part of signedData) verifier.update(part);
    if (!verifier.verify(publicKey, Buffer.from(signature!))) {
      fail("signature", "A package signature does not match its contents");
    }
    if (rsa && extensionIdFromPublicKey(key!) === extensionId) developerKey = key;
  }
  if (developerKey === undefined) {
    return fail("signature", "The package is not signed by the extension's developer key");
  }
  return { publicKey: Buffer.from(developerKey).toString("base64"), archive };
};

export interface ArchiveFile {
  /** Validated relative path segments. */
  readonly segments: ReadonlyArray<string>;
  readonly read: () => Uint8Array;
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

const archiveSegments = (name: string): ReadonlyArray<string> => {
  const directory = name.endsWith("/");
  const trimmed = directory ? name.slice(0, -1) : name;
  // Absolute, drive-letter, backslash, and control-character names never come from Chrome's packer.
  if (trimmed === "" || /[\\:\0-\x1f]/.test(trimmed) || trimmed.startsWith("/")) {
    return fail("archive", "The package contains an unsafe file name");
  }
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("archive", "The package contains an unsafe file name");
  }
  return segments;
};

/** Lists a zip's regular files, rejecting anything that could escape or surprise the target directory. */
export const readArchive = (archive: Uint8Array): ReadonlyArray<ArchiveFile> => {
  const zip = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  let end = -1;
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 22 - 0xffff); offset--) {
    if (zip.readUInt32LE(offset) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) return fail("archive", "The package archive is malformed");
  const entryCount = zip.readUInt16LE(end + 10);
  const directorySize = zip.readUInt32LE(end + 12);
  const directoryOffset = zip.readUInt32LE(end + 16);
  if (
    zip.readUInt16LE(end + 4) !== 0 ||
    zip.readUInt16LE(end + 6) !== 0 ||
    zip.readUInt16LE(end + 8) !== entryCount ||
    entryCount === 0xffff ||
    directoryOffset === 0xffffffff ||
    directoryOffset + directorySize > end
  ) {
    return fail("archive", "The package archive is malformed or uses unsupported zip features");
  }
  if (entryCount > MAX_ENTRIES) fail("archive", "The package has too many files");
  const files: Array<ArchiveFile> = [];
  const filePaths = new Set<string>();
  const directoryPaths = new Set<string>();
  let total = 0;
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > end || zip.readUInt32LE(offset) !== 0x02014b50) {
      return fail("archive", "The package archive is malformed");
    }
    const madeBy = zip.readUInt16LE(offset + 4) >> 8;
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const crc = zip.readUInt32LE(offset + 16);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const externalAttributes = zip.readUInt32LE(offset + 38);
    const localOffset = zip.readUInt32LE(offset + 42);
    const nameBytes = zip.subarray(offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (offset > end) return fail("archive", "The package archive is malformed");
    if ((flags & 0x1) !== 0) fail("archive", "The package archive is encrypted");
    if (method !== 0 && method !== 8)
      fail("archive", "The package uses an unsupported compression");
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      fail("archive", "The package archive uses unsupported zip features");
    }
    const name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
    const segments = archiveSegments(name);
    const mode = madeBy === 3 ? externalAttributes >>> 16 : 0;
    const msDosDirectory = madeBy === 0 && (externalAttributes & 0x10) !== 0;
    const isDirectory = name.endsWith("/");
    if (isDirectory) {
      if ((mode & S_IFMT) !== 0 && (mode & S_IFMT) !== S_IFDIR) {
        fail("archive", "The package contains a link or special file");
      }
      if (size !== 0) fail("archive", "The package archive is malformed");
    } else if (((mode & S_IFMT) !== 0 && (mode & S_IFMT) !== S_IFREG) || msDosDirectory) {
      fail("archive", "The package contains a link or special file");
    }
    // Case-insensitive filesystems would merge names that differ only in case.
    const key = segments.join("/").normalize("NFC").toLowerCase();
    if (filePaths.has(key) || (!isDirectory && directoryPaths.has(key))) {
      fail("archive", "The package contains duplicate files");
    }
    for (let depth = 1; depth < segments.length + (isDirectory ? 1 : 0); depth++) {
      const parent = segments.slice(0, depth).join("/").normalize("NFC").toLowerCase();
      if (filePaths.has(parent)) fail("archive", "The package contains duplicate files");
      directoryPaths.add(parent);
    }
    if (isDirectory) continue;
    filePaths.add(key);
    if (size > MAX_ENTRY_BYTES) fail("archive", "The package contains an oversized file");
    total += size;
    if (total > MAX_UNPACKED_BYTES) fail("archive", "The package unpacks too large");
    if (localOffset + 30 > directoryOffset || zip.readUInt32LE(localOffset) !== 0x04034b50) {
      return fail("archive", "The package archive is malformed");
    }
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const dataStart = localOffset + 30 + localNameLength + zip.readUInt16LE(localOffset + 28);
    if (
      !zip.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes) ||
      dataStart + compressedSize > directoryOffset
    ) {
      fail("archive", "The package archive is malformed");
    }
    const data = zip.subarray(dataStart, dataStart + compressedSize);
    files.push({
      segments,
      read: () => {
        let content: Buffer;
        try {
          content =
            method === 0
              ? Buffer.from(data)
              : NodeZlib.inflateRawSync(data, { maxOutputLength: Math.max(size, 1) });
        } catch {
          return fail("archive", "The package archive is corrupt");
        }
        if (content.length !== size || NodeZlib.crc32(content) !== crc) {
          fail("archive", "The package archive is corrupt");
        }
        return content;
      },
    });
  }
  return files;
};

/** Checks the packaged manifest and adds the developer `key`, so Electron assigns the Web Store id. */
const prepareManifest = (
  content: Uint8Array,
  options: { readonly version: string; readonly chromeVersion: string; readonly publicKey: string },
): string => {
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
  } catch {
    return fail("manifest", "The packaged manifest.json is not valid JSON");
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return fail("manifest", "The packaged manifest.json is not an object");
  }
  const fields = manifest as Record<string, unknown>;
  if (fields.version !== options.version) {
    fail("manifest", "The package version differs from the offered update");
  }
  const minimum = fields.minimum_chrome_version;
  if (minimum !== undefined) {
    if (typeof minimum !== "string" || !VERSION_PATTERN.test(minimum)) {
      fail("manifest", "The package's minimum_chrome_version is invalid");
    }
    if (compareVersions(minimum as string, options.chromeVersion) > 0) {
      fail("manifest", "The package needs a newer Chromium than this app has");
    }
  }
  return JSON.stringify({ ...fields, key: options.publicKey }, null, 2);
};

export interface ExtensionPackageTarget {
  readonly extensionId: string;
  readonly version: string;
  readonly chromeVersion: string;
}

/** Verifies a downloaded CRX and unpacks it into a new `directory`, which is left absent when either fails. */
export const unpackExtension = Effect.fn("ExtensionPackage.unpackExtension")(function* (
  crx: Uint8Array,
  target: ExtensionPackageTarget,
  directory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const prepared = yield* Effect.try({
    try: () => {
      const verified = verifyCrx3(crx, target.extensionId);
      const files = readArchive(verified.archive);
      const manifest = files.find(
        (file) => file.segments.length === 1 && file.segments[0] === "manifest.json",
      );
      if (manifest === undefined) return fail("manifest", "The package has no manifest.json");
      const manifestText = prepareManifest(manifest.read(), {
        ...target,
        publicKey: verified.publicKey,
      });
      return { files, manifest, manifestText };
    },
    catch: (cause) =>
      isExtensionPackageError(cause)
        ? cause
        : new ExtensionPackageError({
            stage: "archive",
            reason: "The package could not be read",
            cause,
          }),
  });
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  const created = new Set<string>();
  yield* Effect.gen(function* () {
    for (const file of prepared.files) {
      const parent = path.join(directory, ...file.segments.slice(0, -1));
      if (!created.has(parent)) {
        yield* fileSystem.makeDirectory(parent, { recursive: true });
        created.add(parent);
      }
      const target = path.join(directory, ...file.segments);
      if (file === prepared.manifest) {
        yield* fileSystem.writeFileString(target, prepared.manifestText, { flag: "wx" });
        continue;
      }
      const content = yield* Effect.try({
        try: file.read,
        catch: (cause) =>
          isExtensionPackageError(cause)
            ? cause
            : new ExtensionPackageError({
                stage: "archive",
                reason: "The package archive is corrupt",
                cause,
              }),
      });
      yield* fileSystem.writeFile(target, content, { flag: "wx" });
    }
  }).pipe(
    Effect.onError(() =>
      fileSystem.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
    ),
  );
});

/** Fetches over https from Google's update hosts only, re-checking the host on every redirect. */
const getFromGoogle = Effect.fn("ExtensionPackage.getFromGoogle")(function* (
  url: URL,
  stage: "updateCheck" | "download",
) {
  const client = yield* HttpClient.HttpClient;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isGoogleDownloadUrl(current)) {
      return yield* new ExtensionPackageError({
        stage,
        reason: "The address is not a Google https host",
      });
    }
    const response = yield* client.execute(HttpClientRequest.get(current)).pipe(
      Effect.mapError(
        (cause) =>
          new ExtensionPackageError({
            stage,
            reason: "Could not reach Google's update service",
            cause,
          }),
      ),
    );
    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && location !== undefined) {
      const next = URL.parse(location, current);
      if (next === null) {
        return yield* new ExtensionPackageError({
          stage,
          reason: "Google's update service sent an invalid redirect",
        });
      }
      current = next;
      continue;
    }
    if (response.status !== 200) {
      return yield* new ExtensionPackageError({
        stage,
        reason: `Google's update service answered HTTP ${response.status}`,
      });
    }
    return response;
  }
  return yield* new ExtensionPackageError({ stage, reason: "Too many redirects" });
});

/** Counts while reading, so a body without Content-Length cannot exhaust main-process memory. */
const readBody = (
  response: HttpClientResponse.HttpClientResponse,
  limit: number,
  stage: "updateCheck" | "download",
) =>
  response.stream.pipe(
    Stream.mapError(
      (cause) =>
        new ExtensionPackageError({ stage, reason: "The response was interrupted", cause }),
    ),
    Stream.runFoldEffect(
      () => ({ chunks: [] as Array<Uint8Array>, size: 0 }),
      (body, chunk) => {
        const size = body.size + chunk.length;
        if (size > limit) {
          return Effect.fail(
            new ExtensionPackageError({ stage, reason: "The response is too large" }),
          );
        }
        body.chunks.push(chunk);
        return Effect.succeed({ chunks: body.chunks, size });
      },
    ),
    Effect.map(({ chunks, size }) => {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return bytes;
    }),
  );

/** A stalled response would otherwise hold the single update slot for good. */
const answerWithin =
  (stage: "updateCheck" | "download", duration: `${number} ${"seconds" | "minutes"}`) =>
  <A, R>(effect: Effect.Effect<A, ExtensionPackageError, R>) =>
    Effect.timeoutOrElse(effect, {
      duration,
      orElse: () =>
        Effect.fail(
          new ExtensionPackageError({
            stage,
            reason: "Google's update service did not answer in time",
          }),
        ),
    });

/** Asks Chrome's update service whether `installedVersion` is current for this Chromium. */
export const checkForUpdate = Effect.fn("ExtensionPackage.checkForUpdate")(function* (options: {
  readonly extensionId: string;
  readonly installedVersion: string | null;
  readonly chromeVersion: string;
  /** A check the user asked for; like Chrome's, it is not held back by a staged rollout. */
  readonly onDemand: boolean;
}) {
  const url = new URL(UPDATE_SERVICE_URL);
  url.searchParams.set("response", "updatecheck");
  url.searchParams.set("acceptformat", "crx3");
  url.searchParams.set("prodversion", options.chromeVersion);
  url.searchParams.set(
    "x",
    new URLSearchParams({
      id: options.extensionId,
      v: options.installedVersion ?? "0.0.0.0",
      ...(options.onDemand ? { installsource: "ondemand" } : {}),
      uc: "",
    })
      .toString()
      .replace(/=$/, ""),
  );
  const xml = yield* getFromGoogle(url, "updateCheck").pipe(
    Effect.flatMap((response) => readBody(response, MAX_UPDATE_CHECK_BYTES, "updateCheck")),
    Effect.map((bytes) => new TextDecoder().decode(bytes)),
    answerWithin("updateCheck", UPDATE_CHECK_TIMEOUT),
  );
  return yield* Effect.try({
    try: () => parseUpdateCheck(xml, options.extensionId),
    catch: (cause) =>
      isExtensionPackageError(cause)
        ? cause
        : new ExtensionPackageError({ stage: "updateCheck", reason: "Unexpected response", cause }),
  });
});

/** Downloads an offered package and checks the size and hash the update service announced. */
export const downloadPackage = Effect.fn("ExtensionPackage.downloadPackage")(function* (
  update: Extract<UpdateCheckResult, { readonly _tag: "Update" }>,
) {
  const bytes = yield* Effect.gen(function* () {
    const response = yield* getFromGoogle(update.codebase, "download");
    const declared = Number(response.headers["content-length"] ?? Number.NaN);
    if (declared > MAX_CRX_BYTES) {
      return yield* new ExtensionPackageError({
        stage: "download",
        reason: "The download is too large",
      });
    }
    return yield* readBody(response, MAX_CRX_BYTES, "download");
  }).pipe(answerWithin("download", DOWNLOAD_TIMEOUT));
  if (bytes.length > MAX_CRX_BYTES || (update.size !== undefined && bytes.length !== update.size)) {
    return yield* new ExtensionPackageError({
      stage: "download",
      reason: "The download has the wrong size",
    });
  }
  if (
    update.sha256 !== undefined &&
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== update.sha256
  ) {
    return yield* new ExtensionPackageError({
      stage: "download",
      reason: "The download has the wrong hash",
    });
  }
  return bytes;
});
