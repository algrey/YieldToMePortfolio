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
        src: "/favicon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
