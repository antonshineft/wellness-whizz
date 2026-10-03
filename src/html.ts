/** Small HTML helpers. Every piece of user or model generated text goes through escapeHtml. */

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Render an array of plain-text bullets as an <ol> or <ul>. */
export function listHtml(items: readonly string[], tag: 'ol' | 'ul' = 'ol'): string {
  const clean = items.map((s) => String(s ?? '').trim()).filter(Boolean);
  if (!clean.length) return '';
  return `<${tag}>${clean.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</${tag}>`;
}

/** Render a list of links as <ul><li><a>. */
export function linksListHtml(items: readonly { label: string; href: string }[]): string {
  const clean = items.filter((i) => i && i.label && i.href);
  if (!clean.length) return '';
  return `<ul>${clean
    .map(
      (i) =>
        `<li><a href="${escapeHtml(i.href)}" target="_blank" rel="noopener nofollow">${escapeHtml(i.label)}</a></li>`,
    )
    .join('')}</ul>`;
}

/** Plain text with blank lines -> paragraphs. */
export function paragraphsHtml(text: string): string {
  return String(text ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}
