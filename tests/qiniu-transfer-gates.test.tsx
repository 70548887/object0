import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { DropZone } from "../src/mainview/components/objects/DropZone";
import { ObjectToolbar } from "../src/mainview/components/objects/ObjectToolbar";
import {
  QINIU_NATIVE_MULTIPART_MAX_BYTES,
  QINIU_PREVIEW_UPLOAD_LIMIT,
  qiniuDroppedFilesBlockReason,
  qiniuFolderMutationBlockReason,
  qiniuTransferPairReason,
  qiniuUnfinishedTransferReason,
  qiniuUploadBlockReason,
  qiniuUploadNotice,
} from "../src/mainview/components/objects/qiniu-transfer-gates";
import { FolderSyncRuleEditor } from "../src/mainview/components/sync/FolderSyncRuleEditor";
import { SyncRuleCard } from "../src/mainview/components/sync/SyncRuleCard";
import {
  useBucketStore,
  useObjectStore,
  useProfileStore,
  useVaultStore,
} from "../src/mainview/stores";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";
import type { FolderSyncRule } from "../src/shared/folder-sync.types";
import type { ProfileInfo } from "../src/shared/profile.types";

const publicProfile: ProfileInfo = {
  id: "qiniu-gate-fixture",
  name: "七牛测试",
  provider: "qiniu",
  qiniu: { mode: "public" },
  hasR2AnalyticsToken: false,
  hasSessionToken: false,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

afterEach(() => useLocaleStore.getState().setLocale("zh-CN"));

function withProfile(
  profile: ProfileInfo,
  run: () => void,
  latest?: ProfileInfo,
  selectedKeys = new Set(["file.txt"]),
) {
  // SSR uses the initial store snapshots. Only fixtures, no vault or RPC access.
  const fixtures = [
    [
      useProfileStore.getInitialState(),
      { activeProfileId: profile.id, activeProfile: profile },
    ],
    [useVaultStore.getInitialState(), { profiles: latest ? [latest] : [] }],
    [useBucketStore.getInitialState(), { selectedBucket: "fixture-bucket" }],
    [useObjectStore.getInitialState(), { selectedKeys }],
  ] as const;
  const previous = fixtures.map(([state]) => ({ ...state }));
  try {
    fixtures.forEach(([state, fixture]) => {
      Object.assign(state, fixture);
    });
    run();
  } finally {
    fixtures.forEach(([state], index) => {
      Object.assign(state, previous[index]);
    });
  }
}

function toolbarButton(markup: string, label: string) {
  const button = markup
    .match(/<button\b[^>]*>.*?<\/button>/gs)
    ?.find((item) => item.endsWith(`${label}</button>`));
  if (!button) throw new Error(`Button missing from SSR fixture: ${label}`);
  return button;
}

describe("Qiniu preview transfer gates without network requests", () => {
  test("only explicitly public long-lived credentials can upload", () => {
    expect(qiniuUploadBlockReason(publicProfile)).toBeNull();
    expect(
      qiniuUploadBlockReason({
        ...publicProfile,
        qiniu: { mode: "private" },
      }),
    ).toContain("私有云");
    expect(
      qiniuUploadBlockReason({ ...publicProfile, hasSessionToken: true }),
    ).toContain("临时凭据");
    expect(
      qiniuUploadBlockReason({ ...publicProfile, hasSessionToken: undefined }),
    ).toContain("尚未确认");
    expect(
      qiniuUploadBlockReason({ ...publicProfile, qiniu: undefined }),
    ).toContain("尚未确认");
  });

  test("non-Qiniu behavior is unchanged for all provider/credential modes", () => {
    for (const provider of ["r2", "aws", "custom", "minio"] as const) {
      const profile = { ...publicProfile, provider, hasSessionToken: true };
      expect(qiniuUploadBlockReason(profile)).toBeNull();
      expect(qiniuUploadNotice(profile)).toBeNull();
      expect(
        qiniuDroppedFilesBlockReason(profile, [{ size: Number.MAX_VALUE }]),
      ).toBeNull();
      for (const feature of [
        "sync",
        "archive",
        "transfer",
        "folder-download",
      ] as const)
        expect(qiniuUnfinishedTransferReason(profile, feature)).toBeNull();
    }
  });

  test("public native files above 5 MiB can enter durable multipart up to the bounded limit", () => {
    for (const size of [
      0,
      1,
      QINIU_PREVIEW_UPLOAD_LIMIT,
      QINIU_PREVIEW_UPLOAD_LIMIT + 1,
      QINIU_NATIVE_MULTIPART_MAX_BYTES,
    ])
      expect(
        qiniuDroppedFilesBlockReason(publicProfile, [{ size }]),
      ).toBeNull();
    expect(
      qiniuDroppedFilesBlockReason(publicProfile, [
        { size: 1 },
        { size: QINIU_NATIVE_MULTIPART_MAX_BYTES + 1 },
      ]),
    ).toContain("本批次未上传");
    for (const size of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0.1])
      expect(qiniuDroppedFilesBlockReason(publicProfile, [{ size }])).toContain(
        "无法确认",
      );
  });

  test("file picker notice describes native durable uploads without claiming cloud acceptance", () => {
    expect(qiniuUploadNotice(publicProfile)).toContain("由后端检查大小");
    expect(qiniuUploadNotice(publicProfile)).toContain("手动恢复");
    expect(qiniuUploadNotice(publicProfile)).toContain("仅本地模拟验收");
  });

  test("all disabled feature reasons and upload limitations are bilingual", () => {
    useLocaleStore.getState().setLocale("en");
    expect(qiniuUploadNotice(publicProfile)).toContain("backend checks sizes");
    expect(
      qiniuUploadBlockReason({ ...publicProfile, hasSessionToken: true }),
    ).toContain("temporary-credential");
    expect(
      qiniuUploadBlockReason({ ...publicProfile, qiniu: { mode: "private" } }),
    ).toContain("private-cloud");
    for (const feature of [
      "sync",
      "archive",
      "transfer",
      "folder-download",
    ] as const)
      expect(qiniuUnfinishedTransferReason(publicProfile, feature)).toContain(
        "not implemented yet",
      );
  });

  test("a Qiniu destination cannot bypass a non-Qiniu transfer or sync source", () => {
    const r2 = { ...publicProfile, id: "r2-fixture", provider: "r2" as const };
    for (const feature of ["sync", "transfer"] as const) {
      expect(qiniuTransferPairReason(r2, r2, feature)).toBeNull();
      expect(
        qiniuTransferPairReason(publicProfile, r2, feature),
      ).not.toBeNull();
      expect(
        qiniuTransferPairReason(r2, publicProfile, feature),
      ).not.toBeNull();
      expect(
        qiniuTransferPairReason(publicProfile, publicProfile, feature),
      ).not.toBeNull();
    }
  });

  test("private toolbar disables uploads and markers, not individual downloads", () => {
    withProfile({ ...publicProfile, qiniu: { mode: "private" } }, () => {
      const markup = renderToStaticMarkup(<ObjectToolbar />);
      expect(toolbarButton(markup, "上传")).toContain('disabled=""');
      expect(toolbarButton(markup, "新建文件夹")).toContain('disabled=""');
      expect(toolbarButton(markup, "同步")).toContain('disabled=""');
      expect(toolbarButton(markup, "下载")).not.toContain('disabled=""');
      expect(markup).toContain("七牛私有云上传尚未完成适配");
    });
  });

  test("latest secret-free vault metadata overrides stale active profile", () => {
    withProfile(
      publicProfile,
      () => {
        const markup = renderToStaticMarkup(<ObjectToolbar />);
        expect(toolbarButton(markup, "上传")).toContain('disabled=""');
        expect(markup).toContain("七牛临时凭据上传尚未完成适配");
      },
      { ...publicProfile, hasSessionToken: true },
    );
  });

  test("mixed Qiniu file/folder downloads fail closed, normal file download remains", () => {
    withProfile(
      publicProfile,
      () => {
        const markup = renderToStaticMarkup(<ObjectToolbar />);
        expect(toolbarButton(markup, "下载")).toContain('disabled=""');
        expect(markup).toContain("请仅选择文件下载");
      },
      undefined,
      new Set(["file.txt", "folder/"]),
    );
  });

  test("Qiniu directory deletion cannot silently delete only a marker in mixed selections", () => {
    withProfile(
      publicProfile,
      () => {
        const markup = renderToStaticMarkup(<ObjectToolbar />);
        expect(toolbarButton(markup, "删除")).toContain('disabled=""');
        expect(markup).toContain("目录删除尚未完成适配");
      },
      undefined,
      new Set(["file.txt", "folder/"]),
    );
  });

  test("folder mutation gates preserve file operations and non-Qiniu behavior in both languages", () => {
    for (const locale of ["zh-CN", "en"] as const) {
      useLocaleStore.getState().setLocale(locale);
      for (const operation of ["delete", "rename"] as const) {
        expect(
          qiniuFolderMutationBlockReason(
            publicProfile,
            ["folder/file.txt"],
            operation,
          ),
        ).toBeNull();
        expect(
          qiniuFolderMutationBlockReason(
            { ...publicProfile, provider: "r2" },
            ["folder/"],
            operation,
          ),
        ).toBeNull();
        expect(
          qiniuFolderMutationBlockReason(
            publicProfile,
            ["file.txt", "中文目录/"],
            operation,
          ),
        ).toContain(locale === "en" ? "not implemented yet" : "尚未完成适配");
      }
    }
  });

  test("folder mutation guard is present at right-click, toolbar confirmation, and inline/F2 rename boundaries", () => {
    // This is a source contract check, not a browser/keyboard simulation.
    const read = (name: string) =>
      readFileSync(
        new URL(`../src/mainview/components/objects/${name}`, import.meta.url),
        "utf8",
      );
    const menu = read("ObjectContextMenu.tsx");
    expect(menu).toContain("disabled={!!renameBlocked}");
    expect(menu).toContain("disabled={!!deleteBlocked}");
    expect(menu).toContain(
      "if (renameBlocked) return toast.warning(renameBlocked)",
    );
    expect(menu).toContain(
      "if (deleteBlocked) return toast.warning(deleteBlocked)",
    );
    const table = read("ObjectTable.tsx");
    expect(table).toMatch(
      /const startRename[\s\S]*?qiniuFolderMutationBlockReason[\s\S]*?if \(blocked\) return toast.warning\(blocked\)/,
    );
    expect(table).toMatch(
      /const commitRename[\s\S]*?qiniuFolderMutationBlockReason[\s\S]*?if \(blocked\)/,
    );
    expect(read("ObjectToolbar.tsx")).toMatch(
      /onConfirm=\{\(\) => \{\s*if \(deleteBlocked\) return toast.warning\(deleteBlocked\)/,
    );
  });

  test("R2 toolbar retains upload, sync, folder marker, and folder download", () => {
    withProfile(
      { ...publicProfile, provider: "r2" },
      () => {
        const markup = renderToStaticMarkup(<ObjectToolbar />);
        for (const label of ["上传", "新建文件夹", "下载", "同步"])
          expect(toolbarButton(markup, label)).not.toContain('disabled=""');
        expect(markup).not.toContain("七牛预览版");
        expect(renderToStaticMarkup(<DropZone>content</DropZone>)).toContain(
          "content",
        );
      },
      undefined,
      new Set(["folder/"]),
    );
  });

  test("existing Qiniu live-sync rule cannot be saved as an available feature", () => {
    withProfile(
      publicProfile,
      () => {
        const rule: FolderSyncRule = {
          id: "rule-fixture",
          profileId: publicProfile.id,
          bucket: "fixture-bucket",
          bucketPrefix: "",
          localPath: "C:/fixture-only",
          direction: "local-to-remote",
          conflictResolution: "keep-both",
          enabled: false,
          pollIntervalMs: 30000,
          excludePatterns: [],
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
        };
        const markup = renderToStaticMarkup(
          <FolderSyncRuleEditor editRule={rule} onDone={() => {}} />,
        );
        expect(markup).toContain("七牛对象同步和文件夹同步尚未完成适配");
        expect(toolbarButton(markup, "保存修改")).toContain('disabled=""');
        const renderCard = (enabled: boolean, blocked: boolean) =>
          renderToStaticMarkup(
            <SyncRuleCard
              rule={{ ...rule, enabled }}
              conflictCount={0}
              isCompact={false}
              unavailableReason={
                blocked
                  ? (qiniuUnfinishedTransferReason(publicProfile, "sync") ??
                    undefined)
                  : undefined
              }
              onSyncNow={() => {}}
              onToggle={() => {}}
              onClearConflicts={() => {}}
              onEdit={() => {}}
              onDelete={() => {}}
            />,
          );
        expect(toolbarButton(renderCard(false, true), "启用")).toContain(
          'disabled=""',
        );
        expect(toolbarButton(renderCard(false, true), "同步")).toContain(
          'disabled=""',
        );
        expect(toolbarButton(renderCard(true, true), "暂停")).not.toContain(
          'disabled=""',
        );
        expect(toolbarButton(renderCard(false, false), "启用")).not.toContain(
          'disabled=""',
        );
      },
      publicProfile,
    );
  });
});
