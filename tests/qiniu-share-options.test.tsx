import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QiniuShareDomains } from "../src/mainview/components/share/QiniuShareDomains";
import {
  isSelectedDomainAvailable,
  localizeDownloadHint,
  NATIVE_APPLICATION_SHARE_MAX_SECONDS,
  ShareRequestGuard,
  safeDownloadFileName,
  sharingProtocol,
  validatedDownloadOptions,
} from "../src/mainview/components/share/qiniu-share-options";
import { ShareExpirationFields } from "../src/mainview/components/share/ShareExpirationFields";
import {
  DEFAULT_SHARE_MAX_SECONDS,
  expirationMaxValues,
  parseCustomExpiration,
} from "../src/mainview/components/share/share-expiration";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";
import type { ProfileInfo } from "../src/shared/profile.types";
import type { QiniuDownloadOptions } from "../src/shared/qiniu.types";

afterEach(() => useLocaleStore.setState({ locale: "zh-CN" }));
const profile: ProfileInfo = {
  id: "p",
  name: "Fixture",
  provider: "qiniu",
  hasR2AnalyticsToken: false,
  hasSessionToken: false,
  qiniu: { mode: "public" },
  createdAt: "1",
  updatedAt: "1",
};
const options = (): QiniuDownloadOptions => ({
  domains: [
    { url: "https://origin.example", kind: "origin", available: true },
    {
      url: "https://cdn.example",
      kind: "cdn",
      available: false,
      reason: "原生签名尚未确认 / Native signatures are unverified",
    },
  ],
  maxShareSeconds: NATIVE_APPLICATION_SHARE_MAX_SECONDS,
  policyNote:
    "应用上限不是服务承诺 / The application cap is not a service guarantee",
});

describe("provider-specific sharing options", () => {
  test("only known public primary credentials without explicit S3 binding use native domain discovery", () => {
    expect(sharingProtocol(profile)).toBe("native");
    expect(sharingProtocol({ ...profile, provider: "r2" })).toBe("s3");
    expect(sharingProtocol({ ...profile, hasSessionToken: true })).toBe("s3");
    expect(sharingProtocol({ ...profile, qiniu: { mode: "private" } })).toBe(
      "s3",
    );
    expect(
      sharingProtocol({
        ...profile,
        qiniu: {
          mode: "public",
          bucketBindings: [
            {
              nativeName: "name",
              s3Name: "alias",
              s3Endpoint: "https://s3.example",
              s3RegionId: "region",
            },
          ],
        },
      }),
    ).toBe("s3");
    expect(sharingProtocol({ ...profile, hasSessionToken: undefined })).toBe(
      "unknown",
    );
    expect(sharingProtocol(undefined)).toBe("unknown");
  });

  test("available discovery is not an automatic domain selection", () => {
    const value = validatedDownloadOptions(options());
    expect(value.selectedDomain).toBeUndefined();
    expect(isSelectedDomainAvailable(value, "")).toBe(false);
    expect(isSelectedDomainAvailable(value, "https://origin.example")).toBe(
      true,
    );
    expect(isSelectedDomainAvailable(value, "https://cdn.example")).toBe(false);
  });

  test("only an available server-provided configured selection is the default", () => {
    expect(
      validatedDownloadOptions({
        ...options(),
        selectedDomain: "https://origin.example",
      }).selectedDomain,
    ).toBe("https://origin.example");
    expect(
      validatedDownloadOptions({
        ...options(),
        selectedDomain: "https://cdn.example",
      }).selectedDomain,
    ).toBeUndefined();
    expect(
      validatedDownloadOptions({
        ...options(),
        selectedDomain: "https://unlisted.example",
      }).selectedDomain,
    ).toBeUndefined();
  });

  test("malformed, overbroad and duplicate option responses are rejected", () => {
    for (const maxShareSeconds of [NaN, Infinity, 0, -1, 1.5, 2592001])
      expect(() =>
        validatedDownloadOptions({ ...options(), maxShareSeconds }),
      ).toThrow();
    expect(() =>
      validatedDownloadOptions({
        ...options(),
        domains: [options().domains[0], options().domains[0]],
      }),
    ).toThrow();
    expect(() =>
      validatedDownloadOptions({ ...options(), policyNote: "x".repeat(4097) }),
    ).toThrow();
  });

  test("unsafe public origins stay unselectable even when a future backend incorrectly labels them available", () => {
    for (const url of [
      "https://ak:sk@origin.example",
      "https://origin.example/path",
      "https://origin.example?token=x",
      "https://origin.example#x",
      "https://origin.example:8443",
      "https://origin.example/..",
      "javascript:alert(1)",
    ]) {
      const value = validatedDownloadOptions({
        ...options(),
        selectedDomain: url,
        domains: [{ url, kind: "configured", available: true }],
      });
      expect(value.domains[0].available).toBe(false);
      expect(value.selectedDomain).toBeUndefined();
    }
  });

  test("native custom expiration can exceed seven days without changing S3 defaults", () => {
    expect(parseCustomExpiration("8", "days").seconds).toBeNull();
    expect(
      parseCustomExpiration("8", "days", NATIVE_APPLICATION_SHARE_MAX_SECONDS)
        .seconds,
    ).toBe(8 * 86400);
    expect(
      parseCustomExpiration("30", "days", NATIVE_APPLICATION_SHARE_MAX_SECONDS)
        .seconds,
    ).toBe(2592000);
    expect(
      parseCustomExpiration("31", "days", NATIVE_APPLICATION_SHARE_MAX_SECONDS)
        .seconds,
    ).toBeNull();
    expect(expirationMaxValues(NATIVE_APPLICATION_SHARE_MAX_SECONDS)).toEqual({
      minutes: 43200,
      hours: 720,
      days: 30,
    });
    expect(DEFAULT_SHARE_MAX_SECONDS).toBe(604800);
    expect(parseCustomExpiration("1", "hours", NaN).seconds).toBeNull();
  });

  test("custom numeric limits and explanatory text label the native cap as application policy", () => {
    const props = {
      mode: "custom" as const,
      onModeChange: () => {},
      selectedPreset: 0,
      onPresetChange: () => {},
      customValue: "8",
      onCustomValueChange: () => {},
      customUnit: "days" as const,
      onCustomUnitChange: () => {},
      disabled: false,
      error: null,
    };
    const html = renderToStaticMarkup(
      <ShareExpirationFields
        {...props}
        maxSeconds={2592000}
        applicationLimit
      />,
    );
    expect(html).toContain('max="30"');
    expect(html).toContain("不是服务商上限");
    useLocaleStore.setState({ locale: "en" });
    const english = renderToStaticMarkup(
      <ShareExpirationFields
        {...props}
        maxSeconds={2592000}
        applicationLimit
      />,
    );
    expect(english).toContain(
      "Application safety cap: 30 days (not a provider limit)",
    );
    expect(english).toContain("access is not guaranteed");
    expect(
      renderToStaticMarkup(<ShareExpirationFields {...props} />),
    ).toContain('max="7"');
  });

  test("file download basenames reject Windows paths, devices and normalization aliases", () => {
    expect(safeDownloadFileName("folder/中文 +%.txt")).toBe("中文 +%.txt");
    expect(safeDownloadFileName("folder/file.txt")).toBe("file.txt");
    for (const key of [
      "",
      "folder/",
      "folder/..",
      "folder/.",
      "folder/C:secret",
      "folder/..\\secret",
      "folder/CON",
      "folder/con.txt",
      "folder/AUX.bin",
      "folder/LPT9",
      "folder/trailing.",
      "folder/trailing ",
      "folder/a?b",
      "folder/a\u0000b",
    ])
      expect(safeDownloadFileName(key)).toBeNull();
  });

  test("scope guard rejects late options and signing responses after account revision, key or domain changes", () => {
    const guard = new ShareRequestGuard();
    guard.bind("account/rev1/bucket/key/domain-a");
    const old = guard.begin();
    expect(guard.isCurrent(old)).toBe(true);
    guard.bind("account/rev2/bucket/key/domain-a");
    expect(guard.isCurrent(old)).toBe(false);
    const next = guard.begin();
    guard.bind("account/rev2/bucket/other/domain-a");
    expect(guard.isCurrent(next)).toBe(false);
    const domain = guard.begin();
    guard.bind("account/rev2/bucket/other/domain-b");
    expect(guard.isCurrent(domain)).toBe(false);
    const closing = guard.begin();
    guard.invalidate();
    expect(guard.isCurrent(closing)).toBe(false);
    const current = guard.begin();
    guard.finish(old);
    expect(guard.isCurrent(current)).toBe(true);
    guard.finish(current);
    expect(guard.pending).toBe(false);
  });

  test("domain selection shows unavailable reasons and allows clearing the default", () => {
    const html = renderToStaticMarkup(
      <QiniuShareDomains
        options={options()}
        loading={false}
        error={null}
        selectedDomain=""
        disabled={false}
        onSelect={() => {}}
        onReload={() => {}}
      />,
    );
    expect(html).toContain("不选择域名");
    expect(html).toContain("https://origin.example");
    expect(html).toContain("https://cdn.example");
    expect(html).toContain("disabled");
    expect(html).toContain("原生签名尚未确认");
    useLocaleStore.setState({ locale: "en" });
    expect(
      renderToStaticMarkup(
        <QiniuShareDomains
          options={options()}
          loading={false}
          error={null}
          selectedDomain=""
          disabled={false}
          onSelect={() => {}}
          onReload={() => {}}
        />,
      ),
    ).toContain("Native signatures are unverified");
  });

  test("loading and error states do not render an empty trusted selection", () => {
    const loading = renderToStaticMarkup(
      <QiniuShareDomains
        options={null}
        loading
        error={null}
        selectedDomain=""
        disabled={false}
        onSelect={() => {}}
        onReload={() => {}}
      />,
    );
    expect(loading).toContain('role="status"');
    const failure = renderToStaticMarkup(
      <QiniuShareDomains
        options={null}
        loading={false}
        error="无法读取域名 / Could not read domains"
        selectedDomain=""
        disabled={false}
        onSelect={() => {}}
        onReload={() => {}}
      />,
    );
    expect(failure).toContain('role="alert"');
    expect(failure).toContain("重新读取");
    expect(localizeDownloadHint("Object/key/目录")).toBe("Object/key/目录");
  });
});
