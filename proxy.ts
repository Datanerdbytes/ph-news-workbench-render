import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/** Paths reachable without a session. */
const PUBLIC_PATHS = [
  "/login",
  "/forgot-password",
  "/reset-password",
  // Vendored ffmpeg.wasm glue: same-origin static modules the browser
  // transcode imports directly, so it must not be redirected to /login.
  "/ffmpeg",
];

export function proxy(request: NextRequest) {
  // better-auth prefixes the session cookie with __Secure- on HTTPS hosts
  // (production) and leaves it bare over HTTP (local dev) — accept both.
  const session =
    request.cookies.get("better-auth.session_token") ??
    request.cookies.get("__Secure-better-auth.session_token");
  const path = request.nextUrl.pathname;
  const isPublic =
    PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`)) ||
    path.startsWith("/api/");
  if (!session && !isPublic) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  // The proxy makes Next buffer the request body in memory, capped at 10MB by
  // default, which truncates large video uploads before the route sees them.
  // The three video routes stream their upload straight to disk and
  // /api/stage takes large multipart hf-driver uploads, so all stay out of
  // the proxy; every /api/* route authenticates the request itself.
  matcher: [
    // tiktok1evuq…txt: TikTok's site-verification signature file must be
    // publicly fetchable or URL-prefix verification fails.
    "/((?!_next/static|_next/image|_next/hmr|_next/webpack-hmr|favicon.ico|api/reels/prepare|api/videos|api/stories|api/stage|tiktok1evuqUunyZ47vScjZKHVD3zQksvJdTCA\\.txt).*)",
  ],
};
