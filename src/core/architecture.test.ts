import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const sourceRoot = path.resolve(import.meta.dir, "..");
function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(target) : /\.(ts|js|cjs)$/.test(entry.name) ? [target] : [];
  });
}

test("relative source imports resolve and shared modules do not depend on either UI", () => {
  const errors: string[] = [];
  for (const file of sourceFiles(sourceRoot)) {
    if (file.endsWith(".test.ts")) continue;
    const owner = path.relative(sourceRoot, file).split(path.sep)[0];
    const source = fs.readFileSync(file, "utf8");
    const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*\()\s*["'](\.[^"']+)["']/g);
    for (const [, specifier] of imports) {
      const resolved = path.resolve(path.dirname(file), specifier);
      const destination = path.relative(sourceRoot, resolved).split(path.sep)[0];
      if (!fs.existsSync(resolved) && !fs.existsSync(resolved.replace(/\.js$/, ".ts"))) {
        errors.push(`${file}: unresolved import ${specifier}`);
      }
      if (["core", "browser", "config"].includes(owner) && ["cli", "desktop"].includes(destination)) {
        errors.push(`${owner} must not depend on ${destination}: ${file}`);
      }
    }
  }
  expect(errors).toEqual([]);
});
