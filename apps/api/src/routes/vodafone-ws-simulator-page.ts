// ============================================================
// Vodafone (VI) WebSocket Simulator - standalone diagnostic page.
//
// Plays VI's role exactly as documented in "Voice Streaming - User Manual -
// Agent Calling": opens a real WebSocket connection to whatever URL is
// configured (defaulting to this deployment's own live
// /telephony/vodafone/voicebot/:customerId route), sends "connected" then
// "start" immediately after, streams caller audio as "media" events (from
// the mic or an uploaded WAV, chunked to VI's 1.6KB-50KB/160-byte-alignment
// rule), and can send "dtmf"/"stop"/"exit" - all client-side, in the
// browser. Renders every sent/received frame in a live log and plays back
// any "media" audio VI's spec says the server should send.
//
// Entirely standalone: this file and its route registration are the only
// two places this feature touches. It does not import from, modify, or
// otherwise depend on vodafone-voicebot.ts / vodafone-adapter.ts /
// types/vodafone-ws.ts - it is a WebSocket *client* hitting that route the
// same way VI itself would, from outside, exactly like a real call would.
// ============================================================

export const VODAFONE_WS_SIMULATOR_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Vodafone WS Simulator</title>
<style>
  :root {
    --bg: #0b1016; --panel: #121a24; --panel2: #0e151d; --border: #22303f;
    --text: #dbe6f0; --muted: #7d94a8; --accent: #3aa3ff; --green: #38d99b;
    --red: #ff6b6b; --amber: #f5b94d;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; }
  header { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  header h1 { font-size: 17px; margin: 0; font-weight: 600; }
  header p { margin: 2px 0 0; color: var(--muted); font-size: 12.5px; }
  #statusPill { padding: 4px 12px; border-radius: 999px; font-size: 12.5px; font-weight: 600; border: 1px solid var(--border); }
  #statusPill.disconnected { color: var(--muted); }
  #statusPill.connecting { color: var(--amber); border-color: var(--amber); }
  #statusPill.connected { color: var(--green); border-color: var(--green); }
  #statusPill.closed { color: var(--red); border-color: var(--red); }
  main { display: grid; grid-template-columns: 340px 1fr; gap: 0; height: calc(100vh - 61px); }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; height: auto; } }
  #sidebar { padding: 16px; border-right: 1px solid var(--border); overflow-y: auto; background: var(--panel2); }
  #logPane { display: flex; flex-direction: column; min-height: 0; }
  section { margin-bottom: 18px; }
  section h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 8px; }
  label { display: block; font-size: 12.5px; color: var(--muted); margin: 8px 0 3px; }
  input[type=text], input[type=number], select, textarea {
    width: 100%; background: var(--panel); border: 1px solid var(--border); color: var(--text);
    border-radius: 6px; padding: 7px 9px; font-size: 13px; font-family: inherit;
  }
  textarea { resize: vertical; min-height: 44px; font-family: 'SF Mono', Consolas, monospace; font-size: 11.5px; }
  .row { display: flex; gap: 8px; }
  .row > * { flex: 1; }
  button {
    cursor: pointer; border: 1px solid var(--border); background: var(--panel); color: var(--text);
    border-radius: 6px; padding: 8px 10px; font-size: 13px; font-weight: 500; width: 100%; margin-top: 8px;
  }
  button:hover:not(:disabled) { border-color: var(--accent); }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #04121f; font-weight: 700; }
  button.danger { color: var(--red); }
  button.rec.active { background: var(--red); border-color: var(--red); color: #200; font-weight: 700; }
  #metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 12.5px; }
  #metrics div { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 8px; }
  #metrics span { display: block; color: var(--muted); font-size: 10.5px; text-transform: uppercase; }
  #metrics b { font-size: 15px; color: var(--green); }
  #logToolbar { display: flex; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--border); align-items: center; }
  #logToolbar button { width: auto; margin: 0; padding: 6px 12px; font-size: 12px; }
  #log { flex: 1; overflow-y: auto; padding: 10px 16px; font-family: 'SF Mono', Consolas, monospace; font-size: 12px; }
  .entry { margin-bottom: 6px; padding: 7px 10px; border-radius: 6px; border-left: 3px solid var(--border); background: var(--panel2); }
  .entry.sent { border-left-color: var(--accent); }
  .entry.recv { border-left-color: var(--green); }
  .entry.err { border-left-color: var(--red); }
  .entry.sys { border-left-color: var(--amber); }
  .entry .t { color: var(--muted); font-size: 10.5px; margin-right: 8px; }
  .entry .dir { font-weight: 700; margin-right: 6px; }
  .entry.sent .dir { color: var(--accent); }
  .entry.recv .dir { color: var(--green); }
  .entry.err .dir { color: var(--red); }
  .entry.sys .dir { color: var(--amber); }
  .entry pre { margin: 4px 0 0; white-space: pre-wrap; word-break: break-all; color: var(--text); }
  small.hint { color: var(--muted); font-size: 11px; display: block; margin-top: 4px; }
</style>
</head>
<body>
<header>
  <div>
    <h1>Vodafone (VI) WebSocket Simulator</h1>
    <p>Plays VI's role exactly per the vendor spec — connects to our real endpoint as an external client, streams audio, and shows every frame exchanged. Does not touch the live Vodafone route's code.</p>
  </div>
  <span id="statusPill" class="disconnected">Disconnected</span>
</header>
<main>
  <div id="sidebar">
    <section>
      <h2>Endpoint</h2>
      <label>WebSocket URL</label>
      <input type="text" id="wsUrl" value="wss://convixx.in/telephony/vodafone/voicebot/" />
      <label>Customer preset</label>
      <select id="customerPreset">
        <option value="97752ef1-eb4f-4ebb-a77f-0613fe3a424b">Ganesh Project</option>
        <option value="7dd859fb-8dbd-440d-9d2c-4ec786b6d1bb">Cartesia Voice Test Console</option>
        <option value="">Custom (type below)</option>
      </select>
      <label>Customer ID</label>
      <input type="text" id="customerId" value="97752ef1-eb4f-4ebb-a77f-0613fe3a424b" />
    </section>

    <section>
      <h2>Simulated call</h2>
      <div class="row">
        <div><label>CLI (caller)</label><input type="text" id="cli" value="+919876543210" /></div>
        <div><label>DNI (dialed)</label><input type="text" id="dni" value="+919112002517" /></div>
      </div>
      <label>Room ID (auto-generated)</label>
      <input type="text" id="roomId" readonly />
      <label>Custom parameters (max 3, one per line, key=value)</label>
      <textarea id="customParams" placeholder="queuename=premium
product=radio"></textarea>
    </section>

    <section>
      <h2>Connection</h2>
      <button class="primary" id="btnConnect">Connect &amp; send connected + start</button>
      <button class="danger" id="btnStop" disabled>Send "stop" (simulate call end)</button>
      <button class="danger" id="btnExit" disabled>Send "exit"</button>
      <button class="danger" id="btnClose" disabled>Raw disconnect (abrupt close)</button>
    </section>

    <section>
      <h2>Caller audio</h2>
      <button id="btnMic" disabled>🎙 Start speaking (mic)</button>
      <small class="hint">Streams live mic audio as 100ms "media" chunks, exactly like a real caller.</small>
      <label>...or upload a WAV file</label>
      <input type="file" id="wavFile" accept="audio/wav,audio/x-wav" disabled />
      <small class="hint">Resampled to 8kHz mono PCM16 and streamed at real-time pace.</small>
    </section>

    <section>
      <h2>DTMF</h2>
      <div class="row">
        <select id="dtmfDigit">
          <option>1</option><option>2</option><option>3</option><option>4</option><option>5</option>
          <option>6</option><option>7</option><option>8</option><option>9</option><option>0</option>
          <option>*</option><option>#</option>
        </select>
        <button id="btnDtmf" disabled style="margin-top:0">Send digit</button>
      </div>
    </section>

    <section>
      <h2>Metrics</h2>
      <div id="metrics">
        <div><span>Connect time</span><b id="mConnect">—</b></div>
        <div><span>First audio</span><b id="mFirstAudio">—</b></div>
        <div><span>Mark ack</span><b id="mMark">—</b></div>
        <div><span>Media frames in</span><b id="mFramesIn">0</b></div>
      </div>
    </section>
  </div>

  <div id="logPane">
    <div id="logToolbar">
      <button id="btnClearLog">Clear log</button>
      <span style="color:var(--muted); font-size:12px;">Blue = sent to our server (as VI would) · Green = received from our server (what VI would get) · Amber = system</span>
    </div>
    <div id="log"></div>
  </div>
</main>

<script>
(function () {
  const $ = (id) => document.getElementById(id);
  const wsUrlEl = $('wsUrl'), customerIdEl = $('customerId'), customerPresetEl = $('customerPreset');
  const roomIdEl = $('roomId'), cliEl = $('cli'), dniEl = $('dni'), customParamsEl = $('customParams');
  const statusPill = $('statusPill');
  const btnConnect = $('btnConnect'), btnStop = $('btnStop'), btnExit = $('btnExit'), btnClose = $('btnClose');
  const btnMic = $('btnMic'), wavFile = $('wavFile'), btnDtmf = $('btnDtmf'), dtmfDigit = $('dtmfDigit');
  const logEl = $('log');
  const mConnect = $('mConnect'), mFirstAudio = $('mFirstAudio'), mMark = $('mMark'), mFramesIn = $('mFramesIn');

  function newRoomId() { return 'SIM_' + Date.now() + '_' + Math.floor(Math.random() * 1000); }
  roomIdEl.value = newRoomId();

  customerPresetEl.addEventListener('change', () => {
    if (customerPresetEl.value) customerIdEl.value = customerPresetEl.value;
  });

  let ws = null;
  let seq = 1;
  let roomId = null;
  let callId = null;
  let connectStartedAt = 0;
  let firstAudioAt = null;
  let framesIn = 0;
  let pendingMarks = new Set();
  let recording = false;
  let mediaStream = null;
  let audioCtx = null;
  let sourceNode = null;
  let procNode = null;
  let pcmCarry = new Uint8Array(0);
  let chunkIndexOut = 0;

  // ---------- logging ----------
  function log(dir, label, data) {
    const div = document.createElement('div');
    div.className = 'entry ' + dir;
    const time = new Date().toLocaleTimeString('en-IN', { hour12: false }) + '.' + String(new Date().getMilliseconds()).padStart(3, '0');
    const dirLabel = dir === 'sent' ? '→ SENT' : dir === 'recv' ? '← RECV' : dir === 'err' ? '⚠ ERROR' : 'ⓘ SYSTEM';
    let body = '';
    if (data !== undefined) {
      const str = typeof data === 'string' ? data : JSON.stringify(data);
      body = '<pre>' + escapeHtml(str.length > 1000 ? str.slice(0, 1000) + '…' : str) + '</pre>';
    }
    div.innerHTML = '<span class="t">' + time + '</span><span class="dir">' + dirLabel + '</span>' + escapeHtml(label) + body;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  function setStatus(state, text) {
    statusPill.className = state;
    statusPill.textContent = text;
  }

  function setControlsConnected(isConnected) {
    btnConnect.disabled = isConnected;
    btnStop.disabled = !isConnected;
    btnExit.disabled = !isConnected;
    btnClose.disabled = !isConnected;
    btnMic.disabled = !isConnected;
    wavFile.disabled = !isConnected;
    btnDtmf.disabled = !isConnected;
  }

  function parseCustomParams() {
    const out = {};
    customParamsEl.value.split('\\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).forEach((line) => {
      const idx = line.indexOf('=');
      if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });
    return out;
  }

  function send(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(obj));
    log('sent', obj.event, obj);
  }

  // ---------- connect ----------
  btnConnect.addEventListener('click', () => {
    const base = wsUrlEl.value.trim().replace(/\\/$/, '');
    const cid = customerIdEl.value.trim();
    const url = base.endsWith(cid) ? base : base + (base.endsWith('/') ? '' : '/') + cid;
    roomId = roomIdEl.value.trim() || newRoomId();
    callId = 'sim-call-' + Date.now();
    seq = 1; framesIn = 0; firstAudioAt = null; chunkIndexOut = 0;
    mConnect.textContent = '—'; mFirstAudio.textContent = '—'; mMark.textContent = '—'; mFramesIn.textContent = '0';

    setStatus('connecting', 'Connecting…');
    log('sys', 'Opening WebSocket: ' + url);
    connectStartedAt = Date.now();

    try {
      ws = new WebSocket(url);
    } catch (e) {
      log('err', 'Failed to open WebSocket: ' + e.message);
      setStatus('closed', 'Failed');
      return;
    }

    ws.addEventListener('open', () => {
      const ms = Date.now() - connectStartedAt;
      mConnect.textContent = ms + ' ms';
      setStatus('connected', 'Connected');
      setControlsConnected(true);
      log('sys', 'WebSocket handshake succeeded in ' + ms + ' ms. Sending connected + start, per VI spec.');

      send({ event: 'connected' });
      send({
        event: 'start',
        sequence_number: seq++,
        room_id: roomId,
        start: {
          room_id: roomId,
          call_id: callId,
          cli: cliEl.value.trim(),
          dni: dniEl.value.trim(),
          custom_parameters: parseCustomParams(),
          media_format: { encoding: 'raw', sample_rate: '8000', bit_rate: '128000' },
        },
      });
    });

    ws.addEventListener('message', (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { log('err', 'Non-JSON message received: ' + evt.data); return; }
      if (msg.event === 'media') {
        framesIn++;
        mFramesIn.textContent = String(framesIn);
        if (firstAudioAt === null) {
          firstAudioAt = Date.now();
          mFirstAudio.textContent = (firstAudioAt - connectStartedAt) + ' ms';
        }
        log('recv', 'media (chunk ' + msg.media.chunk + ', ' + Math.round((msg.media.payload.length * 3) / 4) + ' bytes audio)');
        playPcm16Base64(msg.media.payload);
      } else if (msg.event === 'mark') {
        log('recv', 'mark: ' + msg.mark.name, msg);
        if (mMark.textContent === '—') mMark.textContent = (Date.now() - connectStartedAt) + ' ms';
      } else if (msg.event === 'stop') {
        log('recv', 'stop (server ended the stream)', msg);
      } else if (msg.event === 'clear') {
        log('recv', 'clear', msg);
      } else {
        log('recv', msg.event || 'unknown event', msg);
      }
    });

    ws.addEventListener('close', (evt) => {
      setStatus('closed', 'Closed (' + evt.code + ')');
      setControlsConnected(false);
      stopMic();
      log('sys', 'WebSocket closed. code=' + evt.code + ' reason=' + (evt.reason || '(none)'));
    });

    ws.addEventListener('error', () => {
      log('err', 'WebSocket error (see browser console for detail)');
    });
  });

  btnStop.addEventListener('click', () => {
    send({ event: 'stop', sequence_number: seq++, room_id: roomId, stop: { call_id: callId, reason: 'caller hung up (simulated)' } });
  });
  btnExit.addEventListener('click', () => {
    send({ event: 'exit', room_id: roomId });
  });
  btnClose.addEventListener('click', () => {
    log('sys', 'Closing raw TCP connection (simulating an abrupt VI-side disconnect, no close frame).');
    if (ws) ws.close();
  });
  btnDtmf.addEventListener('click', () => {
    send({ event: 'dtmf', sequence_number: seq++, room_id: roomId, dtmf: { duration: '150', digit: dtmfDigit.value } });
  });
  $('btnClearLog').addEventListener('click', () => { logEl.innerHTML = ''; });

  // ---------- outbound audio (mic) ----------
  function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  function floatTo16BitPCM(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function downsampleBuffer(buffer, inRate, outRate) {
    if (outRate === inRate) return buffer;
    const ratio = inRate / outRate;
    const newLen = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLen);
    let offsetResult = 0, offsetBuffer = 0;
    while (offsetResult < newLen) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let accum = 0, count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) { accum += buffer[i]; count++; }
      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }
    return result;
  }

  const CHUNK_BYTES = 1600; // 100ms @ 8kHz 16-bit mono, per VI spec (min 1.6KB, multiple of 160 bytes)

  function appendAndFlushOutbound(int16Bytes) {
    const merged = new Uint8Array(pcmCarry.length + int16Bytes.length);
    merged.set(pcmCarry, 0);
    merged.set(int16Bytes, pcmCarry.length);
    let offset = 0;
    while (merged.length - offset >= CHUNK_BYTES) {
      const chunk = merged.slice(offset, offset + CHUNK_BYTES);
      sendMediaChunk(chunk);
      offset += CHUNK_BYTES;
    }
    pcmCarry = merged.slice(offset);
  }

  function sendMediaChunk(bytesU8) {
    let binary = '';
    for (let i = 0; i < bytesU8.length; i++) binary += String.fromCharCode(bytesU8[i]);
    const b64 = btoa(binary);
    send({
      event: 'media',
      sequence_number: seq++,
      room_id: roomId,
      media: { chunk: chunkIndexOut++, timestamp: String(chunkIndexOut * 100), payload: b64 },
    });
  }

  btnMic.addEventListener('click', async () => {
    if (recording) { stopMic(); return; }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    } catch (e) {
      log('err', 'Microphone access denied/unavailable: ' + e.message);
      return;
    }
    const ctx = getAudioCtx();
    sourceNode = ctx.createMediaStreamSource(mediaStream);
    procNode = ctx.createScriptProcessor(4096, 1, 1);
    pcmCarry = new Uint8Array(0);
    procNode.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const down = downsampleBuffer(input, ctx.sampleRate, 8000);
      const int16 = floatTo16BitPCM(down);
      appendAndFlushOutbound(new Uint8Array(int16.buffer));
    };
    sourceNode.connect(procNode);
    // ScriptProcessorNode only fires onaudioprocess while connected into the
    // graph, so route it through a silent (gain 0) node rather than directly
    // to the speakers - keeps the mic audio inaudible to the person testing.
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;
    procNode.connect(silentGain);
    silentGain.connect(ctx.destination);
    recording = true;
    btnMic.textContent = '⏹ Stop speaking';
    btnMic.classList.add('active');
    log('sys', 'Mic recording started — streaming live audio as 100ms media chunks.');
  });

  function stopMic() {
    if (!recording) return;
    recording = false;
    btnMic.textContent = '🎙 Start speaking (mic)';
    btnMic.classList.remove('active');
    try { procNode && procNode.disconnect(); } catch {}
    try { sourceNode && sourceNode.disconnect(); } catch {}
    try { mediaStream && mediaStream.getTracks().forEach((t) => t.stop()); } catch {}
    if (pcmCarry.length > 0) { sendMediaChunk(pcmCarry); pcmCarry = new Uint8Array(0); }
    log('sys', 'Mic recording stopped.');
  }

  // ---------- outbound audio (WAV upload) ----------
  wavFile.addEventListener('change', async () => {
    const file = wavFile.files[0];
    if (!file) return;
    log('sys', 'Decoding ' + file.name + ' …');
    const arrayBuf = await file.arrayBuffer();
    const ctx = getAudioCtx();
    let audioBuf;
    try {
      audioBuf = await ctx.decodeAudioData(arrayBuf.slice(0));
    } catch (e) {
      log('err', 'Could not decode WAV file: ' + e.message);
      return;
    }
    const mono = audioBuf.numberOfChannels > 1
      ? (() => {
          const a = audioBuf.getChannelData(0), b = audioBuf.getChannelData(1);
          const out = new Float32Array(a.length);
          for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) / 2;
          return out;
        })()
      : audioBuf.getChannelData(0);
    const down = downsampleBuffer(mono, audioBuf.sampleRate, 8000);
    const int16 = floatTo16BitPCM(down);
    const bytes = new Uint8Array(int16.buffer);
    log('sys', 'Streaming ' + bytes.length + ' bytes (' + (bytes.length / 1600 * 100).toFixed(0) + 'ms) of audio at real-time pace…');

    let offset = 0;
    const timer = setInterval(() => {
      if (offset >= bytes.length || !ws || ws.readyState !== WebSocket.OPEN) {
        clearInterval(timer);
        if (offset >= bytes.length) log('sys', 'Finished streaming uploaded WAV.');
        return;
      }
      const end = Math.min(offset + CHUNK_BYTES, bytes.length);
      sendMediaChunk(bytes.slice(offset, end));
      offset = end;
    }, 100);
    wavFile.value = '';
  });

  // ---------- inbound audio playback ----------
  let playCursor = 0;
  function playPcm16Base64(b64) {
    const ctx = getAudioCtx();
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const view = new DataView(bytes.buffer);
    const sampleCount = Math.floor(bytes.length / 2);
    const float32 = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) float32[i] = view.getInt16(i * 2, true) / 0x8000;
    const buffer = ctx.createBuffer(1, sampleCount, 8000);
    buffer.copyToChannel(float32, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const now = ctx.currentTime;
    const startAt = Math.max(now, playCursor);
    src.start(startAt);
    playCursor = startAt + buffer.duration;
  }
})();
</script>
</body>
</html>
`;
