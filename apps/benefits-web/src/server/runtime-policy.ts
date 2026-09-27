import { PUBLIC_STATUS } from "../domain/integration-status";
export { PUBLIC_STATUS } from "../domain/integration-status";

export function isSyntheticRuntime(env: Readonly<Record<string, string | undefined>>): boolean {
  return env["KEYATLAS_BENEFITS_MODE"] === undefined
    || env["KEYATLAS_BENEFITS_MODE"] === "synthetic";
}

const blockedRoots = [
  "/auth", "/oauth", "/mcp", "/.well-known", "/.lovable.oauth.consent",
  "/dashboard", "/services", "/gmail", "/analyze", "/settings", "/schedule",
];

export function isDisconnectedRoute(pathname: string): boolean {
  // Decode once and fail closed on malformed encoding. Nothing from a failed URL
  // is reflected in errors or logs.
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname).toLowerCase().replace(/\\/g, "/");
  } catch {
    return true;
  }
  return blockedRoots.some((root) => decoded === root || decoded.startsWith(root + "/"));
}

export function unavailableResponse(code = "INTEGRATION_NOT_CONNECTED"): Response {
  return Response.json({ code }, { status: 503 });
}

export function protectResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'");
  // The complete script/connect-src policy awaits the final asset/auth boundary.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function handleRequest(
  request: Request,
  env: Readonly<Record<string, string | undefined>>,
  render: (request: Request) => Promise<Response> | Response,
): Promise<Response> {
  try {
    if (!isSyntheticRuntime(env)) {
      return protectResponse(unavailableResponse("MODE_NOT_AVAILABLE"));
    }
    const pathname = new URL(request.url).pathname;
    if (isDisconnectedRoute(pathname)) {
      return protectResponse(unavailableResponse());
    }
    if (pathname === "/api/integration-status") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return protectResponse(new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } }));
      }
      return protectResponse(request.method === "HEAD"
        ? new Response(null, { status: 200 })
        : Response.json(PUBLIC_STATUS));
    }
    const response = await render(request);
    return protectResponse(response.status >= 500
      ? unavailableResponse("REQUEST_FAILED")
      : response);
  } catch {
    // Do not serialize/log an upstream exception, cookie, query string or body.
    return protectResponse(unavailableResponse("REQUEST_FAILED"));
  }
}
