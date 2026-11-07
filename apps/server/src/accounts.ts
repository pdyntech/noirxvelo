/**
 * Website accounts: sign up, sign in, email verification, password reset, password change,
 * sessions, plus enquiry and newsletter capture.
 *
 * - Passwords: scrypt with a per-user salt; compared in constant time. Unknown emails still pay the
 *   hashing cost, so response time does not reveal which emails have accounts.
 * - Sessions: random 256-bit token in an HttpOnly, SameSite=Lax cookie (Secure over HTTPS). Only its
 *   sha256 is stored. 30-day lifetime; ended on sign out, password reset, or "sign out everywhere".
 * - Email links: random one-time tokens (sha256 stored), 24 h for verification and 30 min for reset.
 * - Rate limits on sign-in, sign-up and email sends.
 */
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { ACCOUNT_ROLES, db, save, type AccountRole, type AuthToken, type Session, type User } from "./db.js";
import { env } from "./env.js";
import { HttpError, clientIp, isHttps, parseCookies } from "./http.js";
import { actionEmail, devLinks, mailConfigured, sendMail } from "./mailer.js";

const COOKIE = "sailo_sid";
const SESSION_DAYS = 30;
const VERIFY_TTL = 24 * 3_600_000;
const RESET_TTL = 30 * 60_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Money-moving portal actions need a verified email whenever verification is possible:
 * real email is configured, or development links are shown. A production deploy without SMTP_URL
 * cannot deliver links, so it does not block users (and logs a warning at startup).
 */
export const verificationRequired = mailConfigured || devLinks;
if (process.env.NODE_ENV === "production" && !mailConfigured) {
  console.warn("auth: SMTP_URL is not set, so verification and password-reset emails cannot be sent.");
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  company: string;
  role: AccountRole;
  emailVerified: boolean;
}

export const publicUser = (u: User): PublicUser => ({
  id: u.id,
  email: u.email,
  name: u.name,
  company: u.company,
  role: u.role,
  emailVerified: Boolean(u.emailVerifiedAt),
});

export const authConfig = () => ({ mail: mailConfigured, verificationRequired, devLinks });

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const now = () => Date.now();

function str(v: unknown, field: string, max: number, required = true): string {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (required && !s) throw new HttpError(400, `Enter your ${field}.`);
  if (s.length > max) throw new HttpError(400, `${field[0]!.toUpperCase() + field.slice(1)} is too long.`);
  return s;
}

export function normEmail(v: unknown): string {
  const e = str(v, "email", 200).toLowerCase();
  if (!EMAIL_RE.test(e)) throw new HttpError(400, "Enter a valid email address.");
  return e;
}

// ---------- passwords ----------
const COMMON = new Set(
  "password password1 password123 12345678 123456789 1234567890 qwerty123 qwertyuiop iloveyou admin123 welcome1 letmein1 11111111 00000000 abc12345 sailo123 changeme passw0rd football baseball sunshine".split(" "),
);

function checkNewPassword(pw: unknown, u: { email: string; name?: string }): string {
  const p = typeof pw === "string" ? pw : "";
  if (p.length < 8) throw new HttpError(400, "Use a password of at least 8 characters.");
  if (p.length > 200) throw new HttpError(400, "That password is too long.");
  const low = p.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/.test(p)) throw new HttpError(400, "That password is too easy to guess. Choose a less common one.");
  if (low === u.email || low === u.email.split("@")[0] || (u.name && low === u.name.toLowerCase().replace(/\s+/g, ""))) {
    throw new HttpError(400, "Don’t use your email or name as your password.");
  }
  return p;
}

function hashPassword(pw: string, salt: string): string {
  return scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
}

function passwordMatches(u: User, pw: string): boolean {
  const a = Buffer.from(hashPassword(pw, u.salt), "hex");
  const b = Buffer.from(u.hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function setPassword(u: User, pw: string): void {
  u.salt = randomBytes(16).toString("hex");
  u.hash = hashPassword(pw, u.salt);
  u.passwordChangedAt = new Date().toISOString();
}

const DUMMY_SALT = randomBytes(16).toString("hex");

// ---------- rate limits ----------
const buckets = new Map<string, { n: number; until: number }>();
/** Counts an attempt under `key`; throws 429 once `max` is reached within the window. */
function limit(key: string, max: number, windowMs: number, message: string): void {
  const t = now();
  if (buckets.size > 20_000) for (const [k, v] of buckets) if (v.until <= t) buckets.delete(k);
  const b = buckets.get(key);
  if (b && b.until > t) {
    if (b.n >= max) throw new HttpError(429, message);
    b.n += 1;
  } else buckets.set(key, { n: 1, until: t + windowMs });
}
const clearLimit = (key: string) => buckets.delete(key);
/** Throws 429 if `key` already reached `max` in its window, without counting a new attempt. */
function assertUnder(key: string, max: number, message: string): void {
  const b = buckets.get(key);
  if (b && b.until > now() && b.n >= max) throw new HttpError(429, message);
}

// ---------- sessions ----------
function cookie(req: IncomingMessage, value: string, maxAge: number): string {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? "; Secure" : ""}`;
}

function agentOf(req: IncomingMessage): string {
  const ua = String(req.headers["user-agent"] ?? "");
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

function startSession(req: IncomingMessage, u: User): string {
  const token = randomBytes(32).toString("hex");
  const t = now();
  db.sessions = db.sessions.filter((s) => s.expiresAt > t);
  db.sessions.push({ id: sha(token), userId: u.id, createdAt: t, lastSeenAt: t, expiresAt: t + SESSION_DAYS * 86_400_000, agent: agentOf(req) });
  save();
  return cookie(req, token, SESSION_DAYS * 86_400);
}

function sessionOf(req: IncomingMessage): Session | null {
  const token = parseCookies(req)[COOKIE];
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const id = sha(token);
  const s = db.sessions.find((x) => x.id === id);
  if (!s || s.expiresAt <= now()) return null;
  if (now() - s.lastSeenAt > 3_600_000) {
    s.lastSeenAt = now();
    save();
  }
  return s;
}

/** The signed-in user for this request, or null. */
export function currentUser(req: IncomingMessage): User | null {
  const s = sessionOf(req);
  return s ? (db.users.find((u) => u.id === s.userId) ?? null) : null;
}

export function requireUser(req: IncomingMessage): User {
  const u = currentUser(req);
  if (!u) throw new HttpError(401, "Please sign in.");
  return u;
}

/** For actions that move money: a verified email is required when verification is possible. */
export function requireVerified(u: User): void {
  if (verificationRequired && !u.emailVerifiedAt) throw new HttpError(403, "Verify your email address first. We sent you a link when you signed up.");
}

function endSessions(userId: string, keep?: string): number {
  const before = db.sessions.length;
  db.sessions = db.sessions.filter((s) => s.userId !== userId || s.id === keep);
  save();
  return before - db.sessions.length;
}

// ---------- email links ----------
function baseUrl(req: IncomingMessage): string {
  const configured = env("APP_URL");
  if (configured) return configured.replace(/\/+$/, "");
  // Without APP_URL we fall back to the request host. Set APP_URL in production so links can't be
  // pointed at another host through a forged Host header.
  return `${isHttps(req) ? "https" : "http"}://${req.headers.host ?? "localhost:3000"}`;
}

function issueToken(u: User, kind: AuthToken["kind"]): string {
  const token = randomBytes(32).toString("hex");
  const t = now();
  db.tokens = db.tokens.filter((x) => x.expiresAt > t && !(x.userId === u.id && x.kind === kind));
  db.tokens.push({ id: sha(token), userId: u.id, kind, expiresAt: t + (kind === "verify" ? VERIFY_TTL : RESET_TTL) });
  save();
  return token;
}

/** Finds the user a link token belongs to, without using it up. */
function tokenUser(token: unknown, kind: AuthToken["kind"]): { user: User; id: string } {
  const bad = new HttpError(400, kind === "verify" ? "This verification link is invalid or has expired. Request a new one." : "This reset link is invalid or has expired. Request a new one.");
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) throw bad;
  const id = sha(token);
  const t = db.tokens.find((x) => x.id === id && x.kind === kind);
  if (!t || t.expiresAt <= now()) throw bad;
  const user = db.users.find((x) => x.id === t.userId);
  if (!user) throw bad;
  return { user, id };
}

/** Uses up a link token (and drops expired ones). */
function burnToken(id: string): void {
  db.tokens = db.tokens.filter((x) => x.id !== id && x.expiresAt > now());
  save();
}

function consumeToken(token: unknown, kind: AuthToken["kind"]): User {
  const { user, id } = tokenUser(token, kind);
  burnToken(id);
  return user;
}

export interface MailResult {
  /** Only outside production with no mail provider: the link that would have been emailed. */
  devLink?: string;
}

async function sendVerification(req: IncomingMessage, u: User): Promise<MailResult> {
  const url = `${baseUrl(req)}/?verify=${issueToken(u, "verify")}`;
  await sendMail(
    actionEmail({
      to: u.email,
      subject: "Verify your email for Sailo",
      greeting: `Hi ${u.name},`,
      body: "Confirm this is your email address to start funding, tokenizing and paying invoices on Sailo.",
      action: "Verify email",
      url,
      footer: "This link expires in 24 hours. If you didn’t create a Sailo account, you can ignore this email.",
    }),
  );
  return devLinks ? { devLink: url } : {};
}

// ---------- actions ----------
export async function signup(req: IncomingMessage, body: Record<string, unknown>): Promise<{ user: User; setCookie: string } & MailResult> {
  limit(`signup|${clientIp(req)}`, 20, 3_600_000, "Too many sign-ups from this network. Try again later.");
  const name = str(body.name, "full name", 120);
  const email = normEmail(body.email);
  const company = str(body.company, "company", 120, false);
  const role = body.role as AccountRole;
  if (!ACCOUNT_ROLES.includes(role)) throw new HttpError(400, "Choose Shipowner, Investor or Cargo owner.");
  const password = checkNewPassword(body.password, { email, name });
  if (db.users.some((u) => u.email === email)) throw new HttpError(409, "An account with this email already exists. Sign in instead.");
  const at = new Date().toISOString();
  const user: User = { id: randomUUID(), email, name, company, role, salt: "", hash: "", createdAt: at, emailVerifiedAt: null, passwordChangedAt: at };
  setPassword(user, password);
  db.users.push(user);
  save();
  const mail = await sendVerification(req, user);
  return { user, setCookie: startSession(req, user), ...mail };
}

export function login(req: IncomingMessage, body: Record<string, unknown>): { user: User; setCookie: string } {
  const email = normEmail(body.email);
  // Per-account lockout is checked before the password, so a locked account can't be guessed into.
  const key = `login|${email}`;
  const locked = "Too many attempts. Try again in 15 minutes, or reset your password.";
  assertUnder(key, 10, locked);
  limit(`login-ip|${clientIp(req)}`, 100, 15 * 60_000, "Too many sign-in attempts. Try again in 15 minutes.");
  const password = typeof body.password === "string" ? body.password.slice(0, 200) : "";
  const user = db.users.find((u) => u.email === email);
  const ok = user ? passwordMatches(user, password) : (hashPassword(password, DUMMY_SALT), false);
  if (!user || !ok) {
    limit(key, 10, 15 * 60_000, locked);
    throw new HttpError(401, "Email or password is incorrect.");
  }
  clearLimit(key);
  return { user, setCookie: startSession(req, user) };
}

export function logout(req: IncomingMessage): string {
  const s = sessionOf(req);
  if (s) {
    db.sessions = db.sessions.filter((x) => x.id !== s.id);
    save();
  }
  return cookie(req, "", 0);
}

export async function resendVerification(req: IncomingMessage, u: User): Promise<MailResult> {
  if (u.emailVerifiedAt) throw new HttpError(409, "Your email is already verified.");
  limit(`verify|${u.id}`, 5, 3_600_000, "We’ve sent several emails already. Check your inbox and spam folder, or try again in an hour.");
  return sendVerification(req, u);
}

export function verifyEmail(body: Record<string, unknown>): User {
  const u = consumeToken(body.token, "verify");
  if (!u.emailVerifiedAt) {
    u.emailVerifiedAt = new Date().toISOString();
    save();
  }
  return u;
}

/** Always answers the same way, so it can't be used to find out which emails have accounts. */
export async function forgotPassword(req: IncomingMessage, body: Record<string, unknown>): Promise<MailResult> {
  const email = normEmail(body.email);
  limit(`forgot-ip|${clientIp(req)}`, 20, 3_600_000, "Too many reset requests. Try again later.");
  const u = db.users.find((x) => x.email === email);
  if (!u) return {};
  try {
    limit(`forgot|${email}`, 3, 15 * 60_000, "");
  } catch {
    return {}; // silently drop extra requests for the same account
  }
  const url = `${baseUrl(req)}/?reset=${issueToken(u, "reset")}`;
  await sendMail(
    actionEmail({
      to: u.email,
      subject: "Reset your Sailo password",
      greeting: `Hi ${u.name},`,
      body: "We received a request to reset the password for your Sailo account.",
      action: "Choose a new password",
      url,
      footer: "This link expires in 30 minutes and works once. If you didn’t ask for this, ignore this email and your password stays the same.",
    }),
  );
  return devLinks ? { devLink: url } : {};
}

/** Sets a new password from a reset link. Signs out every other session and signs this browser in. */
export function resetPassword(req: IncomingMessage, body: Record<string, unknown>): { user: User; setCookie: string } {
  // Check the new password before using up the link, so a rejected password doesn't kill the link.
  const { user: u, id } = tokenUser(body.token, "reset");
  const pw = checkNewPassword(body.password, u);
  burnToken(id);
  setPassword(u, pw);
  u.emailVerifiedAt ??= new Date().toISOString(); // following the emailed link proves the inbox
  endSessions(u.id);
  db.tokens = db.tokens.filter((x) => x.userId !== u.id || x.kind !== "reset");
  save();
  return { user: u, setCookie: startSession(req, u) };
}

export function changePassword(req: IncomingMessage, u: User, body: Record<string, unknown>): { signedOut: number } {
  limit(`pw|${u.id}`, 10, 15 * 60_000, "Too many attempts. Try again in 15 minutes.");
  const current = typeof body.current === "string" ? body.current : "";
  if (!passwordMatches(u, current)) throw new HttpError(400, "Your current password is incorrect.");
  const next = checkNewPassword(body.password, u);
  if (next === current) throw new HttpError(400, "Choose a password you haven’t used here.");
  setPassword(u, next);
  save();
  return { signedOut: endSessions(u.id, sessionOf(req)?.id) };
}

export function updateProfile(u: User, body: Record<string, unknown>): User {
  u.name = str(body.name, "full name", 120);
  u.company = str(body.company, "company", 120, false);
  save();
  return u;
}

export function sessionsFor(req: IncomingMessage, u: User) {
  const cur = sessionOf(req)?.id;
  return db.sessions
    .filter((s) => s.userId === u.id && s.expiresAt > now())
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .map((s) => ({ agent: s.agent, createdAt: new Date(s.createdAt).toISOString(), lastSeenAt: new Date(s.lastSeenAt).toISOString(), current: s.id === cur }));
}

export function signOutOthers(req: IncomingMessage, u: User): { signedOut: number } {
  return { signedOut: endSessions(u.id, sessionOf(req)?.id) };
}

// ---------- marketing forms ----------
export function addEnquiry(req: IncomingMessage, body: Record<string, unknown>): void {
  limit(`enquiry|${clientIp(req)}`, 10, 3_600_000, "Too many enquiries from this network. Try again later.");
  const roles = ["Shipowner", "Investor", "Cargo owner"];
  const role = typeof body.role === "string" && roles.includes(body.role) ? body.role : "Other";
  db.enquiries.push({
    at: new Date().toISOString(),
    name: str(body.name, "name", 120),
    company: str(body.company, "company", 120, false),
    role,
    email: normEmail(body.email),
    msg: typeof body.msg === "string" ? body.msg.trim().slice(0, 2000) : "",
  });
  save();
}

export function subscribe(req: IncomingMessage, body: Record<string, unknown>): void {
  limit(`subscribe|${clientIp(req)}`, 10, 3_600_000, "Too many requests. Try again later.");
  const email = normEmail(body.email);
  if (!db.subscribers.some((s) => s.email === email)) {
    db.subscribers.push({ email, at: new Date().toISOString() });
    save();
  }
}
