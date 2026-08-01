import type { MobileDiagnosticDetails } from "./events";
import { mobileDiagnosticsEnabled, recordMobileDiagnostic } from "./journal";

type HeaderOperation = "signature" | "stabilize";

interface OperationMetrics {
  count: number;
  totalMs: number;
  maxMs: number;
}

function emptyOperationMetrics(): OperationMetrics {
  return { count: 0, totalMs: 0, maxMs: 0 };
}

/**
 * Header options carry the screen `title`, which is a thread or project name, so
 * the exact signature length is a (weak) proxy for a name's length. Bucketing
 * keeps the only thing this metric is for — spotting signature bloat that makes
 * the per-layout comparison expensive — without recording a title-derived number.
 */
export function headerSignatureLengthBucket(length: number): string {
  if (length >= 8_192) return "8192+";
  if (length >= 2_048) return "2048-8191";
  if (length >= 512) return "512-2047";
  return "0-511";
}

export class HeaderDiagnosticMetrics {
  private signature = emptyOperationMetrics();
  private stabilize = emptyOperationMetrics();
  private applied = 0;
  private skipped = 0;
  private maxSignatureLength = 0;

  recordDuration(operation: HeaderOperation, durationMs: number): void {
    const metrics = operation === "signature" ? this.signature : this.stabilize;
    metrics.count += 1;
    metrics.totalMs += durationMs;
    metrics.maxMs = Math.max(metrics.maxMs, durationMs);
  }

  recordSignatureLength(length: number): void {
    this.maxSignatureLength = Math.max(this.maxSignatureLength, length);
  }

  recordDecision(applied: boolean): void {
    if (applied) this.applied += 1;
    else this.skipped += 1;
  }

  takeSnapshot(): MobileDiagnosticDetails | null {
    if (this.signature.count === 0 && this.stabilize.count === 0) return null;
    const snapshot = {
      stabilizeCount: this.stabilize.count,
      stabilizeTotalMs: Number(this.stabilize.totalMs.toFixed(1)),
      stabilizeMaxMs: Number(this.stabilize.maxMs.toFixed(1)),
      signatureCount: this.signature.count,
      signatureTotalMs: Number(this.signature.totalMs.toFixed(1)),
      signatureMaxMs: Number(this.signature.maxMs.toFixed(1)),
      maxSignatureBucket: headerSignatureLengthBucket(this.maxSignatureLength),
      setOptionsApplied: this.applied,
      setOptionsSkipped: this.skipped,
    };
    this.signature = emptyOperationMetrics();
    this.stabilize = emptyOperationMetrics();
    this.applied = 0;
    this.skipped = 0;
    this.maxSignatureLength = 0;
    return snapshot;
  }
}

const headerMetrics = new HeaderDiagnosticMetrics();

export function startHeaderDiagnosticWork(): number | null {
  return mobileDiagnosticsEnabled ? (globalThis.performance?.now?.() ?? Date.now()) : null;
}

export function finishHeaderDiagnosticWork(
  operation: HeaderOperation,
  startedAt: number | null,
): void {
  if (startedAt === null) return;
  const finishedAt = globalThis.performance?.now?.() ?? Date.now();
  headerMetrics.recordDuration(operation, finishedAt - startedAt);
}

export function recordHeaderSignatureLength(length: number): void {
  if (mobileDiagnosticsEnabled) headerMetrics.recordSignatureLength(length);
}

export function recordHeaderOptionsDecision(applied: boolean): void {
  if (mobileDiagnosticsEnabled) headerMetrics.recordDecision(applied);
}

export function flushHeaderDiagnosticMetrics(): void {
  if (!mobileDiagnosticsEnabled) return;
  const snapshot = headerMetrics.takeSnapshot();
  if (snapshot) recordMobileDiagnostic("header", snapshot);
}
