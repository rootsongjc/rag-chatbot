export type MatchMeta = {
  text?: string;
  source?: string;
  title?: string;
  url?: string;
  language?: string;
};

export interface VectorizeIndex {
  upsert(items: { id: string; values: number[]; metadata?: Record<string, any> }[]): Promise<void>;
  query(vector: number[], opts: { 
    topK: number; 
    returnValues?: boolean; 
    includeMetadata?: boolean;
    returnMetadata?: string;
    filter?: { metadata: Record<string, any> };
  }): Promise<{
    matches: { id: string; score: number; metadata?: MatchMeta }[];
  }>;
}

export interface Env {
  VECTORIZE: VectorizeIndex;

  PROVIDER: 'gemini' | 'qwen';
  GOOGLE_API_KEY?: string;
  QWEN_API_KEY?: string;
  QWEN_BASE?: string;
  QWEN_EMBED_MODEL?: string;
  QWEN_CHAT_BASE?: string;

  LLM_MODEL?: string;
  ADMIN_TOKEN: string;
  EMBED_DIM: string;
}
