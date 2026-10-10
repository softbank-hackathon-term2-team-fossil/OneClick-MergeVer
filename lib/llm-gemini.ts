export type GeminiRequest = {
  instructions: string;
  input: string;
  maxOutputTokens: number;
};

export type GeminiSettings = {
  apiKey: string;
  model: string;
};

type FetchLike = typeof fetch;

type ChatCompletionResponse = {
  choices?: { finish_reason?: string | null; message?: { content?: unknown } }[];
  error?: { message?: string };
};

export const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
const MODEL_ID = /^[A-Za-z0-9._-]+$/;

export function readGeminiSettings(env: Record<string, string | undefined>): GeminiSettings {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured.");
  const model = (env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL).replace(/^models\//, "");
  if (!MODEL_ID.test(model)) throw new Error("GEMINI_MODEL contains unsupported characters.");
  return { apiKey, model };
}

export function extractChatText(body: ChatCompletionResponse): string {
  const choice = body.choices?.[0];
  if (!choice) throw new Error("Gemini returned no choices.");
  const content = choice.message?.content;
  const text = typeof content === "string" ? content : "";
  if (!text.trim()) {
    throw new Error(`Gemini returned no text${choice.finish_reason ? ` (finish reason: ${choice.finish_reason})` : ""}.`);
  }
  return text;
}

export async function generateWithGemini(
  request: GeminiRequest,
  settings: GeminiSettings,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const response = await fetchImpl(GEMINI_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        { role: "system", content: request.instructions },
        { role: "user", content: request.input },
      ],
      max_tokens: request.maxOutputTokens,
      temperature: 0.2,
    }),
  });

  const body = (await response.json().catch(() => ({}))) as ChatCompletionResponse;
  if (!response.ok) {
    const detail = body.error?.message?.slice(0, 200) ?? "no details";
    throw new Error(`Gemini API request failed with status ${response.status}: ${detail}`);
  }
  return extractChatText(body);
}
