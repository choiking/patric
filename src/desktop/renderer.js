const $ = id => document.getElementById(id);
const api = window.patric;
const defaults = { openai: 'https://api.openai.com/v1', 'openai-codex': 'https://chatgpt.com/backend-api', anthropic: 'https://api.anthropic.com', openrouter: 'https://openrouter.ai/api/v1', ollama: 'http://localhost:11434', gemini: 'https://generativelanguage.googleapis.com/v1beta' };
let workspace = null;
let mode = 'chat';
let config;
let busy = false;
let current;
let responseNode;
let responseText = '';
let permissionQueue = [];
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
function projectName() {
  if (!workspace) return '';
  return workspace.split(/[\\/]/).filter(Boolean).pop() || workspace;
}
function setWorkspace(value) {
  workspace = value || null;
  $('workspace-name').textContent = workspace ? projectName() : 'Open a project folder';
  $('workspace-detail').textContent = workspace ? workspace.replace(/^.*[\\/](?=[^\\/]+[\\/][^\\/]+$)/, '…/') : 'Required for Code mode';
  $('workspace').title = workspace || 'No project is open';
  renderMode();
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
  $('welcome-eyebrow').textContent = copy.eyebrow;
  $('welcome-subtitle').replaceChildren(copy.subtitle[0], document.createElement('br'), copy.subtitle[1]);
  $('chat-suggestions').hidden = mode !== 'chat';
  $('code-suggestions').hidden = mode !== 'code';
  $('header-mode').textContent = mode === 'chat' ? 'Chat' : 'Code';
  $('header-project').textContent = mode === 'chat' ? 'Conversation' : projectName() || 'No project';
  $('local-status-text').textContent = copy.status;
  $('composer-note-left').textContent = copy.noteLeft;
  $('composer-note-right').textContent = copy.noteRight;
  $('prompt').placeholder = copy.placeholder;
  $('workspace-gate').hidden = bound;
  $('composer').hidden = !bound;
  renderHistory();
}
async function switchMode(next) {
  if (busy || mode === next) return;
  try { mode = await api.setMode(next); }
  catch (error) { notice(error.message); return; }
  current = undefined;
  notice();
  renderMode();
  renderMessages();
  if (mode === 'chat' || workspace) $('prompt').focus();
}
function renderHistory() {
  $('conversations').replaceChildren();
  const items = conversations.filter(c => c.mode === mode && (mode === 'chat' || c.workspace === workspace));
  for (const conversation of items) {
    const button = document.createElement('button');
    button.className = `conversation${current?.id === conversation.id ? ' active' : ''}`;
    button.textContent = conversation.title;
    button.disabled = busy;
    button.onclick = () => { current = conversation; renderMessages(); renderHistory(); notice(); };
    $('conversations').append(button);
  }
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'empty-history';
    p.textContent = mode === 'chat' ? 'A fresh space for your next idea.' : 'No conversations in this project yet.';
    $('conversations').append(p);
  }
}
function addMessage(role, content) {
  const article = document.createElement('article');
  article.className = `message ${role}`;
  const label = document.createElement('div');
  label.className = 'message-label';
  label.textContent = role === 'user' ? 'YOU' : 'PATRIC';
  const body = document.createElement('div');
  body.className = 'message-content';
  body.textContent = content;
  article.append(label, body);
  $('messages').append(article);
  return body;
}
function renderMessages() {
  $('messages').replaceChildren();
  $('welcome').hidden = Boolean(current?.messages.length);
  for (const message of current?.messages || []) addMessage(message.role, message.content);
  scrollBottom();
}
function scrollBottom() { $('scroll-area').scrollTop = $('scroll-area').scrollHeight; }
function fresh() {
  if (busy) return;
  current = undefined;
  renderMessages();
  renderHistory();
  notice();
  $('prompt').focus();
}
function setBusy(value) {
  busy = value;
  for (const id of ['new-chat', 'workspace', 'settings-button', 'model-button', 'mode-chat', 'mode-code']) $(id).disabled = value;
  $('send').hidden = value;
  $('stop').hidden = !value;
  $('stop').disabled = false;
  $('prompt').disabled = value;
  $('run-status').textContent = value ? 'Working…' : 'Enter to send';
  renderHistory();
}
async function send(event) {
  event.preventDefault();
  const prompt = $('prompt').value.trim();
  if (!prompt || busy) return;
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
  responseNode = addMessage('assistant', 'Thinking…');
  responseText = '';
  setBusy(true);
  persist();
  try {
    const result = await api.chat(current.messages, mode);
    if (!result.ok) {
      notice(result.content);
      responseNode.textContent = responseText || 'The response could not be completed.';
    } else {
      if (!responseText) responseText = result.content;
      responseNode.textContent = responseText || (result.stopped ? 'Response stopped.' : 'Done.');
      if (result.stopped) notice('Response stopped. Commands already started may still be running.');
    }
    if (result.ok && responseText) current.messages.push({ role: 'assistant', content: responseText });
  } catch (error) { responseNode.textContent = 'Unable to complete this response.'; notice(error.message); }
  finally {
    responseNode = undefined;
    permissionQueue = [];
    showPermission();
    setBusy(false);
    persist();
    $('prompt').focus();
    scrollBottom();
  }
}
function showPermission() {
  $('permission').hidden = permissionQueue.length === 0;
  if (permissionQueue.length) {
    $('permission-detail').textContent = permissionQueue[0].summary + '\n' + JSON.stringify(permissionQueue[0].arguments, null, 2);
    $('permission-scope').textContent = `Always allow remembers all ${permissionQueue[0].toolName} actions across projects in both desktop and CLI.`;
  }
}
function decide(decision) {
  const request = permissionQueue.shift();
  if (request) api.permission(request.id, decision);
  showPermission();
}
api.onEvent(({ event, data }) => {
  if (event === 'chunk' && responseNode) {
    const nearBottom = $('scroll-area').scrollHeight - $('scroll-area').scrollTop - $('scroll-area').clientHeight < 120;
    responseText += data;
    responseNode.textContent = responseText;
    if (nearBottom) scrollBottom();
  } else if (event === 'permission') { permissionQueue.push(data); showPermission(); }
  else if (event === 'tool' && busy && ['tool_start', 'tool_end', 'agent_status'].includes(data.type)) {
    const detail = document.createElement('details');
    detail.className = 'tool';
    const summary = document.createElement('summary');
    summary.textContent = `${data.type === 'tool_end' ? '✓' : '↳'} ${data.name}`;
    const body = document.createElement('pre');
    body.textContent = data.result || data.detail || JSON.stringify(data.arguments, null, 2);
    detail.append(summary, body);
    $('messages').append(detail);
    scrollBottom();
  } else if (event === 'error') notice(data);
});
async function openSettings() {
  if (busy) return;
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
  try {
    const next = await api.chooseWorkspace();
    if (next !== workspace) { setWorkspace(next); fresh(); }
  } catch (error) { notice(error.message); }
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
$('stop').onclick = () => { api.stop(); $('stop').disabled = true; $('run-status').textContent = 'Stopping…'; permissionQueue = []; showPermission(); };
$('allow').onclick = () => decide('allow-once');
$('allow-always').onclick = () => decide('allow-always');
$('deny').onclick = () => decide('deny');
$('prompt').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); } };
document.querySelectorAll('[data-prompt]').forEach(button => { button.onclick = () => { $('prompt').value = button.dataset.prompt; $('prompt').focus(); }; });
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && !busy && !$('settings-dialog').open) {
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
    setWorkspace(initial.workspace);
    updateModel();
    renderMessages();
  } catch (error) { notice(error.message); }
}
void initialize();
