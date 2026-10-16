import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useApp } from "./context";
import { useI18n } from "./i18n";
import { ApiError, request, streamChat } from "./api";
import type { ChatResponse, RequestResult } from "./api";
import { Note } from "./components";
import LanguageSelect from "./LanguageSelect";
type Attempt = { key: string; createdAt: number };
export default function ChatDialog({
  modelId,
  close,
}: {
  modelId: string;
  close: () => void;
}) {
  const { state, refresh } = useApp(),
    { t, money, number, errorText } = useI18n(),
    ref = useRef<HTMLDialogElement>(null),
    busyRef = useRef(false),
    controller = useRef<AbortController | null>(null);
  const [model] = useState(() => state.models.find((m) => m.id === modelId)!),
    [storageKey] = useState(
      () => `cm-chat-request:${state.user!.id}:${modelId}`,
    );
  const [attempt, setAttempt] = useState<Attempt | null>(() => {
    try {
      const a = JSON.parse(sessionStorage.getItem(storageKey) || "null");
      return a &&
        typeof a.key === "string" &&
        /^[a-zA-Z0-9._-]{8,100}$/.test(a.key) &&
        Number.isSafeInteger(a.createdAt)
        ? a
        : null;
    } catch {
      return null;
    }
  });
  const [prompt, setPrompt] = useState(""),
    [maxTokens, setMaxTokens] = useState(Math.min(1024, model.maxOutputTokens)),
    [streaming, setStreaming] = useState(true),
    [busy, setBusy] = useState(false),
    [recovering, setRecovering] = useState(!!attempt),
    [reply, setReply] = useState<ChatResponse | null>(null),
    [text, setText] = useState(""),
    [id, setId] = useState(""),
    [error, setError] = useState<unknown>(null);
  function save(a: Attempt | null) {
    setAttempt(a);
    try {
      if (a) sessionStorage.setItem(storageKey, JSON.stringify(a));
      else sessionStorage.removeItem(storageKey);
    } catch {
      /* Request bodies are never stored in browser persistence. */
    }
  }
  function complete(result: ChatResponse) {
    setReply(result);
    setText(result.choices[0].message.content);
    setId(result.id);
    setRecovering(false);
    save(null);
    void refresh().catch(() => {});
  }
  async function recover() {
    if (!attempt || busyRef.current) return;
    busyRef.current = true;
    try {
      const row = await request<RequestResult>(
        "/api/requests?" + new URLSearchParams({ key: attempt.key }),
      );
      setId(row.id);
      if (row.status === "succeeded") {
        setError(null);
        complete(row.result!);
      } else if (row.status === "failed") {
        setRecovering(false);
        save(null);
        setError(
          new ApiError(
            502,
            row.result?.error?.message || "Request failed",
            row.result?.error?.code || "request_failed",
            undefined,
            row.id,
          ),
        );
        void refresh().catch(() => {});
      }
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.status === 404 &&
        Date.now() - attempt.createdAt > 120000
      ) {
        setRecovering(false);
        save(null);
      } else setError(e);
    } finally {
      busyRef.current = false;
    }
  }
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    return () => {
      controller.current?.abort();
      d.close();
    };
  }, []);
  useEffect(() => {
    if (!recovering) return;
    void recover();
    const timer = setInterval(() => void recover(), 1000);
    return () => clearInterval(timer);
  }, [recovering, attempt?.key]);
  async function submit() {
    if (busyRef.current || recovering) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setText("");
    setReply(null);
    setId("");
    const a = { key: crypto.randomUUID(), createdAt: Date.now() };
    save(a);
    const ctrl = new AbortController();
    controller.current = ctrl;
    const body = {
      model: model.id,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      stream: streaming,
    };
    try {
      const result = streaming
        ? await streamChat(body, {
            csrf: state.csrfToken,
            requestId: a.key,
            signal: ctrl.signal,
            onText: (s) => setText((old) => old + s),
            onId: setId,
          })
        : await request<ChatResponse>("/v1/chat/completions", {
            method: "POST",
            body,
            csrf: state.csrfToken,
            requestId: a.key,
            signal: ctrl.signal,
          });
      complete(result);
    } catch (e) {
      if (
        !(e instanceof ApiError) ||
        e.status === 0 ||
        e.status >= 500 ||
        e.code === "request_pending"
      ) {
        setRecovering(true);
        if (!ctrl.signal.aborted) setError(e);
      } else {
        save(null);
        setError(e);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
      controller.current = null;
      void refresh().catch(() => {});
    }
  }
  return createPortal(
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="chat-dialog-title"
      onCancel={(e) => (busy ? e.preventDefault() : close())}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
    >
      <div className="dialog-content">
        <div className="dialog-header">
          <h2 id="chat-dialog-title">
            {t("model.try")} · {model.name}
          </h2>
          <LanguageSelect />
          <button
            className="icon-button"
            disabled={busy}
            onClick={close}
            aria-label={t("common.close")}
          >
            <X size={20} />
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="dialog-body form">
            <label>
              {t("chat.prompt")}
              <textarea
                name="prompt"
                value={prompt}
                disabled={busy || recovering}
                onChange={(e) => setPrompt(e.target.value)}
                required
                maxLength={16000}
                rows={4}
              />
            </label>
            <label>
              {t("chat.maxOutput")}
              <input
                name="maxTokens"
                type="number"
                min="1"
                max={model.maxOutputTokens}
                required
                disabled={busy || recovering}
                value={maxTokens}
                onChange={(e) => setMaxTokens(Number(e.target.value))}
              />
            </label>
            <label className="checkbox-label">
              <input
                name="stream"
                type="checkbox"
                disabled={busy || recovering}
                checked={streaming}
                onChange={(e) => setStreaming(e.target.checked)}
              />
              {t("chat.streaming")}
            </label>
            <Note>{t("chat.streamNote")}</Note>
            {(busy || recovering) && (
              <p role="status">
                {t(recovering ? "chat.recovering" : "chat.receiving")}
              </p>
            )}
            {(text || reply) && (
              <div className="reply" aria-live="polite">
                <strong>{model.name}</strong>
                <p className="reply-content">{text}</p>
                {reply && (
                  <div className="reply-usage">
                    <span>
                      {t("wallet.tokens", {
                        input: number(reply.usage.prompt_tokens),
                        output: number(reply.usage.completion_tokens),
                      })}
                    </span>
                    <strong>{money(reply.billing.amount)}</strong>
                  </div>
                )}
              </div>
            )}
            {id && (
              <small>
                {t("chat.request")}: <code>{id}</code>
              </small>
            )}
            {error !== null && (
              <p className="form-error" role="alert">
                {errorText(error)}
              </p>
            )}
          </div>
          <div className="dialog-footer">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={close}
            >
              {t("common.close")}
            </button>
            {busy ? (
              <button
                type="button"
                className="button"
                onClick={() => controller.current?.abort()}
              >
                {t("chat.stopReceiving")}
              </button>
            ) : (
              <button
                className="button primary"
                type="submit"
                disabled={recovering}
              >
                {t("chat.send")}
              </button>
            )}
          </div>
        </form>
      </div>
    </dialog>,
    document.body,
  );
}
