#!/usr/bin/env node
import { DateTime } from "luxon";
import { loadPollerConfig } from "./config.js";
import { InfluxWriter } from "./influx.js";
import { SitePoller } from "./poller.js";
import { runDailyReport } from "./reporter.js";
import { SunnyPortalClient } from "./sunnyportal.js";

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function runCycle(pollers: SitePoller[], label: string): Promise<void> {
  for (const poller of pollers) {
    try {
      if (label === "prices") {
        await poller.pollPrices();
        await poller.pollMarketPrices();
      } else {
        await poller.pollConsumption();
      }
    } catch (error) {
      log(`${label} poll failed: ${error instanceof Error ? error.message : error}`);
    }
  }
}

async function main(): Promise<void> {
  const config = loadPollerConfig();
  const once = process.argv.includes("--once");
  const influx = new InfluxWriter({ ...config.influx, timeoutMs: config.requestTimeoutMs });
  const pollers = config.sites.map((site) => new SitePoller(config, site, influx));
  log(`octopus-influx-poller starting: sites=${config.sites.map((site) => site.slug).join(",")} influx=${config.influx.baseUrl}/${config.influx.bucket}`);

  await runCycle(pollers, "prices");
  await runCycle(pollers, "consumption");
  const smaClient = config.sma.enabled
    ? new SunnyPortalClient({
        username: config.sma.username,
        password: config.sma.password,
        timezone: config.timezone,
        timeoutMs: config.requestTimeoutMs
      })
    : null;
  if (smaClient && !(config.sma.username && config.sma.password)) {
    log("sma: SMA_ENABLED=true but SMA_USERNAME/SMA_PASSWORD are empty — disabling");
  }
  const smaCycle = async (): Promise<void> => {
    if (!smaClient || !(config.sma.username && config.sma.password)) return;
    try {
      const points = await smaClient.fetchDayCurve();
      await influx.write(
        points.map((point) => ({
          measurement: "sma_pv",
          tags: { site: config.sma.site },
          fields: { power_kw: point.kw, energy_kwh: Math.round(point.kw * 0.25 * 1000) / 1000 },
          timestamp: point.ts
        }))
      );
      const latest = points.length ? new Date(points[points.length - 1].ts * 1000).toISOString() : "none";
      log(`sma pv: wrote ${points.length} points (latest slot ${latest})`);
    } catch (error) {
      log(`sma poll failed: ${error instanceof Error ? error.message : error}`);
    }
  };
  await smaCycle();
  if (once) return;

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, shutting down`);
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  const priceTimer = setInterval(() => void runCycle(pollers, "prices"), config.priceIntervalMs);
  const consumptionTimer = setInterval(() => void runCycle(pollers, "consumption"), config.consumptionIntervalMs);
  const smaTimer = smaClient ? setInterval(() => void smaCycle(), config.sma.intervalMs) : null;
  // Note: do not unref() these timers — this process is a daemon and the
  // event loop must stay alive between cycles.

  if (config.report.enabled) {
    if (!config.report.to) throw new Error("REPORT_TO is required when REPORT_ENABLED=true");
    let lastAttemptDay = "";
    let lastFailureMs = 0;
    const [reportHour, reportMinute] = config.report.time.split(":").map(Number);
    const checkReport = async (): Promise<void> => {
      const now = DateTime.now().setZone(config.timezone);
      const today = now.toISODate()!;
      const due = now.hour > reportHour || (now.hour === reportHour && now.minute >= reportMinute);
      if (!due || lastAttemptDay === today) return;
      if (Date.now() - lastFailureMs < 600_000) return; // back off 10 min after a failure
      try {
        const subject = await runDailyReport(config, influx);
        lastAttemptDay = today;
        log(`daily report sent: ${subject}`);
      } catch (error) {
        lastFailureMs = Date.now();
        log(`daily report failed: ${error instanceof Error ? error.message : error}`);
      }
    };
    const reportTimer = setInterval(() => void checkReport(), 60_000);
    void checkReport();
    void reportTimer;
  }
}

main().catch((error) => {
  log(`fatal: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
