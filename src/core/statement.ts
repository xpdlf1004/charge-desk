// Parse pasted statement text into StatementLine records. Only PayPal lines are returned.

import { isPaypalDescriptor, stripPrefix } from "./descriptor.ts";
import type { StatementLine } from "./types.ts";

const CURRENCY_SYMBOLS: Record<string, string> = { "₩": "KRW", "$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY" };

// Amount like "₩16,820", "16,820원", "$12.99", "12.99 USD", "-4.50"
const AMOUNT_RE = /(-?)\s*([₩$€£¥])?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(원|KRW|USD|EUR|GBP|JPY)?/gi;
// Dates like 2026-11-02, 2026.11.02, 11/02, 11.02
const DATE_RE = /\b(?:(\d{4})[-./](\d{1,2})[-./](\d{1,2})|(\d{1,2})[/.](\d{1,2}))\b/;
const PREFIX_FIND_RE = /(PAYPAL\s*\*|PP\s*\*)/i;

export interface ParseOptions {
  year: number; // used when the statement omits the year
  defaultCurrency: string; // card's billing currency
}

export function parseStatement(text: string, opts: ParseOptions): StatementLine[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => parseLine(l, opts))
    .filter((x): x is StatementLine => x !== null);
}

export function parseLine(line: string, opts: ParseOptions): StatementLine | null {
  const start = line.search(PREFIX_FIND_RE);
  if (start < 0) return null;

  const dateMatch = line.match(DATE_RE);
  const date = dateMatch ? toIsoDate(dateMatch, opts.year) : null;
  if (!date) return null;

  // Descriptor = from the PayPal prefix up to the first date/amount token after it.
  const tail = line.slice(start);
  const cut = firstIndex(tail, [DATE_RE, /[₩$€£¥]|\d{1,3}(?:,\d{3})+|\d+\.\d{2}|\d+원/]);
  const descriptorWithPrefix = (cut > 0 ? tail.slice(0, cut) : tail).trim();
  if (!isPaypalDescriptor(descriptorWithPrefix)) return null;

  const amount = lastAmount(line.replace(dateMatch![0], " "), opts.defaultCurrency);
  if (!amount) return null;

  return { raw: line, descriptor: stripPrefix(descriptorWithPrefix), date, amount };
}

function firstIndex(s: string, patterns: RegExp[]): number {
  // Skip the prefix itself ("PAYPAL *") so digits in the merchant part after it are still kept.
  const offset = 8;
  let best = -1;
  for (const p of patterns) {
    const m = s.slice(offset).match(p);
    if (m && m.index !== undefined) {
      const i = m.index + offset;
      // A token glued to letters (e.g. "STUDIO80") is part of the descriptor, not an amount.
      if (i > 0 && /[A-Za-z]/.test(s[i - 1])) continue;
      if (best < 0 || i < best) best = i;
    }
  }
  return best;
}

function lastAmount(s: string, defaultCurrency: string) {
  let last: { currency: string; value: number } | null = null;
  for (const m of s.matchAll(AMOUNT_RE)) {
    const [, minus, sym, intPart, frac, suffix] = m;
    if (!sym && !suffix && !frac && !intPart.includes(",")) continue; // bare integers are too ambiguous
    const currency = sym ? CURRENCY_SYMBOLS[sym] : suffix ? (suffix === "원" ? "KRW" : suffix.toUpperCase()) : defaultCurrency;
    const value = Number(intPart.replace(/,/g, "") + (frac ? "." + frac : ""));
    last = { currency, value: minus ? -value : value };
  }
  return last;
}

function toIsoDate(m: RegExpMatchArray, year: number): string | null {
  const [y, mo, d] = m[1] ? [Number(m[1]), Number(m[2]), Number(m[3])] : [year, Number(m[4]), Number(m[5])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
