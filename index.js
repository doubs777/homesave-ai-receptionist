import Fastify from 'fastify';
import dotenv from 'dotenv';
import { WebSocketServer, WebSocket } from 'ws';
import fastifyFormBody from '@fastify/formbody';

dotenv.config();

const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);

// -----------------------------
// App config
// -----------------------------
const SYSTEM_MESSAGE =
  'You are a friendly British maintenance assistant for a property management company. Collect the caller’s maintenance issue, flat/unit number, and urgency; confirm back succinctly. Keep it polite, natural, and brief.';
const VOICE = 'alloy';
const TEMPERATURE = 0.8;
const PORT = process.env.PORT || 5050;

// Timing
const SILENCE_MS = 900;     // pause with no frames → end of user turn
const MIN_BUFFER_MS = 250;  // must have at least this much audio before commit
const COMMIT_DELAY_MS = 150; // small delay to let append frames flush

// Helpful log filters
const LOG_EVENT_TYPES = [
  'error',
  'response.done',
  'response.output_audio.delta',
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'session.created',
  'session.updated'
];

// -----------------------------
// μ-law (G.711) → PCM16 decoder
// -----------------------------
// Twilio sends 8-bit μ-law (PCMU) frames; we convert to 16-bit Linear PCM (little-endian)
function mulawByteToPcm16(u8) {
  // Invert μ-law byte
  let u = ~u8 & 0xff;

  const sign = u & 0x80;
  let exponent = (u >> 4) & 0x07;
  let mantissa = u & 0x0f;

  // μ-law decoding constants
  const bias = 0x84; // 132
  let magnitude = ((mantissa << 4) + 0x08) << (exponent + 3);
  magnitude -= bias;

  let sample = sign ? -magnitude : magnitude;
  // clamp to 16-bit
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;
  return sample;
}

// Convert base64 μ-law buffer -> PCM16 (Uint8Array little-endian), then base64 it
function mulawBase64ToPcm16Base64(b64) {
  const mu = Buffer.from(b64, 'base64');
  const pcmBytes = Buffer.allocUnsafe(mu.length * 2); // 2 bytes per PCM16 sample
  for (let i = 0; i < mu.length; i++) {
    const s = mulawByteToPcm16(mu[i]);
    pcmBytes.writeInt16LE(s, i * 2);
  }
  return pcmBytes.toString('base64');
}

// -----------------------------
// Health
// -----------------------------
fastify.get('/', async (_req, reply) => {
  reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// -----------------------------
// Twilio webhook → TwiML
// -----------------------------
fastify.all('/incoming-call', async (request, reply) => {
  const host = request.headers['x-forwarded-host'] || request.headers.host;
  const wsUrl = `wss://${host}/media-stream`;

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy">Please wait while I connect you to the assistant.</Say>
  <Pause length="1"/>
  <Say voice="Polly.Amy">Okay, you can start talking now.</Say>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

  reply.code(200).type('text/xml').send(twimlResponse);
});

// -----------------------------
// Start HTTP; then raw WS for Twilio
// -----------------------------
await fastify.listen({ port: PORT, host: '0.0.0.0' });
console.log(`Server is listening on 0.0.0.0:${PORT}`);

const wss = new WebSocketServer({
  server: fastify.server,
  path: '/media-stream'
});

wss.on('connection', (ws) => {
  console.log('🔌 Twilio connected to /media-stream');

  // Per-call state
  let streamSid = null;
  let latestMediaTimestamp = 0;

  // Track current user turn
  let captureStartMs = null;   // timestamp of first frame in current utterance
  let bufferedMs = 0;          // how much audio we’ve buffered this turn
  let awaitingResponse = false;
  let silenceTimer = null;

  // Assistant playback/markers
  let lastAssistantItem = null;
  let responseStartTimestampTwilio = null;
  let markQueue = [];

  const resetSilenceTimer = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      requestResponse();
    }, SILENCE_MS);
  };

  const clearTurnState = () => {
    captureStartMs = null;
    bufferedMs = 0;
  };

  // -----------------------------
  // OpenAI Realtime WebSocket
  // -----------------------------
  const openAiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17&temperature=' + TEMPERATURE,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  const initializeSession = () => {
    // ✅ Input is PCM16 (what we send after decoding μ-law)
    // ✅ Output is μ-law so Twilio can play it straight back
    const sessionUpdate = {
      type: 'session.update',
      session: {
        voice: VOICE,
        instructions: SYSTEM_MESSAGE,
        modalities: ['audio', 'text'],
        input_audio_format: 'pcm16',     // we will append PCM16
        output_audio_format: 'g711_ulaw' // OpenAI → Twilio playback
      }
    };
    console.log('→ OpenAI session.update', sessionUpdate);
    openAiWs.send(JSON.stringify(sessionUpdate));
  };

  const sendMark = () => {
    if (!streamSid) return;
    ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'responsePart' } }));
    markQueue.push('responsePart');
  };

  // Only commit when buffer is real and we’re not already in-flight
  const requestResponse = () => {
    if (awaitingResponse) {
      console.log('⏸️ Already awaiting a response; skipping commit.');
      return;
    }
    bufferedMs = captureStartMs == null ? 0 : Math.max(0, latestMediaTimestamp - captureStartMs);
    if (bufferedMs < MIN_BUFFER_MS) {
      console.log(`🧊 Not enough user audio buffered (${bufferedMs}ms < ${MIN_BUFFER_MS}ms).`);
      return;
    }
    awaitingResponse = true;
    console.log(`🛑 Preparing to commit ${bufferedMs}ms of audio (PCM16)...`);

    // Give OpenAI a tiny moment to flush any pending append frames
    setTimeout(() => {
      console.log('📨 Committing buffer to OpenAI...');
      openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      openAiWs.send(JSON.stringify({ type: 'response.create' }));
      clearTurnState();
    }, COMMIT_DELAY_MS);
  };

  // --- OpenAI events
  openAiWs.on('open', () => {
    console.log('✅ Connected to OpenAI Realtime API');
    setTimeout(initializeSession, 150);
    setTimeout(() => console.log('🧠 Session initialised, awaiting audio...'), 400);
  });

  openAiWs.on('message', (data) => {
    try {
      const response = JSON.parse(data);

      if (response.type === 'error') {
        console.error('❗ OpenAI ERROR:', JSON.stringify(response, null, 2));
      }

      if (LOG_EVENT_TYPES.includes(response.type)) {
        console.log(`OpenAI event: ${response.type}`);
      }

      if (response.type === 'response.output_audio.delta' && response.delta) {
        // got assistant audio → send to Twilio
        awaitingResponse = false;

        ws.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: response.delta }
        }));

        if (responseStartTimestampTwilio == null) {
          responseStartTimestampTwilio = latestMediaTimestamp;
        }
        if (response.item_id) lastAssistantItem = response.item_id;
        sendMark();
      }

      if (response.type === 'response.done') {
        awaitingResponse = false;
        console.log('✅ Assistant finished speaking.');
      }

      if (response.type === 'input_audio_buffer.speech_started') {
        // If assistant was talking and user starts, truncate assistant
        if (markQueue.length > 0 && responseStartTimestampTwilio != null && lastAssistantItem) {
          const elapsed = Math.max(0, latestMediaTimestamp - responseStartTimestampTwilio);
          openAiWs.send(JSON.stringify({
            type: 'conversation.item.truncate',
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: elapsed
          }));
          ws.send(JSON.stringify({ event: 'clear', streamSid }));
          markQueue = [];
          lastAssistantItem = null;
          responseStartTimestampTwilio = null;
        }
      }

      if (response.type === 'input_audio_buffer.speech_stopped') {
        console.log('🛑 Caller speech stopped (VAD trigger)');
        requestResponse();
      }
    } catch (err) {
      console.error('Error parsing OpenAI message:', err, 'Raw:', data?.toString?.());
    }
  });

  openAiWs.on('close', () => console.log('🔻 OpenAI WS closed'));
  openAiWs.on('error', (err) => console.error('OpenAI WS error:', err));

  // --- Twilio frames
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.event) {
        case 'connected':
          console.log('Twilio WS event: connected');
          break;

        case 'start':
          streamSid = data.start.streamSid;
          console.log('▶️ Stream started:', streamSid);
          captureStartMs = null;
          bufferedMs = 0;
          awaitingResponse = false;
          resetSilenceTimer();
          break;

        case 'media': {
          // Twilio timestamp (ms since start of call)
          latestMediaTimestamp = data.media.timestamp;

          // Mark the start of this utterance on first frame
          if (captureStartMs == null) captureStartMs = latestMediaTimestamp;
          bufferedMs = Math.max(0, latestMediaTimestamp - captureStartMs);

          // Decode μ-law → PCM16 and append to OpenAI buffer
          const muB64 = data.media.payload; // base64 μ-law 8 kHz mono
          const pcm16b64 = mulawBase64ToPcm16Base64(muB64);
          if (openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm16b64 }));
          }

          // Keep silence timer hot
          resetSilenceTimer();
          break;
        }

        case 'mark':
          if (markQueue.length > 0) markQueue.shift();
          break;

        case 'stop':
          console.log('⏹️ Stream stopped');
          if (silenceTimer) clearTimeout(silenceTimer);
          // final attempt to commit if we have real audio buffered
          requestResponse();
          break;

        default:
          console.log('Twilio WS event:', data.event);
          break;
      }
    } catch (err) {
      console.error('Error parsing Twilio WS message:', err, message?.toString?.());
    }
  });

  ws.on('close', () => {
    console.log('❌ Twilio WS closed');
    if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
  });

  ws.on('error', (err) => {
    console.error('❌ Twilio WS error:', err);
  });
});
