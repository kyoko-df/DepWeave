import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export interface FileInfo {
  inode: string;
  device: string;
  size: number;
  allocatedBytes: number;
  privateBytes: number | null;
  cloneId: string | null;
  signature: string;
  mode: number;
  links: number;
  flags: number;
}
export class Engine {
  private child: ChildProcessWithoutNullStreams;
  private pending: Array<{
    resolve: (data: any) => void;
    reject: (e: Error) => void;
  }> = [];
  private failure?: Error;
  constructor() {
    const path =
      process.env.DEPWEAVE_ENGINE ??
      fileURLToPath(
        new URL("../native/target/release/depweave-engine", import.meta.url),
      );
    this.child = spawn(path, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (data) => process.stderr.write(data));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const pending = this.pending.shift();
      if (!pending) return;
      try {
        const reply = JSON.parse(line);
        if (reply.ok) pending.resolve(reply.data);
        else pending.reject(new Error(reply.error));
      } catch (error) {
        pending.reject(error as Error);
      }
    });
    const fail = (error: Error) => {
      this.failure = error;
      for (const p of this.pending.splice(0)) p.reject(error);
    };
    this.child.on("error", fail);
    this.child.stdin.on("error", fail);
    this.child.on("exit", (code, signal) =>
      fail(
        new Error(
          `File engine exited (${signal ?? code}). Run npm run build if it is missing.`,
        ),
      ),
    );
  }
  request<T = any>(message: object): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.child.stdin.write(JSON.stringify(message) + "\n");
    });
  }
  info(path: string): Promise<FileInfo> {
    return this.request({ op: "info", path });
  }
  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.failure) return;
    await new Promise<void>((resolve) => {
      this.child.once("exit", () => resolve());
      this.child.stdin.end();
    });
  }
}
