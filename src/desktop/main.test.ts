import { test, expect } from 'bun:test';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

// Exercise the Electron IPC adapter with controllable workers, without a live provider.
test('desktop isolates concurrent workers, project bindings, events, and cancellation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patric-main-test-'));
  const handlers: Record<string, any> = {};
  const signals: Record<string, any> = {};
  const workers: any[] = [];
  const events: any[] = [];
  const app = { whenReady: () => ({ then: () => {} }), on: () => {}, getPath: () => directory };
  const webContents = { mainFrame: { url: new URL('./index.html', import.meta.url).href }, send: (_channel: string, data: any) => events.push(data) };
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  const nativeRequire = createRequire(import.meta.url);
  const context = vm.createContext({
    __dirname: import.meta.dir, process: { env: process.env, resourcesPath: directory, stderr: process.stderr }, console, testWindow: { webContents }, directory,
    require: (name: string) => {
      if (name === 'electron') return { app, ipcMain: { handle: (key: string, fn: any) => { handlers[key] = fn; }, on: (key: string, fn: any) => { signals[key] = fn; } } };
      if (name === 'node:child_process') return { spawn: () => {
        const child: any = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.requests = [];
        child.stdin = new Writable({ write(chunk, _encoding, done) { child.requests.push(JSON.parse(chunk.toString())); done(); } });
        child.kill = () => { child.killed = true; child.emit('exit'); };
        child.reply = (message: any) => child.stdout.write(JSON.stringify(message) + '\n');
        workers.push(child);
        return child;
      } };
      return nativeRequire(name);
    }
  });
  try {
    vm.runInContext(fs.readFileSync(path.join(import.meta.dir, 'main.cjs'), 'utf8'), context);
    vm.runInContext('window = testWindow; workspace = directory; projects = [directory, directory + "/second"]; backend = startBackend(); registerHandlers();', context);
    fs.mkdirSync(path.join(directory, 'second'));
    const request = (method: string, data?: any) => handlers['patric:request'](event, method, data);
    const first = request('chat', { conversationId: 'first', mode: 'code', messages: [] });
    const firstWorker = workers[1];
    expect(firstWorker.requests[0].data.cwd).toBe(directory);
    await expect(request('chat', { conversationId: 'first', mode: 'code', messages: [] })).rejects.toThrow('already running in this chat');
    handlers['patric:selectProject'](event, path.join(directory, 'second'));
    handlers['patric:mode'](event, 'chat');
    const second = request('chat', { conversationId: 'second', mode: 'code', messages: [] });
    const secondWorker = workers[2];
    expect(secondWorker.requests[0].data.cwd).toBe(path.join(directory, 'second'));
    expect(firstWorker.requests[0].data.cwd).toBe(directory);
    const settings = request('settings');
    workers[0].reply({ id: workers[0].requests[0].id, result: { model: 'test-model' } });
    expect(await settings).toEqual({ model: 'test-model' });
    firstWorker.reply({ event: 'chunk', data: 'First answer' });
    secondWorker.reply({ event: 'chunk', data: 'Second answer' });
    expect(events.map(e => [e.conversationId, e.data])).toEqual([['first', 'First answer'], ['second', 'Second answer']]);
    signals['patric:signal'](event, 'stop', { conversationId: 'second' });
    signals['patric:signal'](event, 'permission', { conversationId: 'first', id: 'approval', decision: 'deny' });
    expect(firstWorker.requests.at(-1).method).toBe('permission');
    expect(secondWorker.requests.at(-1).method).toBe('stop');
    secondWorker.reply({ id: secondWorker.requests[0].id, result: { ok: true, stopped: true } });
    expect((await second).stopped).toBe(true);
    expect(secondWorker.killed).toBe(true);
    expect(firstWorker.killed).toBeUndefined();
    firstWorker.reply({ id: firstWorker.requests[0].id, result: { ok: true, content: 'First answer' } });
    expect((await first).content).toBe('First answer');
    expect(firstWorker.killed).toBe(true);
    const retry = request('chat', { conversationId: 'first', mode: 'chat', messages: [] });
    workers[3].emit('error', new Error('Worker crashed'));
    await expect(retry).rejects.toThrow('engine stopped');
    expect(vm.runInContext('runs.size', context)).toBe(0);
  } finally {
    for (const child of workers) { child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
