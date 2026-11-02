import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JobItem } from "../src/mainview/components/jobs/JobItem";
import {
  jobLocationCopyText,
  jobLocationRows,
  jobLocationSummary,
  mergeJobLocation,
  safeJobLocation,
} from "../src/mainview/components/jobs/job-location";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";
import type { JobInfo, JobLocation } from "../src/shared/job.types";

afterEach(() => useLocaleStore.getState().setLocale("zh-CN"));
const location: JobLocation = {
  profileId: "r2-original-id",
  profileName: "原始工作账号",
  provider: "r2",
  bucket: "same-bucket",
  key: "目录/中文 +%?#.txt",
};
const job: JobInfo = {
  id: "completed",
  type: "upload",
  status: "completed",
  fileName: "same.txt",
  description: "legacy description",
  bytesTransferred: 1,
  bytesTotal: 1,
  percentage: 100,
  speed: 0,
  eta: 0,
  createdAt: "2026-11-02T00:00:00Z",
  destination: location,
};

test("completed upload exposes captured account and bucket in collapsed task row in both locales", () => {
  for (const locale of ["zh-CN", "en"] as const) {
    useLocaleStore.getState().setLocale(locale);
    const html = renderToStaticMarkup(<JobItem job={job} />);
    expect(html).toContain("原始工作账号");
    expect(html).toContain("same-bucket");
    expect(html).toContain(locale === "en" ? "To:" : "目标:");
  }
});

test("location detail fields include independent account, ID, provider, bucket and exact object path", () => {
  expect(jobLocationRows(job)).toEqual([
    ["目标账号", "原始工作账号"],
    ["目标账号 ID", "r2-original-id"],
    ["目标服务商", "Cloudflare R2"],
    ["目标存储桶", "same-bucket"],
    ["目标对象路径", "same-bucket/目录/中文 +%?#.txt"],
  ]);
  useLocaleStore.getState().setLocale("en");
  expect(jobLocationRows(job).map(([name]) => name)).toEqual([
    "Destination account",
    "Destination account ID",
    "Destination provider",
    "Destination bucket",
    "Destination object path",
  ]);
});

test("copy allowlist excludes credential, endpoint, token and unknown fields", () => {
  const unsafe = {
    ...location,
    secretAccessKey: "must-never-copy-secret",
    accessKeyId: "must-never-copy-ak",
    endpoint: "https://must-never-copy-host",
    token: "must-never-copy-token",
  };
  const copied = jobLocationCopyText({ destination: unsafe });
  expect(copied).toContain("原始工作账号");
  expect(copied).toContain("r2-original-id");
  expect(copied).toContain("same-bucket/目录/中文 +%?#.txt");
  expect(copied).not.toContain("must-never-copy");
  const safe = safeJobLocation(unsafe);
  expect(safe).toBeDefined();
  if (!safe) throw new Error("Expected safe fixture location");
  expect(Object.keys(safe)).toEqual([
    "profileId",
    "bucket",
    "profileName",
    "provider",
    "key",
  ]);
});

test("unknown historical locations are explicit and never guessed from description or active account", () => {
  const old = {
    ...job,
    source: undefined,
    destination: undefined,
    description: "上传到 same-bucket/same.txt",
  };
  const html = renderToStaticMarkup(<JobItem job={old} />);
  expect(html).toContain("历史任务未记录账号/位置");
  expect(html).not.toContain("原始工作账号");
  expect(jobLocationRows(old)).toEqual([]);
  expect(jobLocationCopyText(old)).toBe("");
  const partial = {
    destination: {
      profileId: "known-id",
      bucket: "known-bucket",
      prefix: "folder/",
    },
  };
  expect(jobLocationRows(partial)).toContainEqual(["目标账号", "名称未记录"]);
  expect(jobLocationRows(partial)).toContainEqual([
    "目标对象路径",
    "known-bucket/folder/",
  ]);
});

test("metadata merges fill missing safe fields but cannot rewrite known historical identity or name", () => {
  const partial = { profileId: location.profileId, bucket: location.bucket };
  expect(mergeJobLocation(partial, location)).toEqual(location);
  expect(mergeJobLocation(location, undefined)).toEqual(location);
  expect(
    mergeJobLocation(location, { ...location, profileName: "renamed now" }),
  ).toEqual(location);
  expect(
    mergeJobLocation(location, {
      ...location,
      profileId: "other-id",
      profileName: "wrong-account",
    }),
  ).toEqual(location);
  expect(
    mergeJobLocation(location, { ...location, bucket: "other-bucket" }),
  ).toEqual(location);
  expect(mergeJobLocation(location, { ...location, key: "wrong-key" })).toEqual(
    location,
  );
  expect(mergeJobLocation(undefined, location)).toEqual(location);
});

test("source and destination remain distinct and incomplete locations do not become false targets", () => {
  const source = {
    ...location,
    profileId: "source-id",
    profileName: "来源账号",
    provider: "qiniu" as const,
    bucket: "source-bucket",
    key: "source/",
  };
  const summary = jobLocationSummary({ source, destination: location });
  expect(summary).toContain(
    "来源账号 · source-bucket → 原始工作账号 · same-bucket",
  );
  expect(jobLocationRows({ source, destination: location })).toContainEqual([
    "来源账号 ID",
    "source-id",
  ]);
  expect(safeJobLocation({ profileId: "", bucket: "b" })).toBeUndefined();
  expect(safeJobLocation({ profileId: "p", bucket: "" })).toBeUndefined();
  expect(
    jobLocationRows({ source: { profileId: "p", bucket: "b" } }),
  ).toContainEqual(["来源对象路径", "未记录"]);
  expect(
    jobLocationRows({ source: { profileId: "p", bucket: "b", prefix: "" } }),
  ).toContainEqual(["来源对象路径", "b/"]);
  expect(
    jobLocationRows({
      destination: { profileId: "p", bucket: "b", key: "folder/file.txt" },
    }),
  ).toContainEqual(["目标对象路径", "b/folder/file.txt"]);
});
