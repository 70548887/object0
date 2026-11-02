import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { ObjectBrowser } from "../src/mainview/components/objects/ObjectBrowser";
import { assertCurrentUploadScope } from "../src/mainview/components/objects/upload-scope";
import { profileInformation } from "../src/mainview/components/profiles/profileCredentials";
import {
  isCurrentQiniuDetailsTarget,
  submitQiniuDetailsMutation,
} from "../src/mainview/components/qiniu/QiniuDetailsActions";
import {
  useBucketStore,
  useObjectStore,
  useProfileStore,
  useUIStore,
  useVaultStore,
} from "../src/mainview/stores";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";
import type { ProfileInfo } from "../src/shared/profile.types";

afterEach(() => useLocaleStore.getState().setLocale("zh-CN"));
const profile: ProfileInfo = {
  id: "audit",
  name: "Audit fixture",
  provider: "qiniu",
  qiniu: { mode: "public" },
  hasR2AnalyticsToken: false,
  hasSessionToken: false,
  createdAt: "t",
  updatedAt: "revision-old",
};
function renderPage(input: {
  prefixes?: Array<{ prefix: string }>;
  objects?: Array<{
    key: string;
    size: number;
    etag: string;
    lastModified: string;
  }>;
  currentPrefix?: string;
  search?: string;
  truncated?: boolean;
  pageHistory?: string[];
}) {
  const fixtures = [
    [
      useProfileStore.getInitialState(),
      { activeProfileId: profile.id, activeProfile: profile },
    ],
    [useBucketStore.getInitialState(), { selectedBucket: "bucket" }],
    [
      useObjectStore.getInitialState(),
      {
        objects: input.objects ?? [],
        prefixes: input.prefixes ?? [],
        loading: false,
        error: null,
        currentPrefix: input.currentPrefix ?? "",
        isTruncated: input.truncated ?? true,
        nextCursor: input.truncated === false ? undefined : "opaque-next",
        pageHistory: input.pageHistory ?? [],
        filters: {
          ...useObjectStore.getInitialState().filters,
          search: input.search ?? "",
        },
      },
    ],
    [useUIStore.getInitialState(), { viewMode: "table" }],
  ] as const;
  const before = fixtures.map(([state]) => ({ ...state }));
  try {
    fixtures.forEach(([state, values]) => {
      Object.assign(state, values);
    });
    return renderToStaticMarkup(<ObjectBrowser />);
  } finally {
    fixtures.forEach(([state], i) => {
      Object.assign(state, before[i]);
    });
  }
}

test("audit A3: an empty continuation page remains navigable and never claims an empty bucket", () => {
  for (const prefix of ["", "folder/"]) {
    const html = renderPage({ currentPrefix: prefix });
    expect(html).toContain("加载更多");
    expect(html).toContain("仍有后续页面");
    expect(html).not.toContain("存储桶为空");
    expect(html).not.toContain("文件夹为空");
  }
  expect(renderPage({ prefixes: [{ prefix: "folder/" }] })).toContain(
    "加载更多",
  );
  expect(renderPage({ truncated: false })).toContain("存储桶为空");
});

test("audit A3: local no-match filtering retains the next-page action in both languages", () => {
  for (const locale of ["zh-CN", "en"] as const) {
    useLocaleStore.getState().setLocale(locale);
    const html = renderPage({
      search: "missing",
      objects: [
        {
          key: "visible.txt",
          size: 1,
          etag: "opaque",
          lastModified: "2026-11-01T00:00:00Z",
        },
      ],
    });
    expect(html).toContain(locale === "en" ? "Load more" : "加载更多");
    expect(html).toContain(locale === "en" ? "later pages" : "后续页");
    expect(html).not.toContain(
      locale === "en" ? "Bucket is empty" : "存储桶为空",
    );
  }
});

test("audit A3: an empty terminal page is not described as an empty bucket", () => {
  const html = renderPage({
    truncated: false,
    pageHistory: ["previous-cursor"],
  });
  expect(html).toContain("本页暂无条目");
  expect(html).toContain("返回第一页");
  expect(html).not.toContain('<h3 class="font-semibold text-lg">存储桶为空');
  useLocaleStore.getState().setLocale("en");
  expect(
    renderPage({ truncated: false, pageHistory: ["previous-cursor"] }),
  ).toContain("Return to first page");
});

test("audit A7: view and copy information include the saved share API without obsolete reserved labels", () => {
  const saved: ProfileInfo = {
    ...profile,
    qiniu: {
      mode: "private",
      ucUrl: "https://uc.fixture",
      regions: [{ id: "zone", s3Endpoint: "https://s3.fixture" }],
      sharePortal: "https://portal.fixture",
      shareApiUrl: "https://share-api.fixture",
    },
  };
  for (const locale of ["zh-CN", "en"] as const) {
    useLocaleStore.getState().setLocale(locale);
    const text = profileInformation(saved);
    expect(text).toContain("https://share-api.fixture");
    expect(text).toContain(
      locale === "en" ? "Directory-share API" : "目录分享 API",
    );
    expect(text).not.toContain(locale === "en" ? "reserved" : "预留");
  }
});

test("audit A2: mutation retains the exact captured account revision and blocks a stale live target", async () => {
  const input = {
    profileId: profile.id,
    expectedProfileRevision: profile.updatedAt,
    bucket: "bucket",
    keys: ["file"],
    operation: "restore" as const,
    value: 1,
    costConfirmed: true,
  };
  let sent: unknown;
  await submitQiniuDetailsMutation(input, async (_method, payload) => {
    sent = payload;
    return { results: [{ key: "file", success: true }] };
  });
  expect(sent).toHaveProperty("expectedProfileRevision", profile.updatedAt);
  let called = false;
  await expect(
    submitQiniuDetailsMutation(
      input,
      async () => {
        called = true;
        return { results: [] };
      },
      () => false,
    ),
  ).rejects.toThrow();
  await expect(
    submitQiniuDetailsMutation(
      { ...input, expectedProfileRevision: "" },
      async () => {
        called = true;
        return { results: [] };
      },
    ),
  ).rejects.toThrow();
  expect(called).toBe(false);
});

test("audit A2: current-store checks reject an edited account before React props refresh", () => {
  const before = [
    useVaultStore.getState(),
    useProfileStore.getState(),
    useBucketStore.getState(),
    useUIStore.getState(),
  ] as const;
  const target = {
    profileId: profile.id,
    expectedProfileRevision: profile.updatedAt,
    bucket: "bucket",
    objectKey: "file",
  };
  try {
    useVaultStore.setState({ unlocked: true, profiles: [profile] });
    useProfileStore.setState({
      activeProfileId: profile.id,
      activeProfile: profile,
    });
    useBucketStore.setState({ selectedBucket: "bucket" });
    useUIStore.setState({ detailKey: "file" });
    expect(isCurrentQiniuDetailsTarget(target)).toBe(true);
    useVaultStore.setState({
      profiles: [{ ...profile, updatedAt: "revision-new" }],
    });
    expect(isCurrentQiniuDetailsTarget(target)).toBe(false);
    useVaultStore.setState({ profiles: [profile], unlocked: false });
    expect(isCurrentQiniuDetailsTarget(target)).toBe(false);
  } finally {
    useVaultStore.setState(before[0], true);
    useProfileStore.setState(before[1], true);
    useBucketStore.setState(before[2], true);
    useUIStore.setState(before[3], true);
  }
});

test("audit A1: all upload entry points send the captured profile revision", () => {
  for (const name of ["ObjectToolbar", "DropZone", "CreateFolderDialog"]) {
    const source = readFileSync(
      `src/mainview/components/objects/${name}.tsx`,
      "utf8",
    );
    expect(source).toContain("expectedProfileRevision:");
  }
});

test("audit A1: live upload checks protect a captured batch across edits, provider changes and directory switches", () => {
  const before = [
    useVaultStore.getState(),
    useProfileStore.getState(),
    useBucketStore.getState(),
    useObjectStore.getState(),
  ] as const;
  try {
    useVaultStore.setState({ unlocked: true, profiles: [profile] });
    useProfileStore.setState({
      activeProfileId: profile.id,
      activeProfile: profile,
    });
    useBucketStore.setState({ selectedBucket: "bucket" });
    useObjectStore.setState({ currentPrefix: "folder/" });
    const scope = {
      profileId: profile.id,
      expectedProfileRevision: profile.updatedAt,
      provider: profile.provider,
      bucket: "bucket",
      prefix: "folder/",
    };
    expect(() => assertCurrentUploadScope(scope)).not.toThrow();
    useVaultStore.setState({ profiles: [{ ...profile, updatedAt: "edited" }] });
    expect(() => assertCurrentUploadScope(scope)).toThrow();
    useVaultStore.setState({ profiles: [{ ...profile, provider: "r2" }] });
    expect(() => assertCurrentUploadScope(scope)).toThrow();
    useVaultStore.setState({ profiles: [profile] });
    useObjectStore.setState({ currentPrefix: "different/" });
    expect(() => assertCurrentUploadScope(scope)).toThrow();
    useObjectStore.setState({ currentPrefix: "folder/" });
    useVaultStore.setState({ unlocked: false });
    expect(() => assertCurrentUploadScope(scope)).toThrow();
  } finally {
    useVaultStore.setState(before[0], true);
    useProfileStore.setState(before[1], true);
    useBucketStore.setState(before[2], true);
    useObjectStore.setState(before[3], true);
  }
});
