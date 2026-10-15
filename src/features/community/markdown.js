import { createMemoryCache } from '../../app/memoryCache.js';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif']);
const usernameCharacters = '\\p{L}\\p{M}\\p{N}\\p{S}_';
const mentionPattern = new RegExp(`(^|[^${usernameCharacters}])(@[${usernameCharacters}]{3,96})(?![${usernameCharacters}])`, 'giu');

function cleanUrl(value) {
  return String(value).replace(/&amp;/g, '&').replace(/[.,!?;:]+$/g, '');
}

function embedForUrl(value) {
  const rawUrl = cleanUrl(value);
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return `<a class="community-link-embed" href="${escapeHtml(rawUrl)}" target="_blank" rel="noreferrer noopener"><strong>${escapeHtml(rawUrl)}</strong></a>`;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return `<a href="${escapeHtml(rawUrl)}" target="_blank" rel="noreferrer noopener">${escapeHtml(rawUrl)}</a>`;

  const safeUrl = escapeHtml(parsed.toString());
  const extension = parsed.pathname.match(/\.[a-z0-9]+$/i)?.[0].toLowerCase() || '';
  if (VIDEO_EXTENSIONS.has(extension)) return `<video class="community-link-video" controls preload="metadata" playsinline src="${safeUrl}"></video>`;
  if (AUDIO_EXTENSIONS.has(extension)) return `<audio class="community-link-audio" controls preload="metadata" src="${safeUrl}"></audio>`;
  if (IMAGE_EXTENSIONS.has(extension)) return `<a class="community-link-image" href="${safeUrl}" target="_blank" rel="noreferrer noopener"><img src="${safeUrl}" alt="Linked image" loading="lazy" decoding="async" /></a>`;

  const youtube = parsed.hostname.replace(/^www\./, '') === 'youtube.com' || parsed.hostname === 'youtu.be'
    ? (parsed.hostname === 'youtu.be' ? parsed.pathname.slice(1) : parsed.searchParams.get('v'))
    : null;
  if (youtube && /^[a-zA-Z0-9_-]{6,20}$/.test(youtube)) return `<iframe class="community-link-video-embed" src="https://www.youtube-nocookie.com/embed/${youtube}" title="YouTube video" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>`;

  const vimeo = parsed.hostname.replace(/^www\./, '') === 'vimeo.com' ? parsed.pathname.match(/\/(\d+)/)?.[1] : null;
  if (vimeo) return `<iframe class="community-link-video-embed" src="https://player.vimeo.com/video/${vimeo}" title="Vimeo video" loading="lazy" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`;

  const host = parsed.hostname.toLowerCase();
  const isGlean = host === 'd3bdx5il6w3di0.cloudfront.net' || host === 'glean.chat';
  const title = isGlean ? 'Glean' : parsed.hostname;
  const description = isGlean ? 'Messages and servers on Glean.' : 'Open this link to view the shared page.';
  return `<a class="community-link-embed" href="${safeUrl}" target="_blank" rel="noreferrer noopener"><span class="community-link-embed-icon" aria-hidden="true">${isGlean ? '✦' : '↗'}</span><span class="community-link-embed-copy"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(description)}</small><em>${escapeHtml(parsed.hostname)}${parsed.pathname !== '/' ? escapeHtml(parsed.pathname) : ''}</em></span></a>`;
}

const htmlCache = createMemoryCache({
  maxEntries: 256,
  maxBytes: 2 * 1024 * 1024,
  sizeOf: (key, html) => (key.length + html.length) * 2,
});
if (import.meta.hot) import.meta.hot.dispose(() => htmlCache.dispose());

export function markdownToHtml(value, options = {}) {
  const mentionKey = (options.mentionUsernames || []).join(',').toLowerCase();
  const styleKey = Object.entries(options.mentionStyles || {}).map(([name, item]) => `${name}:${item?.attr || ''}`).join('|');
  const cacheKey = `${options.currentUsername || ''}\0${mentionKey}\0${styleKey}\0${value}`;
  const cached = htmlCache.get(cacheKey);
  if (cached) return cached;
  const html = renderMarkdownHtml(value, options);
  htmlCache.set(cacheKey, html);
  return html;
}

function renderMarkdownHtml(value, options = {}) {
  const escaped = escapeHtml(value);
  const protectedBlocks = [];
  const protect = (html) => {
    const token = `\u0000${protectedBlocks.length}\u0000`;
    protectedBlocks.push(html);
    return token;
  };
  const mentionNames = new Set((options.mentionUsernames || []).map((name) => String(name || '').toLowerCase()).filter(Boolean));
  const currentUsername = String(options.currentUsername || '').toLowerCase();
  const formatted = escaped
    .replace(/```(?:[a-z0-9_-]+)?\n?([\s\S]*?)```/gi, (_, code) => protect(`<pre><code>${code}</code></pre>`))
    .replace(/`([^`\n]+)`/g, (_, code) => protect(`<code>${code}</code>`))
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => protect(`<a href="${escapeHtml(cleanUrl(url))}" target="_blank" rel="noreferrer noopener">${label}</a>`))
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/_([^_\n]+)_/g, '<em>$1</em>')
    .replace(/^>\s?(.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/https?:\/\/[^\s<]+/gi, (url) => protect(embedForUrl(url)))
    .replace(mentionPattern, (match, prefix, tag) => {
      const name = tag.slice(1);
      const everyone = name.toLowerCase() === 'everyone';
      if (!everyone && mentionNames.size && !mentionNames.has(name.toLowerCase())) return match;
      const self = everyone || (currentUsername && name.toLowerCase() === currentUsername);
      const styled = everyone ? null : (options.mentionStyles || {})[name.toLowerCase()];
      const extraClass = styled?.className ? ` ${styled.className}` : '';
      const styleAttr = styled?.attr ? ` style="${styled.attr}"` : '';
      return `${prefix}${protect(`<button type="button" class="dm-mention${self ? ' is-self' : ''}${everyone ? ' is-everyone' : ''}${extraClass}" data-mention="${escapeHtml(name)}"${styleAttr}>${escapeHtml(tag)}</button>`)}`;
    });

  const renderedLines = [];
  let listType = null;
  for (const line of formatted.split('\n')) {
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const nextType = unordered ? 'ul' : ordered ? 'ol' : null;
    if (nextType) {
      if (listType !== nextType) {
        if (listType) renderedLines.push(`</${listType}>`);
        renderedLines.push(`<${nextType}>`);
        listType = nextType;
      }
      renderedLines.push(`<li>${(unordered || ordered)[1]}</li>`);
      continue;
    }
    if (listType) {
      renderedLines.push(`</${listType}>`);
      listType = null;
    }
    renderedLines.push(line ? `${line}<br />` : '<br />');
  }
  if (listType) renderedLines.push(`</${listType}>`);
  return renderedLines.join('').replace(/\u0000(\d+)\u0000/g, (_, index) => protectedBlocks[Number(index)] || '');
}
