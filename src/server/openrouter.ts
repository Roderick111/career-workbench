import { db, id, now } from "./db";

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  server_tool_use?: {
    web_search_requests?: number;
  };
}

interface OpenRouterMessage {
  content?: string;
  annotations?: Array<{
    type?: string;
    url_citation?: {
      url?: string;
      title?: string;
      content?: string;
    };
  }>;
}

interface OpenRouterResponse {
  choices?: Array<{ message?: OpenRouterMessage }>;
  usage?: Usage;
  model?: string;
}

export interface ModelResult<T> {
  value: T;
  model: string;
  usage: Usage;
  annotations: NonNullable<OpenRouterMessage["annotations"]>;
}

interface RequestOptions {
  operation: string;
  userId: string;
  applicationId?: string;
  system: string;
  prompt: string;
  schema?: Record<string, unknown>;
  webSearch?: boolean;
}

const apiUrl = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");

export function openRouterRouting(): Array<{ model: string; provider: Record<string, unknown> }> {
  const primary = normalizeModel(process.env.DEFAULT_MODEL ?? "openrouter/minimax/minimax-m3");
  const fallback = normalizeModel(
    process.env.FALLBACK_MODEL ?? "openrouter/deepseek/deepseek-v4-flash",
  );
  return [...new Set([primary, fallback])].map((model) => ({ model, provider: providerConfig(model) }));
}

export async function requestJson<T>(options: RequestOptions): Promise<ModelResult<T>> {
  const result = await request(options);
  let parsed: T;
  try {
    parsed = JSON.parse(stripCodeFence(result.content)) as T;
  } catch (error) {
    throw new Error(`Model returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { value: parsed, model: result.model, usage: result.usage, annotations: result.annotations };
}

export async function requestText(options: RequestOptions): Promise<ModelResult<string>> {
  const result = await request(options);
  return { value: result.content, model: result.model, usage: result.usage, annotations: result.annotations };
}

async function request(options: RequestOptions): Promise<{
  content: string;
  model: string;
  usage: Usage;
  annotations: NonNullable<OpenRouterMessage["annotations"]>;
}> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is missing.");

  const routing = openRouterRouting();
  const attempts = options.webSearch
    ? [
        ...routing.map((item) => ({ ...item, webMode: "server-tool" as const })),
        ...routing.map((item) => ({ ...item, webMode: "plugin" as const })),
      ]
    : routing.map((item) => ({ ...item, webMode: "none" as const }));
  let lastError: unknown;

  for (const { model, provider, webMode } of attempts) {
    try {
      const response = await fetch(`${apiUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.APP_ORIGIN ?? "http://localhost:3000",
          "X-Title": "Tailored CV",
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: options.webSearch ? 3000 : 4500,
          user: options.userId,
          provider,
          messages: [
            { role: "system", content: options.system },
            { role: "user", content: options.prompt },
          ],
          ...(options.schema
            ? {
                response_format: {
                  type: "json_schema",
                  json_schema: {
                    name: options.operation.replace(/[^a-zA-Z0-9_]/g, "_"),
                    strict: true,
                    schema: options.schema,
                  },
                },
              }
            : {}),
          ...(webMode === "server-tool"
            ? {
                tools: [
                  {
                    type: "openrouter:web_search",
                    parameters: {
                      engine: "exa",
                      max_results: 5,
                      max_total_results: 10,
                      max_uses: 2,
                      max_characters: 2500,
                    },
                  },
                ],
                max_tool_calls: 2,
              }
            : {}),
          ...(webMode === "plugin"
            ? {
                plugins: [
                  {
                    id: "web",
                    engine: "exa",
                    max_results: 5,
                  },
                ],
              }
            : {}),
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenRouter ${response.status}: ${body.slice(0, 800)}`);
      }

      const payload = (await response.json()) as OpenRouterResponse;
      const message = payload.choices?.[0]?.message;
      if (!message?.content) throw new Error("OpenRouter returned no content.");
      const usage = payload.usage ?? {};
      recordUsage(options, payload.model ?? model, usage);
      return {
        content: message.content,
        model: payload.model ?? model,
        usage,
        annotations: message.annotations ?? [],
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function providerConfig(model: string): Record<string, unknown> {
  const family = model.includes("minimax") ? "MINIMAX" : model.includes("deepseek") ? "DEEPSEEK" : "";
  const order = splitCsv(family ? process.env[`OPENROUTER_${family}_PROVIDER_ORDER`] : undefined);
  const allowFallbacks =
    family === "MINIMAX"
      ? envBoolean("OPENROUTER_MINIMAX_ALLOW_FALLBACKS", false)
      : true;
  const requireParameters =
    family === "MINIMAX"
      ? envBoolean("OPENROUTER_MINIMAX_REQUIRE_PARAMETERS", true)
      : true;
  return {
    ...(order.length ? { order } : {}),
    allow_fallbacks: allowFallbacks,
    require_parameters: requireParameters,
    data_collection: "deny",
    zdr: true,
  };
}

function recordUsage(options: RequestOptions, model: string, usage: Usage): void {
  db.query(
    `INSERT INTO usage_events
      (id, user_id, application_id, operation, model, prompt_tokens, completion_tokens, web_search_requests, cost, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id(),
    options.userId,
    options.applicationId ?? null,
    options.operation,
    model,
    usage.prompt_tokens ?? 0,
    usage.completion_tokens ?? 0,
    usage.server_tool_use?.web_search_requests ?? 0,
    usage.cost ?? 0,
    now(),
  );
}

function normalizeModel(value: string): string {
  return value.replace(/^openrouter\//, "");
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function envBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
}

function stripCodeFence(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
}
