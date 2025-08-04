import 'dotenv/config';
import { processFile, uploadBatch } from './fast-ingest';
import path from 'node:path';
import fs from 'node:fs/promises';

// Get command line arguments, skipping the first two fixed arguments
const args = process.argv.slice(2);

async function manualIngest(filePaths: string[]) {
  console.log('🚀 Manually ingesting specified files...');
  
  for (const filePath of filePaths) {
    try {
      const fullPath = path.resolve(process.cwd(), filePath);
      // Check if the file exists
      await fs.access(fullPath);

      const items = await processFile(fullPath);
      console.log(`✅ Processed ${fullPath}: ${items.length} chunks`);
      
      if (items.length > 0) {
        await uploadBatch(items);
        console.log(`⬆️  Uploaded items from ${fullPath}`);
      }
      
    } catch (error) {
      console.error(`❌ Failed to process ${filePath}: ${error.message}`);
    }
  }

  console.log('🎉 Manual ingestion completed');
}

if (args.length === 0) {
  console.error('Usage: npm run manual-ingest <file1> <file2> ...');
  process.exit(1);
} else {
  manualIngest(args).catch(error => {
    console.error('💥 Error during manual ingestion:', error);
    process.exit(1);
  });
}
