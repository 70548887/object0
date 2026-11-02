import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  isQiniuSharePrefixAllowed,
  normalizeQiniuSharePrefix,
  parseQiniuDirectoryShareMinutes,
  type QiniuDirectoryShareCreateInput,
  type QiniuDirectoryShareResult,
  QiniuDirectoryShareResultView,
  qiniuShareDisplayError,
  requestQiniuDirectoryShare,
  validateQiniuDirectoryShareResult,
  validateQiniuShareUrl,
} from "../src/mainview/components/qiniu/QiniuDirectoryShare";
import {
  parseQiniuShareSession,
  QiniuShareLoginFields,
  type QiniuShareSessionInfo,
  QiniuShareSessionSummary,
  requestQiniuShareSession,
} from "../src/mainview/components/qiniu/QiniuShareLogin";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";

afterEach(() => useLocaleStore.getState().setLocale("zh-CN"));
const now = Date.parse("2026-10-31T00:00:00Z");
const input: QiniuDirectoryShareCreateInput = {
  bucketName: "中文空间",
  prefix: "客户资料/",
  durationSeconds: 3600,
  readOnly: true,
};
const result: QiniuDirectoryShareResult = {
  ...input,
  url: "https://share.example.test/verify?id=example&token=example-token",
  extractionCode: "Ab12cD",
  expiresAt: new Date(now + 3600000).toISOString(),
};
const session: QiniuShareSessionInfo = {
  sessionId: "local-session-id",
  bucketName: "中文空间",
  prefix: "客户资料/",
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  readOnly: true,
};

describe("Qiniu read-only directory sharing, local-only callbacks", () => {
  test("directory boundaries do not allow sibling-prefix or traversal escape", () => {
    expect(normalizeQiniuSharePrefix("客户资料")).toBe("客户资料/");
    expect(isQiniuSharePrefixAllowed("客户资料/图像", "客户资料/")).toBe(true);
    expect(isQiniuSharePrefixAllowed("客户资料2/", "客户资料/")).toBe(false);
    expect(isQiniuSharePrefixAllowed("", "客户资料/")).toBe(false);
    for (const prefix of [
      "/absolute/",
      "客户资料/../其他/",
      "客户资料/./图像/",
      "客户资料\\其他",
      "客户资料/\0",
    ])
      expect(normalizeQiniuSharePrefix(prefix)).toBeNull();
    expect(isQiniuSharePrefixAllowed("", "")).toBe(true);
    expect(isQiniuSharePrefixAllowed("客户 +%资料/", "")).toBe(true);
  });
  test("creation accepts 15–120 whole minutes and retains the one-hour default", () => {
    expect(parseQiniuDirectoryShareMinutes("60")).toBe(60);
    expect(parseQiniuDirectoryShareMinutes("15")).toBe(15);
    expect(parseQiniuDirectoryShareMinutes("120")).toBe(120);
    for (const value of ["", "0", "14", "121", "60.5", "1e2", "-60", "NaN"])
      expect(parseQiniuDirectoryShareMinutes(value)).toBeNull();
  });
  test("backend-generated results must stay in the selected bucket, prefix and read-only scope", () => {
    expect(
      validateQiniuDirectoryShareResult(result, input, now).extractionCode,
    ).toBe("Ab12cD");
    for (const bad of [
      { ...result, bucketName: "其他空间" },
      { ...result, prefix: "其他目录/" },
      { ...result, prefix: "客户资料" },
      { ...result, readOnly: false },
      { ...result, extractionCode: "short" },
      { ...result, expiresAt: new Date(now - 1).toISOString() },
      { ...result, expiresAt: new Date(now + 7200000).toISOString() },
      null,
    ])
      expect(() =>
        validateQiniuDirectoryShareResult(bad, input, now),
      ).toThrow();
  });
  test("URL shape checks never navigate or authorize a service endpoint", () => {
    expect(validateQiniuShareUrl(result.url).valid).toBe(true);
    expect(
      validateQiniuShareUrl("HTTP://share.internal/verify?token=example")
        .insecure,
    ).toBe(true);
    for (const url of [
      "javascript:alert(1)",
      "file:///secret",
      "https://user:secret@share.example",
    ])
      expect(validateQiniuShareUrl(url).valid).toBe(false);
  });
  test("a superseded creation result is discarded, not automatically copied", async () => {
    let calls = 0;
    expect(
      await requestQiniuDirectoryShare(
        input,
        async (received) => {
          calls++;
          expect(received).toEqual(input);
          return {
            ...result,
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          };
        },
        () => false,
      ),
    ).toBeNull();
    expect(calls).toBe(1);
    await expect(
      requestQiniuDirectoryShare(
        { ...input, durationSeconds: 60 },
        async () => {
          calls++;
          return result;
        },
        () => true,
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
  test("link and code have separate explicit copy actions", () => {
    let copied = 0;
    const html = renderToStaticMarkup(
      <QiniuDirectoryShareResultView
        result={result}
        copying={false}
        onCopy={() => {
          copied++;
        }}
      />,
    );
    expect(html).toContain("复制链接");
    expect(html).toContain("复制提取码");
    expect(html).toContain("Ab12cD");
    expect(copied).toBe(0);
    useLocaleStore.getState().setLocale("en");
    expect(
      renderToStaticMarkup(
        <QiniuDirectoryShareResultView
          result={result}
          copying={false}
          onCopy={() => {
            copied++;
          }}
        />,
      ),
    ).toContain("Copy code");
    expect(copied).toBe(0);
  });
  test("share login accepts only the five noncredential session fields", () => {
    expect(parseQiniuShareSession(session)).toEqual(session);
    expect(() =>
      parseQiniuShareSession({ ...session, accessKey: "must-not-be-retained" }),
    ).toThrow();
    expect(() =>
      parseQiniuShareSession({ ...session, secretKey: "must-not-be-retained" }),
    ).toThrow();
    expect(() =>
      parseQiniuShareSession({ ...session, readOnly: false }),
    ).toThrow();
    expect(() =>
      parseQiniuShareSession({ ...session, prefix: "../outside/" }),
    ).toThrow();
    expect(() =>
      parseQiniuShareSession({ ...session, prefix: "客户资料" }),
    ).toThrow();
    expect(() =>
      parseQiniuShareSession({
        ...session,
        expiresAt: new Date(Date.now() - 1).toISOString(),
      }),
    ).toThrow();
    expect(() => parseQiniuShareSession(session, Number.NaN)).toThrow();
  });
  test("verification passes URL and case-sensitive code without storing long-term keys", async () => {
    const received: unknown[] = [];
    const discarded: string[] = [];
    const info = await requestQiniuShareSession(
      {
        url: result.url,
        extractionCode: "Ab12cD",
        privateEnvironmentId: "configured-private",
      },
      async (value) => {
        received.push(value);
        return session;
      },
      () => true,
      (id) => {
        discarded.push(id);
      },
    );
    expect(info).toEqual(session);
    expect(received).toEqual([
      {
        url: result.url,
        extractionCode: "Ab12cD",
        privateEnvironmentId: "configured-private",
      },
    ]);
    expect(discarded).toEqual([]);
  });
  test("late or invalid sessions are cleaned up instead of appearing in another scope", async () => {
    let current = true;
    let resolve: ((value: QiniuShareSessionInfo) => void) | undefined;
    const pending = new Promise<QiniuShareSessionInfo>((done) => {
      resolve = done;
    });
    const discarded: string[] = [];
    const request = requestQiniuShareSession(
      { url: result.url, extractionCode: "Ab12cD" },
      () => pending,
      () => current,
      (id) => {
        discarded.push(id);
      },
    );
    current = false;
    if (!resolve) throw new Error("Missing local resolver");
    resolve(session);
    expect(await request).toBeNull();
    expect(discarded).toEqual(["local-session-id"]);
    await expect(
      requestQiniuShareSession(
        { url: result.url, extractionCode: "Ab12cD" },
        async () =>
          ({ ...session, readOnly: false }) as unknown as QiniuShareSessionInfo,
        () => true,
        (id) => {
          discarded.push(id);
        },
      ),
    ).rejects.toThrow();
    expect(discarded).toEqual(["local-session-id", "local-session-id"]);
  });
  test("login fields hide the extraction code and keep private environment labels intact", () => {
    const html = renderToStaticMarkup(
      <QiniuShareLoginFields
        url=""
        extractionCode=""
        privateEnvironmentId="private"
        privateEnvironments={[{ id: "private", label: "客户私有云" }]}
        disabled={false}
        onUrlChange={() => {}}
        onCodeChange={() => {}}
        onEnvironmentChange={() => {}}
      />,
    );
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain("客户私有云");
    useLocaleStore.getState().setLocale("en");
    const summary = renderToStaticMarkup(
      <QiniuShareSessionSummary session={session} />,
    );
    expect(summary).toContain("Read-only");
    expect(summary).toContain("中文空间");
    expect(summary).toContain("客户资料/");
    expect(summary).not.toContain("local-session-id");
    expect(summary).not.toContain("example-token");
  });
  test("diagnostics never echo signed URLs or the user extraction code", () => {
    expect(
      qiniuShareDisplayError(new Error(`failed: ${result.url}`), "safe"),
    ).toBe("safe");
    expect(
      qiniuShareDisplayError(new Error("invalid Ab12cD"), "safe", ["Ab12cD"]),
    ).toBe("safe");
    expect(qiniuShareDisplayError(new Error("permission denied"), "safe")).toBe(
      "permission denied",
    );
    for (const file of [
      "src/mainview/components/qiniu/QiniuDirectoryShare.tsx",
      "src/mainview/components/qiniu/QiniuShareLogin.tsx",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("localStorage.");
      expect(source).not.toContain("sessionStorage.");
      expect(source).not.toContain("console.");
      expect(source).not.toContain("rpcCall(");
    }
  });
});
