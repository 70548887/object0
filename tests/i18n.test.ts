import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  clearMessageTranslations,
  intlLocale,
  localize,
  t,
} from "../src/mainview/lib/i18n";
import {
  getLocale,
  normalizeLocale,
  readSavedLocale,
  useLocaleStore,
} from "../src/mainview/stores/useLocaleStore";

afterEach(() => {
  useLocaleStore.getState().setLocale("zh-CN");
  clearMessageTranslations();
});
describe("Yuncang interface languages", () => {
  test("persists and restores a language without touching account storage", () => {
    const previous = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    try {
      expect(readSavedLocale()).toBe("zh-CN");
      useLocaleStore.getState().setLocale("en");
      expect(readSavedLocale()).toBe("en");
      expect([...storage.keys()]).toEqual(["object0-locale"]);
      useLocaleStore.getState().setLocale("zh-CN");
      expect(readSavedLocale()).toBe("zh-CN");
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
  test("defaults to Chinese and rejects unknown preferences", () => {
    expect(getLocale()).toBe("zh-CN");
    expect(normalizeLocale(undefined)).toBe("zh-CN");
    expect(normalizeLocale("fr")).toBe("zh-CN");
    expect(normalizeLocale("en")).toBe("en");
  });
  test("switches in both directions without recreating the store", () => {
    expect(t("云仓", "Yuncang")).toBe("云仓");
    useLocaleStore.getState().setLocale("en");
    expect(t("云仓", "Yuncang")).toBe("Yuncang");
    expect(intlLocale()).toBe("en-US");
    expect(localize("云仓")).toBe("Yuncang");
    useLocaleStore.getState().setLocale("zh-CN");
    expect(localize("Yuncang")).toBe("云仓");
  });
  test("keeps feedback translatable in both directions", () => {
    t("已完成 3 个任务", "3 tasks completed");
    useLocaleStore.getState().setLocale("en");
    expect(localize("已完成 3 个任务")).toBe("3 tasks completed");
    useLocaleStore.getState().setLocale("zh-CN");
    expect(localize("3 tasks completed")).toBe("已完成 3 个任务");
  });
  test("translates known backend failures while preserving data", () => {
    useLocaleStore.getState().setLocale("en");
    expect(
      localize(
        "加载文件列表失败：访问被拒绝，请检查凭据是否有当前存储桶的对象列表读取权限（HTTP 403）",
      ),
    ).toContain("Access denied");
    expect(localize("下载 我的文件/图片.jpg")).toBe(
      "Download 我的文件/图片.jpg",
    );
    expect(localize("客户资料/上传备份.zip")).toBe("客户资料/上传备份.zip");
    expect(localize("下载 我的文件/未知错误.txt")).toBe(
      "Download 我的文件/未知错误.txt",
    );
    expect(localize("客户资料/未知错误.txt")).toBe("客户资料/未知错误.txt");
    expect(localize("本地定制版（自动更新已停用）")).toBe(
      "Customized build (automatic updates disabled)",
    );
  });
  test("clears dynamic feedback when vault is locked", () => {
    t("唯一的本地提示", "A unique local message");
    clearMessageTranslations();
    useLocaleStore.getState().setLocale("en");
    expect(localize("唯一的本地提示")).toBe("唯一的本地提示");
  });
  test("Chinese README links to a reciprocal English README", () => {
    const cn = readFileSync("README.md", "utf8");
    const en = readFileSync("README.en.md", "utf8");
    expect(cn.startsWith("# 云仓")).toBe(true);
    expect(cn).toContain("[English](README.en.md)");
    expect(en).toContain("[简体中文](README.md)");
  });
  test("brand rename preserves vault and keychain compatibility", () => {
    const config = JSON.parse(
      readFileSync("src-tauri/tauri.conf.json", "utf8"),
    );
    expect(config.productName).toBe("云仓");
    expect(config.identifier).toBe("dev.object0.app");
    expect(readFileSync("src-tauri/src/config_paths.rs", "utf8")).toContain(
      'path.push("object0")',
    );
    expect(readFileSync("src-tauri/src/lib.rs", "utf8")).toContain(
      'KEYCHAIN_SERVICE: &str = "com.object0.vault"',
    );
  });
});
