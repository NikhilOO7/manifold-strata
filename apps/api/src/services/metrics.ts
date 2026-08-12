/**
 * In-process metrics collector for benchmarking LLM + embedding usage.
 *
 * Every LLM completion and embedding call is recorded here, keyed by
 * (mode, operation), so the /api/field/benchmark endpoint can prove the
 * LLM-call / token reduction of the `field` pipeline vs the `legacy` one.
 *
 * This is deliberately a simple module-level singleton — it lives for the
 * lifetime of the API process and is reset explicitly around benchmark runs.
 */

export interface MetricBucket {
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  embedCalls: number;
  embedTokens: number;
  /** Total wall time spent in this operation, so latency is attributable per role. */
  latencyMsTotal: number;
  /** Models that served this operation — a routing table cannot silently drift. */
  models: string[];
}

export interface MetricsSnapshot {
  mode: string;
  totals: MetricBucket;
  byOperation: Record<string, MetricBucket>;
}

function emptyBucket(): MetricBucket {
  return {
    llmCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    embedCalls: 0,
    embedTokens: 0,
    latencyMsTotal: 0,
    models: [],
  };
}

// key = `${mode}::${operation}`
const buckets = new Map<string, MetricBucket>();

let currentMode: string = process.env.PIPELINE_MODE || 'field';

export function setMode(mode: string): void {
  currentMode = mode;
}

export function getMode(): string {
  return currentMode;
}

function bucketFor(mode: string, operation: string): MetricBucket {
  const key = `${mode}::${operation}`;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = emptyBucket();
    buckets.set(key, bucket);
  }
  return bucket;
}

export function recordLLM(
  operation: string,
  usage?: { promptTokens?: number; completionTokens?: number },
  mode: string = currentMode,
  extra?: { model?: string; latencyMs?: number }
): void {
  const bucket = bucketFor(mode ?? currentMode, operation);
  bucket.llmCalls += 1;
  bucket.promptTokens += usage?.promptTokens ?? 0;
  bucket.completionTokens += usage?.completionTokens ?? 0;
  bucket.latencyMsTotal += extra?.latencyMs ?? 0;
  if (extra?.model && !bucket.models.includes(extra.model)) {
    bucket.models.push(extra.model);
  }
}

export function recordEmbed(
  operation: string,
  count: number,
  tokens: number = 0,
  mode: string = currentMode
): void {
  const bucket = bucketFor(mode, operation);
  bucket.embedCalls += count;
  bucket.embedTokens += tokens;
}

/** Reset metrics — for one mode, or everything when mode is omitted. */
export function reset(mode?: string): void {
  if (!mode) {
    buckets.clear();
    return;
  }
  const prefix = `${mode}::`;
  for (const key of buckets.keys()) {
    if (key.startsWith(prefix)) buckets.delete(key);
  }
}

function sumInto(target: MetricBucket, src: MetricBucket): void {
  target.llmCalls += src.llmCalls;
  target.promptTokens += src.promptTokens;
  target.completionTokens += src.completionTokens;
  target.embedCalls += src.embedCalls;
  target.embedTokens += src.embedTokens;
  target.latencyMsTotal += src.latencyMsTotal;
  for (const m of src.models) if (!target.models.includes(m)) target.models.push(m);
}

export function snapshot(mode: string = currentMode): MetricsSnapshot {
  const prefix = `${mode}::`;
  const totals = emptyBucket();
  const byOperation: Record<string, MetricBucket> = {};

  for (const [key, bucket] of buckets.entries()) {
    if (!key.startsWith(prefix)) continue;
    const operation = key.slice(prefix.length);
    byOperation[operation] = { ...bucket };
    sumInto(totals, bucket);
  }

  return { mode, totals, byOperation };
}
