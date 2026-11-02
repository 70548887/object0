import { t } from "@/lib/i18n";

export function parseQiniuStorageType(
  storageClass?: string,
): number | undefined {
  const match = /^qiniu:(\d+)$/.exec(storageClass ?? "");
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function qiniuStorageTypeLabel(storageType?: number): string {
  switch (storageType) {
    case 0:
      return t("标准", "Standard");
    case 1:
      return t("低频", "Infrequent access");
    case 2:
      return t("归档", "Archive");
    case 3:
      return t("深度归档", "Deep archive");
    case 4:
      return t("归档直读", "Archive instant retrieval");
    case 5:
      return t("智能分层", "Intelligent tiering");
    default:
      return t("未知类型", "Unknown type");
  }
}

export function qiniuRestoreInfo(
  storageType: number | undefined,
  restoreStatus: number | undefined,
  source: "list" | "stat",
): { label: string; hint: string } {
  if (storageType === undefined) {
    return {
      label: t("未知", "Unknown"),
      hint: t(
        "未取得存储类型，无法确认恢复状态。",
        "Storage type is unavailable, so the restore state cannot be determined.",
      ),
    };
  }
  if (storageType !== 2 && storageType !== 3) {
    return {
      label: t("正常", "Normal"),
      hint: t(
        "此存储类型不需要归档解冻。",
        "This storage type does not require archive restoration.",
      ),
    };
  }
  if (restoreStatus === undefined) {
    return source === "stat"
      ? {
          label: t("冻结", "Frozen"),
          hint: t(
            "归档详情未返回恢复状态时，按未解冻处理。",
            "An archive object without a restore status in its details is treated as frozen.",
          ),
        }
      : {
          label: t("请查看详情", "Check details"),
          hint: t(
            "列表未返回恢复状态，请打开详情确认；不能据此断定文件冻结。",
            "The listing did not return a restore state. Open details to confirm; this alone does not mean the object is frozen.",
          ),
        };
  }
  if (restoreStatus === 1)
    return {
      label: t("解冻中", "Restoring"),
      hint: t(
        "解冻尚未完成，文件仍可能无法读取。",
        "Restoration has not completed; the object may still be unreadable.",
      ),
    };
  if (restoreStatus === 2)
    return {
      label: t("已解冻", "Restored"),
      hint: t(
        "当前详情显示文件已解冻，后续状态以服务端为准。",
        "The current details report a restored object. Subsequent state is determined by the service.",
      ),
    };
  return {
    label: t("未知", "Unknown"),
    hint: t(
      "服务返回了未知的恢复状态值，请刷新详情后重试。",
      "The service returned an unknown restore status. Refresh the details and retry.",
    ),
  };
}
