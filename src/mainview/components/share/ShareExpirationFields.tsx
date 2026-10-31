import { Select as SelectPrimitive } from "@base-ui/react/select";
import type { ExpirationUnit } from "@shared/share.types";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { IconCheck, IconCircleInfo } from "@/lib/icons";
import { cn } from "@/lib/utils";
import {
  EXPIRATION_PRESETS,
  CUSTOM_EXPIRATION_MAX as MAX_VALUES,
} from "./share-expiration";

interface ShareExpirationFieldsProps {
  mode: "preset" | "custom";
  onModeChange: (mode: "preset" | "custom") => void;
  selectedPreset: number;
  onPresetChange: (index: number) => void;
  customValue: string;
  onCustomValueChange: (value: string) => void;
  customUnit: ExpirationUnit;
  onCustomUnitChange: (unit: ExpirationUnit) => void;
  disabled: boolean;
  error: string | null;
}

const PRESET_LABELS = EXPIRATION_PRESETS.map((preset) => preset.label);
const UNIT_LABELS: Record<ExpirationUnit, string> = {
  minutes: "分钟",
  hours: "小时",
  days: "天",
};

function ExpirationUnitOption({ unit }: { unit: ExpirationUnit }) {
  return (
    <SelectPrimitive.Item
      value={unit}
      className="relative flex min-h-9 w-full cursor-default items-center rounded-md py-2 pr-9 pl-3 text-sm text-foreground outline-none select-none data-[selected]:bg-primary/10 data-[selected]:text-primary data-[highlighted]:not-data-[selected]:bg-muted data-[highlighted]:not-data-[selected]:text-foreground data-[highlighted]:ring-1 data-[highlighted]:ring-inset data-[highlighted]:ring-primary/35 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 dark:data-[selected]:bg-primary/15"
    >
      <SelectPrimitive.ItemText>{UNIT_LABELS[unit]}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="pointer-events-none absolute right-3 flex size-4 items-center justify-center">
        <IconCheck className="size-4" aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export function ShareExpirationFields({
  mode,
  onModeChange,
  selectedPreset,
  onPresetChange,
  customValue,
  onCustomValueChange,
  customUnit,
  onCustomUnitChange,
  disabled,
  error,
}: ShareExpirationFieldsProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const customId = `${id}-value`;
  const describedBy = error ? `${hintId} ${errorId}` : hintId;

  return (
    <fieldset
      disabled={disabled}
      className="min-w-0 space-y-4 disabled:opacity-60"
      aria-describedby={hintId}
    >
      <legend className="mb-3 text-sm font-semibold text-foreground">
        链接有效期
      </legend>

      <fieldset
        aria-label="有效期设置方式"
        className="grid grid-cols-2 gap-1 rounded-lg bg-muted/80 p-1"
      >
        {(
          [
            ["preset", "预设时长"],
            ["custom", "自定义"],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            type="button"
            variant="ghost"
            disabled={disabled}
            aria-pressed={mode === value}
            onClick={() => onModeChange(value)}
            className={cn(
              "h-9 min-w-0 rounded-md border text-sm transition-colors focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/25",
              mode === value
                ? "border-border/70 bg-background text-foreground shadow-xs hover:bg-background dark:bg-card dark:hover:bg-card"
                : "border-transparent text-muted-foreground hover:bg-background/50 hover:text-foreground dark:hover:bg-background/30",
            )}
          >
            {label}
          </Button>
        ))}
      </fieldset>

      {mode === "preset" ? (
        <fieldset className="min-w-0">
          <legend className="sr-only">选择分享链接有效时长</legend>
          <div className="grid grid-cols-2 gap-2.5">
            {PRESET_LABELS.map((label, index) => (
              <label key={label} className="min-w-0">
                <input
                  type="radio"
                  name={`${id}-preset`}
                  checked={selectedPreset === index}
                  disabled={disabled}
                  onChange={() => onPresetChange(index)}
                  className="peer sr-only"
                />
                <span
                  className={cn(
                    "flex min-h-12 cursor-pointer items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary/70 peer-disabled:cursor-not-allowed",
                    selectedPreset === index
                      ? "border-primary bg-primary/8 text-primary dark:bg-primary/15"
                      : "border-border bg-background text-foreground hover:bg-muted/65 dark:bg-card dark:hover:bg-muted/45",
                  )}
                >
                  {label}
                  <IconCheck
                    className={cn(
                      "size-4 shrink-0",
                      selectedPreset !== index && "invisible",
                    )}
                    aria-hidden="true"
                  />
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <div className="min-h-28 space-y-2">
          <label
            htmlFor={customId}
            className="text-xs font-medium text-foreground"
          >
            有效时长
          </label>
          <div className="grid min-w-0 grid-cols-2 gap-2.5">
            <Input
              id={customId}
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_VALUES[customUnit]}
              step={1}
              value={customValue}
              disabled={disabled}
              aria-invalid={Boolean(error)}
              aria-describedby={describedBy}
              onChange={(event) => onCustomValueChange(event.target.value)}
              className="h-10 min-w-0 bg-background text-sm tabular-nums focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/25 dark:bg-card"
            />
            <Select
              value={customUnit}
              disabled={disabled}
              onValueChange={(value) => {
                if (
                  value === "minutes" ||
                  value === "hours" ||
                  value === "days"
                )
                  onCustomUnitChange(value);
              }}
            >
              <SelectTrigger
                aria-label="时长单位"
                aria-describedby={hintId}
                className="w-full min-w-0 bg-background focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/25 aria-expanded:border-primary aria-expanded:ring-2 aria-expanded:ring-primary/15 data-[size=default]:h-10 dark:bg-card"
              >
                <SelectValue>
                  {(value) =>
                    UNIT_LABELS[value as ExpirationUnit] ?? "选择单位"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent
                alignItemWithTrigger={false}
                align="start"
                side="bottom"
                className="min-w-0 p-1"
              >
                <ExpirationUnitOption unit="minutes" />
                <ExpirationUnitOption unit="hours" />
                <ExpirationUnitOption unit="days" />
              </SelectContent>
            </Select>
          </div>
          {error && (
            <p
              id={errorId}
              role="status"
              aria-live="polite"
              className="text-xs leading-relaxed text-destructive"
            >
              {error}
            </p>
          )}
        </div>
      )}

      <div id={hintId} className="flex items-start gap-2 text-muted-foreground">
        <IconCircleInfo
          className="mt-0.5 size-3.5 shrink-0"
          aria-hidden="true"
        />
        <div className="space-y-1 text-xs leading-relaxed">
          <p>最长有效期：7 天</p>
          <p className="text-muted-foreground/85">到期后，分享链接将失效</p>
        </div>
      </div>
    </fieldset>
  );
}
