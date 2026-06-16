# Google Cloud Text-to-Speech Simulator Implementation Plan

We will create a Google Cloud Text-to-Speech (TTS) simulator mirroring the design, structure, and features of the existing simulators (ElevenLabs, OpenAI, and Cartesia) in the Convixx nodejs workspace.

## User Review Required

> [!IMPORTANT]
> **Authentication via OAuth 2.0 Client ID and Client Secret:**
> Since you only have a Google OAuth Client ID and Client Secret, we will implement a lightweight, self-contained OAuth 2.0 flow inside the simulator:
> 1. You will input your **Google Client ID** and **Client Secret** directly into the simulator's **Connection** section in the UI (saved locally in your browser's `localStorage` for privacy).
> 2. You will click **Authorize with Google**, which opens a consent popup using your Client ID.
> 3. After you consent, Google redirects the popup back to our callback route, which captures the `code` and notifies the simulator window.
> 4. The simulator makes a secure POST call to our server to exchange the code for an **Access Token** and **Refresh Token** (also saved in `localStorage`).
> 5. During synthesis, the backend uses these tokens to call the Google TTS API. If the Access Token expires, the backend automatically uses the Refresh Token + Client ID + Client Secret to refresh it and returns the updated token to the frontend.
>
> **Requirements for this flow:**
> You must register `http://localhost:8080/voice/google-tts/oauth/callback` (or your corresponding server host/port) as an **Authorized redirect URI** in your Google Cloud Console under the credentials for your OAuth 2.0 Client ID.

## Proposed Changes

We will add the following files to support the Google Cloud TTS Simulator.

### Backend Services

#### [NEW] [google-tts.ts](file:///d:/Sandesh/Private\Convixx/nodejs_main/apps/api/src/services/google-tts.ts)
Implement the core integration wrapper for Google Cloud TTS:
- Dynamic voice listing: Proxy `GET https://texttospeech.googleapis.com/v1/voices`.
- OAuth token exchange: Exposes `exchangeOAuthCode` (`POST https://oauth2.googleapis.com/token`).
- Token refresh: Exposes `refreshGoogleAccessToken`.
- Synthesis call: Exposes `googleTextToSpeech` (`POST https://texttospeech.googleapis.com/v1/text:synthesize`).
- Classify voice type and estimate usage cost per 1M characters:
  - Standard/WaveNet: `$4.00`
  - Neural2: `$16.00`
  - Chirp/Journey: `$30.00`
  - Studio: `$160.00`

### Backend Routes

#### [NEW] [google-tts-simulator-page.ts](file:///d:/Sandesh/Private\Convixx/nodejs_main/apps/api/src/routes/google-tts-simulator-page.ts)
A standalone file containing `GOOGLE_TTS_SIMULATOR_PAGE_HTML` which renders the simulator frontend matching the dark aesthetic of the other simulators. It will include:
- **Connection Panel:** Client ID, Client Secret, Authorize button (auth status), and Customer ID.
- **Model & Voice Config:** Dynamic dropdown populated with fetched Google voices, language filters, standard parameters (speaking rate, pitch, volume gain, sample rate, audio encoding format, and audio device effects profiles).
- **Humanizer Toggle:** Integration with the OpenAI-based script humanizer.
- **Mic and Text Inputs:** Options to convert recorded speech to text (via tenant STT) or text input to speech.
- **Output Panel:** Displays the original text, humanized script, exact API payload parameters, latency/timings, cost breakdowns, and an audio player.
- **Session Totals:** Keeps track of turns, character counts, and total cost.

#### [NEW] [google-tts-simulator.ts](file:///d:/Sandesh/Private\Convixx/nodejs_main/apps/api/src/routes/google-tts-simulator.ts)
Fastify route file registering:
- `GET /voice/google-tts/simulator` -> serves the HTML.
- `GET /voice/google-tts/oauth/callback` -> handles redirect callback from Google (returns JS to post OAuth code to parent window and close).
- `POST /voice/google-tts/oauth/token` -> exchanges the OAuth code for token payload.
- `POST /voice/google-tts/voices` -> lists project voices using access token.
- `POST /voice/google-tts/simulator/turn` -> handles STT (if microphone mode), Humanizer (if checked), Google TTS synthesis, cost calculation, and automatic access token refreshing.

### Main Server Configuration

#### [MODIFY] [app.ts](file:///d:/Sandesh/Private\Convixx/nodejs_main/apps/api/src/app.ts)
Import and register `googleTtsSimulatorRoutes` in Fastify.

---

## Verification Plan

### Manual Verification
1. Start the server locally: `npm run dev` in `apps/api`.
2. Open the browser to: `http://localhost:8080/voice/google-tts/simulator?customer_id=YOUR_CUSTOMER_ID`.
3. Input Google OAuth Client ID and Client Secret.
4. Click **Authorize with Google**, sign in, and consent in the popup.
5. Verify that authentication succeeds and the token status updates in the Connection panel.
6. Verify that the voice dropdown dynamically updates with voices fetched from Google.
7. Test synthesizing a text turn (e.g. using a Studio or Neural2 voice).
8. Test mic recording transcription and synthesis.
9. Verify that session totals and API costs are tracked correctly.
