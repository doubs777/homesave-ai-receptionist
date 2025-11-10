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

const SYSTEM_MESSAGE =
  'You are a friendly British maintenance assistant for a property management company. Collect the caller’s maintenance issue, flat/unit number, and urgency; confirm back succinctly. Keep it polite, natural, and brief.';
const VOICE = 'alloy';
const TEMPERATURE = 0.8;
const PORT = process.env.PORT || 5050;

// Tunables
const SILENCE_MS = 900;       // no media for this long => end of user turn
const MIN_BUFFER_MS = 200;    // must have at least this much audio before commit

const LOG_EVENT_TYPES = [
  'error',
  'response.content.done',
  'rate_limits.updated',
  'response.done',
  'input_audio_buffer.committed',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.speech_started',
  'session.created',
  'session.updated'
];

// Health
fastify.get('/', async (_req, reply) => {
  reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Twilio webhook → TwiML
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

// Start HTTP first; then raw WS for Twilio
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

  // Track a single utterance’s audio window using Twilio timestamps
  let captureStartMs = null;       // timestamp of first media in the current user turn
  let bufferedMs = 0;              // latestMediaTimestamp - captureStartMs
  let awaitingResponse = false;    // we’ve asked OpenAI to reply; don’t double-commit
  let silenceTimer = null;

  // Assistant playback/markers
  let lastAssistantItem = null;
  let responseStartTimestampTwilio = null;
  let markQueue = [];

  const resetSilenceTimer = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      // Silence: only commit if we actually have enough audio buffered
      bufferedMs = captureStartMs == null ? 0 : Math.max(0, latestMediaTimestamp - captureStartMs);
      if (awaitingResponse) return;
      if (bufferedMs < MIN_BUFFER_MS) {
        console.log(`🧊 Silence but buffer too small (${bufferedMs}ms < ${MIN_BUFFER_MS}ms) — not committing`);
        return;
      }
      console.log(`🛑 Silence detected (${bufferedMs}ms) → commit & request response`);
      awaitingResponse = true;
      openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      openAiWs.send(JSON.stringify({ type: 'response.create' }));
      // reset capture window for the next turn
      captureStartMs = null;
      bufferedMs = 0;
    }, SILENCE_MS);
  };

  const clearTurnState = () => {
    awaitingResponse = false;
    captureStartMs = null;
    bufferedMs = 0;
  };

  // Connect to OpenAI Realtime
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
    const sessionUpdate = {
      type: 'session.update',
      session: {
        voice: VOICE,
        instructions: SYSTEM_MESSAGE,
        modalities: ['audio', 'text'],   // ← required combo
        input_audio_format: 'g711_ulaw', // Twilio μ-law in
        output_audio_format: 'g711_ulaw' // μ-law out to Twilio
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

  const handleSpeechStartedEvent = () => {
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
  };

  // OpenAI events
  openAiWs.on('open', () => {
    console.log('✅ Connected to OpenAI Realtime API');
    setTimeout(initializeSession, 100);
    setTimeout(() => console.log('🧠 Session initialised, awaiting audio...'), 300);
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
        // Assistant audio back to Twilio
        awaitingResponse = false; // we are now speaking back
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

      if (response.type === 'input_audio_buffer.speech_started') {
        handleSpeechStartedEvent();
      }

      if (response.type === 'input_audio_buffer.speech_stopped') {
        // Server VAD says stop; only commit if enough audio
        bufferedMs = captureStartMs == null ? 0 : Math.max(0, latestMediaTimestamp - captureStartMs);
        if (!awaitingResponse && bufferedMs >= MIN_BUFFER_MS) {
          console.log(`🛑 VAD stop (${bufferedMs}ms) → commit & request response`);
          awaitingResponse = true;
          openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          openAiWs.send(JSON.stringify({ type: 'response.create' }));
          captureStartMs = null;
          bufferedMs = 0;
        } else {
          console.log(`🧊 VAD stop but buffer too small (${bufferedMs}ms) — ignoring`);
        }
      }
    } catch (err) {
      console.error('Error parsing OpenAI message:', err, 'Raw:', data?.toString?.());
    }
  });

  openAiWs.on('close', () => console.log('🔻 OpenAI WS closed'));
  openAiWs.on('error', (err) => console.error('OpenAI WS error:', err));

  // Twilio frames
  ws.on('message', (message, isBinary) => {
    try {
      const text = isBinary ? message.toString() : message.toString();
      const data = JSON.parse(text);

      switch (data.event) {
        case 'connected':
          console.log('Twilio WS event: connected');
          break;

        case 'start':
          streamSid = data.start.streamSid;
          console.log('▶️ Stream started:', streamSid);
          // start a fresh capture window
          clearTurnState();
          resetSilenceTimer();
          break;

        case 'media': {
          latestMediaTimestamp = data.media.timestamp;

          // Begin a new capture on first media of a turn
          if (captureStartMs == null) {
            captureStartMs = latestMediaTimestamp;
            bufferedMs = 0;
            // console.log(`🎬 Capture start at ${captureStartMs}ms`);
          } else {
            bufferedMs = Math.max(0, latestMediaTimestamp - captureStartMs);
          }

          const audioPayload = data.media.payload;
          if (audioPayload && openAiWs.readyState === WebSocket.OPEN) {
            // Append base64 μ-law frame
            openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: audioPayload }));
            console.log(`🎤 Received audio chunk (${audioPayload.length} bytes) at ${latestMediaTimestamp}ms (buffered ~${bufferedMs}ms)`);
            resetSilenceTimer();
          }
          break;
        }

        case 'mark':
          if (markQueue.length > 0) markQueue.shift();
          break;

        case 'stop':
          console.log('⏹️ Stream stopped');
          if (silenceTimer) clearTimeout(silenceTimer);
          // Final attempt to commit if we have enough audio
          bufferedMs = captureStartMs == null ? 0 : Math.max(0, latestMediaTimestamp - captureStartMs);
          if (!awaitingResponse && bufferedMs >= MIN_BUFFER_MS) {
            console.log(`🛑 Stop with buffer ${bufferedMs}ms → commit & request response`);
            awaitingResponse = true;
            openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
          }
          break;

        default:
          console.log('Twilio WS event:', data.event);
          break;
      }
    } catch (err) {
      console.error('Error parsing Twilio WS message:', err, 'Message:', message?.toString?.());
    }
  });

  ws.on('close', (code, reason) => {
    if (silenceTimer) clearTimeout(silenceTimer);
    console.log(`❌ Twilio WS closed: code=${code} reason=${reason?.toString?.() || ''}`.trim());
    if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
  });

  ws.on('error', (err) => {
    console.error('❌ Twilio WS error:', err);
  });
});
