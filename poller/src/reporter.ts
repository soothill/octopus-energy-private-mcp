import nodemailer from "nodemailer";
import { DateTime } from "luxon";
import type { PollerConfig } from "./config.js";
import type { InfluxWriter } from "./influx.js";

const SLOT_MS = 1_800_000;

interface DayFlow {
  minute: number; // UK minutes from midnight
  importKwh: number;
  exportKwh: number;
  pvKwh: number;
}

interface Scenario {
  name: string;
  importCostP: number;
  exportRevP: number;
  standingP: number;
  note?: string;
}

interface NewportPvDay {
  day: string;
  kwh: number;
  peakKw: number;
  peakMinute: number;
}

const netGain = (s: Scenario): number => s.exportRevP - s.importCostP - s.standingP;

interface ReportData {
  day: string;
  flows: DayFlow[];
  coverage: number;
  pvKwh: number;
  importKwh: number;
  exportKwh: number;
  scenarios: Scenario[];
  optimisedUpliftP: number;
  optimisedNote: string;
  cumulative: { days: number; totals: Record<string, number>; last7: Record<string, number>; last30: Record<string, number> };
}

function ukSlot(iso: string): { day: string; minute: number } {
  const t = new Date(new Date(iso).getTime() + 3600e3); // BST in season
  return { day: t.toISOString().slice(0, 10), minute: t.getUTCHours() * 60 + t.getUTCMinutes() };
}

const money = (pence: number): string => `£${(pence / 100).toFixed(2)}`;

async function fetchFlows(influx: InfluxWriter, bucket: string, from: Date, to: Date): Promise<DayFlow[]> {
  const rows = await influx.query(`from(bucket:"${bucket}")
  |> range(start: ${from.toISOString()}, stop: ${to.toISOString()})
  |> filter(fn: (r) => r._measurement == "sigenergy_plant" and contains(value: r._field, set: ["plant_grid_sensor_active_power", "plant_sigen_photovoltaic_power"]))
  |> group(columns: ["_field"])
  |> window(every: 30m)
  |> mean(column: "_value")
  |> map(fn: (r) => ({slot: string(v: r._stop), field: r._field, kw: r._value}))
  |> group()`);
  const bySlot = new Map<number, { grid?: number; pv?: number }>();
  for (const row of rows) {
    const { minute } = ukSlot(row.slot);
    const entry = bySlot.get(minute) ?? {};
    if (row.field === "plant_grid_sensor_active_power") entry.grid = Number(row.kw);
    if (row.field === "plant_sigen_photovoltaic_power") entry.pv = Number(row.kw);
    bySlot.set(minute, entry);
  }
  const flows: DayFlow[] = [];
  for (const [minute, entry] of [...bySlot].sort((a, b) => a[0] - b[0])) {
    flows.push({
      minute,
      importKwh: entry.grid && entry.grid > 0 ? entry.grid * 0.5 : 0,
      exportKwh: entry.grid && entry.grid < 0 ? -entry.grid * 0.5 : 0,
      pvKwh: (entry.pv ?? 0) * 0.5
    });
  }
  return flows;
}

/**
 * Daily Newport PV totals from sma_pv points (written by the Sunny Portal
 * module). Returns one entry per UK day with data, oldest first.
 */
async function fetchNewportPv(
  influx: InfluxWriter,
  bucket: string,
  site: string,
  tz: string,
  from: DateTime,
  to: DateTime
): Promise<NewportPvDay[]> {
  const rows = await influx.query(`from(bucket:"${bucket}")
  |> range(start: ${from.toUTC().toISO()}, stop: ${to.toUTC().toISO()})
  |> filter(fn: (r) => r._measurement == "sma_pv" and r.site == "${site}")
  |> group(columns: ["_field", "_time"])
  |> first()
  |> group()
  |> keep(columns: ["_field", "_time", "_value"])`);
  const byDay = new Map<string, NewportPvDay>();
  for (const row of rows) {
    if (!row._time) continue;
    const t = DateTime.fromISO(row._time).setZone(tz);
    if (!t.isValid) continue;
    const value = Number(row._value);
    if (!Number.isFinite(value)) continue;
    const day = t.toISODate()!;
    const entry = byDay.get(day) ?? { day, kwh: 0, peakKw: 0, peakMinute: 0 };
    if (row._field === "energy_kwh") entry.kwh += value;
    if (row._field === "power_kw" && value > entry.peakKw) {
      entry.peakKw = value;
      entry.peakMinute = t.hour * 60 + t.minute;
    }
    byDay.set(day, entry);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

async function fetchPriceMaps(
  influx: InfluxWriter,
  bucket: string,
  site: string,
  from: Date,
  to: Date
): Promise<Record<string, Map<number, number>>> {
  const rows = await influx.query(`from(bucket:"${bucket}")
  |> range(start: ${from.toISOString()}, stop: ${to.toISOString()})
  |> filter(fn: (r) => r._measurement == "octopus_price" and r._field == "value_inc_vat" and r.site == "${site}")
  |> group(columns: ["tariff_code", "_time"])
  |> first()
  |> group()
  |> keep(columns: ["tariff_code", "_time", "_value"])`);
  const maps: Record<string, Map<number, number>> = {
    agileImport: new Map(),
    agileExport: new Map(),
    varExport: new Map(),
    primeExport: new Map(),
    currentImport: new Map()
  };
  for (const row of rows) {
    const code: string = row.tariff_code ?? "";
    const { minute } = ukSlot(row._time);
    const value = Number(row._value);
    if (!Number.isFinite(value)) continue;
    if (code.includes("AGILE-24-10-01")) maps.agileImport.set(minute, value);
    else if (code.includes("AGILE-OUT")) maps.agileExport.set(minute, value);
    else if (code.includes("OUTGOING-VAR")) maps.varExport.set(minute, value);
    else if (code.includes("PRIME")) maps.primeExport.set(minute, value);
    else maps.currentImport.set(minute, value); // site's own tariff feed
  }
  return maps;
}

async function fetchStandingCharges(tariffCode: string, region: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const currentProduct = tariffCode.replace(/^E-1R-/, "").replace(new RegExp(`-${region}$`), "");
  const fetchOne = async (label: string, product: string, code: string) => {
    try {
      const url = `https://api.octopus.energy/v1/products/${product}/electricity-tariffs/${code}/standing-charges/?page_size=1&order_by=-valid_from`;
      const body = (await (await fetch(url, { signal: AbortSignal.timeout(15_000) })).json()) as {
        results?: { value_inc_vat: number }[];
      };
      const value = body.results?.[0]?.value_inc_vat;
      if (typeof value === "number") out[label] = value;
    } catch {
      /* standing charges are best-effort */
    }
  };
  await Promise.all([
    fetchOne("current", currentProduct, tariffCode),
    fetchOne("go", "GO-VAR-22-10-14", `E-1R-GO-VAR-22-10-14-${region}`),
    fetchOne("agileImport", "AGILE-24-10-01", `E-1R-AGILE-24-10-01-${region}`),
    fetchOne("agileExport", "AGILE-OUTGOING-19-05-13", `E-1R-AGILE-OUTGOING-19-05-13-${region}`)
  ]);
  return out;
}

function rateAt(map: Map<number, number>, minute: number, fallback = 0): number {
  return map.get(minute) ?? fallback;
}

function computeScenarios(data: { flows: DayFlow[] }, prices: Record<string, Map<number, number>>, config: PollerConfig, goDayPence: number): Scenario[] {
  const flows = data.flows;
  const cheap = (minute: number) => {
    const [start, end] = config.battery.cheapImportWindow.split("-").map((w) => {
      const [h, m] = w.split(":").map(Number);
      return h * 60 + m;
    });
    return end > start ? minute >= start && minute < end : minute >= start || minute < end;
  };
  const goRate = (minute: number) => (cheap(minute) ? config.battery.cheapImportPence : goDayPence);
  const sum = (fn: (f: DayFlow) => number) => flows.reduce((total, f) => total + fn(f), 0);
  return [
    {
      name: "Current tariff (no export deal)",
      importCostP: sum((f) => f.importKwh * rateAt(prices.currentImport, f.minute)),
      exportRevP: 0,
      standingP: 0
    },
    {
      name: "Go import + Outgoing VAR export",
      importCostP: sum((f) => f.importKwh * goRate(f.minute)),
      exportRevP: sum((f) => f.exportKwh * rateAt(prices.varExport, f.minute)),
      standingP: 0
    },
    {
      name: "Go import + Agile export",
      importCostP: sum((f) => f.importKwh * goRate(f.minute)),
      exportRevP: sum((f) => f.exportKwh * rateAt(prices.agileExport, f.minute)),
      standingP: 0
    },
    {
      name: "Go import + Prime export",
      importCostP: sum((f) => f.importKwh * goRate(f.minute)),
      exportRevP: sum((f) => f.exportKwh * rateAt(prices.primeExport, f.minute)),
      standingP: 0
    },
    {
      name: "Agile import + Agile export",
      importCostP: sum((f) => f.importKwh * rateAt(prices.agileImport, f.minute)),
      exportRevP: sum((f) => f.exportKwh * rateAt(prices.agileExport, f.minute)),
      standingP: 0
    }
  ];
}

interface OptimisedResult {
  upliftP: number;
  chargeKwh: number;
  chargeCostP: number;
  morningRevP: number;
  shiftedKwh: number;
  shiftedMiddayP: number;
  eveningRevP: number;
  note: string;
}

/**
 * Replay the user's battery strategy on the day's actual prices and solar:
 *  1. charge from the grid overnight in the cheap window (Go 7p)
 *  2. export most of it into the highest morning export rates
 *  3. let solar refill the battery through the middle of the day
 *  4. export most of that between 16:00-19:00, holding back a reserve
 *  5. the reserve (solar-topped) covers evening load until the cheap window restarts
 * Each cycle only counts if it was actually profitable on the day's prices.
 * The reserve earns no import credit: the actual battery already covered the
 * evening load, so the night-charge import is the strategy's only extra import.
 */
function optimisedUplift(flows: DayFlow[], prices: Record<string, Map<number, number>>, config: PollerConfig): OptimisedResult {
  const C = config.battery.capacityKwh;
  const eff = config.battery.efficiency;
  const reserve = config.battery.reserveKwh;
  const perSlotDis = config.battery.dischargeKw * 0.5;
  const morning = flows.filter((f) => f.minute >= 360 && f.minute < 600).sort((a, b) => rateAt(prices.agileExport, b.minute) - rateAt(prices.agileExport, a.minute));
  const evening = flows.filter((f) => f.minute >= 960 && f.minute < 1140).sort((a, b) => rateAt(prices.agileExport, b.minute) - rateAt(prices.agileExport, a.minute));
  const middayExports = flows
    .filter((f) => f.minute >= 600 && f.minute < 930 && f.exportKwh > 0)
    .sort((a, b) => rateAt(prices.agileExport, a.minute) - rateAt(prices.agileExport, b.minute));

  // Cycle A: overnight grid charge -> highest morning export rates
  const chargeCostP = C * config.battery.cheapImportPence;
  let out = C * eff;
  let morningRevP = 0;
  for (const f of morning) {
    if (out <= 0) break;
    const k = Math.min(perSlotDis, out);
    morningRevP += k * rateAt(prices.agileExport, f.minute);
    out -= k;
  }
  const cycleA = morningRevP - chargeCostP;
  const doA = cycleA > 0;

  // Cycle B: solar refill from the day's actual surplus -> 16:00-19:00 export, down to reserve
  let room = C - reserve;
  let shiftedKwh = 0;
  let shiftedMiddayP = 0;
  for (const f of middayExports) {
    if (room <= 0) break;
    const k = Math.min(room, f.exportKwh);
    shiftedKwh += k;
    shiftedMiddayP += k * rateAt(prices.agileExport, f.minute);
    room -= k;
  }
  let rem = shiftedKwh * eff;
  let eveningRevP = 0;
  for (const f of evening) {
    if (rem <= 0) break;
    const k = Math.min(perSlotDis, rem);
    eveningRevP += k * rateAt(prices.agileExport, f.minute);
    rem -= k;
  }
  const cycleB = eveningRevP - shiftedMiddayP;
  const doB = cycleB > 0 && shiftedKwh > 0;

  const upliftP = (doA ? cycleA : 0) + (doB ? cycleB : 0);
  const parts: string[] = [];
  parts.push(doA ? `night charge ${C} kWh @ ${config.battery.cheapImportPence}p out at the morning peak ${money(cycleA)}` : "night cycle skipped (unprofitable on the day)");
  parts.push(doB ? `solar shift ${shiftedKwh.toFixed(1)} kWh midday→16:00-19:00 ${money(cycleB)}` : "no solar surplus to shift");
  parts.push(`reserve ${reserve} kWh held back for evening load (solar-topped, no extra import)`);
  return {
    upliftP,
    chargeKwh: doA ? C : 0,
    chargeCostP: doA ? chargeCostP : 0,
    morningRevP: doA ? morningRevP : 0,
    shiftedKwh: doB ? shiftedKwh : 0,
    shiftedMiddayP: doB ? shiftedMiddayP : 0,
    eveningRevP: doB ? eveningRevP : 0,
    note: parts.join(" · ")
  };
}

const signed = (pence: number): string => {
  const value = pence / 100;
  const colour = value > 0.005 ? "#0a7a2f" : value < -0.005 ? "#b3261e" : "#555";
  return `<span style="color:${colour}">${value >= 0 ? "+" : "−"}£${Math.abs(value).toFixed(2)}</span>`;
};

const hhmm = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/** Newport PV block: yesterday's generation from sma_pv, plus the last week of dailies. */
function newportPvSection(days: NewportPvDay[], day: string): { html: string; kwh: number | null } {
  const yesterday = days.find((d) => d.day === day);
  if (!yesterday || yesterday.kwh <= 0) return { html: "", kwh: null };
  const prior = days.filter((d) => d.day < day).slice(-7);
  const avg = prior.length ? prior.reduce((t, d) => t + d.kwh, 0) / prior.length : 0;
  const week = days.slice(-7);
  const head = week
    .map((d) => `<td align="center" style="padding:3px 6px;background:#f4f4f4">${d.day.slice(5)}</td>`)
    .join("");
  const cells = week
    .map(
      (d) =>
        `<td align="center" style="padding:3px 6px${d.day === day ? ";background:#eef7ee" : ""}"><b>${d.kwh.toFixed(1)}</b></td>`
    )
    .join("");
  const html = `<h3 style="margin:16px 0 4px">Newport Pagnell PV — House Roof (SMA SB3000TL-20, 3.2 kWp)</h3>
<p style="margin:0 0 6px">Generated <b>${yesterday.kwh.toFixed(1)} kWh</b>${
    yesterday.peakKw > 0 ? ` · peak ${yesterday.peakKw.toFixed(2)} kW at ${hhmm(yesterday.peakMinute)}` : ""
  }${avg > 0 ? ` · previous 7-day average ${avg.toFixed(1)} kWh/day` : ""}</p>
<table border="1" cellpadding="2" cellspacing="0" style="border-collapse:collapse;border-color:#ddd">
<tr>${head}</tr>
<tr>${cells}</tr>
</table>
<p style="color:#888;font-size:12px;margin:4px 0 0">Sunny Portal 15-minute averages; the legacy Webconnect card uploads in bursts, so the last slots of a day can arrive after midnight and be missed.</p>`;
  return { html, kwh: yesterday.kwh };
}

function renderEmail(
  data: ReportData,
  config: PollerConfig,
  standing: Record<string, number>,
  newportPv: NewportPvDay[]
): { subject: string; html: string } {
  const best = [...data.scenarios].sort((a, b) => netGain(b) - netGain(a))[0];
  const rows = data.scenarios
    .map(
      (s) => `<tr>
  <td style="padding:4px 8px">${s.name}</td>
  <td align="right" style="padding:4px 8px">${signed(-s.importCostP)}${s.note ? `<br><span style="color:#888;font-size:11px">${s.note}</span>` : ""}</td>
  <td align="right" style="padding:4px 8px">${signed(s.exportRevP)}</td>
  <td align="right" style="padding:4px 8px">${signed(-s.standingP)}</td>
  <td align="right" style="padding:4px 8px"><b>${signed(netGain(s))}</b></td>
</tr>`
    )
    .join("\n");
  const scenarioLabels: Record<string, string> = {
    gain_current: "Current tariff",
    gain_go_var: "Go + Outgoing VAR",
    gain_go_agile: "Go + Agile export",
    gain_go_prime: "Go + Prime",
    gain_agile_agile: "Agile + Agile",
    gain_go_agile_opt: "Go + Agile + optimised battery",
    uplift_opt_pence: "Optimised battery uplift (extra)"
  };
  const cumRow = (name: string) =>
    `<tr><td style="padding:4px 8px">${scenarioLabels[name] ?? name}</td>` +
    [data.cumulative.last7[name] ?? 0, data.cumulative.last30[name] ?? 0, data.cumulative.totals[name] ?? 0]
      .map((v) => `<td align="right" style="padding:4px 8px">${signed(v)}</td>`)
      .join("") +
    "</tr>";
  const cumRows = Object.keys(scenarioLabels).map(cumRow).join("\n");
  const pv = newportPvSection(newportPv, data.day);
  const subject = `Octopus tariff report ${data.day}: best ${best ? best.name : "n/a"} (${signedHtml(netGain(best))}), optimised +${(data.optimisedUpliftP / 100).toFixed(2)}${pv.kwh !== null ? ` · Newport PV ${pv.kwh.toFixed(1)} kWh` : ""}`;
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;color:#222">
<h2 style="margin:0 0 4px">York tariff report — ${data.day}</h2>
<p style="margin:0 0 12px;color:#555">PV ${data.pvKwh.toFixed(1)} kWh · exported ${data.exportKwh.toFixed(1)} kWh · imported ${data.importKwh.toFixed(1)} kWh · battery ${config.battery.capacityKwh} kWh · telemetry ${data.coverage}/48 half-hours</p>
<h3 style="margin:12px 0 4px">Yesterday replayed on each tariff combination</h3>
<table border="1" cellpadding="2" cellspacing="0" style="border-collapse:collapse;border-color:#ddd">
<tr style="background:#f4f4f4"><th align="left" style="padding:4px 8px">Scenario</th><th>Import</th><th>Export</th><th>Standing</th><th>Net gain</th></tr>
${rows}
</table>
<h3 style="margin:16px 0 4px">Optimised battery strategy (top row of the table)</h3>
<p style="margin:0 0 4px">Charge from the grid overnight in the Go cheap window → export it into the day's highest morning export rates → solar refills the battery through the middle of the day → export most of that 16:00–19:00 → hold back ${config.battery.reserveKwh} kWh (solar-topped) to cover evening load until the cheap window restarts. The overnight charge is the only extra import the strategy needs.</p>
<p style="margin:0">Extra profit vs actual behaviour: <b>${signed(data.optimisedUpliftP)}</b><br><span style="color:#555">${data.optimisedNote}</span></p>
<h3 style="margin:16px 0 4px">Net gain totals (${data.cumulative.days} days recorded)</h3>
<table border="1" cellpadding="2" cellspacing="0" style="border-collapse:collapse;border-color:#ddd">
<tr style="background:#f4f4f4"><th align="left" style="padding:4px 8px">Scenario</th><th>Last 7 days</th><th>Last 30 days</th><th>All time</th></tr>
${cumRows}
</table>
${pv.html}
<p style="color:#888;font-size:12px;margin-top:16px">Generated by octopus-poller. Positive = money earned, negative = money paid. Export revenue assumes an export MPAN is installed. Standing charges fetched live from Octopus (current ${money(standing.current ?? 0)}/day, Go ${money(standing.go ?? 0)}/day, Agile in+out ${money((standing.agileImport ?? 0) + (standing.agileExport ?? 0))}/day). Newport excluded from the tariff replay (import-only meter, data lags ~33h); its PV generation is shown above.</p>
</div>`;
  return { subject, html };
}

function signedHtml(pence: number): string {
  return `${pence >= 0 ? "+" : "-"}£${Math.abs(pence / 100).toFixed(2)}`;
}

export async function runDailyReport(
  config: PollerConfig,
  influx: InfluxWriter,
  opts: { forDate?: string; dryRun?: boolean; force?: boolean } = {}
): Promise<string> {
  const reportCfg = config.report;
  const tz = config.timezone;
  const day = opts.forDate ?? DateTime.now().setZone(tz).minus({ days: 1 }).toISODate()!;
  const dayStart = DateTime.fromISO(`${day}T00:00:00`, { zone: tz });
  const from = dayStart.toUTC();
  const to = dayStart.plus({ days: 1 }).toUTC();

  const flows = await fetchFlows(influx, reportCfg.sigenergyBucket, from.toJSDate(), to.toJSDate());
  if (flows.length < 30) throw new Error(`insufficient flow data for ${day} (${flows.length} slots)`);
  const prices = await fetchPriceMaps(influx, config.influx.bucket, reportCfg.site, from.toJSDate(), to.toJSDate());
  if (prices.agileExport.size < 40) throw new Error(`insufficient Agile export prices for ${day}`);

  const scenarios = computeScenarios({ flows }, prices, config, reportCfg.goDayPence);
  const tariffCode = (await influx.query(`from(bucket:"${config.influx.bucket}")
  |> range(start: -400d)
  |> filter(fn: (r) => r._measurement == "octopus_price" and r.site == "${reportCfg.site}" and r.source == "tariff" and r.direction == "import")
  |> group(columns: ["tariff_code"])
  |> first()
  |> group()
  |> limit(n: 1)`))[0]?.tariff_code ?? "";
  const region = tariffCode.slice(-1) || "F";
  const standing = await fetchStandingCharges(tariffCode, region);
  const goStanding = (standing.go ?? 0);
  const agileStanding = (standing.agileImport ?? 0) + (standing.agileExport ?? 0);
  scenarios[0].standingP = standing.current ?? 0;
  for (const s of scenarios) if (s.name.startsWith("Go")) s.standingP = goStanding;
  if (scenarios[4]) scenarios[4].standingP = agileStanding;

  const uplift = optimisedUplift(flows, prices, config);
  // Full scenario: Go + Agile with the optimised battery dispatch applied on top.
  // Import cost includes the overnight grid charge (the strategy's only extra import).
  const goAgile = scenarios[2];
  scenarios.push({
    name: "Go + Agile + optimised battery",
    importCostP: goAgile.importCostP + uplift.chargeCostP,
    exportRevP: goAgile.exportRevP + uplift.morningRevP + uplift.eveningRevP - uplift.shiftedMiddayP,
    standingP: goAgile.standingP,
    note: uplift.chargeKwh > 0 ? `incl. ${uplift.chargeKwh} kWh night charge @ ${config.battery.cheapImportPence}p` : undefined
  });
  const sum = (fn: (f: DayFlow) => number) => flows.reduce((t, f) => t + fn(f), 0);
  const data: ReportData = {
    day,
    flows,
    coverage: flows.length,
    pvKwh: sum((f) => f.pvKwh),
    importKwh: sum((f) => f.importKwh),
    exportKwh: sum((f) => f.exportKwh),
    scenarios,
    optimisedUpliftP: uplift.upliftP,
    optimisedNote: uplift.note,
    cumulative: { days: 1, totals: {}, last7: {}, last30: {} }
  };

  // Cumulative totals from stored report points (per-day rows)
  const history = await influx.query(`from(bucket:"${config.influx.bucket}")
  |> range(start:-400d)
  |> filter(fn: (r) => r._measurement == "octopus_tariff_report" and r.site == "${reportCfg.site}")
  |> group(columns: ["day"])
  |> first()
  |> group()`);
  const label = (name: string) => `gain_${name}`;
  const names = ["current", "go_var", "go_agile", "go_prime", "agile_agile", "go_agile_opt"];
  const dayGain = (s: Scenario): number => s.exportRevP - s.importCostP - s.standingP;
  const totals: Record<string, number> = {};
  const last7: Record<string, number> = {};
  const last30: Record<string, number> = {};
  const rowsByDay = new Map<string, Record<string, string>>();
  for (const row of history) rowsByDay.set(row.day, row);
  const from7 = dayStart.minus({ days: 6 }).toISODate()!;
  const from30 = dayStart.minus({ days: 29 }).toISODate()!;
  const addDays = (target: Record<string, number>, row: Record<string, string>) => {
    for (const [key, value] of Object.entries(row)) {
      if (key.startsWith("gain_") || key === "uplift_opt_pence") target[key] = (target[key] ?? 0) + Number(value);
    }
  };
  if (rowsByDay.has(day) && !opts.dryRun && !opts.force) throw new Error(`report for ${day} already sent`);
  // The freshly computed day always replaces any stored row for it (force re-sends self-correct)
  const freshRow: Record<string, string> = { day };
  data.scenarios.forEach((s, i) => (freshRow[label(names[i])] = String(dayGain(s))));
  freshRow["uplift_opt_pence"] = String(uplift.upliftP);
  rowsByDay.set(day, freshRow);
  for (const [d, row] of rowsByDay) {
    addDays(totals, row);
    if (d >= from7) addDays(last7, row);
    if (d >= from30) addDays(last30, row);
  }
  data.cumulative = { days: rowsByDay.size, totals, last7, last30 };

  // Newport PV block (best-effort: absent sma_pv data simply omits the section)
  let newportPv: NewportPvDay[] = [];
  try {
    newportPv = await fetchNewportPv(
      influx,
      config.influx.bucket,
      config.sma.site,
      tz,
      dayStart.minus({ days: 7 }),
      to
    );
  } catch (error) {
    console.log(`newport pv fetch failed: ${error instanceof Error ? error.message : error}`);
  }

  const { subject, html } = renderEmail(data, config, standing, newportPv);
  if (opts.dryRun) {
    console.log(`DRY RUN ${subject}\n${html}`);
    return subject;
  }
  // LAN hop to the local relay — postfix offers a self-signed cert, so stay plaintext
  const transporter = nodemailer.createTransport({ host: reportCfg.smtpHost, port: reportCfg.smtpPort, ignoreTLS: true });
  await transporter.sendMail({ from: reportCfg.from, to: reportCfg.to, subject, html });
  // Only mark the day as sent after the email actually went out
  const fields: Record<string, number> = { uplift_opt_pence: round(uplift.upliftP), pv_kwh: round(data.pvKwh), export_kwh: round(data.exportKwh), import_kwh: round(data.importKwh) };
  data.scenarios.forEach((s, i) => (fields[label(names[i])] = round(dayGain(s))));
  await influx.write([
    {
      measurement: `${config.measurementPrefix}tariff_report`,
      tags: { site: reportCfg.site, day },
      fields,
      timestamp: Math.floor(dayStart.plus({ hours: 12 }).toSeconds())
    }
  ]);
  return subject;
}

function round(value: number): number {
  return Number(value.toFixed(2));
}
