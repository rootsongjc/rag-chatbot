/**
 * Simple Chinese-friendly chunker:
 * - Split by headings first (##, ###...)
 * - Then further chunk by maxLen characters preserving sentence boundaries when possible.
 */
export function chunkText(input: string, maxLen = 800): string[] {
  const sections = input
    .split(/^#{1,6}\s+/m) // split by markdown heading
    .map(s => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  const pushChunk = (s: string) => { if (s.trim()) chunks.push(s.trim()); };

  for (const sec of sections.length ? sections : [input]) {
    if (sec.length <= maxLen) { pushChunk(sec); continue; }
    let buf = '';
    for (const part of sec.split(/(?<=[。！？!?；;]\s*)/)) {
      if ((buf + part).length > maxLen) {
        pushChunk(buf); buf = part;
      } else {
        buf += part;
      }
    }
    pushChunk(buf);
  }
  return chunks;
}
