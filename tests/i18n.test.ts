import test from "node:test";
import assert from "node:assert/strict";
import {
  messages,
  locales,
  translate,
  resolveLocale,
} from "../src/i18n/messages.ts";
test("four dictionaries have identical keys and interpolation variables", () => {
  const reference = messages["zh-CN"];
  for (const locale of locales) {
    assert.deepEqual(
      Object.keys(messages[locale]).sort(),
      Object.keys(reference).sort(),
    );
    for (const key of Object.keys(reference) as (keyof typeof reference)[]) {
      assert.ok(messages[locale][key].trim());
      assert.deepEqual(
        [...messages[locale][key].matchAll(/\{(\w+)\}/g)]
          .map((m) => m[1])
          .sort(),
        [...reference[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(),
      );
    }
  }
  assert.equal(resolveLocale("en-GB"), "en-US");
  assert.equal(resolveLocale("ja"), "ja-JP");
  assert.equal(resolveLocale("ko-KR"), "ko-KR");
  assert.equal(resolveLocale("zh-TW"), "zh-CN");
  assert.equal(
    translate("en-US", "deployment.required", { count: 2, memory: 24000 }),
    "Requires 2 GPUs, each with at least 24000 MiB.",
  );
});
