import { MICRO } from "../src/domain.ts";
import type { Model, ErrorDetails } from "../src/domain.ts";
export class HttpError extends Error {
  status: number;
  code: string;
  details?: ErrorDetails;
  constructor(
    status: number,
    message: string,
    code = "invalid_request",
    details?: ErrorDetails,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export function check(
  condition: unknown,
  message: string,
  status = 400,
  code?: string,
  details?: ErrorDetails,
): asserts condition {
  if (!condition) throw new HttpError(status, message, code, details);
}
export function object(
  value: unknown,
  field = "body",
): Record<string, unknown> {
  check(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "请求体必须是 JSON 对象。",
    400,
    "invalid_object",
    { field },
  );
  return value as Record<string, unknown>;
}
export function text(
  value: unknown,
  label: string,
  max: number,
  allowEmpty = false,
): string {
  const min = allowEmpty ? 0 : 1;
  check(
    typeof value === "string",
    `${label}必须是文本。`,
    400,
    "invalid_text",
    { field: label, min, max },
  );
  const s = value.trim();
  check(
    (allowEmpty || s.length > 0) && s.length <= max,
    `${label}长度不正确。`,
    400,
    "invalid_text",
    { field: label, min, max },
  );
  return s;
}
export function int(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  check(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= min &&
      value <= max,
    `${label}必须是 ${min}–${max} 的整数。`,
    400,
    "invalid_integer",
    { field: label, min, max },
  );
  return value;
}
export function email(value: unknown) {
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  check(
    s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
    "邮箱格式不正确。",
    400,
    "invalid_email",
    { field: "email" },
  );
  return s;
}
export function password(value: unknown) {
  check(
    typeof value === "string" && value.length >= 12 && value.length <= 128,
    "密码长度必须为 12–128 个字符。",
    400,
    "invalid_password",
    { field: "password", min: 12, max: 128 },
  );
  return value;
}
export function requestKey(value: unknown, field = "requestKey") {
  check(
    typeof value === "string" && /^[a-zA-Z0-9._-]{8,100}$/.test(value.trim()),
    "Idempotency key must be 8–100 letters, digits or ._-",
    400,
    "invalid_request_key",
    { field, min: 8, max: 100 },
  );
  return value.trim();
}
export function validateEndpoint(value: string, origins: Set<string>) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(
      400,
      "推理地址必须是完整 URL。",
      "invalid_upstream_url",
      { field: "upstreamUrl" },
    );
  }
  check(
    ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    "推理地址不允许认证信息、查询参数或片段。",
    400,
    "invalid_upstream_url",
    { field: "upstreamUrl" },
  );
  check(
    origins.has(url.origin),
    "推理地址不在 INFERENCE_ALLOWED_ORIGINS 白名单中。",
    400,
    "upstream_origin_denied",
    { field: "upstreamUrl" },
  );
  return url.href;
}
export function validateModel(
  body: Record<string, unknown>,
  origins: Set<string>,
): Model {
  const id = text(body.id, "id", 100);
  check(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id),
    "模型 ID 仅允许字母、数字和 ._-。",
    400,
    "invalid_model_id",
    { field: "id" },
  );
  const upstreamUrl = text(body.upstreamUrl ?? "", "upstreamUrl", 2048, true),
    apiKeyEnv = text(body.apiKeyEnv ?? "", "apiKeyEnv", 80, true);
  if (upstreamUrl) validateEndpoint(upstreamUrl, origins);
  check(
    !apiKeyEnv || /^INFERENCE_[A-Z0-9_]+$/.test(apiKeyEnv),
    "密钥变量名必须以 INFERENCE_ 开头，且仅包含大写字母、数字和下划线。",
    400,
    "invalid_api_key_env",
    { field: "apiKeyEnv" },
  );
  check(
    typeof body.enabled === "boolean",
    "enabled 必须是布尔值。",
    400,
    "invalid_boolean",
    { field: "enabled" },
  );
  const routingMode = body.routingMode ?? "external";
  check(
    ["external", "managed"].includes(String(routingMode)),
    "Invalid routing mode",
    400,
    "invalid_option",
    { field: "routingMode" },
  );
  const gpus = int(body.gpus, "gpus", 1, 64),
    contextTokens = int(body.contextTokens, "contextTokens", 1, 1_000_000),
    maxOutputTokens = int(body.maxOutputTokens, "maxOutputTokens", 1, 100_000);
  let runtime: Model["runtime"] = null;
  if (routingMode === "managed") {
    const r = object(body.runtime, "runtime"),
      artifact = text(r.artifact, "runtime.artifact", 300),
      revision = text(r.revision, "runtime.revision", 100);
    check(
      /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(artifact) ||
        (/^\/models\/[a-zA-Z0-9_./-]+$/.test(artifact) &&
          !artifact.split("/").includes("..")),
      "Invalid model source",
      400,
      "invalid_model_source",
      { field: "runtime.artifact" },
    );
    check(
      /^[a-zA-Z0-9._-]+$/.test(revision) &&
        !["main", "master", "latest"].includes(revision),
      "Pin model revision",
      400,
      "unpinned_model_revision",
      { field: "runtime.revision" },
    );
    check(
      ["auto", "float16", "bfloat16"].includes(String(r.dtype)),
      "Invalid dtype",
      400,
      "invalid_option",
      { field: "runtime.dtype" },
    );
    runtime = {
      artifact,
      revision,
      dtype: r.dtype as "auto" | "float16" | "bfloat16",
      maxModelLen: int(r.maxModelLen, "runtime.maxModelLen", 1, 1100000),
      minGpuMemoryMiB: int(
        r.minGpuMemoryMiB,
        "runtime.minGpuMemoryMiB",
        1,
        10_000_000,
      ),
      tensorParallelSize: int(
        r.tensorParallelSize,
        "runtime.tensorParallelSize",
        1,
        64,
      ),
    };
    check(
      runtime.tensorParallelSize === gpus,
      "Tensor parallel size must match GPU count",
      400,
      "invalid_integer",
      { field: "runtime.tensorParallelSize", min: gpus, max: gpus },
    );
    check(
      runtime.maxModelLen >= contextTokens + maxOutputTokens,
      "Runtime context is too short",
      400,
      "invalid_integer",
      {
        field: "runtime.maxModelLen",
        min: contextTokens + maxOutputTokens,
        max: 1100000,
      },
    );
  }
  return {
    id,
    name: text(body.name, "name", 100),
    tag: text(body.tag, "tag", 40),
    description: text(body.description, "description", 1000, true),
    inputPrice: int(body.inputPrice, "inputPrice", 0, 10_000 * MICRO),
    outputPrice: int(body.outputPrice, "outputPrice", 0, 10_000 * MICRO),
    gpus,
    vram: int(body.vram, "vram", 1, 1024),
    enabled: body.enabled,
    contextTokens,
    maxOutputTokens,
    upstreamUrl,
    upstreamModel:
      routingMode === "managed"
        ? id
        : text(body.upstreamModel, "upstreamModel", 200),
    apiKeyEnv,
    configured: routingMode === "external" && !!upstreamUrl,
    routingMode: routingMode as "external" | "managed",
    runtime,
  };
}
export function cost(
  inputPrice: number,
  outputPrice: number,
  input: number,
  output: number,
) {
  return Number(
    (BigInt(inputPrice) * BigInt(input) +
      BigInt(outputPrice) * BigInt(output) +
      BigInt(MICRO - 1)) /
      BigInt(MICRO),
  );
}
export const day = () =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
