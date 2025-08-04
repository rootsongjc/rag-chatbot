import MarkdownIt from 'markdown-it';

/**
 * Convert markdown to plain text by rendering to HTML then stripping tags crudely.
 * For production, consider a better plaintext extractor.
 */
const md = new MarkdownIt({ html: false, linkify: false, typographer: false });

export function markdownToPlain(mdContent: string): string {
  const html = md.render(mdContent);
  return html
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n+/g, '\n')
    .trim();
}
