/**
 * Full reindex script:
 * Forces a complete reindex of all blog content by:
 * 1. Clearing the entire vector database
 * 2. Removing the state file
 * 3. Re-indexing all blog content from scratch
 * 
 * Usage:
 *   PROVIDER=gemini GOOGLE_API_KEY=... ADMIN_TOKEN=... WORKER_URL=https://<your-worker> tsx scripts/full-reindex.ts
 */

import { globby } from 'globby';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const WORKER_URL = process.env.WORKER_URL || '';
const stateFilePath = path.resolve(__dirname, 'ingest_state.json');

if (!ADMIN_TOKEN || !WORKER_URL) {
  console.error('Missing ADMIN_TOKEN or WORKER_URL');
  process.exit(1);
}

// Configure proxy agent for node-fetch
function getProxyAgent() {
  const httpsProxy = process.env.https_proxy || process.env.HTTPS_PROXY;
  if (httpsProxy) {
    console.log(`Using proxy: ${httpsProxy}`);
    return new HttpsProxyAgent(httpsProxy);
  }
  return undefined;
}

const proxyAgent = getProxyAgent();

async function clearVectorDatabase(): Promise<void> {
  console.log('🗑️  Clearing vector database...');
  
  try {
    const response = await fetch(`${WORKER_URL.replace(/\/$/, '')}/admin/clear-all`, {
      method: 'DELETE',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${ADMIN_TOKEN}` 
      },
      agent: proxyAgent
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to clear database: ${response.status} ${errorText}`);
    }
    
    const result = await response.json();
    console.log(`✓ Database cleared. Total deleted: ${result.totalDeleted} vectors`);
  } catch (error) {
    console.error('❌ Failed to clear database:', error.message);
    throw error;
  }
}

async function main() {
  console.log('🔄 Starting full reindex...');
  
  // Step 1: Clear the entire vector database
  await clearVectorDatabase();
  
  // Step 2: Remove the state file to force full reindex
  try {
    await fs.unlink(stateFilePath);
    console.log('✓ Removed previous state file');
  } catch (error) {
    console.log('ℹ No previous state file found');
  }
  
  // Step 3: Import and run the main ingest script
  console.log('📝 Starting content indexing...');
  const { main: ingestMain } = await import('./ingest.js');
  await ingestMain();
  
  console.log('✅ Full reindex completed!');
}

main().catch(e => { 
  console.error('❌ Full reindex failed:', e); 
  process.exit(1); 
});
