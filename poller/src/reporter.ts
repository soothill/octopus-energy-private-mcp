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
}

const netCost = (s: Scenario): number => s.importCostP - s.exportRevP + s.standingP;

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
  cumulative: { days: number; totals: Record<string, number> };
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

/** Replay the two-cycle battery strategy (grid night-charge, morning + evening peaks, reserve) on the day's actual prices and solar. */
function optimisedUplift(flows: DayFlow[], prices: Record<string, Map<number, number>>, config: PollerConfig): { upliftP: number; note: string } {
  const C = config.battery.capacityKwh;
  const eff = config.battery.efficiency;
  const reserve = config.battery.reserveKwh;
  const perSlotDis = config.battery.dischargeKw * 0.5;
  const morning = flows.filter((f) => f.minute >= 360 && f.minute < 570).sort((a, b) => rateAt(prices.agileExport, b.minute) - rateAt(prices.agileExport, a.minute));
  const evening = flows.filter((f) => f.minute >= 960 && f.minute < 1140).sort((a, b) => rateAt(prices.agileExport, b.minute) - rateAt(prices.agileExport, a.minute));
  const middayExports = flows
    .filter((f) => f.minute >= 600 && f.minute < 930 && f.exportKwh > 0)
    .sort((a, b) => rateAt(prices.agileExport, a.minute) - rateAt(prices.agileExport, b.minute));
  const eveningImports = flows.filter((f) => f.minute >= 1140 && f.minute < 1380);

  // Cycle A: night grid charge -> morning peak
  let out = C * eff;
  let morningRev = 0;
  for (const f of morning) {
    if (out <= 0) break;
    const k = Math.min(perSlotDis, out);
    morningRev += k * rateAt(prices.agileExport, f.minute);
    out -= k;
  }
  const cycleA = morningRev - C * config.battery.cheapImportPence;
  if (cycleA <= 0) return { upliftP: 0, note: "night-charge cycle not profitable on the day's prices" };

  // Cycle B: shift midday solar (up to C - reserve) into the evening peak
  let room = C - reserve;
  let shift = 0;
  let middayVal = 0;
  for (const f of middayExports) {
    if (room <= 0) break;
    const k = Math.min(room, f.exportKwh);
    shift += k;
    middayVal += k * rateAt(prices.agileExport, f.minute);
    room -= k;
  }
  let rem = shift * eff;
  let eveningRev = 0;
  for (const f of evening) {
    if (rem <= 0) break;
    const k = Math.min(perSlotDis, rem);
    eveningRev += k * rateAt(prices.agileExport, f.minute);
    rem -= k;
  }
  const cycleB = eveningRev - middayVal;
  const reserveValue = eveningImports.length
    ? (reserve * eveningImports.reduce((t, f) => t + rateAt(prices.agileImport, f.minute), 0)) / eveningImports.length
    : 0;
  return {
    upliftP: cycleA + cycleB + reserveValue,
    note: `cycle A ${money(cycleA)} + cycle B ${money(cycleB)} (shifted ${shift.toFixed(1)} kWh) + reserve ${money(reserveValue)}`
  };
}

function renderEmail(data: ReportData, config: PollerConfig, standing: Record<string, number>): { subject: string; html: string } {
  const best = [...data.scenarios].sort((a, b) => netCost(a) - netCost(b))[0];
  const rows = data.scenarios
    .map(
      (s) => `<tr>
  <td style="padding:4px 8px">${s.name}</td>
  <td align="right" style="padding:4px 8px">${money(s.importCostP)}</td>
  <td align="right" style="padding:4px 8px">-${money(s.exportRevP)}</td>
  <td align="right" style="padding:4px 8px">${money(s.standingP)}</td>
  <td align="right" style="padding:4px 8px"><b>${money(netCost(s))}</b></td>
</tr>`
    )
    .join("\n");
  const scenarioLabels: Record<string, string> = {
    net_current: "Current tariff",
    net_go_var: "Go + Outgoing VAR",
    net_go_agile: "Go + Agile export",
    net_go_prime: "Go + Prime",
    net_agile_agile: "Agile + Agile",
    uplift_opt_pence: "Optimised battery uplift (profit)"
  };
  const cumRows = Object.entries(data.cumulative.totals)
    .map(([name, total]) => `<tr><td style="padding:4px 8px">${scenarioLabels[name] ?? name}</td><td align="right" style="padding:4px 8px">${money(total)}</td></tr>`)
    .join("\n");
  const subject = `Octopus tariff report ${data.day}: best ${best ? best.name : "n/a"}, optimised uplift ${money(data.optimisedUpliftP)}`;
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;color:#222">
<h2 style="margin:0 0 4px">York tariff report — ${data.day}</h2>
<p style="margin:0 0 12px;color:#555">PV ${data.pvKwh.toFixed(1)} kWh · exported ${data.exportKwh.toFixed(1)} kWh · imported ${data.importKwh.toFixed(1)} kWh · battery ${config.battery.capacityKwh} kWh · telemetry ${data.coverage}/48 half-hours</p>
<h3 style="margin:12px 0 4px">Yesterday replayed on each tariff combination (energy only, excl. standing charges)</h3>
<table border="1" cellpadding="2" cellspacing="0" style="border-collapse:collapse;border-color:#ddd">
<tr style="background:#f4f4f4"><th align="left" style="padding:4px 8px">Scenario</th><th>Import cost</th><th>Export revenue</th><th>Standing</th><th>Net cost</th></tr>
${rows}
</table>
<h3 style="margin:16px 0 4px">Go + Agile with optimised battery dispatch</h3>
<p style="margin:0">Extra profit vs actual behaviour: <b>${money(data.optimisedUpliftP)}</b><br><span style="color:#555">${data.optimisedNote}</span></p>
<h3 style="margin:16px 0 4px">Running totals (${data.cumulative.days} days)</h3>
<table border="1" cellpadding="2" cellspacing="0" style="border-collapse:collapse;border-color:#ddd">
<tr style="background:#f4f4f4"><th align="left" style="padding:4px 8px">Scenario</th><th>Cumulative net cost</th></tr>
${cumRows}
</table>
<p style="color:#888;font-size:12px;margin-top:16px">Generated by octopus-poller. Export revenue assumes an export MPAN is installed. Standing charges fetched live from Octopus (current ${money(standing.current ?? 0)}/day, Go ${money(standing.go ?? 0)}/day, Agile in+out ${money((standing.agileImport ?? 0) + (standing.agileExport ?? 0))}/day). Newport excluded (meter data lags ~33h).</p>
</div>`;
  return { subject, html };
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
  |> range(start: -7d)
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
    cumulative: { days: 1, totals: {} }
  };

  // Cumulative totals from stored report points
  const history = await influx.query(`from(bucket:"${config.influx.bucket}")
  |> range(start:-400d)
  |> filter(fn: (r) => r._measurement == "octopus_tariff_report" and r.site == "${reportCfg.site}")
  |> group(columns: ["day"])
  |> first()
  |> group()`);
  const totals: Record<string, number> = {};
  const seenDays = new Set<string>();
  for (const row of history) {
    seenDays.add(row.day);
    for (const [key, value] of Object.entries(row)) {
      if (key.startsWith("net_") || key === "uplift_opt_pence") totals[key] = (totals[key] ?? 0) + Number(value);
    }
  }
  if (seenDays.has(day) && !opts.dryRun && !opts.force) throw new Error(`report for ${day} already sent`);
  const label = (name: string) => `net_${name}`;
  const names = ["current", "go_var", "go_agile", "go_prime", "agile_agile"];
  const freshDay = !seenDays.has(day);
  if (freshDay) {
    // include the freshly computed day in the running totals
    data.scenarios.forEach((s, i) => (totals[label(names[i])] = (totals[label(names[i])] ?? 0) + s.importCostP - s.exportRevP + s.standingP));
    totals["uplift_opt_pence"] = (totals["uplift_opt_pence"] ?? 0) + uplift.upliftP;
    seenDays.add(day);
  }
  data.cumulative = { days: seenDays.size, totals };

  const { subject, html } = renderEmail(data, config, standing);
  if (opts.dryRun) {
    console.log(`DRY RUN ${subject}\n${html}`);
    return subject;
  }
  // LAN hop to the local relay — postfix offers a self-signed cert, so stay plaintext
  const transporter = nodemailer.createTransport({ host: reportCfg.smtpHost, port: reportCfg.smtpPort, ignoreTLS: true });
  await transporter.sendMail({ from: reportCfg.from, to: reportCfg.to, subject, html });
  // Only mark the day as sent after the email actually went out
  if (freshDay) {
    const fields: Record<string, number> = { uplift_opt_pence: round(uplift.upliftP), pv_kwh: round(data.pvKwh), export_kwh: round(data.exportKwh), import_kwh: round(data.importKwh) };
    data.scenarios.forEach((s, i) => (fields[label(names[i])] = round(s.importCostP - s.exportRevP + s.standingP)));
    await influx.write([
      {
        measurement: `${config.measurementPrefix}tariff_report`,
        tags: { site: reportCfg.site, day },
        fields,
        timestamp: Math.floor(dayStart.plus({ hours: 12 }).toSeconds())
      }
    ]);
  }
  return subject;
}

function round(value: number): number {
  return Number(value.toFixed(2));
}
