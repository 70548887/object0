import type { SyncEntryPreference } from "@shared/ui.types";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t, useT } from "@/lib/i18n";
import { IconFolderOpen, IconRotate } from "@/lib/icons";
import { useUIStore } from "@/stores";

function optionCopy(preference: SyncEntryPreference) {
  if (preference === "object-sync") {
    return {
      title: t("对象同步（一次性）", "Object sync (one-time)"),
      description: t(
        "将存储桶或路径一次性复制到其他存储桶或账号。",
        "Copy a bucket or prefix to another bucket or account once.",
      ),
      note: t("执行一次后停止。", "Runs once, then stops."),
    };
  }

  return {
    title: t("实时文件夹同步", "Live folder sync"),
    description: t(
      "持续同步本地文件夹和存储桶路径。",
      "Continuously sync a local folder and a bucket prefix.",
    ),
    note: t("在后台持续运行。", "Keeps running in the background."),
  };
}

export function SyncTypeChooserDialog() {
  const t = useT();
  const open = useUIStore((s) => s.syncChooserOpen);
  const closeSyncChooser = useUIStore((s) => s.closeSyncChooser);
  const setSyncDialogOpen = useUIStore((s) => s.setSyncDialogOpen);
  const setFolderSyncPanelOpen = useUIStore((s) => s.setFolderSyncPanelOpen);
  const setSyncEntryPreference = useUIStore((s) => s.setSyncEntryPreference);

  const [rememberChoice, setRememberChoice] = useState(false);

  useEffect(() => {
    if (open) {
      setRememberChoice(false);
    }
  }, [open]);

  const handleChoose = (preference: SyncEntryPreference) => {
    if (rememberChoice) {
      setSyncEntryPreference(preference);
    }
    closeSyncChooser();

    if (preference === "object-sync") {
      setSyncDialogOpen(true);
      return;
    }

    setFolderSyncPanelOpen(true);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && closeSyncChooser()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("请选择同步方式", "Choose a sync type")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-foreground/60 text-xs">
            {t(
              "请选择同步方式。可以每次选择，也可以将其设为同步按钮的默认方式。",
              "Choose a sync type each time, or remember it as the default for the Sync button.",
            )}
          </p>

          {(["object-sync", "live-folder-sync"] as const).map((preference) => {
            const option = optionCopy(preference);
            return (
              <button
                key={preference}
                type="button"
                className="w-full rounded-lg border border-border bg-background p-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
                onClick={() => handleChoose(preference)}
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-primary">
                    {preference === "object-sync" ? (
                      <IconRotate className="size-4" />
                    ) : (
                      <IconFolderOpen className="size-4" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="font-medium text-sm">{option.title}</div>
                    <div className="mt-0.5 text-foreground/65 text-xs">
                      {option.description}
                    </div>
                    <div className="mt-0.5 text-[10px] text-foreground/45">
                      {option.note}
                    </div>
                  </div>
                </div>
              </button>
            );
          })}

          <div className="flex items-center gap-2 border-border border-t pt-2">
            <Checkbox
              checked={rememberChoice}
              onCheckedChange={(v) => setRememberChoice(!!v)}
              id="remember-choice"
            />
            <label
              htmlFor="remember-choice"
              className="cursor-pointer text-foreground/75 text-xs"
            >
              {t(
                "记住此选择，以后直接使用",
                "Remember this choice and use it next time",
              )}
            </label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={closeSyncChooser}>
            {t("取消", "Cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
