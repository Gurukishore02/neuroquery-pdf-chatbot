import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument as getPdfDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { SAMPLE_DOCUMENTS } from './server/samplePdfs.ts';
import {
  isSupabaseConfigured,
  ensureDocumentsBucketExists,
  uploadPdfToSupabaseStorage,
  downloadPdfFromSupabaseStorage,
  downloadVisualImageFromSupabaseStorage,
  createSignedUrl,
  getDocumentFromDb,
  listDocumentsFromDb,
  findDocumentByContentHash,
  upsertDocumentToDb,
  updateDocumentStatusInDb,
  saveChunksToDb,
  saveVisualsToDb,
  saveChatMessage,
  getChatMessages,
  clearChatMessages,
  StoredDoc,
  StoredVisual,
  Chunk,
  VisualType,
} from './server/supabase.ts';

const isServerlessRuntime = process.env.NETLIFY === 'true' || typeof process.env.AWS_LAMBDA_FUNCTION_NAME === 'string';
if (!isServerlessRuntime) dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const app = express();
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

interface PreparedPdf {
  pageCount: number;
  pagesText: string[];
  chunks: Chunk[];
  visualCandidatePages: number[];
  pdf: any;
  loadingTask: any;
}

// In-memory cache for fast hot-path retrieval. The primary source of truth is Supabase.
const documentCache = new Map<string, StoredDoc>();
const activeTextIndexJobs = new Set<string>();
const activeVisualIndexJobs = new Set<string>();

const VECTOR_SIMILARITY_THRESHOLD = 0.45;
const VISUAL_RELEVANCE_THRESHOLD = 0.90;
const VISUAL_MIN_SEMANTIC_SIMILARITY = 0.76;
const VISUAL_RELATIVE_SCORE_MARGIN = 0.10;
const MAX_RELATED_VISUALS = 3;
const VISUAL_GENERIC_TERMS = new Set([
  'about', 'after', 'also', 'among', 'because', 'before', 'between', 'both', 'called', 'can', 'diagram', 'does',
  'each', 'figure', 'from', 'have', 'how', 'image', 'into', 'its', 'more', 'most', 'network', 'page', 'show',
  'shows', 'such', 'that', 'their', 'them', 'there', 'these', 'they', 'this', 'those', 'through', 'under',
  'use', 'used', 'using', 'what', 'when', 'where', 'which', 'while', 'with', 'within', 'would', 'system', 'the', 'and', 'are', 'was', 'were',
  'information', 'document', 'data', 'visual', 'picture', 'photo', 'image', 'illustration', 'overview',
]);
const TEXT_CHUNK_MAX_CHARS = 3000;
const TEXT_CHUNK_OVERLAP_CHARS = 350;
const EMBEDDING_MODEL = 'gemini-embedding-001';
const VISUAL_INDEX_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Loads a document by checking Supabase (source of truth), then falling back to in-memory cache.
 */
async function getDocument(documentId: string): Promise<StoredDoc | undefined> {
  if (isSupabaseConfigured()) {
    try {
      const fromDb = await getDocumentFromDb(documentId);
      if (fromDb) {
        const cached = documentCache.get(documentId);
        if (!fromDb.base64 && cached?.base64) {
          fromDb.base64 = cached.base64;
        }
        documentCache.set(documentId, fromDb);
        return fromDb;
      }
    } catch (err: any) {
      console.error(`[SUPABASE] Failed to fetch document ${documentId}: ${err.message}`);
    }
  }
  return documentCache.get(documentId);
}

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function chunkText(text: string, maxChunkLength = 400): { pageNumber: number; text: string }[] {
  const paragraphs = text.split(/\n\s*\n/).filter(Boolean);
  const chunks: { pageNumber: number; text: string }[] = [];
  let currentPage = 1;

  for (const para of paragraphs) {
    if (para.includes('Page ') || para.includes('---')) {
      currentPage++;
    }
    if (para.length <= maxChunkLength) {
      chunks.push({ pageNumber: currentPage, text: para.trim() });
    } else {
      const sentences = para.match(/[^.!?]+[.!?]+(\s|$)/g) || [para];
      let currentChunk = '';
      for (const sentence of sentences) {
        if ((currentChunk + sentence).length > maxChunkLength) {
          if (currentChunk.trim()) {
            chunks.push({ pageNumber: currentPage, text: currentChunk.trim() });
          }
          currentChunk = sentence;
        } else {
          currentChunk += sentence;
        }
      }
      if (currentChunk.trim()) {
        chunks.push({ pageNumber: currentPage, text: currentChunk.trim() });
      }
    }
  }

  if (chunks.length === 0) {
    chunks.push({ pageNumber: 1, text: text.substring(0, maxChunkLength) });
  }

  return chunks;
}

function chunkPageText(text: string, pageNumber: number, documentId: string, userId: string): Chunk[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const chunks: Chunk[] = [];
  let start = 0;
  let chunkNumber = 0;

  while (start < normalized.length) {
    let end = Math.min(start + TEXT_CHUNK_MAX_CHARS, normalized.length);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf(' ', end);
      if (boundary > start + TEXT_CHUNK_MAX_CHARS * 0.65) end = boundary;
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk.length >= 60) {
      chunkNumber++;
      chunks.push({
        chunkId: `${documentId}_p${pageNumber}_c${chunkNumber}`,
        documentId,
        userId,
        pageNumber,
        text: chunk,
      });
    }
    if (end >= normalized.length) break;
    const nextStart = Math.max(start + 1, end - TEXT_CHUNK_OVERLAP_CHARS);
    const nextBoundary = normalized.indexOf(' ', nextStart);
    start = nextBoundary >= 0 && nextBoundary < end ? nextBoundary + 1 : nextStart;
  }

  return chunks;
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is not set.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
  });
}

async function generateContentWithRetry(ai: GoogleGenAI, params: any) {
  const models = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-3.1-flash-lite'];
  let lastErr: any = null;
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await ai.models.generateContent({
          ...params,
          model,
          config: { ...params.config, abortSignal: params.config?.abortSignal ?? AbortSignal.timeout(60_000) },
        });
      } catch (err: any) {
        lastErr = err;
        const errMsg = String(err?.message || err);
        const isTransient = errMsg.includes('503') || errMsg.includes('429') || errMsg.includes('UNAVAILABLE') || errMsg.includes('ResourceExhausted') || errMsg.includes('fetch failed') || errMsg.includes('ECONNRESET');
        if (isTransient && attempt < 2) {
          await new Promise((r) => setTimeout(r, (attempt + 1) * 1200));
          continue;
        }
        if (isTransient) break;
        throw err;
      }
    }
  }
  throw lastErr;
}

async function embedText(ai: GoogleGenAI, text: string): Promise<number[]> {
  const embedRes = await ai.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: text,
    config: { abortSignal: AbortSignal.timeout(45_000) },
  });
  return embedRes.embeddings?.[0]?.values || [];
}

async function embedTexts(ai: GoogleGenAI, texts: string[], abortSignal?: AbortSignal): Promise<number[][]> {
  const embeddings: number[][] = [];
  const batchSize = 100;
  for (let offset = 0; offset < texts.length; offset += batchSize) {
    const batch = texts.slice(offset, offset + batchSize);
    const response = await ai.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: batch,
      config: { abortSignal: abortSignal ?? AbortSignal.timeout(45_000) },
    });
    const batchEmbeddings = response.embeddings?.map((item) => item.values || []) || [];
    if (batchEmbeddings.length !== batch.length || batchEmbeddings.some((embedding) => embedding.length === 0)) {
      throw new Error('Gemini returned incomplete text embeddings.');
    }
    embeddings.push(...batchEmbeddings);
  }
  return embeddings;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await task(items[index], index);
    }
  });
  const workerResults = await Promise.allSettled(workers);
  const workerError = workerResults.find((result) => result.status === 'rejected');
  if (workerError?.status === 'rejected') throw workerError.reason;
  return results;
}

async function extractPdfLocally(base64: string, documentId: string, userId: string): Promise<PreparedPdf> {
  const extractionStarted = Date.now();
  const loadingTask = getPdfDocument({
    data: Uint8Array.from(Buffer.from(base64, 'base64')),
    useSystemFonts: true,
  });
  try {
    const pdf = await loadingTask.promise;
    const pagesText: string[] = [];
    const chunks: Chunk[] = [];
    const visualCandidatePages: number[] = [];
    let chunkingElapsed = 0;
    const imageOperators = new Set([
      OPS.paintImageXObject,
      OPS.paintInlineImageXObject,
      OPS.paintImageMaskXObject,
      OPS.paintImageMaskXObjectGroup,
      OPS.paintXObject,
    ]);

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const textItems = textContent.items.filter((item: any) => 'str' in item && !!item.str.trim()) as { str: string; transform: number[] }[];
      const pageText = textItems.map((item: any) => item.str).join(' ').trim();
      pagesText.push(pageText);
      const chunkingStarted = Date.now();
      chunks.push(...chunkPageText(pageText, pageNumber, documentId, userId));
      chunkingElapsed += Date.now() - chunkingStarted;

      const xPositionCounts = new Map<number, number>();
      for (const item of textItems) {
        const xPosition = Math.round(item.transform[4] / 8) * 8;
        xPositionCounts.set(xPosition, (xPositionCounts.get(xPosition) || 0) + 1);
      }
      const repeatedColumns = Array.from(xPositionCounts.values()).filter((count) => count >= 2).length;
      const operators = await page.getOperatorList();
      const hasRasterImage = operators.fnArray.some((operator: number) => imageOperators.has(operator));
      const vectorDrawingCount = operators.fnArray.filter((operator: number) =>
        operator === OPS.constructPath || operator === OPS.shadingFill,
      ).length;
      if (hasRasterImage || vectorDrawingCount >= 12 || repeatedColumns >= 4) {
        visualCandidatePages.push(pageNumber);
      }
      page.cleanup();
    }

    console.log(`[CHUNKING] documentId=${documentId} chunks=${chunks.length} elapsedMs=${chunkingElapsed}`);
    console.log(`[PDF EXTRACTION] documentId=${documentId} pages=${pdf.numPages} visualCandidates=${visualCandidatePages.length} elapsedMs=${Date.now() - extractionStarted}`);
    return { pageCount: pdf.numPages, pagesText, chunks, visualCandidatePages, pdf, loadingTask };
  } catch (error) {
    await loadingTask.destroy().catch(() => undefined);
    throw error;
  }
}

async function describePageVisuals(ai: GoogleGenAI, imageBase64: string, abortSignal?: AbortSignal): Promise<{
  type: string;
  title: string;
  caption: string;
  description: string;
  bounds: { x: number; y: number; width: number; height: number };
}[]> {
  try {
    const response = await generateContentWithRetry(ai, {
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: imageBase64 } },
          { text: 'Inspect this rendered PDF page. Return only meaningful visual content that is actually visible, such as figures, diagrams, charts, graphs, tables, maps, screenshots, illustrations, or technical drawings. Do not treat ordinary paragraphs, headings, or decorative marks as visuals. Return an empty visuals array when there is no meaningful visual. For each separate visual, classify its type, copy its nearest visible caption exactly or use an empty caption, give a short specific title, describe only that visual without inference, and provide its tight normalized bounding box as x/y/width/height from 0 to 1 relative to the page. Exclude unrelated nearby text and page margins from the bounding box.' },
        ],
      }],
      config: {
        abortSignal: abortSignal ?? AbortSignal.timeout(60_000),
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            visuals: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  type: { type: Type.STRING },
                  title: { type: Type.STRING },
                  caption: { type: Type.STRING },
                  description: { type: Type.STRING },
                  bounds: {
                    type: Type.OBJECT,
                    properties: {
                      x: { type: Type.NUMBER },
                      y: { type: Type.NUMBER },
                      width: { type: Type.NUMBER },
                      height: { type: Type.NUMBER },
                    },
                    required: ['x', 'y', 'width', 'height'],
                  },
                },
                required: ['type', 'title', 'caption', 'description', 'bounds'],
              },
            },
          },
          required: ['visuals'],
        },
      },
    });
    const parsed = JSON.parse(response.text || '{}');
    return Array.isArray(parsed.visuals) ? parsed.visuals : [];
  } catch (error) {
    console.warn('Visual analysis failed for a candidate PDF page:', error);
    throw error;
  }
}

async function logIndexError(document: StoredDoc, stage: string, error: unknown, visual = false): Promise<void> {
  const message = String((error as Error)?.message || error);
  if (visual) {
    document.visualIndexStatus = 'error';
    document.visualIndexError = message;
  } else {
    document.indexingStatus = 'error';
    document.indexingError = message;
    document.textIndexReady = false;
  }
  documentCache.set(document.id, document);

  if (isSupabaseConfigured()) {
    try {
      if (visual) {
        await updateDocumentStatusInDb(document.id, {
          visualIndexStatus: 'error',
          visualIndexError: message,
        });
      } else {
        await updateDocumentStatusInDb(document.id, {
          indexingStatus: 'error',
          textIndexReady: false,
          indexingError: message,
        });
      }
    } catch (dbErr: any) {
      console.error(`[SUPABASE] Failed to persist index error for ${document.id}: ${dbErr.message}`);
    }
  }

  console.error(`[INDEX ERROR]\ndocumentId: ${document.id}\nstage: ${stage}\nerror: ${message}`);
}

async function indexDocumentText(documentId: string): Promise<void> {
  const document = await getDocument(documentId);
  if (!document || document.textIndexReady || activeTextIndexJobs.has(documentId)) return;
  activeTextIndexJobs.add(documentId);
  document.indexingStatus = 'processing';
  document.indexingError = undefined;
  documentCache.set(documentId, document);

  if (isSupabaseConfigured()) {
    await updateDocumentStatusInDb(documentId, { indexingStatus: 'processing', indexingError: undefined });
  }

  const stageStarted = Date.now();
  let stage = 'text embedding';
  try {
    console.log(`[INDEXING] Started: ${document.name} (${documentId})`);
    console.log(`[INDEX] PDF extraction complete: ${document.name}`);
    console.log(`[INDEX] Pages: ${document.pageCount}`);
    console.log(`[INDEX] Chunks created: ${document.chunks.length}`);
    if (document.chunks.length === 0) throw new Error('PDF contains no searchable text chunks.');

    const ai = getGeminiClient();
    const chunkIndices = document.chunks
      .map((chunk, index) => ({ chunk, index }))
      .filter(({ chunk }) => !chunk.embedding?.length);
    const embeddingStarted = Date.now();
    console.log(`[EMBEDDING] Embeddings started: chunks=${chunkIndices.length}`);
    const embeddings = await embedTexts(ai, chunkIndices.map(({ chunk }) => chunk.text));
    chunkIndices.forEach(({ index }, embeddingIndex) => {
      document.chunks[index].embedding = embeddings[embeddingIndex];
    });
    console.log(`[EMBEDDING] Embeddings complete: chunks=${embeddings.length} elapsedMs=${Date.now() - embeddingStarted}`);

    stage = 'text index verification';
    console.log(`[INDEX] Verification started: ${documentId}`);
    const searchableChunks = document.chunks.filter((chunk) =>
      chunk.documentId === documentId
      && chunk.text.trim().length > 0
      && !!chunk.embedding?.length
      && cosineSimilarity(chunk.embedding, chunk.embedding) > 0,
    );
    document.indexedChunks = searchableChunks.length;
    if (document.chunks.length === 0 || document.indexedChunks === 0 || document.indexedChunks !== document.chunks.length) {
      throw new Error(`Text index verification failed: ${document.indexedChunks}/${document.chunks.length} chunks are searchable.`);
    }

    document.textIndexReady = true;
    document.indexingStatus = 'ready';
    document.indexingError = undefined;
    documentCache.set(documentId, document);

    if (isSupabaseConfigured()) {
      await saveChunksToDb(document.chunks);
      await updateDocumentStatusInDb(documentId, {
        textIndexReady: true,
        indexingStatus: 'ready',
        indexedChunks: document.indexedChunks,
        indexingError: undefined,
      });
    }

    console.log(`[INDEX] Document READY: ${documentId} indexedChunks=${document.indexedChunks} elapsedMs=${Date.now() - stageStarted}`);
  } catch (error) {
    await logIndexError(document, stage, error);
  } finally {
    activeTextIndexJobs.delete(documentId);
  }
}

async function indexDocumentVisuals(documentId: string, prepared?: PreparedPdf): Promise<void> {
  const document = await getDocument(documentId);
  let loadingTask = prepared?.loadingTask;
  let pdf = prepared?.pdf;
  if (!document || document.visualIndexReady || activeVisualIndexJobs.has(documentId)) {
    try {
      await loadingTask?.destroy();
    } catch (error) {
      console.warn(`[INDEX ERROR]\ndocumentId: ${documentId}\nstage: visual cleanup\nerror: ${String((error as Error)?.message || error)}`);
    }
    return;
  }

  const candidatePages = document.visualCandidatePages.filter((pageNumber) =>
    !document.visualAnalyzedPages.includes(pageNumber),
  );
  if (candidatePages.length === 0) {
    document.visualIndexReady = true;
    document.visualIndexStatus = 'ready';
    documentCache.set(documentId, document);
    if (isSupabaseConfigured()) {
      await updateDocumentStatusInDb(documentId, { visualIndexReady: true, visualIndexStatus: 'ready' });
    }
    try {
      await loadingTask?.destroy();
    } catch (error) {
      console.warn(`[INDEX ERROR]\ndocumentId: ${documentId}\nstage: visual cleanup\nerror: ${String((error as Error)?.message || error)}`);
    }
    return;
  }

  activeVisualIndexJobs.add(documentId);
  document.visualIndexStatus = 'processing';
  document.visualIndexError = undefined;
  documentCache.set(documentId, document);
  if (isSupabaseConfigured()) {
    await updateDocumentStatusInDb(documentId, { visualIndexStatus: 'processing', visualIndexError: undefined });
  }

  let stage = 'visual PDF rendering';
  const visualStarted = Date.now();
  const visualAbortSignal = AbortSignal.timeout(VISUAL_INDEX_TIMEOUT_MS);
  console.log(`[VISUAL INDEXING] Visual indexing started: documentId=${documentId} candidatePages=${candidatePages.length}`);
  try {
    if (!pdf) {
      let pdfBase64 = document.base64;
      if (!pdfBase64 && document.storagePath && isSupabaseConfigured()) {
        const buf = await downloadPdfFromSupabaseStorage(document.storagePath);
        if (buf) pdfBase64 = buf.toString('base64');
      }
      if (!pdfBase64) throw new Error('Cannot load PDF content for visual rendering.');

      loadingTask = getPdfDocument({
        data: Uint8Array.from(Buffer.from(pdfBase64, 'base64')),
        useSystemFonts: true,
      });
      pdf = await loadingTask.promise;
    }
    const ai = getGeminiClient();
    stage = 'visual description';
    await mapWithConcurrency(candidatePages, 2, async (pageNumber) => {
      const page = await pdf.getPage(pageNumber);
      try {
        const originalViewport = page.getViewport({ scale: 1 });
        const scale = Math.min(1.2, 900 / originalViewport.width);
        const viewport = page.getViewport({ scale });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({
          canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D,
          viewport,
          canvas: canvas as unknown as HTMLCanvasElement,
        }).promise;
        const imageBase64 = canvas.toBuffer('image/jpeg', 72).toString('base64');
        const pageVisuals = await describePageVisuals(ai, imageBase64, visualAbortSignal);
        console.log(`[VISUAL PAGE] documentId=${documentId} page=${pageNumber} detected=${pageVisuals.length}`);
        const visuals = pageVisuals.flatMap((visual, visualIndex) => {
          const description = String(visual.description || '').trim();
          if (!description) {
            console.log(`[VISUAL REJECTED] documentId=${documentId} page=${pageNumber} visual=${visualIndex + 1} reason=empty description`);
            return [];
          }
          const bounds = visual.bounds;
          if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {
            console.log(`[VISUAL REJECTED] documentId=${documentId} page=${pageNumber} visual=${visualIndex + 1} reason=invalid bounds`);
            return [];
          }
          const boundsArePixels = [bounds.x, bounds.y, bounds.width, bounds.height].some((value) => value > 1);
          const normalizedX = boundsArePixels ? bounds.x / viewport.width : bounds.x;
          const normalizedY = boundsArePixels ? bounds.y / viewport.height : bounds.y;
          const normalizedWidth = boundsArePixels ? bounds.width / viewport.width : bounds.width;
          const normalizedHeight = boundsArePixels ? bounds.height / viewport.height : bounds.height;
          let left = Math.max(0, Math.min(1, normalizedX));
          let top = Math.max(0, Math.min(1, normalizedY));
          let right = Math.max(left, Math.min(1, normalizedX + normalizedWidth));
          let bottom = Math.max(top, Math.min(1, normalizedY + normalizedHeight));
          let expanded = false;
          const boxWidth = right - left;
          const boxHeight = bottom - top;
          if (boxWidth < 0.18) {
            const centerX = (left + right) / 2;
            left = Math.max(0, Math.min(0.76, centerX - 0.12));
            right = Math.min(1, left + 0.24);
            expanded = true;
          }
          if (boxHeight < 0.14) {
            const centerY = (top + bottom) / 2;
            top = Math.max(0, Math.min(0.82, centerY - 0.09));
            bottom = Math.min(1, top + 0.18);
            expanded = true;
          }
          console.log(`[VISUAL CROP] documentId=${documentId} page=${pageNumber} raw=${JSON.stringify(bounds)} normalized=${left.toFixed(3)},${top.toFixed(3)},${(right - left).toFixed(3)},${(bottom - top).toFixed(3)} expanded=${expanded}`);
          const paddingX = Math.round(viewport.width * 0.012);
          const paddingY = Math.round(viewport.height * 0.012);
          const cropX = Math.max(0, Math.floor(left * viewport.width) - paddingX);
          const cropY = Math.max(0, Math.floor(top * viewport.height) - paddingY);
          const cropWidth = Math.min(canvas.width - cropX, Math.ceil((right - left) * viewport.width) + paddingX * 2);
          const cropHeight = Math.min(canvas.height - cropY, Math.ceil((bottom - top) * viewport.height) + paddingY * 2);
          if (cropWidth < 24 || cropHeight < 24) {
            console.log(`[VISUAL REJECTED] documentId=${documentId} page=${pageNumber} visual=${visualIndex + 1} reason=tiny crop width=${cropWidth} height=${cropHeight}`);
            return [];
          }
          const cropCanvas = createCanvas(cropWidth, cropHeight);
          cropCanvas.getContext('2d').drawImage(canvas, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
          const visualImageBase64 = cropCanvas.toBuffer('image/jpeg', 78).toString('base64');
          const caption = String(visual.caption || '').trim();
          const title = String(visual.title || caption || description.slice(0, 80)).trim();
          const allowedTypes: VisualType[] = ['image', 'figure', 'diagram', 'chart', 'graph', 'table', 'flowchart', 'illustration', 'map', 'screenshot', 'other'];
          const type = allowedTypes.includes(visual.type as VisualType) ? visual.type as VisualType : 'other';
          return [{
            id: `${documentId}_p${pageNumber}_v${visualIndex + 1}`,
            documentId,
            pageNumber,
            type,
            title,
            caption,
            description,
            imageData: `data:image/jpeg;base64,${visualImageBase64}`,
            embedding: [],
          }];
        });
        document.visualAnalyzedPages = [...new Set([...document.visualAnalyzedPages, pageNumber])];
        document.visuals = [...document.visuals.filter((visual) => visual.pageNumber !== pageNumber), ...visuals];
      } finally {
        page.cleanup();
      }
    });

    const pendingVisualEmbeddings = document.visuals.filter((visual) => !visual.embedding.length);
    stage = 'visual embedding';
    console.log(`[EMBEDDING] Visual embedding started: count=${pendingVisualEmbeddings.length}`);
    const visualEmbeddings = await embedTexts(ai, pendingVisualEmbeddings.map((visual) => `${visual.title}. ${visual.caption}. ${visual.description}`), visualAbortSignal);
    pendingVisualEmbeddings.forEach((visual, index) => {
      visual.embedding = visualEmbeddings[index];
    });
    if (document.visualAnalyzedPages.length < document.visualCandidatePages.length) {
      throw new Error(`Visual index verification failed: ${document.visualAnalyzedPages.length}/${document.visualCandidatePages.length} candidate pages analyzed.`);
    }
    document.visualIndexReady = true;
    document.visualIndexStatus = 'ready';
    document.visualIndexError = undefined;
    documentCache.set(documentId, document);

    if (isSupabaseConfigured()) {
      await saveVisualsToDb(document.visuals);
      await updateDocumentStatusInDb(documentId, {
        visualIndexReady: true,
        visualIndexStatus: 'ready',
        visualAnalyzedPages: document.visualAnalyzedPages,
        visualIndexError: undefined,
      });
    }

    console.log(`[VISUAL INDEXING] Visual indexing complete: documentId=${documentId} visuals=${document.visuals.length} elapsedMs=${Date.now() - visualStarted}`);
  } catch (error) {
    await logIndexError(document, stage, error, true);
  } finally {
    try {
      await loadingTask?.destroy();
    } catch (error) {
      console.warn(`[INDEX ERROR]\ndocumentId: ${documentId}\nstage: visual cleanup\nerror: ${String((error as Error)?.message || error)}`);
    }
    activeVisualIndexJobs.delete(documentId);
  }
}

async function indexStoredDocument(documentId: string, prepared?: PreparedPdf): Promise<void> {
  const document = await getDocument(documentId);
  if (!document || document.textIndexReady || activeTextIndexJobs.has(documentId)) {
    try {
      await prepared?.loadingTask.destroy();
    } catch (error) {
      console.warn(`[INDEX ERROR]\ndocumentId: ${documentId}\nstage: prepared PDF cleanup\nerror: ${String((error as Error)?.message || error)}`);
    }
    return;
  }

  const textJob = indexDocumentText(documentId);
  const visualJob = indexDocumentVisuals(documentId, prepared);
  void visualJob.catch((error) => {
    void logIndexError(document, 'visual worker promise', error, true);
  });
  await textJob;
}

async function initializeSamples() {
  if (isSupabaseConfigured()) {
    try {
      await ensureDocumentsBucketExists();
    } catch (err: any) {
      console.warn(`[SUPABASE] Storage bucket initialization check: ${err.message}`);
    }
  }

  for (const sample of SAMPLE_DOCUMENTS) {
    const rawText = sample.description + ' ' + (sample.suggestedQuestions || []).join(' ');
    const chunks = chunkText(rawText).map((item, index): Chunk => ({
      chunkId: `${sample.id}_c${index + 1}`,
      documentId: sample.id,
      userId: 'default_user',
      pageNumber: item.pageNumber,
      text: item.text,
    }));
    const sampleDoc: StoredDoc = {
      id: sample.id,
      userId: 'default_user',
      name: sample.name,
      base64: sample.base64,
      size: Math.round((sample.base64.length * 3) / 4),
      pageCount: sample.pageCount,
      summary: sample.description,
      suggestedQuestions: sample.suggestedQuestions,
      chunks,
      visuals: [],
      pagesText: [],
      visualCandidatePages: [],
      visualAnalyzedPages: [],
      contentHash: `sample:${sample.id}`,
      indexingStatus: 'queued',
      textIndexReady: false,
      visualIndexReady: true,
      visualIndexStatus: 'ready',
      indexedChunks: 0,
      uploadedAt: Date.now(),
    };
    documentCache.set(sample.id, sampleDoc);

    if (isSupabaseConfigured()) {
      void upsertDocumentToDb(sampleDoc).catch((e) => {
        console.warn(`[SUPABASE] Notice syncing sample ${sample.id}: ${e.message}`);
      });
    }
  }
}

async function indexSampleDocument(documentId: string): Promise<void> {
  const document = await getDocument(documentId);
  if (!document) return;
  await indexStoredDocument(documentId);
}

function retrieveRelevantChunks(queryEmbedding: number[], document: StoredDoc, userId: string = 'default_user', topK: number = 5) {
  const documentId = document.id;
  const candidateChunks = (!document.userId || document.userId === userId)
    ? document.chunks.filter((chunk) => chunk.documentId === documentId)
    : [];
  const scoredChunks = candidateChunks.map((chunk) => {
    const similarity = chunk.embedding ? cosineSimilarity(queryEmbedding, chunk.embedding) : 0;
    return {
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      pageNumber: chunk.pageNumber,
      text: chunk.text,
      similarity,
    };
  });

  scoredChunks.sort((a, b) => b.similarity - a.similarity);
  const topCandidates = scoredChunks.slice(0, topK);
  const filteredResults = topCandidates.filter((c) => c.similarity >= VECTOR_SIMILARITY_THRESHOLD);

  return {
    hasRelevantResults: filteredResults.length > 0,
    results: filteredResults,
  };
}

function getVisualConceptTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (let term of text.toLowerCase().match(/[a-z0-9]+/g) || []) {
    if (term === 'switching' || term === 'switched' || term === 'switches') term = 'switch';
    else if (term === 'phases') term = 'phase';
    else if (term.endsWith('ies') && term.length > 5) term = `${term.slice(0, -3)}y`;
    else if (term.endsWith('s') && !term.endsWith('ss') && term.length > 4) term = term.slice(0, -1);
    if (term.length > 2 && !VISUAL_GENERIC_TERMS.has(term)) terms.add(term);
  }
  return terms;
}

function getTermOverlap(queryTerms: Set<string>, candidateTerms: Set<string>, denominatorLimit = 6): { ratio: number; matches: string[] } {
  const matches = Array.from(queryTerms).filter((term) => candidateTerms.has(term));
  const denominator = Math.max(1, Math.min(queryTerms.size, denominatorLimit));
  return { ratio: matches.length / denominator, matches };
}

function getEvidenceSentences(text: string): string[] {
  return (text.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) || [text])
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function compactEvidenceSentence(sentence: string, questionTerms: Set<string>, maxLength: number): string {
  if (sentence.length <= maxLength) return sentence;
  const words = Array.from(sentence.matchAll(/[a-z0-9]+/gi));
  const relevantWords = words.filter((word) => {
    let term = word[0].toLowerCase();
    if (term === 'switching' || term === 'switched') term = 'switch';
    if (term.endsWith('s') && term.length > 4) term = term.slice(0, -1);
    return questionTerms.has(term);
  });
  const numericValues = Array.from(sentence.matchAll(/\b\d+(?:\.\d+)?\s?(?:%|percent|knots?|mph|km\/h|m\/s|ms|seconds?|minutes?|hours?|days?|years?|bytes?|bits?|kbps|mbps|gbps)?\b/gi));
  const anchors = [...relevantWords, ...numericValues].sort((left, right) => (left.index || 0) - (right.index || 0));
  if (anchors.length === 0) return `${sentence.slice(0, maxLength - 3).trimEnd()}...`;

  const first = anchors[0].index || 0;
  const last = (anchors[anchors.length - 1].index || first) + anchors[anchors.length - 1][0].length;
  const spanLength = last - first;
  let start = Math.max(0, first - Math.max(0, Math.floor((maxLength - spanLength) / 2)));
  if (start + maxLength > sentence.length) start = sentence.length - maxLength;
  let end = start + maxLength;
  if (start > 0) {
    const boundary = sentence.indexOf(' ', start + 1);
    if (boundary > 0 && boundary < start + 24) start = boundary + 1;
  }
  if (end < sentence.length) {
    const boundary = sentence.lastIndexOf(' ', end);
    if (boundary > start + maxLength * 0.72) end = boundary;
  }
  const prefix = start > 0 ? '... ' : '';
  const suffix = end < sentence.length ? '...' : '';
  return `${prefix}${sentence.slice(start, end).trim()}${suffix}`.slice(0, maxLength);
}

function selectRelevantEvidenceExcerpt(
  question: string,
  chunks: { text: string; similarity: number }[],
  conversationContext = '',
  maxLength = 300,
): string {
  const queryTerms = getVisualConceptTerms(`${question} ${conversationContext}`);
  const candidates = chunks.flatMap((chunk, chunkIndex) => getEvidenceSentences(chunk.text).map((sentence, sentenceIndex) => {
    const sentenceTerms = getVisualConceptTerms(sentence);
    const overlap = getTermOverlap(queryTerms, sentenceTerms, 6);
    const containsDate = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{4}\b/i.test(sentence);
    const dateMatch = queryTerms.has('date') && containsDate;
    const matchedTerms = overlap.matches.length + (dateMatch ? 1 : 0);
    const coverage = queryTerms.size > 0 ? matchedTerms / Math.min(queryTerms.size, 6) : 0;
    const similarity = Math.max(0, chunk.similarity);
    const normalizedQuestion = Array.from(queryTerms).join(' ');
    const normalizedSentence = Array.from(sentenceTerms).join(' ');
    const phraseBoost = normalizedQuestion.length > 0 && normalizedSentence.includes(normalizedQuestion) ? 0.2 : 0;
    return {
      sentence,
      chunkIndex,
      sentenceIndex,
      score: coverage * 0.78 + similarity * 0.18 + phraseBoost,
      matches: matchedTerms,
    };
  }));

  candidates.sort((left, right) => right.score - left.score);
  const best = candidates[0];
  if (!best) return '';

  const selected = [best];
  for (const candidate of candidates.slice(1)) {
    if (selected.length >= 3 || candidate.score < best.score - 0.16) break;
    const isAdjacentContext = candidate.chunkIndex === best.chunkIndex
      && Math.abs(candidate.sentenceIndex - best.sentenceIndex) === 1
      && candidate.score >= best.score - 0.24;
    if (candidate.matches === 0 && !isAdjacentContext) continue;
    if (selected.some((item) => item.sentence.toLowerCase() === candidate.sentence.toLowerCase())) continue;
    selected.push(candidate);
  }

  const ordered = selected.sort((left, right) => left.chunkIndex - right.chunkIndex || left.sentenceIndex - right.sentenceIndex);
  let excerpt = '';
  for (const candidate of ordered) {
    const remaining = maxLength - excerpt.length - (excerpt ? 1 : 0);
    if (remaining < 40) break;
    const sentence = compactEvidenceSentence(candidate.sentence, queryTerms, Math.min(remaining, maxLength));
    excerpt = excerpt ? `${excerpt} ${sentence}` : sentence;
    if (excerpt.length >= maxLength) break;
  }
  return excerpt.slice(0, maxLength).trim();
}

function getVisualConceptConflict(questionTerms: Set<string>, visualTerms: Set<string>): string | undefined {
  for (const [requested, opposing] of [['circuit', 'packet'], ['packet', 'circuit']]) {
    if (questionTerms.has(requested) && !questionTerms.has(opposing) && visualTerms.has(opposing) && !visualTerms.has(requested)) {
      return `${requested}-vs-${opposing} concept mismatch`;
    }
  }
  return undefined;
}

function retrieveRelevantVisuals(
  queryEmbedding: number[],
  document: StoredDoc,
  userId: string,
  question: string,
  visualContext: string,
  relevantPages: Set<number>,
): StoredVisual[] {
  const documentId = document.id;
  if (!document.visualIndexReady || (document.userId && document.userId !== userId)) return [];

  const questionTerms = getVisualConceptTerms(question);
  const contextTerms = getVisualConceptTerms(visualContext);
  const figureReference = question.match(/\b(fig(?:ure)?|table|diagram|chart|graph)\s*(?:no\.?\s*)?(\d+)\b/i);
  const referencePattern = figureReference
    ? new RegExp(`\\b(?:fig(?:ure)?|table|diagram|chart|graph)\\s*(?:no\\.?\\s*)?${figureReference[2]}\\b`, 'i')
    : undefined;
  const explicitVisualRequest = /\b(show|display|diagram|figure|image|chart|graph|table|illustration)\b/i.test(question);
  const visualComparisonRequested = /\b(compare|comparison|difference|versus|vs\.?|between)\b/i.test(question)
    && questionTerms.size > 1;
  const requestedType = /\btable\b/i.test(question)
    ? ['table']
    : /\b(chart|graph)\b/i.test(question)
      ? ['chart', 'graph']
      : /\bdiagram\b/i.test(question)
        ? ['diagram', 'flowchart', 'figure']
        : /\bfigure\b/i.test(question)
          ? ['figure', 'diagram', 'image']
          : [];

  console.log(`[VISUAL QUERY] documentId=${documentId} question="${question.slice(0, 240)}" context="${visualContext.slice(0, 650)}"`);
  const candidates = document.visuals
    .filter((visual) => visual.documentId === documentId && visual.embedding.length > 0)
    .map((visual) => {
      const semantic = cosineSimilarity(queryEmbedding, visual.embedding);
      const titleCaptionTerms = getVisualConceptTerms(`${visual.title} ${visual.caption}`);
      const visualTerms = getVisualConceptTerms(`${visual.title} ${visual.caption} ${visual.description}`);
      const questionOverlap = getTermOverlap(questionTerms, visualTerms);
      const contextOverlap = getTermOverlap(contextTerms, visualTerms, 8);
      const captionOverlap = getTermOverlap(questionTerms, titleCaptionTerms);
      const conflict = getVisualConceptConflict(questionTerms, visualTerms);
      const referenceMatch = !!referencePattern && referencePattern.test(`${visual.title} ${visual.caption}`);
      const semanticFloor = referenceMatch ? 0.36 : VISUAL_MIN_SEMANTIC_SIMILARITY;
      const captionBoost = captionOverlap.matches.length > 0
        ? Math.min(0.18, 0.04 + captionOverlap.ratio * 0.14)
        : 0;
      const contextBoost = Math.min(0.055, contextOverlap.ratio * 0.055);
      const conceptBoost = Math.min(0.10, questionOverlap.ratio * 0.10);
      const pageBoost = relevantPages.has(visual.pageNumber) ? 0.02 : 0;
      const typeBoost = requestedType.includes(visual.type) ? 0.025 : 0;
      const requestBoost = explicitVisualRequest ? 0.015 : 0;
      const referenceBoost = referenceMatch ? 0.20 : 0;
      const score = semantic + captionBoost + contextBoost + conceptBoost + pageBoost + typeBoost + requestBoost + referenceBoost;
      return {
        visual,
        semantic,
        score,
        questionOverlap,
        contextOverlap,
        conflict,
        referenceMatch,
        semanticFloor,
      };
    })
    .sort((left, right) => right.score - left.score);

  const eligible = candidates.filter((candidate) => {
    const caption = candidate.visual.caption.slice(0, 100);
    console.log(`[VISUAL CANDIDATE] page=${candidate.visual.pageNumber} type=${candidate.visual.type} caption="${caption}" semantic=${candidate.semantic.toFixed(3)} score=${candidate.score.toFixed(3)} questionTerms=${candidate.questionOverlap.matches.join(',')} contextTerms=${candidate.contextOverlap.matches.join(',')}`);
    let reason: string | undefined;
    if (candidate.conflict) reason = candidate.conflict;
    else if (figureReference && !candidate.referenceMatch) reason = 'different figure/table identifier requested';
    else if (candidate.semantic < candidate.semanticFloor) reason = 'low semantic similarity';
    else if (candidate.score < VISUAL_RELEVANCE_THRESHOLD) reason = 'below absolute relevance threshold';
    else if (!candidate.referenceMatch && questionTerms.size > 0 && candidate.questionOverlap.matches.length === 0) reason = 'no direct question concept match';
    else if (!candidate.referenceMatch && questionTerms.size === 0 && candidate.contextOverlap.matches.length === 0) reason = 'no meaningful follow-up context match';
    else if (questionTerms.has('phase') && !['phase', 'setup', 'transfer', 'teardown'].some((term) => getVisualConceptTerms(`${candidate.visual.title} ${candidate.visual.caption} ${candidate.visual.description}`).has(term))) reason = 'visual does not show the requested phases';
    if (reason) {
      console.log(`[VISUAL REJECTED] page=${candidate.visual.pageNumber} title="${candidate.visual.title.slice(0, 100)}" score=${candidate.score.toFixed(3)} reason=${reason}`);
      return false;
    }
    return true;
  });

  if (eligible.length === 0) return [];
  const selected: typeof eligible = [];
  const resultLimit = visualComparisonRequested ? MAX_RELATED_VISUALS : 1;
  for (const candidate of eligible) {
    if (selected.length >= resultLimit) break;
    if (selected.length > 0 && selected[0].score - candidate.score > VISUAL_RELATIVE_SCORE_MARGIN) {
      console.log(`[VISUAL REJECTED] page=${candidate.visual.pageNumber} title="${candidate.visual.title.slice(0, 100)}" score=${candidate.score.toFixed(3)} reason=too far below best candidate`);
      continue;
    }
    const duplicate = selected.some((chosen) =>
      chosen.visual.imageData === candidate.visual.imageData
      || cosineSimilarity(chosen.visual.embedding, candidate.visual.embedding) >= 0.97,
    );
    if (duplicate) {
      console.log(`[VISUAL REJECTED] page=${candidate.visual.pageNumber} title="${candidate.visual.title.slice(0, 100)}" score=${candidate.score.toFixed(3)} reason=duplicate or near-duplicate`);
      continue;
    }
    selected.push(candidate);
    console.log(`[VISUAL SELECTED] page=${candidate.visual.pageNumber} caption="${candidate.visual.caption.slice(0, 100)}" score=${candidate.score.toFixed(3)}`);
  }
  return selected.map((candidate) => candidate.visual);
}

// API Endpoints
app.get('/api/health', async (_req, res) => {
  res.json({
    status: 'ok',
    documentsLoaded: documentCache.size,
    supabaseConfigured: isSupabaseConfigured(),
  });
});

app.get('/api/documents', async (req, res) => {
  const userId = (req.query.userId as string) || 'default_user';
  let docs: StoredDoc[] = [];

  if (isSupabaseConfigured()) {
    try {
      const dbDocs = await listDocumentsFromDb(userId);
      const dbMap = new Map(dbDocs.map((d) => [d.id, d]));
      for (const [id, doc] of documentCache.entries()) {
        if (!dbMap.has(id) && (!doc.userId || doc.userId === userId)) {
          dbMap.set(id, doc);
        }
      }
      docs = Array.from(dbMap.values());
    } catch (err: any) {
      console.error(`[SUPABASE] Failed to list documents: ${err.message}`);
      docs = Array.from(documentCache.values()).filter((doc) => !doc.userId || doc.userId === userId);
    }
  } else {
    docs = Array.from(documentCache.values()).filter((doc) => !doc.userId || doc.userId === userId);
  }

  const mapped = docs.map((doc) => ({
    id: doc.id,
    name: doc.name,
    size: doc.size,
    pageCount: doc.pageCount,
    summary: doc.summary,
    suggestedQuestions: doc.suggestedQuestions,
    uploadedAt: doc.uploadedAt,
    indexingStatus: doc.indexingStatus,
    textIndexReady: doc.textIndexReady,
    visualIndexReady: doc.visualIndexReady,
    visualIndexStatus: doc.visualIndexStatus,
    indexingError: doc.indexingError,
    visualIndexError: doc.visualIndexError,
    indexedChunks: doc.indexedChunks,
  }));
  res.json({ documents: mapped });
});

app.get('/api/samples', (_req, res) => {
  const samples = SAMPLE_DOCUMENTS.map((doc) => ({
    id: doc.id,
    name: doc.name,
    description: doc.description,
    category: doc.category,
    pageCount: doc.pageCount,
    suggestedQuestions: doc.suggestedQuestions,
  }));
  res.json({ samples });
});

app.get('/api/documents/:id/status', async (req, res) => {
  const document = await getDocument(req.params.id);
  if (!document) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }

  // Safe serverless resumption: if indexing is queued and serverless runtime, advance indexing
  if (isServerlessRuntime && document.indexingStatus === 'queued' && !activeTextIndexJobs.has(document.id)) {
    try {
      await indexStoredDocument(document.id);
    } catch (err: any) {
      console.warn(`[INDEXING] Serverless status resumption notice: ${err.message}`);
    }
  }

  res.json({
    documentId: document.id,
    status: document.indexingStatus,
    textIndexReady: document.textIndexReady,
    visualIndexReady: document.visualIndexReady,
    visualIndexStatus: document.visualIndexStatus,
    indexedChunks: document.indexedChunks,
    chunkCount: document.chunks.length,
    error: document.indexingError,
    visualIndexError: document.visualIndexError,
  });
});

app.get('/api/documents/:id', async (req, res) => {
  const doc = await getDocument(req.params.id);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }

  let pdfBase64 = doc.base64;
  if (!pdfBase64 && doc.storagePath && isSupabaseConfigured()) {
    const downloaded = await downloadPdfFromSupabaseStorage(doc.storagePath);
    if (downloaded) {
      pdfBase64 = downloaded.toString('base64');
      doc.base64 = pdfBase64;
      documentCache.set(doc.id, doc);
    }
  }

  res.json({
    id: doc.id,
    name: doc.name,
    pageCount: doc.pageCount,
    size: doc.size,
    summary: doc.summary,
    suggestedQuestions: doc.suggestedQuestions,
    uploadedAt: doc.uploadedAt,
    indexingStatus: doc.indexingStatus,
    textIndexReady: doc.textIndexReady,
    visualIndexReady: doc.visualIndexReady,
    visualIndexStatus: doc.visualIndexStatus,
    indexingError: doc.indexingError,
    visualIndexError: doc.visualIndexError,
    base64: pdfBase64 ? `data:application/pdf;base64,${pdfBase64}` : '',
  });
});

app.get('/api/documents/:id/chat', async (req, res) => {
  const userId = (req.query.userId as string) || 'default_user';
  const documentId = req.params.id;
  try {
    const messages = await getChatMessages(documentId, userId);
    res.json({ messages });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/documents/:id/chat', async (req, res) => {
  const userId = (req.query.userId as string) || 'default_user';
  const documentId = req.params.id;
  try {
    await clearChatMessages(documentId, userId);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/documents/analyze', express.raw({ type: 'application/pdf', limit: '50mb' }), async (req, res) => {
  const uploadStarted = Date.now();
  let prepared: PreparedPdf | undefined;
  let documentId = '';
  try {
    const rawUpload = Buffer.isBuffer(req.body) ? req.body as Buffer : undefined;
    const body = rawUpload ? {} : req.body || {};
    let name = typeof body.name === 'string' ? body.name : '';
    if (rawUpload) {
      try {
        name = decodeURIComponent(req.get('x-file-name') || 'Uploaded PDF');
      } catch {
        name = req.get('x-file-name') || 'Uploaded PDF';
      }
    }
    const cleanBase64 = rawUpload
      ? rawUpload.toString('base64')
      : String(body.base64 || '').replace(/^data:[^;]+;base64,/, '');
    if (!cleanBase64) throw new Error('PDF content is required.');
    const uploadedBytes = rawUpload || Buffer.from(cleanBase64, 'base64');
    const contentHash = createHash('sha256').update(uploadedBytes).digest('hex');
    const currentUserId = body.userId || 'default_user';

    let existing: StoredDoc | null = null;
    if (isSupabaseConfigured()) {
      existing = await findDocumentByContentHash(contentHash, currentUserId);
    }
    if (!existing) {
      existing = Array.from(documentCache.values()).find((doc) =>
        doc.contentHash === contentHash && (!doc.userId || doc.userId === currentUserId),
      ) || null;
    }

    if (existing) {
      res.json({
        id: existing.id,
        name: existing.name,
        size: existing.size,
        pageCount: existing.pageCount,
        summary: existing.summary,
        suggestedQuestions: existing.suggestedQuestions,
        uploadedAt: existing.uploadedAt,
        indexingStatus: existing.indexingStatus,
        textIndexReady: existing.textIndexReady,
        visualIndexReady: existing.visualIndexReady,
        visualIndexStatus: existing.visualIndexStatus,
        indexingError: existing.indexingError,
        visualIndexError: existing.visualIndexError,
      });
      console.log(`[DOCUMENT UPLOAD] documentId=${existing.id} duplicate=true elapsedMs=${Date.now() - uploadStarted}`);
      return;
    }

    do {
      documentId = `doc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    } while (documentCache.has(documentId));
    const displayName = name.trim() || 'Uploaded PDF';
    const uploadedAt = Date.now();

    let storagePath: string | undefined;
    if (isSupabaseConfigured()) {
      const uploadedStoragePath = await uploadPdfToSupabaseStorage(documentId, displayName, uploadedBytes);
      if (uploadedStoragePath) storagePath = uploadedStoragePath;
    }

    const document: StoredDoc = {
      id: documentId,
      userId: currentUserId,
      name: displayName,
      base64: cleanBase64,
      storagePath,
      size: rawUpload?.length || Number(body.size) || uploadedBytes.length,
      pageCount: 0,
      summary: 'Extracting document text locally.',
      suggestedQuestions: ['What are the key points in this document?', 'What are the main conclusions or recommendations?'],
      chunks: [],
      visuals: [],
      pagesText: [],
      visualCandidatePages: [],
      visualAnalyzedPages: [],
      contentHash,
      indexingStatus: 'queued',
      textIndexReady: false,
      visualIndexReady: false,
      visualIndexStatus: 'queued',
      indexedChunks: 0,
      uploadedAt,
    };
    documentCache.set(documentId, document);
    console.log(`[DOCUMENT UPLOAD] documentId=${documentId} name=${displayName} size=${document.size} registered=true`);

    if (isSupabaseConfigured()) {
      await upsertDocumentToDb(document, storagePath);
    }

    try {
      prepared = await extractPdfLocally(cleanBase64, documentId, currentUserId);
      document.pageCount = prepared.pageCount;
      document.pagesText = prepared.pagesText;
      document.chunks = prepared.chunks;
      document.visualCandidatePages = prepared.visualCandidatePages;
      document.visualAnalyzedPages = [];
      const extractedText = prepared.pagesText.join(' ').replace(/\s+/g, ' ').trim();
      document.summary = extractedText.slice(0, 500) || 'No selectable text was found in this PDF.';
      document.visualIndexReady = prepared.visualCandidatePages.length === 0;
      document.visualIndexStatus = document.visualIndexReady ? 'ready' : 'queued';
      console.log(`[INDEX] PDF extraction complete: ${document.name}`);
      console.log(`[INDEX] Pages: ${document.pageCount}`);
      console.log(`[INDEX] Chunks created: ${document.chunks.length}`);
      document.indexingStatus = 'queued';
      documentCache.set(documentId, document);

      if (isSupabaseConfigured()) {
        await saveChunksToDb(document.chunks);
        await updateDocumentStatusInDb(documentId, {
          pageCount: document.pageCount,
          summary: document.summary,
          pagesText: document.pagesText,
          visualCandidatePages: document.visualCandidatePages,
          visualAnalyzedPages: [],
          visualIndexReady: document.visualIndexReady,
          visualIndexStatus: document.visualIndexStatus,
          indexingStatus: 'queued',
        });
      }
    } catch (error: any) {
      document.indexingStatus = 'error';
      document.textIndexReady = false;
      document.indexingError = String(error?.message || error);
      console.error(`[PDF EXTRACTION] documentId=${documentId} error=${document.indexingError}`);
      if (isSupabaseConfigured()) {
        await updateDocumentStatusInDb(documentId, {
          indexingStatus: 'error',
          textIndexReady: false,
          indexingError: document.indexingError,
        });
      }
    }

    res.status(202).json({
      id: document.id,
      name: document.name,
      size: document.size,
      pageCount: document.pageCount,
      summary: document.summary,
      suggestedQuestions: document.suggestedQuestions,
      uploadedAt: document.uploadedAt,
      indexingStatus: document.indexingStatus,
      textIndexReady: document.textIndexReady,
      visualIndexReady: document.visualIndexReady,
      visualIndexStatus: document.visualIndexStatus,
      indexingError: document.indexingError,
      visualIndexError: document.visualIndexError,
    });
    console.log(`[DOCUMENT UPLOAD] documentId=${documentId} status=${document.indexingStatus} elapsedMs=${Date.now() - uploadStarted}`);

    if (prepared) {
      setImmediate(() => {
        void indexStoredDocument(documentId, prepared).catch((error) => {
          const failedDocument = documentCache.get(documentId);
          if (failedDocument) void logIndexError(failedDocument, 'background worker promise', error);
        });
      });
    }
  } catch (err: any) {
    if (documentId) {
      const document = documentCache.get(documentId);
      if (document) {
        document.indexingStatus = 'error';
        document.textIndexReady = false;
        document.indexingError = String(err?.message || err);
      }
    }
    res.status(500).json({ error: err.message });
    console.error(`[DOCUMENT UPLOAD] error elapsedMs=${Date.now() - uploadStarted}:`, err);
  }
});

const reindexDocument: express.RequestHandler = async (req, res) => {
  const document = await getDocument(req.params.id);
  if (!document) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (activeTextIndexJobs.has(document.id) || activeVisualIndexJobs.has(document.id)) {
    res.status(409).json({ error: 'Document indexing is already in progress.' });
    return;
  }
  document.indexingStatus = 'queued';
  document.textIndexReady = false;
  document.visualIndexReady = false;
  document.visualIndexStatus = 'queued';
  document.indexedChunks = 0;
  document.indexingError = undefined;
  document.visualIndexError = undefined;
  document.chunks = [];
  document.visuals = [];
  document.pagesText = [];
  document.visualCandidatePages = [];
  document.visualAnalyzedPages = [];
  documentCache.set(document.id, document);

  if (isSupabaseConfigured()) {
    await updateDocumentStatusInDb(document.id, {
      indexingStatus: 'queued',
      textIndexReady: false,
      visualIndexReady: false,
      visualIndexStatus: 'queued',
      indexedChunks: 0,
      indexingError: undefined,
      visualIndexError: undefined,
      pagesText: [],
      visualCandidatePages: [],
      visualAnalyzedPages: [],
    });
  }

  res.status(202).json({
    id: document.id,
    indexingStatus: document.indexingStatus,
    textIndexReady: document.textIndexReady,
    visualIndexReady: document.visualIndexReady,
  });

  const performReindex = async () => {
    let prepared: PreparedPdf | undefined;
    try {
      let pdfBase64 = document.base64;
      if (!pdfBase64 && document.storagePath && isSupabaseConfigured()) {
        const buf = await downloadPdfFromSupabaseStorage(document.storagePath);
        if (buf) {
          pdfBase64 = buf.toString('base64');
          document.base64 = pdfBase64;
        }
      }
      if (!pdfBase64) throw new Error('Cannot load PDF content for re-indexing.');

      prepared = await extractPdfLocally(pdfBase64, document.id, document.userId || 'default_user');
      document.pageCount = prepared.pageCount;
      document.pagesText = prepared.pagesText;
      document.chunks = prepared.chunks;
      document.visualCandidatePages = prepared.visualCandidatePages;
      const text = prepared.pagesText.join(' ').replace(/\s+/g, ' ').trim();
      document.summary = text.slice(0, 500) || 'No selectable text was found in this PDF.';
      document.visualIndexReady = prepared.visualCandidatePages.length === 0;
      document.visualIndexStatus = document.visualIndexReady ? 'ready' : 'queued';
      documentCache.set(document.id, document);

      if (isSupabaseConfigured()) {
        await saveChunksToDb(document.chunks);
        await updateDocumentStatusInDb(document.id, {
          pageCount: document.pageCount,
          summary: document.summary,
          pagesText: document.pagesText,
          visualCandidatePages: document.visualCandidatePages,
          visualIndexReady: document.visualIndexReady,
          visualIndexStatus: document.visualIndexStatus,
        });
      }

      await indexStoredDocument(document.id, prepared);
    } catch (error: any) {
      await logIndexError(document, 'reindex PDF extraction', error);
      if (prepared) {
        try {
          await prepared.loadingTask.destroy();
        } catch (cleanupError) {
          console.warn(`[INDEX ERROR]\ndocumentId: ${document.id}\nstage: reindex cleanup\nerror: ${String((cleanupError as Error)?.message || cleanupError)}`);
        }
      }
    }
  };

  if (isServerlessRuntime) {
    void performReindex();
  } else {
    setImmediate(() => { void performReindex(); });
  }
};

app.post('/api/documents/:id/reindex', reindexDocument);
app.post('/api/documents/:id/retry-indexing', reindexDocument);

app.post('/api/chat', async (req, res) => {
  const totalStarted = Date.now();
  try {
    const { documentId, question, history, userId } = req.body;
    if (!question || typeof question !== 'string' || !question.trim()) {
      res.status(400).json({ error: 'Question is required.' });
      console.log(`[TOTAL RESPONSE] elapsedMs=${Date.now() - totalStarted} error=missing-question`);
      return;
    }

    const currentUserId = userId || 'default_user';
    const selectedDocumentId = typeof documentId === 'string' ? documentId : '';
    const selectedDocument = await getDocument(selectedDocumentId);
    if (!selectedDocument || (selectedDocument.userId && selectedDocument.userId !== currentUserId)) {
      res.status(404).json({ error: 'Document not found.' });
      console.log(`[TOTAL RESPONSE] documentId=${selectedDocumentId} elapsedMs=${Date.now() - totalStarted} error=document-not-found`);
      return;
    }

    console.log(`[CHAT] documentId=${selectedDocumentId} question="${question.trim().slice(0, 100)}"`);

    if (!selectedDocument.textIndexReady) {
      const error = selectedDocument.indexingStatus === 'error'
        ? `Document text indexing failed: ${selectedDocument.indexingError || 'unknown error'}`
        : 'Preparing document... Text chat will be available as soon as indexing finishes.';
      res.status(409).json({ error, indexingStatus: selectedDocument.indexingStatus });
      console.log(`[TOTAL RESPONSE] documentId=${selectedDocumentId} elapsedMs=${Date.now() - totalStarted} status=${selectedDocument.indexingStatus}`);
      return;
    }
    const ai = getGeminiClient();
    const conversation = Array.isArray(history)
      ? history.filter((item: any) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string').slice(-6)
      : [];
    const referencesConversation = /\b(this|that|it|these|those|one|first|second|former|latter|above|previous|same|relevant)\b/i.test(question);
    const relevantConversation = referencesConversation ? conversation : [];
    const retrievalQuery = relevantConversation.length > 0
      ? [`Current question: ${question.trim()}`, ...relevantConversation.map((item: any) => `${item.role}: ${item.text.slice(0, 1200)}`)].join('\n')
      : question.trim();
    const retrievalStarted = Date.now();
    let queryEmbedding: number[] = [];
    try {
      queryEmbedding = await embedText(ai, retrievalQuery);
      if (queryEmbedding.length === 0) throw new Error('Empty query embedding');
    } catch (error) {
      console.error(`[RAG RETRIEVAL ERROR]\ndocumentId: ${selectedDocumentId}\nstage: query embedding\nerror: ${String((error as Error)?.message || error)}`);
      res.status(503).json({ error: 'Could not create a question embedding. Please try again.' });
      console.log(`[TOTAL RESPONSE] documentId=${selectedDocumentId} elapsedMs=${Date.now() - totalStarted} error=query-embedding`);
      return;
    }

    const retrieval = retrieveRelevantChunks(queryEmbedding, selectedDocument, currentUserId, 5);
    console.log(`[TEXT RETRIEVAL] documentId=${selectedDocumentId} chunks=${retrieval.results.length} elapsedMs=${Date.now() - retrievalStarted}`);

    const visualContext = [
      ...relevantConversation.map((item: any) => `${item.role}: ${item.text.slice(0, 300)}`),
      ...retrieval.results.slice(0, 1).map((chunk) => chunk.text.slice(0, 600)),
    ].join('\n').slice(0, 1500);
    const visualSearchText = [`Question: ${question.trim()}`, visualContext ? `Retrieved text context: ${visualContext}` : ''].filter(Boolean).join('\n');
    let relatedVisuals: StoredVisual[] = [];
    if (selectedDocument.visualIndexReady) {
      try {
        const visualQueryEmbedding = await embedText(ai, visualSearchText);
        if (visualQueryEmbedding.length > 0) {
          relatedVisuals = retrieveRelevantVisuals(
            visualQueryEmbedding,
            selectedDocument,
            currentUserId,
            question,
            visualContext,
            new Set(retrieval.results.slice(0, 1).map((chunk) => chunk.pageNumber)),
          );
        }
      } catch (error) {
        console.error(`[VISUAL QUERY ERROR]\ndocumentId: ${selectedDocumentId}\nstage: visual context embedding\nerror: ${String((error as Error)?.message || error)}`);
      }
    }
    console.log(`[VISUAL RETRIEVAL] documentId=${selectedDocumentId} visuals=${relatedVisuals.length}`);
    console.log(`[RAG RETRIEVAL] documentId=${selectedDocumentId} chunks=${retrieval.results.length} visuals=${relatedVisuals.length} elapsedMs=${Date.now() - retrievalStarted}`);
    if (!retrieval.hasRelevantResults && relatedVisuals.length === 0) {
      res.json({
        answer: "I couldn't find this information in the PDF.",
        pageNumbers: [],
        relevantExcerpt: '',
        isFoundInDocument: false,
        topic: 'Out of Scope',
        suggestedFollowUps: [],
        relatedVisuals: [],
      });
      console.log(`[TOTAL RESPONSE] documentId=${selectedDocumentId} elapsedMs=${Date.now() - totalStarted}`);
      return;
    }

    const relevantExcerpt = selectRelevantEvidenceExcerpt(
      question,
      retrieval.results,
      relevantConversation.map((item: any) => item.text).join(' '),
    );
    const pageNumbers = Array.from(new Set([
      ...retrieval.results.map((chunk) => chunk.pageNumber),
      ...relatedVisuals.map((visual) => visual.pageNumber),
    ]));
    const systemInstruction = 'You are a precise PDF Q&A assistant. Answer only from the retrieved page text and supplied rendered PDF visuals. Conversation history may resolve references but is not a factual source. Do not infer visual details that are not visible. Cite relevant page numbers.';
    const contents: any[] = [];
    for (const item of relevantConversation) {
      contents.push({
        role: item.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: item.text }],
      });
    }
    const visualMetadata = relatedVisuals.map(({ embedding: _embedding, imageData: _imageData, ...visual }) => visual);
    const visualParts = relatedVisuals.flatMap((visual) => [
      { text: `Retrieved PDF visual: ${JSON.stringify({ id: visual.id, type: visual.type, title: visual.title, caption: visual.caption, description: visual.description, pageNumber: visual.pageNumber })}` },
      { inlineData: { mimeType: 'image/jpeg', data: visual.imageData.replace(/^data:image\/jpeg;base64,/, '') } },
    ]);
    contents.push({
      role: 'user',
      parts: [
        { text: `Retrieved text chunks: ${JSON.stringify(retrieval.results)}\n\nRetrieved visual metadata: ${JSON.stringify(visualMetadata)}\n\nQuestion: ${question}` },
        ...visualParts,
      ],
    });

    const llmStarted = Date.now();
    const response = await generateContentWithRetry(ai, {
      contents,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            answer: { type: Type.STRING },
            pageNumbers: { type: Type.ARRAY, items: { type: Type.INTEGER } },
            relevantExcerpt: { type: Type.STRING },
            isFoundInDocument: { type: Type.BOOLEAN },
            topic: { type: Type.STRING },
            suggestedFollowUps: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ['answer', 'pageNumbers', 'relevantExcerpt', 'isFoundInDocument'],
        },
      },
    });
    console.log(`[LLM] documentId=${selectedDocumentId} elapsedMs=${Date.now() - llmStarted}`);

    const parsed = JSON.parse(response.text || '{}');
    const answer = parsed.answer || 'Answer generated from vector retrieval.';
    const finalPageNumbers = pageNumbers.length > 0 ? pageNumbers : parsed.pageNumbers || [1];
    const isFoundInDocument = parsed.isFoundInDocument !== false;
    const topic = parsed.topic || '';
    const suggestedFollowUps = parsed.suggestedFollowUps || [];
    const formattedVisuals = relatedVisuals.map(({ embedding: _embedding, ...visual }) => visual);

    // Persist conversation and messages in Supabase
    if (isSupabaseConfigured()) {
      void saveChatMessage(selectedDocumentId, {
        role: 'user',
        text: question.trim(),
      }, currentUserId).catch((e) => console.error(`[SUPABASE] Failed to save user message: ${e.message}`));

      void saveChatMessage(selectedDocumentId, {
        role: 'assistant',
        text: answer,
        pageNumbers: finalPageNumbers,
        relevantExcerpt,
        isFoundInDocument,
        topic,
        suggestedFollowUps,
        relatedVisuals: formattedVisuals,
      }, currentUserId).catch((e) => console.error(`[SUPABASE] Failed to save assistant message: ${e.message}`));
    }

    res.json({
      answer,
      pageNumbers: finalPageNumbers,
      relevantExcerpt,
      isFoundInDocument,
      topic,
      suggestedFollowUps,
      relatedVisuals: formattedVisuals,
    });
    console.log(`[TOTAL RESPONSE] documentId=${selectedDocumentId} elapsedMs=${Date.now() - totalStarted}`);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
    console.error(`[TOTAL RESPONSE] elapsedMs=${Date.now() - totalStarted} error=${err.message}`);
  }
});

initializeSamples();

if (!isServerlessRuntime && process.env.NODE_ENV !== 'production') {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
} else if (!isServerlessRuntime) {
  app.use(express.static(path.resolve(__dirname, 'dist')));
  app.get('*', (_req, res) => res.sendFile(path.resolve(__dirname, 'dist/index.html')));
}

// Guaranteed Server Startup Runner
function startSampleIndexing() {
  for (const sample of SAMPLE_DOCUMENTS) {
    setImmediate(() => {
      void indexSampleDocument(sample.id).catch((error) => {
        const document = documentCache.get(sample.id);
        if (document) void logIndexError(document, 'sample background promise', error);
      });
    });
  }
}

async function startServer() {
  app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:${port}`);
    startSampleIndexing();
  });
}

if (isServerlessRuntime) {
  startSampleIndexing();
} else {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}