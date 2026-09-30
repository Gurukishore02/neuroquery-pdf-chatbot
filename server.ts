import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';
import { SAMPLE_DOCUMENTS } from './server/samplePdfs.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Body limit for PDF uploads in base64 format (up to 50MB)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// In-memory document storage for the session
interface StoredDoc {
  id: string;
  name: string;
  base64: string;
  size: number;
  pageCount: number;
  summary: string;
  suggestedQuestions: string[];
  uploadedAt: number;
}

const documentStore = new Map<string, StoredDoc>();

// Seed sample documents into store
for (const sample of SAMPLE_DOCUMENTS) {
  documentStore.set(sample.id, {
    id: sample.id,
    name: sample.name,
    base64: sample.base64,
    size: Math.round((sample.base64.length * 3) / 4),
    pageCount: sample.pageCount,
    summary: sample.description,
    suggestedQuestions: sample.suggestedQuestions,
    uploadedAt: Date.now(),
  });
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is not set. Please configure it in your AI Studio project.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function generateContentWithRetry(ai: GoogleGenAI, params: any) {
const models = [
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-flash-latest',
];
  let lastErr: any = null;

  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await ai.models.generateContent({
          ...params,
          model,
        });
        return res;
      } catch (err: any) {
        lastErr = err;
        const errMsg = String(err?.message || err);
        const isTransient =
          errMsg.includes('503') ||
          errMsg.includes('429') ||
          errMsg.includes('UNAVAILABLE') ||
          errMsg.includes('high demand') ||
          errMsg.includes('ResourceExhausted');

        if (isTransient && attempt < 2) {
          const delay = (attempt + 1) * 1200;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        if (isTransient) {
          // Break inner loop to try next fallback model
          break;
        }
        throw err;
      }
    }
  }

  throw lastErr;
}

// 1. Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    hasApiKey: Boolean(process.env.GEMINI_API_KEY),
    documentsLoaded: documentStore.size,
  });
});

// 2. List sample documents
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

// 3. Get document details and base64
app.get('/api/documents/:id', (req, res) => {
  const doc = documentStore.get(req.params.id);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  res.json({
    id: doc.id,
    name: doc.name,
    pageCount: doc.pageCount,
    size: doc.size,
    summary: doc.summary,
    suggestedQuestions: doc.suggestedQuestions,
    base64: doc.base64,
  });
});

// 4. Analyze uploaded PDF
app.post('/api/documents/analyze', async (req, res) => {
  try {
    const { name, base64, size } = req.body;
    if (!base64 || !name) {
      res.status(400).json({ error: 'Document name and base64 data are required.' });
      return;
    }

    const cleanBase64 = base64.replace(/^data:[^;]+;base64,/, '');
    const docId = `doc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    let title = name;
    let pageCount = 1;
    let summary = 'Uploaded PDF Document.';
    let suggestedQuestions: string[] = [
      'What are the key points in this document?',
      'What are the main conclusions or recommendations?',
      'What data or statistics are highlighted?',
      'What is discussed in section 1?',
    ];

    // Estimate page count from PDF binary stream tags if possible
    try {
      const buffer = Buffer.from(cleanBase64, 'base64');
      const text = buffer.toString('binary');
      const pageMatches = text.match(/\/Type\s*\/Page[^s]/g);
      if (pageMatches && pageMatches.length > 0) {
        pageCount = pageMatches.length;
      }
    } catch {
      // ignore
    }

    // Try Gemini document understanding for enhanced title, accurate pages, summary & questions
    try {
      const ai = getGeminiClient();
      const response = await generateContentWithRetry(ai, {
        contents: [
          {
            inlineData: {
              mimeType: 'application/pdf',
              data: cleanBase64,
            },
          },
          {
            text: 'Analyze this uploaded PDF. Identify the document title, exact total page count, a concise 2-sentence summary, and 4 specific, highly relevant questions that can be answered from specific pages of this PDF.',
          },
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              pageCount: { type: Type.INTEGER },
              summary: { type: Type.STRING },
              suggestedQuestions: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
            },
            required: ['title', 'pageCount', 'summary', 'suggestedQuestions'],
          },
        },
      });

      if (response.text) {
        const parsed = JSON.parse(response.text);
        if (parsed.title) title = parsed.title;
        if (parsed.pageCount && parsed.pageCount > 0) pageCount = parsed.pageCount;
        if (parsed.summary) summary = parsed.summary;
        if (Array.isArray(parsed.suggestedQuestions) && parsed.suggestedQuestions.length > 0) {
          suggestedQuestions = parsed.suggestedQuestions;
        }
      }
    } catch (aiErr) {
      console.warn('Gemini pre-analysis warning (will proceed with defaults):', aiErr);
    }

    const stored: StoredDoc = {
      id: docId,
      name,
      base64: cleanBase64,
      size: size || Math.round((cleanBase64.length * 3) / 4),
      pageCount,
      summary,
      suggestedQuestions,
      uploadedAt: Date.now(),
    };

    documentStore.set(docId, stored);

    res.json({
      id: docId,
      name,
      pageCount,
      summary,
      suggestedQuestions,
      size: stored.size,
    });
  } catch (err: any) {
    console.error('Error analyzing document:', err);
    res.status(500).json({ error: err.message || 'Failed to analyze document.' });
  }
});

// 5. Ask question about PDF
app.post('/api/chat', async (req, res) => {
  try {
    const { documentId, documentBase64, documentName, question, history } = req.body;

    if (!question || typeof question !== 'string' || !question.trim()) {
      res.status(400).json({ error: 'Question is required.' });
      return;
    }

    let pdfBase64 = '';
    let name = documentName || 'Document.pdf';

    if (documentId && documentStore.has(documentId)) {
      const stored = documentStore.get(documentId)!;
      pdfBase64 = stored.base64;
      name = stored.name;
    } else if (documentBase64) {
      pdfBase64 = documentBase64.replace(/^data:[^;]+;base64,/, '');
    }

    if (!pdfBase64) {
      res.status(400).json({ error: 'No active PDF document found. Please upload or select a PDF first.' });
      return;
    }

    const ai = getGeminiClient();

    const systemInstruction = `You are an expert, precise PDF Document Q&A Assistant.
Your sole purpose is to answer the user's questions based EXCLUSIVELY on the relevant content in the provided PDF document.

STRICT INSTRUCTIONS:
1. ONLY answer using facts directly written in the relevant sections of the PDF.
2. DO NOT return or summarize the entire PDF. Provide a direct, concise, and focused answer addressing specifically what was asked.
3. DO NOT use unrelated PDF content. If the user asks about one specific topic, only address that topic without rambling about other unrelated sections.
4. DO NOT give the same answer for different questions. Each distinct question must be uniquely analyzed to extract the specific facts relevant to that query.
5. PAGE NUMBERS: Identify the exact 1-based page number(s) (e.g. [1], [2], or [2, 3]) in the PDF where the relevant information and evidence appear.
6. RELEVANT EXCERPT: Provide the exact 1 to 3 sentence verbatim quote from the PDF that directly substantiates the answer.
7. MISSING OR UNRELATED QUESTIONS: If the question cannot be answered based on the PDF content, set "isFoundInDocument": false, "pageNumbers": [], "relevantExcerpt": "", and clearly state in "answer" that the uploaded document does not contain this information. Do not hallucinate or search outside knowledge.
8. Follow-up suggestions: Provide 2-3 short, relevant follow-up questions the user can ask about this specific aspect of the document.`;

    // Format conversation history
    const contents: any[] = [];

    if (history && Array.isArray(history) && history.length > 0) {
      const firstTurn = history[0];
      contents.push({
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType: 'application/pdf',
              data: pdfBase64,
            },
          },
          {
            text: `Document: "${name}".\n\nQuestion: ${firstTurn.text}`,
          },
        ],
      });

      for (let i = 1; i < history.length; i++) {
        const item = history[i];
        if (item.role === 'assistant') {
          contents.push({
            role: 'model',
            parts: [
              {
                text: JSON.stringify({
                  answer: item.text,
                  pageNumbers: item.pageNumbers || [],
                  relevantExcerpt: item.relevantExcerpt || '',
                  isFoundInDocument: item.isFoundInDocument !== false,
                }),
              },
            ],
          });
        } else if (item.role === 'user') {
          contents.push({
            role: 'user',
            parts: [{ text: item.text }],
          });
        }
      }

      contents.push({
        role: 'user',
        parts: [
          {
            text: `Answer this specific question strictly from the relevant content of the PDF:\n"${question.trim()}"`,
          },
        ],
      });
    } else {
      contents.push({
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType: 'application/pdf',
              data: pdfBase64,
            },
          },
          {
            text: `Answer the following question strictly based on the provided PDF "${name}":\n"${question.trim()}"`,
          },
        ],
      });
    }

    const response = await generateContentWithRetry(ai, {
      contents,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            answer: {
              type: Type.STRING,
              description: 'Direct, focused answer strictly from relevant PDF content.',
            },
            pageNumbers: {
              type: Type.ARRAY,
              items: { type: Type.INTEGER },
              description: '1-based PDF page numbers containing the evidence.',
            },
            relevantExcerpt: {
              type: Type.STRING,
              description: 'Verbatim excerpt/quote from the PDF supporting the answer.',
            },
            isFoundInDocument: {
              type: Type.BOOLEAN,
              description: 'Whether the answer is found in the PDF.',
            },
            topic: {
              type: Type.STRING,
              description: 'Short topic title for the answer.',
            },
            suggestedFollowUps: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: '2 to 3 related follow-up questions.',
            },
          },
          required: ['answer', 'pageNumbers', 'relevantExcerpt', 'isFoundInDocument'],
        },
      },
    });

    const rawText = response.text;
    if (!rawText) {
      throw new Error('Gemini returned an empty response.');
    }

    const parsed = JSON.parse(rawText);

    res.json({
      answer: parsed.answer || 'No answer generated.',
      pageNumbers: Array.isArray(parsed.pageNumbers) ? parsed.pageNumbers : [],
      relevantExcerpt: parsed.relevantExcerpt || '',
      isFoundInDocument: parsed.isFoundInDocument !== false,
      topic: parsed.topic || '',
      suggestedFollowUps: Array.isArray(parsed.suggestedFollowUps) ? parsed.suggestedFollowUps : [],
    });
  } catch (err: any) {
    console.error('Error generating answer:', err);
    res.status(500).json({
      error: err.message || 'An error occurred while answering your question with Gemini AI.',
    });
  }
});

// Setup Vite middleware in dev or static files in prod
if (process.env.NODE_ENV !== 'production') {
  const { createServer } = await import('vite');
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
} else {
  app.use(express.static(path.resolve(__dirname, 'dist')));
  app.get('*', (_req, res) => {
    res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
  });
}

app.listen(port, '0.0.0.0', () => {
  console.log(`NeuroQuery AI server listening on port ${port}`);
});
