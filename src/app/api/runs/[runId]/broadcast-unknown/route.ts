import { recordBroadcastUnknownHandler } from "@/server/run-api";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ runId: string }> },
): Promise<Response> {
  const { runId } = await context.params;
  return recordBroadcastUnknownHandler(request, runId);
}
