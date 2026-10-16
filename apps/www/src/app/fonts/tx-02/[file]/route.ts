import { serveTx02Font } from "@/server-lib/tx02-font";
import { getR2Binding } from "@/lib/r2-binding";

/**
 * Serves the licensed TX-02 webfont from the private R2 bucket, same-origin.
 * The font files never live in the repo (it is public); see DESIGN.md.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ file: string }> },
) {
  const { file } = await params;
  return serveTx02Font({
    file,
    bucket: getR2Binding("R2_PRIVATE_BUCKET") ?? null,
  });
}
