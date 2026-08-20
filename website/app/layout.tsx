import type { Metadata, Viewport } from "next";
import "./globals.css";

const siteUrl = "https://octopus-energy-private-mcp-guide.darren138956.chatgpt.site";

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#f1efe8",
};

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Install Octopus Energy Private MCP | Beginner Setup Guide",
  description:
    "Install Octopus Energy Private MCP with a plain-English, 15-minute guide for Mac, Windows, and Linux. Connect private energy data to ChatGPT desktop or Codex.",
  applicationName: "Octopus Energy Private MCP Setup Guide",
  authors: [{ name: "Octopus Energy Private MCP community" }],
  creator: "Octopus Energy Private MCP community",
  alternates: { canonical: "/" },
  keywords: [
    "Octopus Energy MCP",
    "Octopus Energy API",
    "ChatGPT energy data",
    "Codex MCP server",
    "Agile Octopus analysis",
    "MCP installation guide",
  ],
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large" },
  },
  openGraph: {
    type: "website",
    url: "/",
    locale: "en_GB",
    title: "Install Octopus Energy Private MCP",
    description: "Private energy insights. Simple setup. A step-by-step guide for everyone.",
    siteName: "Octopus Energy Private MCP",
    images: [
      {
        url: "/og.png",
        width: 1730,
        height: 909,
        alt: "Octopus Energy Private MCP — Private energy insights. Simple setup.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Install Octopus Energy Private MCP",
    description: "Private energy insights. Simple setup. A step-by-step guide for everyone.",
    images: ["/og.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}
