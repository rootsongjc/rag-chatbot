import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getRelevantDocuments } from '../../src/rag/retriever';

// Mock environment
const mockEnv = {
  VECTORIZE: {
    query: vi.fn()
  }
} as any;

describe('retriever language filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return documents with zh language metadata for zh query', async () => {
    // Mock query result with Chinese documents
    const mockMatches = [
      {
        id: 'doc1',
        metadata: {
          text: 'Chinese content text',
          title: '中文标题',
          url: 'https://your-site.com/blog/test-post',
          language: 'zh'
        }
      },
      {
        id: 'doc2', 
        metadata: {
          text: 'More Chinese content',
          title: '另一篇中文文章',
          url: 'https://your-site.com/about',
          language: 'zh'
        }
      }
    ];

    mockEnv.VECTORIZE.query.mockResolvedValue({
      matches: mockMatches
    });

    const qvec = new Array(768).fill(0.1);
    const result = await getRelevantDocuments(mockEnv, qvec, 15, 'zh');

    // Verify language filter was used
    expect(mockEnv.VECTORIZE.query).toHaveBeenCalledWith(
      qvec,
      expect.objectContaining({
        filter: { metadata: { language: 'zh' } }
      })
    );

    // Verify all returned documents have zh language
    expect(result.sources).toHaveLength(2);
    result.sources.forEach(source => {
      expect(source.url).not.toContain('/en/');
    });
  });

  it('should return documents with en language metadata for en query', async () => {
    // Mock query result with English documents
    const mockMatches = [
      {
        id: 'doc1',
        metadata: {
          text: 'English content text',
          title: 'English Title',
          url: 'https://your-site.com/en/blog/test-post',
          language: 'en'
        }
      },
      {
        id: 'doc2',
        metadata: {
          text: 'More English content',
          title: 'Another English Article',
          url: 'https://your-site.com/en/about',
          language: 'en'
        }
      }
    ];

    mockEnv.VECTORIZE.query.mockResolvedValue({
      matches: mockMatches
    });

    const qvec = new Array(768).fill(0.1);
    const result = await getRelevantDocuments(mockEnv, qvec, 15, 'en');

    // Verify language filter was used
    expect(mockEnv.VECTORIZE.query).toHaveBeenCalledWith(
      qvec,
      expect.objectContaining({
        filter: { metadata: { language: 'en' } }
      })
    );

    // Verify all returned documents have en language
    expect(result.sources).toHaveLength(2);
    result.sources.forEach(source => {
      expect(source.url).toContain('/en/');
    });
  });

  it('should fallback to unfiltered query if language filter fails', async () => {
    // First call (with filter) throws error
    mockEnv.VECTORIZE.query.mockRejectedValueOnce(new Error('Language filter timeout'));
    
    // Second call (fallback) returns results
    const mockMatches = [
      {
        id: 'doc1',
        metadata: {
          text: 'Chinese content text',
          title: '中文标题',
          url: 'https://your-site.com/blog/test-post',
          language: 'zh'
        }
      }
    ];
    
    mockEnv.VECTORIZE.query.mockResolvedValueOnce({
      matches: mockMatches
    });

    const qvec = new Array(768).fill(0.1);
    const result = await getRelevantDocuments(mockEnv, qvec, 15, 'zh');

    // Verify fallback query was used
    expect(mockEnv.VECTORIZE.query).toHaveBeenCalledTimes(2);
    expect(mockEnv.VECTORIZE.query).toHaveBeenNthCalledWith(
      2,
      qvec,
      expect.objectContaining({
        topK: 15,
        returnValues: false,
        returnMetadata: 'all'
      })
    );

    expect(result.usedFallback).toBe(true);
    expect(result.sources).toHaveLength(1);
  });

  it('should apply post-query language filtering when using fallback', async () => {
    // First call fails
    mockEnv.VECTORIZE.query.mockRejectedValueOnce(new Error('Language filter timeout'));
    
    // Second call returns mixed language results
    const mockMatches = [
      {
        id: 'doc1',
        metadata: {
          text: 'Chinese content',
          title: '中文标题',
          url: 'https://your-site.com/blog/chinese-post',
          language: 'zh'
        }
      },
      {
        id: 'doc2',
        metadata: {
          text: 'English content',
          title: 'English Title',
          url: 'https://your-site.com/en/blog/english-post',
          language: 'en'
        }
      }
    ];
    
    mockEnv.VECTORIZE.query.mockResolvedValueOnce({
      matches: mockMatches
    });

    const qvec = new Array(768).fill(0.1);
    const result = await getRelevantDocuments(mockEnv, qvec, 15, 'zh');

    // Should only return Chinese documents after post-query filtering
    expect(result.usedFallback).toBe(true);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].url).not.toContain('/en/');
  });
});
