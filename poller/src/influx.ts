export interface Point {
  measurement: string;
  tags: Record<string, string | undefined>;
  fields: Record<string, number | string | boolean>;
  /** Unix seconds; defaults to now. */
  timestamp?: number;
}

function escapeTag(value: string): string {
  return value.replace(/([ ,=])/g, "\\$1");
}

function escapeFieldValue(value: string): string {
  return value.replace(/"/g, '\\"');
}

function lineProtocol(point: Point): string {
  const tags = Object.entries(point.tags)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${escapeTag(key)}=${escapeTag(value as string)}`)
    .sort()
    .join(",");
  const fields = Object.entries(point.fields)
    .filter(([, value]) => value !== undefined && Number.isFinite(value as number) || typeof value === "string" || typeof value === "boolean")
    .map(([key, value]) => {
      if (typeof value === "string") return `${escapeTag(key)}="${escapeFieldValue(value)}"`;
      if (typeof value === "boolean") return `${escapeTag(key)}=${value ? "true" : "false"}`;
      return `${escapeTag(key)}=${value}`;
    })
    .join(",");
  if (!fields) return "";
  const head = tags ? `${point.measurement},${tags}` : point.measurement;
  const timestamp = Math.floor(point.timestamp ?? Date.now() / 1000);
  return `${head} ${fields} ${timestamp}`;
}

export class InfluxWriter {
  constructor(
    private readonly options: {
      baseUrl: string;
      token: string;
      org: string;
      bucket: string;
      timeoutMs?: number;
      fetchFn?: typeof globalThis.fetch;
    }
  ) {}

  async write(points: Point[]): Promise<void> {
    const body = points.map(lineProtocol).filter(Boolean).join("\n");
    if (!body) return;
    const url = new URL("/api/v2/write", this.options.baseUrl);
    url.searchParams.set("org", this.options.org);
    url.searchParams.set("bucket", this.options.bucket);
    url.searchParams.set("precision", "s");
    const response = await (this.options.fetchFn ?? globalThis.fetch)(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${this.options.token}`,
        "Content-Type": "text/plain; charset=utf-8"
      },
      body,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`InfluxDB write failed: HTTP ${response.status} ${text.slice(0, 300)}`);
    }
  }

  /** Run a Flux query and return the result rows as plain objects (annotated CSV parsed). */
  async query(flux: string): Promise<Record<string, string>[]> {
    const url = new URL("/api/v2/query", this.options.baseUrl);
    url.searchParams.set("org", this.options.org);
    const response = await (this.options.fetchFn ?? globalThis.fetch)(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${this.options.token}`,
        "Content-Type": "application/json",
        Accept: "text/csv"
      },
      body: JSON.stringify({ query: flux, dialect: { header: true, annotations: ["datatype"] } }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`InfluxDB query failed: HTTP ${response.status} ${text.slice(0, 300)}`);
    }
    const csv = (await response.text()).replace(/\r/g, "");
    const rows: Record<string, string>[] = [];
    let header: string[] = [];
    for (const line of csv.split("\n")) {
      if (line.startsWith("#")) continue;
      if (line.trim() === "") {
        header = [];
        continue;
      }
      const cells = splitCsvLine(line);
      if (!header.length) {
        header = cells;
        continue;
      }
      const row: Record<string, string> = {};
      header.forEach((key, i) => (row[key] = cells[i] ?? ""));
      rows.push(row);
    }
    return rows;
  }
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      cells.push(current);
      current = "";
    } else current += ch;
  }
  cells.push(current);
  return cells;
}
