import { createRunHandler } from "@/server/run-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return createRunHandler(request);
}
