// Same HTTP-origin fixture against a supplied baseline/candidate/rollback root.
// No account file, secret, IPC or network access is required.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
if (!root) throw new Error("Usage: bun share-http.probe.ts SOURCE_ROOT");
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem() {}, removeItem() {} },
});
const { validatedDownloadOptions } = await import(
  pathToFileURL(
    resolve(root, "src/mainview/components/share/qiniu-share-options.ts"),
  ).href
);
const value = validatedDownloadOptions({
  domains: [
    {
      url: "http://origin.example",
      kind: "origin",
      available: true,
      accessMode: "signed",
    },
  ],
  maxShareSeconds: 2592000,
  policyNote: "Fixture only",
});
console.log(`HTTP_DOMAIN_AVAILABLE=${value.domains[0].available}`);
console.log(`AUTOMATIC_DOMAIN_SELECTED=${Boolean(value.selectedDomain)}`);
