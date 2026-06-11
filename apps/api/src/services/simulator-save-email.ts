import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { env } from "../config/env";

export const SIMULATOR_SAVE_TO = "convixx.ai@gmail.com";
export const SIMULATOR_SAVE_CC = "sandeshr.patil21@gmail.com";

let transporter: Transporter | null = null;
let transporterMode: "smtp" | "sendmail" | null = null;

function getTransporter(): Transporter | null {
  const mode = env.email.activeTransport;
  if (!mode || !env.email.configured) return null;

  if (transporter && transporterMode === mode) return transporter;

  if (mode === "smtp") {
    transporter = nodemailer.createTransport({
      host: env.email.smtp.host,
      port: env.email.smtp.port,
      secure: env.email.smtp.secure,
      auth: {
        user: env.email.smtp.user,
        pass: env.email.smtp.pass,
      },
    });
  } else {
    transporter = nodemailer.createTransport({
      sendmail: true,
      newline: "unix",
      path: env.email.sendmail.path,
    });
  }

  transporterMode = mode;
  return transporter;
}

export function simulatorSaveEmailConfigured(): boolean {
  return env.email.configured;
}

export function simulatorSaveEmailTransportLabel(): string {
  return env.email.activeTransport ?? "none";
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
  simulatorType: "elevenlabs" | "openai_tts";
  customerId: string;
  settings: Record<string, unknown>;
  lastOutput: Record<string, unknown> | null;
  audioBase64: string;
  audioContentType?: string;
  audioFilename?: string;
};

export async function sendSimulatorCharacterSaveEmail(
  params: SimulatorSaveEmailParams
): Promise<{ messageId: string; transport: string }> {
  const tx = getTransporter();
  const transport = env.email.activeTransport;
  if (!tx || !transport) {
    throw new Error(
      "Email is not configured. On Linux production set EMAIL_TRANSPORT=sendmail (Postfix) " +
        "or SMTP_HOST + SMTP_USER + SMTP_PASS."
    );
  }

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

  return { messageId: info.messageId || "sent", transport };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
