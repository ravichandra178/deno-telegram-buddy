/**
 * LLM Service – Groq ONLY (safe, with logging)
 */

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.1-8b-instant";

/* ===================== GROQ ===================== */

async function callGroq(
  userMessage: string,
  systemPrompt?: string,
): Promise<string> {
  const apiKey = Deno.env.get("GROQ_API_KEY");
  if (!apiKey) throw new Error("GROQ_API_KEY not configured");

  const messages: Array<{ role: string; content: string }> = [];

  if (systemPrompt && systemPrompt.trim()) {
    messages.push({ role: "system", content: systemPrompt });
  }

  messages.push({ role: "user", content: userMessage });

  const res = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: 0.7,
    }),
  });

  const data = await res.json();

  console.log("⚡ Groq raw response:", JSON.stringify(data, null, 2));

  const text = data?.choices?.[0]?.message?.content;

  if (!text || !text.trim()) {
    console.warn("⚠️ Groq returned empty message, using fallback text");
    return "Sorry, I'm having trouble right now. Please try again shortly.";
  }

  return text.trim();
}

/* ===================== PUBLIC API ===================== */

export async function generateResponse(
  userMessage: string,
  systemPrompt: string,
): Promise<string> {
  try {
    console.log("⚡ LLM: Groq");
    return await callGroq(userMessage, systemPrompt);
  } catch (err) {
    console.error("❌ Groq failed:", err.message);
    return "Sorry, I'm having trouble right now. Please try again shortly.";
  }
}

/* ===================== PROMPT GENERATOR ===================== */

export async function generatePrompt(instructions: string): Promise<string> {
  const metaPrompt = `Create a concise system prompt (under 500 chars) for a Telegram chatbot.

Instructions:
${instructions}

Return ONLY the prompt text.`;

  try {
    console.log("⚡ Prompt LLM: Groq");
    return await callGroq(metaPrompt);
  } catch (err) {
    console.error("❌ Prompt generation failed:", err.message);
    return "You are a helpful Telegram assistant.";
  }
}
