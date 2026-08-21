const REPOSITORY_URL = "https://github.com/soothill/octopus-energy-private-mcp";
export const UPDATE_MANIFEST_URL =
  "https://api.github.com/repos/soothill/octopus-energy-private-mcp/contents/package.json?ref=main";
export const UPDATE_GUIDE_URL = `${REPOSITORY_URL}/blob/main/docs/INSTALLATION.md#updating-later`;

const UPDATE_CHECK_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;

type UpdateStatusName = "disabled" | "current" | "update_available" | "unavailable" | "not_checked";

export interface UpdateInstructions {
  git: string;
  zip: string;
  full_guide: string;
}

export interface UpdateStatus {
  status: UpdateStatusName;
  current_version: string;
  latest_version?: string;
  checked_at?: string;
  message?: string;
  instructions?: UpdateInstructions;
  reason?: "disabled_by_configuration" | "request_failed" | "invalid_response";
}

interface GitHubContentsResponse {
  content?: unknown;
  encoding?: unknown;
}

interface CheckOptions {
  enabled: boolean;
  currentVersion: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => Date;
}

interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseVersion(value: string): SemanticVersion | null {
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    value.trim()
  );
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => part.length === 0 || (/^\d+$/.test(part) && part.length > 1 && part.startsWith("0")))) {
    return null;
  }
  return { major, minor, patch, prerelease };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      if (leftPart.length !== rightPart.length) return leftPart.length > rightPart.length ? 1 : -1;
      return leftPart > rightPart ? 1 : -1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

export function compareVersions(left: string, right: string): number | null {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (!parsedLeft || !parsedRight) return null;
  for (const key of ["major", "minor", "patch"] as const) {
    if (parsedLeft[key] !== parsedRight[key]) return parsedLeft[key] > parsedRight[key] ? 1 : -1;
  }
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

export function updateInstructions(): UpdateInstructions {
  return {
    git:
      "Git install: in the project folder run `git pull --ff-only`, `npm ci`, and `npm run build`, then restart ChatGPT or Codex.",
    zip:
      "ZIP install: keep a safe copy of `.env`, download and unpack the latest ZIP, copy `.env` into the new folder, run `npm ci`, `npm run build`, and `npm run setup:codex`, update the saved MCP path, then restart ChatGPT or Codex.",
    full_guide: UPDATE_GUIDE_URL
  };
}

export function notCheckedUpdateStatus(currentVersion: string): UpdateStatus {
  return { status: "not_checked", current_version: currentVersion };
}

function unavailable(currentVersion: string, reason: UpdateStatus["reason"]): UpdateStatus {
  return { status: "unavailable", current_version: currentVersion, reason };
}

export async function checkForUpdates(options: CheckOptions): Promise<UpdateStatus> {
  if (!options.enabled) {
    return {
      status: "disabled",
      current_version: options.currentVersion,
      reason: "disabled_by_configuration"
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  try {
    const response = await fetchImpl(UPDATE_MANIFEST_URL, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `octopus-energy-private-mcp/${options.currentVersion}`,
        "X-GitHub-Api-Version": "2022-11-28"
      },
      redirect: "error",
      signal: controller.signal
    });
    if (!response.ok) return unavailable(options.currentVersion, "request_failed");

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      return unavailable(options.currentVersion, "invalid_response");
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) {
      return unavailable(options.currentVersion, "invalid_response");
    }

    const envelope = JSON.parse(raw) as GitHubContentsResponse;
    if (envelope.encoding !== "base64" || typeof envelope.content !== "string") {
      return unavailable(options.currentVersion, "invalid_response");
    }
    const decoded = Buffer.from(envelope.content.replace(/\s/g, ""), "base64").toString("utf8");
    if (Buffer.byteLength(decoded) > MAX_MANIFEST_BYTES) {
      return unavailable(options.currentVersion, "invalid_response");
    }
    const manifest = JSON.parse(decoded) as { version?: unknown };
    if (typeof manifest.version !== "string") {
      return unavailable(options.currentVersion, "invalid_response");
    }
    const comparison = compareVersions(manifest.version, options.currentVersion);
    if (comparison === null) return unavailable(options.currentVersion, "invalid_response");

    const checkedAt = (options.now ?? (() => new Date()))().toISOString();
    if (comparison <= 0) {
      return {
        status: "current",
        current_version: options.currentVersion,
        latest_version: manifest.version,
        checked_at: checkedAt
      };
    }

    return {
      status: "update_available",
      current_version: options.currentVersion,
      latest_version: manifest.version,
      checked_at: checkedAt,
      message: `A newer Octopus Energy Private MCP version is available: ${manifest.version} (installed: ${options.currentVersion}).`,
      instructions: updateInstructions()
    };
  } catch {
    return unavailable(options.currentVersion, "request_failed");
  } finally {
    clearTimeout(timeout);
  }
}

export function formatUpdateNotice(status: UpdateStatus): string | null {
  if (status.status !== "update_available" || !status.message || !status.instructions) return null;
  return [
    status.message,
    status.instructions.git,
    status.instructions.zip,
    `Full update guide: ${status.instructions.full_guide}`
  ].join("\n");
}
