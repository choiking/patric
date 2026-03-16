import type { PatricConfig } from "./config";
import { startTui } from "./tui";

export async function startRepl(config: PatricConfig): Promise<void> {
  await startTui(config);
}
