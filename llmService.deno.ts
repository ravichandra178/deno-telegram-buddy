/**
 * LLM Service for Gemini API integration
 */

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

export interface LLMResponse {
  text: string;
  success: boolean;
  error?: string;
}

export async function generateResponse(
  userMessage: string,
  apiKey: string
): Promise<LLMResponse> {
  if (!apiKey) {
    return {
      text: "LLM API key not configured.",
      success: false,
      error: "Missing LLM_API_KEY",
    };
  }

  try {
    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `You are a helpful Telegram bot assistant. Respond concisely and helpfully to the following message:\n\n${userMessage}`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1024,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Gemini API error:", response.status, errorText);
      return {
        text: "Sorry, I encountered an error processing your request.",
        success: false,
        error: `API error: ${response.status}`,
      };
    }

    const data = await response.json();
    const generatedText =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Sorry, I couldn't generate a response.";

    return {
      text: generatedText,
      success: true,
    };
  } catch (error) {
    console.error("LLM Service error:", error);
    return {
      text: "Sorry, an error occurred while processing your request.",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
