import { auth } from "@/lib/auth";
import { nanoid } from "nanoid/non-secure";
import { NextRequest, NextResponse } from "next/server";
import { getTenantContextOrNull } from "@/lib/auth-server";

export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV !== "development") {
    throw new Error("This endpoint is only available in development");
  }
  const tenant = await getTenantContextOrNull();
  if (!tenant) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Stamp the active org into the key metadata (WI-5) so the daemon-token read
  // path resolves a tenant. Nullable-safe: no active org = no metadata.
  const token = await auth.api.createApiKey({
    body: {
      name: `daemon-token-${nanoid()}`,
      expiresIn: 60 * 60 * 24 * 30, // 30 days,
      userId: tenant.userId,
      ...(tenant.organizationId
        ? { metadata: { organizationId: tenant.organizationId } }
        : {}),
    },
  });
  return NextResponse.json({
    token: token.key,
  });
}
