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

// Timing
const SILENCE_MS = 750; // no frames for this long = treat as end of speech

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

fastify.get('/', async (_req, reply) => {
  reply.send({ message: 'Twilio Media Stream Server is running!' });
});

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

// Start HTTP first; then attach raw WS with subprotocol "audio"
await fastify.listen({ port: PORT, host: '0.0.0.0' });
console.log(`Server is listening on 0.0.0.0:${PORT}`);

const wss = new WebSocketServer({
  server: fastify.server,
  path: '/media-stream',
  handleProtocols: (protocols) => {
    if (Array.isArray(protocols) && protocols.includes('audio')) return 'audio';
    return false;
  }
});

wss.on('connection', (ws) => {
  console.log('🔌 Twilio connected to /media-stream');

  let streamSid = null;
  let latestMediaTimestamp = 0;
  let lastAssistantItem = null;
  let markQueue = [];
  let responseStartTimestampTwilio = null;

  // NEW: silence detector state
  let silenceTimer = null;
  let awaitingResponse = false;

  const openAiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=gpt-realtime&temperature=${TEMPERATURE}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );

  const requestResponse = () => {
    if (awaitingResponse) return;
    awaitingResponse = true;
    console.log('🛑 Silence detected → commit & request response');
    openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    openAiWs.send(JSON.stringify({ type: 'response.create' }));
  };

  const resetSilenceTimer = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(requestResponse, SILENCE_MS);
  };

  const initializeSession = () => {
    const sessionUpdate = {
      type: 'session.update',
      session: {
        type: 'realtime',
        model: 'gpt-realtime',
        output_modalities: ['audio'],
        audio: {
          input: { format: { type: 'audio/pcmu' }, turn_detection: { type: 'server_vad' } },
          output: { format: { type: 'audio/pcmu' }, voice: VOICE }
        },
        instructions: SYSTEM_MESSAGE
      }
    };
    console.log('→ OpenAI session.update');
    openAiWs.send(JSON.stringify(sessionUpdate));
  };

  const handleSpeechStartedEvent = () => {
    if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
      const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
      if (lastAssistantItem) {
        openAiWs.send(JSON.stringify({
          type: 'conversation.item.truncate',
          item_id: lastAssistantItem,
          content_index: 0,
          audio_end_ms: elapsedTime
        }));
      }
      ws.send(JSON.stringify({ event: 'clear', streamSid }));
      markQueue = [];
      lastAssistantItem = null;
      responseStartTimestampTwilio = null;
    }
  };

  const sendMark = () => {
    if (!streamSid) return;
    ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'responsePart' } }));
    markQueue.push('responsePart');
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
      if (LOG_EVENT_TYPES.includes(response.type)) console.log(`OpenAI event: ${response.type}`);

      if (response.type === 'response.output_audio.delta' && response.delta) {
        // got assistant audio → no longer awaiting
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

      if (response.type === 'input_audio_buffer.speech_stopped') {
        console.log('🛑 Caller speech stopped (VAD) → commit & request response');
        requestResponse();
      }

      if (response.type === 'input_audio_buffer.speech_started') {
        handleSpeechStartedEvent();
      }
    } catch (err) {
      console.error('Error parsing OpenAI message:', err, 'Raw:', data?.toString?.());
    }
  });

  openAiWs.on('close', () => console.log('🔻 OpenAI WS closed'));
  openAiWs.on('error', (err) => console.error('OpenAI WS error:', err));

  // Twilio WS frames
  ws.on('message', (message, isBinary) => {
    try {
      const text = isBinary ? message.toString() : message.toString();
      const data = JSON.parse(text);

      switch (data.event) {
        case 'start':
          streamSid = data.start.streamSid;
          console.log('▶️ Stream started:', streamSid);
          responseStartTimestampTwilio = null;
          latestMediaTimestamp = 0;
          awaitingResponse = false;
          resetSilenceTimer(); // start listening for pauses
          break;

        case 'media': {
          latestMediaTimestamp = data.media.timestamp;
          const audioPayload = data.media.payload;
          if (audioPayload && openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: audioPayload }));
            // prove audio flowing
            console.log(`🎤 Received audio chunk (${audioPayload.length} bytes) at ${latestMediaTimestamp}ms`);
            resetSilenceTimer(); // each chunk resets the timer
          }
          break;
        }

        case 'mark':
          if (markQueue.length > 0) markQueue.shift();
          break;

        case 'stop':
          console.log('⏹️ Stream stopped');
          if (silenceTimer) clearTimeout(silenceTimer);
          // ask for any pending reply on stop
          requestResponse();
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
