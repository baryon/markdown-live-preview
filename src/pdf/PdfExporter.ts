import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface PdfOptions {
  format?: 'A4' | 'Letter' | 'A3' | 'Legal';
  printBackground?: boolean;
  margin?: {
    top?: string;
    right?: string;
    bottom?: string;
    left?: string;
  };
  landscape?: boolean;
}

const DEFAULT_PDF_OPTIONS: PdfOptions = {
  format: 'A4',
  printBackground: true,
  margin: {
    top: '10mm',
    right: '10mm',
    bottom: '10mm',
    left: '10mm',
  },
  landscape: false,
};

/**
 * Detect installed Chrome/Chromium/Edge browser path.
 */
function findChromePath(): string | undefined {
  const platform = process.platform;

  if (platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  } else if (platform === 'win32') {
    const prefixes = [
      process.env.LOCALAPPDATA || '',
      process.env['PROGRAMFILES'] || '',
      process.env['PROGRAMFILES(X86)'] || '',
    ];
    const suffixes = [
      'Google\\Chrome\\Application\\chrome.exe',
      'Microsoft\\Edge\\Application\\msedge.exe',
    ];
    for (const prefix of prefixes) {
      if (!prefix) continue;
      for (const suffix of suffixes) {
        const p = path.join(prefix, suffix);
        if (fs.existsSync(p)) return p;
      }
    }
  } else {
    // Linux — use `which` with execFileSync (no shell injection risk)
    const candidates = [
      'google-chrome',
      'google-chrome-stable',
      'chromium',
      'chromium-browser',
      'microsoft-edge',
      'microsoft-edge-stable',
    ];
    for (const name of candidates) {
      try {
        const result = execFileSync('which', [name], { encoding: 'utf-8' }).trim();
        if (result) return result;
      } catch {
        // not found, try next
      }
    }
  }

  return undefined;
}

/**
 * Clean HTML for PDF: strip all <script> tags so webview JS doesn't re-execute
 * in puppeteer (the DOM already has rendered content from the webview snapshot).
 * Keep <style> and <link> tags so CSS still applies.
 */
function cleanHtmlForPdf(html: string): string {
  // Remove all script tags (inline and external) — the outerHTML snapshot
  // already contains rendered diagrams/math in the DOM, re-running scripts
  // would fail (no acquireVsCodeApi) or corrupt the content.
  return html.replace(/<script[\s\S]*?<\/script>/gi, '');
}

/**
 * Export HTML content to PDF using puppeteer-core with system Chrome.
 */
export async function exportToPdf(
  htmlContent: string,
  outputPath: string,
  options?: PdfOptions,
): Promise<void> {
  const chromePath = findChromePath();
  if (!chromePath) {
    throw new Error(
      'Could not find Chrome, Chromium, or Edge on your system.\n' +
        'Please install Google Chrome or Microsoft Edge to use PDF export.\n' +
        'Download: https://www.google.com/chrome/',
    );
  }

  const puppeteer = require('puppeteer-core');
  const pdfOptions = { ...DEFAULT_PDF_OPTIONS, ...options };

  let browser: import('puppeteer-core').Browser | undefined;
  try {
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });

    const page = await browser!.newPage();

    const cleanedHtml = cleanHtmlForPdf(htmlContent);
    await page.setContent(cleanedHtml, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    // Remove webview-specific UI elements via DOM manipulation
    await page.evaluate(() => {
      // Remove context menu
      document.getElementById('ctx-menu')?.remove();
      document.getElementById('ctx-toast')?.remove();
      // Remove page toolbar
      document.getElementById('page-toolbar')?.remove();
      // Remove TOC sidebar (it's a floating overlay)
      document.getElementById('toc-container')?.remove();
      // Remove cursor line decoration
      for (const el of document.querySelectorAll('.cursor-line-decoration')) {
        el.remove();
      }
    });

    const pdfBuffer = await page.pdf({
      path: outputPath,
      format: pdfOptions.format,
      printBackground: pdfOptions.printBackground,
      margin: pdfOptions.margin,
      landscape: pdfOptions.landscape,
    });

    // Ensure file is written (page.pdf with path should do it, but be safe)
    if (!fs.existsSync(outputPath)) {
      fs.writeFileSync(outputPath, pdfBuffer);
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
