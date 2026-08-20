import type { MetadataRoute } from "next";

const siteUrl = "https://octopus-energy-private-mcp-guide.darren138956.chatgpt.site";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: siteUrl,
      lastModified: new Date("2026-08-20"),
      changeFrequency: "monthly",
      priority: 1,
    },
  ];
}
