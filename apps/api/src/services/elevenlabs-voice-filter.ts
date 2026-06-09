/** Shared ElevenLabs voice list filtering (browser + `/voice/elevenlabs/voices`). */

export function voiceMatchesLanguageFilter(
  voice: Record<string, unknown>,
  want: string
): boolean {
  const w = want.trim().toLowerCase();
  const primary = w.split("-")[0] || w;

  const labels = voice.labels as Record<string, unknown> | undefined;
  const labelLang =
    typeof labels?.language === "string" ? labels.language.toLowerCase() : "";
  if (
    labelLang &&
    (labelLang === primary ||
      labelLang === w ||
      w.startsWith(`${labelLang}-`) ||
      primary === labelLang)
  ) {
    return true;
  }

  const verified = voice.verified_languages;
  if (Array.isArray(verified)) {
    for (const entry of verified) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const el =
        typeof e.language === "string" ? e.language.toLowerCase() : "";
      const loc =
        typeof e.locale === "string" ? e.locale.toLowerCase().replace(/_/g, "-") : "";
      if (el === primary || el === w) return true;
      if (loc === w) return true;
      if (loc) {
        const locPrimary = loc.split("-")[0] || "";
        if (locPrimary === primary) return true;
      }
    }
  }

  const name = typeof voice.name === "string" ? voice.name.toLowerCase() : "";
  return name.includes(primary);
}

export function voiceSupportsModel(
  voice: Record<string, unknown>,
  modelId: string
): boolean {
  const m = modelId.trim();
  if (!m) return true;
  const hq = voice.high_quality_base_model_ids;
  if (Array.isArray(hq) && hq.some((x) => String(x) === m)) return true;
  const verified = voice.verified_languages;
  if (Array.isArray(verified)) {
    return verified.some(
      (x) =>
        x &&
        typeof x === "object" &&
        String((x as Record<string, unknown>).model_id) === m
    );
  }
  return false;
}

export function voiceLabelValue(
  voice: Record<string, unknown>,
  key: string
): string {
  const labels = voice.labels as Record<string, unknown> | undefined;
  const v = labels?.[key];
  return typeof v === "string" ? v.trim() : "";
}
