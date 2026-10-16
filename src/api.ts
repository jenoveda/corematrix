import { readSSE } from "./sse.ts";
export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  requestId?: string;
  constructor(
    status: number,
    message: string,
    code: string,
    details?: unknown,
    requestId?: unknown,
  ) {
    super(typeof message === "string" ? message : "Request failed");
    this.status = status;
    this.code = typeof code === "string" ? code : "request_failed";
    this.details = details;
    if (
      typeof requestId === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        requestId,
      )
    )
      this.requestId = requestId;
  }
}
export async function request<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    csrf?: string;
    requestId?: string;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method || "GET",
      credentials: "same-origin",
      signal: options.signal,
      headers: {
        ...(options.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        ...(options.csrf ? { "X-CSRF-Token": options.csrf } : {}),
        ...(options.requestId ? { "Idempotency-Key": options.requestId } : {}),
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
    });
  } catch {
    throw new ApiError(0, "Network error", "network_error");
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(
      0,
      "Invalid response",
      "invalid_response",
      undefined,
      response.headers.get("X-Request-ID"),
    );
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new ApiError(
      0,
      "Invalid response",
      "invalid_response",
      undefined,
      response.headers.get("X-Request-ID"),
    );
  if (!response.ok)
    throw new ApiError(
      response.status,
      data.error?.message || "请求失败。",
      data.error?.code || "request_failed",
      data.error?.details,
      response.headers.get("X-Request-ID") || data.requestId || data.request_id,
    );
  return data;
}
export type ChatResponse = {
  id: string;
  created?: number;
  choices: { message: { content: string }; finish_reason?: string }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  billing: { amount: number };
};
export type RequestResult = {
  id: string;
  status: "pending" | "succeeded" | "failed";
  reserved: number;
  amount: number;
  modelId: string;
  createdAt: string;
  result: (ChatResponse & { error?: { code: string; message: string } }) | null;
};
export async function streamChat(
  body: unknown,
  options: {
    csrf: string;
    requestId: string;
    signal: AbortSignal;
    onText: (text: string) => void;
    onId: (id: string) => void;
  },
): Promise<ChatResponse> {
  let res: Response;
  try {
    res = await fetch("/v1/chat/completions", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": options.csrf,
        "Idempotency-Key": options.requestId,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch {
    throw new ApiError(0, "Stream disconnected", "stream_interrupted");
  }
  if (!res.ok) {
    let result;
    try {
      result = await res.json();
    } catch {
      throw new ApiError(
        0,
        "Invalid response",
        "invalid_response",
        undefined,
        res.headers.get("X-Request-ID"),
      );
    }
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new ApiError(
        0,
        "Invalid response",
        "invalid_response",
        undefined,
        res.headers.get("X-Request-ID"),
      );
    throw new ApiError(
      res.status,
      result.error?.message || "Request failed",
      result.error?.code || "request_failed",
      result.error?.details,
      res.headers.get("X-Request-ID") || result.requestId || result.request_id,
    );
  }
  if (
    !res.body ||
    !res.headers.get("content-type")?.includes("text/event-stream")
  )
    throw new ApiError(0, "Invalid stream", "stream_interrupted");
  let id = "",
    text = "",
    done = false,
    usage: ChatResponse["usage"] | null = null,
    billing: ChatResponse["billing"] | null = null,
    finishReason = "stop";
  try {
    for await (const event of readSSE(res.body, 4 * 1024 * 1024)) {
      if (event.data === "[DONE]") {
        done = true;
        break;
      }
      const frame = JSON.parse(event.data);
      if (frame.error)
        throw new ApiError(
          502,
          frame.error.message,
          frame.error.code,
          frame.error.details,
          frame.requestId ||
            frame.request_id ||
            res.headers.get("X-Request-ID"),
        );
      if (typeof frame.id === "string") {
        id = frame.id;
        options.onId(id);
      }
      for (const c of frame.choices || []) {
        const delta =
          String(c.delta?.content ?? "") + String(c.delta?.refusal ?? "");
        text += delta;
        if (delta) options.onText(delta);
        if (c.finish_reason) finishReason = c.finish_reason;
      }
      if (frame.usage && frame.billing) {
        usage = frame.usage;
        billing = frame.billing;
      }
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, "Stream interrupted", "stream_interrupted");
  }
  if (!done || !id || !usage || !billing)
    throw new ApiError(0, "Stream interrupted", "stream_interrupted");
  return {
    id,
    choices: [{ message: { content: text }, finish_reason: finishReason }],
    usage,
    billing,
  };
}
