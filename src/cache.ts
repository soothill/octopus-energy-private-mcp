import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

interface CacheEntry<T> {
  namespace: string;
  createdAt: number;
  expiresAt: number;
  value: T;
}

export interface CacheLookup<T> {
  value: T;
  stale: boolean;
  ageMs: number;
}

export interface CacheStats {
  enabled: boolean;
  directory: string;
  entries: number;
  expired_entries: number;
  bytes: number;
  namespaces: Record<string, number>;
}

export class FileCache {
  constructor(
    readonly directory: string,
    readonly enabled: boolean
  ) {}

  private fileFor(key: string): string {
    const hash = createHash("sha256").update(key).digest("hex");
    return join(this.directory, `${hash}.json`);
  }

  private async ensureDirectory(): Promise<void> {
    if (!this.enabled) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  async get<T>(key: string, allowStale = false): Promise<CacheLookup<T> | null> {
    if (!this.enabled) return null;
    try {
      const raw = await readFile(this.fileFor(key), "utf8");
      const entry = JSON.parse(raw) as CacheEntry<T>;
      const now = Date.now();
      const stale = entry.expiresAt <= now;
      if (stale && !allowStale) return null;
      return { value: entry.value, stale, ageMs: Math.max(0, now - entry.createdAt) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async set<T>(key: string, namespace: string, value: T, ttlMs: number): Promise<void> {
    if (!this.enabled) return;
    await this.ensureDirectory();
    const now = Date.now();
    const entry: CacheEntry<T> = {
      namespace,
      createdAt: now,
      expiresAt: now + ttlMs,
      value
    };
    const destination = this.fileFor(key);
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(entry));
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
  }

  async clear(namespace?: string): Promise<number> {
    if (!this.enabled) return 0;
    await this.ensureDirectory();
    let removed = 0;
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.directory, name);
      if (namespace) {
        try {
          const entry = JSON.parse(await readFile(path, "utf8")) as CacheEntry<unknown>;
          if (entry.namespace !== namespace) continue;
        } catch {
          // Corrupt cache entries are safe to remove.
        }
      }
      await rm(path, { force: true });
      removed += 1;
    }
    return removed;
  }

  async stats(): Promise<CacheStats> {
    const result: CacheStats = {
      enabled: this.enabled,
      directory: this.directory,
      entries: 0,
      expired_entries: 0,
      bytes: 0,
      namespaces: {}
    };
    if (!this.enabled) return result;
    await this.ensureDirectory();
    const now = Date.now();
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.directory, name);
      try {
        const [metadata, entry] = await Promise.all([
          stat(path),
          readFile(path, "utf8").then((raw) => JSON.parse(raw) as CacheEntry<unknown>)
        ]);
        result.entries += 1;
        result.bytes += metadata.size;
        if (entry.expiresAt <= now) result.expired_entries += 1;
        result.namespaces[entry.namespace] = (result.namespaces[entry.namespace] ?? 0) + 1;
      } catch {
        // A concurrently replaced or corrupt cache file does not invalidate the stats call.
      }
    }
    return result;
  }
}
