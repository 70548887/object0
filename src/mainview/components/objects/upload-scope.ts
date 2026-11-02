import type { Provider } from "@shared/profile.types";
import { t } from "@/lib/i18n";
import {
  useBucketStore,
  useObjectStore,
  useProfileStore,
  useVaultStore,
} from "@/stores";

/** Confirm a captured upload destination immediately before each IPC call. */
export function assertCurrentUploadScope(input: {
  profileId: string;
  expectedProfileRevision: string;
  provider: Provider;
  bucket: string;
  prefix: string;
}): void {
  const vault = useVaultStore.getState();
  const saved = vault.profiles.find((item) => item.id === input.profileId);
  if (
    !vault.unlocked ||
    !input.expectedProfileRevision ||
    !saved ||
    saved.updatedAt !== input.expectedProfileRevision ||
    saved.provider !== input.provider ||
    useProfileStore.getState().activeProfileId !== input.profileId ||
    useBucketStore.getState().selectedBucket !== input.bucket ||
    useObjectStore.getState().currentPrefix !== input.prefix
  )
    throw new Error(
      t(
        "上传账号或目录已变化，请重新选择目标后上传。",
        "The upload account or directory changed. Select the destination again before uploading.",
      ),
    );
}
