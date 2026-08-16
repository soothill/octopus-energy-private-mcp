import { DateTime } from "luxon";
import type { PeriodRange } from "./types.js";

export const PERIOD_ALIASES = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "last_7_days",
  "last_30_days",
  "this_year",
  "last_year"
] as const;

export type PeriodAlias = (typeof PERIOD_ALIASES)[number];

export interface PeriodInput {
  period?: PeriodAlias;
  period_from?: string;
  period_to?: string;
}

function parseBoundary(value: string, timezone: string, endBoundary: boolean): DateTime {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  let parsed = dateOnly
    ? DateTime.fromISO(value, { zone: timezone }).startOf("day")
    : DateTime.fromISO(value, { zone: timezone, setZone: true });
  if (!parsed.isValid) {
    throw new Error(`Invalid ISO date/time: ${value}`);
  }
  if (dateOnly && endBoundary) parsed = parsed.plus({ days: 1 });
  return parsed;
}

export function resolvePeriod(
  input: PeriodInput,
  timezone: string,
  now: DateTime = DateTime.now().setZone(timezone)
): PeriodRange {
  if (!now.isValid) throw new Error(`Invalid timezone: ${timezone}`);
  if (input.period_from || input.period_to) {
    if (!input.period_from || !input.period_to) {
      throw new Error("period_from and period_to must be supplied together");
    }
    const from = parseBoundary(input.period_from, timezone, false);
    const to = parseBoundary(input.period_to, timezone, true);
    if (to.toMillis() <= from.toMillis()) {
      throw new Error("period_to must be after period_from");
    }
    return {
      from: from.toUTC().toISO()!,
      to: to.toUTC().toISO()!,
      label: `${input.period_from} to ${input.period_to}`
    };
  }

  const alias = input.period ?? "last_30_days";
  let from: DateTime;
  let to: DateTime;
  switch (alias) {
    case "today":
      from = now.startOf("day");
      to = now;
      break;
    case "yesterday":
      from = now.minus({ days: 1 }).startOf("day");
      to = now.startOf("day");
      break;
    case "this_week":
      from = now.startOf("week");
      to = now;
      break;
    case "last_week":
      from = now.minus({ weeks: 1 }).startOf("week");
      to = now.startOf("week");
      break;
    case "this_month":
      from = now.startOf("month");
      to = now;
      break;
    case "last_month":
      from = now.minus({ months: 1 }).startOf("month");
      to = now.startOf("month");
      break;
    case "last_7_days":
      from = now.minus({ days: 7 });
      to = now;
      break;
    case "last_30_days":
      from = now.minus({ days: 30 });
      to = now;
      break;
    case "this_year":
      from = now.startOf("year");
      to = now;
      break;
    case "last_year":
      from = now.minus({ years: 1 }).startOf("year");
      to = now.startOf("year");
      break;
  }
  return {
    from: from.toUTC().toISO()!,
    to: to.toUTC().toISO()!,
    label: alias
  };
}

export function previousEquivalentPeriod(range: PeriodRange): PeriodRange {
  const from = DateTime.fromISO(range.from, { setZone: true });
  const to = DateTime.fromISO(range.to, { setZone: true });
  const durationMs = to.toMillis() - from.toMillis();
  return {
    from: from.minus({ milliseconds: durationMs }).toUTC().toISO()!,
    to: from.toUTC().toISO()!,
    label: `previous period before ${range.label}`
  };
}
