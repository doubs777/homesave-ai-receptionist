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

const SILENCE_MS = 900;
const MIN_BUFFER_MS = 250; // must have at least 0.25s before commit
const COMMIT_DELAY_MS = 150; // wait after last chunk before commit

const LOG_EVENT_TYPES = [
  'error',
  'response.content.done',
  'response.done',
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
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

await fastify.listen({ port: PORT, host: '0.0.0.0' });
console.log(`Server is listening on 0.0.0.0:${PORT}`);

const wss = new WebSocketServer({ server: fastify.server, path: '/media-stream' });

wss.on('connection', (ws) => {
  console.log('🔌 Twilio connected to /media-stream');

  let streamSid = null;
  let latestMediaTimestamp = 0;
  let captureStartMs = null;
  let bufferedMs = 0;
  let awaitingResponse = false;
  let lastAssistantItem = null;
  let responseStartTimestampTwilio = null;
  let markQueue = [];
  let silenceTimer = null;

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

  const requestResponse = () => {
    if (awaitingResponse) {
      console.log('⏸️ Already awaiting response, skipping.');
      return;
    }
    bufferedMs = captureStartMs == null ? 0 : Math.max(0, latestMediaTimestamp - captureStartMs);
    if (bufferedMs < MIN_BUFFER_MS) {
      console.log(`🧊 Not enough audio buffered (${bufferedMs}ms < ${MIN_BUFFER_MS}ms).`);
      return;
    }

    awaitingResponse = true;
    console.log(`🛑 Preparing to commit ${bufferedMs}ms of audio...`);

    setTimeout(() => {
      console.log('📨 Committing buffer to OpenAI...');
      openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      openAiWs.send(JSON.stringify({ type: 'response.create' }));
      clearTurnState();
    }, COMMIT_DELAY_MS);
  };

  const openAiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17&temperature=' +
      TEMPERATURE,
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
        modalities: ['audio', 'text'],
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw'
      }
    };
    openAiWs.send(JSON.stringify(sessionUpdate));
  };

  const sendMark = () => {
    if (!streamSid) return;
    ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'responsePart' } }));
    markQueue.push('responsePart');
  };

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
        awaitingResponse = false;
        ws.send(
          JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: response.delta }
          })
        );
        if (response.item_id) lastAssistantItem = response.item_id;
        sendMark();
      }

      if (response.type === 'response.done') {
        awaitingResponse = false;
        console.log('✅ Assistant finished speaking.');
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
          clearTurnState();
          resetSilenceTimer();
          break;

        case 'media':
          latestMediaTimestamp = data.media.timestamp;
          if (captureStartMs == null) captureStartMs = latestMediaTimestamp;
          bufferedMs = latestMediaTimestamp - captureStartMs;
          if (openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(
              JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload })
            );
          }
          resetSilenceTimer();
          break;

        case 'mark':
          if (markQueue.length > 0) markQueue.shift();
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
});
