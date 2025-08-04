import { test, expect } from '@playwright/test';

test.describe('Multilingual Blog and Search', () => {
  test('should return Chinese search results for a Chinese blog post', async ({ page }) => {
    await page.goto('/blog/some-chinese-post/');

    // Simulate asking a question (replace with actual UI interaction)
    // This is a placeholder for the actual search interaction
    await page.fill('#search-input', 'some query');
    await page.click('#search-button');

    // Wait for search results to appear (replace with actual selector)
    await page.waitForSelector('#search-results');

    // Verify reference titles are in Chinese
    const referenceTitles = await page.locator('.reference-title').allTextContents();
    referenceTitles.forEach(title => {
      // This is a simple check; a more robust check might involve a library
      expect(title).toMatch(/[\u4e00-\u9fa5]/);
    });

    // Verify reference URLs do not contain /en/
    const referenceUrls = await page.locator('.reference-url').allTextContents();
    referenceUrls.forEach(url => {
      expect(url).not.toContain('/en/');
    });
  });

  test('should return English search results for an English blog post', async ({ page }) => {
    await page.goto('/en/blog/some-english-post/');

    // Simulate asking a question
    await page.fill('#search-input', 'some query');
    await page.click('#search-button');

    // Wait for search results
    await page.waitForSelector('#search-results');

    // Verify reference titles are in English
    const referenceTitles = await page.locator('.reference-title').allTextContents();
    referenceTitles.forEach(title => {
      expect(title).not.toMatch(/[\u4e00-\u9fa5]/);
    });

    // Verify reference URLs contain /en/
    const referenceUrls = await page.locator('.reference-url').allTextContents();
    referenceUrls.forEach(url => {
      expect(url).toContain('/en/');
    });
  });
});
