import type { ExpirationUnit } from "@shared/share.types";

const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const MS_PER_MINUTE = MINUTE_SECONDS * 1000;
const MS_PER_HOUR = HOUR_SECONDS * 1000;
const MS_PER_DAY = DAY_SECONDS * 1000;

export const EXPIRATION_PRESETS = [
  { label: "1 小时", seconds: HOUR_SECONDS },
  { label: "6 小时", seconds: 6 * HOUR_SECONDS },
  { label: "24 小时", seconds: DAY_SECONDS },
  { label: "7 天", seconds: 7 * DAY_SECONDS },
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
      error: `请输入 1 至 ${maximum} 的整数（${UNIT_LABELS[unit]}），最长有效期为 7 天。`,
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
    return "有效期未知";
  }
  const remainingMs = expiresMs - nowMs;
  if (remainingMs <= 0) return "已过期";
  if (remainingMs < MS_PER_MINUTE) return "不足1分钟";
  if (remainingMs < MS_PER_HOUR) {
    return `${Math.ceil(remainingMs / MS_PER_MINUTE)} 分钟`;
  }
  if (remainingMs < MS_PER_DAY) {
    return `${Math.ceil(remainingMs / MS_PER_HOUR)} 小时`;
  }
  return `${Math.ceil(remainingMs / MS_PER_DAY)} 天`;
}
