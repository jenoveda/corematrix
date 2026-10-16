import type { ServerResponse } from "node:http";
import type { ChatResponse } from "../src/api.ts";
import { readSSE } from "../src/sse.ts";
import { check, object } from "./validation.ts";

export function streamHeader(res: ServerResponse, id: string) {
  if (res.destroyed || res.headersSent) return;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
    "X-Request-ID": id,
  });
  res.flushHeaders();
}
export function streamData(res: ServerResponse, data: unknown) {
  if (!res.destroyed && !res.writableEnded)
    res.write(
      "data: " +
        (typeof data === "string" ? data : JSON.stringify(data)) +
        "\n\n",
    );
}
export function completionChunk(
  id: string,
  model: string,
  choices: unknown[],
  created = Math.floor(Date.now() / 1000),
) {
  return { id, object: "chat.completion.chunk", created, model, choices };
}
export function finishStream(
  res: ServerResponse,
  output: ChatResponse,
  model: string,
  replay = false,
) {
  streamHeader(res, output.id);
  if (replay)
    streamData(
      res,
      completionChunk(
        output.id,
        model,
        [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: output.choices[0].message.content,
            },
            finish_reason: null,
          },
        ],
        output.created,
      ),
    );
  if (replay)
    streamData(
      res,
      completionChunk(
        output.id,
        model,
        [
          {
            index: 0,
            delta: {},
            finish_reason: output.choices[0].finish_reason ?? "stop",
          },
        ],
        output.created,
      ),
    );
  streamData(res, {
    ...completionChunk(output.id, model, [], output.created),
    usage: output.usage,
    billing: output.billing,
  });
  streamData(res, "[DONE]");
  if (!res.destroyed) res.end();
}
export async function consumeCompletion(
  upstream: Response,
  res: ServerResponse,
  id: string,
  model: string,
  created = Math.floor(Date.now() / 1000),
) {
  if (
    !upstream.body ||
    !upstream.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("text/event-stream")
  ) {
    await upstream.body?.cancel().catch(() => {});
    check(false, "Streaming protocol required", 502, "upstream_error");
  }
  streamHeader(res, id);
  streamData(
    res,
    completionChunk(
      id,
      model,
      [
        {
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: null,
        },
      ],
      created,
    ),
  );
  let text = "",
    finishReason: string | null = null,
    usage: Record<string, unknown> | null = null,
    done = false;
  for await (const event of readSSE(upstream.body)) {
    if (event.data === "[DONE]") {
      done = true;
      break;
    }
    const frame = object(JSON.parse(event.data));
    check(
      !frame.error && event.event !== "error",
      "Upstream stream failed",
      502,
      "upstream_error",
    );
    check(
      Array.isArray(frame.choices) && frame.choices.length <= 1,
      "Invalid streaming choices",
      502,
      "invalid_upstream",
    );
    if (frame.usage != null) {
      check(
        finishReason !== null && frame.choices.length === 0 && !usage,
        "Invalid final usage",
        502,
        "invalid_upstream",
      );
      usage = object(frame.usage);
      continue;
    }
    if (!frame.choices.length) continue;
    check(
      finishReason === null && !usage,
      "Content after finish",
      502,
      "invalid_upstream",
    );
    const choice = object(frame.choices[0]),
      delta = object(choice.delta);
    check(
      choice.index === 0,
      "Unsupported choice index",
      502,
      "invalid_upstream",
    );
    check(
      delta.content == null || typeof delta.content === "string",
      "Invalid text delta",
      502,
      "invalid_upstream",
    );
    check(
      delta.refusal == null || typeof delta.refusal === "string",
      "Invalid refusal",
      502,
      "invalid_upstream",
    );
    check(
      delta.tool_calls === undefined &&
        delta.function_call === undefined &&
        delta.audio === undefined,
      "Only text streaming supported",
      502,
      "invalid_upstream",
    );
    check(
      choice.finish_reason == null ||
        ["stop", "length", "content_filter"].includes(
          String(choice.finish_reason),
        ),
      "Invalid finish reason",
      502,
      "invalid_upstream",
    );
    const clean = {
      ...(delta.role === "assistant" ? { role: "assistant" } : {}),
      ...(typeof delta.content === "string" ? { content: delta.content } : {}),
      ...(typeof delta.refusal === "string" ? { refusal: delta.refusal } : {}),
    };
    text += String(delta.content ?? "") + String(delta.refusal ?? "");
    finishReason =
      choice.finish_reason == null ? null : String(choice.finish_reason);
    streamData(
      res,
      completionChunk(
        id,
        model,
        [{ index: 0, delta: clean, finish_reason: finishReason }],
        created,
      ),
    );
  }
  check(
    done && finishReason !== null && usage,
    "Stream ended without final usage",
    502,
    "invalid_upstream",
  );
  return {
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: finishReason,
      },
    ],
    usage,
  };
}
