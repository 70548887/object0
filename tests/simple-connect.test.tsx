import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  isSavedQuickConnectionCurrent,
  QuickConnectFields,
  quickConnectionError,
  requestQuickConnection,
  validateQuickConnection,
} from "../src/mainview/components/profiles/QiniuQuickConnect";
import { LegacyImportFields } from "../src/mainview/components/vault/LegacyImport";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";
import { legacyImportError } from "../src/mainview/stores/useVaultStore";
import type { RPCSchema } from "../src/shared/rpc-schema";

afterEach(() => useLocaleStore.getState().setLocale("zh-CN"));
const response: RPCSchema["profile:connect-qiniu"]["res"] = {
  accountConnected: true,
  bucketReadsVerified: false,
  downloadVerified: false,
  profile: {
    id: "new-profile",
    name: "七牛账号 1",
    provider: "qiniu",
    createdAt: "t",
    updatedAt: "revision-1",
    hasR2AnalyticsToken: false,
    hasSessionToken: false,
    qiniu: { mode: "public" },
  },
  buckets: [{ name: "native-name", s3Name: "s3-alias" }],
};
test("ordinary Qiniu fields are AK/SK only; migration, domains and buckets are not required", () => {
  for (const locale of ["zh-CN", "en"] as const) {
    useLocaleStore.getState().setLocale(locale);
    const html = renderToStaticMarkup(
      <QuickConnectFields
        accessKeyId=""
        secretAccessKey=""
        busy={false}
        onAccessKey={() => {}}
        onSecretKey={() => {}}
      />,
    );
    expect((html.match(/<input/g) ?? []).length).toBe(2);
    expect(html).toContain("AccessKey");
    expect(html).toContain("SecretKey");
    expect(html).toContain('type="password"');
    expect(html).not.toContain("恢复密钥输入");
    expect(html).not.toContain("my-bucket");
    expect(html).not.toContain("S3 ID");
    expect(html).not.toContain("uc.example");
  }
});
test("one request accepts an authenticated empty bucket list without claiming bucket/download verification", async () => {
  let calls = 0;
  const input = {
    requestId: "request-1",
    accessKeyId: "fixture-ak",
    secretAccessKey: "fixture-sk",
  };
  const result = await requestQuickConnection(
    input,
    async () => {
      calls++;
      return { ...response, buckets: [] };
    },
    () => true,
  );
  expect(calls).toBe(1);
  expect(result?.accountConnected).toBe(true);
  expect(result?.buckets).toEqual([]);
  expect(result?.bucketReadsVerified).toBe(false);
  expect(result?.downloadVerified).toBe(false);
});
test("stale/closed connect results are not adopted and failures never become an account", async () => {
  let current = true;
  const input = {
    requestId: "request-1",
    accessKeyId: "fixture-ak",
    secretAccessKey: "fixture-sk",
  };
  expect(
    await requestQuickConnection(
      input,
      async () => {
        current = false;
        return response;
      },
      () => current,
    ),
  ).toBeNull();
  await expect(
    requestQuickConnection(
      input,
      async () => {
        throw new Error("fixed-network");
      },
      () => true,
    ),
  ).rejects.toThrow("fixed-network");
  let calls = 0;
  expect(
    await requestQuickConnection(
      { ...input, secretAccessKey: "" },
      async () => {
        calls++;
        return response;
      },
      () => true,
    ),
  ).toBeNull();
  expect(calls).toBe(0);
});
test("quick response validation preserves native names and rejects false/duplicate/malformed account results", () => {
  expect(validateQuickConnection(response).buckets[0].name).toBe("native-name");
  expect(() =>
    validateQuickConnection({
      ...response,
      buckets: [{ name: "a" }, { name: "a" }],
    }),
  ).toThrow();
  expect(() =>
    validateQuickConnection({
      ...response,
      accountConnected: false,
    } as unknown as typeof response),
  ).toThrow();
  const widened = {
    ...response,
    profile: { ...response.profile, secretAccessKey: "should-not-retain" },
    buckets: [{ name: "native-name", accessKeyId: "should-not-retain" }],
  };
  expect(JSON.stringify(validateQuickConnection(widened))).not.toContain(
    "should-not-retain",
  );
});
test("legacy import is optional and only asks the original passphrase, not a recovery key", () => {
  const html = renderToStaticMarkup(<LegacyImportFields allowSkip />);
  expect(html).toContain("暂不导入，直接使用");
  expect(html).toContain("原云仓密码（仅用于导入）");
  expect((html.match(/<input/g) ?? []).length).toBe(1);
  expect(html).not.toContain("创建密码");
  const app = readFileSync("src/mainview/app/App.tsx", "utf8");
  expect(app).not.toContain("<SetupScreen");
  expect(app).not.toContain("<UnlockScreen");
  expect(app).toContain("<LocalAccountsStartScreen");
});

test("connection errors distinguish rejection, permission, network, timeout and disk without echoing raw secrets", () => {
  const cases = [
    ["七牛请求被拒绝 [permission-denied] (HTTP 401)", "认证被拒绝"],
    ["七牛请求被拒绝 [permission-denied] (HTTP 403)", "空间列表权限"],
    ["安全错误 [connection-failed]", "代理及证书"],
    ["安全错误 [transport-failed]", "代理及证书"],
    ["安全错误 [timeout]", "连接超时"],
    [
      "无法安全保存本地明文账号文件，原文件未替换 / Could not safely save local plaintext accounts; the original file was not replaced",
      "目录写入权限",
    ],
    [
      "本地账号库已变化，请重新连接 / Local account store changed; connect again",
      "旧请求不会继续保存",
    ],
  ];
  for (const [raw, expected] of cases)
    expect(quickConnectionError(new Error(raw))).toContain(expected);
  const safe = quickConnectionError(
    new Error(
      "unsafe fixture-ak fixture-sk https://private.invalid/?token=secret",
    ),
  );
  expect(safe).toContain("账号可能已保存");
  expect(safe).not.toContain("fixture-ak");
  expect(safe).not.toContain("private.invalid");
  expect(quickConnectionError(new Error("anything"), true)).toContain(
    "不要重复新增",
  );
  useLocaleStore.getState().setLocale("en");
  expect(quickConnectionError(new Error("error (HTTP 403)"))).toContain(
    "Advanced settings",
  );
});

test("post-save adoption requires the profile still present with the saved revision", () => {
  expect(isSavedQuickConnectionCurrent(response, [response.profile])).toBe(
    true,
  );
  expect(isSavedQuickConnectionCurrent(response, [])).toBe(false);
  expect(
    isSavedQuickConnectionCurrent(response, [
      { ...response.profile, updatedAt: "changed" },
    ]),
  ).toBe(false);
  expect(
    isSavedQuickConnectionCurrent(response, [
      { ...response.profile, provider: "r2" },
    ]),
  ).toBe(false);
});

test("legacy import distinguishes password, account and transfer identity conflicts without raw input echoes", () => {
  expect(
    legacyImportError(
      "旧账号库密码验证失败，未导入或更改任何账号 / Legacy passphrase verification failed; no account was imported or changed",
    ),
  ).toContain("原云仓密码验证失败");
  expect(
    legacyImportError(
      "旧账号与本地账号 ID 冲突，未覆盖任何账号 / Legacy and local account IDs conflict; no account was overwritten",
    ),
  ).toContain("不是密码错误");
  expect(
    legacyImportError(
      "新旧传输密钥不同，未导入以避免丢失任务恢复身份 / Transfer keys differ; import was stopped to preserve resumable-task identities",
    ),
  ).toContain("传输任务身份不同");
  const unknown = legacyImportError(
    new Error("raw synthetic-password C:/secret-path token"),
  );
  expect(unknown).toContain("可能已经导入");
  expect(unknown).not.toContain("synthetic-password");
  expect(unknown).not.toContain("secret-path");
});
