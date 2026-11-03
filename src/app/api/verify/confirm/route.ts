import { markVerified } from "../../../../server/agent.ts";
import { runtime } from "../../../../server/runtime.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { chatId, sessionId, code, email } = (await req.json().catch(() => ({}))) as Record<string, string | undefined>;
  if (!chatId || !sessionId || !code) return Response.json({ error: "missing fields" }, { status: 400 });
  const r = runtime().desk.confirmCode(sessionId, code.trim());
  if (!r.ok) return Response.json({ ok: false, reason: r.reason }, { status: 400 });
  markVerified(chatId, r.token, (email ?? "").trim().toLowerCase());
  return Response.json({ ok: true });
}
