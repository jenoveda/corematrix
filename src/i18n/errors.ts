import { messages, translate } from "./messages.ts";
import type { Key, Locale } from "./messages.ts";

const fieldLabels: Record<string, Key> = {
  body: "validation.body",
  name: "common.name",
  email: "auth.email",
  password: "auth.password",
  id: "model.id",
  model: "model.id",
  modelId: "model.id",
  tag: "model.tag",
  description: "model.summary",
  inputPrice: "model.inputPrice",
  outputPrice: "model.outputPrice",
  contextTokens: "model.inputLimit",
  maxOutputTokens: "model.outputLimit",
  upstreamUrl: "model.upstream",
  upstreamModel: "model.upstreamId",
  apiKeyEnv: "model.keyEnv",
  routingMode: "model.mode",
  enabled: "model.enabled",
  gpus: "runtime.gpus",
  vram: "runtime.vram",
  runtime: "validation.runtime",
  "runtime.artifact": "runtime.artifact",
  "runtime.revision": "runtime.revision",
  "runtime.dtype": "runtime.dtype",
  "runtime.maxModelLen": "runtime.length",
  "runtime.minGpuMemoryMiB": "runtime.memory",
  "runtime.tensorParallelSize": "runtime.gpus",
  inferenceHost: "server.host",
  portStart: "server.portStart",
  portEnd: "server.portEnd",
  schedulingEnabled: "server.scheduling",
  maintenance: "server.maintenance",
  workMode: "server.mode",
  rentalSalesEnabled: "rental.salesEnabled",
  hourlyPrice: "rental.hourlyPrice",
  region: "server.region",
  serverId: "deployment.server",
  ownerEmail: "rental.owner",
  gpuUuids: "deployment.gpus",
  replaces: "deployment.switch",
  offerId: "rental.offer",
  cards: "rental.cards",
  hours: "rental.hours",
  expectedHourlyPrice: "rental.hourlyPrice",
  startsAt: "reservation.startsAt",
  amount: "common.amount",
  dailyBudget: "wallet.budget",
  reason: "validation.reason",
  reference: "cost.reference",
  category: "cost.category",
  day: "cost.day",
  from: "cost.from",
  to: "cost.to",
  max_tokens: "chat.maxOutput",
  messages: "validation.messages",
  "messages.content": "chat.prompt",
  "messages.role": "validation.messageRole",
  n: "validation.choices",
  stream: "chat.streaming",
  locale: "validation.language",
  requestKey: "validation.requestKey",
};
const moneyFields = new Set([
  "amount",
  "inputPrice",
  "outputPrice",
  "hourlyPrice",
  "expectedHourlyPrice",
  "dailyBudget",
]);
const correlationId =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function errorMessage(
  locale: Locale,
  error: { code: string; details?: unknown; requestId?: string },
) {
  const t = (key: Key, params?: Record<string, string | number>) =>
    translate(locale, key, params);
  const number = (n: number) => new Intl.NumberFormat(locale).format(n);
  const money = (n: number) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "CNY",
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    }).format(n / 1e6);
  const d =
    error.details &&
    typeof error.details === "object" &&
    !Array.isArray(error.details)
      ? (error.details as Record<string, unknown>)
      : {};
  const numeric = (key: string) =>
    typeof d[key] === "number" && Number.isSafeInteger(d[key]) && d[key] >= 0;
  const fieldKey =
    typeof d.field === "string" && Object.hasOwn(fieldLabels, d.field)
      ? fieldLabels[d.field]
      : undefined;
  const field = fieldKey ? t(fieldKey) : t("validation.field");
  const key = `errors.${error.code}`;
  let message = t(
    Object.hasOwn(messages[locale], key) && key !== "errors.withRequestId"
      ? (key as Key)
      : "errors.request_failed",
  );
  if (
    fieldKey &&
    numeric("min") &&
    numeric("max") &&
    Number(d.min) <= Number(d.max)
  ) {
    if (error.code === "invalid_text")
      message = t("validation.text", {
        field,
        min: number(d.min as number),
        max: number(d.max as number),
      });
    if (error.code === "invalid_integer") {
      const monetary = moneyFields.has(d.field as string),
        format = monetary ? money : number;
      message = t(monetary ? "validation.money" : "validation.integer", {
        field,
        min: format(d.min as number),
        max: format(d.max as number),
      });
    }
    if (error.code === "invalid_messages")
      message = t("validation.messagesRange", {
        min: number(d.min as number),
        max: number(d.max as number),
      });
  }
  if (
    fieldKey &&
    ["invalid_option", "invalid_boolean", "invalid_object"].includes(error.code)
  )
    message = t(`validation.${error.code}` as Key, { field });
  if (
    error.code === "insufficient_gpu_memory" &&
    numeric("requiredMiB") &&
    numeric("availableMiB")
  )
    message = t("validation.gpuMemory", {
      required: number(d.requiredMiB as number),
      available: number(d.availableMiB as number),
    });
  if (
    error.code === "gpu_unavailable" &&
    numeric("requiredCards") &&
    numeric("availableCards")
  )
    message = t("validation.gpuCount", {
      required: number(d.requiredCards as number),
      available: number(d.availableCards as number),
    });
  if (
    ["insufficient_balance", "budget_exceeded"].includes(error.code) &&
    numeric("requiredAmount") &&
    numeric("availableAmount")
  )
    message = t(
      error.code === "budget_exceeded"
        ? "validation.budget"
        : "validation.balance",
      {
        required: money(d.requiredAmount as number),
        available: money(d.availableAmount as number),
      },
    );
  return typeof error.requestId === "string" &&
    correlationId.test(error.requestId)
    ? t("errors.withRequestId", { message, requestId: error.requestId })
    : message;
}

export function inputMessage(
  locale: Locale,
  input: Pick<
    HTMLInputElement,
    "validity" | "type" | "minLength" | "maxLength" | "min" | "max" | "step"
  >,
) {
  const t = (key: Key, params?: Record<string, string | number>) =>
      translate(locale, key, params),
    v = input.validity;
  const number = (value: string | number) =>
    value !== "" && Number.isFinite(Number(value))
      ? new Intl.NumberFormat(locale, { maximumFractionDigits: 20 }).format(
          Number(value),
        )
      : String(value);
  if (v.badInput) return t("validation.number");
  if (v.valueMissing) return t("common.required");
  if (v.typeMismatch)
    return t(
      input.type === "email" ? "errors.invalid_email" : "validation.url",
    );
  if (v.tooShort)
    return t("common.minLength", { min: number(input.minLength) });
  if (v.tooLong)
    return t("validation.maxLength", { max: number(input.maxLength) });
  if (v.rangeUnderflow)
    return t("validation.minimum", { min: number(input.min) });
  if (v.rangeOverflow)
    return t("validation.maximum", { max: number(input.max) });
  if (v.stepMismatch)
    return t("validation.step", { step: number(input.step || "1") });
  if (v.patternMismatch) return t("validation.pattern");
  return v.valid ? "" : t("common.invalid");
}
