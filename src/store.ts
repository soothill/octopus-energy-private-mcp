import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConsumptionRecord, RateRecord } from "./types.js";

export type HistorySeriesType = "consumption" | "rates";

export interface ConsumptionSeriesRef {
  site: string;
  fuel: string;
  direction: string;
  meter_point: string;
  serial_number: string;
}

export interface RatesSeriesRef {
  product_code: string;
  tariff_code: string;
  kind: string;
}

export interface HistorySeriesInfo {
  key: string;
  type: HistorySeriesType;
  records: number;
  earliest: string | null;
  latest: string | null;
  bytes: number;
  updated_at: string | null;
}

export interface StoreWriteResult {
  key: string;
  type: HistorySeriesType;
  written: number;
  added: number;
  records: number;
  earliest: string | null;
  latest: string | null;
}

interface HistorySeriesManifest {
  key: string;
  type: HistorySeriesType;
  shards: Record<string, number>;
  earliest: string | null;
  latest: string | null;
  updated_at: string | null;
  /** Windows we tried to fetch but the API could not satisfy; `${from}..${to}` -> attempted-at epoch ms. */
  holes?: Record<string, number>;
}

const MAX_HOLES = 200;

function emptyManifest(key: string, type: HistorySeriesType): HistorySeriesManifest {
  return { key, type, shards: {}, earliest: null, latest: null, updated_at: null };
}

function sanitizeForPath(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
}

function shardIdFor(recordKey: string): string {
  return createHash("sha256").update(recordKey).digest("hex").slice(0, 16);
}

function utcMonth(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 7);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, path);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Persistent, on-shard history store for what-if analysis.
 *
 * Records live in monthly shard files under `<directory>/<type>/<id>/` with a
 * small manifest per series, so reads over arbitrary windows stay local and
 * writes only touch the months the records land in. Nothing here talks to
 * Octopus; the sync engine decides when to fetch.
 */
export class HistoryStore {
  private readonly writeQueues = new Map<string, Promise<unknown>>();

  constructor(readonly directory: string, readonly enabled: boolean) {}

  static consumptionKey(ref: ConsumptionSeriesRef): string {
    return `consumption:${ref.site}:${ref.fuel}:${ref.direction}:${ref.meter_point}:${ref.serial_number}`;
  }

  static ratesKey(ref: RatesSeriesRef): string {
    return `rates:${ref.product_code}:${ref.tariff_code}:${ref.kind}`;
  }

  private seriesDirectory(type: HistorySeriesType, key: string): string {
    const id = `${sanitizeForPath(key)}-${shardIdFor(key)}`;
    return join(this.directory, type, id);
  }

  private runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.writeQueues.set(key, next.catch(() => undefined));
    return next;
  }

  private manifestPath(type: HistorySeriesType, key: string): string {
    return join(this.seriesDirectory(type, key), "manifest.json");
  }

  async manifest(type: HistorySeriesType, key: string): Promise<HistorySeriesManifest | null> {
    if (!this.enabled) return null;
    return readJson<HistorySeriesManifest>(this.manifestPath(type, key));
  }

  private async loadShardRecords(
    type: HistorySeriesType,
    key: string,
    shardName: string
  ): Promise<{ consumption: ConsumptionRecord[]; rates: RateRecord[] }> {
    const shard = await readJson<{ records: unknown[] }>(
      join(this.seriesDirectory(type, key), shardName)
    );
    const records = shard?.records ?? [];
    return {
      consumption: type === "consumption" ? (records as ConsumptionRecord[]) : [],
      rates: type === "rates" ? (records as RateRecord[]) : []
    };
  }

  async readConsumption(
    key: string,
    fromTimestampMs?: number,
    toTimestampMs?: number
  ): Promise<{ records: ConsumptionRecord[]; manifest: HistorySeriesManifest | null }> {
    return this.readSeries("consumption", key, fromTimestampMs, toTimestampMs);
  }

  async readRates(
    key: string,
    fromTimestampMs?: number,
    toTimestampMs?: number
  ): Promise<{ records: RateRecord[]; manifest: HistorySeriesManifest | null }> {
    return this.readSeries("rates", key, fromTimestampMs, toTimestampMs);
  }

  private async readSeries<TRecord extends ConsumptionRecord | RateRecord>(
    type: HistorySeriesType,
    key: string,
    fromTimestampMs?: number,
    toTimestampMs?: number
  ): Promise<{ records: TRecord[]; manifest: HistorySeriesManifest | null }> {
    const manifest = await this.manifest(type, key);
    if (!manifest?.earliest) return { records: [], manifest };
    const manifestDir = this.seriesDirectory(type, key);
    const shardNames = Object.keys(manifest.shards).sort();
    const records: TRecord[] = [];
    for (const shardName of shardNames) {
      const loaded = await this.loadShardRecords(type, key, shardName);
      const typed = loaded[type === "consumption" ? "consumption" : "rates"] as TRecord[];
      for (const record of typed) {
        const at = Date.parse(recordTimeField(record));
        if (Number.isNaN(at)) continue;
        if (fromTimestampMs !== undefined && at < fromTimestampMs) continue;
        if (toTimestampMs !== undefined && at >= toTimestampMs) continue;
        records.push(record);
      }
    }
    void manifestDir;
    records.sort((a, b) => Date.parse(recordTimeField(a)) - Date.parse(recordTimeField(b)));
    return { records, manifest };
  }

  async writeConsumption(key: string, incoming: ConsumptionRecord[]): Promise<StoreWriteResult> {
    return this.writeSeries("consumption", key, incoming, "interval_start", (record) => {
      const consumption = record as ConsumptionRecord;
      return consumption.interval_start;
    });
  }

  async writeRates(key: string, incoming: RateRecord[]): Promise<StoreWriteResult> {
    return this.writeSeries("rates", key, incoming, "valid_from", (record) => {
      const rate = record as RateRecord;
      return JSON.stringify([rate.valid_from, rate.payment_method]);
    });
  }

  private async writeSeries<TRecord extends ConsumptionRecord | RateRecord>(
    type: HistorySeriesType,
    key: string,
    incoming: TRecord[],
    timeField: "interval_start" | "valid_from",
    identityOf: (record: TRecord) => string
  ): Promise<StoreWriteResult> {
    if (!this.enabled) {
      return { key, type, written: 0, added: 0, records: 0, earliest: null, latest: null };
    }
    return this.runExclusive(`${type}:${key}`, async () => {
      const manifest = (await this.manifest(type, key)) ?? emptyManifest(key, type);
      const seriesDir = this.seriesDirectory(type, key);
      await mkdir(seriesDir, { recursive: true, mode: 0o700 });

      const valid = incoming.filter(
        (record) => typeof record === "object" && record !== null && !Number.isNaN(Date.parse(recordTimeField(record)))
      );
      const byShard = new Map<string, TRecord[]>();
      for (const record of valid) {
        const shardName = utcMonth(Date.parse(recordTimeField(record)));
        const bucket = byShard.get(shardName) ?? [];
        bucket.push(record);
        byShard.set(shardName, bucket);
      }

      let added = 0;
      for (const [shardName, bucketRecords] of byShard) {
        const shardPath = join(seriesDir, shardName);
        const existing = (await readJson<{ records: TRecord[] }>(shardPath))?.records ?? [];
        const merged = new Map<string, TRecord>();
        for (const record of existing) {
          if (merged.has(identityOf(record))) continue;
          merged.set(identityOf(record), record);
        }
        const before = merged.size;
        for (const record of bucketRecords) merged.set(identityOf(record), record);
        const records = [...merged.values()].sort(
          (a, b) => Date.parse(recordTimeField(a)) - Date.parse(recordTimeField(b))
        );
        added += merged.size - before;
        await writeJsonAtomic(shardPath, { records });
        manifest.shards[shardName] = records.length;
      }

      for (const record of valid) {
        const at = recordTimeField(record);
        if (!manifest.earliest || at < manifest.earliest) manifest.earliest = at;
        if (!manifest.latest || at > manifest.latest) manifest.latest = at;
      }
      manifest.updated_at = new Date().toISOString();
      await writeJsonAtomic(this.manifestPath(type, key), manifest);

      const records = Object.values(manifest.shards).reduce((sum, count) => sum + count, 0);
      return {
        key,
        type,
        written: valid.length,
        added,
        records,
        earliest: manifest.earliest,
        latest: manifest.latest
      };
    });
  }

  async seriesInfo(): Promise<HistorySeriesInfo[]> {
    if (!this.enabled) return [];
    const results: HistorySeriesInfo[] = [];
    for (const type of ["consumption", "rates"] as HistorySeriesType[]) {
      const typeDir = join(this.directory, type);
      let ids: string[];
      try {
        ids = await readdir(typeDir);
      } catch {
        continue;
      }
      for (const id of ids) {
        const manifest = await readJson<HistorySeriesManifest>(join(typeDir, id, "manifest.json"));
        if (!manifest) continue;
        let bytes = 0;
        try {
          for (const shardName of Object.keys(manifest.shards)) {
            try {
              bytes += (await stat(join(typeDir, id, shardName))).size;
            } catch {
              // shard vanished between listing and stat; ignore
            }
          }
          bytes += (await stat(join(typeDir, id, "manifest.json"))).size;
        } catch {
          // unreadable fragments are skipped rather than failing the whole report
        }
        results.push({
          key: manifest.key,
          type,
          records: Object.values(manifest.shards).reduce((sum, count) => sum + count, 0),
          earliest: manifest.earliest,
          latest: manifest.latest,
          bytes,
          updated_at: manifest.updated_at
        });
      }
    }
    results.sort((a, b) => a.key.localeCompare(b.key));
    return results;
  }

  async holes(type: HistorySeriesType, key: string): Promise<Record<string, number>> {
    const manifest = await this.manifest(type, key);
    return manifest?.holes ?? {};
  }

  /** Record that a fetch could not cover a window, so retries back off for HOLE_RETRY_TTL_HOURS. */
  async recordHole(
    type: HistorySeriesType,
    key: string,
    fromIso: string,
    toIso: string,
    attemptedAtMs: number
  ): Promise<void> {
    await this.runExclusive(`${type}:${key}`, async () => {
      const manifest = (await this.manifest(type, key)) ?? emptyManifest(key, type);
      const holes = { ...(manifest.holes ?? {}) };
      holes[`${fromIso}..${toIso}`] = attemptedAtMs;
      const entries = Object.entries(holes).sort((a, b) => a[1] - b[1]);
      const trimmed = Object.fromEntries(entries.slice(-MAX_HOLES));
      trimmed[`${fromIso}..${toIso}`] = attemptedAtMs;
      manifest.holes = trimmed;
      await writeJsonAtomic(this.manifestPath(type, key), manifest);
    });
  }

  async clear(): Promise<{ removed_series: number }> {
    if (!this.enabled) return { removed_series: 0 };
    const info = await this.seriesInfo();
    try {
      await rm(this.directory, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; missing directory is fine
    }
    return { removed_series: info.length };
  }
}

function recordTimeField(record: ConsumptionRecord | RateRecord): string {
  return (record as ConsumptionRecord).interval_start ?? (record as RateRecord).valid_from;
}
