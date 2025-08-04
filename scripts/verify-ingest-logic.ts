
/**
 * Dry-run script to verify the ingestion logic of fast-ingest.ts
 *
 * This script performs the following steps:
 * 1. Finds all content files based on the patterns in `fast-ingest.ts`.
 * 2. Applies the deduplication logic (preferring Chinese posts over English).
 * 3. For each selected file, it extracts metadata (title, URL, language).
 * 4. It prints the metadata for each file to be processed.
 *
 * IT DOES NOT:
 * - Call any embedding APIs.
 * - Upload any data to the vector store.
 *
 * This is for verification purposes only.
 */

import { globby } from 'globby';
import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { markdownToPlain } from '../src/utils/md';
import { chunkText } from '../src/rag/chunk';

const CONTENT_DIR = process.env.CONTENT_DIR || path.resolve(process.cwd(), '../../content');
const BASE_URL = process.env.BASE_URL || 'https://your-site.com';

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

async function verifyFile(filePath: string): Promise<void> {
  const raw = await fs.readFile(filePath, 'utf-8');
  const fm = matter(raw);

  if (fm.data.draft === true) {
    console.log(`  - ⏭️ SKIPPED (Draft)`);
    return;
  }

  const title = (fm.data && (fm.data.title || fm.data.Title)) || '';
  const { url, language } = toUrlFromPath(filePath);
  const plain = markdownToPlain(fm.content);
  const chunks = chunkText(plain, 800);

  console.log(`  - Title: ${title}`);
  console.log(`  - URL: ${url}`);
  console.log(`  - Language: ${language}`);
  console.log(`  - Chunks: ${chunks.length}`);
}

async function main() {
  console.log('🧪 Verifying ingestion logic (dry run)...');
  console.log('=================================================');

  const patterns = [
    'zh/blog/**/index.md',
    'en/blog/**/index.md',
    '*/about/_index.md',
    '*/contact/_index.md',
    '*/community/_index.md'
  ];
  
  const allFiles = await globby(patterns, { cwd: CONTENT_DIR, absolute: true });
  
  // Deduplication logic from fast-ingest.ts
  const blogFiles = new Map<string, string>();
  const staticFiles: string[] = [];

  for (const file of allFiles) {
    const relativePath = path.relative(CONTENT_DIR, file);

    if (relativePath.includes('/about/') || relativePath.includes('/contact/') || relativePath.includes('/community/')) {
      // Only keep Chinese versions of about/contact/community pages
      if (relativePath.startsWith('zh/')) {
        staticFiles.push(file);
      }
    } else if (relativePath.includes('/blog/')) {
      const postPath = relativePath.replace(/^(zh|en)\/blog\//, '').replace('/index.md', '');
      
      if (relativePath.startsWith('zh/')) {
        blogFiles.set(postPath, file);
      } else if (relativePath.startsWith('en/') && !blogFiles.has(postPath)) {
        blogFiles.set(postPath, file);
      }
    }
  }

  const filesToProcess = [...blogFiles.values(), ...staticFiles];
  
  console.log(`📁 Found ${allFiles.length} total files.`);
  console.log(`✅ Applying deduplication: ${filesToProcess.length} files will be processed.`);
  console.log('=================================================\n');
  
  // Verify each file that would be processed
  for (const file of filesToProcess) {
    const relativePath = path.relative(CONTENT_DIR, file);
    console.log(`📄 File: ${relativePath}`);
    try {
      await verifyFile(file);
    } catch (error) {
      console.error(`  - ❌ Error verifying file: ${error.message}`);
    }
    console.log('---');
  }

  console.log('\n🎉 Verification complete. No tokens were used.');
}

main().catch(e => {
  console.error('💥 Fatal error during verification:', e);
  process.exit(1);
});

