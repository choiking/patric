import type { PatricConfig } from "../config/config.js";
import { startTui } from "./tui.js";

export async function startRepl(config: PatricConfig): Promise<void> {
  await startTui(config);
}
