import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWebsocket from "@fastify/websocket";
import { decode } from "ulaw-js"; // add this small lib

dotenv.config();

const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWebsocket);

const SYSTEM_MESSAGE =
  "You are a friendly British maintenance assistant for a property management company. Collect the caller’s maintenance issue, flat/unit number, and urgency; confirm back succinctly. Keep it polite, natural, and brief.";
const VOICE = "alloy";
const PORT = process.env.PORT || 5050;

fastify.get("/", async (_, reply) => {
  reply.send({ message: "Twilio Media Stream Server is running!" });
});

// ---------- Twilio webhook ----------
fastify.all("/incoming-call", async (request, reply) => {
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  const wsUrl = `wss://${host}/media-stream`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy">Please wait while I connect you to the assistant.</Say>
  <Pause length="1"/>
  <Say voice="Polly.Amy">Okay, you can start talking now.</Say>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

  reply.code(200).type("text/xml").send(twiml);
});

// ---------- WebSocket bridge ----------
fastify.get("/media-stream", { websocket: true }, (connection) => {
  console.log("🔌 Twilio connected to /media-stream");

  let streamSid = null;
  let pcm16Buffer = [];

  const openAiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );

  openAiWs.on("open", () => {
    console.log("✅ Connected to OpenAI Realtime API");
    openAiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          voice: VOICE,
          instructions: SYSTEM_MESSAGE,
          modalities: ["audio", "text"],
          input_audio_format: "pcm16",
          output_audio_format: "g711_ulaw",
        },
      })
    );
  });

  // Twilio → decode µ-law → buffer
  connection.socket.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.event === "media" && data.media?.payload) {
        const ulaw = Buffer.from(data.media.payload, "base64");
        const pcm = decode(ulaw); // convert to PCM16
        pcm16Buffer.push(pcm);
      }

      if (data.event === "start") {
        streamSid = data.start.streamSid;
        console.log("▶️ Stream started:", streamSid);
      }

      if (data.event === "stop") {
        console.log("⏹️ Stream stopped");
        commitAudio();
      }
    } catch (e) {
      console.error("Parse error:", e);
    }
  });

  const commitAudio = () => {
    const combined = Buffer.concat(pcm16Buffer);
    const base64 = combined.toString("base64");

    console.log(`🛑 Preparing to commit ${combined.length} bytes of PCM16...`);
    openAiWs.send(
      JSON.stringify({ type: "input_audio_buffer.append", audio: base64 })
    );
    openAiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    openAiWs.send(JSON.stringify({ type: "response.create" }));
    pcm16Buffer = [];
  };

  openAiWs.on("message", (data) => {
    const msg = JSON.parse(data);
    if (msg.type === "response.output_audio.delta" && msg.delta) {
      const audioDelta = {
        event: "media",
        streamSid,
        media: { payload: msg.delta },
      };
      connection.socket.send(JSON.stringify(audioDelta));
    }
  });

  connection.socket.on("close", () => {
    console.log("❌ Twilio WS closed");
    if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
  });

  openAiWs.on("close", () => console.log("🔻 OpenAI WS closed"));
  openAiWs.on("error", (err) => console.error("OpenAI error:", err));
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is listening on 0.0.0.0:${PORT}`);
});
