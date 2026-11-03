import { runtime } from "../../../../server/runtime.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { email } = (await req.json().catch(() => ({}))) as { email?: string };
  if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) return Response.json({ error: "enter a valid email" }, { status: 400 });
  const rt = runtime();
  const sentBefore = Date.now();
  const r = await rt.desk.startVerification(email);
  // Demo inbox: no mail server, so the code is shown on screen. An email that never paid gets no code,
  // exactly like the real flow (the reply text is the same either way).
  const mail = rt.inbox.get(email.trim().toLowerCase());
  const demoCode = mail && mail.at >= sentBefore ? mail.code : undefined;
  return Response.json({ sessionId: r.sessionId, message: r.message, demoInbox: demoCode ? { to: email, code: demoCode } : null });
}
