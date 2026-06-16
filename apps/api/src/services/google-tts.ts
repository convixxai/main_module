import { env } from "../config/env";

export interface GoogleTtsParams {
  text?: string;
  ssml?: string;
  voiceName: string;
  languageCode: string;
  speakingRate?: number; // 0.25 to 4.0
  pitch?: number; // -20.0 to 20.0 semitones
  volumeGainDb?: number; // -96.0 to 16.0
  sampleRateHertz?: number;
  effectsProfileId?: string[];
  audioEncoding?: "MP3" | "LINEAR16" | "OGG_OPUS" | "MULAW" | "ALAW";
}

export type GoogleTtsVoiceType = "standard" | "wavenet" | "neural2" | "journey" | "studio";

export interface GoogleVoice {
  name: string;
  languageCodes: string[];
  ssmlGender: "MALE" | "FEMALE" | "NEUTRAL" | "SSML_VOICE_GENDER_UNSPECIFIED";
  naturalSampleRateHertz?: number;
}

export interface GoogleOAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

export const POPULAR_GOOGLE_VOICES: GoogleVoice[] = [
  { name: "en-US-Journey-F", languageCodes: ["en-US"], ssmlGender: "FEMALE" },
  { name: "en-US-Journey-O", languageCodes: ["en-US"], ssmlGender: "MALE" },
  { name: "en-US-Studio-O", languageCodes: ["en-US"], ssmlGender: "MALE" },
  { name: "en-US-Studio-Q", languageCodes: ["en-US"], ssmlGender: "FEMALE" },
  { name: "en-US-Neural2-C", languageCodes: ["en-US"], ssmlGender: "FEMALE" },
  { name: "en-US-Neural2-D", languageCodes: ["en-US"], ssmlGender: "MALE" },
  { name: "en-US-Neural2-F", languageCodes: ["en-US"], ssmlGender: "FEMALE" },
  { name: "en-US-Neural2-J", languageCodes: ["en-US"], ssmlGender: "MALE" },
  { name: "en-IN-Neural2-A", languageCodes: ["en-IN"], ssmlGender: "FEMALE" },
  { name: "en-IN-Neural2-B", languageCodes: ["en-IN"], ssmlGender: "MALE" },
  { name: "en-IN-Neural2-C", languageCodes: ["en-IN"], ssmlGender: "MALE" },
  { name: "en-IN-Neural2-D", languageCodes: ["en-IN"], ssmlGender: "FEMALE" },
  { name: "en-IN-Wavenet-A", languageCodes: ["en-IN"], ssmlGender: "FEMALE" },
  { name: "en-IN-Wavenet-B", languageCodes: ["en-IN"], ssmlGender: "MALE" },
  { name: "hi-IN-Neural2-A", languageCodes: ["hi-IN"], ssmlGender: "FEMALE" },
  { name: "hi-IN-Neural2-B", languageCodes: ["hi-IN"], ssmlGender: "MALE" },
  { name: "hi-IN-Neural2-C", languageCodes: ["hi-IN"], ssmlGender: "MALE" },
  { name: "hi-IN-Neural2-D", languageCodes: ["hi-IN"], ssmlGender: "FEMALE" },
  { name: "hi-IN-Wavenet-A", languageCodes: ["hi-IN"], ssmlGender: "FEMALE" },
  { name: "hi-IN-Wavenet-B", languageCodes: ["hi-IN"], ssmlGender: "MALE" },
  { name: "mr-IN-Neural2-A", languageCodes: ["mr-IN"], ssmlGender: "FEMALE" },
  { name: "mr-IN-Neural2-B", languageCodes: ["mr-IN"], ssmlGender: "MALE" },
  { name: "mr-IN-Wavenet-A", languageCodes: ["mr-IN"], ssmlGender: "FEMALE" },
  { name: "mr-IN-Wavenet-B", languageCodes: ["mr-IN"], ssmlGender: "MALE" }
];

export function getGoogleTtsVoiceType(voiceName: string): GoogleTtsVoiceType {
  const lower = voiceName.toLowerCase();
  if (lower.includes("-studio-")) return "studio";
  if (lower.includes("-journey-") || lower.includes("-chirp-")) return "journey";
  if (lower.includes("-neural2-") || lower.includes("-polyglot-")) return "neural2";
  if (lower.includes("-wavenet-")) return "wavenet";
  return "standard";
}

export function estimateGoogleTtsCostUsd(voiceName: string, charCount: number): number {
  const type = getGoogleTtsVoiceType(voiceName);
  const rates: Record<GoogleTtsVoiceType, number> = {
    standard: 4.0,
    wavenet: 4.0,
    neural2: 16.0,
    journey: 30.0,
    studio: 160.0
  };
  const rate = rates[type] || rates.neural2;
  return (charCount / 1_000_000) * rate;
}

/**
 * Exchange OAuth 2.0 authorization code for Access & Refresh Tokens.
 */
export async function exchangeOAuthCode(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<GoogleOAuthTokens> {
  const body = new URLSearchParams({
    code: params.code,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code"
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  const data = await res.json() as Record<string, any>;
  if (!res.ok) {
    throw new Error(data.error_description || data.error || `HTTP ${res.status} token exchange failed`);
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    token_type: data.token_type
  };
}

/**
 * Refresh Google Access Token using Refresh Token.
 */
export async function refreshGoogleAccessToken(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<Omit<GoogleOAuthTokens, "refresh_token">> {
  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    refresh_token: params.refreshToken,
    grant_type: "refresh_token"
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  const data = await res.json() as Record<string, any>;
  if (!res.ok) {
    throw new Error(data.error_description || data.error || `HTTP ${res.status} token refresh failed`);
  }

  return {
    access_token: data.access_token,
    expires_in: data.expires_in,
    token_type: data.token_type
  };
}

/**
 * Query voices list for a project.
 */
export async function fetchGoogleTtsVoices(accessToken: string): Promise<GoogleVoice[]> {
  const res = await fetch("https://texttospeech.googleapis.com/v1/voices", {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${accessToken}`
    }
  });

  const data = await res.json() as Record<string, any>;
  if (!res.ok) {
    throw new Error(data.error?.message || `HTTP ${res.status} fetching voices failed`);
  }

  if (!Array.isArray(data.voices)) {
    return [];
  }

  return data.voices.map((v: any) => ({
    name: v.name,
    languageCodes: v.languageCodes || [],
    ssmlGender: v.ssmlGender || "SSML_VOICE_GENDER_UNSPECIFIED",
    naturalSampleRateHertz: v.naturalSampleRateHertz
  }));
}

/**
 * Call Google Cloud Text-to-Speech REST API.
 */
export async function googleTextToSpeech(params: {
  accessToken: string;
  synthesis: GoogleTtsParams;
}): Promise<{
  audioContentBase64: string;
  charCount: number;
}> {
  const { accessToken, synthesis } = params;

  const isSsml = synthesis.ssml !== undefined && synthesis.ssml.trim() !== "";
  const sourceText = isSsml ? (synthesis.ssml ?? "") : (synthesis.text ?? "");
  const charCount = sourceText.length;

  const requestBody = {
    input: isSsml ? { ssml: synthesis.ssml } : { text: synthesis.text },
    voice: {
      languageCode: synthesis.languageCode,
      name: synthesis.voiceName
    },
    audioConfig: {
      audioEncoding: synthesis.audioEncoding || "MP3",
      speakingRate: synthesis.speakingRate ?? 1.0,
      pitch: synthesis.pitch ?? 0.0,
      volumeGainDb: synthesis.volumeGainDb ?? 0.0,
      sampleRateHertz: synthesis.sampleRateHertz,
      effectsProfileId: synthesis.effectsProfileId && synthesis.effectsProfileId.length > 0 ? synthesis.effectsProfileId : undefined
    }
  };

  const res = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  });

  const data = await res.json() as Record<string, any>;
  if (!res.ok) {
    throw new Error(data.error?.message || `HTTP ${res.status} synthesis failed`);
  }

  if (!data.audioContent) {
    throw new Error("Google API returned empty audioContent response");
  }

  return {
    audioContentBase64: data.audioContent,
    charCount
  };
}

export function googleTtsSimulatorDefaults() {
  return {
    voice_name: "en-US-Journey-F",
    language_code: "en-US",
    speaking_rate: 1.0,
    pitch: 0.0,
    volume_gain_db: 0.0,
    audio_encoding: "MP3" as const,
    sample_rate_hertz: 24000,
    effects_profile_id: [] as string[],
    ssml_mode: false,
    llm_model: "",
    llm_temperature: 0.85,
    llm_max_tokens: 350,
    skip_humanizer: false,
    slider_bounds: {
      speaking_rate: { min: 0.25, max: 4.0, step: 0.05, default: 1.0 },
      pitch: { min: -20.0, max: 20.0, step: 0.5, default: 0.0 },
      volume_gain_db: { min: -10.0, max: 10.0, step: 0.5, default: 0.0 },
      llm_temperature: { min: 0, max: 1.5, step: 0.05, default: 0.85 },
      llm_max_tokens: { min: 80, max: 2000, step: 20, default: 600 }
    },
    popular_voices: POPULAR_GOOGLE_VOICES
  };
}
