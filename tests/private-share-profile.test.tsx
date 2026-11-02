import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  QiniuProfileSharingFields,
  qiniuSharingConfiguration,
} from "../src/mainview/components/profiles/ProfileForm";
import { validateQiniuProfileConfig } from "../src/mainview/components/profiles/providerHints";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";
import type { QiniuProfileConfig } from "../src/shared/profile.types";

const config = (): QiniuProfileConfig => ({
  mode: "private",
  ucUrl: "https://uc.internal.example",
  sharePortal: "https://portal.internal.example",
  shareApiUrl: "https://share-api.internal.example",
  regions: [{ id: "private-east", s3Endpoint: "https://s3.internal.example" }],
});

afterEach(() => useLocaleStore.getState().setLocale("zh-CN"));

describe("explicit private-share profile configuration", () => {
  test("serializes the explicit draft URL and preserves it during unrelated edits", () => {
    const draft = qiniuSharingConfiguration(
      "private",
      " https://portal.internal.example ",
      " https://share-api.internal.example ",
    );
    expect(draft).toEqual({
      sharePortal: "https://portal.internal.example",
      shareApiUrl: "https://share-api.internal.example",
    });
    expect(
      { ...config(), ...draft, downloadDomain: "https://files.example" }
        .shareApiUrl,
    ).toBe("https://share-api.internal.example");
    expect(
      qiniuSharingConfiguration(
        "private",
        "https://portal.changed.example",
        draft.shareApiUrl ?? "",
      ).shareApiUrl,
    ).toBe("https://share-api.internal.example");
  });

  test("never infers API trust or carries it to a public draft", () => {
    expect(
      qiniuSharingConfiguration("private", "https://portal.example", ""),
    ).toEqual({ sharePortal: "https://portal.example" });
    expect(
      qiniuSharingConfiguration("public", "", "https://private-api.example"),
    ).toEqual({});
    expect(
      qiniuSharingConfiguration(
        "public",
        "https://portal.qiniu.com",
        "https://private-api.example",
      ),
    ).toEqual({ sharePortal: "https://portal.qiniu.com" });
    expect(
      validateQiniuProfileConfig({
        mode: "public",
        shareApiUrl: "https://api.qiniuapi.com",
      }).error,
    ).toBeTruthy();
  });

  test("keeps legacy portal-only private accounts saveable without enabling sharing", () => {
    expect(
      validateQiniuProfileConfig({
        mode: "private",
        ucUrl: "https://uc.example",
        sharePortal: "https://portal.example",
      }),
    ).toEqual({ error: null, insecure: false });
    expect(validateQiniuProfileConfig(config()).error).toBeNull();
    expect(
      validateQiniuProfileConfig({ ...config(), sharePortal: "" }).error,
    ).toContain("分享门户");
    expect(
      validateQiniuProfileConfig({ ...config(), regions: [] }).error,
    ).toContain("手工区域");
    expect(
      validateQiniuProfileConfig({
        ...config(),
        regions: [{ id: "private-east", s3Endpoint: "" }],
      }).error,
    ).toBeTruthy();
  });

  test.each([
    "not-a-url",
    "file:///C:/secret.pem",
    "https://user:secret@api.example",
    "https://api.example/shares",
    "https://api.example/shares/..",
    "https://api.example?token=secret",
    "https://api.example#fragment",
    "https://api.example\\shares\\..",
    "https://api.\nexample",
  ])("rejects unsafe share API origin without returning its contents: %s", (shareApiUrl) => {
    const result = validateQiniuProfileConfig({ ...config(), shareApiUrl });
    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain("secret");
  });

  test("warns when only the explicitly configured share API uses plaintext HTTP", () => {
    const draft = {
      ...config(),
      shareApiUrl: "http://share-api.internal:8080",
    };
    expect(validateQiniuProfileConfig(draft)).toEqual({
      error: null,
      insecure: true,
    });
    expect(draft.shareApiUrl).toBe("http://share-api.internal:8080");
  });

  test("private sharing uses the same strict region IDs as its native S3 client", () => {
    for (const id of ["private east", "华东", "a".repeat(129), "../region"]) {
      expect(
        validateQiniuProfileConfig({
          ...config(),
          regions: [{ id, s3Endpoint: "https://s3.internal.example" }],
        }).error,
      ).toContain("区域 ID");
    }
    expect(
      validateQiniuProfileConfig({
        ...config(),
        regions: [{ id: "East_1-Private", s3Endpoint: "https://s3.example" }],
      }).error,
    ).toBeNull();
    expect(
      validateQiniuProfileConfig({
        mode: "private",
        ucUrl: "https://uc.example",
        regions: [{ id: "legacy region", s3Endpoint: "https://s3.example" }],
      }).error,
    ).toBeNull();
  });

  test("sharing fields expose explicit private API input and do not promise deployment verification", () => {
    const render = (mode: "private" | "public") =>
      renderToStaticMarkup(
        <QiniuProfileSharingFields
          mode={mode}
          portal="https://portal.example"
          apiUrl="https://share-api.example"
          onPortalChange={() => {}}
          onApiUrlChange={() => {}}
        />,
      );
    const cn = render("private");
    expect(cn).toContain('id="pf-qiniu-share-api"');
    expect(cn).toContain('value="https://share-api.example"');
    expect(cn).toContain('aria-describedby="pf-qiniu-share-api-help"');
    expect(cn).toContain("不会从 UC、门户或分享链接推断");
    expect(cn).toContain("不发送已保存的账号密钥");
    expect(cn).toContain("仍待目标部署实机验收");
    expect(render("public")).not.toContain('id="pf-qiniu-share-api"');
    expect(render("public")).not.toContain('value="https://share-api.example"');
    useLocaleStore.getState().setLocale("en");
    const en = render("private");
    expect(en).toContain("Share API origin");
    expect(en).toContain("never saved account keys");
    expect(en).toContain("deployment acceptance is still pending");
  });

  test("form shares the same config for test/save and invalidates tests on API edits", () => {
    const source = readFileSync(
      "src/mainview/components/profiles/ProfileForm.tsx",
      "utf8",
    );
    expect(source).toContain(
      "...qiniuSharingConfiguration(qiniuMode, qiniuSharePortal, qiniuShareApiUrl)",
    );
    expect(source).toMatch(
      /qiniuSharePortal,\s*qiniuShareApiUrl,\s*qiniuTrustedCaPath,/,
    );
    expect(source).toContain('if (value === "public") setQiniuShareApiUrl("")');
    expect(source).toContain("Sharing and S3 use the same CA configuration");
    expect(source.match(/qiniu: qiniuConfig/g)?.length).toBe(3);
  });
});
