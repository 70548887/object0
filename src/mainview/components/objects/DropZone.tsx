import type React from "react";
import { useCallback, useRef, useState } from "react";
import { IconCloudArrowUp } from "@/lib/icons";
import { rpcCall } from "@/lib/rpc-client";
import {
  useBucketStore,
  useObjectStore,
  useProfileStore,
  useUIStore,
} from "@/stores";
import { toast } from "../common/Toast";

interface DropZoneProps {
  children: React.ReactNode;
}

export function DropZone({ children }: DropZoneProps) {
  const profileId = useProfileStore((s) => s.activeProfileId);
  const bucket = useBucketStore((s) => s.selectedBucket);
  const [dragging, setDragging] = useState(false);
  const dragCountRef = useRef(0);

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!profileId || !bucket) return;
      dragCountRef.current += 1;
      if (dragCountRef.current === 1) setDragging(true);
    },
    [profileId, bucket],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current -= 1;
    if (dragCountRef.current <= 0) {
      dragCountRef.current = 0;
      setDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragging(false);
      dragCountRef.current = 0;

      if (!profileId || !bucket) return;

      const prefix = useObjectStore.getState().currentPrefix;
      const files = Array.from(e.dataTransfer.files);

      if (files.length === 0) {
        toast.warning("未检测到拖入的文件");
        return;
      }

      try {
        // Use the standard file picker upload flow — the files are from the
        // OS file manager, so we send paths via the pick-and-upload RPC.
        // Electrobun's drag-and-drop gives us File objects with paths.
        const paths = files
          .map((f) => (f as File & { path?: string }).path)
          .filter(Boolean) as string[];

        if (paths.length === 0) {
          toast.warning("无法读取拖入文件的路径");
          return;
        }

        let totalJobs = 0;
        for (const filePath of paths) {
          const fileName = filePath.split("/").pop() ?? "file";
          const key = prefix ? `${prefix}${fileName}` : fileName;
          try {
            await rpcCall("transfer:upload", {
              profileId,
              bucket,
              key,
              localPath: filePath,
            });
            totalJobs++;
          } catch (err: unknown) {
            toast.error(
              `上传 ${fileName} 失败：${err instanceof Error ? err.message : "未知错误"}`,
            );
          }
        }

        if (totalJobs > 0) {
          useUIStore.getState().setJobPanelOpen(true);
          toast.success(`正在上传 ${totalJobs} 个文件`);
        }
      } catch (err: unknown) {
        toast.error(
          `拖放失败：${err instanceof Error ? err.message : "未知错误"}`,
        );
      }
    },
    [profileId, bucket],
  );

  const active = profileId && bucket;

  return (
    // biome-ignore lint/a11y/useSemanticElements: drop zone requires div with drag handlers
    <div
      role="region"
      aria-label={"文件拖放区域"}
      className="relative flex-1 overflow-auto"
      onDragEnter={active ? handleDragEnter : undefined}
      onDragLeave={active ? handleDragLeave : undefined}
      onDragOver={active ? handleDragOver : undefined}
      onDrop={active ? handleDrop : undefined}
    >
      {children}

      {/* Drop overlay */}
      {dragging && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-primary/10 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-primary border-dashed bg-background/80 px-12 py-10">
            <IconCloudArrowUp className="size-10 text-primary" />
            <span className="font-semibold text-foreground text-sm">
              将文件拖到这里上传
            </span>
            <span className="text-foreground/50 text-xs">
              文件将上传到当前文件夹
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
