import { PDFParse } from 'pdf-parse';
import {
  readBodyWithLimit,
  maxPdfBytes,
  HttpTooLargeError,
  TIMEOUTS,
} from './http';
import { politeFetch } from './polite-fetch';

export interface PDFContent {
  text: string;
  numPages: number;
  info?: any;
}

export async function extractTextFromPDF(pdfBuffer: Buffer): Promise<PDFContent> {
  try {
    const parser = new PDFParse({ data: pdfBuffer });
    const textResult = await parser.getText();
    const infoResult = await parser.getInfo();

    const cleanedText = cleanExtractedText(textResult.text);

    await parser.destroy();

    return {
      text: cleanedText,
      numPages: textResult.pages.length,
      info: infoResult.info,
    };
  } catch (error) {
    console.error('Error extracting text from PDF:', error);
    throw new Error(`Failed to extract PDF text: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

function cleanExtractedText(text: string): string {
  let cleaned = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  cleaned = cleaned.replace(/([a-z])-\n([a-z])/g, '$1$2');

  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  cleaned = cleaned.replace(/[ \t]+/g, ' ');

  cleaned = cleaned.replace(/[^\x20-\x7E\n]/g, ' ');

  return cleaned.trim();
}

export async function fetchAndExtractPDF(url: string, retries: number = 3): Promise<PDFContent> {
  let lastError: Error | null = null;
  const sizeCap = maxPdfBytes();

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`Fetching PDF (attempt ${attempt}/${retries}): ${url}`);

      // Same throttle as the metadata call — the PDF host is usually the same
      // origin, and a burst of downloads earns the same 429.
      const response = await politeFetch(
        url,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; KnowledgeGraphBot/1.0)',
            Accept: 'application/pdf',
          },
        },
        { timeoutMs: TIMEOUTS.pdf, label: 'PDF download', attempts: 2 }
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch PDF: ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type');
      if (contentType && !contentType.includes('pdf') && !contentType.includes('octet-stream')) {
        console.warn(`Unexpected content type: ${contentType}`);
      }

      // Streamed with a hard ceiling: `arrayBuffer()` would allocate whatever the
      // remote sends, so one oversized or hostile URL could OOM the whole API.
      const buffer = await readBodyWithLimit(response, sizeCap, 'PDF download');

      if (buffer.length < 1000) {
        throw new Error('PDF file too small, likely an error page');
      }

      console.log(`Downloaded ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);

      return await extractTextFromPDF(buffer);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // An oversized document is a deterministic property of the URL. Retrying
      // just re-downloads the same bytes and burns the worker slot again.
      if (error instanceof HttpTooLargeError) {
        throw error;
      }

      console.error(`Attempt ${attempt} failed:`, lastError.message);

      if (attempt < retries) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`Retrying in ${delay / 1000} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error(`Failed to fetch and extract PDF after ${retries} attempts: ${lastError?.message}`);
}

export function chunkText(
  text: string, 
  chunkSize: number = 2000, 
  overlap: number = 200
): string[] {
  if (!text || text.length === 0) {
    return [];
  }

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  
  let currentChunk = '';
  
  for (const paragraph of paragraphs) {
    if (currentChunk.length + paragraph.length + 2 <= chunkSize) {
      currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
    } else {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
      }
      
      if (paragraph.length > chunkSize) {
        const words = paragraph.split(' ');
        currentChunk = '';
        for (const word of words) {
          if (currentChunk.length + word.length + 1 <= chunkSize) {
            currentChunk += (currentChunk ? ' ' : '') + word;
          } else {
            if (currentChunk) {
              chunks.push(currentChunk.trim());
            }
            currentChunk = word;
          }
        }
      } else {
        currentChunk = paragraph;
      }
    }
  }
  
  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  if (overlap > 0 && chunks.length > 1) {
    const overlappedChunks: string[] = [chunks[0]];
    
    for (let i = 1; i < chunks.length; i++) {
      const prevChunk = chunks[i - 1];
      const overlapText = prevChunk.slice(-overlap);
      overlappedChunks.push(overlapText + '\n\n' + chunks[i]);
    }
    
    return overlappedChunks;
  }

  return chunks;
}

export function detectSection(text: string, chunkIndex: number, totalChunks: number): string {
  const lowerText = text.toLowerCase().slice(0, 500);

  if (chunkIndex === 0) {
    return 'abstract';
  }

  if (lowerText.includes('introduction') || lowerText.includes('1 introduction') || lowerText.includes('1. introduction')) {
    return 'introduction';
  }

  if (lowerText.includes('related work') || lowerText.includes('background') || lowerText.includes('prior work')) {
    return 'related_work';
  }

  if (lowerText.includes('method') || lowerText.includes('approach') || lowerText.includes('our model')) {
    return 'methods';
  }

  if (lowerText.includes('experiment') || lowerText.includes('evaluation') || lowerText.includes('results')) {
    return 'results';
  }

  if (lowerText.includes('conclusion') || lowerText.includes('discussion') || lowerText.includes('future work')) {
    return 'conclusion';
  }

  if (lowerText.includes('reference') || lowerText.includes('bibliography')) {
    return 'references';
  }

  if (chunkIndex < totalChunks * 0.2) {
    return 'introduction';
  } else if (chunkIndex < totalChunks * 0.6) {
    return 'methods';
  } else if (chunkIndex < totalChunks * 0.85) {
    return 'results';
  } else {
    return 'conclusion';
  }
}