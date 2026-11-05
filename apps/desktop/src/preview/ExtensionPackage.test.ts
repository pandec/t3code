// @effect-diagnostics nodeBuiltinImport:off -- fixtures sign and deflate real CRX3 packages.
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import {
  checkForUpdate,
  extensionIdFromHash,
  parseUpdateCheck,
  readArchive,
  unpackExtension,
  verifyCrx3,
} from "./ExtensionPackage.ts";

interface ZipEntry {
  readonly name: string;
  readonly data?: string;
  readonly mode?: number;
}

/** A zip as Chrome's packer writes it: deflated, UTF-8 names, Unix modes. */
const makeZip = (entries: ReadonlyArray<ZipEntry>): Buffer => {
  const locals: Array<Buffer> = [];
  const central: Array<Buffer> = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const raw = Buffer.from(entry.data ?? "");
    const body = NodeZlib.deflateRawSync(raw);
    const crc = NodeZlib.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE((3 << 8) | 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(name.length, 28);
    const mode = entry.mode ?? (entry.name.endsWith("/") ? 0o40755 : 0o100644);
    header.writeUInt32LE((mode << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

const varint = (value: number): Buffer => {
  const bytes: Array<number> = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
};
const field = (number: number, bytes: Buffer) =>
  Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);

const developer = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const spki = (key: NodeCrypto.KeyObject) => key.export({ type: "spki", format: "der" });
const sha256 = (bytes: Buffer) => NodeCrypto.createHash("sha256").update(bytes).digest();
const idOf = (pair: NodeCrypto.KeyPairKeyObjectResult) =>
  extensionIdFromHash(sha256(spki(pair.publicKey)));
const EXTENSION_ID = idOf(developer);

const makeCrx = (
  archive: Buffer,
  options: {
    readonly signers?: ReadonlyArray<NodeCrypto.KeyPairKeyObjectResult>;
    readonly idFrom?: NodeCrypto.KeyPairKeyObjectResult;
  } = {},
): Buffer => {
  const crxId = sha256(spki((options.idFrom ?? developer).publicKey)).subarray(0, 16);
  const signedHeaderData = field(1, crxId);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedHeaderData.length);
  const signed = Buffer.concat([
    Buffer.from("CRX3 SignedData\x00", "latin1"),
    length,
    signedHeaderData,
    archive,
  ]);
  const proofs = (options.signers ?? [developer, stranger]).map((pair) =>
    field(
      2,
      Buffer.concat([
        field(1, spki(pair.publicKey)),
        field(2, NodeCrypto.sign("sha256", signed, pair.privateKey)),
      ]),
    ),
  );
  const header = Buffer.concat([...proofs, field(10000, signedHeaderData)]);
  const prefix = Buffer.alloc(12);
  prefix.write("Cr24", 0, "latin1");
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, archive]);
};

const manifest = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({ manifest_version: 3, name: "Test", version: "2.0.0", ...fields });
const extensionZip = (fields?: Record<string, unknown>) =>
  makeZip([
    { name: "manifest.json", data: manifest(fields) },
    { name: "icons/", mode: 0o40755 },
    { name: "icons/a.png", data: "png" },
  ]);
const TARGET = { extensionId: EXTENSION_ID, version: "2.0.0", chromeVersion: "152.0.7000.1" };

const rejectsWith = (run: () => unknown, reason: RegExp) => assert.throws(run, reason);

describe("verifyCrx3", () => {
  it("accepts a package signed by the key its id comes from", () => {
    const archive = extensionZip();
    const verified = verifyCrx3(makeCrx(archive), EXTENSION_ID);
    assert.deepStrictEqual(Buffer.from(verified.archive), archive);
    assert.strictEqual(verified.publicKey, spki(developer.publicKey).toString("base64"));
  });

  it("rejects tampering, other extensions, and missing developer proofs", () => {
    const crx = makeCrx(extensionZip());
    const tampered = Buffer.from(crx);
    tampered[tampered.length - 30]! ^= 0xff;
    rejectsWith(() => verifyCrx3(tampered, EXTENSION_ID), /does not match its contents/);
    rejectsWith(() => verifyCrx3(crx, idOf(stranger)), /signed for another extension/);
    rejectsWith(
      () => verifyCrx3(makeCrx(extensionZip(), { signers: [stranger] }), EXTENSION_ID),
      /not signed by the extension's developer key/,
    );
    // The signed crx_id names another extension even though the developer key signed it.
    rejectsWith(
      () => verifyCrx3(makeCrx(extensionZip(), { idFrom: stranger }), EXTENSION_ID),
      /signed for another extension/,
    );
    rejectsWith(() => verifyCrx3(Buffer.from("PK\x03\x04"), EXTENSION_ID), /not a Chrome/);
  });
});

describe("readArchive", () => {
  it("rejects entries that could leave or confuse the target directory", () => {
    const cases: ReadonlyArray<[ReadonlyArray<ZipEntry>, RegExp]> = [
      [[{ name: "../evil.js", data: "x" }], /unsafe file name/],
      [[{ name: "a/../../evil.js", data: "x" }], /unsafe file name/],
      [[{ name: "/etc/evil.js", data: "x" }], /unsafe file name/],
      [[{ name: "a\\..\\evil.js", data: "x" }], /unsafe file name/],
      [[{ name: "C:/evil.js", data: "x" }], /unsafe file name/],
      [[{ name: "link.js", data: "/etc/passwd", mode: 0o120777 }], /link or special file/],
      [[{ name: "fifo", mode: 0o010644 }], /link or special file/],
      [
        [
          { name: "a.js", data: "1" },
          { name: "a.js", data: "2" },
        ],
        /duplicate files/,
      ],
      [
        [
          { name: "A.js", data: "1" },
          { name: "a.js", data: "2" },
        ],
        /duplicate files/,
      ],
      [
        [
          { name: "a", data: "1" },
          { name: "a/b.js", data: "2" },
        ],
        /duplicate files/,
      ],
    ];
    for (const [entries, reason] of cases) {
      rejectsWith(() => readArchive(makeZip(entries)), reason);
    }
  });

  it("rejects a file whose content does not match its checksum", () => {
    const [file] = readArchive(makeZip([{ name: "a.js", data: "hello" }]));
    assert.strictEqual(Buffer.from(file!.read()).toString(), "hello");
    const corrupt = makeZip([{ name: "a.js", data: "hello" }]);
    // Corrupt the central directory's CRC for the only entry.
    corrupt.writeUInt32LE(0, corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 16);
    const [bad] = readArchive(corrupt);
    rejectsWith(() => bad!.read(), /corrupt/);
  });
});

describe("unpackExtension", () => {
  it.effect("writes a verified package with its developer key, and nothing otherwise", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const directory = path.join(root, "out");

      yield* unpackExtension(makeCrx(extensionZip()), TARGET, directory);
      const written = JSON.parse(
        yield* fileSystem.readFileString(path.join(directory, "manifest.json")),
      );
      assert.strictEqual(written.version, "2.0.0");
      assert.strictEqual(
        extensionIdFromHash(sha256(Buffer.from(written.key, "base64"))),
        EXTENSION_ID,
      );
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(directory, "icons/a.png")),
        "png",
      );

      const refused = [
        [makeCrx(extensionZip({ version: "2.0.1" })), /differs from the offered update/],
        [makeCrx(extensionZip({ minimum_chrome_version: "153" })), /newer Chromium/],
        [makeCrx(makeZip([{ name: "../x", data: "x" }])), /unsafe file name/],
      ] as const;
      for (const [crx, reason] of refused) {
        const target = path.join(root, "refused");
        const error = yield* unpackExtension(crx, TARGET, target).pipe(Effect.flip);
        assert.match(error.message, reason);
        assert.isFalse(yield* fileSystem.exists(target));
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

// Trimmed from a real response for Dashlane with v=0.0.0.0.
const UPDATE_XML = `<?xml version="1.0" encoding="UTF-8"?><gupdate xmlns="http://www.google.com/update2/response" protocol="2.0" server="prod"><daystart elapsed_days="7248" elapsed_seconds="10728"/><app appid="${EXTENSION_ID}" cohort="1::" cohortname="" status="ok"><updatecheck _esbAllowlist="true" codebase="https://clients2.googleusercontent.com/crx/blobs/AbC/EXT_6_2645_0_0.crx" fp="1.076d" hash_sha256="076d7e280b7a5f0afe167f12d1454cec54563f6130a5791638c8204db3902fe0" protected="0" size="25801698" status="ok" version="6.2645.0"/></app></gupdate>`;

describe("parseUpdateCheck", () => {
  it("reads an offered update, no update, and refuses errors and foreign hosts", () => {
    assert.deepInclude(parseUpdateCheck(UPDATE_XML, EXTENSION_ID), {
      _tag: "Update",
      version: "6.2645.0",
      sha256: "076d7e280b7a5f0afe167f12d1454cec54563f6130a5791638c8204db3902fe0",
      size: 25801698,
    });
    assert.deepStrictEqual(
      parseUpdateCheck(
        UPDATE_XML.replace(
          /<updatecheck[^>]*\/>/,
          '<updatecheck _esbAllowlist="true" status="noupdate"/>',
        ),
        EXTENSION_ID,
      ),
      { _tag: "NoUpdate" },
    );
    rejectsWith(
      () =>
        parseUpdateCheck(
          UPDATE_XML.replace(
            'status="ok"><updatecheck',
            'status="error-unknownApplication"><updatecheck',
          ),
          EXTENSION_ID,
        ),
      /answered "error-unknownApplication"/,
    );
    rejectsWith(
      () =>
        parseUpdateCheck(
          UPDATE_XML.replace('status="ok" version', 'status="error-internal" version'),
          EXTENSION_ID,
        ),
      /answered "error-internal"/,
    );
    for (const codebase of [
      "https://evil.example/x.crx",
      "http://clients2.googleusercontent.com/x.crx",
      "https://clients2.googleusercontent.com.evil.example/x.crx",
    ]) {
      rejectsWith(
        () =>
          parseUpdateCheck(
            UPDATE_XML.replace(/codebase="[^"]*"/, `codebase="${codebase}"`),
            EXTENSION_ID,
          ),
        /not a Google https host/,
      );
    }
    assert.deepInclude(
      parseUpdateCheck(
        UPDATE_XML.replace(
          /codebase="[^"]*"/,
          'codebase="https://edgedl.me.gvt1.com/x.crx?a=1&amp;b=2"',
        ),
        EXTENSION_ID,
      ),
      { codebase: new URL("https://edgedl.me.gvt1.com/x.crx?a=1&b=2") },
    );
    rejectsWith(() => parseUpdateCheck(UPDATE_XML, idOf(stranger)), /does not mention/);
  });

  it.effect("asks for the installed version as this Chromium, like Chrome", () =>
    Effect.gen(function* () {
      const urls: Array<string> = [];
      const client = HttpClient.make((request, url) =>
        Effect.sync(() => {
          urls.push(url.href);
          return HttpClientResponse.fromWeb(request, new Response(UPDATE_XML));
        }),
      );
      const result = yield* checkForUpdate({
        extensionId: EXTENSION_ID,
        installedVersion: null,
        chromeVersion: "152.0.7000.1",
        onDemand: true,
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));
      assert.strictEqual(result._tag, "Update");
      const url = new URL(urls[0]!);
      assert.strictEqual(
        url.origin + url.pathname,
        "https://clients2.google.com/service/update2/crx",
      );
      assert.strictEqual(url.searchParams.get("prodversion"), "152.0.7000.1");
      assert.strictEqual(url.searchParams.get("acceptformat"), "crx3");
      assert.strictEqual(
        url.searchParams.get("x"),
        `id=${EXTENSION_ID}&v=0.0.0.0&installsource=ondemand&uc`,
      );
    }),
  );

  it.effect("gives up on oversized or stalled responses instead of waiting forever", () =>
    Effect.gen(function* () {
      const check = (respond: (request: HttpClientRequest.HttpClientRequest) => Response) =>
        checkForUpdate({
          extensionId: EXTENSION_ID,
          installedVersion: null,
          chromeVersion: "152.0.7000.1",
          onDemand: false,
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => HttpClientResponse.fromWeb(request, respond(request))),
            ),
          ),
          Effect.flip,
        );

      // No Content-Length, so only counting while reading can stop it.
      const huge = new ReadableStream<Uint8Array>({
        pull: (controller) => controller.enqueue(new Uint8Array(64 * 1024)),
      });
      const tooLarge = yield* check(() => new Response(huge));
      assert.match(tooLarge.reason, /too large/);

      const stalled = yield* check(() => new Response(new ReadableStream())).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("1 minute");
      assert.match((yield* Fiber.join(stalled)).reason, /did not answer/);
    }),
  );
});
