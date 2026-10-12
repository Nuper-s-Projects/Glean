import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const plugins = [remarkGfm];
const components = {
  a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
  // Model responses must not silently load third-party images or tracking pixels.
  img: ({ alt }) => alt ? <span className="server-model-markdown-image">{alt}</span> : null,
  table: ({ children }) => <div className="server-model-markdown-table" role="region" aria-label="Markdown table" tabIndex={0}><table>{children}</table></div>,
  pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
};

export default memo(function ServerModelMarkdown({ children }) {
  return <div className="server-model-markdown"><Markdown remarkPlugins={plugins} components={components} skipHtml>{String(children || '')}</Markdown></div>;
});
