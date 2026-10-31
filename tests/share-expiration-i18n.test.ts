import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  formatShareExpiration,
  parseCustomExpiration,
} from "../src/mainview/components/share/share-expiration";
import { PROVIDERS } from "../src/mainview/lib/constants";
import {
  formatBytes,
  formatDate,
  getFileName,
} from "../src/mainview/lib/formatters";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";
import { PROVIDER_LABELS } from "../src/shared/profile.types";

beforeEach(() => useLocaleStore.getState().setLocale("zh-CN"));
afterEach(() => useLocaleStore.getState().setLocale("zh-CN"));

describe("sharing and file metadata localization", () => {
  test("defaults to Chinese and switches remaining duration without losing units", () => {
    const now = Date.parse("2026-10-31T00:00:00Z");
    const minuteLater = new Date(now + 60_000).toISOString();
    expect(formatShareExpiration(minuteLater, now)).toBe("1 分钟");
    useLocaleStore.getState().setLocale("en");
    expect(formatShareExpiration(minuteLater, now)).toBe("1 minute");
    expect(
      formatShareExpiration(new Date(now + 3_600_000).toISOString(), now),
    ).toBe("1 hour");
    expect(
      formatShareExpiration(new Date(now + 86_400_000).toISOString(), now),
    ).toBe("1 day");
    expect(formatShareExpiration(new Date(now - 1).toISOString(), now)).toBe(
      "Expired",
    );
    expect(formatShareExpiration("invalid", now)).toBe("Expiration unknown");
  });

  test("validates the same input while switching error language", () => {
    expect(parseCustomExpiration("8", "days").error).toContain("最长有效期");
    useLocaleStore.getState().setLocale("en");
    expect(parseCustomExpiration("8", "days")).toEqual({
      seconds: null,
      error: "Enter a whole number from 1 to 7 (days), up to 7 days.",
    });
    expect(parseCustomExpiration("7", "days")).toEqual({
      seconds: 604800,
      error: null,
    });
  });

  test("provider labels remain live instead of freezing at module import", () => {
    const custom = PROVIDERS.find((provider) => provider.value === "custom");
    if (!custom) throw new Error("Custom provider is missing");
    expect(custom.label).toBe("自定义 S3 兼容存储");
    expect(PROVIDER_LABELS.custom).toBe("自定义 S3 兼容存储");
    useLocaleStore.getState().setLocale("en");
    expect(custom.label).toBe("Custom S3-compatible storage");
    expect(PROVIDER_LABELS.custom).toBe("Custom S3-Compatible");
    useLocaleStore.getState().setLocale("zh-CN");
    expect(custom.label).toBe("自定义 S3 兼容存储");
  });

  test("dates follow the selected locale while object names and byte units remain intact", () => {
    const date = "2026-01-02T03:04:00Z";
    expect(formatDate(date)).not.toContain("Jan");
    useLocaleStore.getState().setLocale("en");
    expect(formatDate(date)).toContain("Jan");
    expect(getFileName("目录/保留原始文件名.pdf")).toBe("保留原始文件名.pdf");
    expect(formatBytes(1024)).toBe("1 KB");
  });
});
