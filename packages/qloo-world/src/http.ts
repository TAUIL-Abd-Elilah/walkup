/** Small helpers shared by the three transports. */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-walkup-world": "synthetic", ...headers },
  });
}

/** Request body text from a fetch init (string bodies only; the clients send strings). */
export function bodyText(init: RequestInit | undefined): string | null {
  const b = init?.body;
  return typeof b === "string" ? b : null;
}

/** Sorted "k=v" pairs: the seed for every number a response derives. */
export function canonicalParams(params: Map<string, string>): string {
  return [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}
