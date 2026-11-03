// Fixed repository, explicit two-package identity. Sign and cryptographically
// verify this output before publication; a nonempty .sig is not verification.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
export function buildManifest(
  directory,
  version,
  notes = "",
  date = new Date().toISOString(),
) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error("Invalid release version");
  const packages = {};
  for (const [kind, suffix] of [
    ["installer", "setup.exe"],
    ["portable", "portable.zip"],
  ]) {
    const name = `object0_${version}_windows_x64_${suffix}`;
    const file = path.join(directory, name);
    const signature = readFileSync(`${file}.sig`, "utf8").trim();
    if (!signature || signature.length > 16384)
      throw new Error("Missing or invalid signature text");
    const size = statSync(file).size;
    if (size <= 0 || size > 2 * 1024 ** 3)
      throw new Error("Invalid package size");
    packages[kind] = {
      url: `https://github.com/70548887/object0/releases/download/v${version}/${name}`,
      size,
      sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
      signature,
    };
  }
  return {
    schemaVersion: 1,
    version,
    channel: version.includes("-") ? "preview" : "stable",
    notes,
    pub_date: date,
    packages: { "windows-x86_64": packages },
    platforms: {
      "windows-x86_64": {
        url: packages.installer.url,
        signature: packages.installer.signature,
      },
    },
  };
}
if (import.meta.main) {
  const [directory, version, notesFile] = process.argv.slice(2);
  if (!directory || !version)
    throw new Error(
      "Usage: bun build-github-update-manifest.mjs ASSET_DIR VERSION [NOTES_FILE]",
    );
  const output = path.join(directory, "yuncang-update.json");
  if (existsSync(output))
    throw new Error("Refusing to overwrite an existing manifest");
  writeFileSync(
    output,
    `${JSON.stringify(buildManifest(directory, version, notesFile ? readFileSync(notesFile, "utf8") : ""), null, 2)}\n`,
    { flag: "wx" },
  );
  console.log(
    `Generated unsigned manifest awaiting release signing: ${output}`,
  );
}
