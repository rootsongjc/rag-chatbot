/**
 * Generate title translation dictionary without reindexing vector database
 * 
 * This script scans the content directory to find Chinese-English title pairs
 * and creates a translation dictionary for use in the retriever.
 */

import 'dotenv/config';
import { globby } from 'globby';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONTENT_DIR = process.env.CONTENT_DIR || path.resolve(process.cwd(), '../../content');

async function generateTitleDictionary() {
  console.log('🔍 Generating title translation dictionary...');
  
  // Find all blog files (both languages)
  const patterns = [
    'zh/blog/**/index.md',
    'en/blog/**/index.md'
  ];
  
  const allFiles = await globby(patterns, { cwd: CONTENT_DIR, absolute: true });
  
  // Build mapping of post paths to files
  const postFiles = new Map<string, { zh?: string, en?: string }>();
  
  for (const file of allFiles) {
    const relativePath = path.relative(CONTENT_DIR, file);
    const postPath = relativePath.replace(/^(zh|en)\/blog\//, '').replace('/index.md', '');
    const lang = relativePath.startsWith('zh/') ? 'zh' : 'en';
    
    if (!postFiles.has(postPath)) {
      postFiles.set(postPath, {});
    }
    
    postFiles.get(postPath)![lang] = file;
  }
  
  console.log(`📊 Found ${postFiles.size} unique blog posts`);
  
  // Generate title dictionary
  const titleDictionary: { [chineseTitle: string]: string } = {};
  let pairsFound = 0;
  let chineseOnly = 0;
  let englishOnly = 0;
  
  for (const [postPath, files] of postFiles) {
    const zhFile = files.zh;
    const enFile = files.en;
    
    if (zhFile && enFile) {
      // Both versions exist - create title mapping
      try {
        const zhContent = await fs.readFile(zhFile, 'utf-8');
        const enContent = await fs.readFile(enFile, 'utf-8');
        
        const zhMatter = matter(zhContent);
        const enMatter = matter(enContent);
        
        const zhTitle = zhMatter.data?.title || zhMatter.data?.Title;
        const enTitle = enMatter.data?.title || enMatter.data?.Title;
        
        if (zhTitle && enTitle) {
          titleDictionary[zhTitle] = enTitle;
          pairsFound++;
          console.log(`✅ ${postPath}: "${zhTitle}" -> "${enTitle}"`);
        }
      } catch (error) {
        console.error(`❌ Error processing ${postPath}:`, error.message);
      }
    } else if (zhFile && !enFile) {
      chineseOnly++;
    } else if (enFile && !zhFile) {
      englishOnly++;
    }
  }
  
  // Save dictionary to JSON file
  const dictPath = path.resolve(__dirname, '../src/rag/title-dictionary.json');
  await fs.writeFile(dictPath, JSON.stringify(titleDictionary, null, 2), 'utf-8');
  
  console.log('\n🎉 Title dictionary generated successfully!');
  console.log(`📈 Statistics:`);
  console.log(`   - Bilingual pairs: ${pairsFound}`);
  console.log(`   - Chinese only: ${chineseOnly}`);
  console.log(`   - English only: ${englishOnly}`);
  console.log(`   - Dictionary saved to: ${dictPath}`);
  
  // Also generate TypeScript declaration for better IDE support
  const tsContent = `// Auto-generated title dictionary
export const titleDictionary: { [chineseTitle: string]: string } = ${JSON.stringify(titleDictionary, null, 2)};

export function translateTitleToEnglish(chineseTitle: string): string {
  return titleDictionary[chineseTitle] || chineseTitle;
}
`;
  
  const tsPath = path.resolve(__dirname, '../src/rag/title-dictionary.ts');
  await fs.writeFile(tsPath, tsContent, 'utf-8');
  console.log(`   - TypeScript file saved to: ${tsPath}`);
}

generateTitleDictionary().catch(e => {
  console.error('💥 Fatal error:', e);
  process.exit(1);
});
