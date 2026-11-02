// Run in its own process: bun tests/profile-session-token.regression.tsx
// Mock native IPC and clipboard only; no real credential or cloud requests run.
import { mock } from "bun:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProfileInfo } from "../src/shared/profile.types";

const requests: string[] = [];
const copied: string[] = [];
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (
    command: string,
    request: { method: string; payload: { profileId: string; field: string } },
  ) => {
    assert.equal(command, "rpc_request");
    assert.equal(request.method, "profile:credential");
    requests.push(request.payload.field);
    if (request.payload.field === "accessKeyId") return { value: "fixture-AK" };
    if (request.payload.field === "secretAccessKey")
      return { value: "fixture-SK" };
    throw new Error("An unauthorized credential field reached IPC");
  },
}));
mock.module("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
const navigatorDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator",
);
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    userAgent: "Yuncang local credential boundary test",
    platform: "Win32",
    maxTouchPoints: 0,
    clipboard: {
      writeText: async (value: string) => {
        copied.push(value);
      },
    },
  },
});
try {
  const { readCredential, copyCredential, copyAllProfileInformation } =
    await import("../src/mainview/components/profiles/profileCredentials");
  const { SessionTokenStatus } = await import(
    "../src/mainview/components/profiles/ProfileDetailsDialog"
  );
  const { useLocaleStore } = await import(
    "../src/mainview/stores/useLocaleStore"
  );
  const profile: ProfileInfo = {
    id: "fixture-profile",
    name: "中文账号",
    provider: "qiniu",
    hasSessionToken: true,
    hasR2AnalyticsToken: false,
    createdAt: "now",
    updatedAt: "now",
  };
  assert.equal(await readCredential(profile.id, "accessKeyId"), "fixture-AK");
  assert.equal(
    await readCredential(profile.id, "secretAccessKey"),
    "fixture-SK",
  );
  await copyCredential(profile, "secretAccessKey", "Secret access key");
  assert.equal(copied.at(-1), "fixture-SK");
  requests.length = 0;
  copied.length = 0;
  await copyAllProfileInformation(profile);
  assert.deepEqual(requests.sort(), ["accessKeyId", "secretAccessKey"]);
  assert.equal(copied.length, 1);
  assert.ok(copied[0].includes("fixture-AK"));
  assert.ok(copied[0].includes("fixture-SK"));
  assert.ok(!copied[0].includes("Session token:"));
  assert.ok(!copied[0].includes("会话令牌："));
  const beforeForbidden = requests.length;
  await assert.rejects(
    readCredential(
      profile.id,
      "sessionToken" as Parameters<typeof readCredential>[1],
    ),
  );
  assert.equal(
    requests.length,
    beforeForbidden,
    "forbidden token requests must be rejected before IPC",
  );
  for (const [locale, expected] of [
    ["zh-CN", ["已设置", "未设置", "未知（服务未返回状态）"]],
    [
      "en",
      [
        "Configured",
        "Not configured",
        "Unknown (the service did not return a status)",
      ],
    ],
  ] as const) {
    useLocaleStore.getState().setLocale(locale);
    for (const [index, hasSessionToken] of [true, false, undefined].entries()) {
      const html = renderToStaticMarkup(
        <SessionTokenStatus hasSessionToken={hasSessionToken} />,
      );
      assert.ok(html.includes(expected[index]));
      assert.ok(!html.includes("<input"));
      assert.ok(!html.includes("<button"));
      assert.ok(!html.includes("fixture-SK"));
    }
  }
  const source = readFileSync(
    "src/mainview/components/profiles/ProfileDetailsDialog.tsx",
    "utf8",
  );
  assert.ok(!source.includes('field="sessionToken"'));
  assert.ok(source.includes('field="secretAccessKey"'));
  assert.ok(source.includes('readCredential(profile.id, "accessKeyId")'));
  console.log(
    "PASS: AK/SK read and copy preserved; copy-all requests only AK/SK; session token denied before IPC; bilingual token status has no reveal or copy controls",
  );
} finally {
  if (navigatorDescriptor)
    Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
  else Reflect.deleteProperty(globalThis, "navigator");
}
