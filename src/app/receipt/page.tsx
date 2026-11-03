import Link from "next/link";
import { SiteTop, LeafMark } from "../../components/SiteTop.tsx";

export const metadata = { title: "Receipt email · Brightleaf Studio" };

// The receipt Brightleaf sends after the first paid month. Its help link is where the customer
// starts, instead of the card issuer's "dispute this charge" button.
export default function ReceiptPage() {
  return (
    <>
      <SiteTop current="receipt" />
      <article className="mail">
        <div className="mail-meta">
          <span><b>Brightleaf Studio</b> &lt;hello@brightleaf.example&gt;</span>
          <span>To: mina@example.com</span>
          <span>Subject: Your Brightleaf receipt</span>
        </div>
        <div className="mail-body">
          <LeafMark />
          <h1>Thanks for practicing with us</h1>
          <p>Your free trial ended, so your monthly membership has started. Here's your receipt.</p>
          <table className="receipt-lines">
            <tbody>
              <tr><td>Monthly membership, first paid month</td><td>USD 9.99</td></tr>
              <tr className="total"><td>Paid with PayPal</td><td>USD 9.99</td></tr>
            </tbody>
          </table>
          <p>On your card statement this shows as <span className="statement-text">PAYPAL * Brightleaf St</span>. Cards in other currencies show the converted amount.</p>
          <div className="mail-help">
            <Link href="/help?from=receipt">Questions about this charge?</Link>
            <p>Ask us and get an answer right away, with the details of what you paid for.</p>
          </div>
        </div>
      </article>
    </>
  );
}
