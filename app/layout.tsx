import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",")[0];
  const requestedHost = forwardedHost ?? requestHeaders.get("host");
  const host =
    requestedHost && /^[a-z0-9.-]+(?::\d+)?$/i.test(requestedHost)
      ? requestedHost
      : "localhost:3000";
  const forwardedProtocol = requestHeaders
    .get("x-forwarded-proto")
    ?.split(",")[0];
  const protocol = forwardedProtocol === "https" ? "https" : "http";
  const metadataBase = new URL(`${protocol}://${host}`);
  const description =
    "A private portfolio ledger and reporting workspace for invited users.";

  return {
    metadataBase,
    title: {
      default: "YieldToMe",
      template: "%s · YieldToMe",
    },
    description,
    applicationName: "YieldToMe",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
      apple: "/favicon.svg",
    },
    appleWebApp: {
      capable: true,
      statusBarStyle: "black-translucent",
      title: "YieldToMe",
    },
    openGraph: {
      type: "website",
      title: "YieldToMe",
      description,
      images: [
        {
          url: new URL("/og.png", metadataBase).toString(),
          width: 1200,
          height: 630,
          alt: "YieldToMe portfolio workspace",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "YieldToMe",
      description,
      images: [new URL("/og.png", metadataBase).toString()],
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#06110f",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
