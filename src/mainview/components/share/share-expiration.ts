import type { ExpirationUnit } from "@shared/share.types";
import { t } from "@/lib/i18n";

const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const MS_PER_MINUTE = MINUTE_SECONDS * 1000;
const MS_PER_HOUR = HOUR_SECONDS * 1000;
const MS_PER_DAY = DAY_SECONDS * 1000;

export const EXPIRATION_PRESETS = [
  { label: "1 小时", labelEn: "1 hour", seconds: HOUR_SECONDS },
  { label: "6 小时", labelEn: "6 hours", seconds: 6 * HOUR_SECONDS },
  { label: "24 小时", labelEn: "24 hours", seconds: DAY_SECONDS },
  { label: "7 天", labelEn: "7 days", seconds: 7 * DAY_SECONDS },
];

export const CUSTOM_EXPIRATION_MAX: Record<ExpirationUnit, number> = {
  minutes: 10080,
  hours: 168,
  days: 7,
};

const UNIT_SECONDS: Record<ExpirationUnit, number> = {
  minutes: MINUTE_SECONDS,
  hours: HOUR_SECONDS,
  days: DAY_SECONDS,
};

const UNIT_LABELS: Record<ExpirationUnit, string> = {
  minutes: "分钟",
  hours: "小时",
  days: "天",
};
const UNIT_LABELS_EN: Record<ExpirationUnit, string> = {
  minutes: "minutes",
  hours: "hours",
  days: "days",
};

export interface CustomExpirationResult {
  seconds: number | null;
  error: string | null;
}

export function parseCustomExpiration(
  value: string,
  unit: ExpirationUnit,
): CustomExpirationResult {
  const trimmed = value.trim();
  const amount = Number(trimmed);
  const maximum = CUSTOM_EXPIRATION_MAX[unit];
  if (
    !/^[0-9]+$/.test(trimmed) ||
    !Number.isSafeInteger(amount) ||
    amount < 1 ||
    amount > maximum
  ) {
    return {
      seconds: null,
      error: t(
        `请输入 1 至 ${maximum} 的整数（${UNIT_LABELS[unit]}），最长有效期为 7 天。`,
        `Enter a whole number from 1 to ${maximum} (${UNIT_LABELS_EN[unit]}), up to 7 days.`,
      ),
    };
  }
  return { seconds: amount * UNIT_SECONDS[unit], error: null };
}

export function formatShareExpiration(
  isoDate: string,
  nowMs = Date.now(),
): string {
  const expiresMs = Date.parse(isoDate);
  if (!Number.isFinite(expiresMs) || !Number.isFinite(nowMs)) {
    return t("有效期未知", "Expiration unknown");
  }
  const remainingMs = expiresMs - nowMs;
  if (remainingMs <= 0) return t("已过期", "Expired");
  if (remainingMs < MS_PER_MINUTE) return t("不足1分钟", "Less than 1 minute");
  if (remainingMs < MS_PER_HOUR) {
    const minutes = Math.ceil(remainingMs / MS_PER_MINUTE);
    return t(`${minutes} 分钟`, `${minutes} minute${minutes === 1 ? "" : "s"}`);
  }
  if (remainingMs < MS_PER_DAY) {
    const hours = Math.ceil(remainingMs / MS_PER_HOUR);
    return t(`${hours} 小时`, `${hours} hour${hours === 1 ? "" : "s"}`);
  }
  const days = Math.ceil(remainingMs / MS_PER_DAY);
  return t(`${days} 天`, `${days} day${days === 1 ? "" : "s"}`);
}
