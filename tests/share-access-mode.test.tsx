import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { validateQiniuProfileConfig } from "../src/mainview/components/profiles/providerHints";
import { QiniuShareDomains } from "../src/mainview/components/share/QiniuShareDomains";
import {
  isSelectedDomainAvailable,
  NATIVE_APPLICATION_SHARE_MAX_SECONDS,
  validatedDownloadOptions,
  validatedShareResult,
} from "../src/mainview/components/share/qiniu-share-options";
import { ShareResult } from "../src/mainview/components/share/ShareResult";
import { shareLinkState } from "../src/mainview/components/share/share-expiration";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";
import type { QiniuDownloadOptions } from "../src/shared/qiniu.types";
import type { ShareRes } from "../src/shared/s3.types";

afterEach(() => useLocaleStore.setState({ locale: "zh-CN" }));
const now = Date.parse("2026-11-02T00:00:00Z");
const past = "2026-11-01T23:59:59Z";
const future = "2026-11-02T01:00:00Z";
const makeOptions = (
  url: string,
  kind = "origin",
  available = true,
): QiniuDownloadOptions => ({
  domains: [{ url, kind, available, accessMode: "signed" }],
  maxShareSeconds: NATIVE_APPLICATION_SHARE_MAX_SECONDS,
  policyNote: "Fixture policy",
});

describe("Qiniu file-link protocol compatibility", () => {
  test("explicit HTTP/HTTPS origins and CDN/test domains retain the server's availability without automatic selection", () => {
    for (const [url, kind] of [
      ["http://origin.example", "origin"],
      ["https://origin.example", "origin"],
      ["http://test.example", "test"],
      ["https://cdn.example", "cdn"],
    ]) {
      const value = validatedDownloadOptions(makeOptions(url, kind));
      expect(value.domains[0].url).toBe(url);
      expect(value.domains[0].available).toBe(true);
      expect(value.domains[0].accessMode).toBe("signed");
      expect(value.selectedDomain).toBeUndefined();
      expect(isSelectedDomainAvailable(value, "")).toBe(false);
      expect(isSelectedDomainAvailable(value, url)).toBe(true);
      const unavailable = validatedDownloadOptions(
        makeOptions(url, kind, false),
      );
      expect(unavailable.domains[0].available).toBe(false);
    }
  });

  test("domain authentication modes are explicit and malformed modes never become public", () => {
    const value = makeOptions("https://public.example");
    value.domains[0].accessMode = "public";
    expect(validatedDownloadOptions(value).domains[0].accessMode).toBe(
      "public",
    );
    delete value.domains[0].accessMode;
    expect(
      validatedDownloadOptions(value).domains[0].accessMode,
    ).toBeUndefined();
    for (const accessMode of ["unknown-mode", "PUBLIC", "", null, 1, false]) {
      expect(() =>
        validatedDownloadOptions({
          ...value,
          domains: [{ ...value.domains[0], accessMode }],
        } as QiniuDownloadOptions),
      ).toThrow();
    }
  });

  test("a configured HTTP default still requires an explicit per-dialog selection", () => {
    const http = validatedDownloadOptions({
      ...makeOptions("http://origin.example"),
      selectedDomain: "http://origin.example",
    });
    expect(http.domains[0].available).toBe(true);
    expect(http.selectedDomain).toBeUndefined();
    const https = validatedDownloadOptions({
      ...makeOptions("https://origin.example"),
      selectedDomain: "https://origin.example",
    });
    expect(https.selectedDomain).toBe("https://origin.example");
  });

  test("HTTP support does not accept userinfo, nonstandard ports, URL paths or query tokens", () => {
    for (const url of [
      "http://ak:sk@origin.example",
      "http://origin.example:8080",
      "https://origin.example:8443",
      "http://origin.example/file",
      "http://origin.example?token=secret",
      "http://origin.example#fragment",
      "http://origin.example/..",
      "http://origin.example\\@other.example",
      "file:///object",
    ]) {
      const options = validatedDownloadOptions(makeOptions(url));
      expect(options.domains[0].available).toBe(false);
      expect(options.selectedDomain).toBeUndefined();
    }
  });

  test("public links have no enforceable client expiry; legacy signed responses still use their timestamp", () => {
    expect(shareLinkState({ accessMode: "public", expiresAt: null }, now)).toBe(
      "public",
    );
    expect(shareLinkState({ accessMode: "public", expiresAt: past }, now)).toBe(
      "public",
    );
    expect(
      shareLinkState({ accessMode: "signed", expiresAt: future }, now),
    ).toBe("active");
    expect(shareLinkState({ accessMode: "signed", expiresAt: past }, now)).toBe(
      "expired",
    );
    expect(shareLinkState({ expiresAt: future }, now)).toBe("active");
    expect(shareLinkState({ expiresAt: past }, now)).toBe("expired");
    expect(shareLinkState({ expiresAt: null }, now)).toBe("unknown");
    expect(shareLinkState({ accessMode: "signed", expiresAt: null }, now)).toBe(
      "unknown",
    );
    expect(shareLinkState({ expiresAt: "bad-date" }, now)).toBe("unknown");
  });

  test("new share results cannot infer public access from missing expiry or accept a fake public countdown", () => {
    const publicLink: ShareRes = {
      key: "folder/file.txt",
      url: "http://public.example/folder/file.txt",
      expiresAt: null,
      accessMode: "public",
    };
    const signed: ShareRes = {
      ...publicLink,
      url: "https://origin.example/folder/file.txt?e=1793581200&token=fixture",
      expiresAt: future,
      accessMode: "signed",
    };
    expect(validatedShareResult(publicLink)).toEqual(publicLink);
    expect(validatedShareResult(signed, { nowMs: now })).toEqual(signed);
    const legacy = { ...signed, accessMode: undefined };
    expect(validatedShareResult(legacy, { nowMs: now })).toEqual(legacy);
    for (const value of [
      { ...publicLink, expiresAt: future },
      { ...publicLink, accessMode: undefined },
      { ...publicLink, accessMode: "signed" },
      { ...signed, expiresAt: "not-a-date" },
      { ...signed, expiresAt: undefined },
      { ...signed, accessMode: "PUBLIC" },
      { ...signed, url: "javascript:alert(1)" },
      { ...signed, url: "https://ak:sk@origin.example/file" },
      { ...signed, key: null },
      null,
    ])
      expect(() =>
        validatedShareResult(value as ShareRes, { nowMs: now }),
      ).toThrow();
  });

  test("generated links remain bound to the requested key, selected origin and a future signed expiry", () => {
    const signed: ShareRes = {
      key: "folder/file.txt",
      url: "https://origin.example/folder/file.txt?e=1793581200&token=fixture",
      expiresAt: future,
      accessMode: "signed",
    };
    const expected = {
      key: signed.key,
      domain: "https://origin.example",
      nowMs: now,
    };
    expect(validatedShareResult(signed, expected)).toEqual(signed);
    for (const value of [
      { ...signed, key: "folder/other.txt" },
      { ...signed, url: "https://other.example/folder/file.txt?token=fixture" },
      { ...signed, url: `${signed.url}#fragment` },
      { ...signed, expiresAt: past },
      { ...signed, expiresAt: new Date(now).toISOString() },
    ])
      expect(() => validatedShareResult(value, expected)).toThrow();
    const publicLink: ShareRes = {
      ...signed,
      url: "https://origin.example/folder/file.txt",
      accessMode: "public",
      expiresAt: null,
    };
    expect(validatedShareResult(publicLink, expected)).toEqual(publicLink);
    for (const suffix of [
      "?e=1793581200",
      "?token=fixture",
      "?%74oken=fixture",
      "#fragment",
    ])
      expect(() =>
        validatedShareResult(
          { ...publicLink, url: publicLink.url + suffix },
          expected,
        ),
      ).toThrow();
  });

  test("public HTTP download origins do not weaken public management or share-portal configuration", () => {
    for (const downloadDomain of [
      "http://files.example",
      "http://files.example:80",
      "https://files.example:443",
    ]) {
      const result = validateQiniuProfileConfig({
        mode: "public",
        downloadDomain,
      });
      expect(result.error).toBeNull();
      expect(result.insecure).toBe(downloadDomain.startsWith("http:"));
    }
    for (const config of [
      { mode: "public", ucUrl: "http://uc.qbox.me" },
      { mode: "public", sharePortal: "http://portal.qiniu.com" },
      { mode: "public", shareApiUrl: "https://api.qiniuapi.com" },
      { mode: "public", downloadDomain: "http://files.example:8080" },
      { mode: "public", downloadDomain: "https://files.example/path" },
      { mode: "public", downloadDomain: "http://ak:sk@files.example" },
    ] as const)
      expect(validateQiniuProfileConfig(config).error).toBeTruthy();
    const privateConfig = validateQiniuProfileConfig({
      mode: "private",
      ucUrl: "https://uc.internal.example",
      downloadDomain: "http://download.internal.example:8080",
    });
    expect(privateConfig.error).toBeNull();
    expect(privateConfig.insecure).toBe(true);
  });

  test("public-link results never display a countdown in either UI language", () => {
    for (const locale of ["zh-CN", "en"] as const) {
      useLocaleStore.setState({ locale });
      const html = renderToStaticMarkup(
        <ShareResult
          url="http://public.example/folder/file.txt"
          accessMode="public"
          expiresLabel="1 hour"
          showQR={false}
          onCopy={() => {}}
          onToggleQR={() => {}}
        />,
      );
      expect(html).toContain(locale === "en" ? "Public" : "公开");
      expect(html).not.toContain("Expires in");
      expect(html).not.toContain("剩余有效期");
      expect(html).not.toContain("1 hour");
      expect(html).toContain("http://public.example/folder/file.txt");
    }
  });

  test("explicit HTTP selection displays a transport warning in both languages", () => {
    for (const locale of ["zh-CN", "en"] as const) {
      useLocaleStore.setState({ locale });
      const html = renderToStaticMarkup(
        <QiniuShareDomains
          options={makeOptions("http://origin.example")}
          selectedDomain="http://origin.example"
          loading={false}
          error={null}
          disabled={false}
          onSelect={() => {}}
          onReload={() => {}}
        />,
      );
      expect(html).toContain("HTTP");
      expect(html).toContain(
        locale === "en" ? "without transport encryption" : "明文传输",
      );
      expect(html).toContain('role="status"');
    }
  });
});
