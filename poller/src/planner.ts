import { DateTime } from "luxon";
import type { RateRecord } from "./octopus.js";
import type { Point } from "./influx.js";

export interface BatteryPlanConfig {
  sites: string[];
  capacityKwh: number;
  chargeKw: number;
  dischargeKw: number;
  efficiency: number;
  cheapImportPence: number;
  cheapImportWindow: string; // "HH:MM-HH:MM" UK, grid-charge window (e.g. Octopus Go)
  reserveKwh: number; // held back from the evening dump to cover the 19:00-23:00 load
  plannerImportProduct: string;
  plannerExportProduct: string;
}

// Fixed strategy windows (UK minutes from midnight)
const MORNING_WINDOW: [number, number] = [6 * 60, 9 * 60 + 30]; // discharge into morning peak
const SOLAR_WINDOW: [number, number] = [10 * 60, 15 * 60 + 30]; // solar refill (assumed free)
const EVENING_WINDOW: [number, number] = [16 * 60, 19 * 60]; // discharge into evening peak
const RESERVE_WINDOW: [number, number] = [19 * 60, 23 * 60]; // reserve drains to house load
const SLOT_HOURS = 0.5;

function rateAt(rates: RateRecord[], at: number): RateRecord | null {
  return (
    rates.find((rate) => {
      const from = Date.parse(rate.valid_from);
      const to = rate.valid_to ? Date.parse(rate.valid_to) : Number.POSITIVE_INFINITY;
      return from <= at && at < to;
    }) ?? null
  );
}

function parseWindow(window: string): [number, number] {
  const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(window.trim());
  if (!match) throw new Error(`Invalid window "${window}", expected HH:MM-HH:MM`);
  const start = Number(match[1]) * 60 + Number(match[2]);
  let end = Number(match[3]) * 60 + Number(match[4]);
  if (end <= start) end += 24 * 60; // window crossing midnight
  return [start, end];
}

interface PlanSlot {
  at: number; // unix seconds
  minute: number; // UK minutes from midnight
  importP: number;
  exportP: number;
  action: "grid_charge" | "discharge_morning" | "discharge_evening" | "solar_refill" | "reserve" | "idle";
  kwh: number;
  socAfter: number;
}

/**
 * Day-ahead two-cycle schedule for a solar+battery home on a cheap-night import tariff
 * (e.g. Go) with Agile export: grid-charge in the cheap window, export the morning peak,
 * refill from solar, dump the evening peak down to a reserve that covers the 19:00-23:00
 * load before the next cheap window starts. Steady state: SOC starts and ends at 0.
 */
export function planBatteryDay(
  importRates: RateRecord[],
  exportRates: RateRecord[],
  config: BatteryPlanConfig,
  timezone: string
): { day: string; slots: PlanSlot[]; summary: Record<string, number> } | null {
  const tz = timezone;
  const today = DateTime.now().setZone(tz).startOf("day");
  const cheapWindow = parseWindow(config.cheapImportWindow);

  // Plan the next UK day that has a near-complete set of day-ahead export prices;
  // Agile publishes tomorrow ~16:00 UK, so fall back to today before that.
  let day = today.plus({ days: 1 });
  const countSlots = (start: DateTime) => {
    const from = start.toMillis();
    const to = from + 86_400_000;
    let n = 0;
    for (let at = from; at < to; at += 1_800_000) if (rateAt(exportRates, at)) n++;
    return n;
  };
  if (countSlots(day) < 40) day = today;
  if (countSlots(day) < 40) return null;

  const dayStart = day.toMillis();
  const slots: PlanSlot[] = [];
  const inCheapWindow = (minute: number) =>
    (minute >= cheapWindow[0] && minute < cheapWindow[1]) ||
    (minute + 1440 >= cheapWindow[0] && minute + 1440 < cheapWindow[1]);
  for (let i = 0; i < 48; i++) {
    const at = dayStart + i * 1_800_000;
    const importRate = rateAt(importRates, at);
    const exportRate = rateAt(exportRates, at);
    if (!importRate || !exportRate) continue;
    const minute = i * 30;
    const importP = inCheapWindow(minute)
      ? Math.min(importRate.value_inc_vat, config.cheapImportPence)
      : importRate.value_inc_vat;
    slots.push({
      at: Math.floor(at / 1000),
      minute,
      importP,
      exportP: exportRate.value_inc_vat,
      action: "idle",
      kwh: 0,
      socAfter: 0
    });
  }
  if (slots.length < 40) return null;

  const C = config.capacityKwh;
  const chargePerSlot = config.chargeKw * SLOT_HOURS;
  const dischargePerSlot = config.dischargeKw * SLOT_HOURS;
  const eff = config.efficiency;
  const inWindow = (s: PlanSlot, [from, to]: [number, number]) => s.minute >= from && s.minute < to;
  const byExportDesc = (a: PlanSlot, b: PlanSlot) => b.exportP - a.exportP;

  // --- Cycle A gate: is grid-charging then exporting the morning peak profitable? ---
  const cheapSlots = slots
    .filter((s) => inCheapWindow(s.minute))
    .sort((a, b) => a.importP - b.importP || a.minute - b.minute);
  const morningSlots = slots.filter((s) => inWindow(s, MORNING_WINDOW)).sort(byExportDesc);
  let cycleA = false;
  if (cheapSlots.length && morningSlots.length) {
    let simSoc = 0;
    let cost = 0;
    for (const s of cheapSlots) {
      const k = Math.min(chargePerSlot, C - simSoc);
      cost += k * s.importP;
      simSoc += k;
      if (simSoc >= C) break;
    }
    let out = simSoc * eff;
    let revenue = 0;
    for (const s of morningSlots) {
      const k = Math.min(dischargePerSlot, out);
      revenue += k * s.exportP;
      out -= k;
      if (out <= 0) break;
    }
    cycleA = revenue > cost;
  }

  // --- Walk the day (steady state: start empty, end empty) ---
  let soc = 0;
  const gridChargeKwh: number[] = []; // input kWh per cheap slot
  if (cycleA) {
    for (const s of cheapSlots) {
      const k = Math.min(chargePerSlot, C - soc);
      if (k <= 0) break;
      s.action = "grid_charge";
      s.kwh = k;
      soc += k;
      s.socAfter = soc;
      gridChargeKwh.push(k);
    }
  }
  const cheapCostPence = gridChargeKwh.reduce(
    (total, k, idx) => total + k * cheapSlots[idx]!.importP,
    0
  );
  let morningKwh = 0;
  let morningRevenuePence = 0;
  if (cycleA) {
    for (const s of morningSlots) {
      const k = Math.min(dischargePerSlot, soc);
      if (k <= 0) break;
      s.action = "discharge_morning";
      s.kwh = k * eff;
      morningKwh += s.kwh;
      morningRevenuePence += s.kwh * s.exportP;
      soc -= k;
      s.socAfter = soc;
    }
  }
  // Solar refill (free, assumed sufficient surplus)
  let solarKwh = 0;
  for (const s of slots.filter((x) => inWindow(x, SOLAR_WINDOW)).sort((a, b) => a.minute - b.minute)) {
    const k = Math.min(chargePerSlot, C - soc);
    if (k <= 0) break;
    s.action = "solar_refill";
    s.kwh = k;
    solarKwh += k;
    soc += k;
    s.socAfter = soc;
  }
  // Evening dump down to the reserve
  let eveningKwh = 0;
  let eveningRevenuePence = 0;
  for (const s of slots.filter((x) => inWindow(x, EVENING_WINDOW)).sort(byExportDesc)) {
    const k = Math.min(dischargePerSlot, soc - config.reserveKwh);
    if (k <= 0) break;
    s.action = "discharge_evening";
    s.kwh = k * eff;
    eveningKwh += s.kwh;
    eveningRevenuePence += s.kwh * s.exportP;
    soc -= k;
    s.socAfter = soc;
  }
  // Reserve drains to house load across 19:00-23:00 (valued as avoided import)
  let reserveValuePence = 0;
  const reserveSlots = slots.filter((x) => inWindow(x, RESERVE_WINDOW));
  if (reserveSlots.length && soc > 0) {
    const perSlot = soc / reserveSlots.length;
    for (const s of reserveSlots.sort((a, b) => a.minute - b.minute)) {
      s.action = "reserve";
      s.kwh = perSlot;
      reserveValuePence += perSlot * s.importP;
      soc -= perSlot;
      s.socAfter = soc;
    }
  }

  const gridChargeTotal = gridChargeKwh.reduce((a, b) => a + b, 0);
  const summary = {
    cycle_a_enabled: cycleA ? 1 : 0,
    grid_charge_kwh: round(gridChargeTotal),
    grid_charge_cost_pence: round(cheapCostPence),
    morning_export_kwh: round(morningKwh),
    morning_revenue_pence: round(morningRevenuePence),
    solar_refill_kwh: round(solarKwh),
    evening_export_kwh: round(eveningKwh),
    evening_revenue_pence: round(eveningRevenuePence),
    reserve_kwh: round(Math.min(config.reserveKwh, C)),
    reserve_value_pence: round(reserveValuePence),
    expected_profit_pence: round(morningRevenuePence + eveningRevenuePence + reserveValuePence - cheapCostPence),
    half_hours_planned: slots.length
  };
  return { day: day.toISODate() ?? "unknown", slots, summary };
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

/** Influx points: one per planned half-hour plus a daily summary. */
export function batteryPlanPoints(
  prefix: string,
  site: string,
  plan: { day: string; slots: PlanSlot[]; summary: Record<string, number> }
): Point[] {
  const points: Point[] = plan.slots
    .filter((slot) => slot.action !== "idle")
    .map((slot) => ({
      measurement: `${prefix}battery_plan`,
      tags: { site, day: plan.day, action: slot.action },
      fields: {
        kwh: round(slot.kwh),
        soc_after: round(slot.socAfter),
        import_pence: round(slot.importP),
        export_pence: round(slot.exportP)
      },
      timestamp: slot.at
    }));
  points.push({
    measurement: `${prefix}battery_plan`,
    tags: { site, day: plan.day, action: "summary" },
    fields: plan.summary,
    timestamp: Math.floor(Date.now() / 1000)
  });
  return points;
}
