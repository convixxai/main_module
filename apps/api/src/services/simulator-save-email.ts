import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import type { Transporter } from "nodemailer";
import { env } from "../config/env";

export const SIMULATOR_SAVE_TO = "convixx.ai@gmail.com";
export const SIMULATOR_SAVE_CC = "sandeshr.patil21@gmail.com";

let transporter: Transporter | null = null;
let transporterMode: "smtp" | "sendmail" | null = null;
let smtpVerified = false;

export function formatMailError(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as {
      code?: string;
      response?: string;
      responseCode?: number;
      message?: string;
    };
    const parts: string[] = [];
    if (e.responseCode) parts.push(String(e.responseCode));
    if (e.code) parts.push(e.code);
    if (e.response) parts.push(String(e.response).trim());
    if (e.message) parts.push(e.message);
    const msg = parts.filter(Boolean).join(" — ");
    if (msg.includes("535") || /auth/i.test(msg)) {
      return (
        msg +
        ". For Gmail use an App Password (Google Account → Security → App passwords), not your login password."
      );
    }
    return msg || "Email send failed";
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function envelopeFromAddress(): string {
  const from = env.email.from;
  const angle = from.match(/<([^>]+)>/);
  if (angle?.[1]) return angle[1].trim();
  if (from.includes("@")) return from.trim();
  return env.email.smtp.user || "noreply@convixx.ai";
}

function createMailTransporter(): Transporter {
  const mode = env.email.activeTransport;
  if (mode === "smtp") {
    const { user, pass, host, port, secure, useGmailService } = env.email.smtp;
    if (useGmailService) {
      return nodemailer.createTransport({
        service: "gmail",
        auth: { user, pass },
      } as SMTPTransport.Options);
    }
    return nodemailer.createTransport({
      host,
      port,
      secure,
      requireTLS: !secure && port === 587,
      auth: { user, pass },
      tls: { minVersion: "TLSv1.2" },
    });
  }
  return nodemailer.createTransport({
    sendmail: true,
    newline: "unix",
    path: env.email.sendmail.path,
    args: ["-i", "-f", envelopeFromAddress()],
  });
}

function getTransporter(): Transporter | null {
  const mode = env.email.activeTransport;
  if (!mode || !env.email.configured) return null;

  if (transporter && transporterMode === mode) return transporter;

  transporter = createMailTransporter();
  transporterMode = mode;
  smtpVerified = false;
  return transporter;
}

async function ensureSmtpReady(tx: Transporter): Promise<void> {
  if (env.email.activeTransport !== "smtp" || smtpVerified) return;
  await tx.verify();
  smtpVerified = true;
}

export function simulatorSaveEmailConfigured(): boolean {
  return env.email.configured;
}

export function simulatorSaveEmailTransportLabel(): string {
  return env.email.activeTransport ?? "none";
}

export type EmailStatusResult = {
  configured: boolean;
  transport: string | null;
  from: string;
  smtp_user: string | null;
  sendmail_path: string | null;
  verify_ok: boolean;
  verify_error: string | null;
  delivery_note: string | null;
};

export async function getSimulatorEmailStatus(): Promise<EmailStatusResult> {
  const transport = env.email.activeTransport;
  const base: EmailStatusResult = {
    configured: env.email.configured,
    transport,
    from: env.email.from,
    smtp_user: env.email.smtp.enabled ? env.email.smtp.user : null,
    sendmail_path: env.email.sendmail.enabled ? env.email.sendmail.path : null,
    verify_ok: false,
    verify_error: null,
    delivery_note: null,
  };

  if (!transport) {
    base.verify_error =
      "Not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS (Gmail App Password recommended).";
    return base;
  }

  if (transport === "sendmail") {
    base.delivery_note =
      "Using local sendmail. External delivery to Gmail often fails without Postfix relay + SPF. Prefer Gmail SMTP instead.";
    base.verify_ok = true;
    return base;
  }

  const tx = getTransporter();
  if (!tx) {
    base.verify_error = "Transporter could not be created";
    return base;
  }

  try {
    await tx.verify();
    base.verify_ok = true;
    base.delivery_note = "Gmail SMTP connection verified.";
  } catch (err: unknown) {
    base.verify_error = formatMailError(err);
  }

  return base;
}

export async function sendSimulatorTestEmail(): Promise<{
  messageId: string;
  transport: string;
}> {
  const tx = getTransporter();
  const transport = env.email.activeTransport;
  if (!tx || !transport) {
    throw new Error("Email is not configured");
  }

  await ensureSmtpReady(tx);

  const when = new Date().toISOString();
  const info = await tx.sendMail({
    from: env.email.from,
    to: SIMULATOR_SAVE_TO,
    cc: SIMULATOR_SAVE_CC,
    subject: `[Convixx] Simulator email test ${when}`,
    text: [
      "This is a test email from the Convixx voice simulator save feature.",
      `Transport: ${transport}`,
      `Time: ${when}`,
      `From: ${env.email.from}`,
    ].join("\n"),
    html: `<p>Convixx simulator <strong>test email</strong> OK.</p><p>Transport: ${transport}</p><p>${when}</p>`,
  });

  return { messageId: info.messageId || "sent", transport };
}

function safeFilename(name: string, ext: string): string {
  const base = name
    .trim()
    .slice(0, 80)
    .replace(/[^\w\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\- ]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return (base || "character") + ext;
}

function extFromMime(mime: string): string {
  const m = (mime || "").toLowerCase();
  if (m.includes("mpeg") || m.includes("mp3")) return ".mp3";
  if (m.includes("wav")) return ".wav";
  if (m.includes("opus")) return ".opus";
  if (m.includes("aac")) return ".aac";
  if (m.includes("flac")) return ".flac";
  if (m.includes("pcm")) return ".pcm";
  return ".bin";
}

export type SimulatorSaveEmailParams = {
  characterName: string;
  simulatorType: "elevenlabs" | "openai_tts" | "cartesia_tts";
  customerId: string;
  settings: Record<string, unknown>;
  lastOutput: Record<string, unknown> | null;
  audioBase64: string;
  audioContentType?: string;
  audioFilename?: string;
};

export async function sendSimulatorCharacterSaveEmail(
  params: SimulatorSaveEmailParams
): Promise<{ messageId: string; transport: string; delivery_note: string | null }> {
  const tx = getTransporter();
  const transport = env.email.activeTransport;
  if (!tx || !transport) {
    throw new Error(
      "Email is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS (use Gmail App Password)."
    );
  }

  await ensureSmtpReady(tx);

  const audioBuf = Buffer.from(params.audioBase64, "base64");
  if (audioBuf.length === 0) {
    throw new Error("Audio attachment is empty");
  }
  if (audioBuf.length > 12 * 1024 * 1024) {
    throw new Error("Audio attachment exceeds 12 MB limit");
  }

  const mime = params.audioContentType || "audio/wav";
  const attachName =
    params.audioFilename?.trim() ||
    safeFilename(params.characterName, extFromMime(mime));

  const simLabel =
    params.simulatorType === "elevenlabs"
      ? "ElevenLabs Voice Simulator"
      : params.simulatorType === "cartesia_tts"
        ? "Cartesia Sonic TTS Simulator"
        : "OpenAI TTS Humanizer Simulator";

  const subject = `[Convixx] Character save: ${params.characterName} (${simLabel})`;
  const when = new Date().toISOString();

  const settingsJson = JSON.stringify(params.settings, null, 2);
  const outputJson = JSON.stringify(params.lastOutput ?? {}, null, 2);

  const textBody = [
    `Character name: ${params.characterName}`,
    `Simulator: ${simLabel}`,
    `Customer ID: ${params.customerId}`,
    `Saved at: ${when}`,
    `Mail transport: ${transport}`,
    "",
    "=== CURRENT UI SETTINGS ===",
    settingsJson,
    "",
    "=== LAST SIMULATION OUTPUT ===",
    outputJson,
    "",
    `Audio attachment: ${attachName} (${mime}, ${audioBuf.length} bytes)`,
  ].join("\n");

  const htmlBody = [
    "<h2>Convixx simulator character save</h2>",
    `<p><strong>Character:</strong> ${escapeHtml(params.characterName)}</p>`,
    `<p><strong>Simulator:</strong> ${escapeHtml(simLabel)}</p>`,
    `<p><strong>Customer ID:</strong> <code>${escapeHtml(params.customerId)}</code></p>`,
    `<p><strong>Saved at:</strong> ${escapeHtml(when)}</p>`,
    `<p><strong>Transport:</strong> ${escapeHtml(transport)}</p>`,
    "<h3>Current UI settings</h3>",
    `<pre style="white-space:pre-wrap;font-size:12px;background:#f4f4f4;padding:12px;border-radius:6px">${escapeHtml(settingsJson)}</pre>`,
    "<h3>Last simulation output</h3>",
    `<pre style="white-space:pre-wrap;font-size:12px;background:#f4f4f4;padding:12px;border-radius:6px">${escapeHtml(outputJson)}</pre>`,
    `<p>Audio file attached: <strong>${escapeHtml(attachName)}</strong></p>`,
  ].join("\n");

  try {
    const info = await tx.sendMail({
      from: env.email.from,
      to: SIMULATOR_SAVE_TO,
      cc: SIMULATOR_SAVE_CC,
      subject,
      text: textBody,
      html: htmlBody,
      attachments: [
        {
          filename: attachName,
          content: audioBuf,
          contentType: mime,
        },
      ],
    });

    const delivery_note =
      transport === "sendmail"
        ? "Queued via sendmail. If Gmail inbox is empty, switch to Gmail SMTP (App Password)."
        : null;

    return {
      messageId: info.messageId || "sent",
      transport,
      delivery_note,
    };
  } catch (err: unknown) {
    throw new Error(formatMailError(err));
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
