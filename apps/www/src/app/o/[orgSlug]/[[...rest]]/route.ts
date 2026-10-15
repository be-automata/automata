import { NextRequest, NextResponse } from "next/server";

import { getUserIdOrNull } from "@/lib/auth-server";
import { buildOrgLinkTarget } from "@/lib/org-link";
import { activateOrganizationBySlugForUser } from "@/server-lib/active-organization";

/**
 * GET /o/<orgSlug>/<path...>
 *
 * A shareable org-scoped link. Signed out: off to the login page, which
 * brings the user back here. Signed in and a member of the org: the session's
 * active org becomes that org and the browser lands on `/<path>` (with the
 * original query), `/dashboard` when there is no path.
 *
 * An unknown slug and an org the user does not belong to both answer 404, so
 * the link never reveals whether an org exists. A path that cannot be turned
 * into a same-origin target also 404s, before the session is touched.
 *
 * The existing routes have not moved yet: this switches and redirects. See
 * DESIGN.md, Layout.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgSlug: string; rest?: string[] }> },
) {
  const { orgSlug, rest } = await params;
  const target = buildOrgLinkTarget(rest, request.nextUrl.search);
  if (!target) {
    return notFound();
  }

  const userId = await getUserIdOrNull();
  if (!userId) {
    const login = new URL("/login", request.url);
    login.searchParams.set(
      "returnUrl",
      `${request.nextUrl.pathname}${request.nextUrl.search}`,
    );
    return redirectTo(login);
  }

  const activated = await activateOrganizationBySlugForUser({
    userId,
    slug: orgSlug,
  });
  if (!activated) {
    return notFound();
  }
  return redirectTo(new URL(target, request.url));
}

function redirectTo(url: URL): NextResponse {
  const response = NextResponse.redirect(url, 307);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function notFound(): NextResponse {
  return new NextResponse("Not found", {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });
}
