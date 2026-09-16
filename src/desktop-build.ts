import { packager } from "@electron/packager";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const runtimeDir = path.join(root, ".desktop-build");
fs.mkdirSync(runtimeDir, { recursive: true });
const runtime = path.join(runtimeDir, "patric-bun");
fs.copyFileSync(process.execPath, runtime);
fs.chmodSync(runtime, 0o755);
const outputs = await packager({
  dir: root,
  name: "Patric",
  executableName: "Patric",
  appBundleId: "dev.patric.desktop",
  appCategoryType: "public.app-category.developer-tools",
  out: path.join(root, "dist"),
  overwrite: true,
  asar: false,
  prune: true,
  extraResource: [runtime],
  ignore: [/^\/dist(?:\/|$)/, /^\/\.desktop-build(?:\/|$)/, /^\/\.git(?:\/|$)/,
    /^\/\.claude(?:\/|$)/, /^\/\.patric[^/]*(?:\/|$)/, /^\/extension(?:\/|$)/, /\.test\.ts$/],
});
console.log(`Desktop app built:\n${outputs.join("\n")}`);
