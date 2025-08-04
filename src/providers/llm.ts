import type { Env } from '../utils/schema';

export async function llmGenerate(env: Env, prompt: string): Promise<string> {
  if (env.PROVIDER === 'gemini') {
    if (!env.GOOGLE_API_KEY) {
      throw new Error('GOOGLE_API_KEY is required when using Gemini provider');
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.LLM_MODEL || 'gemini-2.5-flash'}:generateContent?key=${env.GOOGLE_API_KEY}`;
    const body = { contents: [{ parts: [{ text: prompt }] }] };
    
    console.log('Calling Gemini API with model:', env.LLM_MODEL || 'gemini-2.5-flash-lite');
    
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    
    if (!r.ok) {
      const errorText = await r.text();
      console.error('Gemini API error:', r.status, errorText);
      throw new Error(`Gemini generate error: ${r.status} - ${errorText}`);
    }
    
    const j = await r.json();
    console.log('Gemini response:', JSON.stringify(j, null, 2));
    
    const parts = (j as any).candidates?.[0]?.content?.parts || [];
    const result = parts.map((p: any) => p.text || '').join('');
    
    console.log('Generated answer:', result);
    return result;
  }
  if (env.PROVIDER === 'qwen') {
    const url = env.QWEN_CHAT_BASE || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
    const body = {
      model: env.LLM_MODEL || 'qwen-plus',
      messages: [
        { role: 'system', content: '请用中文回答，并在末尾列出来源路径。' },
        { role: 'user', content: prompt }
      ]
    };
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.QWEN_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`Qwen generate error: ${r.status}`);
    const j = await r.json();
    return (j as any).choices?.[0]?.message?.content || '';
  }
  throw new Error('Unknown PROVIDER');
}
