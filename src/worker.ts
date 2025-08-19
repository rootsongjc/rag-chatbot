import type { Env } from './utils/schema';
import { createEmbedder } from './providers/embeddings';
import { buildPrompt } from './rag/prompt';
import { llmGenerate } from './providers/llm';
import { getRelevantDocuments, retrieve } from './rag/retriever';

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext) {
    const url = new URL(req.url);
    
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        headers: corsHeaders
      });
    }

    if (req.method === 'POST' && url.pathname === '/chat') {
      try {
        const { message, history = [], language = 'zh' } = await req.json() as { message: string; history?: Array<{type: 'user' | 'bot', content: string}>; language?: string };
        
        if (!message || typeof message !== 'string') {
          return new Response(JSON.stringify({ error: 'Invalid message parameter' }), { 
            status: 400, 
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }

        console.log('Chat request:', message);
        console.log('History length:', history.length);
        console.log('Language:', language);

        const embedder = createEmbedder(env);
        
        // For vector retrieval, use only the current message to avoid history interference
        // We'll include history later in the prompt construction
        const [qv] = await embedder.embed([message], Number(env.EMBED_DIM));
        
        console.log('Using current message for vector search:', message);
        console.log('Query vector length:', qv.length);

        // Use new getRelevantDocuments function with metadata filtering and fallback
        const { contexts, sources, usedFallback } = await getRelevantDocuments(env, qv, 8, language);
        console.log('Used fallback:', usedFallback);
        
        console.log('Final contexts:', contexts.length, 'chars');
        console.log('Final sources:', sources);
        
        const prompt = buildPrompt(message, contexts, history, language);
        console.log('Prompt length:', prompt.length);
        
        const answer = await llmGenerate(env, prompt);
        console.log('Generated answer:', answer);
        
        return new Response(JSON.stringify({ answer, sources }), {
          headers: { 
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
        
      } catch (error) {
        console.error('Chat endpoint error:', error);
        return new Response(JSON.stringify({ 
          error: error.message || 'Internal server error',
          details: error.stack
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
    }

    if (req.method === 'POST' && url.pathname === '/admin/upsert') {
      const auth = req.headers.get('authorization') || '';
      if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return new Response('Unauthorized', { status: 401 });

      try {
        const payload = await req.json() as {
          items: { id: string; vector: number[]; text: string; source?: string; title?: string; url?: string }[]
        };

        console.log(`Upserting ${payload.items.length} items`);
        
        const vectors = payload.items.map(it => {
          if (!Array.isArray(it.vector) || it.vector.length !== Number(env.EMBED_DIM)) {
            throw new Error(`Invalid vector dimension: expected ${env.EMBED_DIM}, got ${it.vector?.length || 'undefined'}`);
          }
          return {
            id: it.id,
            values: it.vector,
            metadata: { text: it.text, source: it.source, title: it.title, url: it.url }
          };
        });

        await env.VECTORIZE.upsert(vectors);
        console.log('Upsert successful');

        return new Response(JSON.stringify({ ok: true, count: payload.items.length }), { 
          headers: { 'Content-Type': 'application/json' } 
        });
      } catch (error) {
        console.error('Upsert error:', error);
        return new Response(JSON.stringify({ 
          error: error.message || 'Internal server error',
          details: error.stack 
        }), { 
          status: 500, 
          headers: { 'Content-Type': 'application/json' } 
        });
      }
    }

    if (req.method === 'DELETE' && url.pathname === '/admin/delete') {
      const auth = req.headers.get('authorization') || '';
      if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return new Response('Unauthorized', { status: 401 });

      try {
        const payload = await req.json() as {
          ids: string[];
        };

        console.log(`Deleting ${payload.ids.length} vectors`);
        
        await (env.VECTORIZE as any).deleteByIds(payload.ids);
        console.log('Delete successful');

        return new Response(JSON.stringify({ ok: true, count: payload.ids.length }), { 
          headers: { 'Content-Type': 'application/json' } 
        });
      } catch (error) {
        console.error('Delete error:', error);
        return new Response(JSON.stringify({ 
          error: error.message || 'Internal server error',
          details: error.stack 
        }), { 
          status: 500, 
          headers: { 'Content-Type': 'application/json' } 
        });
      }
    }

    if (req.method === 'DELETE' && url.pathname === '/admin/clear-all') {
      const auth = req.headers.get('authorization') || '';
      if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return new Response('Unauthorized', { status: 401 });

      try {
        console.log('Clearing all vectors from database...');
        
        // Note: Cloudflare Vectorize doesn't have a direct "clear all" method
        // We need to query all vectors and delete them in batches
        let totalDeleted = 0;
        let hasMore = true;
        
        while (hasMore) {
          // Query vectors in batches (using a dummy vector for query)
          const dummyVector = new Array(Number(env.EMBED_DIM)).fill(0);
          const queryResult = await env.VECTORIZE.query(dummyVector, { 
            topK: 100, // Max batch size (Cloudflare limit)
            returnValues: false, 
            includeMetadata: false 
          });
          
          if (queryResult.matches.length === 0) {
            hasMore = false;
            break;
          }
          
          const idsToDelete = queryResult.matches.map(match => match.id);
          await (env.VECTORIZE as any).deleteByIds(idsToDelete);
          totalDeleted += idsToDelete.length;
          
          console.log(`Deleted ${idsToDelete.length} vectors (total: ${totalDeleted})`);
          
          // If we got less than the batch size, we're done
          if (queryResult.matches.length < 100) {
            hasMore = false;
          }
        }
        
        console.log(`Clear all completed. Total deleted: ${totalDeleted}`);
        return new Response(JSON.stringify({ ok: true, totalDeleted }), { 
          headers: { 'Content-Type': 'application/json' } 
        });
      } catch (error) {
        console.error('Clear all error:', error);
        return new Response(JSON.stringify({ 
          error: error.message || 'Internal server error',
          details: error.stack 
        }), { 
          status: 500, 
          headers: { 'Content-Type': 'application/json' } 
        });
      }
    }

    if (req.method === 'POST' && url.pathname === '/debug') {
      const { message } = await req.json() as { message: string };
      if (!message || typeof message !== 'string') return new Response('bad request', { status: 400 });

      const embedder = createEmbedder(env);
      const [qv] = await embedder.embed([message], Number(env.EMBED_DIM));

      // Try different query options
      console.log('Testing different query options...');
      
      const res1 = await env.VECTORIZE.query(qv, { topK: 1, returnValues: false, includeMetadata: true });
      console.log('Query with topK=1:', JSON.stringify({
        matches: res1.matches.length,
        hasMetadata: res1.matches.length > 0 ? !!res1.matches[0].metadata : false
      }));
      
      const res2 = await env.VECTORIZE.query(qv, { topK: 1, returnValues: true, includeMetadata: true });
      console.log('Query with returnValues=true:', JSON.stringify({
        matches: res2.matches.length,
        hasMetadata: res2.matches.length > 0 ? !!res2.matches[0].metadata : false
      }));

      const res = res1;
      
      return new Response(JSON.stringify({
        query: message,
        vectorLength: qv.length,
        matchCount: res.matches.length,
        matches: res.matches.map(m => ({
          id: m.id,
          score: m.score,
          hasMetadata: !!m.metadata,
          metadata: m.metadata
        }))
      }, null, 2), {
        headers: { 
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }

    if (req.method === 'POST' && url.pathname === '/admin/test-query') {
      const auth = req.headers.get('authorization') || '';
      if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return new Response('Unauthorized', { status: 401 });

      try {
        const { queryVector, topK = 5 } = await req.json() as { queryVector: number[]; topK?: number };
        
        console.log('=== ADMIN TEST QUERY ===');
        console.log('Query vector length:', queryVector.length);
        console.log('TopK:', topK);
        
        // Try different query configurations
        const tests = [
          { name: 'includeMetadata=true, returnValues=false', options: { topK, includeMetadata: true, returnValues: false } },
          { name: 'includeMetadata=true, returnValues=true', options: { topK, includeMetadata: true, returnValues: true } },
          { name: 'includeMetadata=false, returnValues=false', options: { topK, includeMetadata: false, returnValues: false } },
        ];
        
        const results = [];
        
        for (const test of tests) {
          console.log(`Testing: ${test.name}`);
          try {
            const queryRes = await env.VECTORIZE.query(queryVector, test.options);
            const result = {
              testName: test.name,
              matchCount: queryRes.matches.length,
              matches: queryRes.matches.map(m => ({
                id: m.id,
                score: m.score,
                hasMetadata: !!m.metadata,
                metadataKeys: m.metadata ? Object.keys(m.metadata) : [],
                textPreview: m.metadata?.text ? m.metadata.text.substring(0, 100) + '...' : null
              }))
            };
            results.push(result);
            console.log(`${test.name} - matches: ${queryRes.matches.length}, first has metadata: ${!!queryRes.matches[0]?.metadata}`);
          } catch (error) {
            console.error(`Error in test ${test.name}:`, error);
            results.push({
              testName: test.name,
              error: error.message
            });
          }
        }
        
        console.log('=== END ADMIN TEST ===');
        
        return new Response(JSON.stringify({ results }, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error('Admin test query error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (req.method === 'GET' && url.pathname === '/network-debug') {
      const headers = Object.fromEntries([...(req.headers as any).entries()]);
      const debugInfo = {
        url: req.url,
        method: req.method,
        headers: headers,
        cf: req.cf || {},
        timestamp: new Date().toISOString()
      };
      
      return new Response(JSON.stringify(debugInfo, null, 2), {
        headers: { 
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }

    if (req.method === 'GET' && url.pathname === '/widget.js') {
      const widgetJS = `// AI Chatbot Widget v2.0
(function() {
    'use strict';
    
    // Get endpoint from script tag data attribute
    const script = document.currentScript || document.querySelector('script[data-endpoint]');
    const ENDPOINT = script?.getAttribute('data-endpoint') || window.location.origin;
    
    // Detect page language
    function detectLanguage() {
        // Try multiple methods to detect language
        const htmlLang = document.documentElement.lang;
        const urlPath = window.location.pathname;
        const navigatorLang = navigator.language || navigator.userLanguage;
        
        // Check URL path for language indicators (highest priority)
        // Only use English for /en/* pages, everything else defaults to Chinese
        if (urlPath.startsWith('/en/')) {
            return 'en';
        }
        
        // For all other cases, default to Chinese
        // This includes:
        // - /zh/* pages
        // - Root pages like /blog/, /about/, etc.
        // - Any other URL pattern
        return 'zh';
    }
    
    const LANGUAGE = detectLanguage();
    
    // Debug: log detailed detection info
    // console.log('[AI Chatbot v2.0] Language Detection Debug:');
    // console.log('- HTML lang:', document.documentElement.lang);
    // console.log('- URL path:', window.location.pathname);
    // console.log('- URL includes /en/:', window.location.pathname.includes('/en/'));
    // console.log('- URL includes /zh/:', window.location.pathname.includes('/zh/'));
    // console.log('- Navigator lang:', navigator.language || navigator.userLanguage);
    // console.log('- Final detected language:', LANGUAGE);
    
    // Multi-language text
    const TEXTS = {
        zh: {
            title: 'Jimmy 的 AI 助理',
            placeholder: '有什么可以帮您的吗？',
            welcome: '您好！我是 Jimmy 的 AI 助理，可以帮您了解 Jimmy 的技术见解和经验分享。有什么想了解的吗？',
            sources: '参考资料',
            error: '抱歉，我暂时无法回应，请稍后再试。',
            connecting: '连接中...',
            thinking: '正在思考...',
            copy: '复制',
            copied: '已复制'
        },
        en: {
            title: 'Jimmy\\'s AI Assistant',
            placeholder: 'What can I help you with?',
            welcome: 'Hello! I\\'m Jimmy\\'s AI assistant. I can help you explore Jimmy\\'s technical insights and experience. What would you like to know?',
            sources: 'References',
            error: 'Sorry, I\\'m temporarily unavailable. Please try again later.',
            connecting: 'Connecting...',
            thinking: 'Thinking...',
            copy: 'Copy',
            copied: 'Copied!'
        }
    };
    
    const t = TEXTS[LANGUAGE];
    
    // Mobile detection
    const isMobile = /iPhone|iPad|iPod|Android|webOS|BlackBerry|Windows Phone/i.test(navigator.userAgent) ||
                     window.innerWidth <= 768;
    
    let isExpanded = false;
    let isDragging = false;
    let dragOffset = { x: 0, y: 0 };
    let userDraggedPosition = null; // 记录用户拖拽后的位置
    let savedScrollY = 0; // 记录页面滚动位置
    
    // Create styles
    const style = document.createElement('style');
    style.textContent = \`
        /* Scroll lock for body when widget is expanded on mobile */
        body.ai-chatbot-scroll-lock {
            overflow: hidden !important;
            position: fixed !important;
            width: 100% !important;
            height: 100% !important;
        }

        /* Mobile full-screen overlay with proper event handling */
        .ai-chatbot-widget.is-expanded {
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            height: 100dvh !important;
            z-index: 999999 !important;
            background: rgba(0, 0, 0, 0.5) !important;
            border-radius: 0 !important;
            transform: none !important;
            overflow: hidden !important;
        }
        .ai-chatbot-widget {
            position: fixed;
            right: 0px;
            top: 50%;
            transform: translateY(-50%);
            z-index: 10000;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            transition: all 0.3s ease;
        }

        .ai-chatbot-widget.mobile-right {  
            right: 0 !important;
            left: auto !important;
        }
        
        .ai-chatbot-widget.ai-chatbot-collapsed {
            touch-action: none; /* Only prevent touch on collapsed state */
        }
        
        .ai-chatbot-collapsed {
            /* 桌面端：右侧边缘标签样式，显示图标 */
            width: 48px;
            height: 120px;
            border-radius: 14px 0 0 14px;
            right: 0px;
            left: auto;
            top: 50%;
            transform: translateY(-50%);
            padding: 8px 4px;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            background: rgba(255, 255, 255, 0.1);
            border: 1px solid rgba(0, 0, 0, 0.1);
            cursor: pointer;
            box-shadow: 0 4px 20px rgba(0,0,0,0.15);
            user-select: none;
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
        }
        
        /* 移动端：更窄的标签，显示三点 */
        .ai-chatbot-collapsed.mobile-tab {
            width: 24px;
            height: 100px;
        }
        /* Dark mode support for collapsed widget */
        .dark-mode .ai-chatbot-collapsed {
            background: rgba(45, 55, 72, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.1);
        }
        
        .dark-mode .ai-chatbot-collapsed.mobile-tab {
            background: rgba(45, 55, 72, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.1);
        }
        
        /* 桌面端显示聊天图标 */
        .ai-chatbot-collapsed .ai-chatbot-icon {
            color: #666;
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 4px;
        }
        
        .dark-mode .ai-chatbot-collapsed .ai-chatbot-icon {
            color: #a0aec0;
        }
        
        /* 桌面端显示文字 */
        .ai-chatbot-collapsed .ai-chatbot-text {
            font-size: 8px;
            font-weight: 600;
            color: #666;
            line-height: 1;
            text-align: center;
            letter-spacing: 0.5px;
        }
        
        .ai-chatbot-collapsed .ai-chatbot-text div {
            margin: 1px 0;
        }
        
        .dark-mode .ai-chatbot-collapsed .ai-chatbot-text {
            color: #a0aec0;
        }
        
        /* 移动端隐藏图标，显示三点 */
        .ai-chatbot-collapsed.mobile-tab .ai-chatbot-icon {
            display: none;
        }
        
        .ai-chatbot-collapsed.mobile-tab::after {
            content: "⋮";
            font-size: 24px;
            color: #666;
            font-weight: 600;
            line-height: 1;
            opacity: 0.8;
        }
        
        .dark-mode .ai-chatbot-collapsed.mobile-tab::after {
            color: #a0aec0;
        }
        
        .rotated-text {
            display: none; /* Not needed for dots design */
        }

        @media (max-width: 768px) {
            .ai-chatbot-widget.is-expanded .ai-chatbot-expanded {
                position: absolute !important;
                top: 50% !important;
                left: 50% !important;
                transform: translate(-50%, -50%) !important;
                width: 90vw !important;
                height: 85vh !important;
                max-width: none !important;
                max-height: none !important;
                border-radius: 12px !important;
                display: flex !important;
                flex-direction: column !important;
                overflow: hidden !important;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3) !important;
            }
            
            .ai-chatbot-widget.is-expanded .ai-chatbot-header {
                flex-shrink: 0;
                position: relative;
                z-index: 1;
            }
            
            .ai-chatbot-widget.is-expanded .ai-chatbot-messages {
                flex: 1 1 auto;
                overflow-y: auto !important;
                overflow-x: hidden !important;
                padding: 15px !important;
                -webkit-overflow-scrolling: touch !important;
                touch-action: pan-y !important;
                position: relative;
                z-index: 0;
            }

            .ai-chatbot-widget.is-expanded .ai-chatbot-input-container {
                flex-shrink: 0;
                padding: 15px !important;
                padding-bottom: calc(15px + env(safe-area-inset-bottom, 20px)) !important;
                background: white !important;
                border-top: 1px solid #e9ecef !important;
                position: relative;
                z-index: 1;
            }
            
            .dark-mode .ai-chatbot-widget.is-expanded .ai-chatbot-input-container {
                background: #2d3748 !important;
                border-top: 1px solid #4a5568 !important;
            }
        }
        
        .ai-chatbot-icon {
            color: white;
            font-size: 24px;
            font-weight: bold;
        }
        
        .ai-chatbot-expanded {
            position: fixed;
            right: 20px;
            bottom: 20px;
            width: 494px;
            height: 800px;
            border-radius: 12px;
            background: white;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            display: flex;
            flex-direction: column;
            overflow: hidden;
            z-index: 10001;
        }
        
        .dark-mode .ai-chatbot-expanded {
            background: #2d3748;
            box-shadow: 0 10px 40px rgba(0,0,0,0.4);
        }
        
        .ai-chatbot-header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 15px;
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
            user-select: none;
        }
        
        .ai-chatbot-title {
            font-weight: 600;
            font-size: 16px;
        }
        
        .ai-chatbot-slogan {
            font-size: 12px;
            font-weight: 400;
            opacity: 0.85;
            margin-top: 2px;
            font-style: italic;
        }
        
        .ai-chatbot-close {
            background: none;
            border: none;
            color: white;
            font-size: 24px;
            cursor: pointer;
            padding: 0;
            width: 40px;
            height: 40px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 50%;
            transition: background-color 0.2s;
        }
        
        .ai-chatbot-close:hover {
            background-color: rgba(255,255,255,0.2);
        }

        .ai-chatbot-messages {
            flex: 1;
            padding: 15px;
            background: #f8f9fa;
            overflow-y: auto;
            -webkit-overflow-scrolling: touch;   /* smooth momentum scroll on iOS */
            overscroll-behavior: contain;        /* stop scroll chaining */
            position: relative;                  /* Ensure proper positioning */
            max-height: 100%;                    /* Prevent overflow issues */
        }

        .dark-mode .ai-chatbot-messages {
            background: #1a202c;
        }
        
        /* Ensure proper scrolling on mobile devices */
        @media (max-width: 768px) {
            .ai-chatbot-widget.is-expanded .ai-chatbot-messages {
                -webkit-overflow-scrolling: touch;
                touch-action: pan-y;
            }
        }
        
        .ai-chatbot-message {
            margin-bottom: 15px;
            animation: slideIn 0.3s ease;
        }
        
        @keyframes slideIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        .ai-chatbot-message-user {
            text-align: right;
        }
        
        .ai-chatbot-message-user .ai-chatbot-message-content {
            background: #667eea;
            color: white;
            border-radius: 18px 18px 4px 18px;
        }
        
        .ai-chatbot-message-bot .ai-chatbot-message-content {
            background: white;
            color: #333;
            border-radius: 18px 18px 18px 4px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        
        .dark-mode .ai-chatbot-message-bot .ai-chatbot-message-content {
            background: #4a5568;
            color: #e2e8f0;
            box-shadow: 0 1px 3px rgba(0,0,0,0.3);
        }
        
        .ai-chatbot-message-content {
            display: inline-block;
            padding: 10px 16px;
            max-width: 95%;
            word-wrap: break-word;
            line-height: 1.4;
            ol, ul {
              list-style-type: disc;
              margin: 0;
              padding-inline-start: 1rem;
            }
        }
        
        .ai-chatbot-sources {
            margin-top: 8px;
            font-size: 12px;
            opacity: 0.8;
        }
        
        .ai-chatbot-source-link {
            display: inline-block;
            margin-right: 8px;
            color: #667eea;
            text-decoration: none;
            padding: 2px 6px;
            background: rgba(102, 126, 234, 0.1);
            border-radius: 4px;
            transition: all 0.2s;
        }
        
        .ai-chatbot-source-link:hover {
            background: rgba(102, 126, 234, 0.2);
            text-decoration: underline;
        }
        
        .dark-mode .ai-chatbot-source-link {
            color: #90cdf4;
            background: rgba(144, 205, 244, 0.1);
        }
        
        .dark-mode .ai-chatbot-source-link:hover {
            background: rgba(144, 205, 244, 0.2);
        }
        
        .ai-chatbot-source-disabled {
            color: #999 !important;
            cursor: default !important;
            background: rgba(153, 153, 153, 0.1) !important;
        }
        
        .ai-chatbot-source-disabled:hover {
            background: rgba(153, 153, 153, 0.1) !important;
            text-decoration: none !important;
        }
        
        .dark-mode .ai-chatbot-source-disabled {
            color: #718096 !important;
            background: rgba(113, 128, 150, 0.1) !important;
        }
        
        .ai-chatbot-input-container {
            padding: 15px;
            background: white;
            border-top: 1px solid #e9ecef;
            display: flex;
            gap: 8px;
        }
        
        .dark-mode .ai-chatbot-input-container {
            background: #2d3748;
            border-top: 1px solid #4a5568;
        }
        
        .ai-chatbot-input {
            flex: 1;
            border: 1px solid #ddd;
            border-radius: 20px;
            padding: 10px 16px;
            font-size: 16px; /* Prevent iOS zoom on focus */
            outline: none;
            transition: border-color 0.2s;
            background: white;
            color: #333;
            resize: none; /* Prevent manual resizing */
            min-height: 20px;
            max-height: 200px; /* Limit height */
            overflow-y: auto; /* Add scrollbar when needed */
        }
        
        .ai-chatbot-input:focus {
            border-color: #667eea;
        }
        
        .dark-mode .ai-chatbot-input {
            background: #4a5568;
            border: 1px solid #718096;
            color: #e2e8f0;
        }
        
        .dark-mode .ai-chatbot-input:focus {
            border-color: #667eea;
        }
        
        .dark-mode .ai-chatbot-input::placeholder {
            color: #a0aec0;
        }
        
        .ai-chatbot-send {
            background: #667eea;
            color: white;
            border: none;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
            align-self: flex-end; /* Align to bottom */
            margin-bottom: 5px; /* Adjust vertical alignment */
        }
        
        .ai-chatbot-send:hover {
            background: #5a67d8;
            transform: scale(1.05);
        }
        
        .ai-chatbot-send:disabled {
            background: #ccc;
            cursor: not-allowed;
            transform: none;
        }
        
        .dark-mode .ai-chatbot-send:disabled {
            background: #718096;
        }
        
        .ai-chatbot-loading {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 2px solid #f3f3f3;
            border-top: 2px solid #667eea;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        
        .dark-mode .ai-chatbot-loading {
            border: 2px solid #4a5568;
            border-top: 2px solid #90cdf4;
        }
        
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        .ai-chatbot-snap-indicator {
            position: fixed;
            background: rgba(102, 126, 234, 0.2);
            border: 2px dashed #667eea;
            border-radius: 50%;
            width: 80px;
            height: 80px;
            display: none !important;
            z-index: 9999;
        }
        
        .ai-chatbot-copy-btn {
            background: #f8f9fa;
            border: 1px solid #ddd;
            border-radius: 4px;
            color: #666;
            cursor: pointer;
            font-size: 12px;
            margin-top: 8px;
            padding: 4px 8px;
            transition: all 0.2s;
        }
        
        .ai-chatbot-copy-btn:hover {
            background: #e9ecef;
            border-color: #adb5bd;
        }
        
        .dark-mode .ai-chatbot-copy-btn {
            background: #4a5568;
            border-color: #718096;
            color: #e2e8f0;
        }
        
        .dark-mode .ai-chatbot-copy-btn:hover {
            background: #2d3748;
        }
        
        .ai-chatbot-credits {
            padding: 8px 15px;
            background: #f8f9fa;
            border-top: 1px solid #e9ecef;
            font-size: 11px;
            color: #6c757d;
            text-align: center;
            font-style: italic;
        }
        
        .dark-mode .ai-chatbot-credits {
            background: #1a202c;
            border-top: 1px solid #4a5568;
            color: #a0aec0;
        }
    \`;
    document.head.appendChild(style);
    
    // Create widget elements
    const widget = document.createElement('div');
    widget.className = 'ai-chatbot-widget mobile-right';
    
    const collapsed = document.createElement('div');
    collapsed.className = 'ai-chatbot-collapsed';
    
    // Desktop shows icon, mobile shows dots
    if (isMobile) {
        collapsed.classList.add('mobile-tab');
        collapsed.innerHTML = ''; // Mobile: dots via CSS ::after
    } else {
        collapsed.innerHTML = '<div class="ai-chatbot-icon">💬</div>' +
                            '<div class="ai-chatbot-text">' +
                                '<div>ASK</div>' +
                                '<div>JIMMY</div>' +
                            '</div>'; // Desktop: chat icon + text
    }
    
    // 确保初始位置正确
    widget.style.position = 'fixed';
    widget.style.right = '0px';
    widget.style.left = 'auto';
    widget.style.top = '50%';
    widget.style.bottom = 'auto';
    widget.style.transform = 'translateY(-50%)';
    
    const expanded = document.createElement('div');
    expanded.className = 'ai-chatbot-expanded';
    expanded.style.display = 'none';
    
    const header = document.createElement('div');
    header.className = 'ai-chatbot-header';
    
    // Create container for title and slogan
    const titleContainer = document.createElement('div');
    
    const title = document.createElement('div');
    title.className = 'ai-chatbot-title';
    title.textContent = 'Ask Jimmy';
    
    // Slogan below the title
    const slogan = document.createElement('div');
    slogan.className = 'ai-chatbot-slogan';
    slogan.textContent = 'Talk to Jimmy’s digital self';
    
    titleContainer.appendChild(title);
    titleContainer.appendChild(slogan);
    
    const closeBtn = document.createElement('button');
    closeBtn.className = 'ai-chatbot-close';
    closeBtn.innerHTML = '×';
    
    const messages = document.createElement('div');
    messages.className = 'ai-chatbot-messages';
    
    const inputContainer = document.createElement('div');
    inputContainer.className = 'ai-chatbot-input-container';
    
    const input = document.createElement('textarea');
    input.className = 'ai-chatbot-input';
    input.placeholder = t.placeholder;
            
    // Make the textarea automatically adjust height based on content
    input.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight > 200 ? 200 : this.scrollHeight) + 'px';
    });
    
    const sendBtn = document.createElement('button');
    sendBtn.className = 'ai-chatbot-send';
    sendBtn.innerHTML = '➤';
    
    const snapIndicator = document.createElement('div');
    snapIndicator.className = 'ai-chatbot-snap-indicator';
    
    // Assemble widget
    header.appendChild(titleContainer);
    header.appendChild(closeBtn);
    inputContainer.appendChild(input);
    inputContainer.appendChild(sendBtn);
    expanded.appendChild(header);
    expanded.appendChild(messages);
    // Credits at the bottom of the chatbox
    const credits = document.createElement('div');
    credits.className = 'ai-chatbot-credits';
    credits.textContent = 'Powered by Qwen, built with Cloudflare.';
    expanded.appendChild(credits);

    expanded.appendChild(inputContainer);
    widget.appendChild(collapsed);
    widget.appendChild(expanded);
    document.body.appendChild(widget);
    document.body.appendChild(snapIndicator);
    
    // Event handlers - 添加拖拽检测以避免意外触发点击
    let hasDragged = false;
    
    collapsed.addEventListener('click', function(e) {
        if (!hasDragged) {
            expand();
        }
        hasDragged = false; // 重置拖拽状态
    });
    
    closeBtn.addEventListener('click', collapse);
    
    // Ensure proper mobile close button handling
    if (isMobile) {
        closeBtn.addEventListener('touchend', function(e) {
            e.preventDefault();
            e.stopPropagation();
            collapse();
        });
    }
    
    input.addEventListener('keypress', function(e) {
        // Handle Enter key for sending message
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
        // Allow Shift+Enter for new lines
        else if (e.key === 'Enter' && e.shiftKey) {
            // Default behavior (new line) is already handled by textarea
        }
    });
    
    sendBtn.addEventListener('click', sendMessage);
    
    // Drag functionality
    let startPos = { x: 0, y: 0 };
    let currentPos = { x: 0, y: 0 };
    
    function startDrag(e) {
        // 桌面端禁止拖拽
        if (!isMobile) return;
        
        if (isExpanded) return; // 仅在折叠状态时允许拖拽
        
        isDragging = true;
        const rect = widget.getBoundingClientRect();
        
        // 支持触摸事件
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        
        dragOffset.x = clientX - rect.left;
        dragOffset.y = clientY - rect.top;
        startPos.x = clientX;
        startPos.y = clientY;
        
        widget.style.transition = 'none';
        
        if (e.touches) {
            // 触摸事件
            document.addEventListener('touchmove', drag, { passive: false });
            document.addEventListener('touchend', stopDrag);
        } else {
            // 鼠标事件
            document.addEventListener('mousemove', drag);
            document.addEventListener('mouseup', stopDrag);
        }
        
        if (isExpanded) {
            showSnapZones();
        }
    }
    
    function drag(e) {
        if (!isDragging) return;
        
        e.preventDefault(); // 阻止默认滚动行为
        
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        
        // 检测是否真的在拖拽（移动距离超过阈值）
        const deltaX = clientX - startPos.x;
        const deltaY = clientY - startPos.y;
        const dragDistance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        
        if (dragDistance > 5) { // 5 像素的拖拽阈值
            hasDragged = true;
        }
        
        currentPos.x = clientX - dragOffset.x;
        currentPos.y = clientY - dragOffset.y;
        
        // Ensure widget stays within viewport
        const maxX = window.innerWidth - (isExpanded ? 350 : 60);
        const maxY = window.innerHeight - (isExpanded ? 500 : 60);
        
        currentPos.x = Math.max(0, Math.min(currentPos.x, maxX));
        currentPos.y = Math.max(0, Math.min(currentPos.y, maxY));
        
        widget.style.left = currentPos.x + 'px';
        widget.style.top = currentPos.y + 'px';
        widget.style.right = 'auto';
        widget.style.bottom = 'auto';
        
        if (isExpanded) {
            updateSnapIndicator(clientX, clientY);
        }
    }
    
    function stopDrag(e) {
        if (!isDragging) return;
        
        isDragging = false;
        widget.style.transition = 'all 0.3s ease';
        
        // 移除事件监听器
        document.removeEventListener('mousemove', drag);
        document.removeEventListener('mouseup', stopDrag);
        document.removeEventListener('touchmove', drag);
        document.removeEventListener('touchend', stopDrag);
        
        // 记录用户拖拽后的位置（仅在折叠状态时，桌面端和移动端都记录）
        if (!isExpanded) {
            // 只有当 top 是像素值时才记录，避免记录百分比值
            const topValue = widget.style.top;
            if (topValue && topValue.endsWith('px')) {
                userDraggedPosition = parseInt(topValue, 10) || 0;
            }
        }
        
        if (isExpanded) {
            hideSnapZones();
            snapToEdge();
        } else {
            snapToCorner();
            // Remove the mobile-tab class addition here as it's now handled in snapToCorner
        }
    }
    
    function snapToEdge() {
        const rect = widget.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        
        const distToLeft = centerX;
        const distToRight = window.innerWidth - centerX;
        const distToTop = centerY;
        const distToBottom = window.innerHeight - centerY;
        
        const minDist = Math.min(distToLeft, distToRight, distToTop, distToBottom);
        
        if (minDist === distToLeft) {
            widget.style.left = '20px';
        } else if (minDist === distToRight) {
            widget.style.left = (window.innerWidth - 350 - 20) + 'px';
        } else if (minDist === distToTop) {
            widget.style.top = '20px';
        } else {
            widget.style.top = (window.innerHeight - 500 - 20) + 'px';
        }
    }
    
    function snapToCorner() {
        // 桌面端和移动端都使用右侧边缘标签样式
        widget.classList.add('mobile-right');
        
        if (isMobile) {
            collapsed.classList.add('mobile-tab');
            // 移动端清空内容，使用 CSS ::after 显示三点图标
            collapsed.innerHTML = '';
        } else {
            // 桌面端显示聊天图标和文字
            collapsed.innerHTML = '<div class="ai-chatbot-icon">💬</div>' +
                                '<div class="ai-chatbot-text">' +
                                    '<div>ASK</div>' +
                                    '<div>JIMMY</div>' +
                                '</div>';
        }
        
        // 设置位置样式
        widget.style.position = 'fixed';
        widget.style.right = '0px';
        widget.style.left = 'auto';
        widget.style.bottom = 'auto';
        
        if (isMobile) {
            // 移动端：如果用户拖拽过，保持拖拽后的垂直位置，否则默认居中
            if (userDraggedPosition !== null) {
                const maxY = window.innerHeight - widget.offsetHeight;
                const constrainedY = Math.max(0, Math.min(userDraggedPosition, maxY));
                widget.style.top = constrainedY + 'px';
                widget.style.transform = 'none';
            } else {
                widget.style.top = '50%';
                widget.style.transform = 'translateY(-50%)';
            }
        } else {
            // 桌面端：固定在中间，不可拖拽
            widget.style.top = '50%';
            widget.style.transform = 'translateY(-50%)';
        }
    }

    function showSnapZones() {
        // Show visual indicators for snap zones
        snapIndicator.style.display = 'block';
    }
    
    function hideSnapZones() {
        snapIndicator.style.display = 'none';
    }
    
    function updateSnapIndicator(mouseX, mouseY) {
        const threshold = 50;
        let snapX, snapY;
        
        if (mouseX < threshold) snapX = 20;
        else if (mouseX > window.innerWidth - threshold) snapX = window.innerWidth - 80;
        else if (mouseY < threshold) snapY = 20;
        else if (mouseY > window.innerHeight - threshold) snapY = window.innerHeight - 80;
        
        if (snapX !== undefined) {
            snapIndicator.style.left = snapX + 'px';
            snapIndicator.style.top = (mouseY - 40) + 'px';
            snapIndicator.style.display = 'block';
        } else if (snapY !== undefined) {
            snapIndicator.style.left = (mouseX - 40) + 'px';
            snapIndicator.style.top = snapY + 'px';
            snapIndicator.style.display = 'block';
        }
    }
    
    // 只为移动端添加拖拽事件监听器
    if (isMobile) {
        header.addEventListener('mousedown', startDrag);
        collapsed.addEventListener('mousedown', startDrag);
        collapsed.addEventListener('touchstart', startDrag);
    }
    
    // Simplified body scroll prevention function
    function preventBodyScroll(e) {
        const target = e.target;
        const isInChatWidget = target.closest('.ai-chatbot-widget');
        const isScrollableElement = target.closest('.ai-chatbot-messages, .ai-chatbot-input, input, textarea, button');
        
        // For keyboard events, only prevent scroll-related keys
        if (e.type === 'keydown') {
            const scrollKeys = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', 'Space'];
            if (!scrollKeys.includes(e.key)) {
                return; // Allow non-scroll keys
            }
        }

        // Only prevent scroll if:
        // 1. The event is NOT within the chat widget, OR
        // 2. The event is within the widget but NOT on a scrollable element
        if (!isInChatWidget || (isInChatWidget && !isScrollableElement)) {
            e.preventDefault();
        }
    }
    
    // Handle ESC key to close chat window
    function handleEscKey(e) {
        if (e.key === 'Escape' || e.key === 'Esc') {
            collapse();
        }
    }
    
    function expand() {
        if (isExpanded) return;
        isExpanded = true;

        // 如果还没有记录用户拖拽位置，不要记录任何位置
        // 保持 userDraggedPosition 为 null，这样关闭后会回到默认居中位置

        // 保存当前滚动位置并锁定背景滚动（桌面端和移动端都需要）
        savedScrollY = window.scrollY;
        document.body.classList.add('ai-chatbot-scroll-lock');
        document.body.style.top = \`-\${savedScrollY}px\`;
        
        if (isMobile) {
            // Add touchmove listener to prevent body scroll while allowing messages area scrolling
            document.addEventListener('touchmove', preventBodyScroll, { passive: false });
        } else {
            // 桌面端：明确设置聊天窗口位置到右下角
            widget.style.position = 'fixed';
            widget.style.right = '20px';
            widget.style.bottom = '20px';
            widget.style.left = 'auto';
            widget.style.top = 'auto';
            widget.style.transform = 'none';
            
            // 桌面端也添加滚动防止监听器
            document.addEventListener('wheel', preventBodyScroll, { passive: false });
            document.addEventListener('keydown', preventBodyScroll, { passive: false });
        }
        
        // Add ESC key listener to close the chat window
        document.addEventListener('keydown', handleEscKey);

        widget.classList.add('is-expanded');
        
        collapsed.style.display = 'none';
        expanded.style.display = 'flex';
        
        if (messages.children.length === 0) {
            addMessage('bot', t.welcome, [], true);
        }

        setTimeout(() => input.focus(), 100);
    }
    
    function collapse() {
        if (!isExpanded) return;
        isExpanded = false;

        // 恢复页面滚动（桌面端和移动端都需要）
        document.body.classList.remove('ai-chatbot-scroll-lock');
        document.body.style.top = '';
        window.scrollTo(0, savedScrollY);
        
        if (isMobile) {
            // Remove touchmove listener
            document.removeEventListener('touchmove', preventBodyScroll);
        } else {
            // 移除桌面端的滚动防止监听器
            document.removeEventListener('wheel', preventBodyScroll);
            document.removeEventListener('keydown', preventBodyScroll);
        }
        
        // 移除 ESC 键监听器
        document.removeEventListener('keydown', handleEscKey);

        widget.classList.remove('is-expanded');

        expanded.style.display = 'none';
        collapsed.style.display = 'flex';
        
        // 桌面端和移动端都需要恢复到标签样式和位置
        snapToCorner();
        
        // Reset touch action on messages
        messages.style.touchAction = '';
    }
    
    // Simple markdown renderer for chat messages
    function renderMarkdown(text) {
        return text
            // Headers
            .replace(/^### (.+)$/gm, '<h3>$1</h3>')
            .replace(/^## (.+)$/gm, '<h2>$1</h2>')
            .replace(/^# (.+)$/gm, '<h1>$1</h1>')
            // Bold
            .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
            // Italic
            .replace(/\\*(.+?)\\*/g, '<em>$1</em>')
            // Code blocks
            .replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>')
            // Inline code
            .replace(/\`(.+?)\`/g, '<code>$1</code>')
            // Links
            .replace(/\\[(.+?)\\]\\((.+?)\\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
            // Blockquotes
            .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
            // Unordered lists
            .replace(/^- (.+)$/gm, '<li>$1</li>')
            .replace(/^✅ (.+)$/gm, '<li class="check-item">✅ $1</li>')
            .replace(/^❌ (.+)$/gm, '<li class="cross-item">❌ $1</li>')
            .replace(/^👉 (.+)$/gm, '<li class="arrow-item">👉 $1</li>')
            .replace(/^💡 (.+)$/gm, '<li class="idea-item">💡 $1</li>')
            // Wrap consecutive <li> items in <ul>
            .replace(/((<li[^>]*>.*?<\\/li>\\s*)+)/g, '<ul>$1</ul>')
            // Horizontal rules
            .replace(/^---$/gm, '<hr>')
            // Line breaks
            .replace(/\\n\\n/g, '</p><p>')
            .replace(/\\n/g, '<br>');
    }
    
    // Fallback copy function for older browsers
    function fallbackCopyTextToClipboard(text, button) {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        
        try {
            const result = document.execCommand('copy');
            if (result) {
                button.textContent = t.copied || 'Copied!';
                setTimeout(() => { button.textContent = t.copy || 'Copy'; }, 2000);
            }
        } catch (err) {
            console.warn('Failed to copy text:', err);
        } finally {
            document.body.removeChild(textArea);
        }
    }
    
    function addMessage(type, content, sources = [], isWelcome = false) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'ai-chatbot-message ai-chatbot-message-' + type;
        
        const contentDiv = document.createElement('div');
        contentDiv.className = 'ai-chatbot-message-content';
        
        let textContent = content;

        if (type === 'bot') {
            // Render markdown for bot messages
            const rendered = renderMarkdown(content);
            contentDiv.innerHTML = '<p>' + rendered + '</p>';
            
            // Add copy button only for actual responses, not welcome message
            if (!isWelcome) {
                const copyBtn = document.createElement('button');
                copyBtn.className = 'ai-chatbot-copy-btn';
                copyBtn.textContent = t.copy || 'Copy';
                copyBtn.addEventListener('click', () => {
                    if (navigator.clipboard && window.isSecureContext) {
                        navigator.clipboard.writeText(textContent).then(() => {
                            copyBtn.textContent = t.copied || 'Copied!';
                            setTimeout(() => { copyBtn.textContent = t.copy || 'Copy'; }, 2000);
                        });
                    } else {
                        fallbackCopyTextToClipboard(textContent, copyBtn);
                    }
                });
                contentDiv.appendChild(copyBtn);
            }

        } else {
            // Plain text for user messages
            contentDiv.textContent = content;
        }
        
        messageDiv.appendChild(contentDiv);
        
        // Add sources if provided
        if (sources && sources.length > 0) {
            const sourcesDiv = document.createElement('div');
            sourcesDiv.className = 'ai-chatbot-sources';
            
            const sourceLinks = sources.map(source => {
                if (typeof source === 'string') {
                    return '<a href="#" class="ai-chatbot-source-link" data-source="' + source + '">' + source + '</a>';
                } else {
                    const url = source.url || '#';
                    const title = source.title || source.source || source.id;
                    const isValidUrl = url !== '#' && url.startsWith('http');
                    
                    if (isValidUrl) {
                        return '<a href="' + url + '" class="ai-chatbot-source-link" target="_blank" rel="noopener noreferrer">' + title + '</a>';
                    } else {
                        return '<span class="ai-chatbot-source-link ai-chatbot-source-disabled">' + title + '</span>';
                    }
                }
            }).join('');
            
            sourcesDiv.innerHTML = t.sources + ': ' + sourceLinks;
            
            sourcesDiv.querySelectorAll('.ai-chatbot-source-link[data-source]').forEach(link => {
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    const source = e.target.getAttribute('data-source');
                    console.log('Navigate to source:', source);
                });
            });
            
            messageDiv.appendChild(sourcesDiv);
        }
        
        messages.appendChild(messageDiv);
        
        // 自动滚动到最新消息（适用于所有设备）
        setTimeout(() => {
            messages.scrollTop = messages.scrollHeight;
        }, 50);
    }
    
    async function sendMessage() {
        // For textarea, we need to get the value and handle newlines properly
        const message = input.value.trim();
        if (!message) return;
        
        // Add user message
        addMessage('user', message);
        input.value = '';
        
        // Reset textarea height after clearing
        input.style.height = 'auto';
        
        // Disable send button and show loading
        sendBtn.disabled = true;
        sendBtn.innerHTML = '<div class="ai-chatbot-loading"></div>';
        
        try {
            const response = await fetch(ENDPOINT + '/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                body: JSON.stringify({ message, language: LANGUAGE }),
                mode: 'cors',
                credentials: 'omit',
                cache: 'no-cache'
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error('HTTP ' + response.status + ': ' + errorText);
            }
            
            const data = await response.json();
            if (data.error) {
                throw new Error(data.error);
            }
            
            addMessage('bot', data.answer, data.sources);
            
        } catch (error) {
            console.error('Chat error:', error);
            console.error('Error details:', {
                message: error.message,
                stack: error.stack,
                endpoint: ENDPOINT,
                requestData: { message, language: LANGUAGE }
            });
            addMessage('bot', t.error + ' (' + error.message + ')');
        } finally {
            // Re-enable send button
            sendBtn.disabled = false;
            sendBtn.innerHTML = '➤';
            input.focus();
        }
    }
    
    
    // Mobile-specific initialization
    if (isMobile) {
        collapsed.classList.add('mobile-tab');
        collapsed.innerHTML = ''; // Clear content for mobile - dots will be shown via CSS
        widget.classList.add('mobile-right');
        widget.style.right = '0px';
        widget.style.left = 'auto';
        widget.style.top = '50%';
        widget.style.transform = 'translateY(-50%)';
        widget.style.bottom = 'auto';
        
        // Add touch event listeners for mobile - use touchend to prevent accidental triggers
        collapsed.addEventListener('touchend', function(e) {
            if (!hasDragged) {
                e.preventDefault();
                e.stopPropagation();
                expand();
            }
            hasDragged = false; // 重置拖拽状态
        });
        
        // Prevent touchstart from interfering with drag
        collapsed.addEventListener('touchstart', function(e) {
            // 不要阻止默认事件，让拖拽可以正常工作
            e.stopPropagation();
        });
        
        header.addEventListener('touchstart', startDrag);
        
    } else {
        // Desktop-specific initialization
        // Content is already set in the initial creation, including text
        // Position is already set to right edge center
        // No need to override position here
    }
    
    // Initialize
    document.addEventListener('DOMContentLoaded', function() {
        // Widget is ready
    });
    
})();`;
      
      return new Response(widgetJS, {
            headers: {
              'Content-Type': 'application/javascript',
          'Cache-Control': 'public, max-age=86400', // Cache for 24 hours
              ...corsHeaders
            }
          });
    }

    // Health check endpoint
    if (req.method === 'GET' && url.pathname === '/') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'website-rag-worker',
        timestamp: new Date().toISOString(),
        endpoints: ['/chat', '/debug', '/widget.js']
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'healthy' }), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  }
};
