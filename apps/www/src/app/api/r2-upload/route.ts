import { NextRequest, NextResponse } from "next/server";
import { env } from "@terragon/env/apps-www";
import { getUserIdOrNull } from "@/lib/auth-server";
import { r2Public, r2Private } from "@/server-lib/r2";

/**
 * Worker upload proxy for the native R2 binding (Cloudflare). Native bindings
 * can't produce S3 presigned URLs, so in native mode packages/r2 returns a URL to
 * THIS route; the browser PUTs the file here exactly as it would a presigned URL,
 * and we write it through the binding — no S3 credentials anywhere.
 *
 * Auth: requires a session, and the object key must be scoped to the acting user
 * (upload keys are `<prefix>/<userId>/…`), so a user can only write under their
 * own path. Path traversal is rejected.
 */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  const userId = await getUserIdOrNull();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const key = searchParams.get("key");
  const bucket = searchParams.get("bucket");
  if (!key || !bucket) {
    return NextResponse.json(
      { error: "Missing key or bucket" },
      { status: 400 },
    );
  }
  // Reject traversal and require the key to be scoped to the acting user.
  if (key.includes("..") || !key.split("/").includes(userId)) {
    return NextResponse.json({ error: "Forbidden key" }, { status: 403 });
  }

  // Map the bucket name to the configured client (public vs private).
  const client =
    bucket === env.R2_BUCKET_NAME
      ? r2Public
      : bucket === env.R2_PRIVATE_BUCKET_NAME
        ? r2Private
        : null;
  if (!client) {
    return NextResponse.json({ error: "Unknown bucket" }, { status: 400 });
  }

  const contentType =
    request.headers.get("content-type") ?? "application/octet-stream";
  const body = Buffer.from(await request.arrayBuffer());

  try {
    await client.putObject(key, body, contentType);
    return NextResponse.json({ key });
  } catch (error) {
    console.error("[r2-upload] failed to write object", { key, error });
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
