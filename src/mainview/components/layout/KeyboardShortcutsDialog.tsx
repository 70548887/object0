import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { IconKeyboard } from "@/lib/icons";

const SHORTCUTS: { combo: string; label: string }[] = [
  { combo: "Ctrl+K", label: "命令面板" },
  { combo: "Ctrl+B", label: "显示或隐藏侧栏" },
  { combo: "Ctrl+J", label: "显示或隐藏任务面板" },
  { combo: "Ctrl+\\", label: "切换主题" },
  { combo: "Ctrl+,", label: "打开设置" },
  { combo: "↑ / ↓", label: "选择上一行或下一行" },
  { combo: "Space", label: "切换选中状态" },
  { combo: "Enter", label: "打开文件夹" },
  { combo: "F2", label: "重命名文件" },
  { combo: "Ctrl+A", label: "全选" },
  { combo: "Esc", label: "取消选择" },
  { combo: "Backspace", label: "返回上一级" },
];

export function KeyboardShortcutsDialog() {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="no-drag"
            title={"键盘快捷键"}
            aria-label={"键盘快捷键"}
          >
            <IconKeyboard className="size-4" />
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>键盘快捷键</DialogTitle>
          <DialogDescription>查看可用的键盘快捷键。</DialogDescription>
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
