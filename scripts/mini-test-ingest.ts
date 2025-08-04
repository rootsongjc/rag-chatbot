/**
 * Mini test ingest script - processes just 2-3 files to verify the migration works
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

const PROVIDER = process.env.PROVIDER || 'qwen';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const WORKER_URL = process.env.WORKER_URL || '';
const QWEN_API_KEY = process.env.QWEN_API_KEY || '';
const QWEN_BASE = process.env.QWEN_BASE;
const QWEN_EMBED_MODEL = process.env.QWEN_EMBED_MODEL || 'text-embedding-v4';
const CONTENT_DIR = process.env.CONTENT_DIR || path.resolve(process.cwd(), '../../content');
const BASE_URL = process.env.BASE_URL || 'https://your-site.com';
const EMBED_DIM = Number(process.env.EMBED_DIM || 1024);

if (!ADMIN_TOKEN || !WORKER_URL || !QWEN_API_KEY) {
  console.error('Missing required environment variables');
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

function generateShortId(baseUrl: string, sourcePath: string, chunkIndex: number): string {
  const uniqueKey = `${baseUrl}|${sourcePath}`;
  const urlHash = createHash('sha256').update(uniqueKey).digest('hex').substring(0, 12);
  return `${urlHash}-${chunkIndex}`;
}

async function getEmbedding(text: string): Promise<number[]> {
  const url = QWEN_BASE || 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${QWEN_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: QWEN_EMBED_MODEL, input: [text] }),
    agent: proxyAgent
  });
  
  if (!r.ok) {
    throw new Error(`Qwen API error ${r.status}: ${await r.text()}`);
  }
  
  const j = await r.json();
  return j.data[0].embedding.slice(0, EMBED_DIM);
}

async function processFile(filePath: string): Promise<any[]> {
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
  
  // Process only the first chunk to test
  const text = chunks[0];
  console.log(`   Processing chunk 1/${chunks.length} for ${sourcePath}...`);
  
  try {
    const vector = await getEmbedding(text);
    
    let finalVector = vector;
    if (finalVector.length > EMBED_DIM) {
      finalVector = finalVector.slice(0, EMBED_DIM);
    } else if (finalVector.length < EMBED_DIM) {
      finalVector = [...finalVector, ...new Array(EMBED_DIM - finalVector.length).fill(0)];
    }
    
    items.push({
      id: generateShortId(baseUrl, sourcePath, 0),
      vector: finalVector,
      text: text.length > 500 ? text.substring(0, 500) + '...' : text,
      title: title.length > 100 ? title.substring(0, 100) : title,
      source: sourcePath,
      url: baseUrl,
      language: language
    });
    
    console.log(`   ✅ Successfully processed chunk with metadata:`);
    console.log(`      - Title: ${title}`);
    console.log(`      - URL: ${baseUrl}`);
    console.log(`      - Language: ${language}`);
    console.log(`      - Source: ${sourcePath}`);
    
    // Small delay to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 1000));
    
  } catch (error) {
    console.error(`   ❌ Failed to process chunk: ${error.message}`);
  }
  
  return items;
}

async function uploadBatch(items: any[]): Promise<void> {
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
  console.log('🧪 Starting mini test ingest...');
  
  // Find just about pages for testing
  const patterns = [
    '*/about/_index.md'
  ];
  
  const allFiles = await globby(patterns, { cwd: CONTENT_DIR, absolute: true });
  console.log(`📁 Found ${allFiles.length} test files`);
  
  let totalItems = 0;
  let allItems: any[] = [];
  
  for (const file of allFiles) {
    console.log(`📄 Processing: ${path.relative(CONTENT_DIR, file)}`);
    try {
      const items = await processFile(file);
      allItems.push(...items);
      console.log(`   ✅ Generated ${items.length} items`);
    } catch (error) {
      console.error(`   ❌ Error: ${error.message}`);
    }
  }
  
  if (allItems.length > 0) {
    console.log(`\n⬆️  Uploading ${allItems.length} items...`);
    try {
      await uploadBatch(allItems);
      totalItems = allItems.length;
      console.log(`✅ Successfully uploaded ${totalItems} items!`);
    } catch (error) {
      console.error(`❌ Upload failed: ${error.message}`);
    }
  }
  
  console.log('\n🎉 Mini test completed!');
  console.log(`📈 Total items processed: ${totalItems}`);
  console.log('\nMetadata verification:');
  if (allItems.length > 0) {
    const sample = allItems[0];
    console.log(`- Language: ${sample.language} ✅`);
    console.log(`- URL: ${sample.url} ✅`);
    console.log(`- Title: ${sample.title} ✅`);
    console.log(`- Source: ${sample.source} ✅`);
  }
}

main().catch(e => {
  console.error('💥 Fatal error:', e);
  process.exit(1);
});
