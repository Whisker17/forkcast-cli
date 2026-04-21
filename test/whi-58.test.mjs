import test, { before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import fsp from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const fixturesDir = path.join(__dirname, "fixtures");

let build;

before(() => {
  build = spawnSync("npm", ["run", "build"], {
    cwd: rootDir,
    encoding: "utf8",
  });
});

function readFixture(name) {
  return fs.readFileSync(path.join(fixturesDir, name), "utf8");
}

function writeJson(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(contents, null, 2));
}

function createFixtureArchive(
  tempDir,
  extraMeetings = [],
) {
  const archiveRoot = path.join(tempDir, "archive-root");
  const forkcastRoot = path.join(archiveRoot, "forkcast-main");

  writeJson(
    path.join(forkcastRoot, "src", "data", "eips", "7702.json"),
    JSON.parse(readFixture("reference-eip-7702.json")),
  );
  writeJson(
    path.join(forkcastRoot, "src", "data", "eips", "5920.json"),
    JSON.parse(readFixture("reference-eip-5920.json")),
  );
  writeJson(
    path.join(forkcastRoot, "public", "artifacts", "acde", "2026-04-09_234", "tldr.json"),
    JSON.parse(readFixture("reference-tldr-acde-234.json")),
  );

  const withoutTldrDir = path.join(
    forkcastRoot,
    "public",
    "artifacts",
    "acdt",
    "2026-04-10_058",
  );
  fs.mkdirSync(withoutTldrDir, { recursive: true });
  fs.writeFileSync(path.join(withoutTldrDir, "notes.md"), "# placeholder\n");
  for (const meeting of extraMeetings) {
    const meetingDir = path.join(
      forkcastRoot,
      "public",
      "artifacts",
      meeting.type,
      meeting.dirName,
    );
    fs.mkdirSync(meetingDir, { recursive: true });
    fs.writeFileSync(path.join(meetingDir, "notes.md"), "# generated\n");
  }
  fs.writeFileSync(path.join(forkcastRoot, "README.md"), "ignore me\n");

  const archivePath = path.join(tempDir, "forkcast-main.tar.gz");
  const archive = spawnSync("tar", ["-czf", archivePath, "-C", archiveRoot, "forkcast-main"], {
    cwd: rootDir,
    encoding: "utf8",
    env: {
      ...process.env,
      COPYFILE_DISABLE: "1",
    },
  });

  assert.equal(
    archive.status,
    0,
    `expected fixture tarball build to succeed\nstdout:\n${archive.stdout}\nstderr:\n${archive.stderr}`,
  );

  return archivePath;
}

function startServer({
  commitStatus = 200,
  commitBody,
  commitDelayMs = 0,
  hangCommit = false,
  breakCommitStream = false,
  archivePath,
  tldrs = {},
  tldrOverrides = {},
  tldrDelayMs = 0,
  tldrStatus = 200,
}) {
  const requests = [];
  const sockets = new Set();
  let activeTldrs = 0;
  let maxConcurrentTldrs = 0;
  const server = http.createServer((req, res) => {
    requests.push(req.url);

    if (req.url === "/repos/ethereum/forkcast/commits/main") {
      res.writeHead(commitStatus, { "content-type": "application/json" });
      if (hangCommit) {
        return;
      }
      if (breakCommitStream) {
        res.write("{\"sha\":\"partial");
        setTimeout(() => {
          res.destroy(new Error("commit stream interrupted"));
        }, commitDelayMs);
        return;
      }
      setTimeout(() => {
        res.end(JSON.stringify(commitBody ?? { sha: "abc123def456" }));
      }, commitDelayMs);
      return;
    }

    if (req.url === "/ethereum/forkcast/archive/main.tar.gz") {
      res.writeHead(200, { "content-type": "application/gzip" });
      fs.createReadStream(archivePath).pipe(res);
      return;
    }

    if (req.url?.startsWith("/forkcast/artifacts/")) {
      const relativePath = req.url.replace("/forkcast/artifacts/", "");
      const payload = tldrs[relativePath];
      const override = tldrOverrides[relativePath] ?? {};
      const currentDelayMs = override.delayMs ?? tldrDelayMs;
      const currentStatus = override.status ?? tldrStatus;

      if (payload === undefined) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      activeTldrs += 1;
      maxConcurrentTldrs = Math.max(maxConcurrentTldrs, activeTldrs);
      res.writeHead(currentStatus, { "content-type": "application/json" });
      setTimeout(() => {
        activeTldrs -= 1;
        if (currentStatus >= 200 && currentStatus < 300) {
          res.end(JSON.stringify(payload));
          return;
        }
        res.end(JSON.stringify({ error: "boom" }));
      }, currentDelayMs);
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        close: () =>
          new Promise((closeResolve, closeReject) => {
            for (const socket of sockets) {
              socket.destroy();
            }
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          }),
        getMaxConcurrentTldrs: () => maxConcurrentTldrs,
        requests,
        url: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

test("WHI-58 fetches EIPs, caches TLDRs, and writes metadata for later indexing", async () => {
  assert.equal(
    build.status,
    0,
    `expected build to succeed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const { fetchEipData } = await import(
    `${pathToFileURL(path.join(rootDir, "dist", "lib", "fetcher.js")).href}?t=${Date.now()}`
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whi-58-fetcher-"));
  const cacheRoot = path.join(tempDir, "cache-root");
  const archivePath = createFixtureArchive(tempDir);
  const stderr = [];
  const tldrPayload = JSON.parse(readFixture("reference-tldr-acde-234.json"));

  const server = await startServer({
    archivePath,
    tldrs: {
      "acde/2026-04-09_234/tldr.json": tldrPayload,
    },
  });

  try {
    await fetchEipData({
      archiveUrl: `${server.url}/ethereum/forkcast/archive/main.tar.gz`,
      cacheRoot,
      commitUrl: `${server.url}/repos/ethereum/forkcast/commits/main`,
      pagesBaseUrl: `${server.url}/forkcast/artifacts`,
      stderr: {
        write(chunk) {
          stderr.push(String(chunk));
          return true;
        },
      },
    });

    const eipsDir = path.join(cacheRoot, "cache", "eips");
    const tldrsDir = path.join(cacheRoot, "cache", "tldrs", "acde");
    const metaPath = path.join(cacheRoot, "cache", "meta.json");
    const inventoryPath = path.join(cacheRoot, "cache", "meetings-manifest.json");

    assert.deepEqual(fs.readdirSync(eipsDir).sort(), ["5920.json", "7702.json"]);
    assert.ok(fs.existsSync(path.join(tldrsDir, "2026-04-09_234.json")));
    assert.ok(!fs.existsSync(path.join(cacheRoot, "cache", "tldrs", "acdt", "2026-04-10_058.json")));

    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    assert.equal(meta.forkcast_commit, "abc123def456");
    assert.equal(meta.version, 1);
    assert.match(meta.last_updated, /^\d{4}-\d{2}-\d{2}T/);

    const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
    assert.deepEqual(inventory, [
      { dirName: "2026-04-09_234", type: "acde" },
      { dirName: "2026-04-10_058", type: "acdt" },
    ]);

    assert.equal(stderr.length, 0);
    assert.deepEqual(server.requests, [
      "/repos/ethereum/forkcast/commits/main",
      "/ethereum/forkcast/archive/main.tar.gz",
      "/forkcast/artifacts/acde/2026-04-09_234/tldr.json",
      "/forkcast/artifacts/acdt/2026-04-10_058/tldr.json",
    ]);
  } finally {
    await server.close();
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

test("WHI-58 falls back to the existing cache when the GitHub commit API is rate limited", async () => {
  assert.equal(build.status, 0);

  const { fetchEipData } = await import(
    `${pathToFileURL(path.join(rootDir, "dist", "lib", "fetcher.js")).href}?t=${Date.now()}-fallback`
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whi-58-fallback-"));
  const cacheRoot = path.join(tempDir, "cache-root");
  const cacheDir = path.join(cacheRoot, "cache");
  const stderr = [];

  fs.mkdirSync(path.join(cacheDir, "eips"), { recursive: true });
  writeJson(path.join(cacheDir, "eips", "7702.json"), JSON.parse(readFixture("reference-eip-7702.json")));
  writeJson(path.join(cacheDir, "meta.json"), {
    forkcast_commit: "cached-sha",
    last_updated: "2026-04-12T15:30:00.000Z",
    version: 1,
  });
  writeJson(path.join(cacheDir, "meetings-manifest.json"), [
    { dirName: "2026-04-09_234", type: "acde" },
  ]);

  const archivePath = createFixtureArchive(tempDir);
  const server = await startServer({
    archivePath,
    commitBody: { message: "rate limited" },
    commitStatus: 403,
  });

  try {
    const result = await fetchEipData({
      archiveUrl: `${server.url}/ethereum/forkcast/archive/main.tar.gz`,
      cacheRoot,
      commitUrl: `${server.url}/repos/ethereum/forkcast/commits/main`,
      pagesBaseUrl: `${server.url}/forkcast/artifacts`,
      stderr: {
        write(chunk) {
          stderr.push(String(chunk));
          return true;
        },
      },
    });

    assert.deepEqual(result.meta, {
      forkcast_commit: "cached-sha",
      last_updated: "2026-04-12T15:30:00.000Z",
      version: 1,
    });
    assert.deepEqual(result.meetings, [{ dirName: "2026-04-09_234", type: "acde" }]);
    assert.match(stderr.join(""), /rate limit/i);
    assert.deepEqual(server.requests, ["/repos/ethereum/forkcast/commits/main"]);
  } finally {
    await server.close();
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

test("WHI-58 cleans up partial state when the downloaded archive is invalid", async () => {
  assert.equal(build.status, 0);

  const { fetchEipData } = await import(
    `${pathToFileURL(path.join(rootDir, "dist", "lib", "fetcher.js")).href}?t=${Date.now()}-invalid`
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whi-58-invalid-"));
  const cacheRoot = path.join(tempDir, "cache-root");
  const invalidArchivePath = path.join(tempDir, "invalid.tar.gz");
  fs.writeFileSync(invalidArchivePath, "not a tarball");

  const server = await startServer({
    archivePath: invalidArchivePath,
  });

  try {
    await assert.rejects(
      () =>
        fetchEipData({
          archiveUrl: `${server.url}/ethereum/forkcast/archive/main.tar.gz`,
          cacheRoot,
          commitUrl: `${server.url}/repos/ethereum/forkcast/commits/main`,
          pagesBaseUrl: `${server.url}/forkcast/artifacts`,
        }),
      (error) => error?.code === "FETCH_FAILED",
    );

    assert.equal(fs.existsSync(path.join(cacheRoot, "cache", "eips")), false);
    assert.equal(fs.existsSync(path.join(cacheRoot, "cache", "meta.json")), false);
    assert.deepEqual(server.requests, [
      "/repos/ethereum/forkcast/commits/main",
      "/ethereum/forkcast/archive/main.tar.gz",
    ]);
  } finally {
    await server.close();
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

test("WHI-58 times out hung HTTP requests instead of waiting forever", async () => {
  assert.equal(build.status, 0);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whi-58-timeout-"));
  const archivePath = createFixtureArchive(tempDir);
  const server = await startServer({
    archivePath,
    hangCommit: true,
  });

  try {
    const script = `
      import { fetchEipData } from ${JSON.stringify(pathToFileURL(path.join(rootDir, "dist", "lib", "fetcher.js")).href)};
      try {
        await fetchEipData({
          cacheRoot: ${JSON.stringify(path.join(tempDir, "cache-root"))},
          commitUrl: ${JSON.stringify(`${server.url}/repos/ethereum/forkcast/commits/main`)},
          archiveUrl: ${JSON.stringify(`${server.url}/ethereum/forkcast/archive/main.tar.gz`)},
          pagesBaseUrl: ${JSON.stringify(`${server.url}/forkcast/artifacts`)},
          requestTimeoutMs: 50,
        });
        console.log("unexpected-success");
        process.exit(0);
      } catch (error) {
        console.log(JSON.stringify({ code: error.code, message: error.message }));
        process.exit(0);
      }
    `;

    const child = spawnSync("node", ["--input-type=module", "-e", script], {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 500,
    });

    assert.equal(child.signal, null, `process timed out instead of failing fast\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
    assert.equal(child.status, 0, `child failed unexpectedly\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`);

    const payload = JSON.parse(child.stdout.trim());
    assert.equal(payload.code, "FETCH_FAILED");
    assert.match(payload.message, /timed out/i);
    assert.match(payload.message, /commits\/main/);
  } finally {
    await server.close();
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

test("WHI-58 tolerates missing meetings manifests when rate-limit fallback uses an older cache", async () => {
  assert.equal(build.status, 0);

  const { fetchEipData } = await import(
    `${pathToFileURL(path.join(rootDir, "dist", "lib", "fetcher.js")).href}?t=${Date.now()}-legacy-fallback`
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whi-58-legacy-fallback-"));
  const cacheRoot = path.join(tempDir, "cache-root");
  const cacheDir = path.join(cacheRoot, "cache");
  const stderr = [];

  fs.mkdirSync(path.join(cacheDir, "eips"), { recursive: true });
  writeJson(path.join(cacheDir, "eips", "7702.json"), JSON.parse(readFixture("reference-eip-7702.json")));
  writeJson(path.join(cacheDir, "meta.json"), {
    forkcast_commit: "cached-sha",
    last_updated: "2026-04-12T15:30:00.000Z",
    version: 1,
  });

  const archivePath = createFixtureArchive(tempDir);
  const server = await startServer({
    archivePath,
    commitBody: { message: "rate limited" },
    commitStatus: 403,
  });

  try {
    const result = await fetchEipData({
      cacheRoot,
      commitUrl: `${server.url}/repos/ethereum/forkcast/commits/main`,
      archiveUrl: `${server.url}/ethereum/forkcast/archive/main.tar.gz`,
      pagesBaseUrl: `${server.url}/forkcast/artifacts`,
      stderr: {
        write(chunk) {
          stderr.push(String(chunk));
          return true;
        },
      },
    });

    assert.deepEqual(result.meta, {
      forkcast_commit: "cached-sha",
      last_updated: "2026-04-12T15:30:00.000Z",
      version: 1,
    });
    assert.deepEqual(result.meetings, []);
    assert.match(stderr.join(""), /manifest/i);
  } finally {
    await server.close();
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

test("WHI-58 rejects mid-stream response failures without hanging the process", async () => {
  assert.equal(build.status, 0);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whi-58-stream-error-"));
  const archivePath = createFixtureArchive(tempDir);
  const server = await startServer({
    archivePath,
    breakCommitStream: true,
    commitDelayMs: 10,
  });

  try {
    const script = `
      import { fetchEipData } from ${JSON.stringify(pathToFileURL(path.join(rootDir, "dist", "lib", "fetcher.js")).href)};
      try {
        await fetchEipData({
          cacheRoot: ${JSON.stringify(path.join(tempDir, "cache-root"))},
          commitUrl: ${JSON.stringify(`${server.url}/repos/ethereum/forkcast/commits/main`)},
          archiveUrl: ${JSON.stringify(`${server.url}/ethereum/forkcast/archive/main.tar.gz`)},
          pagesBaseUrl: ${JSON.stringify(`${server.url}/forkcast/artifacts`)},
          requestTimeoutMs: 200,
        });
        console.log("unexpected-success");
      } catch (error) {
        console.log(JSON.stringify({ code: error.code, message: error.message }));
      }
    `;

    const child = spawnSync("node", ["--input-type=module", "-e", script], {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 1000,
    });

    assert.equal(child.signal, null, `process hung on response error\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
    assert.equal(child.status, 0, `child failed unexpectedly\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`);

    const payload = JSON.parse(child.stdout.trim());
    assert.equal(payload.code, "FETCH_FAILED");
    assert.match(payload.message, /commits\/main/);
  } finally {
    await server.close();
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

test("WHI-58 preserves the previous cache when finalize fails after staging succeeds", async () => {
  assert.equal(build.status, 0);

  const { fetchEipData } = await import(
    `${pathToFileURL(path.join(rootDir, "dist", "lib", "fetcher.js")).href}?t=${Date.now()}-atomic`
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whi-58-atomic-"));
  const cacheRoot = path.join(tempDir, "cache-root");
  const cacheDir = path.join(cacheRoot, "cache");
  const oldTldr = { meeting: "Old", highlights: {}, action_items: [], decisions: [], targets: [] };

  writeJson(path.join(cacheDir, "eips", "9999.json"), { id: 9999 });
  writeJson(path.join(cacheDir, "tldrs", "acde", "old.json"), oldTldr);
  writeJson(path.join(cacheDir, "meta.json"), {
    forkcast_commit: "old-sha",
    last_updated: "2026-04-01T00:00:00.000Z",
    version: 1,
  });
  writeJson(path.join(cacheDir, "meetings-manifest.json"), [{ type: "acde", dirName: "old" }]);

  const archivePath = createFixtureArchive(tempDir);
  const server = await startServer({
    archivePath,
    tldrs: {
      "acde/2026-04-09_234/tldr.json": JSON.parse(readFixture("reference-tldr-acde-234.json")),
    },
  });
  const originalWriteFile = fsp.writeFile;

  try {
    fsp.writeFile = async (targetPath, data, options) => {
      if (String(targetPath).endsWith(path.join("cache", "meetings-manifest.json"))) {
        throw new Error("injected manifest write failure");
      }
      return originalWriteFile.call(fsp, targetPath, data, options);
    };

    await assert.rejects(
      () =>
        fetchEipData({
          cacheRoot,
          commitUrl: `${server.url}/repos/ethereum/forkcast/commits/main`,
          archiveUrl: `${server.url}/ethereum/forkcast/archive/main.tar.gz`,
          pagesBaseUrl: `${server.url}/forkcast/artifacts`,
        }),
      (error) => error?.code === "FETCH_FAILED",
    );

    assert.deepEqual(fs.readdirSync(path.join(cacheDir, "eips")), ["9999.json"]);
    assert.deepEqual(fs.readdirSync(path.join(cacheDir, "tldrs", "acde")), ["old.json"]);
    const meta = JSON.parse(fs.readFileSync(path.join(cacheDir, "meta.json"), "utf8"));
    assert.equal(meta.forkcast_commit, "old-sha");
  } finally {
    fsp.writeFile = originalWriteFile;
    await server.close();
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

test("WHI-58 fetches TLDRs with bounded concurrency instead of serially", async () => {
  assert.equal(build.status, 0);

  const { fetchEipData } = await import(
    `${pathToFileURL(path.join(rootDir, "dist", "lib", "fetcher.js")).href}?t=${Date.now()}-concurrency`
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whi-58-concurrency-"));
  const cacheRoot = path.join(tempDir, "cache-root");
  const extraMeetings = [
    { type: "bal", dirName: "2026-04-11_001" },
    { type: "epbs", dirName: "2026-04-12_010" },
  ];
  const archivePath = createFixtureArchive(tempDir, extraMeetings);
  const tldrPayload = JSON.parse(readFixture("reference-tldr-acde-234.json"));

  const server = await startServer({
    archivePath,
    tldrDelayMs: 200,
    tldrs: {
      "acde/2026-04-09_234/tldr.json": tldrPayload,
      "acdt/2026-04-10_058/tldr.json": tldrPayload,
      "bal/2026-04-11_001/tldr.json": tldrPayload,
      "epbs/2026-04-12_010/tldr.json": tldrPayload,
    },
  });

  try {
    await fetchEipData({
      cacheRoot,
      commitUrl: `${server.url}/repos/ethereum/forkcast/commits/main`,
      archiveUrl: `${server.url}/ethereum/forkcast/archive/main.tar.gz`,
      pagesBaseUrl: `${server.url}/forkcast/artifacts`,
    });

    assert.ok(server.getMaxConcurrentTldrs() > 1, `expected concurrent TLDR fetches, saw ${server.getMaxConcurrentTldrs()}`);
  } finally {
    await server.close();
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

test("WHI-58 stops dequeuing new TLDR fetches after the first failure", async () => {
  assert.equal(build.status, 0);

  const { fetchEipData } = await import(
    `${pathToFileURL(path.join(rootDir, "dist", "lib", "fetcher.js")).href}?t=${Date.now()}-cancel`
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whi-58-cancel-"));
  const cacheRoot = path.join(tempDir, "cache-root");
  const extraMeetings = Array.from({ length: 10 }, (_, index) => ({
    type: "bal",
    dirName: `2026-04-${String(index + 11).padStart(2, "0")}_${String(index + 1).padStart(3, "0")}`,
  }));
  const archivePath = createFixtureArchive(tempDir, extraMeetings);
  const tldrPayload = JSON.parse(readFixture("reference-tldr-acde-234.json"));

  const tldrs = Object.fromEntries(
    extraMeetings.map((meeting) => [`${meeting.type}/${meeting.dirName}/tldr.json`, tldrPayload]),
  );
  tldrs["acde/2026-04-09_234/tldr.json"] = { ok: false };
  tldrs["acdt/2026-04-10_058/tldr.json"] = tldrPayload;

  const server = await startServer({
    archivePath,
    tldrDelayMs: 100,
    tldrs,
    tldrOverrides: {
      "acde/2026-04-09_234/tldr.json": { delayMs: 0, status: 500 },
    },
  });

  try {
    await assert.rejects(
      () =>
        fetchEipData({
          cacheRoot,
          commitUrl: `${server.url}/repos/ethereum/forkcast/commits/main`,
          archiveUrl: `${server.url}/ethereum/forkcast/archive/main.tar.gz`,
          pagesBaseUrl: `${server.url}/forkcast/artifacts`,
        }),
      (error) => error?.code === "DATA_ERROR" || error?.code === "FETCH_FAILED",
    );

    await delay(250);
    const tldrRequests = server.requests.filter((request) => request?.startsWith("/forkcast/artifacts/"));
    assert.ok(
      tldrRequests.length < extraMeetings.length + 2,
      `expected cancellation to stop new TLDR work, saw ${tldrRequests.length} requests`,
    );
  } finally {
    await server.close();
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

test("WHI-58 surfaces the failing TLDR URL and status code in fetch errors", async () => {
  assert.equal(build.status, 0);

  const { fetchEipData } = await import(
    `${pathToFileURL(path.join(rootDir, "dist", "lib", "fetcher.js")).href}?t=${Date.now()}-error-context`
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whi-58-error-context-"));
  const cacheRoot = path.join(tempDir, "cache-root");
  const archivePath = createFixtureArchive(tempDir);

  const server = await startServer({
    archivePath,
    tldrStatus: 500,
    tldrs: {
      "acde/2026-04-09_234/tldr.json": { ok: false },
    },
  });

  try {
    await assert.rejects(
      () =>
        fetchEipData({
          cacheRoot,
          commitUrl: `${server.url}/repos/ethereum/forkcast/commits/main`,
          archiveUrl: `${server.url}/ethereum/forkcast/archive/main.tar.gz`,
          pagesBaseUrl: `${server.url}/forkcast/artifacts`,
        }),
      (error) =>
        error?.code === "FETCH_FAILED" &&
        /acde\/2026-04-09_234\/tldr\.json/.test(error.message) &&
        /HTTP 500/.test(error.message),
    );
  } finally {
    await server.close();
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

test("WHI-58 removes stale cache backup directories before starting a new fetch", async () => {
  assert.equal(build.status, 0);

  const { fetchEipData } = await import(
    `${pathToFileURL(path.join(rootDir, "dist", "lib", "fetcher.js")).href}?t=${Date.now()}-backup-cleanup`
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whi-58-backup-cleanup-"));
  const cacheRoot = path.join(tempDir, "cache-root");
  const staleBackupDir = path.join(cacheRoot, "cache.bak-stale");
  const archivePath = createFixtureArchive(tempDir);
  const tldrPayload = JSON.parse(readFixture("reference-tldr-acde-234.json"));

  fs.mkdirSync(staleBackupDir, { recursive: true });
  fs.writeFileSync(path.join(staleBackupDir, "marker.txt"), "stale");
  const staleDate = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(staleBackupDir, staleDate, staleDate);

  const server = await startServer({
    archivePath,
    tldrs: {
      "acde/2026-04-09_234/tldr.json": tldrPayload,
    },
  });

  try {
    await fetchEipData({
      cacheRoot,
      commitUrl: `${server.url}/repos/ethereum/forkcast/commits/main`,
      archiveUrl: `${server.url}/ethereum/forkcast/archive/main.tar.gz`,
      pagesBaseUrl: `${server.url}/forkcast/artifacts`,
    });

    assert.equal(fs.existsSync(staleBackupDir), false);
  } finally {
    await server.close();
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

test("WHI-58 ignores individual stale-backup cleanup failures and still fetches", async () => {
  assert.equal(build.status, 0);

  const { fetchEipData } = await import(
    `${pathToFileURL(path.join(rootDir, "dist", "lib", "fetcher.js")).href}?t=${Date.now()}-backup-cleanup-failure`
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whi-58-backup-cleanup-failure-"));
  const cacheRoot = path.join(tempDir, "cache-root");
  const staleBackupDir = path.join(cacheRoot, "cache.bak-broken");
  const archivePath = createFixtureArchive(tempDir);
  const tldrPayload = JSON.parse(readFixture("reference-tldr-acde-234.json"));
  const originalStat = fsp.stat;

  fs.mkdirSync(staleBackupDir, { recursive: true });
  const staleDate = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(staleBackupDir, staleDate, staleDate);

  const server = await startServer({
    archivePath,
    tldrs: {
      "acde/2026-04-09_234/tldr.json": tldrPayload,
    },
  });

  try {
    fsp.stat = async (targetPath, ...rest) => {
      if (String(targetPath) === staleBackupDir) {
        throw new Error("simulated cleanup race");
      }
      return originalStat.call(fsp, targetPath, ...rest);
    };

    const result = await fetchEipData({
      cacheRoot,
      commitUrl: `${server.url}/repos/ethereum/forkcast/commits/main`,
      archiveUrl: `${server.url}/ethereum/forkcast/archive/main.tar.gz`,
      pagesBaseUrl: `${server.url}/forkcast/artifacts`,
    });

    assert.equal(result.meta.version, 1);
    assert.ok(fs.existsSync(path.join(cacheRoot, "cache", "eips", "7702.json")));
  } finally {
    fsp.stat = originalStat;
    await server.close();
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

test("WHI-58 preserves the original swap failure when rollback also fails", async () => {
  assert.equal(build.status, 0);

  const { fetchEipData } = await import(
    `${pathToFileURL(path.join(rootDir, "dist", "lib", "fetcher.js")).href}?t=${Date.now()}-swap-error`
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whi-58-swap-error-"));
  const cacheRoot = path.join(tempDir, "cache-root");
  const cacheDir = path.join(cacheRoot, "cache");
  const archivePath = createFixtureArchive(tempDir);
  const originalRename = fsp.rename;

  writeJson(path.join(cacheDir, "eips", "9999.json"), { id: 9999 });
  writeJson(path.join(cacheDir, "tldrs", "acde", "old.json"), { meeting: "Old" });
  writeJson(path.join(cacheDir, "meta.json"), {
    forkcast_commit: "old-sha",
    last_updated: "2026-04-01T00:00:00.000Z",
    version: 1,
  });
  writeJson(path.join(cacheDir, "meetings-manifest.json"), [{ type: "acde", dirName: "old" }]);

  const server = await startServer({
    archivePath,
    tldrs: {
      "acde/2026-04-09_234/tldr.json": JSON.parse(readFixture("reference-tldr-acde-234.json")),
    },
  });

  try {
    fsp.rename = async (fromPath, toPath, ...rest) => {
      const from = String(fromPath);
      const to = String(toPath);
      if (from.includes(".tmp-fetch-") && path.basename(from) === "cache" && to === cacheDir) {
        throw new Error("install failed");
      }
      if (from.startsWith(`${cacheDir}.bak-`) && to === cacheDir) {
        throw new Error("rollback failed");
      }
      return originalRename.call(fsp, fromPath, toPath, ...rest);
    };

    await assert.rejects(
      () =>
        fetchEipData({
          cacheRoot,
          commitUrl: `${server.url}/repos/ethereum/forkcast/commits/main`,
          archiveUrl: `${server.url}/ethereum/forkcast/archive/main.tar.gz`,
          pagesBaseUrl: `${server.url}/forkcast/artifacts`,
        }),
      (error) =>
        error?.code === "FETCH_FAILED" &&
        /install failed/.test(error.message) &&
        !/rollback failed/.test(error.message),
    );
  } finally {
    fsp.rename = originalRename;
    await server.close();
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

test("WHI-58 removes stale tmp-fetch directories before starting a new fetch", async () => {
  assert.equal(build.status, 0);

  const { fetchEipData } = await import(
    `${pathToFileURL(path.join(rootDir, "dist", "lib", "fetcher.js")).href}?t=${Date.now()}-tmp-cleanup`
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whi-58-tmp-cleanup-"));
  const cacheRoot = path.join(tempDir, "cache-root");
  const staleTempDir = path.join(cacheRoot, ".tmp-fetch-stale");
  const archivePath = createFixtureArchive(tempDir);
  const tldrPayload = JSON.parse(readFixture("reference-tldr-acde-234.json"));

  fs.mkdirSync(staleTempDir, { recursive: true });
  fs.writeFileSync(path.join(staleTempDir, "marker.txt"), "stale");
  const staleDate = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(staleTempDir, staleDate, staleDate);

  const server = await startServer({
    archivePath,
    tldrs: {
      "acde/2026-04-09_234/tldr.json": tldrPayload,
    },
  });

  try {
    await fetchEipData({
      cacheRoot,
      commitUrl: `${server.url}/repos/ethereum/forkcast/commits/main`,
      archiveUrl: `${server.url}/ethereum/forkcast/archive/main.tar.gz`,
      pagesBaseUrl: `${server.url}/forkcast/artifacts`,
    });

    assert.equal(fs.existsSync(staleTempDir), false);
  } finally {
    await server.close();
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

test("WHI-58 rejects extraction when no EIP files are produced", async () => {
  assert.equal(build.status, 0);

  const { fetchEipData } = await import(
    `${pathToFileURL(path.join(rootDir, "dist", "lib", "fetcher.js")).href}?t=${Date.now()}-empty-extraction`
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whi-58-empty-extraction-"));
  const cacheRoot = path.join(tempDir, "cache-root");
  const cacheDir = path.join(cacheRoot, "cache");

  writeJson(path.join(cacheDir, "eips", "7702.json"), JSON.parse(readFixture("reference-eip-7702.json")));
  writeJson(path.join(cacheDir, "meta.json"), {
    forkcast_commit: "existing-sha",
    last_updated: "2026-04-12T00:00:00.000Z",
    version: 1,
  });
  writeJson(path.join(cacheDir, "meetings-manifest.json"), []);

  const archiveRoot = path.join(tempDir, "archive-root", "forkcast-main");
  fs.mkdirSync(archiveRoot, { recursive: true });
  fs.writeFileSync(path.join(archiveRoot, "README.md"), "empty archive\n");
  const archivePath = path.join(tempDir, "empty.tar.gz");
  spawnSync("tar", ["-czf", archivePath, "-C", path.join(tempDir, "archive-root"), "forkcast-main"], {
    cwd: rootDir,
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });

  const server = await startServer({ archivePath });

  try {
    await assert.rejects(
      () =>
        fetchEipData({
          cacheRoot,
          commitUrl: `${server.url}/repos/ethereum/forkcast/commits/main`,
          archiveUrl: `${server.url}/ethereum/forkcast/archive/main.tar.gz`,
          pagesBaseUrl: `${server.url}/forkcast/artifacts`,
        }),
      (error) => error?.code === "DATA_ERROR" && /no EIP files/i.test(error.message),
    );

    assert.ok(
      fs.existsSync(path.join(cacheDir, "eips", "7702.json")),
      "original cache should be preserved when extraction is empty",
    );
  } finally {
    await server.close();
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

test("WHI-58 acquires a process lock and rejects concurrent fetches", async () => {
  assert.equal(build.status, 0);

  const { fetchEipData, FetcherError } = await import(
    `${pathToFileURL(path.join(rootDir, "dist", "lib", "fetcher.js")).href}?t=${Date.now()}-lock`
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whi-58-lock-"));
  const cacheRoot = path.join(tempDir, "cache-root");
  const archivePath = createFixtureArchive(tempDir);
  const tldrPayload = JSON.parse(readFixture("reference-tldr-acde-234.json"));

  const server = await startServer({
    archivePath,
    commitDelayMs: 200,
    tldrs: {
      "acde/2026-04-09_234/tldr.json": tldrPayload,
    },
  });

  try {
    const opts = {
      cacheRoot,
      commitUrl: `${server.url}/repos/ethereum/forkcast/commits/main`,
      archiveUrl: `${server.url}/ethereum/forkcast/archive/main.tar.gz`,
      pagesBaseUrl: `${server.url}/forkcast/artifacts`,
    };

    const first = fetchEipData(opts);
    await new Promise((r) => setTimeout(r, 50));
    const second = fetchEipData(opts);

    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 1, "exactly one fetch should succeed");
    assert.equal(rejected.length, 1, "exactly one fetch should be rejected by the lock");
    assert.match(rejected[0].reason.message, /already in progress/i);
  } finally {
    await server.close();
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

test("WHI-58 pins the archive download to the commit SHA", async () => {
  assert.equal(build.status, 0);

  const { fetchEipData } = await import(
    `${pathToFileURL(path.join(rootDir, "dist", "lib", "fetcher.js")).href}?t=${Date.now()}-sha-pin`
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whi-58-sha-pin-"));
  const cacheRoot = path.join(tempDir, "cache-root");
  const commitSha = "abc123def456";

  const archiveRoot = path.join(tempDir, "archive-root");
  const forkcastRoot = path.join(archiveRoot, `forkcast-${commitSha}`);
  writeJson(
    path.join(forkcastRoot, "src", "data", "eips", "7702.json"),
    JSON.parse(readFixture("reference-eip-7702.json")),
  );
  const meetingDir = path.join(forkcastRoot, "public", "artifacts", "acde", "2026-04-09_234");
  fs.mkdirSync(meetingDir, { recursive: true });
  fs.writeFileSync(path.join(meetingDir, "tldr.json"), readFixture("reference-tldr-acde-234.json"));

  const archivePath = path.join(tempDir, "pinned.tar.gz");
  spawnSync("tar", ["-czf", archivePath, "-C", archiveRoot, `forkcast-${commitSha}`], {
    cwd: rootDir,
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });

  const requests = [];
  const tldrPayload = JSON.parse(readFixture("reference-tldr-acde-234.json"));
  const server = http.createServer((req, res) => {
    requests.push(req.url);

    if (req.url === "/repos/ethereum/forkcast/commits/main") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ sha: commitSha }));
      return;
    }

    if (req.url === `/ethereum/forkcast/archive/${commitSha}.tar.gz`) {
      res.writeHead(200, { "content-type": "application/gzip" });
      fs.createReadStream(archivePath).pipe(res);
      return;
    }

    if (req.url?.startsWith("/forkcast/artifacts/")) {
      const relativePath = req.url.replace("/forkcast/artifacts/", "");
      if (relativePath === "acde/2026-04-09_234/tldr.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(tldrPayload));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const result = await fetchEipData({
      cacheRoot,
      commitUrl: `${baseUrl}/repos/ethereum/forkcast/commits/main`,
      archiveUrl: `${baseUrl}/ethereum/forkcast/archive/${commitSha}.tar.gz`,
      archiveRef: commitSha,
      pagesBaseUrl: `${baseUrl}/forkcast/artifacts`,
    });

    assert.equal(result.meta.forkcast_commit, commitSha);
    assert.ok(
      requests.includes(`/ethereum/forkcast/archive/${commitSha}.tar.gz`),
      `expected archive request pinned to SHA, saw: ${JSON.stringify(requests)}`,
    );
    assert.ok(
      !requests.includes("/ethereum/forkcast/archive/main.tar.gz"),
      "should NOT request main.tar.gz",
    );
    assert.ok(fs.existsSync(path.join(cacheRoot, "cache", "eips", "7702.json")));
  } finally {
    await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

test("WHI-58 treats a recent malformed fetch lock as active instead of stealing it", async () => {
  assert.equal(build.status, 0);

  const { fetchEipData } = await import(
    `${pathToFileURL(path.join(rootDir, "dist", "lib", "fetcher.js")).href}?t=${Date.now()}-malformed-lock`
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whi-58-malformed-lock-"));
  const cacheRoot = path.join(tempDir, "cache-root");
  const lockPath = path.join(cacheRoot, ".fetch-lock");
  const archivePath = createFixtureArchive(tempDir);

  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.writeFileSync(lockPath, "{");

  const server = await startServer({ archivePath });

  try {
    await assert.rejects(
      () =>
        fetchEipData({
          cacheRoot,
          commitUrl: `${server.url}/repos/ethereum/forkcast/commits/main`,
          archiveUrl: `${server.url}/ethereum/forkcast/archive/main.tar.gz`,
          pagesBaseUrl: `${server.url}/forkcast/artifacts`,
        }),
      (error) =>
        error?.code === "FETCH_FAILED" &&
        /already in progress/i.test(error.message),
    );

    assert.equal(fs.existsSync(lockPath), true);
    assert.deepEqual(server.requests, []);
  } finally {
    await server.close();
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

test("WHI-58 does not delete stale temp fetch directories before acquiring the process lock", async () => {
  assert.equal(build.status, 0);

  const { fetchEipData } = await import(
    `${pathToFileURL(path.join(rootDir, "dist", "lib", "fetcher.js")).href}?t=${Date.now()}-cleanup-after-lock`
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whi-58-cleanup-after-lock-"));
  const cacheRoot = path.join(tempDir, "cache-root");
  const lockPath = path.join(cacheRoot, ".fetch-lock");
  const staleTempDir = path.join(cacheRoot, ".tmp-fetch-active");
  const archivePath = createFixtureArchive(tempDir);

  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.mkdirSync(staleTempDir, { recursive: true });
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, ts: Date.now() }),
  );
  const staleDate = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(staleTempDir, staleDate, staleDate);

  const server = await startServer({ archivePath });

  try {
    await assert.rejects(
      () =>
        fetchEipData({
          cacheRoot,
          commitUrl: `${server.url}/repos/ethereum/forkcast/commits/main`,
          archiveUrl: `${server.url}/ethereum/forkcast/archive/main.tar.gz`,
          pagesBaseUrl: `${server.url}/forkcast/artifacts`,
        }),
      (error) =>
        error?.code === "FETCH_FAILED" &&
        /already in progress/i.test(error.message),
    );

    assert.equal(fs.existsSync(staleTempDir), true);
    assert.deepEqual(server.requests, []);
  } finally {
    await server.close();
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});
