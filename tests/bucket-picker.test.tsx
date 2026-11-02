import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { connectionTestPresentation } from "../src/mainview/components/profiles/connection-test-feedback";
import {
  currentQiniuBucketChoices,
  parseQiniuBucketChoices,
  QiniuBucketPicker,
  requiresQiniuMigration,
} from "../src/mainview/components/profiles/QiniuBucketPicker";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";

afterEach(() => useLocaleStore.getState().setLocale("zh-CN"));
const response = () => ({
  success: false,
  bucketCount: 2,
  checks: [
    { name: "authentication" as const, status: "ok" as const },
    { name: "bucketAccess" as const, status: "warning" as const },
    { name: "regionDiscovery" as const, status: "ok" as const },
  ],
  buckets: [
    {
      name: "native-east",
      s3Name: "not-the-display-name",
      regionId: "z0",
      permission: "readwrite",
      secretAccessKey: "must-not-be-kept",
    },
    { name: "native-readonly", regionId: "z1", permission: "readonly" },
  ],
});

describe("Qiniu draft bucket reading", () => {
  test("authenticated account lists are usable before object access is verified", () => {
    const result = response();
    const choices = parseQiniuBucketChoices(result);
    expect(choices).toEqual([
      {
        name: "native-east",
        s3Name: "not-the-display-name",
        regionId: "z0",
        permission: "readwrite",
      },
      { name: "native-readonly", regionId: "z1", permission: "readonly" },
    ]);
    expect(JSON.stringify(choices)).not.toContain("must-not-be-kept");
    expect(connectionTestPresentation("qiniu", result).ok).toBe(false);
    expect(connectionTestPresentation("qiniu", result).tone).toBe("warning");
  });

  test("missing optional lists do not wipe out manually entered names", () => {
    const manual = "manual-native";
    expect(
      parseQiniuBucketChoices({ success: false, bucketCount: 0 }),
    ).toBeNull();
    const html = renderToStaticMarkup(
      <QiniuBucketPicker
        choices={parseQiniuBucketChoices(response())}
        value={manual}
        busy={false}
        disabled={false}
        onRead={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain(`value="${manual}" selected=""`);
    expect(html).toContain("手动填写");
    expect(html).toContain('value="native-east"');
    expect(html).not.toContain('value="not-the-display-name"');
  });

  test("reading never automatically selects the first returned bucket", () => {
    const html = renderToStaticMarkup(
      <QiniuBucketPicker
        choices={parseQiniuBucketChoices(response())}
        value=""
        busy={false}
        disabled={false}
        onRead={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain('value="" selected=""');
    expect(html).not.toContain('value="native-east" selected=""');
    expect(html).toContain("不会自动替你选中");
  });

  test("failed authentication, duplicate names and malformed lists never populate choices", () => {
    const invalid: unknown[] = [
      null,
      { ...response(), checks: [{ name: "authentication", status: "error" }] },
      { ...response(), checks: [] },
      { ...response(), buckets: [{ name: "same" }, { name: "same" }] },
      { ...response(), buckets: [{ name: "" }] },
      { ...response(), buckets: [{ name: "bucket\nsecret" }] },
      { ...response(), buckets: [{ name: "bucket", regionId: 123 }] },
      { ...response(), buckets: [{ name: "bucket", permission: "admin" }] },
      {
        ...response(),
        buckets: Array.from({ length: 10_001 }, (_, index) => ({
          name: `bucket-${index}`,
        })),
      },
    ];
    for (const value of invalid)
      expect(() => parseQiniuBucketChoices(value)).toThrow();
  });

  test("stale draft responses are dropped before parsing, including invalid late errors", () => {
    expect(currentQiniuBucketChoices(null, () => false)).toBeNull();
    let reads = 0;
    expect(
      currentQiniuBucketChoices(response(), () => ++reads === 1),
    ).toBeNull();
    expect(currentQiniuBucketChoices(response(), () => true)?.length).toBe(2);
  });

  test("an authenticated empty list remains explicit without claiming the account has no scoped buckets", () => {
    const choices = parseQiniuBucketChoices({ ...response(), buckets: [] });
    expect(choices).toEqual([]);
    const html = renderToStaticMarkup(
      <QiniuBucketPicker
        choices={choices}
        value="manual"
        busy={false}
        disabled={false}
        onRead={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain("不表示账号没有受限空间");
    expect(html).not.toContain("<select");
  });

  test("busy and disabled read controls and bilingual native-name choices are accessible", () => {
    useLocaleStore.getState().setLocale("en");
    const html = renderToStaticMarkup(
      <QiniuBucketPicker
        choices={parseQiniuBucketChoices(response())}
        value=""
        busy
        disabled={false}
        onRead={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain("Reading…");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Choose a default bucket from the retrieved list");
    expect(html).toContain("Read-only");
    expect(html).toContain('disabled=""');
  });

  test("plaintext mode and format five never request Qiniu recovery migration", () => {
    const input = {
      provider: "qiniu",
      storageMode: "encrypted" as const,
      vaultVersion: 3,
      editingQiniu: false,
      hasQiniu: false,
    };
    expect(requiresQiniuMigration(input)).toBe(true);
    expect(requiresQiniuMigration({ ...input, storageMode: "plaintext" })).toBe(
      false,
    );
    expect(requiresQiniuMigration({ ...input, vaultVersion: 5 })).toBe(false);
    expect(requiresQiniuMigration({ ...input, vaultVersion: 4 })).toBe(false);
    expect(requiresQiniuMigration({ ...input, hasQiniu: true })).toBe(false);
  });

  test("draft identity excludes default selection and includes credential/environment changes without logging secrets", () => {
    const source = readFileSync(
      "src/mainview/components/profiles/ProfileForm.tsx",
      "utf8",
    );
    const scope = source.slice(
      source.indexOf("const bucketScopeValues"),
      source.indexOf("if (", source.indexOf("const bucketScopeValues")),
    );
    expect(scope).toContain("accessKeyId");
    expect(scope).toContain("secretAccessKey");
    expect(scope).toContain("qiniuUcUrl");
    expect(scope).toContain("qiniuBindings");
    expect(scope).toContain("editProfile?.updatedAt");
    expect(scope).not.toContain("defaultBucket");
    expect(source).toContain("bucketScope.current.epoch++");
    expect(source).toContain("onSelect={setDefaultBucket}");
    expect(source).toMatch(/currentQiniuBucketChoices\(\s*result/);
  });
});
