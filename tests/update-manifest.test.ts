import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildManifest } from "../scripts/updater/build-github-update-manifest.mjs";

test("update manifest binds both package kinds to exact own-repo version URLs and byte hashes", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "yuncang-manifest-test-"));
  try {
    for (const suffix of ["setup.exe", "portable.zip"]) {
      const file = path.join(
        dir,
        `object0_2.0.0-preview.1_windows_x64_${suffix}`,
      );
      writeFileSync(file, "fixture payload");
      writeFileSync(`${file}.sig`, "fixture-signature-not-a-real-signature");
    }
    const manifest = buildManifest(
      dir,
      "2.0.0-preview.1",
      "fixture notes",
      "2026-11-02T00:00:00Z",
    );
    expect(manifest.channel).toBe("preview");
    const packages = manifest.packages["windows-x86_64"];
    expect(packages.installer.size).toBe(15);
    expect(packages.portable.size).toBe(15);
    expect(packages.installer.sha256).toHaveLength(64);
    expect(packages.portable.url).toBe(
      "https://github.com/70548887/object0/releases/download/v2.0.0-preview.1/object0_2.0.0-preview.1_windows_x64_portable.zip",
    );
    expect(manifest.platforms["windows-x86_64"].url).toBe(
      packages.installer.url,
    );
    expect(() => buildManifest(dir, "../../wrong")).toThrow();
    expect(() => buildManifest(dir, "1.0.0")).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("release signing requires real verification by the exact compiled validator", () => {
  const script = readFileSync(
    "scripts/release/sign-github-updates.ps1",
    "utf8",
  );
  expect(script).toContain("--yuncang-verify-update-file");
  expect(script).toContain("$check.ExitCode -ne 0");
  expect(script).toContain("-WindowStyle Hidden");
  expect(script).not.toContain("Write-Output $env:TAURI_SIGNING_PRIVATE_KEY");
});
