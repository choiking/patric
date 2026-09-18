const $ = id => document.getElementById(id);
const api = window.patric;
const defaults = { openai: 'https://api.openai.com/v1', 'openai-codex': 'https://chatgpt.com/backend-api', anthropic: 'https://api.anthropic.com', openrouter: 'https://openrouter.ai/api/v1', ollama: 'http://localhost:11434', gemini: 'https://generativelanguage.googleapis.com/v1beta' };
let workspace = null;
let projects = [];
let mode = 'chat';
let config;
const runs = new Map();
let current;
let conversations = [];
try {
  const saved = JSON.parse(localStorage.getItem('patric.conversations') || '[]');
  // Conversations saved before modes existed were all project work.
  if (Array.isArray(saved)) conversations = saved.map(c => c && !c.mode ? { ...c, mode: 'code' } : c).filter(c => typeof c.id === 'string' && typeof c.title === 'string' && ['chat', 'code'].includes(c.mode) && (c.mode === 'chat' ? c.workspace === null : typeof c.workspace === 'string') && Array.isArray(c.messages) && c.messages.every(m => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')).slice(0, 50);
} catch { /* Ignore corrupt local history. */ }
function notice(text = '') { $('notice').textContent = text; $('notice').hidden = !text; }
function persist() {
  try { localStorage.setItem('patric.conversations', JSON.stringify(conversations.slice(0, 50))); }
  catch { notice('Conversation storage is full. This conversation may not be saved.'); }
}
function projectName(target) {
  if (!target) return '';
  return target.split(/[\\/]/).filter(Boolean).pop() || target;
}
function projectParent(target) {
  const parent = target.slice(0, target.length - projectName(target).length).replace(/[\\/]$/, '');
  return parent.replace(/^.*[\\/](?=[^\\/]+$)/, '…/') || parent;
}
function conversationsFor(project) {
  return conversations.filter(c => c.mode === 'code' && c.workspace === project);
}
function conversationButton(conversation) {
  const button = document.createElement('button');
  button.className = `conversation${current?.id === conversation.id ? ' active' : ''}`;
  button.textContent = conversation.title;
  button.title = conversation.title;
  button.onclick = () => { current = conversation; renderMessages(); renderMode(); notice(); };
  return button;
}
function emptyLine(text) {
  const p = document.createElement('p');
  p.className = 'empty-history';
  p.textContent = text;
  return p;
}
/** Each folder is its own project: its own binding and its own conversations,
 *  listed under it so Code mode has no conversation list detached from a folder. */
function renderProjects() {
  $('projects').replaceChildren();
  for (const project of projects) {
    const active = project === workspace;
    const group = document.createElement('div');
    group.className = `project-group${active ? ' active' : ''}`;
    const row = document.createElement('div');
    row.className = 'project';
    const showProjectMenu = async event => {
      event.preventDefault();
      try {
        const action = await api.projectMenu(project);
        if (action === 'remove') { await forgetProject(project); return; }
        if (action !== 'new-chat') return;
        // Bind the chosen folder before clearing the conversation. A failed
        // switch must leave the current chat intact.
        if (project !== workspace) setProjects(await api.selectProject(project));
        fresh();
      } catch (error) { notice(error.message); }
    };
    row.oncontextmenu = showProjectMenu;
    const open = document.createElement('button');
    open.className = 'project-open';
    open.title = project;
    const name = document.createElement('strong');
    name.textContent = projectName(project);
    const parent = document.createElement('small');
    parent.textContent = projectParent(project);
    open.append(name, parent);
    open.onclick = () => selectProject(project);
    const items = conversationsFor(project);
    if (!active && items.length) {
      const count = document.createElement('em');
      count.className = 'project-count';
      count.textContent = String(items.length);
      count.title = `${items.length} conversation${items.length === 1 ? '' : 's'}`;
      open.append(count);
    }
    const more = document.createElement('button');
    more.className = 'project-more';
    more.textContent = '⋯';
    more.title = `Options for ${projectName(project)}`;
    more.setAttribute('aria-label', more.title);
    more.setAttribute('aria-haspopup', 'menu');
    more.onclick = showProjectMenu;
    row.append(open, more);
    group.append(row);
    // Only the open project expands: its conversations are the ones you can resume.
    if (active) {
      const list = document.createElement('nav');
      list.className = 'project-conversations';
      list.setAttribute('aria-label', `Conversations in ${projectName(project)}`);
      list.append(...(items.length ? items.map(conversationButton) : [emptyLine('No conversations yet.')]));
      group.append(list);
    }
    $('projects').append(group);
  }
  if (!projects.length) $('projects').append(emptyLine('Open a folder to start a project.'));
}
function setProjects(state) {
  const changed = state.workspace !== workspace;
  workspace = state.workspace || null;
  projects = Array.isArray(state.projects) ? state.projects : [];
  if (changed) { current = undefined; notice(); }
  renderMode();
  if (changed) renderMessages();
}
const MODES = {
  chat: {
    hint: 'Talk things through. No tools, no project.',
    eyebrow: 'A PLACE TO THINK OUT LOUD',
    subtitle: ['Ask a question, sketch an idea, or talk a problem through.', 'Nothing on your machine is touched.'],
    placeholder: 'What would you like to talk about?',
    status: 'Conversation only',
    noteLeft: 'Conversation only. Your choice of model.',
    noteRight: 'No files are read or changed in Chat mode.'
  },
  code: {
    hint: 'Read, change, and run code in one project.',
    eyebrow: 'YOUR CODING COMPANION',
    subtitle: ['Build something new, untangle a problem, or get to know your code.', 'Patric works inside the project you open.'],
    placeholder: 'What would you like to work on?',
    status: 'Your workspace, connected',
    noteLeft: 'Local tools. Your choice of model.',
    noteRight: 'Patric asks before using tools you haven’t allowed.'
  }
};
/** One place decides what each mode shows, so Chat never implies project access. */
function renderMode() {
  const copy = MODES[mode];
  const bound = mode === 'chat' || Boolean(workspace);
  $('mode-chat').setAttribute('aria-selected', String(mode === 'chat'));
  $('mode-code').setAttribute('aria-selected', String(mode === 'code'));
  $('mode-chat').classList.toggle('active', mode === 'chat');
  $('mode-code').classList.toggle('active', mode === 'code');
  $('mode-hint').textContent = copy.hint;
  $('workspace-section').hidden = mode !== 'code';
  renderProjects();
  $('welcome-eyebrow').textContent = copy.eyebrow;
  $('welcome-title').textContent = mode === 'chat' ? 'What can I help with?' : 'What should we build?';
  $('welcome-subtitle').replaceChildren(copy.subtitle[0], document.createElement('br'), copy.subtitle[1]);
  $('chat-suggestions').hidden = mode !== 'chat';
  $('code-suggestions').hidden = mode !== 'code';
  $('header-mode').textContent = mode === 'chat' ? 'Chat' : 'Code';
  $('header-project').textContent = mode === 'chat' ? 'Conversation' : projectName(workspace) || 'No project';
  $('local-status-text').textContent = copy.status;
  $('composer-note-left').textContent = copy.noteLeft;
  $('composer-note-right').textContent = copy.noteRight;
  $('prompt').placeholder = copy.placeholder;
  $('workspace-gate').hidden = bound;
  $('composer').hidden = !bound;
  renderHistory();
  renderBusy();
}
async function switchMode(next) {
  if (mode === next) return;
  try { mode = await api.setMode(next); }
  catch (error) { notice(error.message); return; }
  current = undefined;
  notice();
  renderMode();
  renderMessages();
  if (mode === 'chat' || workspace) $('prompt').focus();
}
/** Chat has no folders to group by, so it keeps a flat list of its own. */
function renderHistory() {
  const flat = mode === 'chat';
  $('history-label').hidden = !flat;
  $('conversations').hidden = !flat;
  $('conversations').replaceChildren();
  if (!flat) return;
  const items = conversations.filter(c => c.mode === 'chat');
  $('conversations').append(...(items.length ? items.map(conversationButton) : [emptyLine('A fresh space for your next idea.')]));
}
function addMessage(role, content) {
  const article = document.createElement('article');
  article.className = `message ${role}`;
  if (role === 'user') {
    const label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = 'YOU';
    article.append(label);
  }
  const body = document.createElement('div');
  body.className = 'message-content';
  if (role === 'assistant') renderMarkdown(body, content);
  else body.textContent = content;
  article.append(body);
  $('messages').append(article);
  return body;
}
function renderMessages() {
  $('messages').replaceChildren();
  $('welcome').hidden = Boolean(current?.messages.length);
  for (const message of current?.messages || []) addMessage(message.role, message.content);
  const run = runs.get(current?.id);
  if (run) $('messages').append(...run.nodes);
  renderBusy();
  scrollBottom();
}
function scrollBottom() { $('scroll-area').scrollTop = $('scroll-area').scrollHeight; }
function fresh() {
  current = undefined;
  renderMessages();
  // renderMode redraws the project groups too, clearing the active conversation.
  renderMode();
  notice();
  $('prompt').focus();
}
function renderBusy() {
  const run = runs.get(current?.id);
  $('send').hidden = Boolean(run);
  $('stop').hidden = !run;
  $('stop').disabled = Boolean(run?.stopping);
  $('prompt').disabled = Boolean(run);
  $('run-status').textContent = run ? (run.stopping ? 'Stopping…' : 'Working…') : 'Enter to send';
  showPermission();
}
async function send(event) {
  event.preventDefault();
  const prompt = $('prompt').value.trim();
  if (!prompt || runs.has(current?.id)) return;
  if (mode === 'code' && !workspace) { notice('Open a project folder to use Code mode.'); return; }
  if (!config?.model) { await openSettings(); return; }
  notice();
  if (!current) {
    current = { id: crypto.randomUUID(), title: prompt.slice(0, 60), mode, workspace: mode === 'chat' ? null : workspace, messages: [] };
    conversations.unshift(current);
  }
  current.messages.push({ role: 'user', content: prompt });
  $('prompt').value = '';
  renderMessages();
  const conversation = current;
  const responseNode = addMessage('assistant', 'Thinking…');
  const run = { responseNode, text: '', nodes: [responseNode.parentElement], permissions: [], stopping: false };
  runs.set(conversation.id, run);
  renderMode();
  persist();
  try {
    const result = await api.chat(conversation.messages, conversation.mode, conversation.id);
    if (!result.ok) {
      if (current === conversation) notice(result.content);
      renderMarkdown(responseNode, run.text || 'The response could not be completed.');
    } else {
      if (!run.text) run.text = result.content;
      renderMarkdown(responseNode, run.text || (result.stopped ? 'Response stopped.' : 'Done.'));
      if (result.stopped && current === conversation) notice('Response stopped. Commands already started may still be running.');
    }
    if (result.ok && run.text) conversation.messages.push({ role: 'assistant', content: run.text });
  } catch (error) {
    responseNode.textContent = 'Unable to complete this response.';
    if (current === conversation) notice(error.message);
  } finally {
    runs.delete(conversation.id);
    renderBusy();
    persist();
    if (current === conversation) scrollBottom();
  }
}
function showPermission() {
  const queue = runs.get(current?.id)?.permissions || [];
  $('permission').hidden = queue.length === 0;
  if (queue.length) {
    $('permission-detail').textContent = queue[0].summary + '\n' + JSON.stringify(queue[0].arguments, null, 2);
    $('permission-scope').textContent = `Always allow remembers all ${queue[0].toolName} actions across projects in both desktop and CLI.`;
  }
}
function decide(decision) {
  const request = runs.get(current?.id)?.permissions.shift();
  if (request) api.permission(request.id, decision, current.id);
  showPermission();
}
api.onEvent(({ event, data, conversationId }) => {
  const run = runs.get(conversationId);
  const visible = current?.id === conversationId;
  if (!run) return;
  if (event === 'chunk') {
    const nearBottom = $('scroll-area').scrollHeight - $('scroll-area').scrollTop - $('scroll-area').clientHeight < 120;
    run.text += data;
    renderMarkdown(run.responseNode, run.text);
    if (visible && nearBottom) scrollBottom();
  } else if (event === 'permission') { run.permissions.push(data); showPermission(); }
  else if (event === 'tool' && ['tool_start', 'tool_end', 'agent_status'].includes(data.type)) {
    const detail = document.createElement('details');
    detail.className = 'tool';
    const summary = document.createElement('summary');
    summary.textContent = `${data.type === 'tool_end' ? '✓' : '↳'} ${data.name}`;
    const body = document.createElement('pre');
    body.textContent = data.result || data.detail || JSON.stringify(data.arguments, null, 2);
    detail.append(summary, body);
    run.nodes.push(detail);
    if (visible) { $('messages').append(detail); scrollBottom(); }
  } else if (event === 'error' && visible) notice(data);
});
async function openSettings() {
  try {
    config = await api.settings();
    $('provider').value = config.provider;
    $('model').value = config.model;
    $('base-url').value = config.baseUrl;
    $('api-key').value = '';
    $('settings-error').textContent = '';
    $('settings-dialog').showModal();
  } catch (error) { notice(error.message); }
}
function updateModel() { $('model-label').textContent = config.model || 'Configure a model'; }
$('settings-form').onsubmit = async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    config = await api.saveSettings({ provider: $('provider').value, model: $('model').value, baseUrl: $('base-url').value, apiKey: $('api-key').value });
    updateModel();
    $('api-key').value = '';
    $('settings-dialog').close();
    notice();
  } catch (error) { $('settings-error').textContent = error.message; }
  finally { button.disabled = false; }
};
$('provider').onchange = () => { $('base-url').value = defaults[$('provider').value]; $('model').value = ''; $('api-key').value = ''; $('model-options').replaceChildren(); };
$('refresh-models').onclick = async () => {
  if ($('provider').value !== config.provider || $('base-url').value !== config.baseUrl) {
    $('settings-error').textContent = 'Save your provider settings, then reopen Settings to discover its models.';
    return;
  }
  $('refresh-models').disabled = true;
  $('settings-error').textContent = 'Fetching available models…';
  try {
    const models = await api.models();
    $('model-options').replaceChildren(...models.map(model => { const option = document.createElement('option'); option.value = model; return option; }));
    $('settings-error').textContent = `${models.length} models available. Type in the Model field to choose one.`;
  } catch (error) { $('settings-error').textContent = error.message; }
  finally { $('refresh-models').disabled = false; }
};
async function chooseWorkspace() {
  try { setProjects(await api.chooseWorkspace()); }
  catch (error) { notice(error.message); }
}
async function selectProject(project) {
  if (project === workspace) return;
  try { setProjects(await api.selectProject(project)); }
  catch (error) { notice(error.message); }
}
async function forgetProject(project) {
  try { setProjects(await api.forgetProject(project)); }
  catch (error) { notice(error.message); }
}
$('workspace').onclick = chooseWorkspace;
$('gate-open').onclick = chooseWorkspace;
$('mode-chat').onclick = () => switchMode('chat');
$('mode-code').onclick = () => switchMode('code');
$('new-chat').onclick = fresh;
$('settings-button').onclick = openSettings;
$('model-button').onclick = openSettings;
$('close-settings').onclick = () => $('settings-dialog').close();
$('composer').onsubmit = send;
$('stop').onclick = () => {
  const run = runs.get(current?.id);
  if (!run) return;
  api.stop(current.id);
  run.stopping = true;
  run.permissions = [];
  renderBusy();
};
$('allow').onclick = () => decide('allow-once');
$('allow-always').onclick = () => decide('allow-always');
$('deny').onclick = () => decide('deny');
$('prompt').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); } };
document.querySelectorAll('[data-prompt]').forEach(button => { button.onclick = () => { $('prompt').value = button.dataset.prompt; $('prompt').focus(); }; });
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && !$('settings-dialog').open) {
    if (event.key === 'n') { event.preventDefault(); fresh(); }
    if (event.key === ',') { event.preventDefault(); openSettings(); }
    if (event.key === '1') { event.preventDefault(); void switchMode('chat'); }
    if (event.key === '2') { event.preventDefault(); void switchMode('code'); }
  }
});
async function initialize() {
  try {
    const [initial, settings] = await Promise.all([api.initial(), api.settings()]);
    config = settings;
    mode = initial.mode === 'code' ? 'code' : 'chat';
    setProjects(initial);
    updateModel();
    renderMessages();
  } catch (error) { notice(error.message); }
}
void initialize();
