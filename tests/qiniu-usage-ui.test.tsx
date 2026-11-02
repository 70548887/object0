import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BucketUsageStatus,
  formatStorageBytes,
  QiniuUsageBreakdown,
  qiniuUsageClassLabel,
  usageBytesLabel,
  usageSourceLabel,
} from "../src/mainview/components/layout/BucketUsageStatus";
import {
  isBucketUsageCacheable,
  parseBucketUsage,
} from "../src/mainview/hooks/useBucketUsage";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";
import type {
  BucketUsage,
  QiniuClassUsage,
  QiniuUsageAnalytics,
} from "../src/shared/s3.types";

afterEach(() => useLocaleStore.getState().setLocale("zh-CN"));
const at = "2026-11-01T00:00:00Z";
const ids = [
  "standard",
  "line",
  "intelligent_tiering",
  "archive_ir",
  "archive",
  "deep_archive",
];
function analytics(): QiniuUsageAnalytics {
  return {
    complete: true,
    measuredAt: at,
    classes: ids.map((storageClass, index) => ({
      storageClass,
      bytes: index * 1000,
      objectCount: index,
      measuredAt: at,
      state: "available",
    })),
  };
}
function usage(): BucketUsage {
  return {
    profileId: "profile",
    bucket: "bucket",
    source: "qiniu",
    bytes: 15000,
    objectCount: 15,
    measuredAt: at,
    fetchedAt: "2026-11-01T00:05:00Z",
    complete: true,
    qiniuAnalytics: analytics(),
  };
}
function report(value: BucketUsage): QiniuUsageAnalytics {
  if (!value.qiniuAnalytics) throw new Error("Fixture report is missing");
  return value.qiniuAnalytics;
}
const parse = (value: unknown, provider = "qiniu") =>
  parseBucketUsage(value, "profile", "bucket", provider);

describe("Qiniu usage IPC validation", () => {
  test("accepts six distinct aligned classes and preserves actual zero values", () => {
    const data = parse(usage());
    expect(data.bytes).toBe(15000);
    expect(data.qiniuAnalytics?.classes[0].bytes).toBe(0);
    expect(data.complete).toBe(true);
    expect(isBucketUsageCacheable(data)).toBe(true);
    expect(formatStorageBytes(0)).toBe("0 B");
  });
  test("partial or unaligned official metrics never create a lower-bound total", () => {
    for (const change of [
      (data: BucketUsage) => {
        report(data).classes[0].bytes = null;
      },
      (data: BucketUsage) => {
        report(data).classes[1].measuredAt = "2026-10-31T23:55:00Z";
      },
      (data: BucketUsage) => {
        report(data).classes.pop();
      },
      (data: BucketUsage) => {
        report(data).complete = false;
      },
      (data: BucketUsage) => {
        data.complete = false;
      },
      (data: BucketUsage) => {
        data.bytes = 1;
      },
    ]) {
      const value = usage();
      change(value);
      const data = parse(value);
      expect(data.complete).toBe(false);
      expect(data.bytes).toBeNull();
      expect(data.objectCount).toBeNull();
      expect(data.measuredAt).toBeNull();
      if (report(value).classes[0].bytes === null)
        expect(data.qiniuAnalytics?.classes[0].state).toBe("partial");
      expect(isBucketUsageCacheable(data)).toBe(false);
      expect(usageBytesLabel(data)).toBe("总量待确认");
      expect(usageBytesLabel(data)).not.toContain("≥");
    }
  });
  test("unknown advertised class prevents treating known classes as a full bucket", () => {
    const value = usage();
    report(value).classes.push({
      storageClass: "unknown:42",
      bytes: null,
      objectCount: null,
      measuredAt: null,
      state: "unsupported",
      reason: "未知区域类型 / Unknown regional class",
    });
    const data = parse(value);
    expect(data.complete).toBe(false);
    expect(data.qiniuAnalytics?.classes).toHaveLength(7);
    expect(data.bytes).toBeNull();
  });
  test("scope, provider and malformed numeric data are rejected rather than zero-filled", () => {
    for (const value of [
      null,
      [],
      { ...usage(), profileId: "other" },
      { ...usage(), bucket: "other" },
      { ...usage(), bytes: -1 },
      { ...usage(), bytes: NaN },
      { ...usage(), bytes: Infinity },
      { ...usage(), bytes: Number.MAX_SAFE_INTEGER + 1 },
      { ...usage(), objectCount: 1.5 },
      { ...usage(), bytes: "0" },
      { ...usage(), measuredAt: "not-time" },
      { ...usage(), fetchedAt: null },
    ]) {
      expect(() => parse(value)).toThrow();
    }
    expect(() => parse(usage(), "r2")).toThrow();
    expect(() => parse({ ...usage(), source: "r2" })).toThrow();
    expect(() => parse({ ...usage(), qiniuAnalytics: undefined })).toThrow();
  });
  test("duplicate class identifiers and invalid row metrics fail closed", () => {
    for (const mutation of [
      (row: QiniuClassUsage) => {
        row.bytes = -1;
      },
      (row: QiniuClassUsage) => {
        row.objectCount = Number.MAX_SAFE_INTEGER + 1;
      },
      (row: QiniuClassUsage) => {
        row.measuredAt = "secret-invalid-date";
      },
      (row: QiniuClassUsage) => {
        row.storageClass = "standard";
      },
    ]) {
      const value = usage();
      mutation(report(value).classes[1]);
      expect(() => parse(value)).toThrow();
    }
  });
  test("sum overflow and inconsistent totals cannot be cached", () => {
    const value = usage();
    for (const row of report(value).classes)
      row.bytes = Number.MAX_SAFE_INTEGER;
    const data = parse(value);
    expect(data.bytes).toBeNull();
    expect(data.complete).toBe(false);
    expect(isBucketUsageCacheable(data)).toBe(false);
  });
  test("R2 and scan preserve known totals while only an incomplete scan gets ≥", () => {
    const common = {
      ...usage(),
      qiniuAnalytics: undefined,
      bytes: 1234,
      objectCount: 2,
    };
    const r2 = parse({ ...common, source: "r2" }, "r2");
    expect(r2.complete).toBe(true);
    expect(usageBytesLabel(r2)).toBe("1.23 KB");
    const scan = parse({
      ...common,
      source: "scan",
      complete: false,
      scannedPages: 1,
    });
    expect(usageBytesLabel(scan)).toBe("≥ 1.23 KB");
    expect(isBucketUsageCacheable(scan)).toBe(false);
    expect(() => parse({ ...common, source: "scan", bytes: null })).toThrow();
    expect(() =>
      parse({ ...common, source: "r2", objectCount: null }, "r2"),
    ).toThrow();
  });
  test("scan fallback retains separate official diagnostics without mixing totals", () => {
    const value = usage();
    value.source = "scan";
    value.bytes = 2345;
    value.objectCount = 8;
    report(value).complete = false;
    report(value).measuredAt = null;
    report(value).classes[2] = {
      storageClass: "intelligent_tiering",
      bytes: null,
      objectCount: null,
      measuredAt: null,
      state: "forbidden",
      reason: "权限不足 / Permission denied",
    };
    const data = parse(value);
    expect(data.source).toBe("scan");
    expect(data.bytes).toBe(2345);
    expect(data.objectCount).toBe(8);
    expect(data.qiniuAnalytics?.complete).toBe(false);
    expect(data.qiniuAnalytics?.classes[2].bytes).toBeNull();
    expect(isBucketUsageCacheable(data)).toBe(true);
  });
  test("unknown fields never survive the allowlisted IPC result", () => {
    const data = parse({
      ...usage(),
      secretAccessKey: "must-not-be-retained",
      qiniuAnalytics: { ...analytics(), credential: "must-not-be-retained" },
    });
    expect(JSON.stringify(data)).not.toContain("must-not-be-retained");
  });
});

describe("compact Qiniu usage presentation", () => {
  test("unknown official totals do not render zeros, lower-bound marks or R2 allowances", () => {
    const data = parse({ ...usage(), complete: false });
    const html = renderToStaticMarkup(
      <BucketUsageStatus
        bucket="bucket"
        provider="qiniu"
        online
        data={data}
        loading={false}
        error={null}
        stale={false}
        cancelled={false}
        refresh={() => {}}
        cancel={() => {}}
      />,
    );
    expect(html).toContain("总量待确认");
    expect(html).toContain("七牛官方分类统计");
    expect(html).not.toContain("≥");
    expect(html).not.toContain("0 B");
    expect(html).not.toContain("10 GB");
    expect(html).toContain("未知");
  });
  test("classification table distinguishes zero, missing, forbidden and measurement times", () => {
    const report = analytics();
    report.complete = false;
    report.measuredAt = null;
    report.classes[1] = {
      storageClass: "line",
      bytes: null,
      objectCount: null,
      measuredAt: null,
      state: "forbidden",
      reason: "权限不足 / Permission denied",
    };
    report.classes[2].state = "partial";
    const html = renderToStaticMarkup(
      <QiniuUsageBreakdown analytics={report} />,
    );
    for (const label of [
      "标准",
      "低频",
      "智能分层",
      "归档直读",
      "深度归档",
      "部分统计 · 不合计",
      "权限不足",
      "缺项／未对齐",
      "未知",
      "0 B",
      "时间：",
    ])
      expect(html).toContain(label);
    expect(html).not.toContain("≥");
    expect(html).toContain("overflow-auto");
    expect(html).toContain("table-fixed");
  });
  test("complete report has one aligned time and six bilingual class names", () => {
    useLocaleStore.getState().setLocale("en");
    const html = renderToStaticMarkup(
      <QiniuUsageBreakdown analytics={analytics()} />,
    );
    for (const label of [
      "Standard",
      "Infrequent access",
      "Intelligent tiering",
      "Archive instant retrieval",
      "Deep archive",
      "Complete · Time aligned",
      "Aligned measurement:",
    ])
      expect(html).toContain(label);
    expect(usageSourceLabel("qiniu", "qiniu")).toBe(
      "Official Qiniu class analytics",
    );
    expect(usageSourceLabel("scan", "qiniu")).toBe("Qiniu object scan");
    expect(usageSourceLabel("scan", "custom")).toBe("S3 object scan");
    expect(usageSourceLabel("r2", "r2")).toBe("Official R2 analytics");
    expect(qiniuUsageClassLabel("unknown:42")).toBe("Unknown storage class");
    expect(formatStorageBytes(null)).toBe("Unknown");
  });
  test("empty report is explicitly unavailable instead of an empty bucket", () => {
    const html = renderToStaticMarkup(
      <QiniuUsageBreakdown
        analytics={{ complete: false, measuredAt: null, classes: [] }}
      />,
    );
    expect(html).toContain("这不表示空间为空");
    expect(html).not.toContain("0 B");
  });
});
