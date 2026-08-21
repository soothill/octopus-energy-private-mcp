import { describe, expect, it, vi } from "vitest";
import {
  checkForUpdates,
  compareVersions,
  formatUpdateNotice,
  UPDATE_GUIDE_URL,
  UPDATE_MANIFEST_URL
} from "../src/update-check.js";

function manifestResponse(version: string): Response {
  const manifest = Buffer.from(JSON.stringify({ version }), "utf8").toString("base64");
  return new Response(JSON.stringify({ encoding: "base64", content: manifest }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("startup update check", () => {
  it("detects a newer version and returns complete Git and ZIP instructions", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => manifestResponse("0.3.0"));
    const result = await checkForUpdates({
      enabled: true,
      currentVersion: "0.2.0",
      fetch: fetchMock,
      now: () => new Date("2026-08-21T00:00:00.000Z")
    });

    expect(result).toMatchObject({
      status: "update_available",
      current_version: "0.2.0",
      latest_version: "0.3.0",
      checked_at: "2026-08-21T00:00:00.000Z",
      instructions: {
        git: expect.stringContaining("git pull --ff-only"),
        zip: expect.stringContaining("keep a safe copy of `.env`"),
        full_guide: UPDATE_GUIDE_URL
      }
    });
    expect(formatUpdateNotice(result)).toContain("0.3.0 (installed: 0.2.0)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(UPDATE_MANIFEST_URL);
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
  });

  it("reports the installed version as current when main is not newer", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => manifestResponse("0.2.0"));
    await expect(checkForUpdates({
      enabled: true,
      currentVersion: "0.2.0",
      fetch: fetchMock
    })).resolves.toMatchObject({
      status: "current",
      current_version: "0.2.0",
      latest_version: "0.2.0"
    });
  });

  it("does not contact GitHub when disabled", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(checkForUpdates({
      enabled: false,
      currentVersion: "0.2.0",
      fetch: fetchMock
    })).resolves.toEqual({
      status: "disabled",
      current_version: "0.2.0",
      reason: "disabled_by_configuration"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails open when GitHub is unavailable or returns an invalid manifest", async () => {
    const unavailableFetch = vi.fn<typeof fetch>(async () => new Response("unavailable", { status: 503 }));
    const invalidFetch = vi.fn<typeof fetch>(async () => manifestResponse("not-semver"));

    await expect(checkForUpdates({
      enabled: true,
      currentVersion: "0.2.0",
      fetch: unavailableFetch
    })).resolves.toEqual({
      status: "unavailable",
      current_version: "0.2.0",
      reason: "request_failed"
    });
    await expect(checkForUpdates({
      enabled: true,
      currentVersion: "0.2.0",
      fetch: invalidFetch
    })).resolves.toEqual({
      status: "unavailable",
      current_version: "0.2.0",
      reason: "invalid_response"
    });
  });

  it("aborts a slow request and still allows startup to continue", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
      return manifestResponse("0.3.0");
    });

    await expect(checkForUpdates({
      enabled: true,
      currentVersion: "0.2.0",
      fetch: fetchMock,
      timeoutMs: 5
    })).resolves.toEqual({
      status: "unavailable",
      current_version: "0.2.0",
      reason: "request_failed"
    });
  });
});

describe("semantic version comparison", () => {
  it("orders stable and prerelease versions", () => {
    expect(compareVersions("0.3.0", "0.2.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0-beta.2")).toBe(1);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("not-a-version", "1.2.3")).toBeNull();
  });
});
