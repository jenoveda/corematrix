import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { errorMessage } from "./errors";
import { ApiError } from "../api";
import { messages, resolveLocale, translate, locales } from "./messages";
import type { Key, Locale } from "./messages";
export { locales };
export type { Key, Locale };
const Context = createContext<{
  locale: Locale;
  setLocale: (locale: Locale) => void;
} | null>(null);
const storageKey = "corematrix.locale";
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLanguage] = useState<Locale>(() => {
    try {
      return resolveLocale(
        localStorage.getItem(storageKey) || navigator.language,
      );
    } catch {
      return "zh-CN";
    }
  });
  function setLocale(next: Locale) {
    setLanguage(next);
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      /* Browser storage is optional for language preferences. */
    }
  }
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === storageKey && event.newValue)
        setLanguage(resolveLocale(event.newValue));
    };
    addEventListener("storage", sync);
    return () => removeEventListener("storage", sync);
  }, []);
  return (
    <Context.Provider value={{ locale, setLocale }}>
      {children}
    </Context.Provider>
  );
}
export function useI18n() {
  const value = useContext(Context);
  if (!value) throw new Error("Missing I18nProvider");
  const { locale } = value;
  const t = (key: Key, params?: Record<string, string | number>) =>
    translate(locale, key, params);
  const money = (micros: number) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "CNY",
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    }).format(micros / 1e6);
  const number = (n: number) => new Intl.NumberFormat(locale).format(n);
  const date = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat(locale, {
          timeZone: "Asia/Shanghai",
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(value))
      : "—";
  const errorText = (error: unknown) =>
    error instanceof ApiError
      ? errorMessage(locale, error)
      : t("errors.network_error");
  const status = (value: string) => {
    const key = `status.${value}`;
    return t(
      Object.hasOwn(messages[locale], key) ? (key as Key) : "common.unknown",
    );
  };
  return { ...value, t, money, number, date, errorText, status };
}
