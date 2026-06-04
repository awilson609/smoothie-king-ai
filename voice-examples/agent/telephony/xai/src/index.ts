import "dotenv-flow/config";
import express from "express";
import ExpressWs from "express-ws";
import * as crypto from "crypto";
import bot from "./bot";
import { TwilioMediaStreamWebsocket } from "./twilio";

const { app } = ExpressWs(express());
app.use(express.urlencoded({ extended: true })).use(express.json());

// ========================================
// Configuration
// ========================================
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const API_URL = process.env.API_URL || "wss://api.x.ai/v1/realtime";

// Twilio SMS Credentials
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || "";

// Feature flags
const ENABLE_TOOLS = process.env.ENABLE_TOOLS !== "false";

// ========================================
// Helper Functions
// ========================================
function logEvent(callId: string, eventType: string, extra?: string) {
  if (extra) {
    console.log(`[${callId}] ${eventType}`);
    console.log(` ${extra}`);
  } else {
    console.log(`[${callId}] ${eventType}`);
  }
}

function generateSecureId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

// ========================================
// Tool Definitions
// ========================================
const tools = [
  {
    type: "function",
    name: "generate_random_number",
    description: "Generate a random number between min and max values",
    parameters: {
      type: "object",
      properties: {
        min: { type: "number", description: "Minimum value (inclusive)" },
        max: { type: "number", description: "Maximum value (inclusive)" },
      },
      required: ["min", "max"],
    },
  },
  {
    type: "function",
    name: "send_ordering_link",
    description: "Send the direct online ordering link to the customer via text message",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Short message to send with the link"
        }
      },
      required: ["message"]
    }
  }
];

// ========================================
// Tool Handlers
// ========================================
async function handleToolCall(name: string, args: Record<string, any>, callerPhone: string = ""): Promise<string> {
  switch (name) {
    case "generate_random_number": {
      const min = Math.ceil(args.min);
      const max = Math.floor(args.max);
      const result = Math.floor(Math.random() * (max - min + 1)) + min;
      return JSON.stringify({ result, min: args.min, max: args.max });
    }

    case "send_ordering_link": {
      if (!callerPhone) {
        return JSON.stringify({ error: "Phone number not available" });
      }

      const message = args.message || "Here's our online ordering link!";

      try {
        const client = require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
        
        await client.messages.create({
          body: `${message}\n\nhttps://order.smoothieking.com/location/2463-smoothie-king-2055-east-andrew-johnson-highway-suite-1/menu`,
          from: TWILIO_PHONE_NUMBER,
          to: callerPhone
        });

        return JSON.stringify({ success: true, message: "Ordering link sent successfully" });
      } catch (error) {
        console.error("Failed to send SMS:", error);
        return JSON.stringify({ error: "Failed to send text message" });
      }
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ========================================
// Health Check
// ========================================
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ========================================
// Twilio Voice Webhook
// ========================================
app.post("/twiml", async (req, res) => {
  try {
    const callId = generateSecureId('call');
    const callerPhone = req.body.From || "";

    if (!process.env.HOSTNAME) {
      res.status(500).send("Server misconfigured: HOSTNAME not set");
      return;
    }

    const hostname = process.env.HOSTNAME.replace(/^https?:\/\//, '');
    const streamUrl = `wss://${hostname}/media-stream/${callId}`;

    const twimlResponse = `\
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;

    res.type("text/xml");
    res.end(twimlResponse);
  } catch (error) {
    res.status(500).send();
  }
});

// ========================================
// Media Stream WebSocket
// ========================================
app.ws("/media-stream/:callId", async (ws, req) => {
  const callId = req.params.callId;
  console.log(`\n[${callId}] === CALL STARTED ===`);

  const tw = new TwilioMediaStreamWebsocket(ws);
  let callerPhone = ""; // Will be set from twiml if possible

  tw.on("start", (msg) => {
    tw.streamSid = msg.start.streamSid;
    logEvent(callId, 'twilio.start');
  });

  const WebSocket = require('ws');
  const xaiWs = new WebSocket(API_URL, {
    headers: {
      'Authorization': `Bearer ${XAI_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("xAI WS timeout")), 10000);
    xaiWs.on('open', () => { clearTimeout(timeout); resolve(null); });
    xaiWs.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });

  let sessionReady = false;
  let turnCount = 0;
  let turnActive = false;

  xaiWs.on('message', async (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.type !== 'response.output_audio.delta' && message.type !== 'input_audio_buffer.append') {
        logEvent(callId, message.type);
      }

      // ... (keep your existing audio + logging logic) ...

      if (message.type === 'response.output_item.done') {
        if (message.item?.type === 'function_call') {
          const functionName = message.item.name;
          const callId_fn = message.item.call_id;
          let args: Record<string, any> = {};

          try {
            args = JSON.parse(message.item.arguments || '{}');
          } catch (e) {}

          console.log(`[${callId}] FUNCTION CALL: ${functionName}(${JSON.stringify(args)})`);

          const result = await handleToolCall(functionName, args, callerPhone);

          const functionResult = {
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: callId_fn,
              output: result,
            }
          };

          logEvent(callId, functionResult.type);
          xaiWs.send(JSON.stringify(functionResult));

          const responseCreate = { type: 'response.create' };
          xaiWs.send(JSON.stringify(responseCreate));
        }
      }
    } catch (error) {
      console.error(`[${callId}] Error:`, error);
    }
  });

  // ... rest of your media and close handlers ...

  tw.on("media", (msg) => {
    // your existing media handler
  });

  ws.on("close", () => xaiWs.close());
});

const port = process.env.PORT || "3000";
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log(`Tool calling: ENABLED`);
});