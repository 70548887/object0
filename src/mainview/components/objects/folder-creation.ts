import { t } from "@/lib/i18n";
import { rpcCall } from "@/lib/rpc-client";
import {
  useBucketStore,
  useObjectStore,
  useProfileStore,
  useVaultStore,
} from "@/stores";
import { qiniuUploadBlockReason } from "./qiniu-transfer-gates";
import { assertCurrentUploadScope } from "./upload-scope";

export type FolderScope = Parameters<typeof assertCurrentUploadScope>[0];
export function captureFolderScope(): FolderScope | null {
  const vault = useVaultStore.getState();
  const profileId = useProfileStore.getState().activeProfileId;
  const profile = vault.profiles.find((p) => p.id === profileId);
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
export function folderKey(scope: FolderScope, name: string): string {
  const clean = name.trim();
  if (
    !clean ||
    clean === "." ||
    clean === ".." ||
    /[/\\]/.test(clean) ||
    Array.from(name).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    throw new Error(
      t(
        "请输入单个文件夹名称，不可包含斜杠、控制字符或 . / ..。",
        "Enter one folder name without slashes, control characters, '.' or '..'.",
      ),
    );
  const key = `${scope.prefix}${clean}/`;
  if (new TextEncoder().encode(key).byteLength > 1024)
    throw new Error(
      t("文件夹路径超过 1024 字节", "Folder path exceeds 1024 bytes"),
    );
  return key;
}
export async function queueFolder(
  scope: FolderScope,
  name: string,
): Promise<string> {
  const key = folderKey(scope, name);
  assertCurrentUploadScope(scope);
  const profile = useVaultStore
    .getState()
    .profiles.find((p) => p.id === scope.profileId);
  const blocked = qiniuUploadBlockReason(profile);
  if (blocked) throw new Error(blocked);
  const result = await rpcCall("transfer:upload", {
    profileId: scope.profileId,
    expectedProfileRevision: scope.expectedProfileRevision,
    bucket: scope.bucket,
    key,
    localPath: "",
  });
  if (!result.jobId)
    throw new Error(
      t("创建任务未被接受", "The creation task was not accepted"),
    );
  return result.jobId;
}
