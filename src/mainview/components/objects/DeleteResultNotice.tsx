import { localize, t, useT } from "@/lib/i18n";
import { toast } from "../common/Toast";
import {
  type DeleteSummary,
  deleteFailureDetails,
  summarizeDeleteResults,
} from "./delete-results";

export function DeleteFailureDetails({
  bucket,
  summary,
}: {
  bucket: string;
  summary: DeleteSummary;
}) {
  useT();
  return (
    <div className="space-y-2 text-xs">
      <p className="break-all">
        {t("原存储桶", "Original bucket")}: {bucket}
      </p>
      <p>
        {t(
          "以下对象未确认删除成功。请刷新核对；本界面不会自动重试。",
          "Deletion was not confirmed for these objects. Refresh and verify; this UI does not retry automatically.",
        )}
      </p>
      <ul
        className="max-h-48 space-y-2 overflow-y-auto pr-1"
        aria-label={t("删除失败明细", "Deletion failure details")}
      >
        {summary.failed.map((result) => (
          <li key={result.key} className="space-y-0.5">
            <span className="block select-text break-all font-mono">
              {result.key}
            </span>
            <span className="block select-text break-words text-foreground/70">
              {localize(result.error ?? "")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Show partial results, without retaining account credentials or exposing an
 * automatic destructive retry action. The only action copies safe details. */
export function showDeleteResults(
  keys: readonly string[],
  report: unknown,
  bucket: string,
): DeleteSummary {
  const summary = summarizeDeleteResults(keys, report);
  if (summary.results.length === 0) return summary;
  if (summary.failed.length === 0) {
    toast.success(
      t(
        `删除完成：成功 ${summary.succeeded}，失败 0`,
        `Deletion complete: ${summary.succeeded} succeeded, 0 failed`,
      ),
    );
    return summary;
  }
  const title = t(
    `删除结果：成功 ${summary.succeeded}，失败 ${summary.failed.length}`,
    `Deletion results: ${summary.succeeded} succeeded, ${summary.failed.length} failed`,
  );
  const options = {
    duration: Number.POSITIVE_INFINITY,
    description: <DeleteFailureDetails bucket={bucket} summary={summary} />,
    action: {
      label: t("复制失败明细", "Copy failure details"),
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(
            deleteFailureDetails(bucket, summary.failed),
          );
          toast.info(t("失败明细已复制", "Failure details copied"));
        } catch {
          toast.error(
            t(
              "复制失败，请在明细中选择文字后使用系统复制",
              "Copy failed. Select the details and use the system copy command",
            ),
          );
        }
      },
    },
  };
  if (summary.succeeded === 0) toast.error(title, options);
  else toast.warning(title, options);
  return summary;
}
