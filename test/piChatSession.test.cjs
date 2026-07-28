const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const {
  StrictJsonlDecoder,
  normalizePiMessages,
} = require("../out/piChatProtocol.js");
const {
  PiChatCliPathError,
  PiChatSession,
  STARLING_CHAT_TERM_GRACE_MS,
  buildPiChatArguments,
  resolvePiChatSpawnCommand,
  terminateWindowsProcessTree,
} = require("../out/piChatSession.js");

test("strict JSONL splits only on LF and preserves Unicode separators", () => {
  const decoder = new StrictJsonlDecoder();
  const source = Buffer.from('{"text":"a\u2028b 😀"}\n{"second":true}\r\n{"tail":1}', "utf8");
  const emoji = source.indexOf(Buffer.from("😀"));
  const lines = [
    ...decoder.push(source.subarray(0, emoji + 1)),
    ...decoder.push(source.subarray(emoji + 1, source.length - 4)),
    ...decoder.push(source.subarray(source.length - 4)),
    ...decoder.end(),
  ];
  assert.deepEqual(lines, [
    '{"text":"a\u2028b 😀"}',
    '{"second":true}',
    '{"tail":1}',
  ]);
});

test("Pi chat arguments keep Starling options before pi and resume by absolute path", () => {
  assert.deepEqual(buildPiChatArguments({ cwd: "/work/project" }), [
    "chat", "--cwd", "/work/project", "pi",
  ]);
  assert.deepEqual(buildPiChatArguments({
    cwd: "/work/project",
    setting: "research",
    sessionPath: "/sessions/pi-session.jsonl",
  }), [
    "chat", "--cwd", "/work/project", "--setting", "research",
    "pi", "--session", "/sessions/pi-session.jsonl",
  ]);
  assert.throws(
    () => buildPiChatArguments({ cwd: "/work/project", sessionPath: "relative.jsonl" }),
    /must be absolute/,
  );
});

test("Pi chat spawn resolver is direct on POSIX and preserves shell metacharacters as arguments", () => {
  const args = ["chat", "--cwd", "/work/a & b; $(touch nope)", "pi"];
  assert.deepEqual(resolvePiChatSpawnCommand("/opt/starling", args, { platform: "linux" }), {
    file: "/opt/starling",
    args,
  });
});

test("Windows resolver prefers the npm wrapper that owns the SDK Host", () => {
  const files = new Set([
    String.raw`C:\first\starling.exe`.toLowerCase(),
    String.raw`C:\first\starling.cmd`.toLowerCase(),
    String.raw`C:\first\node_modules\starling-ai\bin\starling.js`.toLowerCase(),
    String.raw`C:\first\node.exe`.toLowerCase(),
    String.raw`C:\second\starling.exe`.toLowerCase(),
  ]);
  const result = resolvePiChatSpawnCommand("starling", ["chat", "pi"], {
    platform: "win32",
    env: { Path: String.raw`C:\first;C:\second` },
    cwd: String.raw`C:\workspace`,
    fileExists: (file) => files.has(file.toLowerCase()),
  });
  assert.deepEqual(result, {
    file: String.raw`C:\first\node.exe`,
    args: [
      String.raw`C:\first\node_modules\starling-ai\bin\starling.js`,
      "chat", "pi",
    ],
  });
});

test("Windows resolver rejects a native binary without an explicit SDK Host", () => {
  assert.throws(
    () => resolvePiChatSpawnCommand(String.raw`C:\native\starling.exe`, ["chat", "pi"], {
      platform: "win32",
      env: {},
      cwd: String.raw`C:\workspace`,
      fileExists: (file) => file.toLowerCase() === String.raw`C:\native\starling.exe`.toLowerCase(),
    }),
    /needs STARLING_PI_SDK_HOST and STARLING_PI_SDK_NODE/,
  );
});

test("Windows resolver maps an npm starling.cmd to same-tree starling.js and a real node.exe", () => {
  const files = new Set([
    String.raw`C:\npm\starling.cmd`.toLowerCase(),
    String.raw`C:\npm\node_modules\starling-ai\bin\starling.js`.toLowerCase(),
    String.raw`C:\node\node.exe`.toLowerCase(),
  ]);
  const unsafe = String.raw`C:\work & echo PWNED`;
  const result = resolvePiChatSpawnCommand("starling", ["chat", "--cwd", unsafe, "pi"], {
    platform: "win32",
    env: { Path: String.raw`C:\npm;C:\node` },
    cwd: String.raw`C:\workspace`,
    fileExists: (file) => files.has(file.toLowerCase()),
  });
  assert.deepEqual(result, {
    file: String.raw`C:\node\node.exe`,
    args: [
      String.raw`C:\npm\node_modules\starling-ai\bin\starling.js`,
      "chat", "--cwd", unsafe, "pi",
    ],
  });
});

test("Windows resolver supports local node_modules .bin layout", () => {
  const files = new Set([
    String.raw`C:\repo\node_modules\.bin\starling.cmd`.toLowerCase(),
    String.raw`C:\repo\node_modules\starling-ai\bin\starling.js`.toLowerCase(),
    String.raw`C:\repo\node_modules\.bin\node.exe`.toLowerCase(),
  ]);
  const result = resolvePiChatSpawnCommand(String.raw`C:\repo\node_modules\.bin\starling.cmd`, [], {
    platform: "win32",
    env: { Path: "" },
    cwd: String.raw`C:\repo`,
    fileExists: (file) => files.has(file.toLowerCase()),
  });
  assert.deepEqual(result, {
    file: String.raw`C:\repo\node_modules\.bin\node.exe`,
    args: [String.raw`C:\repo\node_modules\starling-ai\bin\starling.js`],
  });
});

test("Windows resolver fails closed instead of treating VS Code Electron as Node", () => {
  const files = new Set([
    String.raw`C:\npm\starling.cmd`.toLowerCase(),
    String.raw`C:\npm\node_modules\starling-ai\bin\starling.js`.toLowerCase(),
    String.raw`C:\VSCode\Code.exe`.toLowerCase(),
  ]);
  assert.throws(
    () => resolvePiChatSpawnCommand("starling", [], {
      platform: "win32",
      env: { Path: String.raw`C:\npm` },
      cwd: String.raw`C:\workspace`,
      fileExists: (file) => files.has(file.toLowerCase()),
    }),
    (error) => error instanceof PiChatCliPathError
      && /node\.exe was not found/.test(error.message)
      && /starling\.cliPath/.test(error.message),
  );
});

test("Pi messages normalize text, thinking, tool calls, and tool results", () => {
  assert.deepEqual(normalizePiMessages([
    { role: "user", content: [{ type: "text", text: "hello" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reason" },
        { type: "text", text: "answer" },
        { type: "toolCall", name: "read", arguments: { path: "/tmp/a" } },
      ],
    },
    { role: "toolResult", toolName: "read", content: [{ type: "text", text: "done" }], isError: false },
  ]), [
    { role: "user", text: "hello" },
    { role: "assistant", text: "answer", thinking: "reason" },
    { role: "tool", toolName: "read", text: '{\n  "path": "/tmp/a"\n}' },
    { role: "tool", toolName: "read", text: "done", isError: false },
  ]);
});

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 4242;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.stdin.on("finish", () => {
      this.exitCode = 0;
      queueMicrotask(() => this.emit("close", 0, null));
    });
  }

  kill(signal) {
    this.killed = true;
    this.signalCode = signal;
    queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }
}

test("PiChatSession correlates out-of-order responses and hydrates after start", async () => {
  const child = new FakeChild();
  const commands = [];
  let input = "";
  child.stdin.on("data", (chunk) => {
    input += chunk.toString("utf8");
    while (input.includes("\n")) {
      const newline = input.indexOf("\n");
      const command = JSON.parse(input.slice(0, newline));
      input = input.slice(newline + 1);
      commands.push(command);
      const state = commands.find((item) => item.type === "get_state");
      const messages = commands.find((item) => item.type === "get_messages");
      if (state && messages && !commands.responsesSent) {
        commands.responsesSent = true;
        // Startup hydration can wait on a project-trust UI response, so it
        // must outlive the ordinary query deadline.
        setTimeout(() => {
          child.stdout.write(JSON.stringify({
            id: messages.id,
            type: "response",
            command: "get_messages",
            success: true,
            data: { messages: [{ role: "user", content: "history" }] },
          }) + "\n");
          child.stdout.write(JSON.stringify({
            id: state.id,
            type: "response",
            command: "get_state",
            success: true,
            data: { sessionId: "session-1", thinkingLevel: "medium" },
          }) + "\n");
        }, 20);
      }
      if (command.type === "prompt") {
        setTimeout(() => {
          child.stdout.write(JSON.stringify({
            id: command.id,
            type: "response",
            command: "prompt",
            success: true,
          }) + "\n");
        }, 20);
      }
    }
  });

  let spawnCall;
  const session = new PiChatSession({
    executable: "/fake/starling",
    spawnProcess(file, args, options) {
      spawnCall = { file, args: [...args], options };
      return child;
    },
    requestTimeoutMs: 5,
    stopTimeoutMs: 100,
  });

  const starting = session.start({ cwd: "/work", setting: "profile" });
  await assert.rejects(() => session.send("too early"), /still starting/);
  const started = await starting;
  assert.equal(started.state.sessionId, "session-1");
  assert.deepEqual(started.messages, [{ role: "user", text: "history" }]);
  assert.deepEqual(spawnCall.args, ["chat", "--cwd", "/work", "--setting", "profile", "pi"]);
  assert.equal(spawnCall.options.shell, false);
  assert.equal(new Set(commands.filter((item) => item.id).map((item) => item.id)).size, 2);

  await session.send("next", "followUp");
  const prompt = commands.find((item) => item.type === "prompt");
  assert.equal(prompt.message, "next");
  assert.equal(prompt.streamingBehavior, "followUp");
  await session.stop();
  assert.equal(child.killed, false, "EOF should stop a cooperative child without killing it");
});

test("PiChatSession does not become ready when the process exits during hydration", async () => {
  const child = new FakeChild();
  let input = "";
  const commands = [];
  child.stdin.on("data", (chunk) => {
    input += chunk.toString("utf8");
    while (input.includes("\n")) {
      const newline = input.indexOf("\n");
      const command = JSON.parse(input.slice(0, newline));
      input = input.slice(newline + 1);
      commands.push(command);
      const state = commands.find((item) => item.type === "get_state");
      const messages = commands.find((item) => item.type === "get_messages");
      if (state && messages && !commands.responsesSent) {
        commands.responsesSent = true;
        child.stdout.write(JSON.stringify({
          id: state.id, type: "response", command: "get_state", success: true, data: {},
        }) + "\n");
        child.stdout.write(JSON.stringify({
          id: messages.id, type: "response", command: "get_messages", success: true, data: { messages: [] },
        }) + "\n");
        child.exitCode = 0;
        child.emit("close", 0, null);
      }
    }
  });

  let readyEvents = 0;
  const session = new PiChatSession({
    executable: "/fake/starling",
    spawnProcess: () => child,
    requestTimeoutMs: 500,
    stopTimeoutMs: 10,
  });
  session.events.on((event) => {
    if (event.type === "ready") readyEvents += 1;
  });
  await assert.rejects(() => session.start({ cwd: "/work" }), /exited during startup/);
  assert.equal(readyEvents, 0);
  await assert.rejects(() => session.send("stale"), /still starting/);
});

test("Windows process-tree fallback invokes taskkill without a shell", async () => {
  let invocation;
  const utility = new EventEmitter();
  const stopping = terminateWindowsProcessTree(4242, (file, args, options) => {
    invocation = { file, args: [...args], options };
    queueMicrotask(() => utility.emit("close", 0, null));
    return utility;
  });
  await stopping;
  assert.deepEqual(invocation.args, ["/PID", "4242", "/T", "/F"]);
  assert.equal(invocation.file, "taskkill.exe");
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.stdio, "ignore");
});

test("PiChatSession uses the Windows process-tree fallback after EOF times out", async () => {
  const child = new FakeChild();
  child.stdin.removeAllListeners("finish");
  let input = "";
  const commands = [];
  child.stdin.on("data", (chunk) => {
    input += chunk.toString("utf8");
    while (input.includes("\n")) {
      const newline = input.indexOf("\n");
      const command = JSON.parse(input.slice(0, newline));
      input = input.slice(newline + 1);
      commands.push(command);
      if (command.type === "get_state" || command.type === "get_messages") {
        child.stdout.write(JSON.stringify({
          id: command.id,
          type: "response",
          command: command.type,
          success: true,
          data: command.type === "get_messages" ? { messages: [] } : {},
        }) + "\n");
      }
    }
  });

  let mainSpawn;
  let taskkillSpawn;
  const session = new PiChatSession({
    executable: String.raw`C:\native\starling.exe`,
    env: {
      STARLING_PI_SDK_HOST: String.raw`C:\sdk\host.js`,
      STARLING_PI_SDK_NODE: String.raw`C:\node\node.exe`,
    },
    platform: "win32",
    fileExists: (file) => file.toLowerCase() === String.raw`C:\native\starling.exe`.toLowerCase(),
    spawnProcess(file, args, options) {
      mainSpawn = { file, args: [...args], options };
      return child;
    },
    spawnUtilityProcess(file, args, options) {
      taskkillSpawn = { file, args: [...args], options };
      const utility = new EventEmitter();
      queueMicrotask(() => {
        child.exitCode = 1;
        child.emit("close", 1, null);
        utility.emit("close", 0, null);
      });
      return utility;
    },
    requestTimeoutMs: 500,
    stopTimeoutMs: 1,
  });

  await session.start({ cwd: String.raw`C:\work & research` });
  await session.stop();
  assert.equal(mainSpawn.options.shell, false);
  assert.deepEqual(mainSpawn.args, ["chat", "--cwd", String.raw`C:\work & research`, "pi"]);
  assert.deepEqual(taskkillSpawn, {
    file: "taskkill.exe",
    args: ["/PID", "4242", "/T", "/F"],
    options: { windowsHide: true, shell: false, stdio: "ignore" },
  });
});

test("PiChatSession lets the Starling supervisor finish Pi cleanup after SIGTERM", async () => {
  assert.ok(STARLING_CHAT_TERM_GRACE_MS > 2_000);

  const child = new FakeChild();
  child.stdin.removeAllListeners("finish");
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    child.killed = true;
    if (signal === "SIGTERM") {
      setTimeout(() => {
        child.signalCode = "SIGTERM";
        child.emit("close", null, "SIGTERM");
      }, 600);
    } else {
      child.signalCode = signal;
      queueMicrotask(() => child.emit("close", null, signal));
    }
    return true;
  };

  let input = "";
  child.stdin.on("data", (chunk) => {
    input += chunk.toString("utf8");
    while (input.includes("\n")) {
      const newline = input.indexOf("\n");
      const command = JSON.parse(input.slice(0, newline));
      input = input.slice(newline + 1);
      if (command.type === "get_state" || command.type === "get_messages") {
        child.stdout.write(JSON.stringify({
          id: command.id,
          type: "response",
          command: command.type,
          success: true,
          data: command.type === "get_messages" ? { messages: [] } : {},
        }) + "\n");
      }
    }
  });

  const session = new PiChatSession({
    executable: "/fake/starling",
    spawnProcess: () => child,
    requestTimeoutMs: 500,
    stopTimeoutMs: 1,
  });

  await session.start({ cwd: "/work" });
  await session.stop();
  assert.deepEqual(signals, ["SIGTERM"], "the extension must not preempt supervisor cleanup with SIGKILL");
});
