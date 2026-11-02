import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { localize, t, useT } from "@/lib/i18n";
import { IconCloudArrowUp } from "@/lib/icons";
import { rpcCall } from "@/lib/rpc-client";
import {
  useBucketStore,
  useObjectStore,
  useProfileStore,
  useUIStore,
  useVaultStore,
} from "@/stores";
import { toast } from "../common/Toast";
import {
  droppedFileEntries,
  isFileDropPointInside,
  physicalDropPoint,
} from "./file-drop";
import { listenNativeFileDrop } from "./native-file-drop";
import {
  qiniuDroppedFilesBlockReason,
  qiniuUploadBlockReason,
  qiniuUploadNotice,
} from "./qiniu-transfer-gates";
import { assertCurrentUploadScope } from "./upload-scope";

type UploadScope = Parameters<typeof assertCurrentUploadScope>[0];
interface DropZoneProps {
  children: React.ReactNode;
}
function captureScope(): UploadScope | null {
  const vault = useVaultStore.getState();
  const profileId = useProfileStore.getState().activeProfileId;
  const profile = vault.profiles.find((item) => item.id === profileId);
  const bucket = useBucketStore.getState().selectedBucket;
  if (!vault.unlocked || !profileId || !profile?.updatedAt || !bucket)
    return null;
  return {
    profileId,
    expectedProfileRevision: profile.updatedAt,
    provider: profile.provider,
    bucket,
    prefix: useObjectStore.getState().currentPrefix,
  };
}

function warnBusyDrop() {
  toast.warning(
    t(
      "上一批文件仍在加入任务，本次拖入未接收；请稍候重新拖入。",
      "The previous batch is still being queued. This drop was not accepted; wait and drop the files again.",
    ),
  );
}

export function DropZone({ children }: DropZoneProps) {
  useT();
  const profileId = useProfileStore((s) => s.activeProfileId);
  const activeProfile = useProfileStore((s) => s.activeProfile);
  const latestProfile = useVaultStore((s) =>
    s.profiles.find((profile) => profile.id === profileId),
  );
  const profile = latestProfile ?? activeProfile;
  const bucket = useBucketStore((s) => s.selectedBucket);
  const prefix = useObjectStore((s) => s.currentPrefix);
  const uploadBlocked = qiniuUploadBlockReason(profile);
  const uploadNotice = qiniuUploadNotice(profile);
  const [dragging, setDragging] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [nativeError, setNativeError] = useState(false);
  const zoneRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<UploadScope | null>(null);
  const nativeEntered = useRef(false);
  const busyGesture = useRef(false);
  const dragCount = useRef(0);
  const busy = useRef(false);
  const alive = useRef(true);
  const generation = useRef(0);
  const native = isTauri();
  const identity = JSON.stringify([
    profileId,
    profile?.updatedAt,
    profile?.provider,
    bucket,
    prefix,
  ]);

  useEffect(() => {
    // Keep a captured gesture bound to its original scope: do not recapture
    // a different folder merely because the user switched tabs mid-drag.
    void identity;
    generation.current++;
    setDragging(false);
  }, [identity]);

  const enqueuePaths = async (paths: readonly string[], scope: UploadScope) => {
    if (!alive.current) return;
    if (busy.current) {
      warnBusyDrop();
      return;
    }
    let entries: ReturnType<typeof droppedFileEntries>;
    try {
      assertCurrentUploadScope(scope);
      const current = useVaultStore
        .getState()
        .profiles.find((item) => item.id === scope.profileId);
      const blocked = qiniuUploadBlockReason(current);
      if (blocked) {
        toast.warning(blocked);
        return;
      }
      entries = droppedFileEntries(paths);
    } catch (error) {
      toast.warning(
        error instanceof Error
          ? localize(error.message)
          : t("无法处理拖入文件", "Could not process dropped files"),
      );
      return;
    }
    const batch = generation.current;
    busy.current = true;
    setQueueing(true);
    let accepted = 0;
    let failed = 0;
    let stopped = false;
    for (const entry of entries) {
      if (!alive.current || batch !== generation.current) {
        stopped = true;
        break;
      }
      try {
        assertCurrentUploadScope(scope);
      } catch {
        stopped = true;
        break;
      }
      try {
        await rpcCall("transfer:upload", {
          profileId: scope.profileId,
          expectedProfileRevision: scope.expectedProfileRevision,
          bucket: scope.bucket,
          key: `${scope.prefix}${entry.name}`,
          localPath: entry.path,
        });
        accepted++;
      } catch (error) {
        failed++;
        if (alive.current && batch === generation.current)
          toast.error(
            t(
              `无法上传 ${entry.name}：${error instanceof Error ? localize(error.message) : t("未知错误", "Unknown error")}`,
              `Could not upload ${entry.name}: ${error instanceof Error ? localize(error.message) : t("未知错误", "Unknown error")}`,
            ),
          );
      }
    }
    busy.current = false;
    if (!alive.current) return;
    setQueueing(false);
    if (stopped || batch !== generation.current) {
      toast.warning(
        t(
          `目标已变化，后续文件未上传；已加入 ${accepted} 个任务。`,
          `The destination changed; remaining files were not uploaded. ${accepted} tasks were already queued.`,
        ),
      );
    } else if (accepted) {
      useUIStore.getState().setJobPanelOpen(true);
      const message = t(
        `已加入 ${accepted} 个上传任务${failed ? `，${failed} 个失败` : ""}`,
        `Queued ${accepted} upload tasks${failed ? `; ${failed} failed` : ""}`,
      );
      if (failed) toast.warning(message);
      else toast.success(message);
    }
  };
  const enqueueRef = useRef(enqueuePaths);
  enqueueRef.current = enqueuePaths;

  useEffect(() => {
    alive.current = true;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const initializationFailed = () => {
      if (disposed) return;
      nativeEntered.current = false;
      busyGesture.current = false;
      gesture.current = null;
      setDragging(false);
      setNativeError(true);
    };
    if (native) {
      try {
        const subscription = listenNativeFileDrop(
          getCurrentWebview(),
          (payload) => {
            if (disposed) return;
            if (payload.type === "leave") {
              nativeEntered.current = false;
              busyGesture.current = false;
              gesture.current = null;
              setDragging(false);
              return;
            }
            if (payload.type === "enter") {
              nativeEntered.current = true;
              busyGesture.current = false;
              gesture.current = null;
            }
            if (!nativeEntered.current) return;
            const inside = isFileDropPointInside(
              zoneRef.current,
              physicalDropPoint(payload.position, window.devicePixelRatio),
              document,
            );
            if (payload.type === "enter" || payload.type === "over") {
              if (inside && busy.current) busyGesture.current = true;
              if (
                inside &&
                !busy.current &&
                !busyGesture.current &&
                !gesture.current
              )
                gesture.current = captureScope();
              setDragging(
                inside &&
                  !!gesture.current &&
                  !busy.current &&
                  !busyGesture.current,
              );
              return;
            }
            const scope = gesture.current;
            const wasBusy = busyGesture.current;
            nativeEntered.current = false;
            busyGesture.current = false;
            gesture.current = null;
            setDragging(false);
            if (!inside) return;
            if (busy.current || wasBusy) {
              warnBusyDrop();
              return;
            }
            if (!scope) return;
            void enqueueRef.current(payload.paths, scope);
          },
        );
        unlisten = subscription.stop;
        void subscription.ready.catch(initializationFailed);
      } catch {
        initializationFailed();
      }
    }
    return () => {
      disposed = true;
      alive.current = false;
      generation.current++;
      gesture.current = null;
      nativeEntered.current = false;
      busyGesture.current = false;
      unlisten?.();
    };
  }, [native]);

  const stopDomEvent = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const enter = (event: React.DragEvent) => {
    stopDomEvent(event);
    if (native || !event.dataTransfer.types.includes("Files")) return;
    if (
      !isFileDropPointInside(
        zoneRef.current,
        { x: event.clientX, y: event.clientY },
        document,
      )
    )
      return;
    if (!dragCount.current) busyGesture.current = false;
    dragCount.current++;
    if (busy.current) busyGesture.current = true;
    if (busyGesture.current) return;
    if (!gesture.current) gesture.current = captureScope();
    setDragging(!!gesture.current);
  };
  const leave = (event: React.DragEvent) => {
    stopDomEvent(event);
    if (native) return;
    dragCount.current = Math.max(0, dragCount.current - 1);
    if (!dragCount.current) {
      gesture.current = null;
      busyGesture.current = false;
      setDragging(false);
    }
  };
  const drop = (event: React.DragEvent) => {
    stopDomEvent(event);
    if (native) return;
    const scope = gesture.current;
    const wasBusy = busyGesture.current;
    gesture.current = null;
    busyGesture.current = false;
    dragCount.current = 0;
    setDragging(false);
    if (
      (busy.current || wasBusy) &&
      event.dataTransfer.types.includes("Files") &&
      isFileDropPointInside(
        zoneRef.current,
        { x: event.clientX, y: event.clientY },
        document,
      )
    ) {
      warnBusyDrop();
      return;
    }
    if (
      !scope ||
      !isFileDropPointInside(
        zoneRef.current,
        { x: event.clientX, y: event.clientY },
        document,
      )
    )
      return;
    const files = Array.from(event.dataTransfer.files);
    const blocked = qiniuDroppedFilesBlockReason(profile, files);
    if (blocked) {
      toast.warning(blocked);
      return;
    }
    const paths = files.map((file) => (file as File & { path?: string }).path);
    if (!paths.length || paths.some((path) => !path)) {
      toast.warning(
        t(
          "浏览器无法提供本地文件路径，请使用桌面端或上传按钮。",
          "The browser cannot provide local file paths. Use the desktop app or Upload.",
        ),
      );
      return;
    }
    void enqueueRef.current(paths as string[], scope);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: div is the bounded native/DOM drop target
    <div
      ref={zoneRef}
      role="region"
      aria-label={t("文件拖放区域", "File drop area")}
      className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden"
      onDragEnter={enter}
      onDragLeave={leave}
      onDragOver={stopDomEvent}
      onDrop={drop}
    >
      {children}
      {!dragging && !!bucket && (
        <div
          className="pointer-events-none absolute inset-x-3 bottom-3 flex justify-center"
          aria-live="polite"
        >
          <span
            className={`max-w-full rounded-md border bg-background/90 px-3 py-1.5 text-center text-xs shadow-sm ${nativeError ? "border-warning/30 text-warning" : "border-border/70 text-muted-foreground"}`}
          >
            {nativeError
              ? t(
                  "拖放初始化失败，请使用上传按钮。",
                  "Drag and drop could not initialize. Use Upload.",
                )
              : queueing
                ? t("正在加入上传任务…", "Queuing upload tasks…")
                : (uploadBlocked ??
                  t(
                    "将电脑文件拖到此处，上传到当前目录",
                    "Drop files from your computer here to upload to this folder",
                  ))}
          </span>
        </div>
      )}
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center border-2 border-dashed border-primary bg-primary/10 p-6 backdrop-blur-sm">
          <div
            role="status"
            className="flex max-w-lg flex-col items-center gap-3 rounded-xl bg-background/95 p-6 text-center shadow-lg"
          >
            <IconCloudArrowUp className="size-10 text-primary" />
            <span className="font-semibold text-foreground">
              {uploadBlocked
                ? t(
                    "此连接暂不支持上传",
                    "Uploads are unavailable for this connection",
                  )
                : t("松开鼠标即可上传文件", "Release to upload files")}
            </span>
            <span className="max-w-full break-all font-mono text-sm text-primary">
              {gesture.current?.bucket ?? bucket}/
              {gesture.current?.prefix ?? prefix}
            </span>
            <span className="text-xs leading-relaxed text-muted-foreground">
              {uploadNotice ??
                t(
                  "支持多选文件；文件夹请使用“上传文件夹”。",
                  "Multiple files are supported. For folders, use Upload folder.",
                )}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
