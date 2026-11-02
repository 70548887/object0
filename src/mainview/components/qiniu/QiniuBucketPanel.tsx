import type { ProfileInfo } from "@shared/profile.types";
import type { QiniuBucketContext, QiniuRegionInfo } from "@shared/qiniu.types";
import type { RPCSchema } from "@shared/rpc-schema";
import type { ObjectListRes } from "@shared/s3.types";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { localize, t, useT } from "@/lib/i18n";
import { IconArrowsRotate, IconSpinner } from "@/lib/icons";
import { rpcCall } from "@/lib/rpc-client";
import { useProfileStore } from "@/stores";
import {
  canAttemptQiniuBucketAction,
  isValidQiniuBucketName,
  QiniuBucketActions,
} from "./QiniuBucketActions";
import type { QiniuCapability, QiniuRegionOption } from "./types";

type PanelMethod =
  | "qiniu:regions"
  | "qiniu:bucket-context"
  | "objects:list"
  | "qiniu:bucket-create"
  | "qiniu:bucket-delete"
  | "qiniu:bucket-remark";
export type QiniuBucketPanelRPC = <M extends PanelMethod>(
  method: M,
  input: RPCSchema[M]["req"],
) => Promise<RPCSchema[M]["res"]>;
type Action = "create" | "remove" | "remark";
type ErrorArea = "regions" | "context" | "emptiness" | "refresh";

export interface QiniuBucketPanelState {
  scopeId: string;
  loading: boolean;
  pending: boolean;
  regions: QiniuRegionOption[];
  context: QiniuBucketContext | null;
  emptyState: "empty" | "not-empty" | "unknown";
  capabilities: Record<Action, QiniuCapability>;
  errors: { area: ErrorArea; message: string }[];
  notice: { action: Action; name: string } | null;
}

function unknownPermission(): QiniuCapability {
  return {
    state: "unknown",
    reason: t(
      "空间管理权限尚未确认。可提交验证尝试，是否允许由服务端最终校验。",
      "Bucket-management permission is unverified. You may submit a verification attempt; the server makes the final authorization decision.",
    ),
  };
}
function initialState(scopeId: string): QiniuBucketPanelState {
  return {
    scopeId,
    loading: false,
    pending: false,
    regions: [],
    context: null,
    emptyState: "unknown",
    capabilities: {
      create: unknownPermission(),
      remove: unknownPermission(),
      remark: unknownPermission(),
    },
    errors: [],
    notice: null,
  };
}
function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return t(
    "无法取得空间信息，请重试。",
    "Could not load bucket information. Please retry.",
  );
}
export function classifyQiniuBucketFailure(error: unknown): QiniuCapability {
  const reason = messageOf(error);
  const state = /\[permission-denied\]|HTTP\s*(401|403)\b/i.test(reason)
    ? "forbidden"
    : /\[unsupported(?:-api)?\]|HTTP\s*(404|405|501)\b/i.test(reason)
      ? "unsupported"
      : /\[unknown\]|\[capability-unknown\]/i.test(reason)
        ? "unknown"
        : "unavailable";
  return { state, reason };
}
export function classifyQiniuBucketEmptiness(
  result: ObjectListRes,
): QiniuBucketPanelState["emptyState"] {
  if (!Array.isArray(result.objects) || !Array.isArray(result.prefixes))
    return "unknown";
  if (result.objects.length > 0 || result.prefixes.length > 0)
    return "not-empty";
  return result.isTruncated === false ? "empty" : "unknown";
}
function nativeRegions(regions: QiniuRegionInfo[]): QiniuRegionOption[] {
  const options = new Map<string, QiniuRegionOption>();
  for (const region of regions) {
    if (
      region?.kodoRegionId &&
      region.s3RegionId &&
      Array.isArray(region.rsUrls) &&
      region.rsUrls.length > 0
    ) {
      // The create RPC accepts the S3 alias, then resolves its distinct native
      // Kodo region ID for /mkbucketv3. Never send z0 as cn-east-1.
      options.set(region.s3RegionId, {
        id: region.s3RegionId,
        label: region.label || region.kodoRegionId,
      });
    }
  }
  return [...options.values()];
}
function unsupportedNative(): QiniuCapability {
  return {
    state: "unsupported",
    reason: t(
      "当前空间或区域没有已确认的七牛原生管理端点，此操作未启用。",
      "No native Qiniu management endpoint has been confirmed for this bucket or region; this action is unavailable.",
    ),
  };
}

/** Scope-guarded RPC orchestration, separately testable without rendering or
 * account secrets. No read success is treated as proof of write permission. */
export function createQiniuBucketPanelController(options: {
  scopeId: string;
  profileId: string;
  bucketName: string | null;
  call: QiniuBucketPanelRPC;
  isCurrent: () => boolean;
  onState: (state: QiniuBucketPanelState) => void;
  refreshBuckets: (profileId: string) => Promise<void>;
  onRemoved?: (profileId: string, bucket: string) => void;
}) {
  let state = initialState(options.scopeId);
  let disposed = false;
  let loadGeneration = 0;
  const current = () => !disposed && options.isCurrent();
  const update = (changes: Partial<QiniuBucketPanelState>) => {
    if (!current()) return;
    state = { ...state, ...changes };
    options.onState(state);
  };
  const requireCurrent = () => {
    if (!current())
      throw new Error(
        t(
          "账号或空间已改变，请重新打开管理面板。",
          "The account or bucket changed. Reopen the management panel.",
        ),
      );
  };
  const load = async () => {
    if (!current()) return;
    const generation = ++loadGeneration;
    update({ loading: true, emptyState: "unknown", errors: [] });
    const results = await Promise.allSettled([
      options.call("qiniu:regions", { profileId: options.profileId }),
      options.bucketName
        ? options.call("qiniu:bucket-context", {
            profileId: options.profileId,
            bucket: options.bucketName,
          })
        : Promise.resolve(null),
      options.bucketName
        ? options.call("objects:list", {
            profileId: options.profileId,
            bucket: options.bucketName,
            prefix: "",
            maxKeys: 1,
          })
        : Promise.resolve(null),
    ] as const);
    if (!current() || generation !== loadGeneration) return;
    const errors: QiniuBucketPanelState["errors"] = [];
    const regionResult = results[0];
    const regionOptions =
      regionResult.status === "fulfilled" && Array.isArray(regionResult.value)
        ? nativeRegions(regionResult.value)
        : [];
    const malformedRegions =
      regionResult.status === "fulfilled" && !Array.isArray(regionResult.value);
    const capabilities: QiniuBucketPanelState["capabilities"] = {
      create:
        regionResult.status === "rejected"
          ? classifyQiniuBucketFailure(regionResult.reason)
          : malformedRegions
            ? {
                state: "unavailable",
                reason: t(
                  "区域响应格式无效，创建空间已禁用。",
                  "The region response is invalid; bucket creation is disabled.",
                ),
              }
            : regionOptions.length > 0
              ? unknownPermission()
              : unsupportedNative(),
      remove: unknownPermission(),
      remark: unknownPermission(),
    };
    if (regionResult.status === "rejected")
      errors.push({ area: "regions", message: messageOf(regionResult.reason) });
    let context: QiniuBucketContext | null = null;
    const contextResult = results[1];
    if (contextResult.status === "fulfilled" && contextResult.value) {
      if (contextResult.value.bucket?.name !== options.bucketName) {
        const error = t(
          "空间信息与当前选择不一致，操作已禁用。",
          "Bucket information does not match the current selection; actions are disabled.",
        );
        capabilities.remove = { state: "unavailable", reason: error };
        capabilities.remark = { state: "unavailable", reason: error };
        errors.push({ area: "context", message: error });
      } else {
        context = contextResult.value;
        const native =
          context.backendMode === "kodo" &&
          Array.isArray(context.region?.rsUrls) &&
          context.region.rsUrls.length > 0;
        if (!native) {
          capabilities.remove = unsupportedNative();
          capabilities.remark = unsupportedNative();
        } else if (context.bucket.permission === "readonly") {
          const forbidden: QiniuCapability = {
            state: "forbidden",
            reason: t(
              "当前空间授权为只读，管理写操作已禁用。",
              "The bucket grant is read-only; management writes are disabled.",
            ),
          };
          capabilities.remove = forbidden;
          capabilities.remark = forbidden;
        }
      }
    } else if (contextResult.status === "rejected") {
      capabilities.remove = classifyQiniuBucketFailure(contextResult.reason);
      capabilities.remark = classifyQiniuBucketFailure(contextResult.reason);
      errors.push({
        area: "context",
        message: messageOf(contextResult.reason),
      });
    }
    let emptyState: QiniuBucketPanelState["emptyState"] = "unknown";
    const emptyResult = results[2];
    if (emptyResult.status === "fulfilled" && emptyResult.value)
      emptyState = classifyQiniuBucketEmptiness(emptyResult.value);
    else if (emptyResult.status === "rejected")
      errors.push({
        area: "emptiness",
        message: messageOf(emptyResult.reason),
      });
    update({
      regions: regionOptions,
      context,
      capabilities,
      emptyState,
      errors,
      loading: false,
    });
  };
  const mutate = async (
    action: Action,
    name: string,
    operation: () => Promise<void>,
  ) => {
    requireCurrent();
    if (
      state.pending ||
      state.loading ||
      !canAttemptQiniuBucketAction(state.capabilities[action], true)
    ) {
      throw new Error(
        t(
          "空间操作尚未就绪，请先刷新信息。",
          "Bucket actions are not ready. Refresh information first.",
        ),
      );
    }
    update({ pending: true, notice: null });
    try {
      await operation();
      if (!current()) return;
      update({ notice: { action, name } });
      if (action === "remove") options.onRemoved?.(options.profileId, name);
      let refreshError: string | null = null;
      try {
        await options.refreshBuckets(options.profileId);
      } catch (error) {
        refreshError = messageOf(error);
      }
      if (current() && action !== "remove") await load();
      if (refreshError)
        update({
          errors: [
            ...state.errors.filter((error) => error.area !== "refresh"),
            { area: "refresh", message: refreshError },
          ],
        });
    } catch (error) {
      if (current())
        update({
          capabilities: {
            ...state.capabilities,
            [action]: classifyQiniuBucketFailure(error),
          },
        });
      throw error;
    } finally {
      if (current()) update({ pending: false });
      else state = { ...state, pending: false };
    }
  };
  return {
    getState: () => state,
    load,
    activate: () => {
      // React StrictMode replays effect setup/cleanup using the same memoized
      // controller. The disposed generation stays invalid, but a new setup may
      // safely start a fresh read for the still-current scope.
      disposed = false;
    },
    dispose: () => {
      disposed = true;
      loadGeneration++;
    },
    create: (input: { name: string; regionId: string; access: "private" }) => {
      requireCurrent();
      if (
        input.access !== "private" ||
        !isValidQiniuBucketName(input.name) ||
        !state.regions.some((region) => region.id === input.regionId)
      ) {
        return Promise.reject(
          new Error(
            t(
              "仅支持在已确认区域创建合法名称的私有空间。",
              "Only private buckets with a valid name and confirmed region can be created.",
            ),
          ),
        );
      }
      return mutate("create", input.name, async () => {
        const result = await options.call("qiniu:bucket-create", {
          profileId: options.profileId,
          ...input,
        });
        if (!result.privateVerified || result.name !== input.name) {
          throw new Error(
            t(
              "创建结果的私有状态尚未确认，上传仍被禁用，请刷新并检查。",
              "The created bucket's private status is not confirmed; uploads remain blocked. Refresh and inspect it.",
            ),
          );
        }
      });
    },
    remove: (input: { bucketName: string }) => {
      requireCurrent();
      if (
        input.bucketName !== options.bucketName ||
        state.emptyState !== "empty"
      ) {
        return Promise.reject(
          new Error(
            t(
              "空间为空尚未确认，不能提交删除。",
              "Bucket emptiness has not been confirmed; deletion cannot be submitted.",
            ),
          ),
        );
      }
      return mutate("remove", input.bucketName, async () => {
        await options.call("qiniu:bucket-delete", {
          profileId: options.profileId,
          bucket: input.bucketName,
          confirmName: input.bucketName,
        });
      });
    },
    updateRemark: (input: { bucketName: string; remark: string }) => {
      requireCurrent();
      if (
        input.bucketName !== options.bucketName ||
        Array.from(input.remark).length > 100
      ) {
        return Promise.reject(
          new Error(
            t(
              "空间不匹配或备注超过 100 个字符。",
              "The bucket does not match, or the remark exceeds 100 characters.",
            ),
          ),
        );
      }
      return mutate("remark", input.bucketName, async () => {
        await options.call("qiniu:bucket-remark", {
          profileId: options.profileId,
          bucket: input.bucketName,
          remark: input.remark,
        });
      });
    },
  };
}

export function QiniuBucketPanel({
  profile,
  bucketName,
  open,
  onOpenChange,
  onRemoved,
}: {
  profile: ProfileInfo;
  bucketName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemoved?: (profileId: string, bucket: string) => void;
}) {
  const t = useT();
  const scopeId = JSON.stringify([profile.id, profile.updatedAt, bucketName]);
  const latest = useRef(scopeId);
  latest.current = scopeId;
  const isOpen = useRef(open);
  isOpen.current = open;
  const [state, setState] = useState(() => initialState(scopeId));
  const controller = useMemo(
    () =>
      createQiniuBucketPanelController({
        scopeId,
        profileId: profile.id,
        bucketName,
        call: rpcCall,
        isCurrent: () => latest.current === scopeId && isOpen.current,
        onState: setState,
        refreshBuckets: async (profileId) => {
          if (useProfileStore.getState().activeProfileId === profileId) {
            await useProfileStore.getState().loadBuckets(profileId);
            const current = useProfileStore.getState();
            if (current.activeProfileId === profileId && current.error)
              throw new Error(current.error);
          }
        },
        onRemoved,
      }),
    [scopeId, profile.id, bucketName, onRemoved],
  );
  useEffect(() => {
    controller.activate();
    return () => controller.dispose();
  }, [controller]);
  useEffect(() => {
    if (open) void controller.load();
  }, [controller, open]);
  const visible = state.scopeId === scopeId ? state : initialState(scopeId);
  const areaLabel = (area: ErrorArea) =>
    area === "regions"
      ? t("区域发现", "Region discovery")
      : area === "context"
        ? t("空间信息", "Bucket information")
        : area === "emptiness"
          ? t("空空间检查", "Empty-bucket check")
          : t("列表刷新", "List refresh");
  const permission = visible.context?.bucket.permission;
  return (
    <Sheet
      open={open}
      onOpenChange={(value) => {
        if (!visible.pending) onOpenChange(value);
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={!visible.pending}
        className="flex w-full max-w-[min(100vw,420px)] flex-col gap-0 overflow-y-auto p-0 sm:max-w-[420px]"
      >
        <SheetHeader className="border-b border-border pr-12">
          <SheetTitle>
            {t("七牛空间管理", "Qiniu bucket management")}
          </SheetTitle>
          <SheetDescription>
            {t(
              "管理当前账号的空间，不会递归清空文件。",
              "Manage this account's buckets. Files are never recursively emptied.",
            )}
          </SheetDescription>
        </SheetHeader>
        <div className="min-w-0 space-y-4 p-4">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium" title={profile.name}>
                {profile.name}
              </p>
              <p className="mt-1 break-all text-xs text-muted-foreground">
                {bucketName || t("尚未选择空间", "No bucket selected")}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={visible.loading || visible.pending}
              onClick={() => void controller.load()}
              aria-label={t(
                "刷新七牛空间管理信息",
                "Refresh Qiniu bucket management information",
              )}
            >
              {visible.loading ? (
                <IconSpinner
                  className="size-3.5 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <IconArrowsRotate className="size-3.5" aria-hidden="true" />
              )}
              {t("刷新", "Refresh")}
            </Button>
          </div>
          {profile.qiniu?.mode === "private" && (
            <p className="rounded-lg border border-warning/30 bg-warning/5 p-2 text-xs leading-relaxed text-muted-foreground">
              {t(
                "私有云路径尚待实机验收，未确认能力会保持禁用。",
                "Private-cloud support awaits deployment testing. Unconfirmed service capabilities stay disabled.",
              )}
            </p>
          )}
          {visible.context && (
            <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-lg bg-muted/50 p-3 text-xs">
              <dt className="text-muted-foreground">{t("区域", "Region")}</dt>
              <dd className="m-0 break-all">
                {visible.context.region.label ||
                  visible.context.region.kodoRegionId ||
                  visible.context.region.s3RegionId}
              </dd>
              <dt className="text-muted-foreground">
                {t("文件访问", "File access")}
              </dt>
              <dd className="m-0">
                {permission === "readonly"
                  ? t("只读授权", "Read-only grant")
                  : permission === "readwrite"
                    ? t("读写授权", "Read/write grant")
                    : t("权限未确认", "Permissions unverified")}
              </dd>
              <dt className="text-muted-foreground">
                {t("空间内容", "Bucket contents")}
              </dt>
              <dd className="m-0">
                {visible.emptyState === "empty"
                  ? t("已确认当前为空", "Currently confirmed empty")
                  : visible.emptyState === "not-empty"
                    ? t("包含文件或目录", "Contains files or folders")
                    : t("是否为空未确认", "Emptiness unconfirmed")}
              </dd>
            </dl>
          )}
          {visible.errors.map((error) => (
            <p
              key={error.area}
              role="alert"
              className="break-words text-xs leading-relaxed text-destructive"
            >
              {areaLabel(error.area)}：{localize(error.message)}
            </p>
          ))}
          {visible.notice && (
            <p
              role="status"
              className="break-words text-xs leading-relaxed text-success"
            >
              {visible.notice.action === "create"
                ? t(
                    `私有空间“${visible.notice.name}”已创建并验证。`,
                    `Private bucket “${visible.notice.name}” was created and verified.`,
                  )
                : visible.notice.action === "remove"
                  ? t(
                      `空空间“${visible.notice.name}”已删除。`,
                      `Empty bucket “${visible.notice.name}” was deleted.`,
                    )
                  : t("空间备注已更新。", "Bucket remark updated.")}
            </p>
          )}
          <QiniuBucketActions
            scopeId={scopeId}
            bucketName={bucketName || undefined}
            remark={visible.context?.bucket.remark}
            regions={visible.regions}
            emptyState={visible.emptyState}
            capabilities={visible.capabilities}
            busy={visible.loading || visible.pending}
            allowUnverifiedAttempt
            onCreate={controller.create}
            onRemove={controller.remove}
            onUpdateRemark={controller.updateRemark}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
