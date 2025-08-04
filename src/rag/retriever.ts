import type { Env, MatchMeta } from '../utils/schema';
import { translateTitleToEnglish, titleDictionary } from './title-dictionary.js';

// Language filter timeout in milliseconds
const LANGUAGE_FILTER_TIMEOUT = 500;

// Convert URL to appropriate language version
function convertUrlForLanguage(originalUrl: string, targetLanguage: string): string {
  if (!originalUrl || originalUrl === '#') {
    return originalUrl;
  }
  
  try {
    const url = new URL(originalUrl);
    let pathname = url.pathname;
    
    // Remove existing language prefixes
    pathname = pathname.replace(/^\/(zh|en)/, '');
    
    // Add the appropriate prefix based on the target language
    if (targetLanguage === 'en') {
      pathname = '/en' + pathname;
    }
    
    url.pathname = pathname;
    return url.toString();
  } catch (error) {
    console.warn('Failed to convert URL:', originalUrl, error);
    return originalUrl;
  }
}

// New function with metadata filtering and fallback logic
export async function getRelevantDocuments(env: Env, qvec: number[], k = 15, currentLang = 'zh') {
  try {
    console.log('=== GET RELEVANT DOCUMENTS ===');
    console.log('Querying with topK:', k);
    console.log('Language filter:', currentLang);
    
    let queryRes;
    let usedFallback = false;
    
    try {
      // Step 1: Try query with language metadata filter
      const queryWithFilter = env.VECTORIZE.query(qvec, { 
        topK: k, 
        returnValues: false, 
        returnMetadata: 'all',
        // Add metadata filter for language
        filter: { metadata: { language: currentLang } }
      });
      
      // Set timeout for language-filtered query
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Language filter timeout')), LANGUAGE_FILTER_TIMEOUT)
      );
      
      queryRes = await Promise.race([queryWithFilter, timeoutPromise]);
      
      console.log('Language-filtered matches:', queryRes.matches.length);
      
      // If no results with language filter, try fallback
      if (queryRes.matches.length === 0) {
        console.log('No results with language filter, trying fallback...');
        throw new Error('No language-filtered results');
      }
      
    } catch (error) {
      console.log('Language filter failed or timed out, using fallback:', error.message);
      usedFallback = true;
      
      // Fallback: Query without language filter
      queryRes = await env.VECTORIZE.query(qvec, { 
        topK: k, 
        returnValues: false, 
        returnMetadata: 'all'
      });
      
      console.log('Fallback query matches:', queryRes.matches.length);
    }
    
    if (queryRes.matches.length === 0) {
      console.log('No matches found even with fallback');
      return { contexts: '', sources: [], matches: [], usedFallback };
    }
    
    // Step 2: Process matches with metadata
    const validMatches = queryRes.matches.filter(m => m.metadata && m.metadata.text);
    
    if (validMatches.length === 0) {
      console.log('No metadata found in query results');
      return { contexts: '', sources: [], matches: queryRes.matches, usedFallback };
    }
    
    console.log(`Found ${validMatches.length} matches with metadata`);
    
    let metadataResults = validMatches.map(m => ({
      id: m.id,
      metadata: m.metadata
    }));
    
    // Step 3: Additional language filtering if using fallback
    if (usedFallback) {
      console.log('Applying post-query language filter...');
      const beforeFilter = metadataResults.length;
      
      metadataResults = metadataResults.filter((v: any) => {
        const metadata = v.metadata;
        if (!metadata) return false;
        const url = metadata.url || '';
        
        if (currentLang === 'en') {
          // For English queries: First try to find English content,
          // but if none exists, allow Chinese content (will convert URLs later)
          const englishResults = metadataResults.filter(r => r.metadata?.url?.includes('/en/'));
          if (englishResults.length > 0) {
            // Found English content, use it
            return url.includes('/en/');
          } else {
            // No English content available, use Chinese content (URLs will be converted)
            console.log('No English content found, falling back to Chinese content with URL conversion');
            return !url.includes('/en/'); // Allow Chinese content
          }
        }
        if (currentLang === 'zh') {
          // For Chinese queries: Include Chinese content and root content (no /en/)
          return !url.includes('/en/');
        }
        return true;
      });
      
      console.log(`Post-query language filtering: ${beforeFilter} -> ${metadataResults.length} results`);
    }
    
    // Step 4: Build contexts
    const contexts = metadataResults
      .map((v: any) => v.metadata.text)
      .filter((text: any) => text && text.length > 0)
      .join('\n---\n');
    
    // Step 5: Build sources with language-specific filtering and conversion
    const sources = metadataResults
      .filter((v: any) => v.metadata && (v.metadata.url || v.metadata.title))
      .map((v: any) => {
        const originalUrl = v.metadata.url || '#';
        const originalTitle = v.metadata.title || v.metadata.source || v.id;
        
        if (currentLang === 'en' && !originalUrl.includes('/en/')) {
          // This is Chinese content being requested by English user
          const translatedTitle = translateTitleToEnglish(originalTitle);
          
          if (translatedTitle !== originalTitle) {
            // Translation exists, meaning English version exists - convert URL and title
            const finalUrl = convertUrlForLanguage(originalUrl, currentLang);
            console.log(`English version found: "${originalTitle}" -> "${translatedTitle}"`);
            console.log(`URL converted: ${originalUrl} -> ${finalUrl}`);
            
            return {
              id: v.id,
              url: finalUrl,
              title: translatedTitle,
              source: v.metadata.source || v.id,
              hasEnglishVersion: true
            };
          } else {
            // No English version available - mark for filtering
            console.log(`No English version available for: "${originalTitle}", will be filtered out`);
            return {
              id: v.id,
              url: originalUrl,
              title: originalTitle,
              source: v.metadata.source || v.id,
              hasEnglishVersion: false
            };
          }
        } else {
          // Chinese request or already English URL
          return {
            id: v.id,
            url: originalUrl,
            title: originalTitle,
            source: v.metadata.source || v.id,
            hasEnglishVersion: true  // Keep for Chinese requests or already English
          };
        }
      })
      .filter((source: any) => {
        // Filter out sources that don't have English versions when requesting English
        if (currentLang === 'en') {
          const shouldInclude = source.hasEnglishVersion;
          if (!shouldInclude) {
            console.log(`Filtered out Chinese-only source: "${source.title}"`);
          }
          return shouldInclude;
        }
        return true; // Keep all sources for Chinese requests
      });
    
    // Remove duplicate sources based on URL
    const uniqueSources = [];
    const seenUrls = new Set();
    
    for (const source of sources) {
      if (!seenUrls.has(source.url) && source.url !== '#') {
        seenUrls.add(source.url);
        uniqueSources.push(source);
      }
    }
    
    console.log('Final contexts length:', contexts.length);
    console.log('Final sources:', uniqueSources.slice(0, 3));
    console.log('Used fallback:', usedFallback);
    console.log('=== END GET RELEVANT DOCUMENTS ===');
    
    return { 
      contexts, 
      sources: uniqueSources, 
      matches: queryRes.matches, 
      usedFallback 
    };
    
  } catch (error) {
    console.error('Error in getRelevantDocuments:', error);
    throw error;
  }
}

// Alias for backward compatibility
export const retrieve = getRelevantDocuments;
