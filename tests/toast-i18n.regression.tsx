// Independent process: bun tests/toast-i18n.regression.tsx. No cloud calls.
import { strict as assert } from "node:assert";
import { renderToStaticMarkup } from "react-dom/server";
import { type Action, toast as rawToast } from "sonner";
import { toast } from "../src/mainview/components/common/Toast";
import { t } from "../src/mainview/lib/i18n";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";

const callback = () => {};
useLocaleStore.getState().setLocale("zh-CN");
const id = toast.info(t("测试通知", "Test notification"), {
  description: t("等待操作", "Awaiting action"),
  action: { label: t("撤销", "Undo"), onClick: callback },
  cancel: { label: t("取消", "Cancel"), onClick: callback },
});
const item = rawToast.getHistory().find((entry) => entry.id === id);
assert.ok(item);
for (const [locale, expected] of [
  ["en", ["Test notification", "Awaiting action", "Undo", "Cancel"]],
  ["zh-CN", ["测试通知", "等待操作", "撤销", "取消"]],
] as const) {
  useLocaleStore.getState().setLocale(locale);
  const values = [
    item.title,
    item.description,
    (item.action as Action).label,
    (item.cancel as Action).label,
  ];
  assert.deepEqual(
    values.map((value) =>
      renderToStaticMarkup(typeof value === "function" ? value() : value),
    ),
    [...expected],
  );
}
assert.equal((item.action as Action).onClick, callback);
console.log(
  "PASS: toast title, description, action and cancel switch both ways; callback preserved; no cloud calls",
);
