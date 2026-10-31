import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { t, useT } from "@/lib/i18n";
import { IconKeyboard } from "@/lib/icons";

const SHORTCUTS: { combo: string; label: string }[] = [
  {
    combo: "Ctrl+K",
    get label() {
      return t("命令面板", "Command Palette");
    },
  },
  {
    combo: "Ctrl+B",
    get label() {
      return t("显示或隐藏侧栏", "Toggle Sidebar");
    },
  },
  {
    combo: "Ctrl+J",
    get label() {
      return t("显示或隐藏任务面板", "Toggle Job Panel");
    },
  },
  {
    combo: "Ctrl+\\",
    get label() {
      return t("切换主题", "Toggle Theme");
    },
  },
  {
    combo: "Ctrl+,",
    get label() {
      return t("打开设置", "Open Settings");
    },
  },
  {
    combo: "↑ / ↓",
    get label() {
      return t("选择上一行或下一行", "Navigate rows");
    },
  },
  {
    combo: "Space",
    get label() {
      return t("切换选中状态", "Toggle selection");
    },
  },
  {
    combo: "Enter",
    get label() {
      return t("打开文件夹", "Open folder");
    },
  },
  {
    combo: "F2",
    get label() {
      return t("重命名文件", "Rename file");
    },
  },
  {
    combo: "Ctrl+A",
    get label() {
      return t("全选", "Select all");
    },
  },
  {
    combo: "Esc",
    get label() {
      return t("取消选择", "Clear selection");
    },
  },
  {
    combo: "Backspace",
    get label() {
      return t("返回上一级", "Go back");
    },
  },
];

export function KeyboardShortcutsDialog() {
  useT();
  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="no-drag"
            title={t("键盘快捷键", "Keyboard Shortcuts")}
            aria-label={t("键盘快捷键", "Keyboard Shortcuts")}
          >
            <IconKeyboard className="size-4" />
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("键盘快捷键", "Keyboard Shortcuts")}</DialogTitle>
          <DialogDescription>
            {t(
              "查看可用的键盘快捷键。",
              "Quick reference for available keyboard shortcuts.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5 text-sm">
          {SHORTCUTS.map((s) => (
            <div
              key={s.label}
              className="flex items-center justify-between gap-4"
            >
              <span className="text-foreground/60">{s.label}</span>
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/70">
                {s.combo}
              </kbd>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
