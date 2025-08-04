/**
 * Add static pages (about/contact) to RAG system
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

function toUrlFromPath(filePath: string): string {
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
  
  // Handle static pages: remove zh prefix, keep en prefix
  if (cleanPath.startsWith('zh/')) {
    cleanPath = cleanPath.replace('zh/', '');
  }
  
  const urlPath = ('/' + cleanPath).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  return new URL(urlPath, BASE_URL).toString();
}

function generateShortId(baseUrl: string, sourcePath: string, chunkIndex: number): string {
  const uniqueKey = `${baseUrl}|${sourcePath}`;
  const urlHash = createHash('sha256').update(uniqueKey).digest('hex').substring(0, 12);
  return `${urlHash}-${chunkIndex}`;
}

async function getEmbedding(text: string): Promise<number[]> {
  const url = QWEN_BASE || 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 
      'Authorization': `Bearer ${QWEN_API_KEY}`, 
      'Content-Type': 'application/json' 
    },
    body: JSON.stringify({ 
      model: QWEN_EMBED_MODEL, 
      input: [text] 
    }),
    agent: proxyAgent
  });
  
  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`Qwen API error ${resp.status}: ${errorText}`);
  }
  
  const data = await resp.json();
  return data.data[0].embedding.slice(0, EMBED_DIM);
}

async function processFile(filePath: string): Promise<any[]> {
  console.log(`Processing ${path.relative(CONTENT_DIR, filePath)}...`);
  
  const raw = await fs.readFile(filePath, 'utf-8');
  const fm = matter(raw);
  
  if (fm.data.draft === true) {
    console.log('  Skipping draft file');
    return [];
  }
  
  const title = (fm.data && (fm.data.title || fm.data.Title)) || '';
  const plain = markdownToPlain(fm.content);
  const chunks = chunkText(plain, 800);
  
  if (chunks.length === 0) {
    console.log('  No content to index');
    return [];
  }
  
  const baseUrl = toUrlFromPath(filePath);
  const sourcePath = path.relative(CONTENT_DIR, filePath);
  
  console.log(`  Title: ${title}`);
  console.log(`  URL: ${baseUrl}`);
  console.log(`  Chunks: ${chunks.length}`);
  
  const items = [];
  for (let i = 0; i < chunks.length; i++) {
    const text = chunks[i];
    
    try {
      const vector = await getEmbedding(text);
      
      // Ensure correct dimensions
      let finalVector = vector;
      if (finalVector.length > EMBED_DIM) {
        finalVector = finalVector.slice(0, EMBED_DIM);
      } else if (finalVector.length < EMBED_DIM) {
        finalVector = [...finalVector, ...new Array(EMBED_DIM - finalVector.length).fill(0)];
      }
      
      items.push({
        id: generateShortId(baseUrl, sourcePath, i),
        vector: finalVector,
        text: text.length > 500 ? text.substring(0, 500) + '...' : text,
        title: title.length > 100 ? title.substring(0, 100) : title,
        source: sourcePath,
        url: baseUrl
      });
      
      console.log(`  ✅ Chunk ${i + 1}/${chunks.length} processed`);
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      console.error(`  ❌ Failed to process chunk ${i + 1}: ${error.message}`);
    }
  }
  
  return items;
}

async function uploadItems(items: any[]): Promise<void> {
  const resp = await fetch(`${WORKER_URL.replace(/\/$/, '')}/admin/upsert`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json', 
      'Authorization': `Bearer ${ADMIN_TOKEN}` 
    },
    body: JSON.stringify({ items }),
    agent: proxyAgent
  });
  
  if (!resp.ok) {
    const msg = await resp.text();
    throw new Error(`Upload failed: ${resp.status} ${msg}`);
  }
}

async function main() {
  console.log('🚀 Adding static pages to RAG system...');
  
  // Find only about and contact pages
  const patterns = [
    '*/about/_index.md',
    '*/contact/_index.md'
  ];
  
  const files = await globby(patterns, { cwd: CONTENT_DIR, absolute: true });
  console.log(`📁 Found ${files.length} static pages to process:`);
  files.forEach(file => console.log(`  - ${path.relative(CONTENT_DIR, file)}`));
  
  if (files.length === 0) {
    console.log('❌ No static pages found');
    return;
  }
  
  let allItems: any[] = [];
  
  for (const file of files) {
    try {
      const items = await processFile(file);
      allItems.push(...items);
    } catch (error) {
      console.error(`❌ Failed to process ${path.relative(CONTENT_DIR, file)}: ${error.message}`);
    }
  }
  
  if (allItems.length > 0) {
    console.log(`\n⬆️  Uploading ${allItems.length} items...`);
    try {
      await uploadItems(allItems);
      console.log('✅ Upload successful!');
    } catch (error) {
      console.error(`❌ Upload failed: ${error.message}`);
    }
  } else {
    console.log('❌ No items to upload');
  }
  
  console.log('\n🎉 Static pages processing completed!');
}

main().catch(e => {
  console.error('💥 Fatal error:', e);
  process.exit(1);
});
