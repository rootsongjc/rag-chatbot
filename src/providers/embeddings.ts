import type { Env } from '../utils/schema';

export interface Embedder {
  embed(texts: string[], dim: number): Promise<number[][]>;
}

export function createEmbedder(env: Env): Embedder {
  if (env.PROVIDER === 'gemini') {
    return {
      async embed(texts, dim) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${env.GOOGLE_API_KEY}`;
        
        // Gemini API doesn't support batch requests, so we need to make individual requests
        const embeddings: number[][] = [];
        
        for (const text of texts) {
          const body = {
            model: 'models/text-embedding-004',
            content: { parts: [{ text: text }] },
            outputDimensionality: dim
          };
          
          console.log('Making Gemini embedding request with text length:', text.length);
          console.log('API URL:', url.substring(0, 80) + '...');
          
          const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          
          if (!resp.ok) {
            const errorText = await resp.text();
            console.error(`Gemini API error details:`, errorText);
            throw new Error(`Gemini embed error: ${resp.status} - ${errorText}`);
          }
          const data = await resp.json();
          embeddings.push((data as any).embedding.values);
        }
        
        return embeddings;
      }
    };
  }
  if (env.PROVIDER === 'qwen') {
    return {
      async embed(texts, dim) {
        const baseUrl = env.QWEN_BASE || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
        const url = baseUrl.endsWith('/embeddings') ? baseUrl : `${baseUrl}/embeddings`;
        const model = env.QWEN_EMBED_MODEL || 'text-embedding-v2';
        
        console.log('=== QWEN EMBEDDING REQUEST DEBUG ===');
        console.log('URL:', url);
        console.log('Model:', model);
        console.log('Texts count:', texts.length);
        console.log('Target dimension:', dim);
        console.log('Input texts preview:', texts.map(t => t.substring(0, 100) + (t.length > 100 ? '...' : '')));
        console.log('API Key prefix:', env.QWEN_API_KEY ? env.QWEN_API_KEY.substring(0, 8) + '...' : 'NOT_SET');
        
        const requestBody = {
          model: model,
          input: texts
        };
        
        console.log('Request body:', JSON.stringify(requestBody, null, 2));
        
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.QWEN_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody)
        });
        
        console.log('Response status:', resp.status);
        console.log('Response headers:', Object.fromEntries([...(resp.headers as any).entries()]));
        
        if (!resp.ok) {
          const errorText = await resp.text();
          console.error('Qwen API error response:', errorText);
          console.log('=== END QWEN DEBUG ===');
          throw new Error(`Qwen embed error: ${resp.status} - ${errorText}`);
        }
        
        const data = await resp.json() as any;
        console.log('Response data structure:', {
          hasData: !!data.data,
          dataLength: data.data ? data.data.length : 0,
          firstItemKeys: data.data && data.data[0] ? Object.keys(data.data[0]) : [],
          firstEmbeddingLength: data.data && data.data[0] && data.data[0].embedding ? data.data[0].embedding.length : 0
        });
        console.log('=== END QWEN DEBUG ===');
        
        // Some providers return longer vectors; truncate if needed
        return (data as any).data.map((d: any) => (d.embedding.length > dim ? d.embedding.slice(0, dim) : d.embedding));
      }
    };
  }
  throw new Error('Unknown PROVIDER');
}
