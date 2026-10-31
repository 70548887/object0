import { useEffect } from "react";
import { localize, useT } from "@/lib/i18n";
import { onEvent } from "@/lib/rpc-client";
import {
  useBucketStore,
  useJobStore,
  useObjectStore,
  useProfileStore,
  useUIStore,
} from "@/stores";

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
      updateFromProgress(data);
    });

    const unsubComplete = onEvent("job:complete", (data) => {
      updateFromComplete(data);

      // Desktop notification
      const notificationsEnabled = useUIStore.getState().desktopNotifications;
      if (notificationsEnabled && Notification.permission === "granted") {
        const title = data.success
          ? t("传输完成", "Transfer complete")
          : t("传输失败", "Transfer failed");
        const body = data.fileName
          ? `${data.fileName} — ${data.success ? t("已完成", "Completed") : data.error ? localize(data.error) : t("失败", "Failed")}`
          : data.success
            ? t("任务已成功完成", "Job completed successfully")
            : data.error
              ? localize(data.error)
              : t("任务失败", "Job failed");
        new Notification(title, { body, silent: true });
      }

      // Best-effort refresh: JobCompleteEvent carries no bucket/profile/type, so
      // we cannot tell whether this job touched the visible bucket. The
      // generation guard in loadObjects makes a possibly-irrelevant refresh safe.
      if (data.success) {
        const profileId = useProfileStore.getState().activeProfileId;
        const bucket = useBucketStore.getState().selectedBucket;
        const prefix = useObjectStore.getState().currentPrefix;
        if (profileId && bucket) {
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
