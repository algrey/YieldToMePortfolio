import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "YieldToMe",
    short_name: "YieldToMe",
    description: "Private, explainable portfolio tracking.",
    start_url: "/",
    display: "standalone",
    background_color: "#06110f",
    theme_color: "#06110f",
    orientation: "any",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
