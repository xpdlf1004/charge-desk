import { resetChats } from "../../../../server/agent.ts";
import { resetRuntime } from "../../../../server/runtime.ts";

export const dynamic = "force-dynamic";

export async function POST() {
  resetChats();
  const rt = resetRuntime();
  return Response.json({ ok: true, mode: rt.mode });
}
