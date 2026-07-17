import { env } from "@terragon/env/apps-www";
import { R2Client } from "@terragon/r2";
import { getR2Binding } from "@/lib/r2-binding";

// Same-origin Worker upload proxy the native driver points browser uploads at
// (bindings can't presign). See apps/www/src/app/api/r2-upload/route.ts.
const R2_UPLOAD_PROXY_PATH = "/api/r2-upload";

export const r2Public = new R2Client({
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  accountId: env.R2_ACCOUNT_ID,
  bucketName: env.R2_BUCKET_NAME,
  publicUrl: env.R2_PUBLIC_URL,
  // On Workers, use the native R2_BUCKET binding (no S3 creds); else S3.
  resolveBinding: () => getR2Binding("R2_BUCKET"),
  uploadProxyPath: R2_UPLOAD_PROXY_PATH,
});

export const r2Private = new R2Client({
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  accountId: env.R2_ACCOUNT_ID,
  bucketName: env.R2_PRIVATE_BUCKET_NAME,
  // On Workers, use the native R2_PRIVATE_BUCKET binding (no S3 creds); else S3.
  resolveBinding: () => getR2Binding("R2_PRIVATE_BUCKET"),
  uploadProxyPath: R2_UPLOAD_PROXY_PATH,
});
