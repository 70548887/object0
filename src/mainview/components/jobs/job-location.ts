import type { JobInfo, JobLocation } from "@shared/job.types";
import { PROVIDER_LABELS } from "@shared/profile.types";
import { t } from "@/lib/i18n";

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : undefined;
}

/** Explicit allowlist: unknown IPC fields can never enter the copy payload. */
export function safeJobLocation(
  value: JobLocation | null | undefined,
): JobLocation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const profileId = text(value.profileId, 1024);
  const bucket = text(value.bucket, 1024);
  if (!profileId || !bucket) return undefined;
  const provider =
    typeof value.provider === "string" &&
    Object.keys(PROVIDER_LABELS).includes(value.provider)
      ? value.provider
      : undefined;
  return {
    profileId,
    bucket,
    ...(text(value.profileName, 4096)
      ? { profileName: value.profileName }
      : {}),
    ...(provider ? { provider } : {}),
    ...(typeof value.key === "string" && value.key.length <= 8192
      ? { key: value.key }
      : {}),
    ...(typeof value.prefix === "string" && value.prefix.length <= 8192
      ? { prefix: value.prefix }
      : {}),
  };
}

/** Preserve immutable known snapshots; legacy/partial events may only fill gaps. */
export function mergeJobLocation(
  known: JobLocation | null | undefined,
  incoming: JobLocation | null | undefined,
): JobLocation | undefined {
  const left = safeJobLocation(known);
  const right = safeJobLocation(incoming);
  if (!left) return right;
  if (
    !right ||
    left.profileId !== right.profileId ||
    left.bucket !== right.bucket ||
    (left.key !== undefined &&
      right.key !== undefined &&
      left.key !== right.key) ||
    (left.prefix !== undefined &&
      right.prefix !== undefined &&
      left.prefix !== right.prefix) ||
    (left.provider !== undefined &&
      right.provider !== undefined &&
      left.provider !== right.provider)
  )
    return left;
  return { ...right, ...left };
}

export function jobLocationSummary(
  job: Pick<JobInfo, "source" | "destination">,
): string {
  const summarize = (value: JobLocation) =>
    `${value.profileName ?? t("账号名称未记录", "Account name not recorded")} · ${value.bucket}`;
  const source = safeJobLocation(job.source);
  const destination = safeJobLocation(job.destination);
  if (source && destination)
    return `${summarize(source)} → ${summarize(destination)}`;
  if (destination) return `${t("目标", "To")}: ${summarize(destination)}`;
  if (source) return `${t("来源", "From")}: ${summarize(source)}`;
  return t(
    "历史任务未记录账号/位置",
    "Account/location was not recorded for this historical job",
  );
}

export function jobLocationRows(
  job: Pick<JobInfo, "source" | "destination">,
): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  for (const [side, raw] of [
    ["source", job.source],
    ["destination", job.destination],
  ] as const) {
    const value = safeJobLocation(raw);
    if (!value) continue;
    const sideLabel =
      side === "source" ? t("来源", "Source") : t("目标", "Destination");
    rows.push([
      `${sideLabel}${t("账号", " account")}`,
      value.profileName ?? t("名称未记录", "Name not recorded"),
    ]);
    rows.push([`${sideLabel}${t("账号 ID", " account ID")}`, value.profileId]);
    rows.push([
      `${sideLabel}${t("服务商", " provider")}`,
      value.provider
        ? PROVIDER_LABELS[value.provider]
        : t("未记录", "Not recorded"),
    ]);
    rows.push([`${sideLabel}${t("存储桶", " bucket")}`, value.bucket]);
    rows.push([
      `${sideLabel}${t("对象路径", " object path")}`,
      value.key !== undefined || value.prefix !== undefined
        ? `${value.bucket}/${value.key ?? value.prefix}`
        : t("未记录", "Not recorded"),
    ]);
  }
  return rows;
}

export function jobLocationCopyText(
  job: Pick<JobInfo, "source" | "destination">,
): string {
  return jobLocationRows(job)
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");
}
