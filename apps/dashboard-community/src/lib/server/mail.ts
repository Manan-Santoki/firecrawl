import "server-only";
import nodemailer from "nodemailer";
import { env } from "./env";

/** Sends a plain-text email when SMTP is configured; returns whether it sent. Never throws. */
export async function sendMail(to: string[], subject: string, text: string): Promise<boolean> {
  const config = env();
  if (!config.SMTP_HOST || !config.SMTP_FROM || to.length === 0) return false;
  try {
    const transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
    });
    await transport.sendMail({ from: config.SMTP_FROM, to, subject, text });
    return true;
  } catch (error) {
    console.error("Email failed", error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Optional: emails an invite link when SMTP is configured. Without SMTP the
 * admin copies the link from the dashboard instead. Returns whether it sent.
 */
export async function sendInviteEmail(to: string, url: string, expiresAt: Date): Promise<boolean> {
  return sendMail(
    [to],
    "You're invited to a Firecrawl deployment",
    `You have been invited to use a self-hosted Firecrawl deployment.\n\nCreate your account: ${url}\n\nThe link works once and expires ${expiresAt.toUTCString()}.`,
  );
}
