import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { PlaintextModeNotice } from "../src/mainview/components/vault/PlaintextModeDialog";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";

afterEach(() => useLocaleStore.getState().setLocale("zh-CN"));

test("plaintext confirmation explicitly states readable AK/SK and preserved encrypted vault in both languages", () => {
  const cn = renderToStaticMarkup(<PlaintextModeNotice />);
  expect(cn).toContain("明文保存在本机文件");
  expect(cn).toContain("能读取该文件的程序或用户都能看到账号密钥");
  expect(cn).toContain("原样保留");
  expect(cn).toContain("不提供密码、恢复密钥或 Windows 凭据加密保护");
  expect(cn).toContain("一次只运行一个版本");
  useLocaleStore.getState().setLocale("en");
  const en = renderToStaticMarkup(<PlaintextModeNotice />);
  expect(en).toContain("plaintext in a local file");
  expect(en).toContain("preserved unchanged");
  expect(en).toContain(
    "no passphrase, recovery-key or Windows credential encryption protection",
  );
});

test("default plaintext UI opens local accounts without normal password onboarding", () => {
  const dialog = readFileSync(
    "src/mainview/components/vault/PlaintextModeDialog.tsx",
    "utf8",
  );
  const setup = readFileSync(
    "src/mainview/components/vault/SetupScreen.tsx",
    "utf8",
  );
  const settings = readFileSync(
    "src/mainview/components/settings/SettingsPanel.tsx",
    "utf8",
  );
  const sidebar = readFileSync(
    "src/mainview/components/layout/Sidebar.tsx",
    "utf8",
  );
  const palette = readFileSync(
    "src/mainview/components/common/CommandPalette.tsx",
    "utf8",
  );
  expect(dialog).toContain("if (!confirmed || busy || pending.current) return");
  expect(dialog).not.toMatch(/localStorage|sessionStorage|console\./);
  expect(setup).toContain("使用本地明文模式（无密码）");
  expect(settings).toContain("明文保存在本机");
  expect(settings).not.toContain("useKeychainStatus");
  expect(settings).toContain("导入旧加密库账号");
  expect(sidebar).toContain("!plaintext &&");
  expect(palette).toContain("!plaintext");
});
