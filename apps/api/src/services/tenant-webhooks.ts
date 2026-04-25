// Fire-and-forget HTTP notifications using customer_settings webhook URLs.
import crypto from "crypto";
import type { CustomerSettings } from "./customer-settings";

function signBody(secret: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * POST JSON to a tenant webhook. Adds X-Convixx-Signature: sha256=<hex> when secret is set.
 * Retries up to `retries` additional attempts (total attempts = retries + 1).
 */
export async function postTenantWebhook(
  url: string | null | undefined,
  secret: string | null | undefined,
  payload: unknown,
  retries: number
): Promise<void> {
  const u = url?.trim();
  if (!u) return;
  const body = JSON.stringify(payload);
  const sig = secret?.trim() ? signBody(secret.trim(), body) : null;
  const maxAttempts = Math.max(0, retries) + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": "Convixx-API/1.0",
      };
      if (sig) headers["X-Convixx-Signature"] = `sha256=${sig}`;
      const res = await fetch(u, { method: "POST", headers, body });
      if (res.ok) return;
    } catch {
      /* retry */
    }
  }
}

export function fireTenantWebhook(
  url: string | null | undefined,
  secret: string | null | undefined,
  payload: unknown,
  retries: number
): void {
  void postTenantWebhook(url, secret, payload, retries);
}

export async function postSlackIncomingWebhook(
  url: string | null | undefined,
  text: string
): Promise<void> {
  const u = url?.trim();
  if (!u) return;
  try {
    await fetch(u, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch {
    /* ignore */
  }
}

/** No in-process SMTP; include `email_recipients` in webhook payloads when `email_notify_call_end` is true. */
export function fireEmailNotifyHint(
  cs: CustomerSettings,
  payload: Record<string, unknown>
): void {
  if (!cs.email_notify_call_end || cs.email_recipients.length === 0) return;
  fireTenantWebhook(
    cs.webhook_url_call_end,
    cs.webhook_secret,
    { ...payload, email_notify_call_end: true, email_recipients: cs.email_recipients },
    cs.webhook_retry_attempts
  );
}
