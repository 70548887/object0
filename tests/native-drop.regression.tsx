import { fileURLToPath } from "node:url";
import { runNativeDropFixture } from "./native-drop.fixture";

await runNativeDropFixture(fileURLToPath(new URL("../", import.meta.url)));
