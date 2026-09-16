import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function fixture(run: (client: any, directory: string) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "patric-desktop-test-"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as any;
    const toolResult = body.messages.find((m: any) => m.role === "tool");
    const delta = toolResult ? { content: "Finished safely." } : { tool_calls: [{ index: 0, id: "write-1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "approved.txt", content: "approved" }) } }] };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const child = spawn(process.execPath, [path.join(import.meta.dir, "desktop-backend.ts")], {
    env: { ...process.env, HOME: directory, PATRIC_PROVIDER: "openai", PATRIC_MODEL: "test-model", PATRIC_API_KEY: "test-secret", PATRIC_OAUTH_TOKEN: "", PATRIC_BASE_URL: `http://127.0.0.1:${server.port}/v1` },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const backlog: any[] = [];
  const listeners = new Set<() => void>();
  createInterface({ input: child.stdout }).on("line", line => {
    backlog.push(JSON.parse(line));
    for (const listener of listeners) listener();
  });
  const client = {
    send: (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n"),
    wait: (predicate: (value: any) => boolean) => new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(check); reject(new Error("Backend response timed out")); }, 5000);
      function check() {
        const index = backlog.findIndex(predicate);
        if (index < 0) return;
        clearTimeout(timer);
        listeners.delete(check);
        resolve(backlog.splice(index, 1)[0]);
      }
      listeners.add(check);
      check();
    })
  };
  try { await run(client, directory); }
  finally { child.kill(); server.stop(true); await new Promise(resolve => child.once("exit", resolve)); fs.rmSync(directory, { recursive: true, force: true }); }
}

test("desktop settings exclude credentials and malformed conversations are rejected", async () => {
  await fixture(async client => {
    client.send({ id: "settings", method: "settings" });
    const reply = await client.wait((m: any) => m.id === "settings");
    expect(reply.result.model).toBe("test-model");
    expect(JSON.stringify(reply)).not.toContain("test-secret");
    client.send({ id: "invalid", method: "chat", data: { messages: [{ role: "system", content: "untrusted" }] } });
    expect((await client.wait((m: any) => m.id === "invalid")).error).toBe("Invalid conversation.");
  });
});

for (const decision of ["deny", "allow-once", "stop"]) {
  test(`desktop ${decision} gates an actual write tool`, async () => {
    await fixture(async (client, directory) => {
      client.send({ id: "chat", method: "chat", data: { cwd: directory, messages: [{ role: "user", content: "Write a file." }] } });
      const permission = await client.wait((m: any) => m.event === "permission");
      expect(fs.existsSync(path.join(directory, "approved.txt"))).toBe(false);
      client.send({ id: "overlap", method: "chat", data: {} });
      expect((await client.wait((m: any) => m.id === "overlap")).error).toContain("current response");
      if (decision === "stop") client.send({ method: "stop" });
      else client.send({ method: "permission", data: { id: permission.data.id, decision } });
      const result = await client.wait((m: any) => m.id === "chat");
      expect(result.result.stopped).toBe(decision === "stop");
      expect(fs.existsSync(path.join(directory, "approved.txt"))).toBe(decision === "allow-once");
      if (decision !== "stop") expect(result.result.content).toContain("Finished safely.");
    });
  });
}
