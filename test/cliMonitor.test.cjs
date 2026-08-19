const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const childProcess = require("node:child_process");
const { promisify } = require("node:util");

const cliModulePath = require.resolve("../out/cli.js");
const loggingModulePath = require.resolve("../out/logging.js");

function loadCli(execHandler, configuration = {}) {
  const originalLoad = Module._load;
  const originalBin = process.env.STARLING_BIN;
  const fakeExecFile = () => {
    throw new Error("callback execFile path should not be used");
  };
  fakeExecFile[promisify.custom] = execHandler;

  const outputChannel = {
    error() {},
    info() {},
    show() {},
    dispose() {},
  };
  const vscodeStub = {
    workspace: {
      getConfiguration() {
        return {
          get(key, fallback) {
            return Object.prototype.hasOwnProperty.call(configuration, key)
              ? configuration[key]
              : fallback;
          },
        };
      },
    },
    window: {
      createOutputChannel() {
        return outputChannel;
      },
    },
  };

  delete require.cache[cliModulePath];
  delete require.cache[loggingModulePath];
  process.env.STARLING_BIN = "/fake/starling";
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "vscode") return vscodeStub;
    if (request === "child_process") {
      return { ...childProcess, execFile: fakeExecFile };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(cliModulePath);
  } finally {
    Module._load = originalLoad;
    if (originalBin === undefined) {
      delete process.env.STARLING_BIN;
    } else {
      process.env.STARLING_BIN = originalBin;
    }
  }
}

function emptySnapshotJson() {
  return JSON.stringify({
    pinned_total: 0,
    recent_total: 0,
    active: 0,
    rows: [],
    pinned: [],
    recent: [],
  });
}

test("forced monitor refreshes reuse the same in-flight CLI command", async () => {
  let calls = 0;
  let resolveExec;
  const cli = loadCli(() => {
    calls += 1;
    return new Promise((resolve) => {
      resolveExec = resolve;
    });
  });

  const first = cli.getMonitorSnapshot({ force: true, allowStale: false });
  const second = cli.getMonitorSnapshot({ force: true, allowStale: false });

  assert.equal(calls, 1);
  resolveExec({ stdout: emptySnapshotJson(), stderr: "" });
  await Promise.all([first, second]);
});

test("monitor timeout reports the timeout, signal, and killed state", async () => {
  let receivedTimeout;
  const cli = loadCli(async (_file, _args, options) => {
    receivedTimeout = options.timeout;
    const error = new Error("Command failed");
    error.code = null;
    error.killed = true;
    error.signal = "SIGTERM";
    throw error;
  });

  await assert.rejects(
    () => cli.getMonitorSnapshot({ force: true, allowStale: false }),
    (error) => {
      assert.match(error.message, /timed out after 60000ms/);
      assert.match(error.message, /killed=true/);
      assert.match(error.message, /signal=SIGTERM/);
      assert.doesNotMatch(error.message, /code=null/);
      return true;
    }
  );
  assert.equal(receivedTimeout, 60_000);
});

test("command-cache invalidation preserves stale monitor data and retry backoff", async () => {
  let calls = 0;
  const cli = loadCli(async () => {
    calls += 1;
    if (calls === 1) {
      return { stdout: emptySnapshotJson(), stderr: "" };
    }
    throw Object.assign(new Error("Command failed"), {
      code: null,
      killed: true,
      signal: "SIGTERM",
    });
  });

  const initial = await cli.getMonitorSnapshot({ force: true });
  cli.clearCommandCache();
  const stale = await cli.getMonitorSnapshot({ force: true, allowStale: true });
  const backedOff = await cli.getMonitorSnapshot({ force: true, allowStale: true });

  assert.deepEqual(stale, initial);
  assert.deepEqual(backedOff, initial);
  assert.equal(calls, 2);
});

test("active monitor rows are running or waiting, not merely pid-backed", () => {
  const cli = loadCli(async () => ({ stdout: emptySnapshotJson(), stderr: "" }));

  assert.equal(cli.isActiveMonitorRowStatus({ status: "running" }), true);
  assert.equal(cli.isActiveMonitorRowStatus({ status: "waiting" }), true);
  assert.equal(cli.isActiveMonitorRowStatus({ status: "idle", pid: 1 }), false);
  assert.equal(cli.isActiveMonitorRowStatus({ status: "orphaned", pid: 1 }), false);
  assert.equal(cli.isActiveMonitorRowStatus({ status: "stopped", pid: 1 }), false);
});
