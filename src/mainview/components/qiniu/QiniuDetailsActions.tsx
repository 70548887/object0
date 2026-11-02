import type {
  QiniuBucketContext,
  QiniuMutationResult,
} from "@shared/qiniu.types";
import type { RPCSchema } from "@shared/rpc-schema";
import type { S3StatResult } from "@shared/s3.types";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { invalidateBucketUsage } from "@/lib/bucket-usage-events";
import { localize, t, useT } from "@/lib/i18n";
import { rpcCall } from "@/lib/rpc-client";
import {
  useBucketStore,
  useObjectStore,
  useProfileStore,
  useUIStore,
  useVaultStore,
} from "@/stores";
import { qiniuStorageTypeLabel } from "../objects/qiniu-object-info";
import { QiniuObjectActions } from "./QiniuObjectActions";
import type {
  QiniuCapability,
  QiniuRestoreState,
  QiniuStorageClassOption,
} from "./types";

type MutationMethod = "qiniu:object-change-type" | "qiniu:object-restore";
type MutationCall = (
  method: MutationMethod,
  payload: RPCSchema[MutationMethod]["req"],
) => Promise<RPCSchema[MutationMethod]["res"]>;
export interface QiniuDetailsActionsProps {
  profileId: string;
  profileRevision: string;
  bucket: string;
  objectKey: string;
  stat: S3StatResult;
  onRefresh: () => void | Promise<void>;
}

export function qiniuDetailsCapability(
  context: QiniuBucketContext | null,
): QiniuCapability {
  if (!context)
    return {
      state: "unknown",
      reason: t(
        "正在确认七牛管理接口和空间权限。",
        "Checking the Qiniu management interface and bucket permissions.",
      ),
    };
  if (context.bucket.permission === "readonly")
    return {
      state: "forbidden",
      reason: t(
        "此空间已确认为只读，不能修改存储类型或解冻。",
        "This bucket is read-only. Storage type changes and restore requests are unavailable.",
      ),
    };
  if (
    context.backendMode !== "kodo" ||
    !context.region.rsUrls.some((url) => Boolean(url.trim()))
  )
    return {
      state: "unsupported",
      reason: t(
        "当前连接未确认可用的 Kodo 原生管理接口，这些操作暂不可用。",
        "No available native Kodo management interface was confirmed for this connection; these operations are unavailable.",
      ),
    };
  if (context.bucket.permission === "readwrite") return { state: "supported" };
  return {
    state: "unknown",
    reason: t(
      "权限未确认，操作时由服务端验证。你仍需逐次确认可能产生的费用；服务端拒绝时不会视为成功。",
      "Permissions are unconfirmed and will be validated by the server when you act. Confirm possible charges for each request; a server rejection is never treated as success.",
    ),
  };
}

export function qiniuDetailsRestoreState(
  stat: S3StatResult,
): QiniuRestoreState {
  if (stat.storageType === undefined) return "unknown";
  if (stat.storageType !== 2 && stat.storageType !== 3) return "normal";
  if (stat.restoreStatus === undefined) return "frozen";
  if (stat.restoreStatus === 1) return "restoring";
  if (stat.restoreStatus === 2) return "restored";
  return "unknown";
}

export function qiniuDetailsStorageClasses(
  context: QiniuBucketContext | null,
): QiniuStorageClassOption[] {
  if (!context) return [];
  const seen = new Set<number>();
  return context.region.storageClasses
    .filter((item) => {
      if (
        !Number.isInteger(item.fileType) ||
        item.fileType < 0 ||
        item.fileType > 255 ||
        seen.has(item.fileType)
      )
        return false;
      seen.add(item.fileType);
      return true;
    })
    .map((item) => ({
      id: String(item.fileType),
      label:
        item.fileType <= 5
          ? qiniuStorageTypeLabel(item.fileType)
          : item.kodoName || item.s3Name || t("未知类型", "Unknown type"),
      available: true,
    }));
}

export async function submitQiniuDetailsMutation(
  input: {
    profileId: string;
    expectedProfileRevision: string;
    bucket: string;
    keys: readonly string[];
    operation: "type" | "restore";
    value: number;
    costConfirmed: boolean;
  },
  call: MutationCall = rpcCall,
  isCurrent: () => boolean = () => true,
): Promise<QiniuMutationResult[]> {
  const keys = [...new Set(input.keys)];
  if (
    !input.costConfirmed ||
    typeof input.expectedProfileRevision !== "string" ||
    !input.expectedProfileRevision.trim() ||
    keys.length === 0 ||
    keys.some((key) => key.length === 0) ||
    !Number.isInteger(input.value) ||
    input.value < 0 ||
    input.value > 255 ||
    (input.operation === "restore" && (input.value < 1 || input.value > 7))
  )
    throw new Error(
      t(
        "请求未满足对象范围、取值或费用确认条件。",
        "The request does not satisfy object scope, value or cost-confirmation requirements.",
      ),
    );
  if (!isCurrent())
    throw new Error(
      t(
        "账号或对象已变化，请重新打开操作并确认。",
        "The account or object changed. Reopen the action and confirm again.",
      ),
    );
  const response = await call(
    input.operation === "type"
      ? "qiniu:object-change-type"
      : "qiniu:object-restore",
    {
      profileId: input.profileId,
      expectedProfileRevision: input.expectedProfileRevision,
      bucket: input.bucket,
      keys,
      value: input.value,
      costConfirmed: true,
    },
  );
  const results = response.results;
  if (
    !Array.isArray(results) ||
    results.length !== keys.length ||
    keys.some(
      (key) => results.filter((result) => result.key === key).length !== 1,
    ) ||
    results.some(
      (result) =>
        typeof result.success !== "boolean" ||
        (result.error !== undefined && typeof result.error !== "string"),
    )
  )
    throw new Error(
      t(
        "服务端未返回与当前对象范围一致的逐项结果，请手动刷新确认。",
        "The service did not return individual results matching the requested objects. Refresh manually to verify.",
      ),
    );
  return results;
}

/** Read live stores rather than waiting for a React render to replace old props. */
export function isCurrentQiniuDetailsTarget(input: {
  profileId: string;
  expectedProfileRevision: string;
  bucket: string;
  objectKey: string;
}): boolean {
  const vault = useVaultStore.getState();
  const profile = vault.profiles.find((item) => item.id === input.profileId);
  return Boolean(
    vault.unlocked &&
      input.expectedProfileRevision &&
      profile?.provider === "qiniu" &&
      profile.updatedAt === input.expectedProfileRevision &&
      useProfileStore.getState().activeProfileId === input.profileId &&
      useBucketStore.getState().selectedBucket === input.bucket &&
      useUIStore.getState().detailKey === input.objectKey,
  );
}

export async function refreshSuccessfulQiniuResults(
  results: readonly QiniuMutationResult[],
  isCurrent: () => boolean,
  refreshers: readonly (() => void | Promise<void>)[],
): Promise<string[]> {
  const warnings: string[] = [];
  if (!results.some((result) => result.success) || !isCurrent())
    return warnings;
  for (const refresh of refreshers) {
    if (!isCurrent()) break;
    try {
      await refresh();
    } catch (cause) {
      warnings.push(
        cause instanceof Error
          ? cause.message
          : t(
              "刷新信息失败，请手动刷新。",
              "Information refresh failed. Refresh manually.",
            ),
      );
    }
  }
  return warnings;
}

export function QiniuMutationResults({
  operation,
  results,
  error,
  refreshWarnings = [],
}: {
  operation: "type" | "restore";
  results: readonly QiniuMutationResult[];
  error?: string;
  refreshWarnings?: readonly string[];
}) {
  const t = useT();
  const successful = results.filter((result) => result.success).length;
  return (
    <section
      aria-label={t("七牛操作结果", "Qiniu operation results")}
      aria-live="polite"
      className="min-w-0 space-y-2 rounded-md border border-border/70 p-2.5 text-xs"
    >
      <h4 className="font-semibold">{t("本次请求结果", "Request results")}</h4>
      {error ? (
        <p
          role="alert"
          className="break-words leading-relaxed text-destructive"
        >
          {localize(error)}
        </p>
      ) : (
        <p className="text-muted-foreground">
          {t(
            `成功 ${successful} 项，失败 ${results.length - successful} 项。`,
            `${successful} succeeded; ${results.length - successful} failed.`,
          )}
        </p>
      )}
      <ul className="space-y-2">
        {results.map((result) => (
          <li key={result.key} className="min-w-0 space-y-0.5">
            <div className="flex min-w-0 items-start justify-between gap-2">
              <span className="min-w-0 break-all font-mono text-[10px]">
                {result.key}
              </span>
              <span
                className={`shrink-0 ${result.success ? "text-success" : "text-destructive"}`}
              >
                {result.success ? t("已受理", "Accepted") : t("失败", "Failed")}
              </span>
            </div>
            {!result.success && (
              <p className="break-words leading-relaxed text-destructive">
                {result.error
                  ? localize(result.error)
                  : t(
                      "服务端未给出具体原因。",
                      "The service returned no detailed reason.",
                    )}
              </p>
            )}
          </li>
        ))}
      </ul>
      {operation === "restore" && successful > 0 && (
        <p className="leading-relaxed text-muted-foreground">
          {t(
            "解冻请求已受理，不表示文件已可读取；请以刷新后的恢复状态为准。",
            "The restore request was accepted; the object may not be readable yet. Follow its refreshed restore state.",
          )}
        </p>
      )}
      {refreshWarnings.length > 0 && (
        <div role="status" className="space-y-1 text-warning">
          <p>
            {t(
              "请求结果已保留，但部分信息刷新失败。",
              "The request results were preserved, but some information could not be refreshed.",
            )}
          </p>
          {[...new Set(refreshWarnings)].map((warning) => (
            <p key={warning} className="break-words leading-relaxed">
              {localize(warning)}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

export function QiniuDetailsActions({
  profileId,
  profileRevision,
  bucket,
  objectKey,
  stat,
  onRefresh,
}: QiniuDetailsActionsProps) {
  const t = useT();
  const scope = JSON.stringify([profileId, profileRevision, bucket, objectKey]);
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const [context, setContext] = useState<{
    scope: string;
    query: string;
    data: QiniuBucketContext | null;
    loading: boolean;
    error?: string;
  }>({ scope: "", query: "", data: null, loading: true });
  const [contextRevision, setContextRevision] = useState(0);
  const queryKey = JSON.stringify([scope, contextRevision]);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<{
    scope: string;
    operation: "type" | "restore";
    results: QiniuMutationResult[];
    error?: string;
    refreshWarnings?: string[];
  } | null>(null);
  const generation = useRef(0);
  const mutationPending = useRef(false);
  useEffect(() => {
    let cancelled = false;
    generation.current++;
    mutationPending.current = false;
    setPending(false);
    setOutcome(null);
    setContext({ scope, query: queryKey, data: null, loading: true });
    void rpcCall("qiniu:bucket-context", { profileId, bucket })
      .then((data) => {
        if (cancelled || latestScope.current !== scope) return;
        if (data.bucket.name !== bucket)
          throw new Error(
            t(
              "空间上下文与当前选择不一致，请刷新。",
              "The bucket context does not match the current selection. Refresh again.",
            ),
          );
        setContext({ scope, query: queryKey, data, loading: false });
      })
      .catch((cause) => {
        if (!cancelled && latestScope.current === scope)
          setContext({
            scope,
            query: queryKey,
            data: null,
            loading: false,
            error:
              cause instanceof Error
                ? cause.message
                : t(
                    "无法确认七牛操作能力。",
                    "Could not determine Qiniu operation capabilities.",
                  ),
          });
      });
    return () => {
      cancelled = true;
      generation.current++;
    };
  }, [profileId, bucket, scope, queryKey, t]);
  const current =
    context.scope === scope && context.query === queryKey
      ? context
      : { scope, data: null, loading: true, error: undefined };
  const capability = current.error
    ? { state: "unavailable" as const, reason: current.error }
    : qiniuDetailsCapability(current.data);
  const nativeAvailable =
    current.data?.backendMode === "kodo" &&
    current.data.region.rsUrls.some((url) => Boolean(url.trim()));
  const canAttempt =
    capability.state === "supported" ||
    (capability.state === "unknown" && nativeAvailable);
  const mutate = async (
    operation: "type" | "restore",
    keys: string[],
    value: number,
  ) => {
    if (
      mutationPending.current ||
      !canAttempt ||
      current.loading ||
      keys.length !== 1 ||
      keys[0] !== objectKey
    )
      throw new Error(
        t(
          "当前对象操作能力或范围尚未确认，请刷新后重试。",
          "The object scope or operation capability is not confirmed. Refresh and retry.",
        ),
      );
    const request = ++generation.current;
    const isCurrent = () =>
      latestScope.current === scope && generation.current === request;
    mutationPending.current = true;
    setPending(true);
    setOutcome(null);
    try {
      const results = await submitQiniuDetailsMutation(
        {
          profileId,
          expectedProfileRevision: profileRevision,
          bucket,
          keys,
          operation,
          value,
          costConfirmed: true,
        },
        rpcCall,
        () =>
          isCurrent() &&
          isCurrentQiniuDetailsTarget({
            profileId,
            expectedProfileRevision: profileRevision,
            bucket,
            objectKey,
          }),
      );
      if (!isCurrent()) return;
      setOutcome({ scope, operation, results });
      const refreshWarnings = await refreshSuccessfulQiniuResults(
        results,
        isCurrent,
        [
          () => invalidateBucketUsage({ profileId, bucket }),
          () => refreshRef.current(),
          async () => {
            if (
              useProfileStore.getState().activeProfileId !== profileId ||
              useBucketStore.getState().selectedBucket !== bucket
            )
              return;
            const store = useObjectStore.getState();
            await store.loadObjects(profileId, bucket, store.currentPrefix);
          },
        ],
      );
      if (isCurrent() && refreshWarnings.length)
        setOutcome({ scope, operation, results, refreshWarnings });
    } catch (cause) {
      if (isCurrent())
        setOutcome({
          scope,
          operation,
          results: [],
          error:
            cause instanceof Error
              ? cause.message
              : t("操作请求失败。", "The operation request failed."),
        });
    } finally {
      if (isCurrent()) {
        mutationPending.current = false;
        setPending(false);
      }
    }
  };
  return (
    <div className="min-w-0 space-y-3 border-t border-border pt-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold">
          {t("七牛对象操作", "Qiniu object actions")}
        </h4>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={current.loading || pending}
          onClick={() => setContextRevision((value) => value + 1)}
        >
          {t("刷新能力", "Refresh capabilities")}
        </Button>
      </div>
      {current.loading && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("正在确认服务端能力…", "Checking server capabilities…")}
        </p>
      )}
      <QiniuObjectActions
        scopeId={scope}
        objectKeys={[objectKey]}
        currentStorageClass={
          stat.storageType === undefined ? undefined : String(stat.storageType)
        }
        restoreState={qiniuDetailsRestoreState(stat)}
        storageClasses={qiniuDetailsStorageClasses(current.data)}
        capabilities={{ changeType: capability, restore: capability }}
        busy={pending || current.loading}
        allowUnknownPermissionAttempt={Boolean(nativeAvailable)}
        onChangeStorageClass={(input) =>
          mutate("type", input.objectKeys, Number(input.storageClass))
        }
        onRestore={(input) => mutate("restore", input.objectKeys, input.days)}
      />
      {pending && (
        <p
          role="status"
          className="text-xs leading-relaxed text-muted-foreground"
        >
          {t(
            "请求已提交。关闭详情或切换对象不会撤销已发送的服务端操作。",
            "The request has been submitted. Closing details or switching objects does not undo server operations already sent.",
          )}
        </p>
      )}
      {outcome?.scope === scope && (
        <QiniuMutationResults
          operation={outcome.operation}
          results={outcome.results}
          error={outcome.error}
          refreshWarnings={outcome.refreshWarnings}
        />
      )}
    </div>
  );
}
