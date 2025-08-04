import { describe, it, expect, vi } from 'vitest';
import path from 'path';

// Mock dependencies
vi.mock('globby', () => ({ globby: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));

const CONTENT_DIR = path.resolve(process.cwd(), '../../content');
const BASE_URL = 'https://your-site.com';

// Mock implementation of toUrlFromPath
function toUrlFromPath(filePath: string): { url: string; language: 'en' | 'zh' } {
  const rel = path.relative(CONTENT_DIR, filePath).replace(/\\/g, '/');
  const noExt = rel.replace(/\.md$/i, '');
  let cleanPath;
  if (noExt.endsWith('/_index')) {
    cleanPath = noExt.replace('/_index', '/').replace(/^\//, '');
  } else if (noExt.endsWith('/index')) {
    cleanPath = noExt.replace('/index', '/').replace(/^\//, '');
  } else {
    cleanPath = noExt.replace(/^\//, '') + '/';
  }
  const language: 'en' | 'zh' = cleanPath.startsWith('en/') ? 'en' : 'zh';
  let finalPath;
  if (cleanPath.startsWith('zh/blog/')) {
    finalPath = cleanPath.replace('zh/blog/', 'blog/');
  } else if (cleanPath.startsWith('en/blog/')) {
    finalPath = cleanPath;
  } else if (cleanPath.startsWith('zh/')) {
    finalPath = cleanPath.replace('zh/', '');
  } else {
    finalPath = cleanPath;
  }
  const urlPath = ('/' + finalPath).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  const url = new URL(urlPath, BASE_URL).toString();
  return { url, language };
}

describe('ingest URL and language metadata', () => {
  it('should correctly identify Chinese blog posts', () => {
    const filePath = `${CONTENT_DIR}/zh/blog/some-post/index.md`;
    const { url, language } = toUrlFromPath(filePath);
    expect(url).toBe(`${BASE_URL}/blog/some-post`);
    expect(language).toBe('zh');
  });

  it('should correctly identify English blog posts', () => {
    const filePath = `${CONTENT_DIR}/en/blog/some-post/index.md`;
    const { url, language } = toUrlFromPath(filePath);
    expect(url).toBe(`${BASE_URL}/en/blog/some-post`);
    expect(language).toBe('en');
  });

  it('should correctly identify Chinese static pages', () => {
    const filePath = `${CONTENT_DIR}/zh/about/_index.md`;
    const { url, language } = toUrlFromPath(filePath);
    expect(url).toBe(`${BASE_URL}/about`);
    expect(language).toBe('zh');
  });

  it('should correctly identify English static pages', () => {
    const filePath = `${CONTENT_DIR}/en/about/_index.md`;
    const { url, language } = toUrlFromPath(filePath);
    expect(url).toBe(`${BASE_URL}/en/about`);
    expect(language).toBe('en');
  });
});
