import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderChoices } from "../src/mainview/components/profiles/ProviderChooser";
import { PROVIDERS } from "../src/mainview/lib/constants";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";

afterEach(() => useLocaleStore.getState().setLocale("zh-CN"));

test("the first account step offers every provider without a selected default or credential fields", () => {
  for (const locale of ["zh-CN", "en"] as const) {
    useLocaleStore.getState().setLocale(locale);
    const html = renderToStaticMarkup(<ProviderChoices onSelect={() => {}} />);
    expect(PROVIDERS).toHaveLength(8);
    expect((html.match(/<button\b/g) ?? []).length).toBe(8);
    for (const provider of PROVIDERS) {
      expect(html).toContain(provider.label);
      expect(html).toContain(`data-provider="${provider.value}"`);
    }
    expect(html).toContain("<fieldset");
    expect(html).toContain(
      locale === "zh-CN"
        ? 'aria-label="存储服务商"'
        : 'aria-label="Storage provider"',
    );
    expect(html).not.toMatch(/<button\b[^>]*\sdisabled(?:=|\s|>)/);
    expect(html).not.toContain("<input");
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).not.toContain('aria-selected="true"');
    expect(html).not.toContain("autofocus");
    expect((html.match(/type="button"/g) ?? []).length).toBe(8);
  }
});

test("provider choices localize Qiniu and custom S3 while preserving recognizable service names", () => {
  const zh = renderToStaticMarkup(<ProviderChoices onSelect={() => {}} />);
  expect(zh).toContain("七牛云 Kodo");
  expect(zh).toContain("自定义 S3 兼容存储");
  useLocaleStore.getState().setLocale("en");
  const en = renderToStaticMarkup(<ProviderChoices onSelect={() => {}} />);
  expect(en).toContain("Qiniu Kodo");
  expect(en).toContain("Custom S3-compatible storage");
  for (const name of ["Cloudflare R2", "Amazon S3", "MinIO", "Backblaze B2"])
    expect(en).toContain(name);
});
