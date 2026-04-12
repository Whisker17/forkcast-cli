import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const packageJsonPath = path.join(rootDir, "package.json");
const distIndexPath = path.join(rootDir, "dist", "index.js");

function runBuild() {
  return spawnSync("npm", ["run", "build"], {
    cwd: rootDir,
    encoding: "utf8",
  });
}

test("bootstrap project builds and exposes forkcast help output", () => {
  const build = runBuild();

  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const help = spawnSync("./bin/forkcast", ["--help"], {
    cwd: rootDir,
    encoding: "utf8",
  });

  assert.equal(
    help.status,
    0,
    `expected help command to succeed\nstdout:\n${help.stdout}\nstderr:\n${help.stderr}`,
  );
  assert.match(help.stdout, /Usage:/);
  assert.match(help.stdout, /forkcast/);
});

test("project is configured as ESM and the compiled entrypoint emits ESM syntax", () => {
  const build = runBuild();

  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const distIndex = fs.readFileSync(distIndexPath, "utf8");

  assert.equal(packageJson.type, "module");
  assert.match(distIndex, /\bimport\s+\{\s*Command\s*\}\s+from\s+"commander"/);
  assert.doesNotMatch(distIndex, /\brequire\(/);
});

test("forkcast exposes a version flag", () => {
  const build = runBuild();

  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const version = spawnSync("./bin/forkcast", ["--version"], {
    cwd: rootDir,
    encoding: "utf8",
  });

  assert.equal(
    version.status,
    0,
    `expected version command to succeed\nstdout:\n${version.stdout}\nstderr:\n${version.stderr}`,
  );
  assert.equal(version.stdout.trim(), "0.1.0");
});
