import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  JobItem,
  resumableJobCopy,
} from "../src/mainview/components/jobs/JobItem";
import { useJobStore } from "../src/mainview/stores/useJobStore";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";
import type { JobInfo, JobStatus } from "../src/shared/job.types";

afterEach(() => {
  useLocaleStore.getState().setLocale("zh-CN");
  useJobStore.getState().resetJobs();
});

const download = (
  status: JobStatus,
  extra: Partial<JobInfo> = {},
): JobInfo => ({
  id: `download-fixture-${status}`,
  type: "download",
  status,
  resumable: true,
  attempt: 1,
  fileName: "fixture.bin",
  description: "Local fixture",
  bytesTransferred: 5,
  bytesTotal: 10,
  percentage: 50,
  speed: 0,
  eta: 0,
  createdAt: "2026-10-31T00:00:00Z",
  ...extra,
});

test("resumable download controls describe local checkpoints and Range, not uploaded parts", () => {
  const running = renderToStaticMarkup(<JobItem job={download("running")} />);
  expect(running).toContain('aria-label="暂停并保留下载断点"');
  expect(running).not.toContain("Pause and retain uploaded parts");
  const paused = renderToStaticMarkup(<JobItem job={download("paused")} />);
  expect(paused).toContain('aria-label="恢复下载"');
  expect(paused).toContain("本地下载断点");
  expect(paused).toContain("对象身份、Range 与临时文件");
  expect(paused).not.toContain("恢复上传");
  const interrupted = renderToStaticMarkup(
    <JobItem job={download("interrupted")} />,
  );
  expect(interrupted).toContain("重试安全下载恢复");
  const copy = resumableJobCopy("download");
  expect(copy.recovery).toContain("不会自动覆盖已有目标");
  expect(copy.cancellationConfirm).toContain("不删除已有目标或云端文件");
  expect(copy.cancellationConfirm).not.toContain("终止已确认的上传会话");
});

test("download cancellation retains explicit local-only cleanup and does not claim deleted cloud data", () => {
  const held = renderToStaticMarkup(
    <JobItem job={download("interrupted", { cancelRequested: true })} />,
  );
  expect(held).toContain("继续取消清理");
  expect(held).toContain("只清理本任务临时文件");
  expect(held).toContain("不会重新下载");
  expect(held).toContain("不删除目标或云端文件");
  expect(held).not.toContain("重新上传");
  expect(held).not.toContain('aria-label="恢复下载"');
  const active = renderToStaticMarkup(
    <JobItem job={download("running", { cancelRequested: true })} />,
  );
  expect(active).toContain("正在确认本地取消清理");
  const complete = renderToStaticMarkup(
    <JobItem job={download("completed", { cancelRequested: true })} />,
  );
  expect(complete).toContain("本地文件已完整交付");
  expect(complete).toContain("取消请求未删除目标或云端文件");
  expect(complete).not.toContain("完成提交已确认");
  expect(complete).not.toContain("已取消");
});

test("download pause, recovery and cancellation explanations switch to English", () => {
  useLocaleStore.getState().setLocale("en");
  const paused = renderToStaticMarkup(<JobItem job={download("paused")} />);
  expect(paused).toContain("Resume download");
  expect(paused).toContain("Range and the temporary file");
  expect(paused).toContain("no automatic download");
  const copy = resumableJobCopy("download");
  expect(copy.cancellationConfirm).toContain(
    "never existing destination or cloud files",
  );
  const complete = renderToStaticMarkup(
    <JobItem job={download("completed", { cancelRequested: true })} />,
  );
  expect(complete).toContain("The local file was fully delivered");
  expect(complete).not.toContain("The commit completed");
  const cleanup = renderToStaticMarkup(
    <JobItem job={download("interrupted", { cancelRequested: true })} />,
  );
  expect(cleanup).toContain("Continue cancellation cleanup");
  expect(cleanup).toContain("never redownloads");
});

test("ordinary downloads do not gain fake resumability and upload copy is unchanged", () => {
  for (const status of [
    "running",
    "paused",
    "interrupted",
    "completed",
  ] as const) {
    const html = renderToStaticMarkup(
      <JobItem job={download(status, { resumable: false })} />,
    );
    expect(html).not.toContain("暂停并保留下载断点");
    expect(html).not.toContain('aria-label="恢复下载"');
    expect(html).not.toContain("重试安全下载恢复");
    expect(html).not.toContain("已保留本地下载断点");
  }
  const copy = resumableJobCopy("upload");
  expect(copy.pauseLabel).toBe("暂停并保留分片");
  expect(copy.resumeLabel).toBe("恢复上传");
  expect(copy.cancellationConfirm).toContain("终止已确认的上传会话");
  expect(copy.completedAfterCancellationHint).toContain("完成提交已确认");
});
