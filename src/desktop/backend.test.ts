import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function fixture(run: (client: any, directory: string) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "patric-desktop-test-"));
  const requests: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as any;
    requests.push(body);
    if (body.messages.some((m: any) => m.role === "user" && m.content === "Compare interfaces")) {
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Same engine." } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    const toolResult = body.messages.find((m: any) => m.role === "tool");
    const delta = toolResult ? { content: "Finished safely." } : { tool_calls: [{ index: 0, id: "write-1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "approved.txt", content: "approved" }) } }] };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const env = { ...process.env, HOME: directory, PATRIC_PROVIDER: "openai", PATRIC_MODEL: "test-model", PATRIC_API_KEY: "test-secret", PATRIC_OAUTH_TOKEN: "", PATRIC_BASE_URL: `http://127.0.0.1:${server.port}/v1` };
  const backlog: any[] = [];
  const listeners = new Set<() => void>();
  function startChild() {
    const backend = spawn(process.execPath, [path.join(import.meta.dir, "backend.ts")], {
      env, stdio: ["pipe", "pipe", "pipe"]
    });
    createInterface({ input: backend.stdout }).on("line", line => {
      backlog.push(JSON.parse(line));
      for (const listener of listeners) listener();
    });
    return backend;
  }
  let child = startChild();
  async function stopChild() {
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill();
    await exited;
  }
  const client = {
    requests,
    restart: async () => {
      await stopChild();
      backlog.length = 0;
      child = startChild();
    },
    runCli: async (prompt: string) => {
      const cli = Bun.spawn([process.execPath, path.join(import.meta.dir, "../cli/cli.ts"), "chat", prompt], { cwd: directory, env, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([cli.exited, new Response(cli.stdout).text(), new Response(cli.stderr).text()]);
      if (code !== 0) throw new Error(stderr || stdout);
      return stdout;
    },
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
  finally { await stopChild(); server.stop(true); fs.rmSync(directory, { recursive: true, force: true }); }
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
      expect(fs.existsSync(path.join(directory, ".config", "patric", "config.json"))).toBe(false);
    });
  });
}


test("CLI and desktop send identical model requests with project instructions", async () => {
  await fixture(async (client, directory) => {
    fs.writeFileSync(path.join(directory, "PATRIC.md"), "Shared project instruction: prefer small changes.");
    const cliReply = await client.runCli("Compare interfaces");
    client.send({ id: "parity", method: "chat", data: { cwd: directory, messages: [{ role: "user", content: "Compare interfaces" }] } });
    const desktopReply = await client.wait((m: any) => m.id === "parity");
    expect(desktopReply.result.ok).toBe(true);
    expect(cliReply.trim()).toBe(desktopReply.result.content);
    expect(client.requests).toHaveLength(2);
    expect(client.requests[0]).toEqual(client.requests[1]);
    const system = client.requests[0].messages.filter((m: any) => m.role === "system");
    expect(system.map((m: any) => m.content).join("\n").split("Shared project instruction:")).toHaveLength(2);
  });
});


test("Always allow persists only the approved tool and works after backend restart", async () => {
  await fixture(async (client, directory) => {
    const configDir = path.join(directory, ".config", "patric");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ allowedTools: ["edit_file"], systemPrompt: "Keep this setting." }));
    const data = { cwd: directory, messages: [{ role: "user", content: "Write a file." }] };
    client.send({ id: "first", method: "chat", data });
    const permission = await client.wait((m: any) => m.event === "permission");
    client.send({ method: "permission", data: { id: "not-a-pending-request", decision: "allow-always", toolName: "bash" } });
    client.send({ method: "permission", data: { id: permission.data.id, decision: "allow-always", toolName: "bash" } });
    expect((await client.wait((m: any) => m.id === "first")).result.ok).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(config.allowedTools).toEqual(["edit_file", "write_file"]);
    expect(config.systemPrompt).toBe("Keep this setting.");
    expect(fs.readFileSync(path.join(directory, "approved.txt"), "utf8")).toBe("approved");
    fs.unlinkSync(path.join(directory, "approved.txt"));
    await client.restart();
    client.send({ id: "second", method: "chat", data });
    const next = await client.wait((m: any) => m.id === "second" || m.event === "permission");
    expect(next.id).toBe("second");
    expect(next.result.ok).toBe(true);
    expect(fs.existsSync(path.join(directory, "approved.txt"))).toBe(true);
  });
});

test("Always allow denies the action if its preference cannot be saved", async () => {
  await fixture(async (client, directory) => {
    client.send({ id: "chat", method: "chat", data: { cwd: directory, messages: [{ role: "user", content: "Write a file." }] } });
    const permission = await client.wait((m: any) => m.event === "permission");
    fs.writeFileSync(path.join(directory, ".config"), "Block creating the config directory");
    client.send({ method: "permission", data: { id: permission.data.id, decision: "allow-always" } });
    expect((await client.wait((m: any) => m.event === "error")).data).toContain("Could not save");
    await client.wait((m: any) => m.id === "chat");
    expect(fs.existsSync(path.join(directory, "approved.txt"))).toBe(false);
  });
});

test("chat mode answers without tools, a project, or project instructions", async () => {
  await fixture(async (client, directory) => {
    fs.writeFileSync(path.join(directory, "PATRIC.md"), "Shared project instruction: prefer small changes.");
    client.send({ id: "unbound", method: "chat", data: { mode: "code", messages: [{ role: "user", content: "Write a file." }] } });
    expect((await client.wait((m: any) => m.id === "unbound")).error).toContain("Open a project folder");
    client.send({ id: "plain", method: "chat", data: { mode: "chat", cwd: directory, messages: [{ role: "user", content: "Write a file." }] } });
    const reply = await client.wait((m: any) => m.id === "plain");
    expect(reply.result.ok).toBe(true);
    // The mock provider only offers a tool call, so a tool-free turn must not write the file.
    expect(fs.existsSync(path.join(directory, "approved.txt"))).toBe(false);
    const request = client.requests.at(-1);
    expect(request.tools).toBeUndefined();
    const system = request.messages.filter((m: any) => m.role === "system").map((m: any) => m.content).join("\n");
    expect(system).not.toContain("Shared project instruction:");
    expect(system).not.toContain("MEMORY SYSTEM");
    expect(system).toContain("no tools");
  });
});
