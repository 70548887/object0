import { useLocaleStore } from "@/stores/useLocaleStore";

export function LanguageSwitcher() {
  const locale = useLocaleStore((state) => state.locale);
  const setLocale = useLocaleStore((state) => state.setLocale);
  return (
    <label className="no-drag flex items-center gap-2 text-xs text-muted-foreground">
      <span className="sr-only">语言 / Language</span>
      <select
        aria-label="语言 / Language"
        value={locale}
        onChange={(event) =>
          setLocale(event.target.value === "en" ? "en" : "zh-CN")
        }
        className="h-8 rounded-md border border-border bg-background px-2 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <option value="zh-CN">简体中文</option>
        <option value="en">English</option>
      </select>
    </label>
  );
}
