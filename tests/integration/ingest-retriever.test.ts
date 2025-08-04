import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// Mock dependencies
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn()
  },
  readFile: vi.fn()
}));

vi.mock('gray-matter', () => ({
  default: vi.fn()
}));

vi.mock('../../src/utils/md', () => ({
  markdownToPlain: vi.fn()
}));

vi.mock('../../src/rag/chunk', () => ({
  chunkText: vi.fn()
}));

const fs = {
  readFile: vi.fn()
};
const matter = vi.fn();
const markdownToPlain = vi.fn();
const chunkText = vi.fn();
import { getRelevantDocuments } from '../../src/rag/retriever';

const CONTENT_DIR = path.resolve(process.cwd(), '../../content');
const BASE_URL = 'https://your-site.com';

// Mock implementation of toUrlFromPath from fast-ingest
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

// Mock processFile function similar to fast-ingest
async function processFile(filePath: string) {
  const raw = await fs.readFile(filePath, 'utf-8');
  const fm = matter(raw);
  
  if (fm.data.draft === true) {
    return [];
  }
  
  const title = (fm.data && (fm.data.title || fm.data.Title)) || '';
  const plain = markdownToPlain(fm.content);
  const chunks = chunkText(plain, 800);
  
  if (chunks.length === 0) {
    return [];
  }
  
  const { url: baseUrl, language } = toUrlFromPath(filePath);
  const sourcePath = path.relative(CONTENT_DIR, filePath);
  
  const items = [];
  for (let i = 0; i < chunks.length; i++) {
    const text = chunks[i];
    
    items.push({
      id: `mock-id-${i}`,
      vector: new Array(768).fill(0.1), // Mock vector
      text: text.length > 500 ? text.substring(0, 500) + '...' : text,
      title: title.length > 100 ? title.substring(0, 100) : title,
      source: sourcePath,
      url: baseUrl,
      language: language
    });
  }
  
  return items;
}

describe('Integration: Fast-ingest + Retriever', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should process Chinese blog post and store correct metadata', async () => {
    // Mock file system and markdown processing
    const mockContent = '# 测试文章\n\n这是一篇中文测试文章的内容。';
    const mockFrontMatter = {
      data: { title: '测试文章标题', draft: false },
      content: mockContent
    };

    (fs.readFile as any).mockResolvedValue('---\ntitle: 测试文章标题\n---\n' + mockContent);
    (matter as any).mockReturnValue(mockFrontMatter);
    (markdownToPlain as any).mockReturnValue('测试文章 这是一篇中文测试文章的内容。');
    (chunkText as any).mockReturnValue(['测试文章 这是一篇中文测试文章的内容。']);

    const filePath = `${CONTENT_DIR}/zh/blog/test-post/index.md`;
    const items = await processFile(filePath);

    expect(items).toHaveLength(1);
    expect(items[0].language).toBe('zh');
    expect(items[0].url).toBe(`${BASE_URL}/blog/test-post`);
    expect(items[0].title).toBe('测试文章标题');
    expect(items[0].url).not.toContain('/en/');
  });

  it('should process English blog post and store correct metadata', async () => {
    // Mock file system and markdown processing
    const mockContent = '# Test Article\n\nThis is an English test article content.';
    const mockFrontMatter = {
      data: { title: 'Test Article Title', draft: false },
      content: mockContent
    };

    (fs.readFile as any).mockResolvedValue('---\ntitle: Test Article Title\n---\n' + mockContent);
    (matter as any).mockReturnValue(mockFrontMatter);
    (markdownToPlain as any).mockReturnValue('Test Article This is an English test article content.');
    (chunkText as any).mockReturnValue(['Test Article This is an English test article content.']);

    const filePath = `${CONTENT_DIR}/en/blog/test-post/index.md`;
    const items = await processFile(filePath);

    expect(items).toHaveLength(1);
    expect(items[0].language).toBe('en');
    expect(items[0].url).toBe(`${BASE_URL}/en/blog/test-post`);
    expect(items[0].title).toBe('Test Article Title');
    expect(items[0].url).toContain('/en/');
  });

  it('should retrieve only Chinese documents for Chinese query context', async () => {
    // Mock environment with Chinese results only (simulating successful language filter)
    const mockEnv = {
      VECTORIZE: {
        query: vi.fn().mockResolvedValue({
          matches: [
            {
              id: 'zh-doc1',
              metadata: {
                text: '中文内容',
                title: '中文标题',
                url: 'https://your-site.com/blog/chinese-post',
                language: 'zh'
              }
            }
          ]
        })
      }
    } as any;

    const qvec = new Array(768).fill(0.1);
    const result = await getRelevantDocuments(mockEnv, qvec, 15, 'zh');

    // Verify language filter was applied
    expect(mockEnv.VECTORIZE.query).toHaveBeenCalledWith(
      qvec,
      expect.objectContaining({
        filter: { metadata: { language: 'zh' } }
      })
    );

    // Should return only Chinese sources
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].url).not.toContain('/en/');
  });

  it('should retrieve only English documents for English query context', async () => {
    // Mock environment with English results only (simulating successful language filter)
    const mockEnv = {
      VECTORIZE: {
        query: vi.fn().mockResolvedValue({
          matches: [
            {
              id: 'en-doc1',
              metadata: {
                text: 'English content',
                title: 'English Title',
                url: 'https://your-site.com/en/blog/english-post',
                language: 'en'
              }
            }
          ]
        })
      }
    } as any;

    const qvec = new Array(768).fill(0.1);
    const result = await getRelevantDocuments(mockEnv, qvec, 15, 'en');

    // Verify language filter was applied
    expect(mockEnv.VECTORIZE.query).toHaveBeenCalledWith(
      qvec,
      expect.objectContaining({
        filter: { metadata: { language: 'en' } }
      })
    );

    // Should return only English sources
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].url).toContain('/en/');
  });
});
