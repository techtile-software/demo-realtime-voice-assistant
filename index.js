import Fastify from "fastify";
import WebSocket from "ws";
import fs from "fs";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import fetch from "node-fetch";

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables
const { OPENAI_API_KEY } = process.env;
console.log("OpenAI API key:", OPENAI_API_KEY);
if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key. Please set it in the .env file.");
  process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const SYSTEM_MESSAGE = `You are an AI assistant, your name is Marie. You're calling from Edebex, specify this in the greeting part. Your job is to politely engage with the client, you'll call him as Peter, greet him first, then ask for availabilty and then ask these questions: 
  What is the country where you are operating?
  Are your invoices are already due? If not when?
  Are services or deliveries are executed and delivered?
  Do you have a factoring contract?
  Do you have any social security/tax debts?
  Ask one question at a time. Do not ask for other contact information. Ensure the conversation remains friendly and professional, and guide the user to provide these details naturally. If necessary, ask follow-up questions to gather the required information. After you acquired all of the answers, say this "Thank you for your time. My colleague will be in touch for the next steps." give your kind regards, and terminate the session.`;
const VOICE = "shimmer";
const PORT = process.env.PORT || 5050;
const WEBHOOK_URL = "<input your webhook URL here>";

// Session management
const sessions = new Map();

// List of Event Types to log to the console
const LOG_EVENT_TYPES = [
  "response.content.done",
  "rate_limits.updated",
  "response.done",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "session.created",
  "response.text.done",
  "conversation.item.input_audio_transcription.completed",
];

// Root Route
fastify.get("/", async (request, reply) => {
  reply.send({ message: "Twilio Media Stream Server is running!" });
});

// Route for Twilio to handle incoming and outgoing calls
fastify.all("/incoming-call", async (request, reply) => {
  console.log("Incoming call");

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                                                        <Say> </Say>

                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;
  console.log("HOST", request.headers.host);

  reply.type("text/xml").send(twimlResponse);
});
// WebSocket route for media-stream
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection, req) => {
    console.log("Client connected");

    const sessionId =
      req.headers["x-twilio-call-sid"] || `session_${Date.now()}`;
    let session = sessions.get(sessionId) || {
      transcript: "",
      streamSid: null,
    };
    sessions.set(sessionId, session);

    let openAiWs;
    try {
      openAiWs = new WebSocket(
        //"wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
        "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "OpenAI-Beta": "realtime=v1",
          },
        }
      );
      console.log("Connecting to the OpenAI Realtime API...", openAiWs);
    } catch (error) {
      console.log(error);
    }

    const sendSessionUpdate = () => {
      const sessionUpdate = {
        type: "session.update",
        session: {
          turn_detection: { type: "server_vad" },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: VOICE,
          instructions: SYSTEM_MESSAGE,
          modalities: ["text", "audio"],
          temperature: 0.8,
          input_audio_transcription: {
            model: "whisper-1",
          },
        },
      };

      //      console.log("Sending session //update:", //JSON.stringify(sessionUpdate));
      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    // Open event for OpenAI WebSocket
    openAiWs.on("open", () => {
      console.log("Connected to the AI Agent api");
      setTimeout(sendSessionUpdate, 250);
    });

    // Listen for messages from the OpenAI WebSocket
    openAiWs.on("message", (data) => {
      try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type)) {
          //       console.log(`Received //event: ${response.type}`, response);
        }

        // User message transcription handling
        if (
          response.type ===
          "conversation.item.input_audio_transcription.completed"
        ) {
          const userMessage = response.transcript.trim();
          session.transcript += `User: ${userMessage}\n`;
          //   console.log(`User //(${sessionId}): ${userMessage}`);
        }

        // Agent message handling
        if (response.type === "response.done") {
          const agentMessage =
            response.response.output[0]?.content?.find(
              (content) => content.transcript
            )?.transcript || "Agent message not found";
          session.transcript += `Agent: ${agentMessage}\n`;
          //  console.log(`Agent //(${sessionId}): ${agentMessage}`);
        }

        if (response.type === "session.updated") {
          //     console.log("Session //updated successfully:", response);
        }

        if (response.type === "response.audio.delta" && response.delta) {
          const audioDelta = {
            event: "media",
            streamSid: session.streamSid,
            media: {
              payload: Buffer.from(response.delta, "base64").toString("base64"),
            },
          };
          connection.send(JSON.stringify(audioDelta));
        }
      } catch (error) {
        console.error(
          "Error processing OpenAI message:",
          error,
          "Raw message:",
          data
        );
      }
    });

    // Handle incoming messages from Twilio
    connection.on("message", (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case "media":
            if (openAiWs.readyState === WebSocket.OPEN) {
              const audioAppend = {
                type: "input_audio_buffer.append",
                audio: data.media.payload,
              };

              openAiWs.send(JSON.stringify(audioAppend));
            }
            break;
          case "start":
            session.streamSid = data.start.streamSid;
            //     console.log("Incoming stream has started", session.streamSid);
            break;
          default:
            // console.log("Received non-media event:", data.event);
            break;
        }
      } catch (error) {
        console.error("Error parsing message:", error, "Message:", message);
      }
    });

    // Handle connection close and log transcript
    connection.on("close", async () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      //     console.log(`Client disconnected (${sessionId}).`);
      //   console.log("Full Transcript:");
      //  console.log(session.transcript);

      await processTranscriptAndSend(session.transcript, sessionId);

      // Clean up the session
      sessions.delete(sessionId);
    });

    // Handle WebSocket close and errors
    openAiWs.on("close", () => {
      console.log("Disconnected from the OpenAI Realtime API");
    });

    openAiWs.on("error", (error) => {
      console.error("Error in the OpenAI WebSocket:", error);
    });
  });
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is listening on port ${PORT}`);
});

// Function to make ChatGPT API completion call with structured outputs
async function makeChatGPTCompletion(transcript) {
  //console.log("Starting ChatGPT API call...");
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content:
              "Extract customer details: name, country (double check this to be an actual country), invoices due date, services delivery, factoring contract, tax debts",
          },
          { role: "user", content: transcript },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "customer_details_extraction",
            schema: {
              type: "object",
              properties: {
                customer_name: { type: "string" },
                country: { type: "string" },
                invoices_due_date: { type: "string" },
                service_delivery: { type: "string" },
                factoring_contract: { type: "string" },
                tax_debts: { type: "string" },
              },
              required: [
                "customer_name",
                "country",
                "invoices_due_date",
                "service_delivery",
                "factoring_contract",
                "tax_debts",
              ],
            },
          },
        },
      }),
    });

    // console.log("ChatGPT API response status:", response.status);
    const data = await response.json();
    // console.log("Full ChatGPT API response:", JSON.stringify(data, null, 2));
    return data;
  } catch (error) {
    console.error("Error making ChatGPT completion call:", error);
    throw error;
  }
}

// Function to send data to Make.com webhook
async function sendToWebhook(payload) {
  // console.log("Sending data to webhook:", JSON.stringify(payload, null, 2));
  try {
    console.log("Information:", payload);

    //  fs.writeFileSync(
    //    "/Users/juani/Desktop/call-result.txt",
    //    JSON.stringify(payload),
    //  );

    /*
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    console.log("Webhook response status:", response.status);
    if (response.ok) {
      console.log("Data successfully sent to webhook.");
    } else {
      console.error("Failed to send data to webhook:", response.statusText);
    }
    */
  } catch (error) {
    console.error("Error sending data to webhook:", error);
  }
}

// Main function to extract and send customer details
async function processTranscriptAndSend(transcript, sessionId = null) {
  // console.log(`Starting transcript processing for session ${sessionId}...`);
  try {
    // Make the ChatGPT completion call
    const result = await makeChatGPTCompletion(transcript);

    // console.log("Raw result from ChatGPT:", JSON.stringify(result, null, 2));

    if (
      result.choices &&
      result.choices[0] &&
      result.choices[0].message &&
      result.choices[0].message.content
    ) {
      try {
        const parsedContent = JSON.parse(result.choices[0].message.content);
        //   console.log("Parsed content:", JSON.stringify(parsedContent, null, 2));

        if (parsedContent) {
          // Send the parsed content directly to the webhook
          await sendToWebhook(parsedContent);
          //       console.log("Extracted and sent customer details:", parsedContent);
        } else {
          console.error("Unexpected JSON structure in ChatGPT response");
        }
      } catch (parseError) {
        console.error("Error parsing JSON from ChatGPT response:", parseError);
      }
    } else {
      console.error("Unexpected response structure from ChatGPT API");
    }
  } catch (error) {
    console.error("Error in processTranscriptAndSend:", error);
  }
}
