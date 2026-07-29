const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function createRequestId(
  request: Request,
  generate: () => string = () => crypto.randomUUID(),
): string {
  const supplied = request.headers.get("x-request-id")?.trim();
  return supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : generate();
}

export function addRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
