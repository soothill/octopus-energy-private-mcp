import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { FileCache } from "../src/cache.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("file cache", () => {
  it("uses hashed private files and supports namespace clearing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octopus-cache-test-"));
    directories.push(directory);
    const cache = new FileCache(directory, true);
    await cache.set("account:A-PRIVATE", "account", { ok: true }, 60_000);
    const names = await readdir(directory);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    expect(names[0]).not.toContain("PRIVATE");
    expect((await stat(join(directory, names[0]!))).mode & 0o077).toBe(0);
    expect(await readFile(join(directory, names[0]!), "utf8")).not.toContain("A-PRIVATE");
    expect((await cache.get<{ ok: boolean }>("account:A-PRIVATE"))?.value.ok).toBe(true);
    expect(await cache.clear("account")).toBe(1);
  });
});
