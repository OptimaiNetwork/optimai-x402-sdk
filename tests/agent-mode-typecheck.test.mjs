import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.dirname(testDirectory);
const fixturePath = path.join(testDirectory, "fixtures", "create-search-agent-mode.ts");

test("CreateSearchRequest accepts the public agent search mode", () => {
  assert.doesNotThrow(() => {
    execFileSync("pnpm", [
      "exec",
      "tsc",
      "--noEmit",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--skipLibCheck",
      "--lib",
      "ES2022,DOM",
      fixturePath,
    ], {
      cwd: repositoryDirectory,
      stdio: "pipe",
    });
  });
});
