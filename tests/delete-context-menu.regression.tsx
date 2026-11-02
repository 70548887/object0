// Isolated context-menu handler test with mocked UI/store/native surfaces.
// This is not a browser test and performs no cloud requests.
import { mock } from "bun:test";
import { strict as assert } from "node:assert";
import type { ReactElement, ReactNode } from "react";

mock.module("@base-ui/react/context-menu", () => ({
  ContextMenu: { Trigger: "div" },
}));
mock.module("../src/mainview/components/ui/context-menu", () =>
  Object.fromEntries(
    [
      "ContextMenu",
      "ContextMenuContent",
      "ContextMenuItem",
      "ContextMenuSeparator",
    ].map((name) => [name, name]),
  ),
);
mock.module("../src/mainview/lib/i18n", () => ({
  t: (zh: string) => zh,
  localize: (value: string) => value,
  useT: () => {},
}));
mock.module("../src/mainview/lib/icons", () =>
  Object.fromEntries(
    [
      "IconArrowRightArrowLeft",
      "IconCircleInfo",
      "IconClipboard",
      "IconCloudArrowDown",
      "IconCopy",
      "IconPen",
      "IconShareNodes",
      "IconTrashCan",
    ].map((name) => [name, () => null]),
  ),
);
const profileA = { id: "account-a", provider: "r2", updatedAt: "revision-a" };
const profileB = { id: "account-b", provider: "r2", updatedAt: "revision-b" };
let active = { activeProfileId: profileA.id, activeProfile: profileA };
let selectedBucket = "bucket-a";
const reloads: unknown[][] = [];
const asStore = <S,>(get: () => S) =>
  Object.assign((selector: (state: S) => unknown) => selector(get()), {
    getState: get,
  });
mock.module("../src/mainview/stores", () => ({
  useProfileStore: asStore(() => active),
  useVaultStore: asStore(() => ({ profiles: [profileA, profileB] })),
  useBucketStore: asStore(() => ({ selectedBucket })),
  useObjectStore: asStore(() => ({
    currentPrefix: "folder/",
    loadObjects: (...args: unknown[]) => reloads.push(args),
  })),
  useUIStore: asStore(() => ({
    openShareDialog: () => {},
    setDetailKey: () => {},
    openTransferDialog: () => {},
  })),
}));
const requests: unknown[] = [];
const responses: Array<(value: unknown) => void> = [];
mock.module("../src/mainview/lib/rpc-client", () => ({
  rpcCall: (method: string, payload: unknown) => {
    assert.equal(method, "objects:delete");
    requests.push(payload);
    return new Promise<unknown>((resolve) => responses.push(resolve));
  },
}));
const messages: Array<{ kind: string; title: string }> = [];
mock.module("../src/mainview/components/common/Toast", () => ({
  toast: Object.fromEntries(
    ["success", "error", "warning", "info"].map((kind) => [
      kind,
      (title: string) => messages.push({ kind, title }),
    ]),
  ),
}));

const { ObjectContextMenu } = await import(
  "../src/mainview/components/objects/ObjectContextMenu"
);
type Node = ReactElement<{
  children?: ReactNode;
  onClick?: () => void;
  variant?: string;
}>;
function deleteHandler(value: ReactNode): () => void {
  if (Array.isArray(value)) {
    for (const child of value) {
      try {
        return deleteHandler(child);
      } catch {}
    }
  } else if (value && typeof value === "object" && "props" in value) {
    const node = value as Node;
    if (node.props.variant === "destructive" && node.props.onClick)
      return node.props.onClick;
    return deleteHandler(node.props.children);
  }
  throw new Error("Delete menu handler missing");
}
const click = () => {
  const menu = ObjectContextMenu({
    objectKey: "folder/file.txt",
    isFolder: false,
    onRename: () => {},
  });
  deleteHandler(menu)();
};
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
click();
assert.deepEqual(requests[0], {
  profileId: "account-a",
  bucket: "bucket-a",
  keys: ["folder/file.txt"],
  expectedProfileRevision: "revision-a",
});
responses[0]({
  results: [{ key: "folder/file.txt", success: false, error: "Access denied" }],
});
await flush();
assert.equal(messages.at(-1)?.kind, "error");
assert.match(messages.at(-1)?.title ?? "", /成功 0.*失败 1/);
assert.equal(reloads.length, 1);
click();
active = { activeProfileId: profileB.id, activeProfile: profileB };
selectedBucket = "bucket-b";
responses[1]({ results: [{ key: "folder/file.txt", success: true }] });
await flush();
assert.equal(messages.at(-1)?.kind, "success");
assert.equal(
  reloads.length,
  1,
  "late success must not load the old bucket into the new account view",
);
active = { activeProfileId: profileA.id, activeProfile: profileA };
selectedBucket = "bucket-a";
click();
responses[2]({ results: [] });
await flush();
assert.equal(messages.at(-1)?.kind, "error");
assert.match(messages.at(-1)?.title ?? "", /成功 0.*失败 1/);
console.log(
  "PASS: context-menu deletes read per-item outcomes, bind account revision, and ignore late refreshes after navigation",
);
