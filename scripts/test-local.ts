// All frontend tests use fixtures/mocks; regression scripts run in separate
// processes so one module mock cannot contaminate another suite.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
function run(args: string[]) {
  const result = Bun.spawnSync([process.execPath, ...args], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  if (result.exitCode !== 0) process.exit(result.exitCode || 1);
}
run(["test", "tests"]);
for (const name of readdirSync(new URL("../tests/", import.meta.url))
  .filter((name) => /\.regression\.tsx?$/.test(name))
  .sort()) {
  console.log(`\nIsolated regression: ${name}`);
  run([`tests/${name}`]);
}
