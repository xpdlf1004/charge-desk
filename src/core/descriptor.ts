// Card statements show PAYPAL_prefix + (space) + merchant descriptor + (space) + soft descriptor,
// cut to 22 characters (Orders v2 soft_descriptor docs: "PAYPAL * Janes Gift 80").
// This module rebuilds that string for a candidate merchant and scores it against what was printed.

export const STATEMENT_LIMIT = 22;
export const PAYPAL_PREFIX = "PAYPAL *";

const PREFIX_RE = /^(?:PAYPAL\s*\*|PP\s*\*)\s*/i;

/** True when a statement descriptor looks like a PayPal charge. */
export function isPaypalDescriptor(text: string): boolean {
  return PREFIX_RE.test(text.trim());
}

/** Strip the PayPal prefix, keeping only the merchant part as printed. */
export function stripPrefix(text: string): string {
  return text.trim().replace(PREFIX_RE, "");
}

/** Uppercase and drop everything except letters and digits, so spacing/punctuation differences don't matter. */
export function normalize(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** What the statement would print for this merchant + order, before any bank-side mangling. */
export function buildStatementText(descriptorPrefix: string, softDescriptor?: string): string {
  return fullStatementText(descriptorPrefix, softDescriptor).slice(0, STATEMENT_LIMIT);
}

function fullStatementText(descriptorPrefix: string, softDescriptor?: string): string {
  return [PAYPAL_PREFIX, descriptorPrefix, softDescriptor].filter(Boolean).join(" ");
}

/** Merchant part of the predicted statement text (after "PAYPAL *"). */
export function predictedMerchantPart(descriptorPrefix: string, softDescriptor?: string): string {
  return stripPrefix(buildStatementText(descriptorPrefix, softDescriptor));
}

/**
 * Score 0..1 for how well a printed descriptor matches a candidate merchant.
 * Banks sometimes cut further or squash spaces, so we compare normalized strings
 * and give full credit when one is a prefix of the other.
 */
export function descriptorScore(printed: string, descriptorPrefix: string, softDescriptor?: string): number {
  const a = normalize(stripPrefix(printed));
  const b = normalize(predictedMerchantPart(descriptorPrefix, softDescriptor));
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (longer.startsWith(shorter)) {
    // Prefix match; very short overlaps are weak evidence.
    return shorter.length >= 6 ? 0.95 : 0.6;
  }
  return similarity(a, b);
}

/** Levenshtein-based similarity in 0..1. */
export function similarity(a: string, b: string): number {
  const d = levenshtein(a, b);
  return 1 - d / Math.max(a.length, b.length);
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Suggest a descriptor that stays readable within the 22-character limit (merchant-side tool). */
export function previewForMerchant(descriptorPrefix: string, softDescriptor?: string) {
  const full = fullStatementText(descriptorPrefix, softDescriptor);
  const shown = full.slice(0, STATEMENT_LIMIT);
  return { full, shown, truncated: full.length > STATEMENT_LIMIT, lostText: full.slice(STATEMENT_LIMIT) };
}
