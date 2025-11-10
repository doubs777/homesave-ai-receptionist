import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWebsocket from '@fastify/websocket';

// Load env
dotenv.config();

const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}

// App setup
const fastify = Fastify();

// Accept forms (not strictly needed, harmless)
fastify.register(fastifyFormBody);

// IMPORTANT: echo Twilio's subprotocol "audio"
fastify.register(fastifyWebsocket, {
  options: {
    handleProtocols: (protocols /*, request */) => {
      // Twilio sends Sec-WebSocket-Protocol: audio
      if (protocols && protocols.includes('audio')) return 'audio';
      // Fallback: accept first protocol or none
      return protocols?.[0] || false;
    }
  }
});

// Config
const SYSTEM_MESSAGE =
  'You are a friendly British maintenance assistant for a property management company. Collect the caller’s maintenance issue, flat/unit number, and urgency; confirm back succinctly. Keep it polite, natural, and brief.';
const VOICE = 'alloy';
const TEMPERATURE = 0.8;
const PORT = process.env.PORT || 5050;

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

const SHOW_TIMING_MATH = false;

// Health
fastify.get('/', async (_req, reply) => {
  reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Twilio webhook → return TwiML
fastify.all('/incoming-call', async (request, reply) => {
  const host = request.headers['x-forwarded-host'] || request.headers.host;
  const wsUrl = `wss://${host}/media-stream`;

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy">Please wait while I connect you to the assistant.</Say>
  <Pause length="1"/>
  <Say voice="Polly.Amy">Okay, you can start talking now.</Say>
  <Connect>
    <Stream url="${wsUrl}" track="inbound_track" />
  </Connect>
</Response>`;

  reply.code(200).type('text/xml').send(twimlResponse);
});

// WebSocket bridge Twilio <-> OpenAI
fastify.get('/media-stream', { websocket: true }, (connection /*, req */) => {
  console.log('🔌 Twilio connected to /media-stream');

  // Per-connection state
  let streamSid = null;
  let latestMediaTimestamp = 0;
  let lastAssistantItem = null;
  let markQueue = [];
  let responseStartTimestampTwilio = null;

  // Connect to OpenAI Realtime
  const openAiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=gpt-realtime&temperature=${TEMPERATURE}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );

  const initializeSession = () => {
    const sessionUpdate = {
      type: 'session.update',
      session: {
        type: 'realtime',
        model: 'gpt-realtime',
        output_modalities: ['audio'],
        audio: {
          // Twilio sends base64 PCMU frames; declare exactly that
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
      if (SHOW_TIMING_MATH) {
        console.log(`Truncate calc: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`);
      }
      if (lastAssistantItem) {
        openAiWs.send(JSON.stringify({
          type: 'conversation.item.truncate',
          item_id: lastAssistantItem,
          content_index: 0,
          audio_end_ms: elapsedTime
        }));
      }
      connection.socket.send(JSON.stringify({ event: 'clear', streamSid }));
      markQueue = [];
      lastAssistantItem = null;
      responseStartTimestampTwilio = null;
    }
  };

  const sendMark = () => {
    if (!streamSid) return;
    connection.socket.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'responsePart' } }));
    markQueue.push('responsePart');
  };

  // OpenAI socket events
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
        // Twilio playback
        connection.socket.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: response.delta }
        }));

        if (responseStartTimestampTwilio == null) {
          responseStartTimestampTwilio = latestMediaTimestamp;
          if (SHOW_TIMING_MATH) console.log(`Assistant start timestamp: ${responseStartTimestampTwilio}ms`);
        }

        if (response.item_id) lastAssistantItem = response.item_id;
        sendMark();
      }

      // When OpenAI VAD says caller stopped → ask it to reply
      if (response.type === 'input_audio_buffer.speech_stopped') {
        console.log('🛑 Caller speech stopped → committing & requesting response');
        openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        openAiWs.send(JSON.stringify({ type: 'response.create' }));
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

  // Twilio WS events
  connection.socket.on('message', (message, isBinary) => {
    try {
      // Twilio sends JSON text frames; make sure we parse as string
      const text = isBinary ? message.toString() : message.toString();
      const data = JSON.parse(text);

      switch (data.event) {
        case 'start':
          streamSid = data.start.streamSid;
          console.log('▶️ Stream started:', streamSid);
          responseStartTimestampTwilio = null;
          latestMediaTimestamp = 0;
          break;

        case 'media': {
          latestMediaTimestamp = data.media.timestamp;
          const audioPayload = data.media.payload;
          if (audioPayload && openAiWs.readyState === WebSocket.OPEN) {
            // Forward base64 PCMU chunk to OpenAI
            openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: audioPayload }));
            // Debug proof that audio is flowing
            console.log(`🎤 Received audio chunk (${audioPayload.length} bytes) at ${latestMediaTimestamp}ms`);
          }
          break;
        }

        case 'mark':
          if (markQueue.length > 0) markQueue.shift();
          break;

        case 'stop':
          console.log('⏹️ Stream stopped');
          break;

        default:
          console.log('Twilio WS event:', data.event);
          break;
      }
    } catch (err) {
      console.error('Error parsing Twilio WS message:', err, 'Message:', message?.toString?.());
    }
  });

  connection.socket.on('close', () => {
    if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    console.log('❌ Twilio disconnected from /media-stream');
  });
});

// Start server
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is listening on 0.0.0.0:${PORT}`);
});
