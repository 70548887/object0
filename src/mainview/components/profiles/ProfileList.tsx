import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import type { ProfileInfo } from "@shared/profile.types";
import { PROVIDER_LABELS } from "@shared/profile.types";
import { useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { localize, t, useT } from "@/lib/i18n";
import {
  IconAws,
  IconCloud,
  IconCopy,
  IconDigitalOcean,
  IconFire,
  IconGear,
  IconGoogle,
  IconInfo,
  IconKey,
  IconPenToSquare,
  IconServer,
  IconTrashCan,
  IconWifi,
} from "@/lib/icons";
import { rpcCall } from "@/lib/rpc-client";
import { toast } from "../common/Toast";
import {
  copyAllProfileInformation,
  copyCredential,
  copyValue,
  profileInformation,
} from "./profileCredentials";

interface ProfileListProps {
  profiles: ProfileInfo[];
  activeId: string | null;
  onSelect: (profile: ProfileInfo) => void;
  onView: (profile: ProfileInfo) => void;
  onEdit: (profile: ProfileInfo) => void;
  onDelete: (profile: ProfileInfo) => void;
}

export function ProfileList({
  profiles,
  activeId,
  onSelect,
  onView,
  onEdit,
  onDelete,
}: ProfileListProps) {
  useT();
  const [testingProfiles, setTestingProfiles] = useState<Set<string>>(
    () => new Set(),
  );

  const testSavedConnection = async (profile: ProfileInfo) => {
    if (testingProfiles.has(profile.id)) return;
    setTestingProfiles((current) => new Set(current).add(profile.id));
    const toastId = toast.loading(
      t(
        `正在测试“${profile.name}”的连接...`,
        `Testing the connection for “${profile.name}”…`,
      ),
    );
    try {
      const result = await rpcCall("profile:test-saved", {
        profileId: profile.id,
      });
      if (result.success) {
        toast.success(
          t(
            `“${profile.name}”连接成功`,
            `“${profile.name}” connected successfully`,
          ),
          { id: toastId },
        );
      } else {
        toast.error(
          t(
            `连接失败：${result.error ?? "请检查账号配置"}`,
            `Connection failed: ${localize(result.error ?? t("请检查账号配置", "Check the account configuration"))}`,
          ),
          {
            id: toastId,
          },
        );
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : t("请确认密码库已解锁", "Make sure the vault is unlocked");
      toast.error(
        t(
          `测试连接失败：${message}`,
          `Connection test failed: ${localize(message)}`,
        ),
        { id: toastId },
      );
    } finally {
      setTestingProfiles((current) => {
        const next = new Set(current);
        next.delete(profile.id);
        return next;
      });
    }
  };

  if (profiles.length === 0) {
    return (
      <div className="px-3 py-4 text-center text-muted-foreground/60 text-xs">
        {t(
          "暂无存储账号，点击 + 添加。",
          "No profiles yet. Click + to add one.",
        )}
      </div>
    );
  }

  return (
    <ul className="w-full px-0">
      {profiles.map((p) => (
        <ContextMenu key={p.id}>
          <ContextMenuPrimitive.Trigger
            data-slot="context-menu-trigger"
            className="select-none w-full"
            render={<li />}
          >
            <button
              type="button"
              title={p.name}
              className={`flex w-full items-center gap-2 rounded-none px-3 py-1.5 text-sm transition-colors duration-150 hover:bg-accent hover:text-accent-foreground group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-2 ${
                p.id === activeId
                  ? "bg-accent text-accent-foreground"
                  : "text-foreground"
              }`}
              onClick={() => onSelect(p)}
            >
              <span className="text-base shrink-0">
                <ProviderIcon provider={p.provider} />
              </span>
              <div className="flex min-w-0 flex-col items-start group-data-[collapsible=icon]:hidden">
                <span className="w-full truncate font-medium text-sm">
                  {p.name}
                </span>
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[9px] leading-tight ${providerBadge(p.provider)}`}
                >
                  <span
                    className={`inline-block h-1.5 w-1.5 rounded-full ${providerDot(p.provider)}`}
                  />
                  {PROVIDER_LABELS[p.provider]}
                </span>
              </div>
            </button>
          </ContextMenuPrimitive.Trigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => onEdit(p)}>
              <IconPenToSquare className="size-3.5 shrink-0" />{" "}
              {t("编辑", "Edit")}
            </ContextMenuItem>
            <ContextMenuItem
              disabled={testingProfiles.has(p.id)}
              onClick={() => void testSavedConnection(p)}
            >
              <IconWifi className="size-3.5 shrink-0" />
              {testingProfiles.has(p.id)
                ? t("正在测试连接...", "Testing connection…")
                : t("测试连接", "Test connection")}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => void copyAllProfileInformation(p)}>
              <IconCopy className="size-3.5 shrink-0" />{" "}
              {t("复制信息（含密钥）", "Copy details (including secrets)")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onView(p)}>
              <IconInfo className="size-3.5 shrink-0" />{" "}
              {t("查看账号信息", "View account details")}
            </ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <IconCopy className="size-3.5 shrink-0" />{" "}
                {t("复制指定信息", "Copy a specific field")}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem
                  onClick={() =>
                    void copyValue(
                      profileInformation(p),
                      t("账号信息", "Account details"),
                    )
                  }
                >
                  <IconCopy className="size-3.5 shrink-0" />{" "}
                  {t("复制普通信息", "Copy non-secret details")}
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() =>
                    void copyCredential(
                      p,
                      "accessKeyId",
                      t("访问密钥 ID", "Access key ID"),
                    )
                  }
                >
                  <IconKey className="size-3.5 shrink-0" />{" "}
                  {t("复制访问密钥 ID", "Copy access key ID")}
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() =>
                    void copyCredential(
                      p,
                      "secretAccessKey",
                      t("访问密钥", "Secret access key"),
                    )
                  }
                >
                  <IconKey className="size-3.5 shrink-0" />{" "}
                  {t("复制访问密钥", "Copy secret access key")}
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={() => onDelete(p)}>
              <IconTrashCan className="size-3.5 shrink-0" />{" "}
              {t("删除", "Delete")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}
    </ul>
  );
}

function ProviderIcon({ provider }: { provider: ProfileInfo["provider"] }) {
  useT();
  switch (provider) {
    case "aws":
      return <IconAws className="size-4 text-warning" />;
    case "r2":
      return <IconCloud className="size-4 text-info" />;
    case "spaces":
      return <IconDigitalOcean className="size-4 text-info" />;
    case "minio":
      return <IconServer className="size-4 text-destructive" />;
    case "gcs":
      return <IconGoogle className="size-4 text-success" />;
    case "backblaze":
      return <IconFire className="size-4 text-foreground" />;
    case "custom":
      return <IconGear className="size-4 text-muted-foreground" />;
    default:
      return <IconCloud className="size-4" />;
  }
}

function providerBadge(provider: ProfileInfo["provider"]): string {
  const map: Record<string, string> = {
    aws: "bg-warning/10 text-warning",
    r2: "bg-info/10 text-info",
    spaces: "bg-info/10 text-info",
    minio: "bg-destructive/10 text-destructive",
    gcs: "bg-success/10 text-success",
    backblaze: "bg-foreground/10 text-foreground/60",
    custom: "bg-foreground/5 text-foreground/40",
  };
  return map[provider] ?? "bg-foreground/5 text-foreground/40";
}

function providerDot(provider: ProfileInfo["provider"]): string {
  const map: Record<string, string> = {
    aws: "bg-warning",
    r2: "bg-info",
    spaces: "bg-info",
    minio: "bg-destructive",
    gcs: "bg-success",
    backblaze: "bg-foreground",
    custom: "bg-foreground/40",
  };
  return map[provider] ?? "bg-foreground/40";
}
