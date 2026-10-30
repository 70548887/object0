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
import { IconFolderOpen, IconSpinner } from "@/lib/icons";
import { rpcCall } from "@/lib/rpc-client";
import { useFolderSyncStore, useVaultStore } from "@/stores";
import { toast } from "../common/Toast";

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

  const loadBuckets = useCallback(async (pid: string) => {
    setLoadingBuckets(true);
    try {
      const result = await rpcCall("buckets:list", { profileId: pid });
      setBuckets(result.map((b) => b.name));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "未知错误");
    }
    setLoadingBuckets(false);
  }, []);

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
    if (!profileId || !bucket || !localPath) {
      toast.error("请填写所有必填项");
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
        toast.success("同步规则已更新");
      } else {
        await addRule(input);
        toast.success("同步规则已创建");
      }
      onDone();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "未知错误");
    }
    setSaving(false);
  };

  return (
    <div className="space-y-3">
      <div className="rounded border border-success/30 bg-success/10 p-2 text-xs">
        <p className="font-semibold text-success">实时同步规则</p>
        <p className="text-foreground/70">
          在后台持续同步本地文件夹和 S3 路径。
        </p>
      </div>

      {/* Profile */}
      <div className="space-y-1.5">
        <Label className="text-xs">存储账号</Label>
        <Select
          value={profileId}
          onValueChange={(v) => {
            if (v == null) return;
            setProfileId(v);
            setBucket("");
          }}
        >
          <SelectTrigger size="sm" className="w-full">
            <SelectValue placeholder={"选择存储账号..."}>
              {(value) =>
                profiles.find((p) => p.id === value)?.name ?? (value as string)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {profiles.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Bucket */}
      <div className="space-y-1.5">
        <Label className="text-xs">存储桶</Label>
        <Select
          value={bucket}
          onValueChange={(v) => {
            if (v != null) setBucket(v);
          }}
          disabled={!profileId || loadingBuckets}
        >
          <SelectTrigger size="sm" className="w-full">
            <SelectValue
              placeholder={loadingBuckets ? "正在加载..." : "选择存储桶..."}
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
        <Label className="text-xs">存储桶路径前缀（可选）</Label>
        <Input
          className="h-7 text-xs w-full"
          placeholder={"例如 photos/，留空表示整个存储桶"}
          value={bucketPrefix}
          onChange={(e) => setBucketPrefix(e.target.value)}
        />
      </div>

      {/* Local folder */}
      <div className="space-y-1.5">
        <Label className="text-xs">本地文件夹</Label>
        <div className="flex gap-2">
          <Input
            className="h-7 text-xs flex-1"
            placeholder="/path/to/folder"
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
          />
          <Button variant="outline" size="sm" onClick={handlePickFolder}>
            <IconFolderOpen className="size-3.5" />
            浏览
          </Button>
        </div>
      </div>

      {/* Direction */}
      <div className="space-y-1.5">
        <Label className="text-xs">同步方向（持续规则）</Label>
        <Select
          value={direction}
          onValueChange={(v) => {
            if (v != null) setDirection(v as SyncDirection);
          }}
        >
          <SelectTrigger size="sm" className="w-full">
            <SelectValue>
              {(value) => {
                const labels: Record<string, string> = {
                  bidirectional: "双向同步",
                  "local-to-remote": "仅上传：本地 → 远端",
                  "remote-to-local": "仅下载：远端 → 本地",
                };
                return labels[value as string] ?? (value as string);
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="bidirectional">双向同步</SelectItem>
            <SelectItem value="local-to-remote">仅上传：本地 → 远端</SelectItem>
            <SelectItem value="remote-to-local">仅下载：远端 → 本地</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Conflict resolution */}
      <div className="space-y-1.5">
        <Label className="text-xs">冲突处理</Label>
        <Select
          value={conflictResolution}
          onValueChange={(v) => {
            if (v != null) setConflictResolution(v as ConflictResolution);
          }}
        >
          <SelectTrigger size="sm" className="w-full">
            <SelectValue>
              {(value) => {
                const labels: Record<string, string> = {
                  "newer-wins": "保留较新的文件（比较时间）",
                  "local-wins": "始终以本地为准",
                  "remote-wins": "始终以远端为准",
                  "keep-both": "两者都保留（标记冲突）",
                };
                return labels[value as string] ?? (value as string);
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newer-wins">
              保留较新的文件（比较时间）
            </SelectItem>
            <SelectItem value="local-wins">始终以本地为准</SelectItem>
            <SelectItem value="remote-wins">始终以远端为准</SelectItem>
            <SelectItem value="keep-both">两者都保留（标记冲突）</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Poll interval */}
      <div className="space-y-1.5">
        <Label className="text-xs">检查远端更新的间隔</Label>
        <Select
          value={String(pollIntervalMs)}
          onValueChange={(v) => {
            if (v != null) setPollIntervalMs(Number(v));
          }}
        >
          <SelectTrigger size="sm" className="w-full">
            <SelectValue>
              {(value) => {
                const labels: Record<string, string> = {
                  "15000": "15 seconds",
                  "30000": "30 seconds",
                  "60000": "1 minute",
                  "300000": "5 minutes",
                  "600000": "10 minutes",
                  "1800000": "30 minutes",
                };
                return labels[value as string] ?? (value as string);
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="15000">15 秒</SelectItem>
            <SelectItem value="30000">30 秒</SelectItem>
            <SelectItem value="60000">1 分钟</SelectItem>
            <SelectItem value="300000">5 分钟</SelectItem>
            <SelectItem value="600000">10 分钟</SelectItem>
            <SelectItem value="1800000">30 分钟</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Exclude patterns */}
      <div className="space-y-1.5">
        <Label className="text-xs">排除规则（每行一条）</Label>
        <Textarea
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
          取消
        </Button>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={saving || !profileId || !bucket || !localPath}
        >
          {saving ? (
            <IconSpinner className="size-3.5 animate-spin" />
          ) : editRule ? (
            "保存修改"
          ) : (
            "创建规则"
          )}
        </Button>
      </div>
    </div>
  );
}
