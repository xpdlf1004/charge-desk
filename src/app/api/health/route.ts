import { spendReport } from "../../../server/agent.ts";
import { runtime } from "../../../server/runtime.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  const rt = runtime();
  return Response.json({ mode: rt.mode, ai: spendReport() });
}
