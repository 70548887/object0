import type { ProfileInfo } from "@shared/profile.types";
import { t } from "@/lib/i18n";

export const QINIU_PREVIEW_UPLOAD_LIMIT = 5 * 1024 * 1024;
export const QINIU_NATIVE_MULTIPART_MAX_BYTES = 64 * 1024 * 1024 * 10000;

/** A directory prefix is not a single object. Until recursive operations have
 * a complete listing and per-item verification, do not mutate just its marker. */
export function qiniuFolderMutationBlockReason(
  profile: ProfileInfo | null | undefined,
  keys: readonly string[],
  operation: "delete" | "rename",
) {
  if (profile?.provider !== "qiniu" || !keys.some((key) => key.endsWith("/")))
    return null;
  return operation === "delete"
    ? t(
        "七牛目录删除尚未完成适配，不能只删除目录占位对象；请进入目录后仅选择文件删除。",
        "Qiniu directory deletion is not implemented yet; deleting only its marker would leave its contents. Open the directory and select files only.",
      )
    : t(
        "七牛目录重命名尚未完成适配，不能只重命名目录占位对象；文件重命名仍可使用。",
        "Qiniu directory renaming is not implemented yet; renaming only its marker would leave its contents. Individual files can still be renamed.",
      );
}

/** UI hints are not authorization. Rust revalidates the profile and local file. */
export function qiniuUploadBlockReason(
  profile: ProfileInfo | null | undefined,
) {
  if (profile?.provider !== "qiniu") return null;
  if (profile.qiniu?.bucketBindings?.length) {
    return t(
      "七牛限定空间使用 S3 路径，上传尚未完成适配",
      "Scoped Qiniu buckets use S3; uploads are not connected yet",
    );
  }
  if (profile.qiniu?.mode === "private") {
    return t(
      "七牛私有云上传尚未完成适配，暂不可用",
      "Qiniu private-cloud uploads are not implemented yet",
    );
  }
  if (profile.hasSessionToken === true) {
    return t(
      "七牛临时凭据上传尚未完成适配，暂不可用",
      "Qiniu temporary-credential uploads are not implemented yet",
    );
  }
  if (profile.qiniu?.mode !== "public" || profile.hasSessionToken !== false) {
    return t(
      "七牛上传身份尚未确认，请重新加载账号配置",
      "Qiniu upload credential mode is unknown; reload the account configuration",
    );
  }
  return null;
}

export function qiniuUploadNotice(profile: ProfileInfo | null | undefined) {
  if (profile?.provider !== "qiniu") return null;
  return (
    qiniuUploadBlockReason(profile) ??
    t(
      "七牛原生上传：超过 5 MiB 使用加密持久分片任务，可暂停和手动恢复；会先计算完整指纹，选择文件后由后端检查大小。仅本地模拟验收，私有云/临时凭据不启用。",
      "Native Qiniu uploads above 5 MiB use encrypted durable multipart tasks with pause and manual resume. A full fingerprint is computed first; the backend checks sizes after selection. Locally validated only; private/temporary credentials remain disabled.",
    )
  );
}

export function qiniuDroppedFilesBlockReason(
  profile: ProfileInfo | null | undefined,
  files: ReadonlyArray<{ size: number }>,
) {
  const blocked = qiniuUploadBlockReason(profile);
  if (blocked || profile?.provider !== "qiniu") return blocked;
  if (files.some((file) => !Number.isSafeInteger(file.size) || file.size < 0)) {
    return t(
      "无法确认拖入文件的大小，本批次未上传；请使用文件选择器",
      "Dropped file sizes could not be verified; nothing was uploaded. Use the file picker",
    );
  }
  if (files.some((file) => file.size > QINIU_NATIVE_MULTIPART_MAX_BYTES)) {
    return t(
      "文件超过当前最多 10000 个、每片 64 MiB 的分片上限，本批次未上传",
      "A file exceeds the current limit of 10000 parts of 64 MiB; nothing was uploaded",
    );
  }
  return null;
}

export function qiniuUnfinishedTransferReason(
  profile: ProfileInfo | null | undefined,
  feature: "sync" | "archive" | "transfer" | "folder-download",
) {
  if (profile?.provider !== "qiniu") return null;
  switch (feature) {
    case "sync":
      return t(
        "七牛对象同步和文件夹同步尚未完成适配，暂不可用",
        "Qiniu object and folder synchronization are not implemented yet",
      );
    case "archive":
      return t(
        "七牛打包下载尚未完成适配，请逐个下载文件",
        "Qiniu archive downloads are not implemented yet; download individual files",
      );
    case "transfer":
      return t(
        "七牛跨空间和跨云传输尚未完成适配，暂不可用",
        "Qiniu cross-bucket and cross-cloud transfers are not implemented yet",
      );
    case "folder-download":
      return t(
        "七牛文件夹下载尚未完成适配，请仅选择文件下载",
        "Qiniu folder downloads are not implemented yet; select files only",
      );
  }
}

export function qiniuTransferPairReason(
  source: ProfileInfo | null | undefined,
  destination: ProfileInfo | null | undefined,
  feature: "sync" | "transfer",
) {
  return (
    qiniuUnfinishedTransferReason(source, feature) ??
    qiniuUnfinishedTransferReason(destination, feature)
  );
}
