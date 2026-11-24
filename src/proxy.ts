import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized, PASSWORDS } from "@/lib/passwords";

/** Every page needs the group password, except the login page and the scheduled job (which has its own secret). */
export async function proxy(request: NextRequest) {
  // Before a database is connected, let the pages show their setup notice.
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) return NextResponse.next();
  let ok = false;
  try {
    ok = await isAuthorized("site", request.cookies.get(PASSWORDS.site.cookie)?.value);
  } catch (err) {
    console.error("Password check failed", err);
    return new NextResponse("The site could not reach its database. Please try again in a moment.", { status: 503 });
  }
  if (ok) return NextResponse.next();
  const url = request.nextUrl.clone();
  const next = request.nextUrl.pathname + request.nextUrl.search;
  url.pathname = "/login";
  url.search = next && next !== "/" ? `?next=${encodeURIComponent(next)}` : "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!login|api/cron|_next/static|_next/image|favicon.ico).*)"],
};
