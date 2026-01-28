/**
 * LLM Service – Groq ONLY (safe for Telegram, never empty)
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

  try {
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

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Groq ${res.status}: ${err}`);
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;

    // 🚨 Prevent empty string
    if (!text || !text.trim()) {
      console.warn("⚠️ Groq returned empty response, using fallback message.");
      return "⚠️ I'm temporarily unavailable. Please try again shortly.";
    }

    return text.trim();
  } catch (err: any) {
    console.error("❌ Groq call failed:", err.message);
    return "⚠️ I'm temporarily unavailable. Please try again shortly.";
  }
}

/* ===================== PUBLIC API ===================== */

export async function generateResponse(
  userMessage: string,
  systemPrompt: string,
): Promise<string> {
  return await callGroq(userMessage, systemPrompt);
}

/* ===================== PROMPT GENERATOR ===================== */

export async function generatePrompt(instructions: string): Promise<string> {
  const metaPrompt = `Create a concise system prompt (under 500 chars) for a Telegram chatbot.

Instructions:
${instructions}

Return ONLY the prompt text.`;

  try {
    const prompt = await callGroq(metaPrompt);
    // 🚨 fallback if empty
    return prompt && prompt.trim() ? prompt : "You are a helpful Telegram assistant.";
  } catch {
    return "You are a helpful Telegram assistant.";
  }
}
