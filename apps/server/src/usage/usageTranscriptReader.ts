// @effect-diagnostics nodeBuiltinImport:off
/**
 * Raw filesystem access for transcript scanning.
 *
 * Isolated here so the rest of the usage code stays on Effect's `FileSystem`.
 * The direct `node:fs` streaming is deliberate: a cold 30-day window is ~1.4 GB
 * across ~1,500 files, and `readline` over a read stream is roughly an order of
 * magnitude cheaper than materialising each file. The equivalent Effect stream
 * pipeline is idiomatic but not fast enough to sit behind a page load.
 *
 * @module usageTranscriptReader
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import type { UsageProviderKind } from "@t3tools/contracts";

import {
  initialCodexScanState,
  mightCarryUsage,
  parseClaudeLine,
  parseCodexLine,
  type UsageRecord,
} from "./usageTranscripts.ts";

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * Lists `.jsonl` transcripts under `root` last modified at or after `sinceMs`.
 *
 * Errors on individual entries are swallowed: session files rotate and get
 * removed while the walk is in flight, and a partial listing is far better than
 * failing the page.
 */
export async function listTranscriptFiles(
  root: string,
  sinceMs: number,
): Promise<readonly TranscriptFile[]> {
  const found: TranscriptFile[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      try {
        const stats = await NodeFSP.stat(child);
        if (stats.mtimeMs >= sinceMs) {
          found.push({ path: child, size: stats.size, mtimeMs: stats.mtimeMs });
        }
      } catch {
        // Vanished between readdir and stat.
      }
    }
  };

  await walk(root);
  return found;
}

/**
 * Filesystem identity of a directory, as `device:inode`.
 *
 * Used to tell "two servers reading the same transcript directory" apart from
 * "two machines whose hostname and home path happen to match". Returns an empty
 * string when the directory cannot be stat'd.
 */
export async function readDirectoryVolumeId(path: string): Promise<string> {
  try {
    const stats = await NodeFSP.stat(path);
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return "";
  }
}

/** What one transcript yielded, once it could be read at all. */
export interface TranscriptReadResult {
  readonly records: readonly UsageRecord[];
  /**
   * Lines that advertised a usage payload but did not parse into one.
   *
   * Counted only for lines `mightCarryUsage` accepted, so Codex's
   * `turn_context`/`session_meta` lines — which legitimately reduce to no
   * record — are not mistaken for corruption.
   */
  readonly malformedRecords: number;
}

/**
 * Streams one transcript and returns what it contains, or `null` when the file
 * could not be read.
 *
 * The distinction matters twice over. To the caller's cache: a genuinely empty
 * transcript is a stable fact worth memoising, while a transient read failure
 * memoised under the same `(size, mtime)` key would silently drop that file's
 * usage until the file next changes. And to the caller's report: an unreadable
 * file means the returned totals are understated, which the source has to say
 * out loud rather than pass off as "no usage here".
 *
 * Codex carries the active model on `turn_context` lines that hold no usage of
 * their own, so those still have to pass through the reducer to keep model
 * attribution correct.
 */
export async function readTranscriptRecords(
  filePath: string,
  provider: UsageProviderKind,
): Promise<TranscriptReadResult | null> {
  const records: UsageRecord[] = [];
  const codexState = initialCodexScanState();
  let malformedRecords = 0;

  try {
    const lines = NodeReadline.createInterface({
      input: NodeFS.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (provider === "codex") {
        const carriesUsage = mightCarryUsage(line, provider);
        if (!carriesUsage && !line.includes('"turn_context"') && !line.includes('"session_meta"')) {
          continue;
        }
        const skipsBefore = codexState.deliberateSkips;
        const record = parseCodexLine(line, codexState);
        if (record !== null) records.push(record);
        // A usage-carrying line that yielded nothing is only malformed when the
        // reducer did not deliberately drop it. Fork copies, duplicate
        // re-emissions and zero-token events are read correctly and simply not
        // counted, so charging them here would understate nothing yet still
        // warn the user that their usage is incomplete.
        else if (carriesUsage && codexState.deliberateSkips === skipsBefore) {
          malformedRecords += 1;
        }
        continue;
      }

      if (!mightCarryUsage(line, provider)) continue;
      const record = parseClaudeLine(line);
      if (record !== null) records.push(record);
      else malformedRecords += 1;
    }
  } catch {
    return null;
  }

  return { records, malformedRecords };
}
