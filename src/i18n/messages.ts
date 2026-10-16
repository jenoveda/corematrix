import zh from "./locales/zh-CN.ts";
import en from "./locales/en-US.ts";
import ja from "./locales/ja-JP.ts";
import ko from "./locales/ko-KR.ts";
export const locales = ["zh-CN", "en-US", "ja-JP", "ko-KR"] as const;
export type Locale = (typeof locales)[number];
export type Key = keyof typeof zh;
export type Messages = Record<Key, string>;
export const messages: Record<Locale, Messages> = {
  "zh-CN": zh,
  "en-US": en,
  "ja-JP": ja,
  "ko-KR": ko,
};
export function resolveLocale(value: string): Locale {
  const exact = locales.find((l) => l === value);
  if (exact) return exact;
  const prefix = value.split("-")[0].toLowerCase();
  return prefix === "en"
    ? "en-US"
    : prefix === "ja"
      ? "ja-JP"
      : prefix === "ko"
        ? "ko-KR"
        : "zh-CN";
}
export function translate(
  locale: Locale,
  key: Key,
  params: Record<string, string | number> = {},
) {
  return messages[locale][key].replace(/\{(\w+)\}/g, (_, name: string) =>
    String(params[name] ?? `{${name}}`),
  );
}
