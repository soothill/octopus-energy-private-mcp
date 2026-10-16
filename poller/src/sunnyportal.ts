import { DateTime } from "luxon";

/**
 * Sunny Portal (www.sunnyportal.com) client for legacy Webconnect inverters.
 *
 * The classic BasicJson plant-key API is gone from the ennexOS portal and the
 * Keycloak password grant is disabled for the SunnyPortalClassic client, so we
 * replay the portal's own login dance headlessly:
 *   1. prime an ASP.NET session on sunnyportal.com
 *   2. GET the Keycloak auth URL (the portal embeds its public client_secret)
 *   3. POST the credentials to the Keycloak login form
 *   4. Start.aspx answers each OAuth code with an auto-post ASP.NET form;
 *      repost it (with __EVENTTARGET=LoginBtn / __EVENTARGUMENT=ServerReturn)
 *      until the portal session is established.
 *
 * Data comes from the Analysis chart API: trigger a render with
 * ?id=mainChart&presetting=day (returns a PNG), then poll
 * ?id=mainChart&mode=last_info for the JSON data points. RawValueX is
 * plant-local wall-clock encoded as UTC, so it is re-zoned to `timezone`.
 */

export interface PvPoint {
  /** True Unix seconds (after re-zoning from plant-local wall clock). */
  ts: number;
  /** Average power over the 15-minute slot, kW. */
  kw: number;
}

const PORTAL = "https://www.sunnyportal.com";
const AUTH_URL =
  "https://login.sma.energy/auth/realms/SMA/protocol/openid-connect/auth" +
  "?response_type=code&client_id=SunnyPortalClassic" +
  "&client_secret=baa6d5fe-f905-4fb2-bc8e-8f218acc2835" +
  "&redirect_uri=" +
  encodeURIComponent(`${PORTAL}/Templates/Start.aspx?SilentLogin=true`) +
  "&ui_locales=en";
const CHART_API = `${PORTAL}/PortalCharts/Core/PortalChartsAPI.aspx`;

interface JarEntry {
  value: string;
  path: string;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export class SunnyPortalClient {
  private readonly jar = new Map<string, JarEntry>();
  private loggedIn = false;

  constructor(
    private readonly options: {
      username: string;
      password: string;
      timezone: string;
      timeoutMs?: number;
      fetchFn?: typeof globalThis.fetch;
    }
  ) {}

  private cookieHeader(url: URL): string {
    const parts: string[] = [];
    for (const [name, entry] of this.jar) {
      if (url.pathname.startsWith(entry.path)) parts.push(`${name}=${entry.value}`);
    }
    return parts.join("; ");
  }

  private storeCookies(url: URL, response: Response): void {
    // Node's Headers#get only returns the first Set-Cookie; getHeaders() keeps them all.
    const raw = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const cookie of raw) {
      const [pair, ...attrs] = cookie.split(";");
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const pathAttr = attrs.map((a) => a.trim()).find((a) => a.toLowerCase().startsWith("path="));
      const path = pathAttr ? pathAttr.slice(5).trim() : "/";
      const expired = attrs.some((a) => /^max-age=0$/i.test(a.trim()) || /expires=thu, 01 jan 1970/i.test(a.trim()));
      if (expired && !value) this.jar.delete(name);
      else this.jar.set(name, { value, path });
    }
    void url;
  }

  private async request(url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<{ status: number; location: string | null; body: string; url: string }> {
    const target = new URL(url);
    const fetchFn = this.options.fetchFn ?? globalThis.fetch;
    const response = await fetchFn(url, {
      method: init?.method ?? "GET",
      body: init?.body,
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) octopus-poller",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: this.cookieHeader(target),
        ...init?.headers
      },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000)
    });
    this.storeCookies(target, response);
    const location = response.headers.get("location");
    const body = response.status < 300 ? await response.text().catch(() => "") : "";
    return { status: response.status, location: location ? new URL(location, url).toString() : null, body, url };
  }

  private async get(url: string): Promise<{ body: string; url: string }> {
    let current = url;
    for (let hop = 0; hop < 10; hop++) {
      const response = await this.request(current);
      if (response.status >= 300 && response.status < 400 && response.location) {
        current = response.location;
        continue;
      }
      return { body: response.body, url: current };
    }
    throw new Error("sunny portal: too many redirects");
  }

  private async post(url: string, fields: Record<string, string>): Promise<{ body: string; url: string }> {
    const body = Object.entries(fields)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join("&");
    let current = url;
    for (let hop = 0; hop < 10; hop++) {
      const response = await this.request(current, { method: "POST", body });
      if (response.status >= 300 && response.status < 400 && response.location) {
        current = response.location;
        continue;
      }
      return { body: response.body, url: current };
    }
    throw new Error("sunny portal: too many redirects after POST");
  }

  async login(): Promise<void> {
    // 1. prime the ASP.NET session cookie
    await this.get(`${PORTAL}/Home`);

    // 2. Keycloak login form
    const auth = await this.get(AUTH_URL);
    const actionMatch = auth.body.match(/<form[^>]*action="([^"]+)"/);
    if (!actionMatch) throw new Error("sunny portal: Keycloak login form not found");
    let page = (await this.post(decodeEntities(actionMatch[1]), {
      username: this.options.username,
      password: this.options.password,
      credentialId: ""
    })).body;

    // 3. Start.aspx answers each code with an auto-post form; replay it.
    for (let step = 0; step < 5; step++) {
      const formMatch = page.match(/<form[^>]*action="([^"]*code=[^"]*)"/);
      if (!formMatch) break;
      const action = new URL(decodeEntities(formMatch[1]), `${PORTAL}/Templates/Start.aspx`).toString();
      const fields: Record<string, string> = {
        __EVENTTARGET: "ctl00$ContentPlaceHolder1$Logincontrol1$LoginBtn",
        __EVENTARGUMENT: "ServerReturn"
      };
      for (const input of page.match(/<input[^>]*type="hidden"[^>]*>/g) ?? []) {
        const name = input.match(/name="([^"]+)"/);
        const value = input.match(/value="([^"]*)"/);
        if (name) fields[decodeEntities(name[1])] = value ? decodeEntities(value[1]) : "";
      }
      page = (await this.post(action, fields)).body;
    }
    if (!page.includes("House Roof") && !page.includes("Start.aspx")) {
      // Not fatal: the plant name check is cosmetic; data fetch will confirm.
    }
    this.loggedIn = true;
  }

  /** Today's 15-minute PV power averages, newest last. */
  async fetchDayCurve(): Promise<PvPoint[]> {
    if (!this.loggedIn) await this.login();
    // Register the chart session, then trigger a fresh render.
    await this.get(`${PORTAL}/FixedPages/AnalysisTool.aspx`);
    await this.get(`${CHART_API}?id=mainChart&presetting=day`);
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 500 : 3000));
      const { body } = await this.get(`${CHART_API}?id=mainChart&mode=last_info&t=${Date.now()}`);
      let parsed: { Entries?: unknown[]; Error?: string | null };
      try {
        parsed = JSON.parse(body) as { Entries?: unknown[]; Error?: string | null };
      } catch {
        throw new Error("sunny portal: chart API returned non-JSON (session expired?)");
      }
      if (parsed.Error) {
        if (/session/i.test(String(parsed.Error))) {
          this.loggedIn = false;
          throw new Error(`sunny portal: ${parsed.Error}`);
        }
        continue;
      }
      const points: PvPoint[] = [];
      for (const entry of parsed.Entries ?? []) {
        const info = (entry as { Type?: string; OptionalInfo?: Record<string, string | number> }).OptionalInfo;
        const type = (entry as { Type?: string }).Type;
        if (type !== "DataPoint" || !info) continue;
        const raw = Number(info.RawValueX);
        const kw = Number(info.RawValueY);
        if (!Number.isFinite(raw) || !Number.isFinite(kw)) continue;
        points.push({ ts: this.localWallClockToEpoch(raw), kw });
      }
      if (points.length) return points.sort((a, b) => a.ts - b.ts);
    }
    throw new Error("sunny portal: chart render did not produce data points");
  }

  /** RawValueX is plant wall-clock seconds; reinterpret them in the plant timezone. */
  private localWallClockToEpoch(raw: number): number {
    const wall = DateTime.fromSeconds(raw, { zone: "utc" });
    return DateTime.fromObject(
      {
        year: wall.year, month: wall.month, day: wall.day,
        hour: wall.hour, minute: wall.minute, second: wall.second
      },
      { zone: this.options.timezone }
    ).toSeconds();
  }
}
