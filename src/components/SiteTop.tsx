import Link from "next/link";

export function LeafMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 24 24" fill="none" stroke="#2f6b4f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z" />
      <path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12" />
    </svg>
  );
}

export function SiteTop({ current }: { current: "help" | "merchant" | "receipt" }) {
  return (
    <header className="site-top">
      <Link className="brand" href="/">
        <LeafMark />
        Brightleaf Studio
      </Link>
      <nav aria-label="Demo views">
        <Link href="/receipt" aria-current={current === "receipt" ? "page" : undefined}>Receipt email</Link>
        <Link href="/help" aria-current={current === "help" ? "page" : undefined}>Payment help</Link>
        <Link href="/merchant" aria-current={current === "merchant" ? "page" : undefined}>Studio dashboard</Link>
      </nav>
    </header>
  );
}
