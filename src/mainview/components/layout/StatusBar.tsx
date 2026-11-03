import { useOnlineStatus } from "@/hooks";
import { useBucketUsage } from "@/hooks/useBucketUsage";
import { formatBytes, formatSpeed } from "@/lib/formatters";
import { t, useT } from "@/lib/i18n";
import {
  IconBucket,
  IconCheckDouble,
  IconCircleUser,
  IconFolderOpen,
  IconWifi,
} from "@/lib/icons";
import {
  useBucketStore,
  useFolderSyncStore,
  useJobStore,
  useObjectStore,
  useProfileStore,
  useUIStore,
  useVaultStore,
} from "@/stores";
import { Progress } from "../ui/progress";
import { UpdateEntry } from "../updates/UpdateDialog";
import { BucketUsageStatus } from "./BucketUsageStatus";

export function StatusBar() {
  useT();
  const activeProfile = useProfileStore((s) => s.activeProfile);
  const profiles = useVaultStore((s) => s.profiles);
  const profile =
    profiles.find((item) => item.id === activeProfile?.id) ?? activeProfile;
  const bucket = useBucketStore((s) => s.selectedBucket);
  const objects = useObjectStore((s) => s.objects);
  const currentPrefix = useObjectStore((s) => s.currentPrefix);
  const selectedKeys = useObjectStore((s) => s.selectedKeys);
  const jobs = useJobStore((s) => s.jobs);
  const setJobPanelOpen = useUIStore((s) => s.setJobPanelOpen);
  const online = useOnlineStatus();
  const usage = useBucketUsage(profile, bucket, online);
  const folderSyncRules = useFolderSyncStore((s) => s.rules);
  const folderSyncStatuses = useFolderSyncStore((s) => s.statuses);
  const setFolderSyncPanelOpen = useUIStore((s) => s.setFolderSyncPanelOpen);

  const folderSyncActive = [...folderSyncStatuses.values()].filter(
    (s) => s.status === "watching" || s.status === "syncing",
  ).length;
  const folderSyncSyncing = [...folderSyncStatuses.values()].filter(
    (s) => s.status === "syncing",
  ).length;

  const runningJobs = jobs.filter((j) => j.status === "running");
  const queuedJobs = jobs.filter((j) => j.status === "queued");
  const activeCount = runningJobs.length + queuedJobs.length;

  // Aggregate progress across all running jobs
  const totalBytes = runningJobs.reduce((s, j) => s + (j.bytesTotal || 0), 0);
  const transferredBytes = runningJobs.reduce(
    (s, j) => s + (j.bytesTransferred || 0),
    0,
  );
  const aggregatePercent =
    totalBytes > 0 ? Math.round((transferredBytes / totalBytes) * 100) : 0;
  const aggregateSpeed = runningJobs.reduce((s, j) => s + (j.speed || 0), 0);

  const selectedSize = objects
    .filter((o) => selectedKeys.has(o.key))
    .reduce((sum, o) => sum + o.size, 0);

  // Depth indicator for prefix
  const prefixDepth = currentPrefix
    ? currentPrefix.split("/").filter(Boolean).length
    : 0;

  return (
    <div className="@container/statusbar flex h-8 min-w-0 shrink-0 items-center justify-between gap-2 border-border border-t bg-card px-2 text-[11px] text-foreground/55">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {!online && (
          <span
            className="flex shrink-0 items-center gap-1 text-warning"
            role="status"
          >
            <IconWifi className="size-3" />
            {t("离线", "Offline")}
          </span>
        )}
        {profile && (
          <span
            className="hidden min-w-0 max-w-28 shrink items-center gap-1 @[440px]/statusbar:inline-flex"
            title={profile.name}
          >
            <IconCircleUser className="size-3 shrink-0" />
            <span className="truncate">{profile.name}</span>
          </span>
        )}
        {bucket && (
          <span
            className="hidden min-w-0 max-w-28 shrink items-center gap-1 @[760px]/statusbar:inline-flex"
            title={`${bucket}${prefixDepth > 0 ? t(` · 当前目录深度 ${prefixDepth}`, ` · Current folder depth ${prefixDepth}`) : ""}`}
          >
            <IconBucket className="size-3 shrink-0" />
            <span className="truncate">{bucket}</span>
          </span>
        )}
        {bucket && profile && (
          <BucketUsageStatus
            key={`${profile.id}:${bucket}`}
            bucket={bucket}
            provider={profile.provider}
            online={online}
            {...usage}
          />
        )}
        {!bucket && (
          <span className="truncate text-foreground/40">
            {t("选择存储桶后显示用量", "Select a bucket to view usage")}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 @[1000px]/statusbar:gap-3">
        {selectedKeys.size > 0 && (
          <span
            className="whitespace-nowrap text-primary/70"
            role="status"
            aria-live="polite"
            title={t(
              `${selectedKeys.size} 个选中对象，当前列表大小合计 ${formatBytes(selectedSize)}`,
              `${selectedKeys.size} selected objects, total listed size ${formatBytes(selectedSize)}`,
            )}
          >
            <IconCheckDouble className="mr-0.5 inline size-3" />
            {selectedKeys.size}
            <span className="hidden @[1100px]/statusbar:inline">
              {" "}
              {t("已选择（", "selected (")}
              {formatBytes(selectedSize)}
              {t("）", ")")}
            </span>
          </span>
        )}
        {activeCount > 0 && (
          <button
            type="button"
            className="flex items-center gap-2 whitespace-nowrap text-info transition-colors hover:text-info/80"
            onClick={() => setJobPanelOpen(true)}
            title={t(
              `${activeCount} 个任务${runningJobs.length > 0 ? "运行中" : "排队中"}，点击查看任务`,
              `${activeCount} jobs ${runningJobs.length > 0 ? t("运行中", "running") : t("排队中", "queued")}. Click to view jobs`,
            )}
          >
            <span>
              {activeCount} {t("个任务", "jobs")}
              <span className="hidden @[1100px]/statusbar:inline">
                {" "}
                {runningJobs.length > 0
                  ? t("运行中", "running")
                  : t("排队中", "queued")}
              </span>
            </span>
            {runningJobs.length > 0 && totalBytes > 0 && (
              <span className="hidden items-center gap-2 @[1250px]/statusbar:inline-flex">
                <Progress value={aggregatePercent} className="h-1.5 w-20" />
                <span className="tabular-nums">{aggregatePercent}%</span>
                {aggregateSpeed > 0 && (
                  <span>{formatSpeed(aggregateSpeed)}</span>
                )}
              </span>
            )}
          </button>
        )}
        {folderSyncRules.length > 0 && (
          <button
            type="button"
            className={`flex items-center gap-1 transition-colors ${
              folderSyncSyncing > 0
                ? "text-info"
                : folderSyncActive > 0
                  ? "text-success/70"
                  : "text-foreground/40"
            } hover:text-primary`}
            onClick={() => setFolderSyncPanelOpen(true)}
            title={t(
              `实时文件夹同步：${folderSyncActive} 条已启用`,
              `Live folder sync: ${folderSyncActive} enabled rules`,
            )}
          >
            <IconFolderOpen
              className={`size-3 ${folderSyncSyncing > 0 ? "animate-pulse" : ""}`}
            />
            <span className="hidden whitespace-nowrap @[1150px]/statusbar:inline">
              {folderSyncSyncing > 0
                ? t(
                    `正在同步 ${folderSyncSyncing} 个文件夹`,
                    `Syncing ${folderSyncSyncing} folders`,
                  )
                : t(
                    `${folderSyncActive} 个实时同步`,
                    `${folderSyncActive} live sync rules`,
                  )}
            </span>
          </button>
        )}
        <UpdateEntry compact />
      </div>
    </div>
  );
}
