import test, { before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const packageJsonPath = path.join(rootDir, "package.json");
const distVersionPath = path.join(rootDir, "dist", "generated", "version.js");
let build;

before(() => {
  build = spawnSync("npm", ["run", "build"], {
    cwd: rootDir,
    encoding: "utf8",
  });
});

test("bootstrap project builds and exposes forkcast help output", () => {
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
  assert.equal(build.status, 0);

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const distIndex = fs.readFileSync(path.join(rootDir, "dist", "index.js"), "utf8");

  assert.equal(packageJson.type, "module");
  assert.match(distIndex, /\bimport\b.*\bfrom\b/);
  assert.doesNotMatch(distIndex, /\brequire\(/);
});

test("version is stamped at build time and matches package.json", () => {
  assert.equal(build.status, 0);

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const distVersion = fs.readFileSync(distVersionPath, "utf8");

  // The build artifact must contain the exact version from package.json
  assert.ok(
    distVersion.includes(JSON.stringify(packageJson.version)),
    `expected dist/generated/version.js to contain ${JSON.stringify(packageJson.version)}, got:\n${distVersion}`,
  );

  // CLI --version must return the stamped version
  const version = spawnSync("./bin/forkcast", ["--version"], {
    cwd: rootDir,
    encoding: "utf8",
  });

  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), packageJson.version);
});

test("CLI does not depend on package.json at runtime", () => {
  assert.equal(build.status, 0);

  // Temporarily rename package.json so it's unavailable at runtime
  const backupPath = `${packageJsonPath}.bak`;
  fs.renameSync(packageJsonPath, backupPath);

  try {
    const help = spawnSync("./bin/forkcast", ["--help"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    assert.equal(
      help.status,
      0,
      `expected --help to work without package.json\nstdout:\n${help.stdout}\nstderr:\n${help.stderr}`,
    );

    const version = spawnSync("./bin/forkcast", ["--version"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    assert.equal(
      version.status,
      0,
      `expected --version to work without package.json\nstdout:\n${version.stdout}\nstderr:\n${version.stderr}`,
    );
  } finally {
    fs.renameSync(backupPath, packageJsonPath);
  }
});
