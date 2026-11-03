import { t } from "@/lib/i18n";
import {
  useBucketStore,
  useObjectStore,
  useProfileStore,
  useVaultStore,
} from "@/stores";
import type { TextEditorScope } from "./text-editor-model";

export function captureWorkspaceScope(): TextEditorScope | null {
  const vault = useVaultStore.getState();
  const id = useProfileStore.getState().activeProfileId;
  const profile = vault.profiles.find((item) => item.id === id);
  const bucket = useBucketStore.getState().selectedBucket;
  if (!vault.unlocked || !profile?.updatedAt || !bucket) return null;
  return {
    profileId: profile.id,
    expectedProfileRevision: profile.updatedAt,
    provider: profile.provider,
    profileName: profile.name,
    bucket,
    prefix: useObjectStore.getState().currentPrefix,
  };
}
export function isTextScopeCurrent(scope: TextEditorScope) {
  const vault = useVaultStore.getState();
  const saved = vault.profiles.find(
    (profile) => profile.id === scope.profileId,
  );
  return (
    vault.unlocked &&
    !!scope.expectedProfileRevision &&
    saved?.updatedAt === scope.expectedProfileRevision &&
    saved?.provider === scope.provider &&
    useProfileStore.getState().activeProfileId === scope.profileId &&
    useBucketStore.getState().selectedBucket === scope.bucket &&
    useObjectStore.getState().currentPrefix === scope.prefix
  );
}
export function confirmTextScope(scope: TextEditorScope) {
  if (!isTextScopeCurrent(scope))
    throw new Error(
      t(
        "账号、凭据或目录已变化。草稿已保留；请返回原目标或关闭后重新选择。",
        "The account, credentials or folder changed. The draft is retained; return to its original destination or close and select again.",
      ),
    );
}
