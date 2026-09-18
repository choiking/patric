import { test, expect } from 'bun:test';
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

test('desktop formats streamed and saved Markdown while keeping user input and HTML inert', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1220, height: 840 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      let listener: any;
      (window as any).patric = {
        initial: async () => ({ mode: 'chat', workspace: null, projects: [] }),
        settings: async () => ({ model: 'test-model', provider: 'openai' }),
        onEvent: (callback: any) => { listener = callback; },
        chat: (_messages: any, _mode: string, conversationId: string) => new Promise(resolve => {
          (window as any).chunk = (data: string) => listener({ event: 'chunk', data, conversationId });
          (window as any).finish = () => resolve({ ok: true, content: '' });
        })
      };
    });
    await page.goto(pathToFileURL(path.join(import.meta.dir, 'index.html')).href);
    await page.locator('#model-label').filter({ hasText: 'test-model' }).waitFor();
    await page.locator('#prompt').fill('**literal user text**');
    await page.locator('#send').click();
    await page.waitForFunction(() => Boolean((window as any).chunk));
    const first = '不是常数空间。\n\n- **时间复杂度：** `O(m × n)`\n- **额外空间复杂度：** `O(m + n)`\n\n```java\nclass Solution {\n    int m = matrix.length;\n';
    await page.evaluate(text => (window as any).chunk(text), first);
    expect(await page.locator('.assistant strong').count()).toBe(2);
    expect(await page.locator('.assistant pre code').textContent()).toContain('    int m');
    expect(await page.locator('.user strong').count()).toBe(0);
    const rest = '}\n```\n\n| Space | Time |\n| --- | --- |\n| O(1) | O(m × n) |\n\n<script>window.compromised = true</script>\n\n[unsafe](javascript:alert%281%29)\n\n![image](https://example.com/tracker.png)';
    await page.evaluate(text => (window as any).chunk(text), rest);
    await page.evaluate(() => (window as any).finish());
    await page.waitForFunction(() => !(document.getElementById('send') as HTMLElement).hidden);
    expect(await page.locator('.assistant table td').count()).toBe(2);
    expect(await page.locator('.assistant script, .assistant img, .assistant [onclick], .assistant a[href^="javascript:"]').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).compromised)).toBeUndefined();
    expect(await page.locator('.assistant pre').evaluate(el => getComputedStyle(el).whiteSpace)).toBe('pre');
    await page.reload();
    await page.locator('.conversation').click();
    expect(await page.locator('.assistant pre code').textContent()).toBe('class Solution {\n    int m = matrix.length;\n}\n');
    expect(await page.locator('.assistant strong').count()).toBe(2);
    await page.screenshot({ path: '/tmp/patric-markdown-desktop.png' });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 20000);

test('project context action starts a fresh chat in the selected folder', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const projects = ['/projects/first', '/projects/second'];
      let workspace = projects[0];
      localStorage.setItem('patric.conversations', JSON.stringify([
        { id: 'old', title: 'Existing chat', mode: 'code', workspace, messages: [{ role: 'user', content: 'Old question' }] }
      ]));
      (window as any).menuAction = 'new-chat';
      (window as any).patric = {
        initial: async () => ({ mode: 'code', workspace, projects }),
        settings: async () => ({ model: 'test-model', provider: 'openai' }),
        onEvent: () => {},
        projectMenu: async (project: string) => {
          (window as any).menuProject = project;
          return (window as any).menuAction;
        },
        selectProject: async (project: string) => {
          workspace = project;
          return { workspace, projects };
        },
        chat: async () => ({ ok: true, content: 'New response' })
      };
    });
    await page.goto(pathToFileURL(path.join(import.meta.dir, 'index.html')).href);
    await page.getByRole('button', { name: 'Existing chat', exact: true }).click();
    await page.locator('.project-open').first().click({ button: 'right' });
    await page.waitForFunction(() => !document.getElementById('welcome')!.hidden);
    expect(await page.locator('#messages .message').count()).toBe(0);
    expect(await page.locator('#prompt').evaluate(el => el === document.activeElement)).toBe(true);
    await page.getByRole('button', { name: 'Existing chat', exact: true }).click();
    await page.evaluate(() => { (window as any).menuAction = null; });
    await page.locator('.project-open').last().click({ button: 'right' });
    expect(await page.locator('#header-project').textContent()).toBe('first');
    expect(await page.locator('#messages').textContent()).toContain('Old question');
    await page.evaluate(() => { (window as any).menuAction = 'new-chat'; });
    await page.getByRole('button', { name: 'Options for second', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('header-project')!.textContent === 'second');
    expect(await page.locator('#messages .message').count()).toBe(0);
    await page.locator('#prompt').fill('New project question');
    await page.locator('#send').click();
    await page.waitForFunction(() => !document.getElementById('send')!.hidden);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('patric.conversations')!));
    expect(saved[0].workspace).toBe('/projects/second');
    expect(saved[0].mode).toBe('code');
    expect(saved[1].messages).toEqual([{ role: 'user', content: 'Old question' }]);
  } finally { await browser.close(); }
}, 20000);

test('generation locks only its chat and routes background replies and stop independently', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const runs: Record<string, any> = {};
      let listener: any;
      (window as any).runs = runs;
      (window as any).emit = (conversationId: string, event: string, data: any) => listener({ conversationId, event, data });
      (window as any).patric = {
        initial: async () => ({ mode: 'chat', workspace: null, projects: [] }),
        settings: async () => ({ model: 'test-model', provider: 'openai' }),
        setMode: async (mode: string) => mode,
        onEvent: (callback: any) => { listener = callback; },
        chat: (_messages: any, _mode: string, id: string) => new Promise(resolve => { runs[id] = resolve; }),
        stop: (id: string) => { (window as any).stopped = id; },
        permission: (id: string, decision: string, conversationId: string) => { (window as any).approval = { id, decision, conversationId }; }
      };
    });
    await page.goto(pathToFileURL(path.join(import.meta.dir, 'index.html')).href);
    await page.locator('#model-label').filter({ hasText: 'test-model' }).waitFor();
    await page.locator('#prompt').fill('First question');
    await page.locator('#send').click();
    await page.waitForFunction(() => Object.keys((window as any).runs).length === 1);
    const first = await page.evaluate(() => Object.keys((window as any).runs)[0]);
    expect(await page.locator('#prompt').isDisabled()).toBe(true);
    await page.locator('#settings-button').click();
    expect(await page.locator('#settings-dialog').isVisible()).toBe(true);
    await page.locator('#close-settings').click();
    await page.locator('#mode-code').click();
    expect(await page.locator('#workspace-gate').isVisible()).toBe(true);
    await page.locator('#mode-chat').click();
    await page.locator('#new-chat').click();
    expect(await page.locator('#prompt').isEnabled()).toBe(true);
    await page.locator('#prompt').fill('Second question');
    await page.locator('#send').click();
    await page.waitForFunction(() => Object.keys((window as any).runs).length === 2);
    const second = await page.evaluate(() => Object.keys((window as any).runs)[1]);
    await page.evaluate(id => {
      (window as any).emit(id, 'chunk', 'First answer');
      (window as any).emit(id, 'permission', { id: 'approval-1', summary: 'Write file', arguments: {}, toolName: 'write_file' });
    }, first);
    expect(await page.locator('#messages').textContent()).not.toContain('First answer');
    expect(await page.locator('#permission').isVisible()).toBe(false);
    await page.getByRole('button', { name: 'First question', exact: true }).click();
    expect(await page.locator('#messages').textContent()).toContain('First answer');
    expect(await page.locator('#permission').isVisible()).toBe(true);
    await page.locator('#allow').click();
    expect(await page.evaluate(() => (window as any).approval)).toEqual({ id: 'approval-1', decision: 'allow-once', conversationId: first });
    await page.getByRole('button', { name: 'Second question', exact: true }).click();
    await page.locator('#stop').click();
    expect(await page.evaluate(() => (window as any).stopped)).toBe(second);
    await page.evaluate(id => (window as any).runs[id]({ ok: true, content: '', stopped: true }), second);
    await page.waitForFunction(() => !(document.getElementById('prompt') as HTMLTextAreaElement).disabled);
    await page.locator('#prompt').fill('Keep this draft');
    await page.evaluate(id => (window as any).runs[id]({ ok: true, content: 'First answer' }), first);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('patric.conversations')!).find((c: any) => c.title === 'First question').messages.length === 2);
    expect(await page.locator('#prompt').inputValue()).toBe('Keep this draft');
    expect(await page.locator('#messages').textContent()).not.toContain('First answer');
    await page.getByRole('button', { name: 'First question', exact: true }).click();
    expect((await page.locator('.assistant').textContent())?.trim()).toBe('First answer');
    expect(await page.locator('#prompt').isEnabled()).toBe(true);
  } finally { await browser.close(); }
}, 20000);
