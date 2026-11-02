import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { QiniuProfileCapabilityNotice } from "../src/mainview/components/profiles/ProfileForm";
import { ProfileList } from "../src/mainview/components/profiles/ProfileList";
import {
  PROVIDER_HINTS,
  validateQiniuProfileConfig,
} from "../src/mainview/components/profiles/providerHints";
import { PROVIDERS } from "../src/mainview/lib/constants";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";
import {
  PROVIDER_LABELS,
  PROVIDER_REGIONS,
  type Profile,
  toProfileInfo,
} from "../src/shared/profile.types";

afterEach(() => useLocaleStore.getState().setLocale("zh-CN"));

describe("Qiniu account configuration", () => {
  test("session scope requirements and directory-share deployment limitations are explicit", () => {
    const cnToken = renderToStaticMarkup(
      <QiniuProfileCapabilityNotice kind="session-token" />,
    );
    const cnShare = renderToStaticMarkup(
      <QiniuProfileCapabilityNotice kind="directory-share" />,
    );
    expect(cnToken).toContain("限定空间 / S3 绑定");
    expect(cnToken).toContain("保存成功不代表");
    expect(cnShare).toContain("公有云原生账号已接入目录分享创建");
    expect(cnShare).toContain("仍待目标部署实机验收");
    useLocaleStore.getState().setLocale("en");
    expect(
      renderToStaticMarkup(
        <QiniuProfileCapabilityNotice kind="session-token" />,
      ),
    ).toContain("require scoped S3 bucket bindings");
    expect(
      renderToStaticMarkup(
        <QiniuProfileCapabilityNotice kind="directory-share" />,
      ),
    ).toContain("deployment acceptance is still pending");
  });
  test("capability notices are attached while token preserve and clear branches remain unchanged", () => {
    const source = readFileSync(
      "src/mainview/components/profiles/ProfileForm.tsx",
      "utf8",
    );
    expect(source).toMatch(
      /<QiniuProfileCapabilityNotice\s+kind="session-token"/,
    );
    expect(source).toMatch(
      /<QiniuProfileCapabilityNotice\s+kind="directory-share"/,
    );
    expect(source).toMatch(
      /clearSessionToken\s*\?\s*\{\s*sessionToken:\s*null\s*\}/,
    );
    expect(source).toMatch(
      /:\s*sessionToken\.trim\(\)\s*\?\s*\{\s*sessionToken:\s*sessionToken\.trim\(\)\s*\}\s*:\s*\{\s*\}/,
    );
    expect(source).toContain("Leave blank to keep the saved token");
    expect(source).toContain('type="password"');
  });
  test("public cloud defaults do not pretend the account has one region", () => {
    expect(PROVIDER_REGIONS.qiniu).toBe("auto");
    expect(validateQiniuProfileConfig({ mode: "public" })).toEqual({
      error: null,
      insecure: false,
    });
    expect(PROVIDERS.some((provider) => provider.value === "qiniu")).toBe(true);
  });
  test("private cloud requires a UC URL, but manual regions are optional", () => {
    expect(validateQiniuProfileConfig({ mode: "private" }).error).toBeTruthy();
    expect(
      validateQiniuProfileConfig({
        mode: "private",
        ucUrl: "https://uc.internal.example",
      }).error,
    ).toBeNull();
  });
  test.each([
    "not a url",
    "file:///cert.pem",
    "https://user:secret@uc.example.com",
    "https://uc.example.com?token=secret",
    "https://uc.example.com#fragment",
  ])("rejects an unsafe endpoint shape %s", (ucUrl) => {
    expect(
      validateQiniuProfileConfig({ mode: "private", ucUrl }).error,
    ).toBeTruthy();
  });
  test("explicit private-network HTTP is warned about, never rewritten", () => {
    const config = {
      mode: "private" as const,
      ucUrl: "http://192.168.1.20:8080",
      regions: [{ id: "local", s3Endpoint: "http://s3.internal:9000" }],
    };
    expect(validateQiniuProfileConfig(config)).toEqual({
      error: null,
      insecure: true,
    });
    expect(config.ucUrl).toBe("http://192.168.1.20:8080");
    expect(
      validateQiniuProfileConfig({
        mode: "private",
        ucUrl: "HTTP://uc.internal:8080",
      }).insecure,
    ).toBe(true);
  });
  test("manual region IDs must be unique and endpoints complete", () => {
    expect(
      validateQiniuProfileConfig({
        mode: "private",
        ucUrl: "https://uc.example",
        regions: [{ id: "east", s3Endpoint: "" }],
      }).error,
    ).toBeTruthy();
    expect(
      validateQiniuProfileConfig({
        mode: "private",
        ucUrl: "https://uc.example",
        regions: [
          { id: "east", s3Endpoint: "https://s3.example" },
          { id: "east", s3Endpoint: "https://other.example" },
        ],
      }).error,
    ).toBeTruthy();
  });
  test("optional download and share endpoints receive the same URL checks", () => {
    expect(
      validateQiniuProfileConfig({
        mode: "public",
        downloadDomain: "https://files.example",
        sharePortal: "https://portal.example",
      }).error,
    ).toBeNull();
    expect(
      validateQiniuProfileConfig({
        mode: "public",
        downloadDomain: "javascript:alert(1)",
      }).error,
    ).toBeTruthy();
    expect(
      validateQiniuProfileConfig({
        mode: "public",
        sharePortal: "https://user:pass@portal.example",
      }).error,
    ).toBeTruthy();
  });
  test("ordinary profile info includes endpoint settings, never saved credentials", () => {
    const profile: Profile = {
      id: "test",
      name: "中文账号",
      provider: "qiniu",
      accessKeyId: "sensitive-access",
      secretAccessKey: "sensitive-secret",
      sessionToken: "sensitive-token",
      qiniu: {
        mode: "private",
        ucUrl: "https://uc.example",
        trustedCaPath: "C:/certs/company.pem",
      },
      createdAt: "now",
      updatedAt: "now",
    };
    const info = toProfileInfo(profile);
    expect(info.qiniu).toEqual(profile.qiniu);
    expect(JSON.stringify(info)).not.toContain("sensitive");
    expect(info.name).toBe("中文账号");
  });
  test("provider labels, hints and account rows switch immediately to English", () => {
    const profile: Profile = {
      id: "test",
      name: "中文账号",
      provider: "qiniu",
      accessKeyId: "hidden-access",
      secretAccessKey: "hidden-secret",
      createdAt: "now",
      updatedAt: "now",
    };
    const render = () =>
      renderToStaticMarkup(
        <ProfileList
          profiles={[toProfileInfo(profile)]}
          activeId="test"
          onSelect={() => {}}
          onView={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
        />,
      );
    expect(PROVIDER_LABELS.qiniu).toBe("七牛云 Kodo");
    expect(render()).toContain("七牛云 Kodo");
    useLocaleStore.getState().setLocale("en");
    expect(PROVIDER_LABELS.qiniu).toBe("Qiniu Kodo");
    expect(PROVIDER_HINTS.qiniu.region).toContain("per bucket");
    const html = render();
    expect(html).toContain("Qiniu Kodo");
    expect(html).toContain("中文账号");
    expect(html).not.toContain("hidden-secret");
  });
});
