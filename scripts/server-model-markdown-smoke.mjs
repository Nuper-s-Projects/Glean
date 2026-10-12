import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { default: ServerModelMarkdown } = await vite.ssrLoadModule('/src/features/community/ServerModelMarkdown.jsx');
  const render = (text) => renderToStaticMarkup(createElement(ServerModelMarkdown, null, text));
  const formatted = render('# Plan\n\n## Channels\n\n**Bold** and *italic* and ~~removed~~ with `code`.\n\n- General\n- Support\n\n1. Prepare\n2. Apply\n\n> Review first\n\n```js\nconst role = "Helpers";\n```\n\n| Channel | Type |\n| --- | --- |\n| general | text |\n\n- [x] Prepared\n\n[Docs](https://example.com/docs)');
  for (const tag of ['h1', 'h2', 'strong', 'em', 'del', 'code', 'ul', 'ol', 'blockquote', 'pre', 'table']) assert.match(formatted, new RegExp(`<${tag}(?:>|\\s)`), tag);
  assert.match(formatted, /type="checkbox"/);
  assert.match(formatted, /rel="noopener noreferrer"/);
  const unsafe = render('[bad](javascript:alert%281%29)\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n![tracking](https://example.com/tracking.png)');
  assert.doesNotMatch(unsafe, /href="javascript:|<script|<img|onerror=|<iframe/);
  assert.match(unsafe, /tracking/);
  assert.equal(render(''), '<div class="server-model-markdown"></div>');
  console.log('PASS: model Markdown formatting, code, tables, tasks, safe links, blocked HTML and no remote image loading.');
} finally { await vite.close(); }
