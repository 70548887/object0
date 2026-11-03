import type { ProfileInfo } from "@shared/profile.types";
import { PROVIDER_LABELS } from "@shared/profile.types";
import { useCallback, useMemo, useState } from "react";
import { useS3Buckets } from "@/hooks";
import { localize, t, useT } from "@/lib/i18n";
import {
  IconArrowsRotate,
  IconAws,
  IconBucket,
  IconCloud,
  IconCloudArrowUp,
  IconDigitalOcean,
  IconFire,
  IconGear,
  IconGoogle,
  IconLock,
  IconPlus,
  IconServer,
  IconShareNodes,
  IconUser,
  IconUserGroup,
} from "@/lib/icons";
import { rpcCall } from "@/lib/rpc-client";
import {
  useBucketStore,
  useFavoritesStore,
  useObjectStore,
  useProfileStore,
  useTabStore,
  useUIStore,
  useVaultStore,
} from "@/stores";
import { useQiniuShareStore } from "@/stores/useQiniuShareStore";
import { BucketList } from "../buckets/BucketList";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { toast } from "../common/Toast";
import { ProfileDetailsDialog } from "../profiles/ProfileDetailsDialog";
import { ProfileForm } from "../profiles/ProfileForm";
import { ProfileList } from "../profiles/ProfileList";
import { QiniuBucketPanel } from "../qiniu/QiniuBucketPanel";
import { Button } from "../ui/button";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  Sidebar as SidebarPrimitive,
  SidebarRail,
  SidebarTrigger,
} from "../ui/sidebar";
import { SidebarQuickNav } from "./SidebarQuickNav";

export function Sidebar() {
  useT();
  const profiles = useVaultStore((s) => s.profiles);
  const lock = useVaultStore((s) => s.lock);
  const plaintext = useVaultStore((s) => s.storageMode === "plaintext");
  const {
    activeProfile,
    buckets,
    bucketsLoading,
    error: bucketError,
    selectedBucket,
    selectBucket,
    selectFavoriteBucket,
    switchProfile,
    refreshBuckets,
  } = useS3Buckets();
  const favorites = useFavoritesStore((s) => s.favorites);
  const toggleFavorite = useFavoritesStore((s) => s.toggleFavorite);
  const favoriteEntries = useMemo(
    () =>
      [...favorites].map((key) => {
        const idx = key.indexOf(":");
        return { profileId: key.slice(0, idx), bucket: key.slice(idx + 1) };
      }),
    [favorites],
  );
  const [addingProfile, setAddingProfile] = useState(false);
  const [qiniuManagementOpen, setQiniuManagementOpen] = useState(false);
  const qiniuProfile =
    profiles.find((profile) => profile.id === activeProfile?.id) ??
    activeProfile;
  const handleQiniuBucketRemoved = useCallback(
    (profileId: string, bucket: string) => {
      // Remove only the deleted scope, without auto-selecting an adjacent tab
      // from another account or changing the user's active profile.
      if (useProfileStore.getState().activeProfileId !== profileId) return;
      if (useBucketStore.getState().selectedBucket === bucket) {
        useBucketStore.getState().setSelectedBucket(null);
        useObjectStore.getState().reset();
      }
      useTabStore.setState((state) => {
        const removed = new Set(
          state.tabs
            .filter(
              (tab) => tab.profileId === profileId && tab.bucket === bucket,
            )
            .map((tab) => tab.id),
        );
        return {
          tabs: state.tabs.filter((tab) => !removed.has(tab.id)),
          activeTabId:
            state.activeTabId && removed.has(state.activeTabId)
              ? null
              : state.activeTabId,
        };
      });
      setQiniuManagementOpen(false);
    },
    [],
  );
  const [viewingProfile, setViewingProfile] = useState<ProfileInfo | null>(
    null,
  );
  const [editingProfile, setEditingProfile] = useState<ProfileInfo | null>(
    null,
  );
  const [deletingProfile, setDeletingProfile] = useState<ProfileInfo | null>(
    null,
  );

  const handleDeleteProfile = async () => {
    if (!deletingProfile) return;
    try {
      await rpcCall("profile:remove", { id: deletingProfile.id });
      useFavoritesStore.getState().removeByProfile(deletingProfile.id);
      await useVaultStore.getState().refreshProfiles();
      if (activeProfile?.id === deletingProfile.id) {
        switchProfile(null as unknown as ProfileInfo);
      }
      toast.success(
        t(
          `已删除存储账号“${deletingProfile.name}”`,
          `Deleted account “${deletingProfile.name}”`,
        ),
      );
    } catch (err: unknown) {
      toast.error(
        err instanceof Error ? err.message : t("未知错误", "Unknown error"),
      );
    }
    setDeletingProfile(null);
  };

  return (
    <SidebarPrimitive collapsible="icon" className="absolute inset-y-0 h-full">
      <SidebarHeader className="shrink-0 gap-1 border-border border-b px-3 py-2 group-data-[collapsible=icon]:px-1">
        <div className="flex items-center gap-2 group-data-[collapsible=icon]:justify-center">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border/70 bg-background/55 px-2.5 py-2 group-data-[collapsible=icon]:hidden">
            {activeProfile ? (
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                {(() => {
                  const ProviderIcon = providerIcon(activeProfile.provider);
                  return (
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <ProviderIcon className="size-4" />
                    </div>
                  );
                })()}
                <div className="min-w-0 flex-1">
                  <div
                    className="truncate font-medium text-xs leading-tight"
                    title={activeProfile.name}
                  >
                    {activeProfile.name}
                  </div>
                  <div
                    className="mt-0.5 truncate text-[10px] text-muted-foreground"
                    title={
                      selectedBucket ?? PROVIDER_LABELS[activeProfile.provider]
                    }
                  >
                    {PROVIDER_LABELS[activeProfile.provider]}
                    {selectedBucket && (
                      <>
                        <span className="mx-1">·</span>
                        <IconBucket className="mr-0.5 inline size-[10px]" />
                        {selectedBucket}
                      </>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex min-w-0 flex-1 items-center gap-2.5 text-foreground/40">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-foreground/20 border-dashed">
                  <IconUser className="size-3" />
                </div>
                <span className="truncate text-xs">
                  {t("选择存储账号", "Select a profile")}
                </span>
              </div>
            )}
            <SidebarTrigger className="size-6 shrink-0 rounded-md text-muted-foreground hover:text-foreground [&_svg]:size-3.5" />
          </div>
          <SidebarTrigger className="hidden size-6 shrink-0 rounded-md text-muted-foreground hover:text-foreground group-data-[collapsible=icon]:flex [&_svg]:size-3.5" />
        </div>
      </SidebarHeader>

      {/* ── Scrollable content ── */}
      <SidebarContent className="overflow-hidden">
        <SidebarQuickNav
          profiles={profiles}
          favorites={favoriteEntries}
          onSelectBucket={selectFavoriteBucket}
          onToggleFavorite={toggleFavorite}
          onShowStorage={() =>
            document
              .getElementById("sidebar-storage-accounts")
              ?.scrollIntoView({ block: "nearest", behavior: "smooth" })
          }
        />

        {/* Profiles section */}
        <SidebarGroup
          id="sidebar-storage-accounts"
          className={`min-h-20 overflow-hidden p-0 ${activeProfile ? "max-h-[min(12rem,25vh)] shrink" : "flex-1"} group-data-[collapsible=icon]:mt-1 group-data-[collapsible=icon]:border-border group-data-[collapsible=icon]:border-t group-data-[collapsible=icon]:pt-1`}
        >
          <SidebarGroupLabel className="sticky top-0 z-10 flex items-center justify-between rounded-none border-border border-b bg-card px-3 text-foreground/50 group-data-[collapsible=icon]:pointer-events-none">
            <div className="flex items-center gap-1.5">
              <IconUserGroup className="size-[11px]" />
              <span className="font-semibold text-[11px] uppercase tracking-wider">
                {t("账号与存储桶", "Accounts & buckets")}
              </span>
              {profiles.length > 0 && (
                <span className="rounded-full bg-muted px-1.5 py-px text-[10px] text-foreground/40 tabular-nums">
                  {profiles.length}
                </span>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-foreground/40 hover:text-primary group-data-[collapsible=icon]:hidden"
              onClick={() => setAddingProfile(true)}
              title={t("添加存储账号", "Add Profile")}
            >
              <IconPlus className="size-[11px]" />
            </Button>
          </SidebarGroupLabel>

          {/* Account and bucket lists scroll independently so a long account
              list cannot consume the bucket viewport in a short window. */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:thin]">
            {/* Profile list — rendered as SidebarMenu items */}
            {profiles.length === 0 ? (
              <div className="flex flex-col items-center gap-3 p-4 group-data-[collapsible=icon]:hidden">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
                  <IconCloudArrowUp className="size-5 text-primary" />
                </div>
                <div className="text-center">
                  <p className="font-medium text-sm">
                    {t("暂无存储账号", "No profiles yet")}
                  </p>
                  <p className="mt-0.5 text-foreground/50 text-xs">
                    {t(
                      "添加一个 S3 兼容存储账号以开始使用",
                      "Add an S3-compatible profile to get started",
                    )}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-1"
                  onClick={() => setAddingProfile(true)}
                >
                  <IconPlus className="size-3" />{" "}
                  {t("添加存储账号", "Add Profile")}
                </Button>
              </div>
            ) : (
              <ProfileList
                profiles={profiles}
                activeId={activeProfile?.id ?? null}
                onSelect={switchProfile}
                onView={(p) => setViewingProfile(p)}
                onEdit={(p) => setEditingProfile(p)}
                onDelete={(p) => setDeletingProfile(p)}
              />
            )}
          </div>
        </SidebarGroup>

        <div className="shrink-0 px-2 py-1 group-data-[collapsible=icon]:px-1">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-foreground/65 group-data-[collapsible=icon]:justify-center"
            onClick={() => useQiniuShareStore.getState().openLogin()}
            title={t(
              "连接七牛共享目录（只读）",
              "Connect to a Qiniu shared directory (read-only)",
            )}
            aria-label={t(
              "连接七牛共享目录（只读）",
              "Connect to a Qiniu shared directory (read-only)",
            )}
          >
            <IconShareNodes className="size-3.5 shrink-0" />
            <span className="truncate group-data-[collapsible=icon]:hidden">
              {t("连接共享目录", "Connect shared directory")}
            </span>
          </Button>
        </div>

        {/* Buckets section (when profile selected) — pinned to the bottom */}
        {activeProfile && (
          <SidebarGroup className="mt-auto min-h-32 flex-1 overflow-hidden p-0 group-data-[collapsible=icon]:border-border group-data-[collapsible=icon]:border-t group-data-[collapsible=icon]:pt-1">
            <SidebarGroupLabel className="sticky top-0 z-10 flex items-center justify-between rounded-none border-border border-b bg-card px-3 text-foreground/50 group-data-[collapsible=icon]:pointer-events-none">
              <div className="flex items-center gap-1.5">
                <IconBucket className="size-[11px]" />
                <span className="font-semibold text-[11px] uppercase tracking-wider">
                  {t("存储桶", "Buckets")}
                </span>
                {buckets.length > 0 && (
                  <span className="rounded-full bg-muted px-1.5 py-px text-[10px] text-foreground/40 tabular-nums">
                    {buckets.length}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-0.5 group-data-[collapsible=icon]:hidden">
                {activeProfile.provider === "qiniu" && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-foreground/40 hover:text-primary"
                    onClick={() => setQiniuManagementOpen(true)}
                    title={t("管理七牛空间", "Manage Qiniu buckets")}
                    aria-label={t("管理七牛空间", "Manage Qiniu buckets")}
                  >
                    <IconGear className="size-[11px]" aria-hidden="true" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-foreground/40 hover:text-primary group-data-[collapsible=icon]:hidden"
                  onClick={refreshBuckets}
                  title={t("刷新存储桶列表", "Refresh Buckets")}
                >
                  <IconArrowsRotate className="size-[11px]" />
                </Button>
              </div>
            </SidebarGroupLabel>
            {bucketError && (
              <p
                role="alert"
                className="break-words px-3 py-2 text-xs leading-relaxed text-destructive group-data-[collapsible=icon]:hidden"
              >
                {localize(bucketError)}
              </p>
            )}
            <div
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:thin]"
              data-testid="sidebar-bucket-viewport"
            >
              <BucketList
                buckets={buckets}
                loading={bucketsLoading}
                selectedBucket={selectedBucket}
                profileId={activeProfile?.id ?? null}
                onSelect={selectBucket}
              />
            </div>
          </SidebarGroup>
        )}
      </SidebarContent>

      {/* ── Footer: profile count + lock ── */}
      <SidebarFooter className="shrink-0 gap-1 border-border border-t px-2 py-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 justify-start gap-2.5 text-xs text-muted-foreground group-data-[collapsible=icon]:justify-center"
          onClick={() => useUIStore.getState().setSettingsOpen(true)}
          title={t("设置与关于", "Settings and about")}
          aria-label={t("设置与关于", "Settings and about")}
        >
          <IconGear className="size-4 shrink-0" />
          <span className="group-data-[collapsible=icon]:hidden">
            {t("设置", "Settings")}
          </span>
        </Button>
        <div className="flex items-center justify-between px-1 group-data-[collapsible=icon]:justify-center">
          <div className="text-[11px] text-foreground/35 group-data-[collapsible=icon]:hidden">
            {profiles.length} {t("个账号", "accounts")}
            {profiles.length !== 1 ? "" : ""}
            {buckets.length > 0 && (
              <>
                {" "}
                · {buckets.length} {t("个存储桶", "buckets")}
                {buckets.length !== 1 ? "" : ""}
              </>
            )}
          </div>
          {!plaintext && (
            <Button
              variant="ghost"
              size="sm"
              className="text-foreground/40 hover:text-destructive"
              onClick={lock}
              title={t("锁定密码库", "Lock Vault")}
            >
              <IconLock className="size-4" />
              <span className="text-[11px] group-data-[collapsible=icon]:hidden">
                {t("锁定", "Lock")}
              </span>
            </Button>
          )}
          {plaintext && (
            <span
              className="text-[10px] text-warning group-data-[collapsible=icon]:hidden"
              title={t(
                "凭据以明文保存在本机",
                "Credentials are stored locally as plaintext",
              )}
            >
              {t("明文", "Plaintext")}
            </span>
          )}
        </div>
      </SidebarFooter>

      {/* Click-to-resize rail */}
      <SidebarRail />

      {/* ── Modals ── */}
      {qiniuProfile?.provider === "qiniu" && (
        <QiniuBucketPanel
          profile={qiniuProfile}
          bucketName={selectedBucket}
          open={qiniuManagementOpen}
          onOpenChange={setQiniuManagementOpen}
          onRemoved={handleQiniuBucketRemoved}
        />
      )}
      <ProfileForm
        open={addingProfile}
        onClose={() => setAddingProfile(false)}
      />

      {viewingProfile && (
        <ProfileDetailsDialog
          key={viewingProfile.id}
          profile={viewingProfile}
          onClose={() => setViewingProfile(null)}
        />
      )}

      {/* Mounted per-profile so the form initializes from the edited profile. */}
      {editingProfile && (
        <ProfileForm
          key={editingProfile.id}
          open
          editProfile={editingProfile}
          onClose={() => setEditingProfile(null)}
        />
      )}

      <ConfirmDialog
        open={!!deletingProfile}
        title={t("删除存储账号", "Delete Profile")}
        message={t(
          `确定删除存储账号“${deletingProfile?.name}”吗？此操作无法撤销。`,
          `Delete account “${deletingProfile?.name}”? This cannot be undone.`,
        )}
        confirmLabel={t("删除", "Delete")}
        destructive
        onConfirm={handleDeleteProfile}
        onClose={() => setDeletingProfile(null)}
      />
    </SidebarPrimitive>
  );
}

/* ── Provider icon map ── */
type LucideIconComponent = React.ComponentType<{ className?: string }>;

function providerIcon(provider: string): LucideIconComponent {
  const map: Record<string, LucideIconComponent> = {
    aws: IconAws,
    r2: IconCloud,
    spaces: IconDigitalOcean,
    minio: IconServer,
    gcs: IconGoogle,
    backblaze: IconFire,
    qiniu: IconCloud,
    custom: IconGear,
  };
  return map[provider] ?? IconCloud;
}
