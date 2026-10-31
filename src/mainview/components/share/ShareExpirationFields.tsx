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
import { localize, t, useT } from "@/lib/i18n";
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

const UNIT_LABELS: Record<ExpirationUnit, string> = {
  minutes: "分钟",
  hours: "小时",
  days: "天",
};
const UNIT_LABELS_EN: Record<ExpirationUnit, string> = {
  minutes: "Minutes",
  hours: "Hours",
  days: "Days",
};
const unitLabel = (unit: ExpirationUnit) =>
  UNIT_LABELS[unit] && UNIT_LABELS_EN[unit]
    ? t(UNIT_LABELS[unit], UNIT_LABELS_EN[unit])
    : t("选择单位", "Select a unit");

function ExpirationUnitOption({ unit }: { unit: ExpirationUnit }) {
  useT();
  return (
    <SelectPrimitive.Item
      value={unit}
      className="relative flex min-h-9 w-full cursor-default items-center rounded-md py-2 pr-9 pl-3 text-sm text-foreground outline-none select-none data-[selected]:bg-primary/10 data-[selected]:text-primary data-[highlighted]:not-data-[selected]:bg-muted data-[highlighted]:not-data-[selected]:text-foreground data-[highlighted]:ring-1 data-[highlighted]:ring-inset data-[highlighted]:ring-primary/35 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 dark:data-[selected]:bg-primary/15"
    >
      <SelectPrimitive.ItemText>{unitLabel(unit)}</SelectPrimitive.ItemText>
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
  useT();
  const presetLabels = EXPIRATION_PRESETS.map((preset) =>
    t(preset.label, preset.labelEn),
  );
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
        {t("链接有效期", "Link expiration")}
      </legend>

      <fieldset
        aria-label={t("有效期设置方式", "Expiration mode")}
        className="grid grid-cols-2 gap-1 rounded-lg bg-muted/80 p-1"
      >
        {(
          [
            ["preset", t("预设时长", "Preset duration")],
            ["custom", t("自定义", "Custom")],
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
          <legend className="sr-only">
            {t("选择分享链接有效时长", "Choose a link duration")}
          </legend>
          <div className="grid grid-cols-2 gap-2.5">
            {presetLabels.map((label, index) => (
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
            {t("有效时长", "Duration")}
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
                aria-label={t("时长单位", "Duration unit")}
                aria-describedby={hintId}
                className="w-full min-w-0 bg-background focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/25 aria-expanded:border-primary aria-expanded:ring-2 aria-expanded:ring-primary/15 data-[size=default]:h-10 dark:bg-card"
              >
                <SelectValue>
                  {(value) =>
                    unitLabel(value as ExpirationUnit) ??
                    t("选择单位", "Select a unit")
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
              {localize(error)}
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
          <p>{t("最长有效期：7 天", "Maximum expiration: 7 days")}</p>
          <p className="text-muted-foreground/85">
            {t(
              "到期后，分享链接将失效",
              "The sharing link stops working after it expires.",
            )}
          </p>
        </div>
      </div>
    </fieldset>
  );
}
