# Website RAG Chatbot

Build an embeddable RAG Chatbot for your website using Cloudflare Workers. The JavaScript widget is stored locally for easy maintenance.
Data source: The `content/` directory (Markdown) of your Hugo website repository `website`.
Model backend: Switchable between Gemini and Qwen (Tongyi Qianwen).

## Features

- Markdown -> Plain text -> Chunking -> Embedding -> Write to Vectorize
- /chat: Retrieve Top-K chunks + assemble prompt + call LLM to generate Chinese answers
- Returns source references (source, url)
- Embeddable frontend `widget.js` for your Hugo site

## Directory Structure

See the repository tree (`src/`, `scripts/`).

## Prerequisites

1. **Cloudflare account** + `wrangler` installed
2. **Create a Vectorize index** (dimension consistent with `wrangler.toml`, default 1024), and bind in `wrangler.toml`:

   ```toml
   [[vectorize]]
   binding = "VECTORIZE"
   index_name = "website-rag"
   ```

3. **Set Secrets / Vars**

   ```bash
   wrangler secret put ADMIN_TOKEN # For Vectorize admin API
   wrangler secret put GOOGLE_API_KEY     # If PROVIDER=gemini
   wrangler secret put QWEN_API_KEY       # If PROVIDER=qwen
   # (Optional) wrangler secret put QWEN_BASE
   # (Optional) wrangler secret put QWEN_EMBED_MODEL
   ```

   And set in `[vars]` of `wrangler.toml`: `PROVIDER`, `EMBED_DIM`, `LLM_MODEL`.

## Development & Deployment

1. Install dependencies:

   ```bash
   npm i
   ```

2. Local development (Cloudflare login required):

   ```bash
   npm run dev
   ```

3. Deploy to Cloudflare:

   ```bash
   npm run deploy
   ```

4. Save `widget.js` locally and ensure your site references it:
   - Reference the local `widget.js` path in your HTML.

## Ingest Your Hugo Content

Run locally (Node 20+):

```bash
# Example:
PROVIDER=gemini \
GOOGLE_API_KEY=your_google_api_key \
ADMIN_TOKEN=your_admin_token \
WORKER_URL=https://<your-worker>.workers.dev \
CONTENT_DIR=../website/content \
BASE_URL=https://your-site.com \
EMBED_DIM=1024 \
npm run ingest
```

Or switch to Qwen:

```bash
PROVIDER=qwen \
QWEN_API_KEY=your_qwen_api_key \
ADMIN_TOKEN=your_admin_token \
WORKER_URL=https://<your-worker>.workers.dev \
CONTENT_DIR=../website/content \
BASE_URL=https://your-site.com \
EMBED_DIM=1024 \
npm run ingest
```

> Tip: Ensure the Vectorize index dimension (e.g., 1024) matches the embedding dimension.

## Embed in Your Website

In your Hugo template (e.g., `layouts/partials/footer.html`), add the following, referencing your local JavaScript path:

```html
<script
  src="/path/to/your/local/widget.js"
  data-endpoint="https://<your-worker>.workers.dev"
  defer
></script>
```

This will display the chat widget in the bottom right corner of your site.

## Customization & Improvements

- **Rerank**: Call a rerank model on retrieval results to improve relevance.
- **Chunking strategy**: Optimize chunk length based on Chinese punctuation and headings.
- **Source links**: The mapping in `scripts/ingest.ts`'s `toUrlFromPath` can be further refined with Hugo routing rules.
- **Conversation memory**: Integrate KV / D1 to store user chat history for summarization and compression.

## Detailed Operation Guide

### Full Reindex

To completely rebuild the vector index, follow these steps:

1. **Clear the index**:

   ```bash
   # Use the admin API to clear all vector data
   curl -X DELETE "https://<your-worker-url>/admin/clear-all" \
     -H "Authorization: Bearer $ADMIN_TOKEN"
   ```

2. **Perform full reindex**:

   ```bash
   npm run full-reindex
   ```

   This command will automatically clear the database and reindex all content.

3. **ADMIN_TOKEN Permission Notes**:
   - `ADMIN_TOKEN` authorizes admin operations (clear DB, batch upload, etc.)
   - Store securely, usually as an environment variable or Cloudflare Secret
   - Has full DB read/write permissions—keep it safe

### First-Time Initialization

For first deployment, complete these steps:

1. **Create Vectorize index**:

   ```bash
   # Create vector index in Cloudflare console
   # Or use wrangler command (if supported)
   wrangler vectorize create website-rag --dimensions=1024
   ```

2. **Configure embedding dimension**:
   In `wrangler.toml`:

   ```toml
   [vars]
   EMBED_DIM = 1024  # Must match Vectorize index dimension
   PROVIDER = "qwen"  # Or "gemini"
   ```

3. **Initial run of indexing**:

   ```bash
   # Run after configuring all required env variables
   PROVIDER=qwen \
   QWEN_API_KEY=your_qwen_api_key \
   ADMIN_TOKEN=your_admin_token \
   WORKER_URL=https://<your-worker>.workers.dev \
   CONTENT_DIR=../website/content \
   EMBED_DIM=1024 \
   npm run ingest
   ```

### Bilingual Blog Extraction

Supports extracting and updating new Chinese/English bilingual blog content:

1. **Extract new blogs**: Use `manual-ingest.ts` to extract new bilingual blogs, ensuring the vector DB contains the latest content.

   ```bash
   # Extract a single Chinese blog
   npm run manual-ingest ../../content/zh/blog/new-post/index.md

   # Extract a single English blog
   npm run manual-ingest ../../content/en/blog/new-post/index.md

   # Extract both Chinese and English versions
   npm run manual-ingest ../../content/zh/blog/new-post/index.md ../../content/en/blog/new-post/index.md
   ```

2. **Update title dictionary**: After adding new bilingual blogs, regenerate the title mapping file to support title translation.

   ```bash
   npm run generate-titles
   ```

#### Bilingual Blog Extraction Workflow

On initialization, the system processes bilingual blogs as follows:

1. **Deduplication strategy**:
   - Scans all blogs under `content/zh/blog/` and `content/en/blog/`
   - For blogs with both Chinese and English versions, **Chinese version is prioritized** for vectorization
   - Only extracts English version if Chinese is absent
   - Each vector entry includes a `language` metadata field for language filtering during retrieval

2. **Title mapping file generation**:
   - `generate-title-dictionary.ts` scans all blogs with both Chinese and English versions
   - Extracts `title` or `Title` from frontmatter
   - Generates a mapping from Chinese to English titles
   - Saves as both JSON and TypeScript:
     - `src/rag/title-dictionary.json`
     - `src/rag/title-dictionary.ts`

3. **Recommended bilingual blog update workflow**:

   For new bilingual blogs, follow this order:

   ```bash
   # Step 1: Extract vector data
   npm run manual-ingest ../../content/zh/blog/new-post/index.md ../../content/en/blog/new-post/index.md
   # Step 2: Update title dictionary
   npm run generate-title-dict
   ```

   This ensures the vector DB has the latest content and title translation works properly.

4. **Language retrieval mechanism**:
   - On user query, the system filters by current page language (zh/en)
   - Returns content in the corresponding language first; falls back to all languages if not found
   - Supports auto-detecting language by URL path (`/en/` for English, others for Chinese)

### Single File Upload

For updating the index with single or a few files:

1. **Upload a single file with script**:

```bash
# Upload a specific Markdown file
npm run manual-ingest ../website/content/blog/new-post.md

# Upload multiple files
npm run manual-ingest file1.md file2.md file3.md
```

2. **Upload directly via API** (advanced):

   ```bash
   # Call the Worker's admin API directly
   curl -X POST "https://<your-worker-url>/admin/upsert" \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "items": [{
         "id": "doc-1",
         "vector": [0.1, 0.2, ...],
         "text": "Document content",
         "source": "blog/example.md",
         "title": "Sample Article",
         "url": "https://your-site.com/blog/example/"
       }]
     }'
   ```

### Cloudflare Configuration Details

Full Cloudflare environment setup steps:

1. **Wrangler authentication**:

   ```bash
   # Log in to Cloudflare
   wrangler login

   # Verify login status
   wrangler whoami
   ```

2. **Configure wrangler.toml**:

   ```toml
   name = "website-rag-worker"
   main = "src/worker.ts"
   compatibility_date = "2024-07-01"

   # Environment variables
   [vars]
   PROVIDER = "qwen"                    # Model provider: gemini or qwen
   EMBED_DIM = 1024                     # Embedding dimension, must match index
   LLM_MODEL = "qwen-turbo-latest"      # LLM model name
   QWEN_EMBED_MODEL = "text-embedding-v4"  # Qwen embedding model

   # Vectorize binding
   [[vectorize]]
   binding = "VECTORIZE"
   index_name = "website-rag"           # Index name

   # Optional: KV storage binding (for chat memory, etc.)
   # [[kv_namespaces]]
   # binding = "CHAT_HISTORY"
   # id = "your-kv-namespace-id"
   ```

3. **Set environment variables and secrets**:

   ```bash
   # Required secrets
   wrangler secret put ADMIN_TOKEN      # Admin token

   # Set according to PROVIDER
   wrangler secret put GOOGLE_API_KEY   # Gemini API key
   wrangler secret put QWEN_API_KEY     # Qwen API key

   # Optional
   wrangler secret put QWEN_BASE        # Custom Qwen API endpoint
   ```

4. **Deploy and test**:

   ```bash
   # Build project
   npm run build

   # Local test
   npm run dev

   # Deploy to production
   npm run deploy
   ```

5. **Billing notes**:
   - **Vectorize**: Billed by vector count and query times
   - **Workers**: Billed by request count and CPU time
   - **KV** (if used): Billed by storage and operation count
   - Monitor usage and set appropriate limits
   - Free tier available for development/testing

### Troubleshooting

1. **Embedding dimension mismatch**:
   Ensure `EMBED_DIM` matches the Vectorize index dimension

2. **API quota exceeded**:
   Adjust `MAX_CONCURRENT_EMBEDDINGS` and batch size parameters

3. **Permission errors**:
   Check if `ADMIN_TOKEN` is set correctly and not expired

4. **Network proxy**:
   Set `https_proxy` environment variable if needed

## License

Apache License, Version 2.0
