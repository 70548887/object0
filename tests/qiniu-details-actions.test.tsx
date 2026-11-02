import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  QiniuMutationResults,
  qiniuDetailsCapability,
  qiniuDetailsRestoreState,
  qiniuDetailsStorageClasses,
  refreshSuccessfulQiniuResults,
  submitQiniuDetailsMutation,
} from "../src/mainview/components/qiniu/QiniuDetailsActions";
import { QiniuObjectActions } from "../src/mainview/components/qiniu/QiniuObjectActions";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";
import type {
  QiniuBucketContext,
  QiniuMutationResult,
} from "../src/shared/qiniu.types";

afterEach(() => useLocaleStore.getState().setLocale("zh-CN"));
const context: QiniuBucketContext = {
  bucket: { name: "中文空间", permission: "readwrite" },
  backendMode: "kodo",
  region: {
    s3RegionId: "east",
    s3Urls: [],
    rsUrls: ["https://rs.example.test"],
    storageClasses: [
      { fileType: 0, kodoName: "Standard" },
      { fileType: 2, kodoName: "Archive" },
      { fileType: 2, kodoName: "Duplicate" },
      { fileType: 255, kodoName: "Future provider type" },
    ],
    expiresAt: 9999999999,
  },
};
const normal = {
  size: 1,
  etag: "opaque",
  lastModified: "2026-01-01",
  type: "text/plain",
  storageType: 0,
};

describe("Qiniu details action integration without cloud requests", () => {
  test("capabilities distinguish protocol support, permission and unknown state", () => {
    expect(qiniuDetailsCapability(null).state).toBe("unknown");
    expect(qiniuDetailsCapability(context).state).toBe("supported");
    expect(
      qiniuDetailsCapability({
        ...context,
        bucket: { name: "中文空间", permission: "readonly" },
      }).state,
    ).toBe("forbidden");
    expect(
      qiniuDetailsCapability({ ...context, backendMode: "s3" }).state,
    ).toBe("unsupported");
    expect(
      qiniuDetailsCapability({
        ...context,
        region: { ...context.region, rsUrls: [] },
      }).state,
    ).toBe("unsupported");
    const unknown = qiniuDetailsCapability({
      ...context,
      bucket: { name: "中文空间" },
    });
    expect(unknown.state).toBe("unknown");
    expect(unknown.reason).toContain("由服务端验证");
  });
  test("an explicit unknown-permission attempt never rewrites the capability", () => {
    const capability = qiniuDetailsCapability({
      ...context,
      bucket: { name: "中文空间" },
    });
    const render = (allow: boolean) =>
      renderToStaticMarkup(
        <QiniuObjectActions
          scopeId="test"
          objectKeys={["中文文件.txt"]}
          currentStorageClass="0"
          restoreState="normal"
          storageClasses={qiniuDetailsStorageClasses(context)}
          capabilities={{ changeType: capability, restore: capability }}
          allowUnknownPermissionAttempt={allow}
          onChangeStorageClass={async () => {}}
          onRestore={async () => {}}
        />,
      );
    const guarded = render(false);
    const attempt = render(true);
    expect((guarded.match(/disabled=""/g) ?? []).length).toBeGreaterThan(
      (attempt.match(/disabled=""/g) ?? []).length,
    );
    expect(attempt).toContain("权限未确认");
    expect(capability.state).toBe("unknown");
  });
  test("storage choices use dynamic unique fileType IDs, and restore state follows stat", () => {
    expect(qiniuDetailsStorageClasses(context).map((item) => item.id)).toEqual([
      "0",
      "2",
      "255",
    ]);
    expect(qiniuDetailsStorageClasses(context)[2].label).toBe(
      "Future provider type",
    );
    expect(qiniuDetailsRestoreState(normal)).toBe("normal");
    expect(qiniuDetailsRestoreState({ ...normal, storageType: 2 })).toBe(
      "frozen",
    );
    expect(
      qiniuDetailsRestoreState({ ...normal, storageType: 3, restoreStatus: 1 }),
    ).toBe("restoring");
    expect(
      qiniuDetailsRestoreState({ ...normal, storageType: 2, restoreStatus: 2 }),
    ).toBe("restored");
    expect(
      qiniuDetailsRestoreState({
        ...normal,
        storageType: 2,
        restoreStatus: 99,
      }),
    ).toBe("unknown");
  });
  test("typed mutation sends exact object keys and explicit cost confirmation", async () => {
    const calls: unknown[] = [];
    const results = await submitQiniuDetailsMutation(
      {
        profileId: "profile",
        expectedProfileRevision: "revision-1",
        bucket: "中文空间",
        keys: ["文件 +%.txt", "文件 +%.txt"],
        operation: "restore",
        value: 7,
        costConfirmed: true,
      },
      async (method, payload) => {
        calls.push([method, payload]);
        return { results: [{ key: "文件 +%.txt", success: true }] };
      },
    );
    expect(calls).toEqual([
      [
        "qiniu:object-restore",
        {
          profileId: "profile",
          expectedProfileRevision: "revision-1",
          bucket: "中文空间",
          keys: ["文件 +%.txt"],
          value: 7,
          costConfirmed: true,
        },
      ],
    ]);
    expect(results[0].success).toBe(true);
    let called = false;
    await expect(
      submitQiniuDetailsMutation(
        {
          profileId: "profile",
          expectedProfileRevision: "revision-1",
          bucket: "bucket",
          keys: ["file"],
          operation: "restore",
          value: 8,
          costConfirmed: true,
        },
        async () => {
          called = true;
          return { results: [] };
        },
      ),
    ).rejects.toThrow();
    await expect(
      submitQiniuDetailsMutation(
        {
          profileId: "profile",
          expectedProfileRevision: "revision-1",
          bucket: "bucket",
          keys: ["file"],
          operation: "type",
          value: 1,
          costConfirmed: false,
        },
        async () => {
          called = true;
          return { results: [] };
        },
      ),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });
  test("unexpected response objects are rejected rather than reported as success", async () => {
    await expect(
      submitQiniuDetailsMutation(
        {
          profileId: "profile",
          expectedProfileRevision: "revision-1",
          bucket: "bucket",
          keys: ["wanted"],
          operation: "type",
          value: 1,
          costConfirmed: true,
        },
        async () => ({
          results: [{ key: "other-account-object", success: true }],
        }),
      ),
    ).rejects.toThrow();
  });
  test("failed or superseded results do not refresh another selection", async () => {
    let refreshed = 0;
    const run = () => {
      refreshed++;
    };
    await refreshSuccessfulQiniuResults(
      [{ key: "file", success: false, error: "denied" }],
      () => true,
      [run, run, run],
    );
    await refreshSuccessfulQiniuResults(
      [{ key: "file", success: true }],
      () => false,
      [run, run, run],
    );
    expect(refreshed).toBe(0);
    let current = true;
    await refreshSuccessfulQiniuResults(
      [{ key: "file", success: true }],
      () => current,
      [
        () => {
          refreshed++;
          current = false;
        },
        run,
        run,
      ],
    );
    expect(refreshed).toBe(1);
  });
  test("partial success refreshes once and preserves individual failure feedback", async () => {
    const results: QiniuMutationResult[] = [
      { key: "已受理的中文文件", success: true },
      { key: "失败文件", success: false, error: "permission denied" },
    ];
    let refreshed = 0;
    const warnings = await refreshSuccessfulQiniuResults(results, () => true, [
      () => {
        refreshed++;
      },
      () => {
        throw new Error("refresh failed");
      },
      () => {
        refreshed++;
      },
    ]);
    expect(refreshed).toBe(2);
    expect(warnings).toEqual(["refresh failed"]);
    const html = renderToStaticMarkup(
      <QiniuMutationResults
        operation="restore"
        results={results}
        refreshWarnings={warnings}
      />,
    );
    expect(html).toContain("成功 1 项，失败 1 项");
    expect(html).toContain("permission denied");
    expect(html).toContain("不表示文件已可读取");
    expect(html).toContain("已受理的中文文件");
    useLocaleStore.getState().setLocale("en");
    const en = renderToStaticMarkup(
      <QiniuMutationResults operation="restore" results={results} />,
    );
    expect(en).toContain("1 succeeded; 1 failed");
    expect(en).toContain("已受理的中文文件");
    expect(en).toContain("permission denied");
  });
});
