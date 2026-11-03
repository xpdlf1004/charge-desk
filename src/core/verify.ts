// Email one-time codes. Nothing about any order is shown until the customer proves they own
// the email used at checkout. The reply is the same whether or not that email ever paid us,
// so nobody can probe "did this person buy here?".

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;

export const START_MESSAGE =
  "If that email was used to pay us, we just sent it a 6-digit code. Enter it to continue.";

export interface OtpRecord {
  email: string;
  known: boolean; // false = decoy session for an email that never paid us; no code was sent
  salt: string;
  codeHash: string;
  expiresAt: number;
  attempts: number;
}

export interface OtpStore {
  get(id: string): OtpRecord | undefined;
  set(id: string, rec: OtpRecord): void;
  delete(id: string): void;
}

export function memoryStore(): OtpStore {
  const m = new Map<string, OtpRecord>();
  return { get: (id) => m.get(id), set: (id, r) => void m.set(id, r), delete: (id) => void m.delete(id) };
}

export interface VerifyDeps {
  store: OtpStore;
  send: (email: string, code: string) => void | Promise<void>;
  now?: () => number;
  makeCode?: () => string; // injectable for tests and the judges' demo mode
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function startVerification(
  claimedEmail: string,
  payerEmails: Set<string>,
  deps: VerifyDeps,
): Promise<{ sessionId: string; message: string }> {
  const email = normalizeEmail(claimedEmail);
  const known = payerEmails.has(email);
  const code = (deps.makeCode ?? defaultCode)();
  const salt = randomBytes(16).toString("hex");
  const sessionId = randomBytes(16).toString("hex");
  deps.store.set(sessionId, {
    email,
    known,
    salt,
    codeHash: hash(salt, code),
    expiresAt: (deps.now ?? Date.now)() + CODE_TTL_MS,
    attempts: 0,
  });
  if (known) await deps.send(email, code);
  return { sessionId, message: START_MESSAGE };
}

export type CheckResult = { ok: true; email: string } | { ok: false; reason: "wrong" | "expired" | "locked" | "unknown" };

export function checkCode(sessionId: string, code: string, deps: Pick<VerifyDeps, "store" | "now">): CheckResult {
  const rec = deps.store.get(sessionId);
  if (!rec) return { ok: false, reason: "unknown" };
  if ((deps.now ?? Date.now)() > rec.expiresAt) {
    deps.store.delete(sessionId);
    return { ok: false, reason: "expired" };
  }
  if (rec.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "locked" };
  rec.attempts += 1;
  deps.store.set(sessionId, rec);
  const match = safeEqual(rec.codeHash, hash(rec.salt, code.trim()));
  // A decoy session never verifies, but fails exactly like a wrong code.
  if (!match || !rec.known) return { ok: false, reason: rec.attempts >= MAX_ATTEMPTS ? "locked" : "wrong" };
  deps.store.delete(sessionId);
  return { ok: true, email: rec.email };
}

function defaultCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function hash(salt: string, code: string): string {
  return createHash("sha256").update(salt + ":" + code).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}
