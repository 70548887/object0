import { useEffect } from "react";
import { localize, useT } from "@/lib/i18n";
import { onEvent } from "@/lib/rpc-client";
import {
  useBucketStore,
  useJobStore,
  useObjectStore,
  useProfileStore,
  useUIStore,
  useVaultStore,
} from "@/stores";
import { wasClearedJobAttempt } from "@/stores/useJobStore";

/**
 * Subscribes to job:progress and job:complete events from the Bun process
 * and updates the job store accordingly. Auto-refreshes object listing
 * when a job that modifies the bucket completes. Sends desktop notifications
 * on completion when enabled.
 */
export function useJobProgress() {
  const t = useT();
  const updateFromProgress = useJobStore((s) => s.updateFromProgress);
  const updateFromComplete = useJobStore((s) => s.updateFromComplete);

  useEffect(() => {
    const unsubProgress = onEvent("job:progress", (data) => {
      if (!useVaultStore.getState().unlocked) return;
      if (wasClearedJobAttempt(data.jobId, data.attempt)) return;
      updateFromProgress(data);
    });

    const unsubComplete = onEvent("job:complete", (data) => {
      if (!useVaultStore.getState().unlocked) return;
      if (wasClearedJobAttempt(data.jobId, data.attempt)) return;
      const previous = useJobStore
        .getState()
        .jobs.find((job) => job.id === data.jobId);
      if (previous && (data.attempt ?? 0) < (previous.attempt ?? 0)) return;
      updateFromComplete(data);
      const status =
        useJobStore.getState().jobs.find((job) => job.id === data.jobId)
          ?.status ??
        data.status ??
        (data.success ? "completed" : "failed");
      if (status !== "completed" && status !== "failed") return;
      if (data.status && data.status !== status) return;
      if (status === "completed" && !data.success) return;
      const completed = status === "completed" && data.success;

      // Desktop notification
      const notificationsEnabled = useUIStore.getState().desktopNotifications;
      if (notificationsEnabled && Notification.permission === "granted") {
        const title = completed
          ? t("传输完成", "Transfer complete")
          : t("传输失败", "Transfer failed");
        const body = data.fileName
          ? `${data.fileName} — ${completed ? t("已完成", "Completed") : data.error ? localize(data.error) : t("失败", "Failed")}`
          : completed
            ? t("任务已成功完成", "Job completed successfully")
            : data.error
              ? localize(data.error)
              : t("任务失败", "Job failed");
        new Notification(title, { body, silent: true });
      }

      // New native events carry their scope. Legacy events remain best-effort;
      // loadObjects still rejects a response after a later navigation.
      if (completed) {
        const profileId = useProfileStore.getState().activeProfileId;
        const bucket = useBucketStore.getState().selectedBucket;
        const prefix = useObjectStore.getState().currentPrefix;
        const scopeMatches =
          (!data.profileId || data.profileId === profileId) &&
          (!data.bucket || data.bucket === bucket);
        if (profileId && bucket && scopeMatches) {
          useObjectStore.getState().loadObjects(profileId, bucket, prefix);
        }
      }
    });

    // Request notification permission once
    if (
      useUIStore.getState().desktopNotifications &&
      Notification.permission === "default"
    ) {
      Notification.requestPermission();
    }

    return () => {
      unsubProgress();
      unsubComplete();
    };
  }, [updateFromProgress, updateFromComplete, t]);
}
