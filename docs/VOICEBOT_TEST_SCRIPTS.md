# Voicebot Test Scripts — Multi-Language Testing

Use these scripts to test the voicebot's language detection, STT accuracy, and response quality across English, Hindi, and Marathi.

---

## English Test Questions (en-IN)

| # | Question | Expected Intent | Expected KB Match |
|---|----------|-----------------|-------------------|
| 1 | Hello, am I speaking with Chhavani Resort? | Confirmation | Resort identity |
| 2 | What types of rooms do you have available? | Room inquiry | Room types |
| 3 | How much does a Royal Cart cost per night? | Pricing | Room pricing |
| 4 | Is breakfast included in the package? | Meals inquiry | Package inclusions |
| 5 | Do you have a swimming pool? | Amenities | Activities |
| 6 | Is the resort pet-friendly? | Policy | Pet policy |
| 7 | How far is the resort from Lonavala station? | Location | Distance/directions |
| 8 | Can you tell me about the activities available? | Activities | Activities list |
| 9 | I want to book for this Saturday and Sunday. | Booking intent | Availability |
| 10 | Is the resort suitable for children below 5 years? | Policy | Child policy |

### English Test Audio Prompts

```
Test 1: "Hello, am I speaking with Chhavani Resort?"
Test 2: "What types of rooms do you have available?"
Test 3: "How much does a Royal Cart cost per night?"
Test 4: "Is breakfast included in the package?"
Test 5: "Do you have a swimming pool?"
Test 6: "Is the resort pet-friendly?"
Test 7: "How far is the resort from Lonavala station?"
Test 8: "Can you tell me about the activities available?"
Test 9: "I want to book for this Saturday and Sunday."
Test 10: "Is the resort suitable for children below 5 years?"
```

---

## Hindi Test Questions (hi-IN)

| # | Question (Hindi) | Transliteration | Expected Intent |
|---|------------------|-----------------|-----------------|
| 1 | क्या मैं छावनी रिसॉर्ट से बात कर रहा हूं? | Kya main Chhavani Resort se baat kar raha hoon? | Confirmation |
| 2 | आपके पास कितने प्रकार के कमरे हैं? | Aapke paas kitne prakar ke kamre hain? | Room inquiry |
| 3 | एक रात के लिए कमरे का किराया क्या है? | Ek raat ke liye kamre ka kiraya kya hai? | Pricing |
| 4 | क्या नाश्ता पैकेज में शामिल है? | Kya nashta package mein shamil hai? | Meals inquiry |
| 5 | क्या यहाँ स्विमिंग पूल है? | Kya yahan swimming pool hai? | Amenities |
| 6 | क्या हम पालतू जानवर ला सकते हैं? | Kya hum paltu janwar la sakte hain? | Pet policy |
| 7 | लोनावला स्टेशन से रिसॉर्ट कितनी दूर है? | Lonavala station se resort kitni door hai? | Location |
| 8 | यहाँ क्या-क्या गतिविधियाँ उपलब्ध हैं? | Yahan kya-kya gatividhiyan uplabdh hain? | Activities |
| 9 | मुझे इस शनिवार-रविवार के लिए बुकिंग करनी है। | Mujhe is Shanivar-Ravivar ke liye booking karni hai. | Booking intent |
| 10 | क्या छोटे बच्चों के लिए यह रिसॉर्ट सही है? | Kya chhote bachchon ke liye yeh resort sahi hai? | Child policy |

### Hindi Test Audio Prompts

```
Test 1: "क्या मैं छावनी रिसॉर्ट से बात कर रहा हूं?"
Test 2: "आपके पास कितने प्रकार के कमरे हैं?"
Test 3: "एक रात के लिए कमरे का किराया क्या है?"
Test 4: "क्या नाश्ता पैकेज में शामिल है?"
Test 5: "क्या यहाँ स्विमिंग पूल है?"
Test 6: "क्या हम पालतू जानवर ला सकते हैं?"
Test 7: "लोनावला स्टेशन से रिसॉर्ट कितनी दूर है?"
Test 8: "यहाँ क्या-क्या गतिविधियाँ उपलब्ध हैं?"
Test 9: "मुझे इस शनिवार-रविवार के लिए बुकिंग करनी है।"
Test 10: "क्या छोटे बच्चों के लिए यह रिसॉर्ट सही है?"
```

---

## Marathi Test Questions (mr-IN)

| # | Question (Marathi) | Transliteration | Expected Intent |
|---|-------------------|-----------------|-----------------|
| 1 | मी छावणी रिसॉर्टशी बोलत आहे का? | Mi Chhavani Resort-shi bolat aahe ka? | Confirmation |
| 2 | तुमच्याकडे कोणत्या प्रकारच्या खोल्या आहेत? | Tumchyakade konatya prakarchya kholya aahet? | Room inquiry |
| 3 | एका रात्रीसाठी खोलीचे भाडे किती आहे? | Eka ratrisathi kholichi bhade kiti aahe? | Pricing |
| 4 | नाश्ता पॅकेजमध्ये समाविष्ट आहे का? | Nashta package-madhye samavishta aahe ka? | Meals inquiry |
| 5 | तुमच्याकडे स्विमिंग पूल आहे का? | Tumchyakade swimming pool aahe ka? | Amenities |
| 6 | आम्ही पाळीव प्राणी आणू शकतो का? | Amhi paliv prani aanu shakto ka? | Pet policy |
| 7 | लोणावळा स्टेशनपासून रिसॉर्ट किती दूर आहे? | Lonavala station-pasun resort kiti door aahe? | Location |
| 8 | इथे कोणत्या ॲक्टिव्हिटीज उपलब्ध आहेत? | Ithe konatya activities uplabdh aahet? | Activities |
| 9 | मला या शनिवार-रविवारी बुकिंग करायची आहे। | Mala ya Shanivar-Ravivari booking karaychi aahe. | Booking intent |
| 10 | लहान मुलांसाठी हे रिसॉर्ट योग्य आहे का? | Lahan mulansathi he resort yogya aahe ka? | Child policy |

### Marathi Test Audio Prompts

```
Test 1: "मी छावणी रिसॉर्टशी बोलत आहे का?"
Test 2: "तुमच्याकडे कोणत्या प्रकारच्या खोल्या आहेत?"
Test 3: "एका रात्रीसाठी खोलीचे भाडे किती आहे?"
Test 4: "नाश्ता पॅकेजमध्ये समाविष्ट आहे का?"
Test 5: "तुमच्याकडे स्विमिंग पूल आहे का?"
Test 6: "आम्ही पाळीव प्राणी आणू शकतो का?"
Test 7: "लोणावळा स्टेशनपासून रिसॉर्ट किती दूर आहे?"
Test 8: "इथे कोणत्या ॲक्टिव्हिटीज उपलब्ध आहेत?"
Test 9: "मला या शनिवार-रविवारी बुकिंग करायची आहे।"
Test 10: "लहान मुलांसाठी हे रिसॉर्ट योग्य आहे का?"
```

---

## Code-Mixed (Hinglish) Test Questions

| # | Question | Expected Language Detection |
|---|----------|----------------------------|
| 1 | Room ka price kya hai? | hi-IN (Hindi dominant) |
| 2 | Breakfast included hai kya? | hi-IN (Hindi dominant) |
| 3 | Swimming pool available hai? | hi-IN (Hindi dominant) |
| 4 | Lonavala station kitna door hai? | hi-IN (Hindi dominant) |
| 5 | Saturday Sunday ke liye booking karna hai. | hi-IN (Hindi dominant) |

---

## Edge Case Test Scenarios

### Noise/Filler Sounds
| # | Audio Input | Expected Behavior |
|---|-------------|-------------------|
| 1 | "Uh... hmm..." | Detect as noise, use session language |
| 2 | "Aaa... aaa..." | Detect as noise, use session language |
| 3 | (background noise only) | Detect as noise, ask to repeat |
| 4 | "Hello? Hello?" | en-IN, ask how to help |

### Language Switching Mid-Call
| # | Sequence | Expected Behavior |
|---|----------|-------------------|
| 1 | EN → "मुझे Hindi में बोलो" | Switch to hi-IN |
| 2 | HI → "Please speak English" | Switch to en-IN |
| 3 | EN → "मराठीत बोला" | Switch to mr-IN |

### Very Short Utterances
| # | Audio Input | Expected Behavior |
|---|-------------|-------------------|
| 1 | "Yes" | Keep current session language |
| 2 | "हाँ" | Keep current session language (or detect hi-IN) |
| 3 | "No" | Keep current session language |
| 4 | "नहीं" | Keep current session language (or detect hi-IN) |

---

## Testing Checklist

### Pre-Test Setup
- [ ] Verify customer_settings has `voicebot_enabled: true`
- [ ] Verify `voicebot_multilingual: true` for multi-language tests
- [ ] Verify `allowed_languages` includes `["en-IN", "hi-IN", "mr-IN"]`
- [ ] Clear greeting cache if testing greeting changes
- [ ] Check PM2 logs are capturing voicebot traces

### Per-Test Verification
- [ ] STT transcript accuracy
- [ ] Language detection accuracy
- [ ] TTFA within target (< 2000ms)
- [ ] Response relevance to question
- [ ] TTS language matches detected language
- [ ] No JSON artifacts in spoken response

### Post-Test Analysis
- [ ] Review `pipeline.stt.raw_transcript` logs
- [ ] Check `pipeline.stt.disallowed_language_detected` for false positives
- [ ] Verify `pipeline.ttfa` metrics
- [ ] Check for any `pipeline.tts.error` logs

---

## Sample Call Script (Full Test Flow)

```
1. [Call connects]
2. Bot: "Hello! How can I help you today?"
3. Caller: "Am I speaking with Chhavani Resort?" [EN]
4. Bot: "Yes, you're speaking with Chhavani Resort. How can I assist you?"
5. Caller: "कमरे कितने प्रकार के हैं?" [HI - Language switch]
6. Bot: "हमारे पास सर्जा राजा मिनी कार्ट, राहुती टेंट, रॉयल राहुती टेंट, रॉयल कार्ट और यशवंतराव वाडा उपलब्ध है।"
7. Caller: "Price kitna hai?" [Hinglish]
8. Bot: "कमरे की कीमत ₹7,000 प्रति रात से शुरू होती है।"
9. Caller: "Thank you" [EN]
10. Bot: "You're welcome! Is there anything else I can help you with?"
11. [Caller hangs up]
```
