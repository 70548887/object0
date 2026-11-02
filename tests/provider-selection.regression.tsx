// Production ProfileForm routing/lifecycle harness. Fake hook slots only: no
// renderer, credentials, disk, IPC or cloud calls. This runs in its own process.
import { mock } from "bun:test";
import assert from "node:assert/strict";
import type { ReactElement } from "react";
import type { ProfileInfo } from "../src/shared/profile.types";

const react = await import("react");
const slots: unknown[] = [];
const effects = new Map<number, { deps?: unknown[]; cleanup?: () => void }>();
let cursor = 0;
let dirty = true;
let setups: Array<() => void> = [];
mock.module("react", () => ({
  ...react,
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
        effects.set(index, { deps, cleanup: setup() });
      });
    }
  },
}));
mock.module("../src/mainview/lib/i18n", () => ({
  t: (zh: string) => zh,
  localize: (v: string) => v,
  useT: () => (zh: string) => zh,
}));
const vault = {
  profiles: [],
  hasRecoveryKey: false,
  vaultVersion: 5,
  storageMode: "plaintext",
  refreshProfiles: async () => {},
};
const actualStores = await import("../src/mainview/stores");
mock.module("../src/mainview/stores", () => ({
  ...actualStores,
  useVaultStore: Object.assign(
    (selector: (state: typeof vault) => unknown) => selector(vault),
    { getState: () => vault },
  ),
  useProfileStore: {},
}));

const { ProfileForm, AdvancedProfileForm } = await import(
  "../src/mainview/components/profiles/ProfileForm"
);
const { ProviderChooser, ProviderChoices } = await import(
  "../src/mainview/components/profiles/ProviderChooser"
);
const { QiniuQuickConnect } = await import(
  "../src/mainview/components/profiles/QiniuQuickConnect"
);
const { PROVIDERS } = await import("../src/mainview/lib/constants");
const { PROVIDER_REGIONS, PROVIDER_ENDPOINTS } = await import(
  "../src/shared/profile.types"
);
type Node = ReactElement<Record<string, unknown>>;
let closeCalls = 0;
let props: Parameters<typeof ProfileForm>[0] = {
  open: true,
  onClose: () => closeCalls++,
};
function render(): Node | null {
  let result: Node | null = null;
  for (let i = 0; i < 10; i++) {
    dirty = false;
    cursor = 0;
    setups = [];
    result = ProfileForm(props) as Node | null;
    for (const setup of setups) setup();
    if (!dirty) return result;
  }
  throw new Error("ProfileForm hook state did not settle");
}
function requireNode(type: unknown): Node {
  const result = render();
  assert(result);
  assert.equal(result.type, type);
  return result;
}
function call(node: Node, name: string, ...args: unknown[]) {
  const fn = node.props[name];
  assert.equal(typeof fn, "function", `Missing ${name}`);
  (fn as (...args: unknown[]) => void)(...args);
}
function choose(provider: string): Node {
  const initial = requireNode(ProviderChooser);
  call(initial, "onSelect", provider);
  return requireNode(
    provider === "qiniu" ? QiniuQuickConnect : AdvancedProfileForm,
  );
}

// New account: no implicit Qiniu/default service, and all eight click handlers
// route to the service actually chosen (not merely to a generic AWS draft).
requireNode(ProviderChooser);
const draftKeys = new Set<string>();
for (const provider of PROVIDERS) {
  const node = choose(provider.value);
  if (provider.value !== "qiniu") {
    assert.equal(node.props.initialProvider, provider.value);
    assert(node.key, "Provider draft must have a remount key");
    assert(
      !draftKeys.has(node.key),
      "Different providers must not reuse draft state",
    );
    draftKeys.add(node.key);
  }
  call(node, "onChooseProvider");
  requireNode(ProviderChooser);
}

// Exercise the real provider-button callbacks as well as the route callback.
const selected: string[] = [];
cursor = 0;
const choices = ProviderChoices({ onSelect: (p) => selected.push(p) }) as Node;
function walk(value: unknown): Node[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(walk);
  const node = value as Node;
  return [node, ...walk(node.props?.children)];
}
const buttons = walk(choices).filter(
  (n) => typeof n.props?.onClick === "function",
);
assert.equal(buttons.length, 8);
for (const button of buttons) call(button, "onClick");
assert.deepEqual(
  selected,
  PROVIDERS.map((p) => p.value),
);

// Qiniu's advanced path must preserve Qiniu rather than silently default to AWS.
let node = choose("qiniu");
call(node, "onAdvanced");
node = requireNode(AdvancedProfileForm);
assert.equal(node.props.initialProvider, "qiniu");
call(node, "onChooseProvider");
requireNode(ProviderChooser);

// Changing the provider in a detailed form uses the same parent router, so
// switching to Qiniu gets its quick form rather than retaining an S3 draft.
node = choose("r2");
call(node, "onProviderChange", "qiniu");
node = requireNode(QiniuQuickConnect);
call(node, "onChooseProvider");
requireNode(ProviderChooser);

// Close resets the route immediately, even before the parent updates `open`.
node = choose("r2");
call(node, "onClose");
assert.equal(closeCalls, 1);
requireNode(ProviderChooser);
choose("minio");
props = { ...props, open: false };
render();
props = { ...props, open: true };
requireNode(ProviderChooser);

// Editing remains an edit form, never a fresh connection or selection dialog.
const edit: ProfileInfo = {
  id: "fixture-profile",
  name: "Fixture",
  provider: "r2",
  createdAt: "fixture-time",
  updatedAt: "fixture-revision",
  hasR2AnalyticsToken: false,
};
props = { ...props, editProfile: edit };
node = requireNode(AdvancedProfileForm);
assert.equal(node.props.editProfile, edit);
assert.equal(node.props.onChooseProvider, undefined);
props = { ...props, editProfile: undefined, open: false };
render();
props = { ...props, open: true };
requireNode(ProviderChooser);

// Inspect the production form's actual initialized field values, not just the
// wrapper props: R2 must start with auto, never AWS's us-east-1.
for (const provider of PROVIDERS.filter((p) => p.value !== "qiniu")) {
  for (const previous of effects.values()) previous.cleanup?.();
  slots.length = 0;
  effects.clear();
  cursor = 0;
  setups = [];
  const form = AdvancedProfileForm({
    open: true,
    initialProvider: provider.value,
    onClose: () => {},
  }) as Node;
  const nodes = walk(form);
  const region = nodes.find((n) => n.props?.id === "pf-region");
  assert(region, `Region input missing for ${provider.value}`);
  assert.equal(region.props.value, PROVIDER_REGIONS[provider.value]);
  const endpoint = nodes.find((n) => n.props?.id === "pf-endpoint");
  if (endpoint)
    assert.equal(
      endpoint.props.value,
      PROVIDER_ENDPOINTS[provider.value] ?? "",
    );
}

console.log(
  "PROVIDER_SELECTION_PASS: no default service; all eight choices route correctly; provider drafts remount with correct region/endpoint; Qiniu advanced preserves provider; back/close/reopen reset route; editing retained; fixture hooks only",
);
