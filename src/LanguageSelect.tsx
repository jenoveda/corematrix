import { useApp } from "./context";
import { useI18n, locales } from "./i18n";
import type { Locale } from "./i18n";
export default function LanguageSelect() {
  const { changeLocale, languageSaving } = useApp(),
    { t, locale } = useI18n();
  return (
    <label className="language-select">
      <span className="sr-only">{t("app.language")}</span>
      <select
        disabled={languageSaving}
        aria-label={t("app.language")}
        value={locale}
        onChange={(e) => void changeLocale(e.target.value as Locale)}
      >
        {locales.map((l, i) => (
          <option key={l} value={l}>
            {["简体中文", "English", "日本語", "한국어"][i]}
          </option>
        ))}
      </select>
    </label>
  );
}
