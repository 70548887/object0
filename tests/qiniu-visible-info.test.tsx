import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BucketList } from "../src/mainview/components/buckets/BucketList";
import { QiniuStatDetails } from "../src/mainview/components/objects/DetailPanel";
import { ObjectTable } from "../src/mainview/components/objects/ObjectTable";
import {
  parseQiniuStorageType,
  qiniuRestoreInfo,
  qiniuStorageTypeLabel,
} from "../src/mainview/components/objects/qiniu-object-info";
import { useBucketStore, useProfileStore } from "../src/mainview/stores";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";

afterEach(() => useLocaleStore.getState().setLocale("zh-CN"));

function withProvider(provider: "qiniu" | "r2", run: () => void) {
  // SSR reads Zustand's initial snapshot. Adjust only this in-memory fixture,
  // restore immediately and never invoke actions that load real accounts.
  const profileState = useProfileStore.getInitialState();
  const bucketState = useBucketStore.getInitialState();
  const previousProfile = { ...profileState };
  const previousBucket = { ...bucketState };
  Object.assign(profileState, {
    activeProfileId: "visible-test",
    activeProfile: {
      id: "visible-test",
      name: "中文账号",
      provider,
      hasR2AnalyticsToken: false,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    },
  });
  Object.assign(bucketState, { selectedBucket: "中文空间" });
  try {
    run();
  } finally {
    Object.assign(profileState, previousProfile);
    Object.assign(bucketState, previousBucket);
  }
}

describe("visible Qiniu information without RPC", () => {
  test("storage labels use native type IDs and remain bilingual", () => {
    expect(parseQiniuStorageType("qiniu:3")).toBe(3);
    expect(parseQiniuStorageType("GLACIER")).toBeUndefined();
    expect(parseQiniuStorageType("qiniu:-1")).toBeUndefined();
    expect(qiniuStorageTypeLabel(4)).toBe("归档直读");
    expect(qiniuStorageTypeLabel(42)).toBe("未知类型");
    useLocaleStore.getState().setLocale("en");
    expect(qiniuStorageTypeLabel(4)).toBe("Archive instant retrieval");
  });
  test("archive stat absence means frozen but listing absence never does", () => {
    for (const type of [2, 3]) {
      expect(qiniuRestoreInfo(type, undefined, "stat").label).toBe("冻结");
      expect(qiniuRestoreInfo(type, undefined, "list").label).toBe(
        "请查看详情",
      );
      expect(qiniuRestoreInfo(type, 1, "stat").label).toBe("解冻中");
      expect(qiniuRestoreInfo(type, 2, "stat").label).toBe("已解冻");
      expect(qiniuRestoreInfo(type, 99, "stat").label).toBe("未知");
    }
    for (const type of [0, 1, 4, 5])
      expect(qiniuRestoreInfo(type, undefined, "stat").label).toBe("正常");
    expect(qiniuRestoreInfo(undefined, undefined, "stat").label).toBe("未知");
  });
  test("bucket rows expose region and read-only status only for Qiniu", () => {
    const render = () =>
      renderToStaticMarkup(
        <BucketList
          buckets={[
            {
              name: "中文空间-很长的名称仍保持原样",
              regionId: "cn-east-1",
              permission: "readonly",
              remark: "客户项目备注",
            },
          ]}
          loading={false}
          selectedBucket={null}
          profileId="visible-test"
          onSelect={() => {
            throw new Error("Unexpected selection action");
          }}
        />,
      );
    withProvider("qiniu", () => {
      const html = render();
      expect(html).toContain("cn-east-1");
      expect(html).toContain("只读");
      expect(html).toContain("客户项目备注");
      expect(html).toContain("min-w-0");
      expect(html).toContain("truncate");
      useLocaleStore.getState().setLocale("en");
      expect(render()).toContain("Read only");
      expect(render()).toContain("中文空间-很长的名称仍保持原样");
    });
    withProvider("r2", () => {
      const html = render();
      expect(html).not.toContain("cn-east-1");
      expect(html).not.toContain("Read only");
    });
  });
  test("object rows display type only and defer unknown archive state to details", () => {
    const render = () =>
      renderToStaticMarkup(
        <ObjectTable
          objects={[
            {
              key: "中文文件名.pdf",
              size: 1024,
              lastModified: "2026-01-01T00:00:00Z",
              etag: "opaque",
              storageClass: "qiniu:2",
            },
          ]}
          prefixes={[]}
          selectedKeys={new Set()}
          sortField="key"
          sortDir="asc"
          loading={false}
          onNavigate={() => {}}
          onSort={() => {}}
          onToggleSelect={() => {}}
          onSelectAll={() => {}}
          onClearSelection={() => {}}
        />,
      );
    withProvider("qiniu", () => {
      const html = render();
      expect(html).toContain("归档");
      expect(html).toContain("请查看详情");
      expect(html).not.toContain(" · 冻结");
      expect(html).toContain("中文文件名.pdf");
    });
    withProvider("r2", () => {
      const html = render();
      expect(html).not.toContain("归档");
      expect(html).not.toContain("请查看详情");
    });
  });
  test("details show read-only metadata literally and escape markup", () => {
    const stat = {
      size: 1,
      etag: "opaque",
      lastModified: "2026-01-01",
      type: "text/plain",
      storageType: 3,
      metadata: {
        客户字段: "中文值",
        "x-qn-meta-note": "<script>not executable</script>",
      },
    };
    const cn = renderToStaticMarkup(<QiniuStatDetails stat={stat} />);
    expect(cn).toContain("深度归档");
    expect(cn).toContain("冻结");
    expect(cn).toContain("客户字段");
    expect(cn).toContain("中文值");
    expect(cn).toContain("&lt;script&gt;");
    expect(cn).not.toContain("<script>");
    expect(cn).not.toContain("<input");
    expect(cn).not.toContain("<textarea");
    useLocaleStore.getState().setLocale("en");
    const en = renderToStaticMarkup(
      <QiniuStatDetails stat={{ ...stat, restoreStatus: 2 }} />,
    );
    expect(en).toContain("Deep archive");
    expect(en).toContain("Restored");
    expect(en).toContain("read-only");
    expect(en).toContain("客户字段");
    expect(en).toContain("中文值");
  });
  test("missing metadata is distinguished from a confirmed empty map", () => {
    const stat = {
      size: 1,
      etag: "opaque",
      lastModified: "2026-01-01",
      type: "text/plain",
      storageType: 0,
    };
    expect(renderToStaticMarkup(<QiniuStatDetails stat={stat} />)).toContain(
      "服务未返回",
    );
    expect(
      renderToStaticMarkup(
        <QiniuStatDetails stat={{ ...stat, metadata: {} }} />,
      ),
    ).toContain("无自定义元信息");
  });
});
