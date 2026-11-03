"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CaseRecord, MerchantMetrics } from "../../core/cases.ts";
import type { Money } from "../../core/types.ts";

interface Data { mode: string; cases: CaseRecord[]; metrics: MerchantMetrics }
interface Proof { subscriptionId: string; status: string; planName: string }

export function Dashboard() {
  const [data, setData] = useState<Data>();
  const [working, setWorking] = useState<string>();
  const [proof, setProof] = useState<Record<string, Proof | string>>({});
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    const res = await fetch("/api/merchant", { cache: "no-store" });
    if (res.ok) setData(await res.json());
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 4000); // new inquiries show up while the customer is chatting
    return () => clearInterval(t);
  }, [load]);

  async function decide(caseId: string, action: "approve" | "decline") {
    setWorking(caseId);
    setError(undefined);
    try {
      const res = await fetch("/api/merchant/decide", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ caseId, action }) });
      const body = await res.json();
      if (!res.ok) return setError(body.error ?? "Couldn't update this request.");
      if (body.paypal) setProof((p) => ({ ...p, [caseId]: body.paypal }));
      else if (body.request?.paypalRefundId) setProof((p) => ({ ...p, [caseId]: `PayPal refund ${body.request.paypalRefundId} completed` }));
      await load();
    } finally {
      setWorking(undefined);
    }
  }

  if (!data) return <main className="merchant"><p>Loading…</p></main>;
  const m = data.metrics;
  const requests = data.cases.filter((c) => c.request);
  const pending = requests.filter((c) => c.request!.status === "pending");
  const handled = requests.filter((c) => c.request!.status !== "pending");

  return (
    <main className="merchant">
      <div className="merchant-head">
        <div>
          <h1>Charge questions</h1>
          <p>Customers who asked about a charge, and what the desk did.</p>
        </div>
        <button type="button" className="btn quiet" onClick={async () => { await fetch("/api/demo/reset", { method: "POST" }); setProof({}); await load(); }}>
          Reset demo
        </button>
      </div>

      <section className="numbers" aria-label="This month">
        <div><b><CountUp value={m.inquiries} /></b><span>questions answered</span></div>
        <div><b><CountUp value={m.explained} /></b><span>settled by an explanation</span></div>
        <div><b>{m.keptRevenue.length ? m.keptRevenue.map((k) => <MoneyUp key={k.currency} money={k} />) : "USD 0.00"}</b><span>sales kept, nothing refunded</span></div>
        <div><b><MoneyUp money={m.feesAtStake} /></b><span>dispute fees avoided (at {fmtMoney({ currency: m.feesAtStake.currency, value: 15 })} each)</span></div>
      </section>

      <section>
        <h2 className="section-title">Waiting for you</h2>
        {error && <p className="form-error">{error}</p>}
        {pending.length === 0 ? (
          <p className="empty-note">No requests right now. Refund and cancellation requests from customers land here for your approval.</p>
        ) : (
          <div className="requests">
            {pending.map((c) => (
              <article className="request" key={c.id}>
                <div>
                  <h3>{c.request!.kind === "cancel" ? "Cancel subscription" : "Refund"} for {c.customerEmail}</h3>
                  <span className="status pending">Waiting for approval</span>
                  <ul>{c.request!.summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
                </div>
                <div className="actions">
                  <button className="btn" disabled={working === c.id} onClick={() => decide(c.id, "approve")}>
                    {c.request!.kind === "cancel" ? "Approve cancellation" : "Approve refund"}
                  </button>
                  <button className="btn quiet" disabled={working === c.id} onClick={() => decide(c.id, "decline")}>Decline</button>
                </div>
              </article>
            ))}
          </div>
        )}
        {handled.map((c) => (
          <article className="request" key={c.id} style={{ marginTop: 14 }}>
            <div>
              <h3>{c.request!.kind === "cancel" ? "Cancel subscription" : "Refund"} for {c.customerEmail}</h3>
              <span className={`status ${c.request!.status}`}>{c.request!.status === "approved" ? "Approved" : "Declined"}</span>
              <Proof value={proof[c.id]} />
            </div>
          </article>
        ))}
      </section>

      <section>
        <h2 className="section-title">All questions</h2>
        {data.cases.length === 0 ? (
          <p className="empty-note">No questions yet. Open Payment help and ask about a charge.</p>
        ) : (
          <table className="log">
            <thead><tr><th>When</th><th>Customer</th><th>They asked</th><th>Outcome</th></tr></thead>
            <tbody>
              {data.cases.map((c) => (
                <tr key={c.id}>
                  <td>{new Date(c.openedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</td>
                  <td>{c.customerEmail ?? "Not verified"}</td>
                  <td>{c.question}</td>
                  <td>{OUTCOME[c.outcome]}{c.amount ? `, ${fmtMoney(c.amount)}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <p className="mode">Data: {data.mode === "sandbox" ? "live PayPal sandbox merchant account" : "built-in demo store"}</p>
    </main>
  );
}

function Proof({ value }: { value?: Proof | string }) {
  if (!value) return null;
  if (typeof value === "string") return <p className="paypal-proof">{value}</p>;
  return <p className="paypal-proof">PayPal now shows subscription {value.subscriptionId} ({value.planName}) as {value.status}</p>;
}

const OUTCOME: Record<CaseRecord["outcome"], string> = {
  explained: "Explained",
  request: "Request sent",
  not_ours: "Not our charge",
  no_match: "No matching payment",
};

function fmtMoney(m: Money): string {
  return `${m.currency} ${m.value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Counts up when the number changes, so a new saved sale is noticeable. */
function useCount(target: number, decimals: number) {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = from.current;
    if (start === target || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      from.current = target;
      return setV(target);
    }
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / 900);
      const eased = 1 - Math.pow(1 - k, 3);
      setV(Number((start + (target - start) * eased).toFixed(decimals)));
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, decimals]);
  return v;
}

function CountUp({ value }: { value: number }) {
  return <>{useCount(value, 0)}</>;
}

function MoneyUp({ money }: { money: Money }) {
  const v = useCount(money.value, 2);
  return <>{fmtMoney({ currency: money.currency, value: v })}</>;
}
