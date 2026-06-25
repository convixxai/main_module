import { pool } from "../config/db";
import { env } from "../config/env";
import type { VoicebotSession } from "./voicebot-session";
import type { CustomerSettings } from "./customer-settings";
import {
  type ElevenLabsVoiceSettingsPayload,
  ELEVENLABS_BUILTIN_INDIAN_MULTILINGUAL_VOICE_ID,
} from "./elevenlabs";
import {
  parseCartesiaGenerationConfig,
  resolveCartesiaModel,
} from "./cartesia";

function pickLang(session: VoicebotSession): string {
  return (
    session.effectiveSttLanguageThisTurn?.trim() ||
    session.defaultLanguageCode?.trim() ||
    "en-IN"
  );
}

function mergeLanguageMapEntry<T extends Record<string, unknown>>(
  map: unknown,
  lang: string
): T | null {
  if (!map || typeof map !== "object") return null;
  const o = map as Record<string, unknown>;
  const exact = o[lang];
  if (exact && typeof exact === "object") return exact as T;
  const primary = lang.split("-")[0]?.toLowerCase();
  if (primary) {
    for (const k of Object.keys(o)) {
      if (k.split("-")[0]?.toLowerCase() === primary) {
        const v = o[k];
        if (v && typeof v === "object") return v as T;
      }
    }
  }
  return null;
}

function mergeVoiceSettings(
  base: unknown,
  override: unknown
): ElevenLabsVoiceSettingsPayload | null {
  const a =
    base && typeof base === "object"
      ? (base as Record<string, unknown>)
      : {};
  const b =
    override && typeof override === "object"
      ? (override as Record<string, unknown>)
      : {};
  const m = { ...a, ...b } as ElevenLabsVoiceSettingsPayload;
  return Object.keys(m).length ? m : null;
}

/**
 * Apply `agents.avatar_id` / `agents.elevenlabs_avatar_id` + language map onto session TTS fields.
 * Call after agent row is loaded and `customerSettingsSnapshot` is set.
 */
export async function applyAgentVoicePersonaToSession(
  session: VoicebotSession,
  prefetched?: {
    avatarId?: string | null;
    elevenlabsAvatarId?: string | null;
    cartesiaAvatarId?: string | null;
    customerSettings?: CustomerSettings | null;
  }
): Promise<void> {
  const cs = prefetched?.customerSettings ?? session.customerSettingsSnapshot ?? null;
  const ttsProvider = cs?.tts_provider ?? "sarvam";
  if (!session.agentId) return;

  let avatarId = prefetched?.avatarId;
  let elevenlabsAvatarId = prefetched?.elevenlabsAvatarId;
  let cartesiaAvatarId = prefetched?.cartesiaAvatarId;
  if (
    avatarId === undefined &&
    elevenlabsAvatarId === undefined &&
    cartesiaAvatarId === undefined
  ) {
    const r = await pool.query(
      `SELECT avatar_id, elevenlabs_avatar_id, cartesia_avatar_id
       FROM agents WHERE id = $1 AND customer_id = $2`,
      [session.agentId, session.customerId]
    );
    if (r.rows.length === 0) return;
    avatarId = r.rows[0].avatar_id as string | null;
    elevenlabsAvatarId = r.rows[0].elevenlabs_avatar_id as string | null;
    cartesiaAvatarId = r.rows[0].cartesia_avatar_id as string | null;
  }

  const lang = pickLang(session);

  if (ttsProvider === "cartesia") {
    session.elevenlabsVoiceSettings = null;
    if (cartesiaAvatarId) {
      const ar = await pool.query(
        `SELECT voice_id, model_id, generation_config, pronunciation_dict_id,
                legacy_speed, is_pvc_voice, language_voice_map
         FROM cartesia_avatars
         WHERE id = $1 AND customer_id = $2 AND is_active = TRUE`,
        [cartesiaAvatarId, session.customerId]
      );
      if (ar.rows.length === 0) return;
      const row = ar.rows[0];
      const mapEntry = mergeLanguageMapEntry<{
        voice_id?: string;
        model_id?: string | null;
        generation_config?: unknown;
      }>(row.language_voice_map, lang);

      const voiceFromMap =
        typeof mapEntry?.voice_id === "string" ? mapEntry.voice_id.trim() : "";
      const voiceId = voiceFromMap || String(row.voice_id || "").trim();
      const modelFromMap =
        mapEntry?.model_id != null ? String(mapEntry.model_id).trim() : "";
      const modelFromRow = row.model_id != null ? String(row.model_id).trim() : "";
      const modelId = resolveCartesiaModel(modelFromMap || modelFromRow || cs?.tts_model);

      if (voiceId) session.ttsSpeaker = voiceId;
      if (modelId) session.ttsModel = modelId;

      const baseGen = parseCartesiaGenerationConfig(row.generation_config);
      const mapGen = mapEntry?.generation_config
        ? parseCartesiaGenerationConfig(mapEntry.generation_config)
        : null;
      session.cartesiaGenerationConfig = mapGen
        ? { ...baseGen, ...mapGen }
        : baseGen;
      session.cartesiaPronunciationDictId =
        row.pronunciation_dict_id != null
          ? String(row.pronunciation_dict_id).trim() || null
          : null;
      const ls = row.legacy_speed != null ? String(row.legacy_speed).trim() : "";
      session.cartesiaLegacySpeed =
        ls === "slow" || ls === "normal" || ls === "fast" ? ls : null;
      session.cartesiaIsPvcVoice = row.is_pvc_voice === true;
      return;
    }

    if (!session.ttsSpeaker?.trim() && cs?.tts_default_speaker?.trim()) {
      session.ttsSpeaker = cs.tts_default_speaker.trim();
    }
    if (!session.ttsModel?.trim()) {
      session.ttsModel = resolveCartesiaModel(cs?.tts_model);
    }
    if (!session.cartesiaGenerationConfig) {
      session.cartesiaGenerationConfig = {
        speed: 1,
        volume: 1,
        emotion: "neutral",
      };
    }
    return;
  }

  session.cartesiaGenerationConfig = null;
  session.cartesiaPronunciationDictId = null;
  session.cartesiaLegacySpeed = null;
  session.cartesiaIsPvcVoice = false;

  if (ttsProvider === "elevenlabs" && elevenlabsAvatarId) {
    const ar = await pool.query(
      `SELECT voice_id, model_id, voice_settings, language_voice_map
       FROM elevenlabs_avatars
       WHERE id = $1 AND customer_id = $2 AND is_active = TRUE`,
      [elevenlabsAvatarId, session.customerId]
    );
    if (ar.rows.length === 0) return;
    const row = ar.rows[0];
    const mapEntry = mergeLanguageMapEntry<{
      voice_id?: string;
      model_id?: string | null;
      voice_settings?: unknown;
    }>(row.language_voice_map, lang);

    const voiceFromMap =
      typeof mapEntry?.voice_id === "string" ? mapEntry.voice_id.trim() : "";
    const voiceId = voiceFromMap || String(row.voice_id || "").trim();
    const modelFromMap =
      mapEntry?.model_id != null ? String(mapEntry.model_id).trim() : "";
    const modelFromRow = row.model_id != null ? String(row.model_id).trim() : "";
    const modelId = modelFromMap || modelFromRow;

    if (voiceId) session.ttsSpeaker = voiceId;
    if (modelId) session.ttsModel = modelId;

    session.elevenlabsVoiceSettings = mergeVoiceSettings(
      row.voice_settings,
      mapEntry?.voice_settings
    );
    return;
  }

  session.elevenlabsVoiceSettings = null;

  if (ttsProvider === "elevenlabs") {
    if (!elevenlabsAvatarId) {
      const hasAnySpeaker =
        session.ttsSpeaker?.trim() ||
        cs?.tts_default_speaker?.trim() ||
        env.elevenlabs.defaultVoiceId;
      if (!hasAnySpeaker) {
        session.ttsSpeaker =
          env.elevenlabs.defaultIndianMultilingualVoiceId?.trim() ||
          ELEVENLABS_BUILTIN_INDIAN_MULTILINGUAL_VOICE_ID;
      }
    }
    return;
  }

  if (avatarId) {
    const ar = await pool.query(
      `SELECT tts_provider, tts_model, tts_speaker, tts_pace, tts_sample_rate, language_voice_map
       FROM avatars
       WHERE id = $1 AND customer_id = $2 AND is_active = TRUE`,
      [avatarId, session.customerId]
    );
    if (ar.rows.length === 0) return;
    const row = ar.rows[0];
    if (String(row.tts_provider || "sarvam") !== "sarvam") return;

    const mapEntry = mergeLanguageMapEntry<{
      tts_model?: string | null;
      tts_speaker?: string | null;
      tts_pace?: number | null;
      tts_sample_rate?: number | null;
    }>(row.language_voice_map, lang);

    const sp =
      (typeof mapEntry?.tts_speaker === "string" && mapEntry.tts_speaker.trim()) ||
      (typeof row.tts_speaker === "string" && row.tts_speaker.trim()) ||
      "";
    const tm =
      (mapEntry?.tts_model != null && String(mapEntry.tts_model).trim()) ||
      (row.tts_model != null ? String(row.tts_model).trim() : "") ||
      "";
    const pace =
      mapEntry?.tts_pace != null && Number.isFinite(Number(mapEntry.tts_pace))
        ? Number(mapEntry.tts_pace)
        : row.tts_pace != null
          ? Number(row.tts_pace)
          : null;
    const sr =
      mapEntry?.tts_sample_rate != null &&
      Number.isFinite(Number(mapEntry.tts_sample_rate))
        ? Number(mapEntry.tts_sample_rate)
        : row.tts_sample_rate != null
          ? Number(row.tts_sample_rate)
          : null;

    if (sp) session.ttsSpeaker = sp;
    if (tm) session.ttsModel = tm;
    if (pace != null && Number.isFinite(pace)) session.ttsPace = pace;
    if (sr != null && Number.isFinite(sr)) session.ttsSampleRate = sr;
  }
}
