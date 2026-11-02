// Isolated production ShareDialog lifecycle/handler harness. Fake hook slots,
// stores, clipboard and RPC only; not a browser or real-service acceptance test.
import { mock } from "bun:test";
import { strict as assert } from "node:assert";
import type { ReactElement, ReactNode } from "react";

const actualReact = await import("react");
const slots: unknown[] = [];
const effects = new Map<number, { deps?: unknown[]; cleanup?: () => void }>();
let cursor = 0;
let dirty = true;
let setups: Array<() => void> = [];
mock.module("react", () => ({
  ...actualReact,
  useState: (initial: unknown) => {
    const index = cursor++;
    if (!(index in slots))
      slots[index] = typeof initial === "function" ? initial() : initial;
    return [
      slots[index],
      (next: unknown) => {
        const value = typeof next === "function" ? next(slots[index]) : next;
        if (!Object.is(value, slots[index])) {
          slots[index] = value;
          dirty = true;
        }
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = { current: initial };
    return slots[index];
  },
  useEffect: (setup: () => (() => void) | undefined, deps?: unknown[]) => {
    const index = cursor++;
    const previous = effects.get(index);
    if (
      !previous ||
      !deps ||
      deps.some((value, item) => !Object.is(value, previous.deps?.[item]))
    ) {
      effects.set(index, { deps });
      setups.push(() => {
        previous?.cleanup?.();
        const cleanup = setup();
        effects.set(index, { deps, cleanup });
      });
    }
  },
}));
mock.module("../src/mainview/lib/i18n", () => ({
  t: (zh: string) => zh,
  localize: (value: string) => value,
  useT: () => (zh: string) => zh,
}));
mock.module("@base-ui/react/select", () => ({
  Select: { Item: "option", ItemText: "span", ItemIndicator: "span" },
}));
mock.module("qrcode.react", () => ({ QRCodeSVG: "svg" }));
for (const [path, names] of [
  [
    "../src/mainview/components/ui/dialog",
    [
      "Dialog",
      "DialogContent",
      "DialogDescription",
      "DialogFooter",
      "DialogHeader",
      "DialogTitle",
    ],
  ],
  [
    "../src/mainview/components/ui/select",
    ["Select", "SelectContent", "SelectTrigger", "SelectValue"],
  ],
  ["../src/mainview/components/ui/button", ["Button"]],
  ["../src/mainview/components/ui/input", ["Input"]],
] as const)
  mock.module(path, () =>
    Object.fromEntries(names.map((name) => [name, name])),
  );
mock.module("../src/mainview/lib/icons", () =>
  Object.fromEntries(
    [
      "IconFile",
      "IconLink",
      "IconSpinner",
      "IconXmark",
      "IconCheck",
      "IconCircleInfo",
      "IconChevronDown",
      "IconClock",
      "IconCopy",
      "IconQrcode",
    ].map((name) => [name, () => null]),
  ),
);
const native = {
  id: "p",
  provider: "qiniu",
  updatedAt: "rev1",
  hasSessionToken: false,
  qiniu: { mode: "public", bucketBindings: [] as unknown[] },
};
let profile = native;
let open = true;
let target = {
  profileId: "p",
  bucket: "fixture-bucket",
  key: "folder/file.txt",
};
let panels = 0;
const history: unknown[] = [];
const ui = () => ({
  shareDialogOpen: open,
  shareTarget: target,
  closeShareDialog: () => {
    open = false;
    dirty = true;
  },
  setJobPanelOpen: () => panels++,
});
const asStore = <S,>(get: () => S) =>
  Object.assign((selector: (state: S) => unknown) => selector(get()), {
    getState: get,
  });
mock.module("../src/mainview/stores", () => ({
  useUIStore: asStore(ui),
  useVaultStore: asStore(() => ({ profiles: [profile] })),
  useShareHistoryStore: asStore(() => ({
    addEntry: (entry: unknown) => history.push(entry),
  })),
}));
const messages: string[] = [];
mock.module("../src/mainview/components/common/Toast", () => ({
  toast: {
    info: (value: string) => messages.push(value),
    success: (value: string) => messages.push(value),
  },
}));
type Call = {
  method: string;
  payload: Record<string, unknown>;
  resolve: (value: unknown) => void;
};
const calls: Call[] = [];
mock.module("../src/mainview/lib/rpc-client", () => ({
  rpcCall: (method: string, payload: Record<string, unknown>) =>
    new Promise<unknown>((resolve) => calls.push({ method, payload, resolve })),
}));
const navigatorBefore = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator",
);
const copied: string[] = [];
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    clipboard: {
      writeText: async (value: string) => {
        copied.push(value);
      },
    },
  },
});
type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const { ShareDialog } = await import(
  "../src/mainview/components/share/ShareDialog"
);
let tree: ReactNode;
function render() {
  let limit = 0;
  do {
    dirty = false;
    cursor = 0;
    setups = [];
    tree = ShareDialog();
    const work = setups;
    setups = [];
    for (const setup of work) setup();
    assert.ok(++limit < 30, "hook state did not settle");
  } while (dirty);
}
const settle = async () => {
  for (let count = 0; count < 8; count++) {
    await Promise.resolve();
    if (dirty) render();
  }
};
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap((child) => nodes(child));
  if (value && typeof value === "object" && "props" in value) {
    const node = value as Node;
    return [node, ...nodes(node.props.children)];
  }
  return [];
}
const text = (value: ReactNode): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map(text).join("")
      : value && typeof value === "object" && "props" in value
        ? text((value as Node).props.children)
        : "";
const button = (label: string) => {
  const found = nodes(tree).find(
    (node) => node.type === "Button" && text(node.props.children) === label,
  );
  assert.ok(found, label);
  return found;
};
const component = (name: string) => {
  const found = nodes(tree).find(
    (node) => typeof node.type === "function" && node.type.name === name,
  );
  assert.ok(found, name);
  return found;
};
const invoke = (node: Node, prop: string, ...args: unknown[]) =>
  (node.props[prop] as (...values: unknown[]) => unknown)(...args);
const options = {
  domains: [
    { url: "https://origin-a.example", kind: "origin", available: true },
    { url: "https://origin-b.example", kind: "origin", available: true },
    {
      url: "https://cdn.example",
      kind: "cdn",
      available: false,
      reason: "Unverified",
    },
  ],
  maxShareSeconds: 2592000,
  policyNote: "应用策略 / Application policy",
};
try {
  render();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "qiniu:download-options");
  assert.equal(button("生成链接").props.disabled, true);
  calls[0].resolve(options);
  await settle();
  assert.equal(
    component("QiniuShareDomains").props.selectedDomain,
    "https://origin-a.example",
  );
  assert.equal(
    button("生成链接").props.disabled,
    false,
    "discovery must select the first usable domain but not generate a link",
  );
  assert.equal(calls.length, 1, "default selection must not sign or download");
  assert.equal(copied.length, 0);
  assert.equal(history.length, 0);
  invoke(component("QiniuShareDomains"), "onSelect", "https://cdn.example");
  render();
  assert.equal(
    component("QiniuShareDomains").props.selectedDomain,
    "https://origin-a.example",
  );
  invoke(
    component("QiniuShareDomains"),
    "onSelect",
    "https://origin-b.example",
  );
  render();
  render();
  assert.equal(
    component("QiniuShareDomains").props.selectedDomain,
    "https://origin-b.example",
    "ordinary rerenders must preserve manual choices",
  );
  invoke(component("QiniuShareDomains"), "onSelect", "");
  render();
  render();
  assert.equal(component("QiniuShareDomains").props.selectedDomain, "");
  assert.equal(button("生成链接").props.disabled, true);
  invoke(component("QiniuShareDomains"), "onReload");
  render();
  const reload = calls.at(-1);
  assert.ok(reload);
  assert.equal(reload.method, "qiniu:download-options");
  reload.resolve({
    ...options,
    selectedDomain: "https://origin-b.example",
    domains: [
      { url: "https://disabled.example", kind: "origin", available: false },
      ...options.domains,
    ],
  });
  await settle();
  assert.equal(
    component("QiniuShareDomains").props.selectedDomain,
    "https://origin-a.example",
    "reload chooses the first usable list entry, not the configured later entry",
  );
  invoke(
    component("QiniuShareDomains"),
    "onSelect",
    "https://origin-a.example",
  );
  render();
  assert.equal(component("ShareExpirationFields").props.maxSeconds, 2592000);
  assert.equal(component("ShareExpirationFields").props.applicationLimit, true);
  assert.equal(button("生成链接").props.disabled, false);
  invoke(button("生成链接"), "onClick");
  render();
  const oldShare = calls.at(-1);
  assert.ok(oldShare);
  assert.equal(oldShare.method, "share:generate");
  assert.equal(oldShare.payload.expiresIn, 3600);
  assert.equal(oldShare.payload.downloadDomain, "https://origin-a.example");
  assert.equal(oldShare.payload.expectedProfileRevision, "rev1");
  invoke(
    component("QiniuShareDomains"),
    "onSelect",
    "https://origin-b.example",
  );
  render();
  oldShare.resolve({
    key: target.key,
    url: `https://origin-a.example/${target.key}?e=1893456000&token=fixture`,
    expiresAt: "2030-01-01T00:00:00Z",
  });
  await settle();
  assert.equal(copied.length, 0);
  assert.equal(
    history.length,
    0,
    "late domain response must not enter persistent share history",
  );
  invoke(component("ShareExpirationFields"), "onModeChange", "custom");
  invoke(component("ShareExpirationFields"), "onCustomValueChange", "8");
  invoke(component("ShareExpirationFields"), "onCustomUnitChange", "days");
  render();
  assert.equal(button("生成链接").props.disabled, false);
  invoke(button("生成链接"), "onClick");
  render();
  const goodShare = calls.at(-1);
  assert.ok(goodShare);
  assert.equal(goodShare.payload.expiresIn, 691200);
  assert.equal(goodShare.payload.downloadDomain, "https://origin-b.example");
  goodShare.resolve({
    key: target.key,
    url: `https://origin-b.example/${target.key}?e=1893456000&token=fixture`,
    expiresAt: "2030-01-01T00:00:00Z",
  });
  await settle();
  assert.equal(copied.length, 1);
  assert.equal(history.length, 1);
  assert.ok(component("ShareResult"));
  invoke(button("使用所选域名下载"), "onClick");
  render();
  const download = calls.at(-1);
  assert.ok(download);
  assert.equal(download.method, "transfer:download");
  assert.equal(download.payload.localPath, "~/Downloads/file.txt");
  assert.equal(download.payload.downloadDomain, "https://origin-b.example");
  assert.equal(download.payload.expectedProfileRevision, "rev1");
  profile = { ...native, updatedAt: "rev2" };
  target = { ...target, key: "folder/new.txt" };
  dirty = true;
  render();
  const revisionOptions = calls.at(-1);
  assert.ok(revisionOptions);
  assert.equal(revisionOptions.method, "qiniu:download-options");
  download.resolve({ jobId: "fixture-job" });
  await settle();
  assert.equal(
    panels,
    0,
    "late job response must not open a panel for a replacement account revision",
  );
  const optionCalls = calls.filter(
    (call) => call.method === "qiniu:download-options",
  ).length;
  profile = {
    ...native,
    updatedAt: "rev3",
    qiniu: { ...native.qiniu, bucketBindings: [{}] },
  };
  dirty = true;
  render();
  assert.equal(
    calls.filter((call) => call.method === "qiniu:download-options").length,
    optionCalls,
    "explicit S3 binding must not use native domain discovery",
  );
  revisionOptions.resolve({
    ...options,
    selectedDomain: "https://origin-a.example",
  });
  await settle();
  assert.equal(
    nodes(tree).some(
      (node) =>
        typeof node.type === "function" &&
        node.type.name === "QiniuShareDomains",
    ),
    false,
  );
  assert.equal(component("ShareExpirationFields").props.maxSeconds, 604800);
  invoke(component("ShareExpirationFields"), "onModeChange", "custom");
  invoke(component("ShareExpirationFields"), "onCustomValueChange", "8");
  invoke(component("ShareExpirationFields"), "onCustomUnitChange", "days");
  render();
  assert.equal(
    button("生成链接").props.disabled,
    true,
    "S3 remains limited to seven days",
  );
  profile = { ...native, updatedAt: "rev4" };
  dirty = true;
  render();
  const closingOptions = calls.at(-1);
  assert.ok(closingOptions);
  const close = nodes(tree).find(
    (node) => node.props["aria-label"] === "关闭分享弹窗",
  );
  assert.ok(close);
  invoke(close, "onClick");
  render();
  closingOptions.resolve({
    ...options,
    selectedDomain: "https://origin-a.example",
  });
  await settle();
  assert.equal(copied.length, 1);
  assert.equal(history.length, 1);
  // Reopening selects the first usable HTTP domain as requested, retains its
  // transport warning and never invents an enforceable public expiry.
  profile = { ...native, updatedAt: "rev5" };
  open = true;
  dirty = true;
  render();
  const publicOptions = calls.at(-1);
  assert.ok(publicOptions);
  assert.equal(publicOptions.method, "qiniu:download-options");
  publicOptions.resolve({
    ...options,
    selectedDomain: "http://public.example",
    domains: [
      {
        url: "http://public.example",
        kind: "test",
        available: true,
        accessMode: "public",
      },
    ],
  });
  await settle();
  assert.equal(
    component("QiniuShareDomains").props.selectedDomain,
    "http://public.example",
  );
  assert.equal(
    calls.at(-1),
    publicOptions,
    "HTTP default must not generate or download",
  );
  assert(
    !nodes(tree).some(
      (node) =>
        typeof node.type === "function" &&
        node.type.name === "ShareExpirationFields",
    ),
    "public links must not offer a fictitious enforceable expiration",
  );
  assert.equal(button("生成链接").props.disabled, false);
  invoke(button("生成链接"), "onClick");
  render();
  const publicShare = calls.at(-1);
  assert.ok(publicShare);
  assert.equal(publicShare.method, "share:generate");
  assert.equal(publicShare.payload.expiresIn, 3600);
  assert.equal(publicShare.payload.downloadDomain, "http://public.example");
  assert.equal(publicShare.payload.expectedProfileRevision, "rev5");
  publicShare.resolve({
    key: target.key,
    url: `http://public.example/${target.key}?token=fixture`,
    expiresAt: null,
    accessMode: "public",
  });
  await settle();
  assert.equal(
    copied.length,
    1,
    "malformed public response must not copy a link",
  );
  assert.equal(
    history.length,
    1,
    "malformed public response must not enter history",
  );
  assert.equal(button("生成链接").props.disabled, false);
  invoke(button("生成链接"), "onClick");
  render();
  const verifiedPublicShare = calls.at(-1);
  assert.ok(verifiedPublicShare);
  assert.notEqual(verifiedPublicShare, publicShare);
  verifiedPublicShare.resolve({
    key: target.key,
    url: `http://public.example/${target.key}`,
    expiresAt: null,
    accessMode: "public",
  });
  await settle();
  assert.equal(component("ShareResult").props.accessMode, "public");
  assert.equal(copied.at(-1), `http://public.example/${target.key}`);
  assert.equal(history.length, 2);
  assert.equal((history.at(-1) as { accessMode: string }).accessMode, "public");
  assert.equal((history.at(-1) as { expiresAt: null }).expiresAt, null);
  console.log(
    "PASS: first usable domain auto-default including HTTP, manual and cleared selection preserved, reload ordering, no implicit RPC generation, native payloads and TTL, S3 limits, stale account/domain/close lifecycle, public links without fake expiry; no real RPC",
  );
} finally {
  for (const effect of effects.values()) effect.cleanup?.();
  if (navigatorBefore)
    Object.defineProperty(globalThis, "navigator", navigatorBefore);
  else Reflect.deleteProperty(globalThis, "navigator");
}
