import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the complete beginner installation guide", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Install Octopus Energy Private MCP \| Beginner Setup Guide<\/title>/i);
  assert.match(html, /Ask better questions about your energy use/);
  assert.match(html, /Your 15-minute setup/);
  assert.match(html, /Install Node\.js/);
  assert.match(html, /Download the latest ZIP/);
  assert.match(html, /Save the details locally/);
  assert.match(html, /Connect ChatGPT desktop or Codex/);
  assert.match(html, /Documents is not a special MCP folder/);
  assert.match(html, /do not search your Documents folder/);
  assert.match(html, /does <strong>not<\/strong> move the folder/i);
  assert.match(html, /mcp_servers\.octopus_energy/);
  assert.match(html, /I moved or renamed the MCP folder/);
  assert.match(html, /Check that it works/);
  assert.match(html, /Show my four Intelligent Octopus Go rates/);
  assert.match(html, /Does it understand the new Intelligent Octopus Go prices/);
  assert.match(html, /separate home peak, home off-peak, EV peak and EV off-peak rates/i);
  assert.match(html, /effective whole dates used by Octopus/i);
  assert.match(html, /never presents a partial subtotal as complete/i);
  assert.match(html, /distinguishes a confirmed empty history from unavailable data/i);
  assert.match(html, /shorter period or weekly\/monthly results/i);
  assert.match(html, /INTELLI-VAR/);
  assert.match(html, /does not rebuild these prices from whole-home meter readings/i);
  assert.match(html, /Sends energy results to your selected AI client and model/);
  assert.match(html, /AI provider.s privacy and data controls apply to those results/);
  assert.match(html, /a newer version is available/);
  assert.match(html, /Checks the public GitHub version at startup unless you disable it/);
  assert.match(html, /git pull --ff-only/);
  assert.match(html, /application\/ld\+json/);
  assert.match(html, /HowTo/);
  assert.match(html, /FAQPage/);
  assert.match(html, /rel="canonical"[^>]+octopus-energy-private-mcp-guide\.darren138956\.chatgpt\.site/i);
  assert.doesNotMatch(html, /Your energy data stays between you and Octopus/);
  assert.doesNotMatch(html, /No cloud middleman/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|SkeletonPreview/);
});

test("ships the required search and sharing asset", async () => {
  await access(new URL("../public/og.png", import.meta.url));
});

test("allows indexing and publishes a sitemap", async () => {
  const robotsResponse = await render("/robots.txt");
  assert.equal(robotsResponse.status, 200);
  const robots = await robotsResponse.text();
  assert.match(robots, /User-Agent: \*/i);
  assert.match(robots, /Allow: \//i);
  assert.match(robots, /Sitemap: https:\/\/octopus-energy-private-mcp-guide\.darren138956\.chatgpt\.site\/sitemap\.xml/i);

  const sitemapResponse = await render("/sitemap.xml");
  assert.equal(sitemapResponse.status, 200);
  const sitemap = await sitemapResponse.text();
  assert.match(sitemap, /<loc>https:\/\/octopus-energy-private-mcp-guide\.darren138956\.chatgpt\.site<\/loc>/i);
});
