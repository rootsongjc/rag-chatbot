/**
 * Ultra-fast batch ingest script with maximum parallelism
 * 
 * Key optimizations:
 * - Pre-process all files in parallel
 * - Batch embedding requests maximally 
 * - Upload in large batches to minimize HTTP overhead
 * - Use Promise.allSettled for fault tolerance
 */

import 'dotenv/config';
import { globby } from 'globby';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import { markdownToPlain } from '../src/utils/md';
import { chunkText } from '../src/rag/chunk';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

const PROVIDER = process.env.PROVIDER || 'gemini';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const WORKER_URL = process.env.WORKER_URL || '';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const QWEN_API_KEY = process.env.QWEN_API_KEY || '';
const QWEN_BASE = process.env.QWEN_BASE;
const QWEN_EMBED_MODEL = process.env.QWEN_EMBED_MODEL || 'text-embedding-v4';
const CONTENT_DIR = process.env.CONTENT_DIR || path.resolve(process.cwd(), '../../content');
const BASE_URL = process.env.BASE_URL || 'https://your-site.com';
const EMBED_DIM = Number(process.env.EMBED_DIM || 768);

// High-speed settings for maximum throughput
const MAX_CONCURRENT_FILES = PROVIDER === 'gemini' ? 30 : 15; // Much higher concurrency for Qwen
const MAX_CONCURRENT_EMBEDDINGS = PROVIDER === 'gemini' ? 50 : 25; // Increased concurrent embeddings
const UPLOAD_BATCH_SIZE = 300; // Larger upload batches
const EMBEDDING_BATCH_SIZE = PROVIDER === 'gemini' ? 1 : 10; // Qwen v4 max batch size is 10

if (!ADMIN_TOKEN || !WORKER_URL) {
  console.error('Missing ADMIN_TOKEN or WORKER_URL');
  process.exit(1);
}
if (PROVIDER === 'gemini' && !GOOGLE_API_KEY) {
  console.error('Missing GOOGLE_API_KEY');
  process.exit(1);
}
if (PROVIDER === 'qwen' && !QWEN_API_KEY) {
  console.error('Missing QWEN_API_KEY');
  process.exit(1);
}

const proxyAgent = (() => {
  const httpsProxy = process.env.https_proxy || process.env.HTTPS_PROXY;
  if (httpsProxy) {
    console.log(`Using proxy: ${httpsProxy}`);
    return new HttpsProxyAgent(httpsProxy);
  }
  return undefined;
})();

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
  
  // Determine language from the original file path
  const language: 'en' | 'zh' = cleanPath.startsWith('en/') ? 'en' : 'zh';
  
  // Build language-specific URLs
  let finalPath;
  if (cleanPath.startsWith('zh/blog/')) {
    // Chinese blog posts: /blog/{slug}/ (no prefix)
    finalPath = cleanPath.replace('zh/blog/', 'blog/');
  } else if (cleanPath.startsWith('en/blog/')) {
    // English blog posts: /en/blog/{slug}/ (retain prefix)
    finalPath = cleanPath; // Keep the en/ prefix
  } else if (cleanPath.startsWith('zh/')) {
    // Chinese static pages: remove zh prefix
    finalPath = cleanPath.replace('zh/', '');
  } else {
    // English static pages and others: keep as is
    finalPath = cleanPath;
  }
  
  const urlPath = ('/' + finalPath).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  const url = new URL(urlPath, BASE_URL).toString();
  
  return { url, language };
}

// Generate short, unique ID from URL, source path and chunk index
function generateShortId(baseUrl: string, sourcePath: string, chunkIndex: number): string {
  // Include source path to differentiate between zh and en versions
  const uniqueKey = `${baseUrl}|${sourcePath}`;
  const urlHash = createHash('sha256').update(uniqueKey).digest('hex').substring(0, 12);
  return `${urlHash}-${chunkIndex}`;
}

// Batch embedding function that handles multiple texts efficiently
async function getBatchEmbeddings(texts: string[]): Promise<number[][]> {
  if (PROVIDER === 'gemini') {
    // Gemini doesn't support batch, so process individually
    const embeddings: number[][] = [];
    for (const text of texts) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${GOOGLE_API_KEY}`;
      const body = {
        model: 'models/text-embedding-004',
        content: { parts: [{ text }] },
        outputDimensionality: EMBED_DIM
      };
      
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        agent: proxyAgent
      });
      
      if (!r.ok) {
        throw new Error(`Gemini API error ${r.status}: ${await r.text()}`);
      }
      
      const j = await r.json();
      embeddings.push(j.embedding.values);
    }
    return embeddings;
  } else {
    // Qwen supports batch processing - much more efficient!
    const url = QWEN_BASE || 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings';
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${QWEN_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: QWEN_EMBED_MODEL, input: texts }),
      agent: proxyAgent
    });
    
    if (!r.ok) {
      throw new Error(`Qwen API error ${r.status}: ${await r.text()}`);
    }
    
    const j = await r.json();
    return j.data.map((d: any) => d.embedding.slice(0, EMBED_DIM));
  }
}

// Single embedding function for backward compatibility
async function getEmbedding(text: string): Promise<number[]> {
  const [embedding] = await getBatchEmbeddings([text]);
  return embedding;
}

// Process a single file and return all its vector items
export async function processFile(filePath: string): Promise<any[]> {
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
  
  // Process chunks in batches using batch embedding API
  const items = [];
  for (let i = 0; i < chunks.length; i += EMBEDDING_BATCH_SIZE) {
    const chunkBatch = chunks.slice(i, i + EMBEDDING_BATCH_SIZE);
    
    try {
      // Get embeddings for all chunks in this batch at once
      const vectors = await getBatchEmbeddings(chunkBatch);
      
      // Create items for each chunk in the batch
      for (let j = 0; j < chunkBatch.length; j++) {
        const text = chunkBatch[j];
        let finalVector = vectors[j];
        
        // Ensure correct dimensions
        if (finalVector.length > EMBED_DIM) {
          finalVector = finalVector.slice(0, EMBED_DIM);
        } else if (finalVector.length < EMBED_DIM) {
          finalVector = [...finalVector, ...new Array(EMBED_DIM - finalVector.length).fill(0)];
        }
        
        items.push({
          id: generateShortId(baseUrl, sourcePath, i + j),
          vector: finalVector,
          text: text.length > 500 ? text.substring(0, 500) + '...' : text,
          title: title.length > 100 ? title.substring(0, 100) : title,
          source: sourcePath,
          url: baseUrl,
          language: language
        });
      }
      
      // Minimal delay between batches for maximum speed
      if (i + EMBEDDING_BATCH_SIZE < chunks.length) {
        const delay = PROVIDER === 'qwen' ? 50 : 5; // Very short delay for maximum throughput
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    } catch (error) {
      console.error(`Embedding batch failed for ${sourcePath}:`, error.message);
      // Continue with next batch
    }
  }
  
  return items;
}

// Upload items in large batches
export async function uploadBatch(items: any[]): Promise<void> {
  const r = await fetch(`${WORKER_URL.replace(/\/$/, '')}/admin/upsert`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json', 
      'Authorization': `Bearer ${ADMIN_TOKEN}` 
    },
    body: JSON.stringify({ items }),
    agent: proxyAgent
  });
  
  if (!r.ok) {
    const msg = await r.text();
    throw new Error(`Upload failed: ${r.status} ${msg}`);
  }
}

async function main() {
  console.log('🚀 Starting ultra-fast batch ingestion...');
  const startTime = Date.now();
  
  // Find files - include both language versions to preserve language-specific URLs
  const patterns = [
    // Both Chinese and English blog posts (preserve both versions)
    'zh/blog/**/index.md',
    'en/blog/**/index.md',
    // Add more static contents here
  ];
  
  const allFiles = await globby(patterns, { cwd: CONTENT_DIR, absolute: true });

  // Deduplicate blog posts: prefer Chinese version, use English only if Chinese doesn't exist
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
      // For blog posts, extract the post identifier
      const postPath = relativePath.replace(/^(zh|en)\/blog\//, '').replace('/index.md', '');

      if (relativePath.startsWith('zh/')) {
        // Chinese version takes priority
        blogFiles.set(postPath, file);
      } else if (relativePath.startsWith('en/') && !blogFiles.has(postPath)) {
        // English version only if no Chinese version exists
        blogFiles.set(postPath, file);
      }
    }
  }

  const files = [...blogFiles.values(), ...staticFiles];
  console.log(`📁 Found ${allFiles.length} total files, deduplicated to ${files.length} files`);
  console.log(`📊 Blog posts: ${blogFiles.size}, Static pages: ${staticFiles.length}`);
  
  let totalItems = 0;
  let processedFiles = 0;
  let allItems: any[] = [];
  
  // Process files in batches with maximum concurrency
  for (let i = 0; i < files.length; i += MAX_CONCURRENT_FILES) {
    const batch = files.slice(i, i + MAX_CONCURRENT_FILES);
    console.log(`📊 Processing batch ${Math.floor(i/MAX_CONCURRENT_FILES) + 1}/${Math.ceil(files.length/MAX_CONCURRENT_FILES)} (${batch.length} files)`);
    
    const results = await Promise.allSettled(
      batch.map(async (file) => {
        try {
          const items = await processFile(file);
          console.log(`✅ ${path.relative(CONTENT_DIR, file)}: ${items.length} chunks`);
          return items;
        } catch (error) {
          console.error(`❌ ${path.relative(CONTENT_DIR, file)}: ${error.message}`);
          return [];
        }
      })
    );
    
    // Collect all successful results
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allItems.push(...result.value);
        processedFiles++;
      }
    }
    
    // Upload in large batches when we have enough items
    while (allItems.length >= UPLOAD_BATCH_SIZE) {
      const uploadBatch_items = allItems.splice(0, UPLOAD_BATCH_SIZE);
      try {
        await uploadBatch(uploadBatch_items);
        totalItems += uploadBatch_items.length;
        console.log(`⬆️  Uploaded batch: ${uploadBatch_items.length} items (total: ${totalItems})`);
      } catch (error) {
        console.error(`Upload failed: ${error.message}`);
        // Put items back at the beginning to retry later
        allItems.unshift(...uploadBatch_items);
        break;
      }
    }
  }
  
  // Upload remaining items
  if (allItems.length > 0) {
    try {
      await uploadBatch(allItems);
      totalItems += allItems.length;
      console.log(`⬆️  Uploaded final batch: ${allItems.length} items`);
    } catch (error) {
      console.error(`Final upload failed: ${error.message}`);
    }
  }
  
  const duration = (Date.now() - startTime) / 1000;
  console.log('\n🎉 Ingestion completed!');
  console.log(`📈 Stats: ${processedFiles}/${files.length} files, ${totalItems} chunks`);
  console.log(`⏱️  Time: ${duration.toFixed(1)}s (${(totalItems/duration).toFixed(1)} chunks/sec)`);
}

// Only run main if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => {
    console.error('💥 Fatal error:', e);
    process.exit(1);
  });
}
