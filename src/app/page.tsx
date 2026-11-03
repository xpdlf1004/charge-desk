import Link from "next/link";
import { runtime } from "../server/runtime.ts";

export const dynamic = "force-dynamic";

export default function Home() {
  const mode = runtime().mode;
  return (
    <main className="index">
      <h1>Every charge, explained before it's disputed.</h1>
      <p>
        Charge Desk is an AI agent that a PayPal merchant puts on its own site. A customer who doesn't recognize a
        charge asks about it, proves the email they paid with, and gets the answer with evidence from the merchant's
        PayPal records. Refunds and cancellations go to the merchant for one-click approval.
      </p>
      <ul className="tour">
        <li>
          <Link href="/receipt">
            <b>Receipt email</b>
            <span>Where a confused customer starts: the receipt's "Questions about this charge?" link.</span>
          </Link>
        </li>
        <li>
          <Link href="/help">
            <b>Payment help</b>
            <span>Ask about a charge. Try mina@example.com when it asks for your email.</span>
          </Link>
        </li>
        <li>
          <Link href="/merchant">
            <b>Studio dashboard</b>
            <span>The merchant's side: requests to approve and what the desk saved.</span>
          </Link>
        </li>
      </ul>
      <p className="mode">
        Data: {mode === "sandbox" ? "live PayPal sandbox merchant account" : "built-in demo store (no PayPal account needed)"}
      </p>
    </main>
  );
}
