# Testing Suite Documentation

This directory contains comprehensive tests for the multilingual RAG (Retrieval-Augmented Generation) system.

## Test Structure

```text
tests/
├── unit/                    # Unit tests for individual functions
│   ├── ingest.test.ts  # Tests URL generation and language detection
│   └── retriever.test.ts    # Tests document retrieval and language filtering
├── integration/             # Integration tests for combined functionality
│   └── ingest-retriever.test.ts  # Tests full ingestion + retrieval flow
└── e2e/                     # End-to-end tests with real browser
    └── multilingual.spec.ts # Tests complete user experience
```

## Test Coverage

### 1. Unit Tests for ingest (`tests/unit/ingest.test.ts`)

Tests the URL generation and language detection logic from `scripts/ingest.ts`:

- ✅ **Chinese blog posts**: `zh/blog/post/index.md` → `https://your-site.com/blog/post` (language: zh)
- ✅ **English blog posts**: `en/blog/post/index.md` → `https://your-site.com/en/blog/post` (language: en)  
- ✅ **Chinese static pages**: `zh/about/_index.md` → `https://your-site.com/about` (language: zh)
- ✅ **English static pages**: `en/about/_index.md` → `https://your-site.com/en/about` (language: en)

### 2. Unit Tests for Retriever (`tests/unit/retriever.test.ts`)

Tests the document retrieval and language filtering from `src/rag/retriever.ts`:

- ✅ **Chinese query context**: Returns only documents with `language === 'zh'` and URLs without `/en/`
- ✅ **English query context**: Returns only documents with `language === 'en'` and URLs containing `/en/`
- ✅ **Fallback mechanism**: Falls back to unfiltered query when language filter fails/times out
- ✅ **Post-query filtering**: Applies URL-based language filtering during fallback

### 3. Integration Tests (`tests/integration/ingest-retriever.test.ts`)

Tests the complete flow from ingestion through retrieval:

- ✅ **Chinese file processing**: Processes Chinese markdown files and stores correct metadata (language: zh, URL without /en/)
- ✅ **English file processing**: Processes English markdown files and stores correct metadata (language: en, URL with /en/)
- ✅ **End-to-end Chinese retrieval**: Full flow returns only Chinese documents for Chinese queries
- ✅ **End-to-end English retrieval**: Full flow returns only English documents for English queries

### 4. End-to-End Tests (`tests/e2e/multilingual.spec.ts`)

Browser-based tests using Playwright to verify the complete user experience:

- 🔄 **Chinese blog experience**: Navigate to `/blog/...` (zh), ask question, verify Chinese references without `/en/` URLs
- 🔄 **English blog experience**: Navigate to `/en/blog/...` (en), ask question, verify English references with `/en/` URLs

*Note: E2E tests require actual website deployment and may need selector updates based on UI implementation.*

## Running Tests

### Unit & Integration Tests

```bash
# Run all unit and integration tests
npm run test

# Run tests in watch mode
npm run test:ui

# Run tests once
npm run test:run
```

### End-to-End Tests

```bash
# Install Playwright browsers (first time only)
npx playwright install

# Run E2E tests
npm run test:e2e

# Run E2E tests with UI
npm run test:e2e:ui
```

### All Tests

```bash
# Run everything
npm run test:run && npm run test:e2e
```

## Test Configuration

- **Vitest**: Unit and integration tests use Vitest with TypeScript support
- **Playwright**: E2E tests use Playwright for cross-browser testing
- **Mocking**: Comprehensive mocking of file system, embedding APIs, and vector database

## Key Assertions

The tests verify the core multilingual requirements:

1. **URL Generation**: Chinese content maps to clean URLs, English content includes `/en/` prefix
2. **Language Metadata**: All ingested documents have correct language tags (`zh` or `en`)
3. **Language Filtering**: Retrieval respects language context and returns appropriate documents
4. **Fallback Behavior**: System gracefully handles language filter failures
5. **End-to-End Experience**: Users see references in their language with correct URLs

## Mock Data Examples

### Chinese Document

```javascript
{
  id: 'mock-id-0',
  url: 'https://your-site.com/blog/test-post',
  title: '测试文章标题',
  language: 'zh',
  text: '测试文章 这是一篇中文测试文章的内容。'
}
```

### English Document  

```javascript
{
  id: 'mock-id-0', 
  url: 'https://your-site.com/en/blog/test-post',
  title: 'Test Article Title',
  language: 'en',
  text: 'Test Article This is an English test article content.'
}
```

This comprehensive testing suite ensures the multilingual RAG system correctly handles both Chinese and English content throughout the entire pipeline.
