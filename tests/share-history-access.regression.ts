// Isolated real history-store behavior; fixture browser storage only.
import assert from "node:assert/strict";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
  },
});
const { useShareHistoryStore } = await import(
  "../src/mainview/stores/useShareHistoryStore"
);
const { useUIStore } = await import("../src/mainview/stores/useUIStore");
const { shareLinkState } = await import(
  "../src/mainview/components/share/share-expiration"
);
const createdAt = new Date().toISOString();
const past = new Date(Date.now() - 3600_000).toISOString();
const future = new Date(Date.now() + 3600_000).toISOString();
const common = {
  profileId: "fixture-profile",
  bucket: "fixture-bucket",
  key: "folder/file.txt",
  url: "https://fixture.example/folder/file.txt",
  createdAt,
};
useShareHistoryStore.setState({
  entries: [
    { ...common, id: "public", accessMode: "public", expiresAt: null },
    {
      ...common,
      id: "public-old-timestamp",
      accessMode: "public",
      expiresAt: past,
    },
    { ...common, id: "active-signed", accessMode: "signed", expiresAt: future },
    { ...common, id: "expired-signed", accessMode: "signed", expiresAt: past },
    { ...common, id: "active-legacy", expiresAt: future },
    { ...common, id: "expired-legacy", expiresAt: past },
    { ...common, id: "unknown-null", expiresAt: null },
  ],
});
useShareHistoryStore.getState().clearExpired();
assert.deepEqual(
  useShareHistoryStore.getState().entries.map((entry) => entry.id),
  [
    "public",
    "public-old-timestamp",
    "active-signed",
    "active-legacy",
    "unknown-null",
  ],
);
assert.equal(
  shareLinkState(useShareHistoryStore.getState().entries[0]),
  "public",
);
const unknown = useShareHistoryStore.getState().entries.at(-1);
assert(unknown);
assert.equal(shareLinkState(unknown), "unknown");
useUIStore.setState({ persistShareHistory: true });
useShareHistoryStore
  .getState()
  .addEntry({ ...common, accessMode: "public", expiresAt: null });
const saved = useShareHistoryStore.getState().entries[0];
assert.equal(saved.accessMode, "public");
assert.equal(saved.expiresAt, null);
useShareHistoryStore.getState().clearExpired();
assert(
  useShareHistoryStore
    .getState()
    .entries.some((entry) => entry.id === saved.id),
);
assert(![...memory.values()].some((value) => value.includes("fixture-secret")));
console.log(
  "SHARE_HISTORY_ACCESS_PASS: public links survive cleanup without a fake expiry; signed/legacy expiry remains compatible; null alone is unknown; browser-storage fixtures only",
);
