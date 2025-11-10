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
fastify.register(fastifyFormBody);
fastify.register(fastifyWebsocket);

// Config
const SYSTEM_MESSAGE =
  'You are a helpful and bubbly AI assistant who chats naturally. Collect the caller’s maintenance issue, flat number, and urgency; keep it concise and polite.';
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

// Health/root
fastify.get('/', async (_req, reply) => {
  reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// ---- Twilio webhook: returns proper TwiML (XML) ----
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

// ---- WebSocket bridge: Twilio <-> OpenAI Realtime ----
fastify.get('/media-stream', { websocket: true }, (connection /*, req */) => {
  console.log('🔌 Twilio connected to /media-stream');

  // Per-connection state
  let streamSid = null;
  let latestMediaTimestamp = 0;
  let lastAssistantItem = null;
  let markQueue = [];
  let responseStartTimestampTwilio = null;

  // Connect to OpenAI Realtime API
  const openAiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=gpt-realtime&temperature=${TEMPERATURE}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`
      }
    }
  );

  // Send session config after OpenAI socket opens
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

  // If caller interrupts while assistant is talking, truncate
  const handleSpeechStartedEvent = () => {
    if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
      const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
      if (SHOW_TIMING_MATH) {
        console.log(
          `Truncate calc: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`
        );
      }
      if (lastAssistantItem) {
        const truncateEvent = {
          type: 'conversation.item.truncate',
          item_id: lastAssistantItem,
          content_index: 0,
          audio_end_ms: elapsedTime
        };
        openAiWs.send(JSON.stringify(truncateEvent));
      }

      // Tell Twilio to clear buffered audio
      connection.socket.send(
        JSON.stringify({
          event: 'clear',
          streamSid: streamSid
        })
      );

      // Reset
      markQueue = [];
      lastAssistantItem = null;
      responseStartTimestampTwilio = null;
    }
  };

  const sendMark = () => {
    if (streamSid) {
      const markEvent = {
        event: 'mark',
        streamSid,
        mark: { name: 'responsePart' }
      };
      connection.socket.send(JSON.stringify(markEvent));
      markQueue.push('responsePart');
    }
  };

  // OpenAI socket events
  openAiWs.on('open', () => {
    console.log('✅ Connected to OpenAI Realtime API');
    setTimeout(initializeSession, 100);
  });

  openAiWs.on('message', (data) => {
    try {
      const response = JSON.parse(data);

      if (LOG_EVENT_TYPES.includes(response.type)) {
        console.log(`OpenAI event: ${response.type}`);
      }

      if (response.type === 'response.output_audio.delta' && response.delta) {
        // Send audio delta to Twilio
        const audioDelta = {
          event: 'media',
          streamSid,
          media: { payload: response.delta }
        };
        connection.socket.send(JSON.stringify(audioDelta));

        // First delta marks assistant start time
        if (responseStartTimestampTwilio == null) {
          responseStartTimestampTwilio = latestMediaTimestamp;
          if (SHOW_TIMING_MATH) {
            console.log(`Assistant start timestamp: ${responseStartTimestampTwilio}ms`);
          }
        }

        if (response.item_id) {
          lastAssistantItem = response.item_id;
        }

        sendMark();
      }

      // ✅ NEW: when VAD says caller stopped, commit buffer and request a reply
      if (response.type === 'input_audio_buffer.speech_stopped') {
        console.log('🛑 Caller speech stopped → committing & requesting response');
        openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' })); // ✅ NEW
        openAiWs.send(JSON.stringify({ type: 'response.create' }));           // ✅ NEW
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
  connection.socket.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.event) {
        case 'media':
          latestMediaTimestamp = data.media.timestamp;
          if (openAiWs.readyState === WebSocket.OPEN) {
            const audioAppend = {
              type: 'input_audio_buffer.append',
              audio: data.media.payload
            };
            openAiWs.send(JSON.stringify(audioAppend));
          }
          break;

        case 'start':
          streamSid = data.start.streamSid;
          console.log('▶️ Stream started:', streamSid);
          // Reset timing for new stream
          responseStartTimestampTwilio = null;
          latestMediaTimestamp = 0;

          // ✅ Optional: have assistant greet first after connect
          // setTimeout(() => {
          //   if (openAiWs.readyState === WebSocket.OPEN) {
          //     openAiWs.send(JSON.stringify({ type: 'response.create' }));
          //   }
          // }, 300);
          break;

        case 'mark':
          if (markQueue.length > 0) markQueue.shift();
          break;

        default:
          // e.g., "stop", others
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
