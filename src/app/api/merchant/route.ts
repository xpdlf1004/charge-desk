import { runtime } from "../../../server/runtime.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  const rt = runtime();
  return Response.json({ mode: rt.mode, cases: [...rt.desk.cases()].reverse(), metrics: rt.desk.metrics() });
}
