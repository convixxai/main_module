import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { env } from "../config/env";

export const SIMULATOR_SAVE_TO = "convixx.ai@gmail.com";
export const SIMULATOR_SAVE_CC = "sandeshr.patil21@gmail.com";

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!env.smtp.enabled) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.secure,
      auth: {
        user: env.smtp.user,
        pass: env.smtp.pass,
      },
    });
  }
  return transporter;
}

export function simulatorSaveEmailConfigured(): boolean {
  return env.smtp.enabled;
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
): Promise<{ messageId: string }> {
  const tx = getTransporter();
  if (!tx) {
    throw new Error(
      "SMTP is not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS in server .env)"
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
    safeFilename(
      params.characterName,
      extFromMime(mime)
    );

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
    "<h3>Current UI settings</h3>",
    `<pre style="white-space:pre-wrap;font-size:12px;background:#f4f4f4;padding:12px;border-radius:6px">${escapeHtml(settingsJson)}</pre>`,
    "<h3>Last simulation output</h3>",
    `<pre style="white-space:pre-wrap;font-size:12px;background:#f4f4f4;padding:12px;border-radius:6px">${escapeHtml(outputJson)}</pre>`,
    `<p>Audio file attached: <strong>${escapeHtml(attachName)}</strong></p>`,
  ].join("\n");

  const info = await tx.sendMail({
    from: env.smtp.from,
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

  return { messageId: info.messageId || "sent" };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
