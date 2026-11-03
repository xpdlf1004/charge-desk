import Anthropic from "@anthropic-ai/sdk";
import { BudgetExceeded, newChatId, runTurn } from "../../../server/agent.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { chatId?: string; text?: string };
  const text = (body.text ?? "").trim().slice(0, 1000);
  if (!text) return Response.json({ error: "empty message" }, { status: 400 });
  const chatId = body.chatId && /^[0-9a-f]{32}$/.test(body.chatId) ? body.chatId : newChatId();
  try {
    return Response.json({ chatId, ...(await runTurn(chatId, text)) });
  } catch (e) {
    if (e instanceof BudgetExceeded) return Response.json({ chatId, error: "The demo has used today's AI budget. It resets at midnight UTC." }, { status: 429 });
    if (e instanceof Anthropic.RateLimitError) return Response.json({ chatId, error: "busy, try again in a moment" }, { status: 429 });
    if (e instanceof Anthropic.APIError) return Response.json({ chatId, error: `AI service error (${e.status})` }, { status: 502 });
    console.error(e);
    return Response.json({ chatId, error: "something went wrong" }, { status: 500 });
  }
}
