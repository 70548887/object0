import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JobItem } from "../src/mainview/components/jobs/JobItem";
import { buildJobPanelModel } from "../src/mainview/components/jobs/useJobPanelModel";
import {
  resumableJobActions,
  useJobStore,
} from "../src/mainview/stores/useJobStore";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";
import type { JobInfo, JobStatus } from "../src/shared/job.types";

afterEach(() => {
  useLocaleStore.getState().setLocale("zh-CN");
  useJobStore.getState().resetJobs();
});
const job = (status: JobStatus, resumable = true): JobInfo => ({
  id: `job-${status}`,
  type: "upload",
  status,
  resumable,
  attempt: 1,
  fileName: "fixture.bin",
  description: "fixture",
  bytesTransferred: 5,
  bytesTotal: 10,
  percentage: 50,
  speed: 0,
  eta: 0,
  createdAt: "2026-10-31T00:00:00Z",
});

test("resumable actions apply only to persisted native upload states", () => {
  expect(resumableJobActions(job("running"))).toEqual({
    pause: true,
    resume: false,
    retry: false,
    cancel: true,
  });
  expect(resumableJobActions(job("queued"))).toEqual({
    pause: true,
    resume: false,
    retry: false,
    cancel: true,
  });
  expect(resumableJobActions(job("paused"))).toEqual({
    pause: false,
    resume: true,
    retry: false,
    cancel: true,
  });
  expect(resumableJobActions(job("interrupted"))).toEqual({
    pause: false,
    resume: false,
    retry: true,
    cancel: true,
  });
  expect(resumableJobActions(job("running", false)).pause).toBe(false);
  expect(resumableJobActions(job("paused", false))).toEqual({
    pause: false,
    resume: false,
    retry: false,
    cancel: false,
  });
  for (const status of ["completed", "failed", "cancelled"] as const)
    expect(resumableJobActions(job(status))).toEqual({
      pause: false,
      resume: false,
      retry: false,
      cancel: false,
    });
});
test("paused and interrupted jobs remain visible but are not counted as active or completed", () => {
  const jobs: JobInfo[] = [
    job("running"),
    job("queued"),
    job("paused"),
    job("interrupted"),
    job("completed"),
    job("failed"),
    job("cancelled"),
  ];
  const model = buildJobPanelModel(jobs);
  expect(model.activeJobs.map((item) => item.status)).toEqual([
    "running",
    "queued",
  ]);
  expect(model.waitingJobs.map((item) => item.status)).toEqual([
    "paused",
    "interrupted",
  ]);
  expect(model.completedJobs.map((item) => item.status)).toEqual([
    "completed",
    "failed",
    "cancelled",
  ]);
  expect(model.succeededCount).toBe(1);
  expect(model.failedCount).toBe(1);
  expect(model.totalBytes).toBe(10);
  expect(model.transferredBytes).toBe(5);
  expect(model.virtualRows.filter((item) => item.kind === "job")).toHaveLength(
    7,
  );
});
test("native held job SSR is bilingual and exposes safe manual controls", () => {
  const paused = renderToStaticMarkup(<JobItem job={job("paused")} />);
  expect(paused).toContain("已暂停");
  expect(paused).toContain("恢复上传");
  expect(paused).toContain("已保留断点");
  expect(paused).not.toContain("暂停并保留分片");
  const interrupted = renderToStaticMarkup(
    <JobItem job={job("interrupted")} />,
  );
  expect(interrupted).toContain("已中断，待恢复");
  expect(interrupted).toContain("重试安全续传");
  useLocaleStore.getState().setLocale("en");
  const en = renderToStaticMarkup(<JobItem job={job("paused")} />);
  expect(en).toContain("Paused");
  expect(en).toContain("Resume upload");
  expect(en).toContain("no automatic upload");
});
test("ordinary and finished task rows never expose fake pause/resume controls or nested buttons", () => {
  for (const value of [
    job("running", false),
    job("completed"),
    job("failed"),
    job("cancelled"),
  ]) {
    const html = renderToStaticMarkup(<JobItem job={value} />);
    expect(html).not.toContain("暂停并保留分片");
    expect(html).not.toContain("恢复上传");
    expect(html).not.toContain("重试安全续传");
    let nesting = 0;
    for (const match of html.matchAll(/<button\b|<\/button>/g)) {
      if (match[0].startsWith("</")) nesting--;
      else {
        expect(nesting).toBe(0);
        nesting++;
      }
    }
    expect(nesting).toBe(0);
  }
});
test("durable cancellation intent exposes cleanup only and never claims a completed object was deleted", () => {
  for (const status of ["queued", "running"] as const)
    expect(
      resumableJobActions({ ...job(status), cancelRequested: true }),
    ).toEqual({ pause: false, resume: false, retry: false, cancel: false });
  for (const status of ["paused", "interrupted"] as const) {
    const value = { ...job(status), cancelRequested: true };
    expect(resumableJobActions(value)).toEqual({
      pause: false,
      resume: false,
      retry: true,
      cancel: false,
    });
    const html = renderToStaticMarkup(<JobItem job={value} />);
    expect(html).toContain("继续取消清理");
    expect(html).toContain("不会重新上传");
    expect(html).not.toContain('aria-label="恢复上传"');
    expect(html).not.toContain('aria-label="暂停并保留分片"');
    expect(html).not.toContain('aria-label="取消"');
  }
  const committed = { ...job("completed"), cancelRequested: true };
  const html = renderToStaticMarkup(<JobItem job={committed} />);
  expect(html).toContain("完成提交已确认");
  expect(html).toContain("未删除已完成对象");
  expect(html).not.toContain("已取消");
  useLocaleStore.getState().setLocale("en");
  const en = renderToStaticMarkup(
    <JobItem job={{ ...job("interrupted"), cancelRequested: true }} />,
  );
  expect(en).toContain("Continue cancellation cleanup");
  expect(en).toContain("never reuploads");
  expect(renderToStaticMarkup(<JobItem job={committed} />)).toContain(
    "did not delete the completed object",
  );
});
