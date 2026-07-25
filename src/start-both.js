import { spawn } from "node:child_process";
import process from "node:process";

function startProcess(label, scriptPath, extraEnv = {}) {
  const child = spawn(process.execPath, [scriptPath], {
    stdio: "inherit",
    env: {
      ...process.env,
      ...extraEnv
    }
  });

  return { label, child };
}

const children = [
  startProcess("stdio", "src/index.js", { MCP_TRANSPORT_MODE: "stdio" }),
  startProcess("http", "src/http/index.js", { MCP_TRANSPORT_MODE: "http" })
];

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  for (const { child } of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

for (const { label, child } of children) {
  child.on("exit", (code, signal) => {
    if (!shuttingDown && (code !== 0 || signal)) {
      console.error(`${label} process exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "none"})`);
      shutdown("SIGTERM");
      process.exit(code ?? 1);
      return;
    }

    const allExited = children.every(({ child: candidate }) => candidate.exitCode !== null || candidate.killed);
    if (allExited) {
      process.exit(0);
    }
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
