/**
 * Outgoing email for account verification and password reset.
 *
 *   SMTP_URL   e.g. smtps://resend:API_KEY@smtp.resend.com:465  (any SMTP provider works)
 *   MAIL_FROM  e.g. "Sailo <no-reply@yourdomain.com>"
 *
 * Without SMTP_URL nothing is sent: the message is printed to the server log, and outside production
 * the link is also returned to the browser (labelled as a development link) so the flow can be tested.
 */
import nodemailer, { type Transporter } from "nodemailer";
import { env } from "./env.js";

const SMTP_URL = env("SMTP_URL");
const FROM = env("MAIL_FROM") ?? "Sailo <no-reply@sailo.local>";

/** True when real email can be delivered. */
export const mailConfigured = Boolean(SMTP_URL);
/** Outside production, links are shown in the UI when no mail provider is set up. */
export const devLinks = !mailConfigured && process.env.NODE_ENV !== "production";

let transport: Transporter | null = null;
const getTransport = () => (transport ??= nodemailer.createTransport(SMTP_URL!));

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Sends the message, or logs it when no provider is configured. Never throws to the caller's user. */
export async function sendMail(m: Mail): Promise<{ delivered: boolean }> {
  if (!mailConfigured) {
    console.log(`\n[mail: not sent, SMTP_URL is not set]\nTo: ${m.to}\nSubject: ${m.subject}\n\n${m.text}\n`);
    return { delivered: false };
  }
  try {
    await getTransport().sendMail({ from: FROM, to: m.to, subject: m.subject, text: m.text, html: m.html });
    return { delivered: true };
  } catch (e) {
    console.error("mail: send failed:", e instanceof Error ? e.message : e);
    return { delivered: false };
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A plain, branded email with one button. */
export function actionEmail(o: { to: string; subject: string; greeting: string; body: string; action: string; url: string; footer: string }): Mail {
  const text = `${o.greeting}\n\n${o.body}\n\n${o.action}: ${o.url}\n\n${o.footer}\n\nSailo, freight advances for island shipping lines`;
  const html = `<!doctype html><html><body style="margin:0;background:#FAF7F0;font-family:Arial,Helvetica,sans-serif;color:#0B3D3B">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #E6DFCF;border-radius:16px">
<tr><td style="padding:28px 28px 8px;font-size:22px;font-weight:800">Sailo</td></tr>
<tr><td style="padding:8px 28px;font-size:16px;line-height:1.6">${esc(o.greeting)}<br><br>${esc(o.body)}</td></tr>
<tr><td style="padding:16px 28px"><a href="${esc(o.url)}" style="display:inline-block;background:#F57C00;color:#1F2937;font-weight:700;text-decoration:none;padding:14px 22px;border-radius:12px">${esc(o.action)}</a></td></tr>
<tr><td style="padding:8px 28px 4px;font-size:13px;color:#4F6068;line-height:1.6">If the button doesn’t work, paste this link into your browser:<br><span style="word-break:break-all">${esc(o.url)}</span></td></tr>
<tr><td style="padding:12px 28px 28px;font-size:13px;color:#4F6068;line-height:1.6">${esc(o.footer)}</td></tr>
</table></td></tr></table></body></html>`;
  return { to: o.to, subject: o.subject, text, html };
}
