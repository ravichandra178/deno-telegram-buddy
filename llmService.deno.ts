/**
 * LLM Service – Groq primary, Gemini fallback (safe)
 */

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama3-70b-8192";

/* ===================== GEMINI ===================== */

async function callGemini(prompt: string): Promise<string> {
  const apiKey = Deno.env.get("LLM_API_KEY");
  if (!apiKey) throw new Error("LLM_API_KEY not configured");

  const res = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1024,
      },
    }),
  });

  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `Gemini ${res.status}`);
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || !text.trim()) {
    throw new Error("Empty Gemini response");
  }

  return text.trim();
}

/* ===================== GROQ ===================== */

async function callGroq(
  userMessage: string,
  systemPrompt?: string,
): Promise<string> {
  const apiKey = Deno.env.get("GROQ_API_KEY");
  if (!apiKey) throw new Error("GROQ_API_KEY not configured");

  const messages = [];

  // 🚨 IMPORTANT: do NOT send empty system prompt to Groq
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

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;

  if (!text || !text.trim()) {
    throw new Error("Empty Groq response");
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
  } catch (groqErr) {
    console.warn("⚠️ Groq failed, trying Gemini:", groqErr.message);
  }

  try {
    console.log("🤖 LLM: Gemini");
    return await callGemini(`${systemPrompt}\n\nUser: ${userMessage}`);
  } catch (geminiErr) {
    console.error("❌ Both LLMs failed:", geminiErr.message);
    return "Sorry, I'm having trouble right now. Please try again later.";
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
  } catch {
    try {
      console.log("🤖 Prompt fallback: Gemini");
      return await callGemini(metaPrompt);
    } catch {
      return "You are a helpful Telegram assistant.";
    }
  }
}
