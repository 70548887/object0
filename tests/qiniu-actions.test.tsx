import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  canConfirmQiniuBucketRemoval,
  isValidQiniuBucketName,
  QiniuBucketActions,
} from "../src/mainview/components/qiniu/QiniuBucketActions";
import {
  QiniuBucketDomains,
  validateQiniuDomainUrl,
} from "../src/mainview/components/qiniu/QiniuBucketDomains";
import {
  canReadQiniuObject,
  parseQiniuRestoreDays,
  QiniuObjectActions,
} from "../src/mainview/components/qiniu/QiniuObjectActions";
import {
  isQiniuCapabilityAllowed,
  type QiniuCapability,
} from "../src/mainview/components/qiniu/types";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";

const supported: QiniuCapability = { state: "supported" };
const unknown: QiniuCapability = { state: "unknown" };
let calls = 0;
const submit = async () => {
  calls++;
};
afterEach(() => {
  useLocaleStore.getState().setLocale("zh-CN");
  calls = 0;
});
describe("Qiniu action views, no RPC", () => {
  test("unknown, forbidden and unsupported capabilities never enable writes", () => {
    for (const state of ["unknown", "forbidden", "unsupported"] as const)
      expect(isQiniuCapabilityAllowed({ state })).toBe(false);
    expect(isQiniuCapabilityAllowed(supported)).toBe(true);
    const html = renderToStaticMarkup(
      <QiniuBucketActions
        scopeId="test"
        bucketName="中文空间"
        regions={[{ id: "east", label: "华东" }]}
        emptyState="unknown"
        capabilities={{
          create: unknown,
          remove: { state: "forbidden" },
          remark: { state: "unsupported" },
        }}
        onCreate={submit}
        onRemove={submit}
        onUpdateRemark={submit}
      />,
    );
    expect((html.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(html).toContain("删除已禁用");
    expect(html).toContain("没有此操作权限");
    expect(html).toContain("不支持此操作");
    expect(calls).toBe(0);
  });
  test("bucket-name validation enforces native constraints without altering names", () => {
    for (const name of ["abc", "bucket-01", "a".repeat(63)])
      expect(isValidQiniuBucketName(name)).toBe(true);
    for (const name of [
      "ab",
      "ABC",
      "-abc",
      "abc-",
      "a_b",
      "中文空间",
      "a".repeat(64),
    ])
      expect(isValidQiniuBucketName(name)).toBe(false);
  });
  test("deletion requires one exact name, confirmed emptiness and permission", () => {
    expect(
      canConfirmQiniuBucketRemoval({
        bucketName: "one-bucket",
        confirmation: "one-bucket",
        emptyState: "empty",
        capability: supported,
      }),
    ).toBe(true);
    expect(
      canConfirmQiniuBucketRemoval({
        bucketName: "one-bucket",
        confirmation: " one-bucket ",
        emptyState: "empty",
        capability: supported,
      }),
    ).toBe(false);
    expect(
      canConfirmQiniuBucketRemoval({
        bucketName: "one-bucket",
        confirmation: "one-bucket",
        emptyState: "unknown",
        capability: supported,
      }),
    ).toBe(false);
    expect(
      canConfirmQiniuBucketRemoval({
        bucketName: "one-bucket",
        confirmation: "one-bucket",
        emptyState: "empty",
        capability: unknown,
      }),
    ).toBe(false);
    expect(
      canConfirmQiniuBucketRemoval({
        bucketName: undefined,
        confirmation: "",
        emptyState: "empty",
        capability: supported,
      }),
    ).toBe(false);
  });
  test("non-empty bucket deletion stays disabled while other permitted actions remain visible", () => {
    const html = renderToStaticMarkup(
      <QiniuBucketActions
        scopeId="test"
        bucketName="bucket"
        regions={[{ id: "east", label: "华东" }]}
        emptyState="not-empty"
        capabilities={{
          create: supported,
          remove: supported,
          remark: supported,
        }}
        onCreate={submit}
        onRemove={submit}
        onUpdateRemark={submit}
      />,
    );
    expect(html).toContain("空间非空");
    expect(html).toContain('disabled=""');
    expect(calls).toBe(0);
  });
  test("restore allows only whole days from one to seven", () => {
    for (const days of ["1", "7", " 3 "])
      expect(parseQiniuRestoreDays(days)).toBe(Number(days));
    for (const days of ["", "0", "8", "1.5", "1e0", "-1", "01", "NaN"])
      expect(parseQiniuRestoreDays(days)).toBeNull();
    expect(canReadQiniuObject("normal")).toBe(true);
    expect(canReadQiniuObject("restored")).toBe(true);
    for (const state of [
      "frozen",
      "restoring",
      "expired",
      "unknown",
      "mixed",
    ] as const)
      expect(canReadQiniuObject(state)).toBe(false);
  });
  test("a restoring object does not offer repeat restoration or type conversion", () => {
    const html = renderToStaticMarkup(
      <QiniuObjectActions
        scopeId="test"
        objectKeys={["中文文件.exe"]}
        currentStorageClass="archive"
        restoreState="restoring"
        storageClasses={[{ id: "archive", label: "归档", available: true }]}
        capabilities={{ changeType: supported, restore: supported }}
        onChangeStorageClass={submit}
        onRestore={submit}
      />,
    );
    expect(html).toContain("解冻中");
    expect((html.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(calls).toBe(0);
  });
  test("domain selection is read-only configuration and preserves original URL text", () => {
    const html = renderToStaticMarkup(
      <QiniuBucketDomains
        capability={supported}
        domains={[
          {
            id: "origin",
            url: "https://files.example.com",
            kind: "origin",
            available: true,
          },
          {
            id: "expired",
            url: "https://expired.example.com",
            kind: "cdn",
            available: true,
            expiresAt: "2000-01-01T00:00:00Z",
          },
          {
            id: "invalid",
            url: "javascript:alert(1)",
            kind: "custom",
            available: true,
          },
        ]}
        onSelect={() => {
          calls++;
        }}
      />,
    );
    expect(html).toContain("https://files.example.com");
    expect(html).toContain("已过期");
    expect(html).toContain("地址格式无效");
    expect(calls).toBe(0);
    expect(
      validateQiniuDomainUrl("https://user:pass@files.example.com").valid,
    ).toBe(false);
    expect(
      validateQiniuDomainUrl("https://files.example.com?token=secret").valid,
    ).toBe(false);
    expect(validateQiniuDomainUrl("HTTP://files.example.com").insecure).toBe(
      true,
    );
  });
  test("the same object view switches language without translating object keys", () => {
    useLocaleStore.getState().setLocale("en");
    const html = renderToStaticMarkup(
      <QiniuObjectActions
        scopeId="test"
        objectKeys={["中文文件.exe"]}
        currentStorageClass="archive"
        restoreState="frozen"
        storageClasses={[{ id: "archive", label: "Archive", available: true }]}
        capabilities={{ changeType: unknown, restore: unknown }}
        onChangeStorageClass={submit}
        onRestore={submit}
      />,
    );
    expect(html).toContain("Frozen");
    expect(html).toContain("Change storage type");
    expect(html).toContain("not confirmed");
    expect(calls).toBe(0);
  });
});
