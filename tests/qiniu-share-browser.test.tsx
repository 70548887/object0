import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  parseQiniuSharePage,
  QiniuShareFileList,
  qiniuShareBreadcrumbs,
  requestQiniuSharePage,
} from "../src/mainview/components/qiniu/QiniuShareBrowser";
import {
  canCreateQiniuDirectoryShare,
  isCurrentQiniuShareTarget,
} from "../src/mainview/components/qiniu/qiniu-share-scope";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";
import type { ProfileInfo } from "../src/shared/profile.types";
import type { QiniuShareSessionInfo } from "../src/shared/qiniu.types";

afterEach(() => useLocaleStore.getState().setLocale("zh-CN"));
const now = Date.now();
const session: QiniuShareSessionInfo = {
  sessionId: "fixture-session",
  bucketName: "空间",
  prefix: "分享/",
  expiresAt: new Date(now + 3600000).toISOString(),
  readOnly: true,
};
const page = {
  objects: [
    {
      key: "分享/中文 +%?#.txt",
      size: 123,
      lastModified: new Date(now).toISOString(),
    },
  ],
  prefixes: ["分享/图片/"],
  isTruncated: true,
  nextCursor: "opaque-not-a-file-name",
};
const profile: ProfileInfo = {
  id: "p",
  name: "fixture",
  provider: "qiniu",
  qiniu: { mode: "public" },
  hasSessionToken: false,
  hasR2AnalyticsToken: false,
  createdAt: "a",
  updatedAt: "revision1",
};
const target = {
  profileId: "p",
  profileRevision: "revision1",
  bucketName: "bucket",
  prefix: "分享/",
};

describe("reachable Qiniu directory-share browsing", () => {
  test("creation is only available for known permanent public native identities", () => {
    expect(canCreateQiniuDirectoryShare(profile)).toBe(true);
    for (const changed of [
      { ...profile, provider: "r2" as const },
      { ...profile, hasSessionToken: true },
      { ...profile, hasSessionToken: undefined },
      { ...profile, qiniu: undefined },
      { ...profile, qiniu: { mode: "private" as const } },
      {
        ...profile,
        qiniu: {
          mode: "public" as const,
          bucketBindings: [
            {
              nativeName: "bucket",
              s3Name: "id",
              s3RegionId: "z0",
              s3Endpoint: "https://fixture.invalid",
            },
          ],
        },
      },
    ])
      expect(canCreateQiniuDirectoryShare(changed)).toBe(false);
  });
  test("creation target is bound to revision, bucket and literal directory", () => {
    expect(isCurrentQiniuShareTarget(target, profile, "bucket", "分享/")).toBe(
      true,
    );
    expect(
      isCurrentQiniuShareTarget(
        target,
        { ...profile, updatedAt: "revision2" },
        "bucket",
        "分享/",
      ),
    ).toBe(false);
    expect(
      isCurrentQiniuShareTarget(
        target,
        { ...profile, id: "other" },
        "bucket",
        "分享/",
      ),
    ).toBe(false);
    expect(isCurrentQiniuShareTarget(target, profile, "other", "分享/")).toBe(
      false,
    );
    expect(
      isCurrentQiniuShareTarget(target, profile, "bucket", "分享/图/"),
    ).toBe(false);
  });
  test("opaque page data is rebuilt without unexpected fields or credentials", () => {
    const parsed = parseQiniuSharePage(
      {
        ...page,
        accessKey: "not-retained",
        objects: [{ ...page.objects[0], secretKey: "not-retained" }],
      },
      session,
      session.prefix,
      undefined,
      now,
    );
    expect(parsed).toEqual(page);
    expect(JSON.stringify(parsed)).not.toContain("not-retained");
    expect(parsed.objects[0].key).toBe("分享/中文 +%?#.txt");
  });
  test("out-of-scope files, directory traversal and non-immediate rows are rejected", () => {
    for (const key of [
      "别处/secret",
      "分享2/secret",
      "分享/../secret",
      "分享/./secret",
      "分享/子/file",
      "分享/坏\0.txt",
      "分享/坏\\path",
    ]) {
      expect(() =>
        parseQiniuSharePage(
          { ...page, objects: [{ key, size: 1 }] },
          session,
          session.prefix,
          undefined,
          now,
        ),
      ).toThrow();
    }
    for (const prefix of [
      "别处/",
      "分享2/",
      "分享/../secret/",
      "分享/子/嵌套/",
      "分享/",
      "分享/无尾斜线",
    ]) {
      expect(() =>
        parseQiniuSharePage(
          { ...page, prefixes: [prefix] },
          session,
          session.prefix,
          undefined,
          now,
        ),
      ).toThrow();
    }
  });
  test("empty pages can continue but repeated, missing or cross-scope cursors do not", () => {
    expect(
      parseQiniuSharePage(
        { objects: [], prefixes: [], isTruncated: true, nextCursor: "next" },
        session,
        session.prefix,
        undefined,
        now,
      ).isTruncated,
    ).toBe(true);
    for (const value of [
      { ...page, nextCursor: "" },
      { ...page, nextCursor: undefined },
      { ...page, isTruncated: false },
    ])
      expect(() =>
        parseQiniuSharePage(value, session, session.prefix, undefined, now),
      ).toThrow();
    expect(() =>
      parseQiniuSharePage(page, session, session.prefix, page.nextCursor, now),
    ).toThrow();
    expect(() =>
      parseQiniuSharePage(page, session, "", undefined, now),
    ).toThrow();
    expect(() =>
      parseQiniuSharePage(
        page,
        { ...session, expiresAt: "invalid" },
        session.prefix,
        undefined,
        now,
      ),
    ).toThrow();
    expect(() =>
      parseQiniuSharePage(
        page,
        session,
        session.prefix,
        undefined,
        now + 3600000,
      ),
    ).toThrow();
  });
  test("stale page replies after close or navigation never become visible", async () => {
    let current = true;
    let calls = 0;
    const result = await requestQiniuSharePage(
      session,
      session.prefix,
      undefined,
      async (input) => {
        calls++;
        expect(input).toEqual({
          sessionId: session.sessionId,
          prefix: session.prefix,
          cursor: undefined,
        });
        current = false;
        return page;
      },
      () => current,
    );
    expect(result).toBeNull();
    expect(calls).toBe(1);
    expect(
      await requestQiniuSharePage(
        session,
        "",
        undefined,
        async () => {
          calls++;
          return page;
        },
        () => true,
      ),
    ).toBeNull();
    expect(calls).toBe(1);
  });
  test("breadcrumbs never expose or navigate above the authorized root", () => {
    expect(
      qiniuShareBreadcrumbs("分享/", "分享/图片/中文 +%?#/").map(
        (crumb) => crumb.prefix,
      ),
    ).toEqual(["分享/", "分享/图片/", "分享/图片/中文 +%?#/"]);
    expect(qiniuShareBreadcrumbs("分享/", "")).toEqual([]);
    expect(qiniuShareBreadcrumbs("分享/", "分享2/")).toEqual([]);
    expect(qiniuShareBreadcrumbs("分享/", "分享/../secret/")).toEqual([]);
    expect(
      qiniuShareBreadcrumbs("", "folder//child/").map((crumb) => crumb.prefix),
    ).toEqual(["", "folder/", "folder//", "folder//child/"]);
    expect(
      qiniuShareBreadcrumbs("分享/", "分享//中文/").map(
        (crumb) => crumb.prefix,
      ),
    ).toEqual(["分享/", "分享//", "分享//中文/"]);
    expect(qiniuShareBreadcrumbs("分享//", "分享//")).toHaveLength(1);
  });
  test("file list is read-only, bilingual, keyboard reachable and does not invoke downloads on render", () => {
    let invoked = false;
    const props = {
      prefix: session.prefix,
      page,
      busy: false,
      downloading: null,
      onNavigate: () => {
        invoked = true;
      },
      onDownload: () => {
        invoked = true;
      },
    };
    const chinese = renderToStaticMarkup(<QiniuShareFileList {...props} />);
    expect(chinese).toContain("下载");
    expect(chinese).toContain("中文 +%?#.txt");
    expect(chinese).toContain("aria-label");
    for (const forbidden of ["上传", "删除", "重命名", "创建空间"])
      expect(chinese).not.toContain(forbidden);
    useLocaleStore.getState().setLocale("en");
    const english = renderToStaticMarkup(<QiniuShareFileList {...props} />);
    expect(english).toContain("Download");
    expect(english).toContain("Size");
    expect(invoked).toBe(false);
    expect(
      renderToStaticMarkup(<QiniuShareFileList {...props} busy />),
    ).toContain("disabled");
    const failed = renderToStaticMarkup(
      <QiniuShareFileList
        {...props}
        page={{ objects: [], prefixes: [], isTruncated: false }}
        unavailable
      />,
    );
    expect(failed).toContain("listing is unavailable");
    expect(failed).not.toContain("directory is empty");
  });
  test("real application mounts the workspace and both entry points", () => {
    const read = (name: string) =>
      readFileSync(new URL(`../src/mainview/${name}`, import.meta.url), "utf8");
    expect(read("components/layout/MainLayout.tsx")).toContain(
      "<QiniuShareWorkspace />",
    );
    expect(read("components/layout/Sidebar.tsx")).toContain(
      "getState().openLogin()",
    );
    expect(read("components/objects/ObjectToolbar.tsx")).toContain(
      "getState().openCreate({",
    );
    const workspace = read("components/qiniu/QiniuShareWorkspace.tsx");
    expect(workspace).toContain('rpcCall("qiniu:share-create"');
    expect(workspace).toContain(
      "expectedProfileRevision: currentTarget.profileRevision",
    );
    expect(workspace).toContain('rpcCall("qiniu:share-login"');
    expect(workspace).toContain("onDiscardSession={discardQiniuShareSession}");
    expect(workspace).toContain("useEffect(() => () => reset(), [reset])");
  });
});
