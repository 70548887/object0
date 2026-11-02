import type {
  ConflictResolution,
  FolderSyncRule,
  FolderSyncRuleInput,
  SyncDirection,
} from "@shared/folder-sync.types";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { localize, useT } from "@/lib/i18n";
import { IconFolderOpen, IconSpinner } from "@/lib/icons";
import { rpcCall } from "@/lib/rpc-client";
import { useFolderSyncStore, useVaultStore } from "@/stores";
import { toast } from "../common/Toast";
import { qiniuUnfinishedTransferReason } from "../objects/qiniu-transfer-gates";

const DEFAULT_POLL_INTERVAL_MS = 30000;
const DEFAULT_EXCLUDE_PATTERNS = [
  ".DS_Store",
  "Thumbs.db",
  ".object0-tmp",
  "desktop.ini",
];

interface FolderSyncRuleEditorProps {
  editRule?: FolderSyncRule;
  onDone: () => void;
}

export function FolderSyncRuleEditor({
  editRule,
  onDone,
}: FolderSyncRuleEditorProps) {
  const t = useT();
  const profiles = useVaultStore((s) => s.profiles);
  const addRule = useFolderSyncStore((s) => s.addRule);
  const updateRule = useFolderSyncStore((s) => s.updateRule);
  const pickFolder = useFolderSyncStore((s) => s.pickFolder);

  const [profileId, setProfileId] = useState(editRule?.profileId ?? "");
  const [bucket, setBucket] = useState(editRule?.bucket ?? "");
  const [bucketPrefix, setBucketPrefix] = useState(
    editRule?.bucketPrefix ?? "",
  );
  const [localPath, setLocalPath] = useState(editRule?.localPath ?? "");
  const [direction, setDirection] = useState<SyncDirection>(
    editRule?.direction ?? "bidirectional",
  );
  const [conflictResolution, setConflictResolution] =
    useState<ConflictResolution>(editRule?.conflictResolution ?? "newer-wins");
  const [pollIntervalMs, setPollIntervalMs] = useState(
    editRule?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  );
  const [excludePatterns, setExcludePatterns] = useState(
    editRule?.excludePatterns?.join("\n") ??
      DEFAULT_EXCLUDE_PATTERNS.join("\n"),
  );

  const [buckets, setBuckets] = useState<string[]>([]);
  const [loadingBuckets, setLoadingBuckets] = useState(false);
  const [saving, setSaving] = useState(false);
  const syncBlocked = qiniuUnfinishedTransferReason(
    profiles.find((p) => p.id === profileId),
    "sync",
  );

  const loadBuckets = useCallback(
    async (pid: string) => {
      if (profiles.find((p) => p.id === pid)?.provider === "qiniu") {
        setBuckets([]);
        return;
      }
      setLoadingBuckets(true);
      try {
        const result = await rpcCall("buckets:list", { profileId: pid });
        setBuckets(result.map((b) => b.name));
      } catch (err: unknown) {
        toast.error(
          err instanceof Error
            ? localize(err.message)
            : t("未知错误", "Unknown error"),
        );
      }
      setLoadingBuckets(false);
    },
    [t, profiles],
  );

  useEffect(() => {
    if (profileId) {
      loadBuckets(profileId);
    }
  }, [profileId, loadBuckets]);

  const handlePickFolder = async () => {
    const path = await pickFolder();
    if (path) setLocalPath(path);
  };

  const handleSave = async () => {
    if (syncBlocked) return toast.warning(syncBlocked);
    if (!profileId || !bucket || !localPath) {
      toast.error(t("请填写所有必填项", "Please fill in all required fields"));
      return;
    }

    setSaving(true);
    try {
      const input: FolderSyncRuleInput = {
        profileId,
        bucket,
        bucketPrefix,
        localPath,
        direction,
        conflictResolution,
        pollIntervalMs,
        excludePatterns: excludePatterns
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      };

      if (editRule) {
        await updateRule({ ...input, id: editRule.id });
        toast.success(t("同步规则已更新", "Sync rule updated"));
      } else {
        await addRule(input);
        toast.success(t("同步规则已创建", "Sync rule created"));
      }
      onDone();
    } catch (err: unknown) {
      toast.error(
        err instanceof Error
          ? localize(err.message)
          : t("未知错误", "Unknown error"),
      );
    }
    setSaving(false);
  };

  return (
    <div className="space-y-3">
      {syncBlocked && (
        <p role="note" className="text-warning text-xs">
          {syncBlocked}
        </p>
      )}
      <div className="rounded border border-success/30 bg-success/10 p-2 text-xs">
        <p className="font-semibold text-success">
          {t("实时同步规则", "Live sync rule")}
        </p>
        <p className="text-foreground/70">
          {t(
            "在后台持续同步本地文件夹和 S3 路径。",
            "Continuously sync a local folder and an S3 prefix in the background.",
          )}
        </p>
      </div>

      {/* Profile */}
      <div className="space-y-1.5">
        <Label className="text-xs">{t("存储账号", "Storage account")}</Label>
        <Select
          value={profileId}
          onValueChange={(v) => {
            if (v == null) return;
            const reason = qiniuUnfinishedTransferReason(
              profiles.find((p) => p.id === v),
              "sync",
            );
            if (reason) return toast.warning(reason);
            setProfileId(v);
            setBucket("");
          }}
        >
          <SelectTrigger
            aria-label={t("存储账号", "Storage account")}
            size="sm"
            className="w-full"
          >
            <SelectValue
              placeholder={t("选择存储账号...", "Select a storage account...")}
            >
              {(value) =>
                profiles.find((p) => p.id === value)?.name ?? (value as string)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {profiles.map((p) => (
              <SelectItem
                key={p.id}
                value={p.id}
                disabled={p.provider === "qiniu"}
                title={qiniuUnfinishedTransferReason(p, "sync") ?? undefined}
              >
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Bucket */}
      <div className="space-y-1.5">
        <Label className="text-xs">{t("存储桶", "Bucket")}</Label>
        <Select
          value={bucket}
          onValueChange={(v) => {
            if (v != null) setBucket(v);
          }}
          disabled={!profileId || loadingBuckets}
        >
          <SelectTrigger
            aria-label={t("存储桶", "Bucket")}
            size="sm"
            className="w-full"
          >
            <SelectValue
              placeholder={
                loadingBuckets
                  ? t("正在加载...", "Loading...")
                  : t("选择存储桶...", "Select a bucket...")
              }
            >
              {(value) => value as string}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {buckets.map((b) => (
              <SelectItem key={b} value={b}>
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Bucket prefix */}
      <div className="space-y-1.5">
        <Label className="text-xs">
          {t("存储桶路径前缀（可选）", "Bucket prefix (optional)")}
        </Label>
        <Input
          aria-label={t("存储桶路径前缀（可选）", "Bucket prefix (optional)")}
          className="h-7 text-xs w-full"
          placeholder={t(
            "例如 photos/，留空表示整个存储桶",
            "For example, photos/; leave blank for the entire bucket",
          )}
          value={bucketPrefix}
          onChange={(e) => setBucketPrefix(e.target.value)}
        />
      </div>

      {/* Local folder */}
      <div className="space-y-1.5">
        <Label className="text-xs">{t("本地文件夹", "Local folder")}</Label>
        <div className="flex gap-2">
          <Input
            aria-label={t("本地文件夹", "Local folder")}
            className="h-7 text-xs flex-1"
            placeholder="/path/to/folder"
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
          />
          <Button variant="outline" size="sm" onClick={handlePickFolder}>
            <IconFolderOpen className="size-3.5" />
            {t("浏览", "Browse")}
          </Button>
        </div>
      </div>

      {/* Direction */}
      <div className="space-y-1.5">
        <Label className="text-xs">
          {t("同步方向（持续规则）", "Sync direction (continuous rule)")}
        </Label>
        <Select
          value={direction}
          onValueChange={(v) => {
            if (v != null) setDirection(v as SyncDirection);
          }}
        >
          <SelectTrigger
            aria-label={t(
              "同步方向（持续规则）",
              "Sync direction (continuous rule)",
            )}
            size="sm"
            className="w-full"
          >
            <SelectValue>
              {(value) => {
                const labels: Record<string, string> = {
                  bidirectional: t("双向同步", "Bidirectional"),
                  "local-to-remote": t(
                    "仅上传：本地 → 远端",
                    "Upload only: local → remote",
                  ),
                  "remote-to-local": t(
                    "仅下载：远端 → 本地",
                    "Download only: remote → local",
                  ),
                };
                return labels[value as string] ?? (value as string);
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="bidirectional">
              {t("双向同步", "Bidirectional")}
            </SelectItem>
            <SelectItem value="local-to-remote">
              {t("仅上传：本地 → 远端", "Upload only: local → remote")}
            </SelectItem>
            <SelectItem value="remote-to-local">
              {t("仅下载：远端 → 本地", "Download only: remote → local")}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Conflict resolution */}
      <div className="space-y-1.5">
        <Label className="text-xs">
          {t("冲突处理", "Conflict resolution")}
        </Label>
        <Select
          value={conflictResolution}
          onValueChange={(v) => {
            if (v != null) setConflictResolution(v as ConflictResolution);
          }}
        >
          <SelectTrigger
            aria-label={t("冲突处理", "Conflict resolution")}
            size="sm"
            className="w-full"
          >
            <SelectValue>
              {(value) => {
                const labels: Record<string, string> = {
                  "newer-wins": t(
                    "保留较新的文件（比较时间）",
                    "Keep the newer file (compare timestamps)",
                  ),
                  "local-wins": t("始终以本地为准", "Always prefer local"),
                  "remote-wins": t("始终以远端为准", "Always prefer remote"),
                  "keep-both": t(
                    "两者都保留（标记冲突）",
                    "Keep both (mark conflicts)",
                  ),
                };
                return labels[value as string] ?? (value as string);
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newer-wins">
              {t(
                "保留较新的文件（比较时间）",
                "Keep the newer file (compare timestamps)",
              )}
            </SelectItem>
            <SelectItem value="local-wins">
              {t("始终以本地为准", "Always prefer local")}
            </SelectItem>
            <SelectItem value="remote-wins">
              {t("始终以远端为准", "Always prefer remote")}
            </SelectItem>
            <SelectItem value="keep-both">
              {t("两者都保留（标记冲突）", "Keep both (mark conflicts)")}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Poll interval */}
      <div className="space-y-1.5">
        <Label className="text-xs">
          {t("检查远端更新的间隔", "Check remote changes every")}
        </Label>
        <Select
          value={String(pollIntervalMs)}
          onValueChange={(v) => {
            if (v != null) setPollIntervalMs(Number(v));
          }}
        >
          <SelectTrigger
            aria-label={t("检查远端更新的间隔", "Check remote changes every")}
            size="sm"
            className="w-full"
          >
            <SelectValue>
              {(value) => {
                const labels: Record<string, string> = {
                  "15000": t("15 秒", "15 seconds"),
                  "30000": t("30 秒", "30 seconds"),
                  "60000": t("1 分钟", "1 minute"),
                  "300000": t("5 分钟", "5 minutes"),
                  "600000": t("10 分钟", "10 minutes"),
                  "1800000": t("30 分钟", "30 minutes"),
                };
                return labels[value as string] ?? (value as string);
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="15000">{t("15 秒", "15 seconds")}</SelectItem>
            <SelectItem value="30000">{t("30 秒", "30 seconds")}</SelectItem>
            <SelectItem value="60000">{t("1 分钟", "1 minute")}</SelectItem>
            <SelectItem value="300000">{t("5 分钟", "5 minutes")}</SelectItem>
            <SelectItem value="600000">{t("10 分钟", "10 minutes")}</SelectItem>
            <SelectItem value="1800000">
              {t("30 分钟", "30 minutes")}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Exclude patterns */}
      <div className="space-y-1.5">
        <Label className="text-xs">
          {t("排除规则（每行一条）", "Exclude patterns (one per line)")}
        </Label>
        <Textarea
          aria-label={t(
            "排除规则（每行一条）",
            "Exclude patterns (one per line)",
          )}
          className="font-mono text-xs w-full"
          rows={4}
          placeholder={".DS_Store\nThumbs.db\n.git/**\nnode_modules/**"}
          value={excludePatterns}
          onChange={(e) => setExcludePatterns(e.target.value)}
        />
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" size="sm" onClick={onDone}>
          {t("取消", "Cancel")}
        </Button>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={
            !!syncBlocked || saving || !profileId || !bucket || !localPath
          }
          title={syncBlocked ?? undefined}
        >
          {saving ? (
            <IconSpinner className="size-3.5 animate-spin" />
          ) : editRule ? (
            t("保存修改", "Save changes")
          ) : (
            t("创建规则", "Create rule")
          )}
        </Button>
      </div>
    </div>
  );
}
