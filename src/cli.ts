#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import { CliIO, run } from "./cli/run.js";

// Give up on stdin that is open but silent (a pipe nobody writes to), instead of hanging.
const STDIN_IDLE_TIMEOUT_MS = 5_000;
const MAX_SECRET_BYTES = 4096;

/** Read piped stdin up to maxBytes + 1 bytes. Null when stdin is a terminal or nothing arrives. */
function readStdin(maxBytes: number): Promise<string | null> {
  const stdin = process.stdin;
  if (stdin.isTTY) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let timer: NodeJS.Timeout | undefined;

    const finish = (value: string | null) => {
      if (timer) clearTimeout(timer);
      stdin.removeAllListeners("data");
      stdin.removeAllListeners("end");
      stdin.removeAllListeners("error");
      stdin.pause();
      stdin.destroy();
      resolve(value);
    };
    const armIdleTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(
        () => finish(size === 0 ? null : Buffer.concat(chunks).toString("utf8")),
        STDIN_IDLE_TIMEOUT_MS,
      );
    };

    stdin.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      // One byte past the limit is enough for the caller to report "too big".
      if (size > maxBytes) {
        finish(Buffer.concat(chunks).subarray(0, maxBytes + 1).toString("utf8"));
        return;
      }
      armIdleTimer();
    });
    stdin.on("end", () =>
      finish(size === 0 ? null : Buffer.concat(chunks).toString("utf8")),
    );
    stdin.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    armIdleTimer();
  });
}

function readFile(file: string, maxBytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(maxBytes + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** Hidden prompt on a terminal; otherwise the first line of piped stdin. */
async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const piped = await readStdin(MAX_SECRET_BYTES);
    return (piped ?? "").split(/\r?\n/)[0];
  }

  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise((resolve) => {
    let value = "";
    const done = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
    };
    const onData = (input: string) => {
      for (const ch of input) {
        if (ch === "\r" || ch === "\n") {
          done();
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          done();
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (value.length < MAX_SECRET_BYTES) value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

const io: CliIO = {
  cwd: process.cwd(),
  home: os.homedir(),
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  readStdin,
  readFile,
  readSecret,
};

run(process.argv.slice(2), io).then((code) => {
  process.exitCode = code;
});
