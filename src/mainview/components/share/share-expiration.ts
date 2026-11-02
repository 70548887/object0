import type { ExpirationUnit } from "@shared/share.types";
import { t } from "@/lib/i18n";

const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const MS_PER_MINUTE = MINUTE_SECONDS * 1000;
const MS_PER_HOUR = HOUR_SECONDS * 1000;
const MS_PER_DAY = DAY_SECONDS * 1000;
export const DEFAULT_SHARE_MAX_SECONDS = 7 * DAY_SECONDS;

export function shareLinkState(
  entry: { expiresAt: string | null; accessMode?: "public" | "signed" },
  nowMs = Date.now(),
): "public" | "active" | "expired" | "unknown" {
  if (entry.accessMode === "public") return "public";
  const expiry =
    typeof entry.expiresAt === "string" ? Date.parse(entry.expiresAt) : NaN;
  if (!Number.isFinite(expiry) || !Number.isFinite(nowMs)) return "unknown";
  return expiry > nowMs ? "active" : "expired";
}

export function expirationMaxValues(
  maxSeconds = DEFAULT_SHARE_MAX_SECONDS,
): Record<ExpirationUnit, number> {
  return {
    minutes: Math.floor(maxSeconds / MINUTE_SECONDS),
    hours: Math.floor(maxSeconds / HOUR_SECONDS),
    days: Math.floor(maxSeconds / DAY_SECONDS),
  };
}

export function shareExpirationLimitLabel(
  maxSeconds = DEFAULT_SHARE_MAX_SECONDS,
): string {
  if (maxSeconds % DAY_SECONDS === 0)
    return t(
      `${maxSeconds / DAY_SECONDS} 天`,
      `${maxSeconds / DAY_SECONDS} days`,
    );
  if (maxSeconds % HOUR_SECONDS === 0)
    return t(
      `${maxSeconds / HOUR_SECONDS} 小时`,
      `${maxSeconds / HOUR_SECONDS} hours`,
    );
  return t(
    `${Math.floor(maxSeconds / MINUTE_SECONDS)} 分钟`,
    `${Math.floor(maxSeconds / MINUTE_SECONDS)} minutes`,
  );
}

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
  maxSeconds = DEFAULT_SHARE_MAX_SECONDS,
): CustomExpirationResult {
  if (!Number.isSafeInteger(maxSeconds) || maxSeconds < MINUTE_SECONDS) {
    return {
      seconds: null,
      error: t(
        "无法确认有效期上限，请重新读取连接配置。",
        "The expiration limit could not be verified. Reload connection settings.",
      ),
    };
  }
  const trimmed = value.trim();
  const amount = Number(trimmed);
  const maximum = expirationMaxValues(maxSeconds)[unit];
  if (
    !/^[0-9]+$/.test(trimmed) ||
    !Number.isSafeInteger(amount) ||
    amount < 1 ||
    amount > maximum
  ) {
    return {
      seconds: null,
      error: t(
        `请输入 1 至 ${maximum} 的整数（${UNIT_LABELS[unit]}），最长有效期为 ${shareExpirationLimitLabel(maxSeconds)}。`,
        `Enter a whole number from 1 to ${maximum} (${UNIT_LABELS_EN[unit]}), up to ${maxSeconds % DAY_SECONDS === 0 ? `${maxSeconds / DAY_SECONDS} days` : maxSeconds % HOUR_SECONDS === 0 ? `${maxSeconds / HOUR_SECONDS} hours` : `${Math.floor(maxSeconds / MINUTE_SECONDS)} minutes`}.`,
      ),
    };
  }
  return { seconds: amount * UNIT_SECONDS[unit], error: null };
}

export function formatShareExpiration(
  isoDate: string | null,
  nowMs = Date.now(),
): string {
  const expiresMs = typeof isoDate === "string" ? Date.parse(isoDate) : NaN;
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
