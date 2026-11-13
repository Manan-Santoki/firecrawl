import "server-only";
import nodemailer from "nodemailer";
import { env } from "./env";

/**
 * Optional: emails an invite link when SMTP is configured. Without SMTP the
 * admin copies the link from the dashboard instead. Returns whether it sent.
 */
export async function sendInviteEmail(to: string, url: string, expiresAt: Date): Promise<boolean> {
  const config = env();
  if (!config.SMTP_HOST || !config.SMTP_FROM) return false;
  try {
    const transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
    });
    await transport.sendMail({
      from: config.SMTP_FROM,
      to,
      subject: "You're invited to a Firecrawl deployment",
      text: `You have been invited to use a self-hosted Firecrawl deployment.\n\nCreate your account: ${url}\n\nThe link works once and expires ${expiresAt.toUTCString()}.`,
    });
    return true;
  } catch (error) {
    console.error("Invite email failed", error instanceof Error ? error.message : error);
    return false;
  }
}
