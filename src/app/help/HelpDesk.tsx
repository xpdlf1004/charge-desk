"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Card, TurnResult } from "../../server/agent.ts";

const VERIFIED_NOTE = "I verified my email."; // same text as the server constant

type Item =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "note"; text: string }
  | { kind: "verify" };

type Verify =
  | { phase: "email"; error?: string }
  | { phase: "code"; sessionId: string; email: string; message: string; error?: string }
  | { phase: "done"; email: string };

type PanelCard = Exclude<Card, { type: "verify" } | { type: "request" }>;

const SUGGESTIONS = [
  "I was charged ₩13,900 and I don't know why",
  "What is PAYPAL *QUICKWINPRIZE?",
  "Two charges, ₩89,280 and ₩50,220?",
];

export function HelpDesk({ fromReceipt }: { fromReceipt: boolean }) {
  const [chatId, setChatId] = useState<string>();
  const [items, setItems] = useState<Item[]>([
    { kind: "agent", text: fromReceipt ? "Hi! Which charge on your statement can I help you with?" : "Hi! Tell me about a charge you don't recognize: the amount, the date, or the name on your statement." },
  ]);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [verify, setVerify] = useState<Verify>();
  const [panel, setPanel] = useState<PanelCard>();
  const [requestStatus, setRequestStatus] = useState<Record<string, { kind: string; status: string }>>({});
  const [inbox, setInbox] = useState<{ to: string; code: string }>();
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [items, busy, verify]);

  async function send(text: string, opts: { silent?: boolean } = {}) {
    if (!text.trim() || busy) return;
    if (!opts.silent) setItems((xs) => [...xs, { kind: "user", text }]);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, text }) });
      const data = (await res.json()) as Partial<TurnResult> & { chatId?: string; error?: string };
      if (data.chatId) setChatId(data.chatId);
      if (!res.ok) {
        setItems((xs) => [...xs, { kind: "note", text: data.error ?? "Something went wrong. Try again." }]);
        return;
      }
      const next: Item[] = [];
      if (data.reply) next.push({ kind: "agent", text: data.reply });
      for (const c of data.cards ?? []) {
        if (c.type === "verify") {
          setVerify({ phase: "email" });
          next.push({ kind: "verify" });
        } else if (c.type === "request") {
          setRequestStatus((r) => ({ ...r, [c.caseId]: { kind: c.kind, status: c.status } }));
        } else {
          setPanel(c);
        }
      }
      setItems((xs) => [...xs, ...next]);
    } finally {
      setBusy(false);
    }
  }

  async function submitEmail(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email") ?? "").trim();
    const res = await fetch("/api/verify/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
    const data = await res.json();
    if (!res.ok) return setVerify({ phase: "email", error: data.error });
    setVerify({ phase: "code", sessionId: data.sessionId, email, message: data.message });
    if (data.demoInbox) setInbox(data.demoInbox);
  }

  async function submitCode(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (verify?.phase !== "code") return;
    const code = String(new FormData(e.currentTarget).get("code") ?? "");
    const res = await fetch("/api/verify/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, sessionId: verify.sessionId, code, email: verify.email }),
    });
    const data = await res.json();
    if (!res.ok) {
      const reason = data.reason === "expired" ? "That code expired. Ask for a new one." : data.reason === "locked" ? "Too many tries. Ask for a new code." : "That code doesn't match. Check the email and try again.";
      return setVerify({ ...verify, error: reason });
    }
    setVerify({ phase: "done", email: verify.email });
    setInbox(undefined);
    await send(VERIFIED_NOTE, { silent: true });
  }

  return (
    <div className="desk">
      <section className="chat" aria-label="Payment help chat">
        <div className="chat-head">
          <h1>Payment help</h1>
          <p>Ask about any Brightleaf charge. Answers come from our PayPal records.</p>
        </div>
        <div className="thread" ref={threadRef} aria-live="polite">
          {items.map((it, i) =>
            it.kind === "verify" ? (
              <VerifyBox key={i} verify={verify} onEmail={submitEmail} onCode={submitCode} onRestart={() => setVerify({ phase: "email" })} />
            ) : (
              <div key={i} className={`msg ${it.kind}`}>
                {it.kind === "agent" ? <TypeOut text={it.text} /> : it.text}
              </div>
            ),
          )}
          {busy && (
            <div className="msg agent typing" aria-label="Typing">
              <i /><i /><i />
            </div>
          )}
        </div>
        {items.length <= 1 && (
          <div className="suggest">
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" onClick={() => send(s)}>{s}</button>
            ))}
          </div>
        )}
        <form className="composer" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Describe the charge" aria-label="Your message" maxLength={1000} />
          <button className="btn" disabled={busy || !input.trim()}>Send</button>
        </form>
      </section>

      <section className="panel" aria-label="What we found">
        <Panel card={panel} requestStatus={requestStatus} />
      </section>

      {inbox && (
        <aside className="inbox" role="status">
          <button type="button" onClick={() => setInbox(undefined)} aria-label="Close demo inbox">×</button>
          <small>Demo inbox for {inbox.to}</small>
          <div>Your Brightleaf code</div>
          <div className="code">{inbox.code}</div>
        </aside>
      )}
    </div>
  );
}

function VerifyBox({ verify, onEmail, onCode, onRestart }: {
  verify?: Verify;
  onEmail: (e: FormEvent<HTMLFormElement>) => void;
  onCode: (e: FormEvent<HTMLFormElement>) => void;
  onRestart: () => void;
}) {
  if (!verify) return null;
  if (verify.phase === "done") return <div className="verify-box"><span className="done">Verified {verify.email}</span></div>;
  if (verify.phase === "email") {
    return (
      <div className="verify-box">
        <p>Enter the email you paid with. We'll send it a 6-digit code.</p>
        <form key="email" onSubmit={onEmail}>
          <input name="email" type="email" required placeholder="you@example.com" aria-label="Email you paid with" autoComplete="email" />
          <button className="btn">Send code</button>
        </form>
        {verify.error && <span className="form-error">{verify.error}</span>}
      </div>
    );
  }
  return (
    <div className="verify-box">
      <p>{verify.message}</p>
      <form key="code" onSubmit={onCode}>
        <input name="code" inputMode="numeric" pattern="[0-9]{6}" required placeholder="6-digit code" aria-label="6-digit code" autoComplete="one-time-code" />
        <button className="btn">Verify</button>
      </form>
      {verify.error && <span className="form-error">{verify.error}</span>}
      <button type="button" className="btn quiet" onClick={onRestart}>Use a different email</button>
    </div>
  );
}

function Panel({ card, requestStatus }: { card?: PanelCard; requestStatus: Record<string, { kind: string; status: string }> }) {
  if (!card) {
    return (
      <div className="panel-empty">
        <h2>Not sure what a charge is?</h2>
        <p>Tell us what you see on your statement. Once you confirm your email, we'll show the payment it matches and why it was charged.</p>
      </div>
    );
  }
  if (card.type === "descriptor") {
    return card.ours ? (
      <div className="notours">
        <h2>Yes, that's us</h2>
        <p>Brightleaf charges show on statements as:</p>
        <ul>{card.howWeAppear.map((h) => <li key={h} className="statement-text">{h}</li>)}</ul>
      </div>
    ) : (
      <div className="notours">
        <h2>That charge isn't from Brightleaf</h2>
        <p><span className="statement-text">{card.descriptor}</span> doesn't match any name we use. Our charges show as:</p>
        <ul>{card.howWeAppear.map((h) => <li key={h} className="statement-text">{h}</li>)}</ul>
        <p>Your bank can tell you who that merchant is.</p>
      </div>
    );
  }
  if (card.type === "choose") {
    return (
      <div className="choose">
        <h2>{card.reason === "ask" ? `A few of your payments could match. What ${card.field === "date" ? "date" : card.field === "amount" ? "amount" : "name"} do you see?` : "Which one is it?"}</h2>
        <ul>{card.payments.map((p) => <li key={p.txIds[0]}><span>{niceDate(p.date)}</span><span>{p.amount}</span></li>)}</ul>
      </div>
    );
  }
  if (card.type === "none") {
    return (
      <div className="notours">
        <h2>No matching payment for this email</h2>
        <p>We couldn't find a Brightleaf payment like that from this email. If you paid with another email, verify that one instead.</p>
      </div>
    );
  }
  const req = requestStatus[card.caseId];
  return (
    <article className="found" key={card.caseId}>
      <div className="found-head">
        <h2>{card.payment.items.length ? card.payment.items.slice(0, 2).join(" + ") + (card.payment.items.length > 2 ? ` and ${card.payment.items.length - 2} more` : "") : "Brightleaf payment"}</h2>
        <p>
          {card.payment.parts
            ? `One order, charged in ${card.payment.parts.length} parts: ${card.payment.parts.map((x) => `${x.amount} on ${niceDate(x.date)}`).join(" and ")}`
            : `Paid ${niceDate(card.payment.date)}`}
        </p>
      </div>
      <div className="match-strip">
        <div className="match-side bank">
          <small>On your statement</small>
          <strong className="statement-text">{card.statement}</strong>
          {card.quoted && <span className="statement-text">{card.quoted}</span>}
        </div>
        <div className="match-link" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 17H7A5 5 0 0 1 7 7h2" /><path d="M15 7h2a5 5 0 1 1 0 10h-2" /><line x1="8" x2="16" y1="12" y2="12" /></svg>
        </div>
        <div className="match-side record">
          <small>In our PayPal records</small>
          <strong>{card.payment.amount}</strong>
          <span>{card.payment.items.join(", ")}</span>
        </div>
      </div>
      <ul className="evidence">
        {[...card.evidence].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind)).map((e, i) => (
          <li key={i} className="reveal" style={{ animationDelay: `${300 + i * 380}ms` }}>
            <span className="tick" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            </span>
            <div>
              <div className="what">{EVIDENCE_LABEL[e.kind] ?? "Match"}</div>
              <div className="detail">{e.detail}</div>
            </div>
          </li>
        ))}
      </ul>
      {card.recurring && card.alternatives.length > 0 && !req && (
        <div className="options">
          <h3>Not ready to keep paying?</h3>
          <ul>{card.alternatives.map((a) => <li key={a}>{a}</li>)}</ul>
        </div>
      )}
      {req && (
        <div className="options">
          <span className={`status ${req.status}`}>
            {req.kind === "cancel" ? "Cancellation" : "Refund"} {req.status === "pending" ? "sent to the studio for approval" : req.status}
          </span>
        </div>
      )}
    </article>
  );
}

// The reason comes first; matching details follow as proof.
const ORDER = ["order", "recurring", "amount", "date", "name"];

function niceDate(iso: string): string {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

const EVIDENCE_LABEL: Record<string, string> = {
  name: "Statement name matches",
  amount: "Amount matches",
  date: "Date matches",
  order: "What you bought",
  recurring: "Recurring payment",
};

/** Reveals the agent's reply progressively, like it is being written. */
function TypeOut({ text }: { text: string }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return setN(text.length);
    setN(0);
    const step = Math.max(1, Math.ceil(text.length / 60));
    const t = setInterval(() => setN((x) => (x + step >= text.length ? (clearInterval(t), text.length) : x + step)), 16);
    return () => clearInterval(t);
  }, [text]);
  return <>{text.slice(0, n)}</>;
}
