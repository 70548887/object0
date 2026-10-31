import { describe, expect, test } from "bun:test";
import {
  CUSTOM_EXPIRATION_MAX,
  EXPIRATION_PRESETS,
  formatShareExpiration,
  parseCustomExpiration,
} from "../src/mainview/components/share/share-expiration";
import type { ExpirationUnit } from "../src/shared/share.types";

describe("custom share expiration", () => {
  test("preserves the one-hour default and existing presets", () => {
    expect(EXPIRATION_PRESETS.map((preset) => preset.seconds)).toEqual([
      3600, 21600, 86400, 604800,
    ]);
  });

  test.each([
    ["minutes", "分钟", 60],
    ["hours", "小时", 3600],
    ["days", "天", 86400],
  ] as const)("validates %s bounds and converts to seconds", (unit, label, scale) => {
    const maximum = CUSTOM_EXPIRATION_MAX[unit];
    expect(parseCustomExpiration(" 1 ", unit)).toEqual({
      seconds: scale,
      error: null,
    });
    expect(parseCustomExpiration(String(maximum), unit)).toEqual({
      seconds: 604800,
      error: null,
    });
    const overLimit = parseCustomExpiration(String(maximum + 1), unit);
    expect(overLimit.seconds).toBeNull();
    expect(overLimit.error).toContain(String(maximum));
    expect(overLimit.error).toContain(label);
  });

  test.each([
    "",
    "   ",
    "0",
    "-1",
    "+1",
    "1.5",
    "1.0",
    "1e2",
    "0x10",
    "NaN",
    "Infinity",
    "9007199254740993",
    "１２",
  ])("rejects invalid numeric input %j", (value) => {
    for (const unit of ["minutes", "hours", "days"] as ExpirationUnit[]) {
      const result = parseCustomExpiration(value, unit);
      expect(result.seconds).toBeNull();
      expect(result.error).toBeTruthy();
    }
  });

  test("allows decimal digits with leading zeros", () => {
    expect(parseCustomExpiration("006", "hours")).toEqual({
      seconds: 21600,
      error: null,
    });
  });
});

describe("remaining share expiration", () => {
  const nowMs = Date.parse("2026-10-31T00:00:00Z");
  const future = (milliseconds: number) =>
    new Date(nowMs + milliseconds).toISOString();

  test.each([
    [-1, "已过期"],
    [0, "已过期"],
    [1, "不足1分钟"],
    [59999, "不足1分钟"],
    [60000, "1 分钟"],
    [60001, "2 分钟"],
    [3599999, "60 分钟"],
    [3600000, "1 小时"],
    [3600001, "2 小时"],
    [86399999, "24 小时"],
    [86400000, "1 天"],
    [86400001, "2 天"],
    [604800000, "7 天"],
  ] as const)("formats remaining %i ms as %s", (remaining, expected) => {
    expect(formatShareExpiration(future(remaining), nowMs)).toBe(expected);
  });

  test("handles malformed expiration dates and invalid clocks", () => {
    expect(formatShareExpiration("not-a-date", nowMs)).toBe("有效期未知");
    expect(formatShareExpiration(future(60000), Number.NaN)).toBe("有效期未知");
  });
});
