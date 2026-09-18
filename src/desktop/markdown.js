// Build a small, inert subset of HTML: model output must never become active UI.
const markdownParser = new marked.Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  }
});
const markdownTags = new Set(['P', 'BR', 'HR', 'STRONG', 'EM', 'DEL', 'CODE', 'PRE',
  'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'A']);

function renderMarkdown(container, source) {
  const template = document.createElement('template');
  template.innerHTML = markdownParser.parse(source);
  function clean(node) {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent);
    if (node.nodeType !== Node.ELEMENT_NODE) return document.createTextNode('');
    if (node.tagName === 'IMG') return document.createTextNode(node.getAttribute('alt') || '');
    if (node.tagName === 'INPUT') return document.createTextNode(node.hasAttribute('checked') ? '☑ ' : '☐ ');
    const element = markdownTags.has(node.tagName)
      ? document.createElement(node.tagName.toLowerCase()) : document.createDocumentFragment();
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href)) {
        element.setAttribute('href', href);
        element.setAttribute('title', href);
        element.setAttribute('rel', 'noreferrer noopener');
      }
    }
    if (node.tagName === 'OL' && /^\d+$/.test(node.getAttribute('start') || '')) {
      element.setAttribute('start', node.getAttribute('start'));
    }
    element.append(...Array.from(node.childNodes, clean));
    return element;
  }
  container.replaceChildren(...Array.from(template.content.childNodes, clean));
}
