import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  canRotateRecoveryKey,
  RecoveryRotationNotice,
} from "../src/mainview/components/vault/RotateRecoveryKeyDialog";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";

afterEach(() => useLocaleStore.getState().setLocale("zh-CN"));
const ready = {
  unlocked: true,
  needsPassphraseChange: false,
  busy: false,
  pendingKey: false,
  passphrase: "synthetic-current-passphrase",
  acknowledged: true,
};
test("rotation requires explicit acknowledgement and manually entered current passphrase", () => {
  expect(canRotateRecoveryKey(ready)).toBe(true);
  for (const patch of [
    { unlocked: false },
    { needsPassphraseChange: true },
    { busy: true },
    { pendingKey: true },
    { passphrase: "" },
    { passphrase: "x".repeat(4097) },
    { acknowledged: false },
  ])
    expect(canRotateRecoveryKey({ ...ready, ...patch })).toBe(false);
});
test("rotation notice explains old-key invalidation and primary-account preservation in both languages", () => {
  const cn = renderToStaticMarkup(<RecoveryRotationNotice />);
  expect(cn).toContain("旧恢复密钥在当前密码库上失效");
  expect(cn).toContain("旧恢复密钥仍可解锁对应旧备份");
  expect(cn).toContain("不是七牛 SecretKey");
  expect(cn).toContain("加密备份");
  expect(cn).toContain("账号、文件和当前解锁密码不会因此删除或更改");
  useLocaleStore.getState().setLocale("en");
  const en = renderToStaticMarkup(<RecoveryRotationNotice />);
  expect(en).toContain("invalidates the old recovery key");
  expect(en).toContain("old recovery key can still unlock that backup");
  expect(en).toContain("not a Qiniu SecretKey");
  expect(en).toContain("encrypted backup");
});
test("rotation UI stays manual, avoids password persistence and reuses the non-dismissable save-key display", () => {
  const dialog = readFileSync(
    "src/mainview/components/vault/RotateRecoveryKeyDialog.tsx",
    "utf8",
  );
  const settings = readFileSync(
    "src/mainview/components/settings/SettingsPanel.tsx",
    "utf8",
  );
  const app = readFileSync("src/mainview/app/App.tsx", "utf8");
  const display = readFileSync(
    "src/mainview/components/vault/RecoveryKeyDisplay.tsx",
    "utf8",
  );
  expect(dialog).toContain('type="password"');
  expect(dialog).toContain("if (busy || pending.current) return");
  expect(dialog).not.toMatch(/localStorage|sessionStorage|console\./);
  expect(settings).not.toContain("setRotationOpen(true)");
  expect(settings).toContain("导入旧加密库账号");
  expect(app).toContain("pendingRecoveryKey && unlocked");
  expect(app).toContain("key={pendingRecoveryKey}");
  expect(display).toContain("showCloseButton={false}");
  expect(display).toContain("disabled={!confirmed}");
});
