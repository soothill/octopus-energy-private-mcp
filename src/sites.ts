import { FileCache } from "./cache.js";
import { siteConfigFor, type ServerConfig, type SiteConfig } from "./config.js";
import { OctopusGraphQlClient } from "./graphql-client.js";
import { OctopusRestClient } from "./octopus-client.js";
import { RequestRateLimiter } from "./rate-limiter.js";

export interface SiteRuntime {
  site: SiteConfig;
  config: ServerConfig;
  cache: FileCache;
  limiter: RequestRateLimiter;
  rest: OctopusRestClient;
  graphql: OctopusGraphQlClient;
}

export interface SiteRegistryOverrides {
  cache?: FileCache;
  rest?: OctopusRestClient;
  graphql?: OctopusGraphQlClient;
  limiter?: RequestRateLimiter;
}

function normalizeSelector(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export class SiteRegistry {
  private readonly runtimes = new Map<string, SiteRuntime>();

  constructor(
    readonly config: ServerConfig,
    private readonly overrides: SiteRegistryOverrides = {}
  ) {}

  list(): SiteConfig[] {
    return this.config.sites;
  }

  find(selector?: string): SiteConfig {
    if (!selector || !selector.trim()) {
      const fallback = this.config.sites.find((site) => site.slug === this.config.defaultSite) ?? this.config.sites[0];
      if (!fallback) throw new Error("No sites are configured");
      return fallback;
    }
    const needle = normalizeSelector(selector);
    const match = this.config.sites.find(
      (site) => site.slug === needle || normalizeSelector(site.name) === needle
    );
    if (match) return match;
    const known = this.config.sites.map((site) => `${site.name} (${site.slug})`).join(", ");
    throw new Error(`Unknown site "${selector}". Configured sites: ${known}. Omit site to use the default.`);
  }

  resolve(selector?: string): SiteRuntime {
    const site = this.find(selector);
    const existing = this.runtimes.get(site.slug);
    if (existing) return existing;
    const isDefault = site.slug === this.config.defaultSite;
    const config = siteConfigFor(this.config, site);
    const cache = this.overrides.cache ?? new FileCache(config.cacheDir, config.cacheEnabled);
    const limiter =
      (isDefault && this.overrides.limiter) ||
      new RequestRateLimiter(config.requestsPerMinute, config.minRequestIntervalMs);
    const rest =
      (isDefault && this.overrides.rest) || new OctopusRestClient(config, cache, limiter);
    const graphql =
      (isDefault && this.overrides.graphql) || new OctopusGraphQlClient(config, cache, limiter);
    const runtime: SiteRuntime = { site, config, cache, limiter, rest, graphql };
    this.runtimes.set(site.slug, runtime);
    return runtime;
  }

  get defaultRuntime(): SiteRuntime {
    return this.resolve();
  }
}
