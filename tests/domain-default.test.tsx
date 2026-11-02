import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QiniuShareDomains } from "../src/mainview/components/share/QiniuShareDomains";
import {
  defaultDownloadDomain,
  localizeDownloadHint,
  validatedDownloadOptions,
} from "../src/mainview/components/share/qiniu-share-options";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";
import type { QiniuDownloadOptions } from "../src/shared/qiniu.types";

afterEach(() => useLocaleStore.setState({ locale: "zh-CN" }));
const options = (
  domains: QiniuDownloadOptions["domains"],
  selectedDomain?: string,
): QiniuDownloadOptions => ({
  domains,
  selectedDomain,
  maxShareSeconds: 2592000,
  policyNote: "Fixture policy",
});

test("the first available domain follows the existing list order, including HTTP", () => {
  const value = validatedDownloadOptions(
    options(
      [
        { url: "http://first.example", kind: "cdn", available: true },
        { url: "https://second.example", kind: "origin", available: true },
      ],
      "https://second.example",
    ),
  );
  expect(defaultDownloadDomain(value)).toBe("http://first.example");
  expect(value.domains.map((domain) => domain.url)).toEqual([
    "http://first.example",
    "https://second.example",
  ]);
  expect(
    defaultDownloadDomain({ ...value, domains: [...value.domains].reverse() }),
  ).toBe("https://second.example");
});

test("disabled and invalid domains are skipped; no available domain stays unselected", () => {
  const value = validatedDownloadOptions(
    options([
      { url: "https://s3.example", kind: "origin", available: false },
      { url: "https://bad.example/path", kind: "configured", available: true },
      { url: "http://usable.example", kind: "test", available: true },
    ]),
  );
  expect(defaultDownloadDomain(value)).toBe("http://usable.example");
  expect(defaultDownloadDomain(null)).toBe("");
  expect(defaultDownloadDomain(validatedDownloadOptions(options([])))).toBe("");
  expect(
    defaultDownloadDomain(
      validatedDownloadOptions(
        options([
          { url: "https://disabled.example", kind: "origin", available: false },
        ]),
      ),
    ),
  ).toBe("");
});

test("bilingual domain guidance describes the default without suppressing HTTP warnings", () => {
  const value = validatedDownloadOptions(
    options([{ url: "http://first.example", kind: "cdn", available: true }]),
  );
  for (const locale of ["zh-CN", "en"] as const) {
    useLocaleStore.setState({ locale });
    const html = renderToStaticMarkup(
      <QiniuShareDomains
        options={value}
        selectedDomain={defaultDownloadDomain(value)}
        loading={false}
        error={null}
        disabled={false}
        onSelect={() => {}}
        onReload={() => {}}
      />,
    );
    expect(html).toContain("http://first.example");
    expect(html).toContain('checked=""');
    expect(html).toContain("HTTP");
    expect(html).not.toContain("never selected automatically");
    expect(html).not.toContain("不会自动选择发现的地址");
    expect(html).not.toContain("不自动使用其他域名");
    if (locale === "zh-CN") {
      expect(html).toContain("第一个");
      expect(html).toContain("明文");
    } else {
      expect(html.toLowerCase()).toContain("first");
      expect(html.toLowerCase()).toContain("transport encryption");
    }
  }
});

test("HTTP-prefixed backend hints localize instead of showing both languages", () => {
  const hint =
    "HTTP 链接和下载令牌会明文传输 / HTTP sends links and download tokens without transport encryption";
  useLocaleStore.setState({ locale: "zh-CN" });
  expect(localizeDownloadHint(hint)).toBe("HTTP 链接和下载令牌会明文传输");
  useLocaleStore.setState({ locale: "en" });
  expect(localizeDownloadHint(hint)).toBe(
    "HTTP sends links and download tokens without transport encryption",
  );
  expect(localizeDownloadHint("https://example/path / filename")).toBe(
    "https://example/path / filename",
  );
});
