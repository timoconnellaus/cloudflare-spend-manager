import { EmailMessage } from "cloudflare:email";

/** Sends a plain-text email through the `send_email` binding. The destination must be verified in Email Routing. */
export async function sendEmail(binding: SendEmail, from: string, to: string, subject: string, body: string) {
  const domain = from.split("@")[1];
  const raw = [
    `From: spend-guard <${from}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");
  await binding.send(new EmailMessage(from, to, raw));
}
