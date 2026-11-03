import { runtime } from "../../../../server/runtime.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { caseId, action } = (await req.json().catch(() => ({}))) as { caseId?: string; action?: string };
  if (!caseId || (action !== "approve" && action !== "decline")) return Response.json({ error: "bad request" }, { status: 400 });
  const { desk } = runtime();
  try {
    const request = action === "approve" ? await desk.approve(caseId) : desk.decline(caseId);
    // Show what PayPal now says, so the screen proves the change happened on PayPal, not just here.
    const paypal = request.kind === "cancel" && request.subscriptionId && action === "approve" ? await desk.subscriptionStatus(request.subscriptionId) : undefined;
    return Response.json({ request, paypal });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
