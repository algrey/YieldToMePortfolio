export function rejectCrossSiteMutation(request: Request): Response | null {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  const allowedFetchSite =
    fetchSite === null || fetchSite === "same-origin" || fetchSite === "none";
  if (!allowedFetchSite || (origin !== null && origin !== requestOrigin)) {
    return Response.json(
      { ok: false, message: "Cross-site mutation requests are not allowed." },
      {
        status: 403,
        headers: { "cache-control": "private, no-store" },
      },
    );
  }
  return null;
}
