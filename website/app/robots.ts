import type { MetadataRoute } from "next";

const siteUrl = "https://octopus-energy-private-mcp-guide.darren138956.chatgpt.site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl,
  };
}
