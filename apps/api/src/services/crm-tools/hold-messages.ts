// ============================================================
// "Please hold while I check" lines, spoken the moment the model decides to
// call a tool, in the call's CURRENT language and the call's own (locked)
// voice. Phrased gender-neutrally (Hindi/Marathi/Punjabi use passive voice) so
// they are correct for any agent voice, and without commas so the Exotel
// sentence cutter speaks each one as a single TTS piece.
// ============================================================

const HOLD_BY_LANG: Record<string, string> = {
  en: "Please hold on a moment while I check that for you.",
  hi: "कृपया एक पल रुकिए। आपकी जानकारी देखी जा रही है।",
  mr: "कृपया थोडा वेळ थांबा। आपली माहिती तपासली जात आहे।",
  gu: "કૃપા કરીને થોડી વાર રાહ જુઓ. તમારી માહિતી તપાસવામાં આવી રહી છે.",
  bn: "অনুগ্রহ করে একটু অপেক্ষা করুন. আপনার তথ্য দেখা হচ্ছে.",
  ta: "தயவுசெய்து ஒரு நிமிடம் காத்திருங்கள். உங்கள் தகவலைச் சரிபார்க்கிறேன்.",
  te: "దయచేసి ఒక్క క్షణం ఆగండి. మీ వివరాలు చూస్తున్నాను.",
  kn: "ದಯವಿಟ್ಟು ಒಂದು ಕ್ಷಣ ಕಾಯಿರಿ. ನಿಮ್ಮ ಮಾಹಿತಿಯನ್ನು ಪರಿಶೀಲಿಸಲಾಗುತ್ತಿದೆ.",
  ml: "ദയവായി ഒരു നിമിഷം കാത്തിരിക്കൂ. നിങ്ങളുടെ വിവരങ്ങൾ പരിശോധിക്കുന്നു.",
  pa: "ਕਿਰਪਾ ਕਰਕੇ ਥੋੜ੍ਹਾ ਰੁਕੋ। ਤੁਹਾਡੀ ਜਾਣਕਾਰੀ ਦੇਖੀ ਜਾ ਰਹੀ ਹੈ।",
  od: "ଦୟାକରି ଟିକେ ଅପେକ୍ଷା କରନ୍ତୁ। ଆପଣଙ୍କ ସୂଚନା ଯାଞ୍ଚ କରାଯାଉଛି।",
};

/** BCP-47 ("hi-IN", "mr", "en-IN") -> hold line; unknown languages fall back to English. */
export function holdMessageFor(languageCode: string | null | undefined): string {
  const primary = String(languageCode ?? "en").trim().toLowerCase().split(/[-_]/)[0] || "en";
  const key = primary === "or" ? "od" : primary;
  return HOLD_BY_LANG[key] ?? HOLD_BY_LANG.en;
}
