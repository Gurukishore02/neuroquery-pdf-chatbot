import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface Chunk {
  chunkId: string;
  documentId: string;
  userId: string;
  pageNumber: number;
  text: string;
  embedding?: number[];
}

export type VisualType = 'image' | 'figure' | 'diagram' | 'chart' | 'graph' | 'table' | 'flowchart' | 'illustration' | 'map' | 'screenshot' | 'other';

export interface StoredVisual {
  id: string;
  documentId: string;
  pageNumber: number;
  type: VisualType;
  title: string;
  caption: string;
  description: string;
  imageData: string;
  imagePath?: string;
  embedding: number[];
}

export interface StoredDoc {
  id: string;
  userId?: string;
  name: string;
  base64: string;
  storagePath?: string;
  size: number;
  pageCount: number;
  summary: string;
  suggestedQuestions: string[];
  chunks: Chunk[];
  visuals: StoredVisual[];
  pagesText: string[];
  visualCandidatePages: number[];
  visualAnalyzedPages: number[];
  contentHash: string;
  indexingStatus: 'queued' | 'processing' | 'ready' | 'error';
  textIndexReady: boolean;
  visualIndexReady: boolean;
  visualIndexStatus: 'queued' | 'processing' | 'ready' | 'error';
  indexedChunks: number;
  indexingError?: string;
  visualIndexError?: string;
  uploadedAt: number;
}

let supabaseInstance: SupabaseClient | null = null;
let supabaseLogged = false;

export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function getSupabaseClient(): SupabaseClient | null {
  if (!isSupabaseConfigured()) {
    if (!supabaseLogged) {
      console.log('[SUPABASE] Credentials not configured (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY). Running in fallback mode.');
      supabaseLogged = true;
    }
    return null;
  }

  if (!supabaseInstance) {
    const supabaseUrl = process.env.SUPABASE_URL!.trim();
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
    supabaseInstance = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
    console.log('[SUPABASE] Client successfully initialized with service role key.');
  }

  return supabaseInstance;
}

export const STORAGE_BUCKET_DOCUMENTS = 'documents';

/**
 * Ensures the 'documents' private bucket exists in Supabase Storage.
 */
export async function ensureDocumentsBucketExists(): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;
  try {
    const { data: buckets, error: listError } = await supabase.storage.listBuckets();
    if (listError) {
      console.warn(`[SUPABASE] Could not list storage buckets: ${listError.message}`);
      return;
    }
    const exists = buckets?.some((b) => b.name === STORAGE_BUCKET_DOCUMENTS);
    if (!exists) {
      const { error: createError } = await supabase.storage.createBucket(STORAGE_BUCKET_DOCUMENTS, {
        public: false,
        fileSizeLimit: 52428800,
        allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
      });
      if (createError && !createError.message.includes('already exists')) {
        console.warn(`[SUPABASE] Bucket creation notice: ${createError.message}`);
      } else {
        console.log(`[SUPABASE] Created private storage bucket: "${STORAGE_BUCKET_DOCUMENTS}"`);
      }
    }
  } catch (err: any) {
    console.warn(`[SUPABASE] Storage bucket verification check: ${err.message}`);
  }
}

/**
 * Uploads a PDF to Supabase Storage in the private 'documents' bucket.
 */
export async function uploadPdfToSupabaseStorage(
  documentId: string,
  fileName: string,
  buffer: Buffer,
): Promise<string | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  const sanitizedName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `pdfs/${documentId}/${sanitizedName}`;

  try {
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET_DOCUMENTS)
      .upload(storagePath, buffer, {
        contentType: 'application/pdf',
        upsert: true,
      });

    if (error) {
      console.error(`[SUPABASE] Failed to upload PDF to storage: ${error.message}`);
      return null;
    }

    console.log(`[SUPABASE] Stored PDF in Supabase Storage: ${storagePath}`);
    return storagePath;
  } catch (err: any) {
    console.error(`[SUPABASE] Storage upload exception: ${err.message}`);
    return null;
  }
}

/**
 * Downloads a PDF from Supabase Storage as a Buffer.
 */
export async function downloadPdfFromSupabaseStorage(storagePath: string): Promise<Buffer | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET_DOCUMENTS)
      .download(storagePath);

    if (error || !data) {
      console.error(`[SUPABASE] Failed to download PDF from storage: ${error?.message}`);
      return null;
    }

    const arrayBuffer = await data.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err: any) {
    console.error(`[SUPABASE] Storage download exception: ${err.message}`);
    return null;
  }
}

/**
 * Uploads a visual crop JPEG image to Supabase Storage.
 */
export async function uploadVisualImageToSupabaseStorage(
  documentId: string,
  visualId: string,
  imageBuffer: Buffer,
): Promise<string | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  const storagePath = `visuals/${documentId}/${visualId}.jpg`;
  try {
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET_DOCUMENTS)
      .upload(storagePath, imageBuffer, {
        contentType: 'image/jpeg',
        upsert: true,
      });

    if (error) {
      console.warn(`[SUPABASE] Failed to upload visual crop image: ${error.message}`);
      return null;
    }

    return storagePath;
  } catch (err: any) {
    console.warn(`[SUPABASE] Visual storage upload exception: ${err.message}`);
    return null;
  }
}

/**
 * Downloads a visual image from Supabase Storage.
 */
export async function downloadVisualImageFromSupabaseStorage(storagePath: string): Promise<Buffer | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET_DOCUMENTS)
      .download(storagePath);

    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Creates a signed URL for a file in Supabase Storage.
 */
export async function createSignedUrl(storagePath: string, expiresIn = 3600): Promise<string | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET_DOCUMENTS)
      .createSignedUrl(storagePath, expiresIn);

    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}

/**
 * Loads a single document from Supabase PostgreSQL.
 */
export async function getDocumentFromDb(documentId: string): Promise<StoredDoc | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from('documents')
      .select('*')
      .eq('id', documentId)
      .maybeSingle();

    if (error) {
      console.error(`[SUPABASE] Error reading document ${documentId}: ${error.message}`);
      return null;
    }
    if (!data) return null;

    // Load chunks and visuals for complete StoredDoc
    const [chunks, visuals] = await Promise.all([
      getChunksFromDb(documentId),
      getVisualsFromDb(documentId),
    ]);

    let base64 = '';
    if (data.storage_path) {
      const pdfBuf = await downloadPdfFromSupabaseStorage(data.storage_path);
      if (pdfBuf) base64 = pdfBuf.toString('base64');
    }

    return {
      id: data.id,
      userId: data.user_id || 'default_user',
      name: data.name,
      base64,
      storagePath: data.storage_path,
      size: Number(data.size || 0),
      pageCount: Number(data.page_count || 0),
      summary: data.summary || '',
      suggestedQuestions: Array.isArray(data.suggested_questions) ? data.suggested_questions : [],
      chunks,
      visuals,
      pagesText: Array.isArray(data.pages_text) ? data.pages_text : [],
      visualCandidatePages: Array.isArray(data.visual_candidate_pages) ? data.visual_candidate_pages : [],
      visualAnalyzedPages: Array.isArray(data.visual_analyzed_pages) ? data.visual_analyzed_pages : [],
      contentHash: data.content_hash || '',
      indexingStatus: data.status || 'queued',
      textIndexReady: Boolean(data.text_index_ready),
      visualIndexReady: Boolean(data.visual_index_ready),
      visualIndexStatus: data.visual_index_status || 'queued',
      indexedChunks: Number(data.indexed_chunks || chunks.length),
      indexingError: data.indexing_error || undefined,
      visualIndexError: data.visual_index_error || undefined,
      uploadedAt: data.created_at ? new Date(data.created_at).getTime() : Date.now(),
    };
  } catch (err: any) {
    console.error(`[SUPABASE] Exception in getDocumentFromDb(${documentId}): ${err.message}`);
    return null;
  }
}

/**
 * Lists all documents from Supabase PostgreSQL for a specific user.
 */
export async function listDocumentsFromDb(userId = 'default_user'): Promise<StoredDoc[]> {
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from('documents')
      .select('*')
      .or(`user_id.eq.${userId},user_id.is.null`)
      .order('created_at', { ascending: false });

    if (error) {
      console.error(`[SUPABASE] Error listing documents: ${error.message}`);
      return [];
    }

    return (data || []).map((row) => ({
      id: row.id,
      userId: row.user_id || 'default_user',
      name: row.name,
      base64: '',
      storagePath: row.storage_path,
      size: Number(row.size || 0),
      pageCount: Number(row.page_count || 0),
      summary: row.summary || '',
      suggestedQuestions: Array.isArray(row.suggested_questions) ? row.suggested_questions : [],
      chunks: [],
      visuals: [],
      pagesText: Array.isArray(row.pages_text) ? row.pages_text : [],
      visualCandidatePages: Array.isArray(row.visual_candidate_pages) ? row.visual_candidate_pages : [],
      visualAnalyzedPages: Array.isArray(row.visual_analyzed_pages) ? row.visual_analyzed_pages : [],
      contentHash: row.content_hash || '',
      indexingStatus: row.status || 'queued',
      textIndexReady: Boolean(row.text_index_ready),
      visualIndexReady: Boolean(row.visual_index_ready),
      visualIndexStatus: row.visual_index_status || 'queued',
      indexedChunks: Number(row.indexed_chunks || 0),
      indexingError: row.indexing_error || undefined,
      visualIndexError: row.visual_index_error || undefined,
      uploadedAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    }));
  } catch (err: any) {
    console.error(`[SUPABASE] Exception in listDocumentsFromDb: ${err.message}`);
    return [];
  }
}

/**
 * Finds a document by its contentHash and user to prevent duplicate uploads.
 */
export async function findDocumentByContentHash(contentHash: string, userId = 'default_user'): Promise<StoredDoc | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from('documents')
      .select('id')
      .eq('content_hash', contentHash)
      .or(`user_id.eq.${userId},user_id.is.null`)
      .maybeSingle();

    if (error || !data) return null;
    return getDocumentFromDb(data.id);
  } catch {
    return null;
  }
}

/**
 * Upserts a document metadata record into Supabase PostgreSQL.
 */
export async function upsertDocumentToDb(doc: StoredDoc, storagePath?: string): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  try {
    const payload = {
      id: doc.id,
      user_id: doc.userId || 'default_user',
      name: doc.name,
      storage_path: storagePath ?? doc.storagePath ?? null,
      file_path: storagePath ?? doc.storagePath ?? null,
      size: doc.size,
      page_count: doc.pageCount,
      summary: doc.summary,
      suggested_questions: doc.suggestedQuestions,
      status: doc.indexingStatus,
      text_index_ready: doc.textIndexReady,
      visual_index_ready: doc.visualIndexReady,
      visual_index_status: doc.visualIndexStatus,
      indexed_chunks: doc.indexedChunks,
      indexing_error: doc.indexingError || null,
      visual_index_error: doc.visualIndexError || null,
      content_hash: doc.contentHash,
      pages_text: doc.pagesText,
      visual_candidate_pages: doc.visualCandidatePages,
      visual_analyzed_pages: doc.visualAnalyzedPages,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from('documents')
      .upsert(payload, { onConflict: 'id' });

    if (error) {
      console.error(`[SUPABASE] Error upserting document ${doc.id}: ${error.message}`);
    } else {
      console.log(`[SUPABASE] Upserted document record: ${doc.id} status=${doc.indexingStatus}`);
    }
  } catch (err: any) {
    console.error(`[SUPABASE] Exception in upsertDocumentToDb: ${err.message}`);
  }
}

/**
 * Updates status/progress of a document in Supabase PostgreSQL.
 */
export async function updateDocumentStatusInDb(
  documentId: string,
  updates: Partial<StoredDoc>,
): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  try {
    const payload: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };
    if (updates.indexingStatus !== undefined) payload.status = updates.indexingStatus;
    if (updates.textIndexReady !== undefined) payload.text_index_ready = updates.textIndexReady;
    if (updates.visualIndexReady !== undefined) payload.visual_index_ready = updates.visualIndexReady;
    if (updates.visualIndexStatus !== undefined) payload.visual_index_status = updates.visualIndexStatus;
    if (updates.indexedChunks !== undefined) payload.indexed_chunks = updates.indexedChunks;
    if (updates.indexingError !== undefined) payload.indexing_error = updates.indexingError;
    if (updates.visualIndexError !== undefined) payload.visual_index_error = updates.visualIndexError;
    if (updates.pageCount !== undefined) payload.page_count = updates.pageCount;
    if (updates.summary !== undefined) payload.summary = updates.summary;
    if (updates.pagesText !== undefined) payload.pages_text = updates.pagesText;
    if (updates.visualCandidatePages !== undefined) payload.visual_candidate_pages = updates.visualCandidatePages;
    if (updates.visualAnalyzedPages !== undefined) payload.visual_analyzed_pages = updates.visualAnalyzedPages;

    const { error } = await supabase
      .from('documents')
      .update(payload)
      .eq('id', documentId);

    if (error) {
      console.error(`[SUPABASE] Failed to update document status for ${documentId}: ${error.message}`);
    }
  } catch (err: any) {
    console.error(`[SUPABASE] Exception updating document status: ${err.message}`);
  }
}

/**
 * Stores document text chunks and embeddings into Supabase PostgreSQL.
 */
export async function saveChunksToDb(chunks: Chunk[]): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase || chunks.length === 0) return;

  try {
    const documentId = chunks[0].documentId;
    // Format rows for document_chunks table
    const rows = chunks.map((chunk, index) => ({
      id: chunk.chunkId,
      document_id: chunk.documentId,
      chunk_index: index + 1,
      page_number: chunk.pageNumber,
      content: chunk.text,
      embedding: chunk.embedding?.length ? chunk.embedding : null,
      metadata: { userId: chunk.userId },
      created_at: new Date().toISOString(),
    }));

    // Insert in batches of 50
    const batchSize = 50;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const { error } = await supabase
        .from('document_chunks')
        .upsert(batch, { onConflict: 'id' });

      if (error) {
        console.error(`[SUPABASE] Error saving chunks batch ${i / batchSize + 1} for ${documentId}: ${error.message}`);
      }
    }
    console.log(`[SUPABASE] Saved ${chunks.length} chunks to database for documentId=${documentId}`);
  } catch (err: any) {
    console.error(`[SUPABASE] Exception in saveChunksToDb: ${err.message}`);
  }
}

/**
 * Fetches all text chunks for a document from Supabase PostgreSQL.
 */
export async function getChunksFromDb(documentId: string): Promise<Chunk[]> {
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from('document_chunks')
      .select('*')
      .eq('document_id', documentId)
      .order('chunk_index', { ascending: true });

    if (error) {
      console.error(`[SUPABASE] Error getting chunks for ${documentId}: ${error.message}`);
      return [];
    }

    return (data || []).map((row) => {
      let embedding: number[] | undefined;
      if (row.embedding) {
        embedding = typeof row.embedding === 'string'
          ? JSON.parse(row.embedding.replace(/[\[\]]/g, (match: string) => match))
          : Array.isArray(row.embedding) ? row.embedding : undefined;
      }
      return {
        chunkId: row.id,
        documentId: row.document_id,
        userId: row.metadata?.userId || 'default_user',
        pageNumber: row.page_number,
        text: row.content,
        embedding,
      };
    });
  } catch (err: any) {
    console.error(`[SUPABASE] Exception in getChunksFromDb(${documentId}): ${err.message}`);
    return [];
  }
}

/**
 * Stores document visual elements and their embeddings into Supabase PostgreSQL.
 */
export async function saveVisualsToDb(visuals: StoredVisual[]): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase || visuals.length === 0) return;

  try {
    const documentId = visuals[0].documentId;
    const rows = await Promise.all(visuals.map(async (visual, index) => {
      let imagePath = visual.imagePath || `visuals/${visual.documentId}/${visual.id}.jpg`;
      // If we have base64 image data and no storage path, persist to Supabase Storage
      if (visual.imageData && visual.imageData.startsWith('data:image')) {
        const base64Data = visual.imageData.replace(/^data:image\/[^;]+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        const uploadedPath = await uploadVisualImageToSupabaseStorage(visual.documentId, visual.id, buffer);
        if (uploadedPath) imagePath = uploadedPath;
      }

      return {
        id: visual.id,
        document_id: visual.documentId,
        page_number: visual.pageNumber,
        visual_index: index + 1,
        image_path: imagePath,
        caption: visual.caption || '',
        description: visual.description || '',
        metadata: {
          type: visual.type,
          title: visual.title,
          // Preserve raw data URL for fast inline loading if needed
          imageData: visual.imageData,
        },
        embedding: visual.embedding?.length ? visual.embedding : null,
        created_at: new Date().toISOString(),
      };
    }));

    const { error } = await supabase
      .from('document_visuals')
      .upsert(rows, { onConflict: 'id' });

    if (error) {
      console.error(`[SUPABASE] Error saving visuals for ${documentId}: ${error.message}`);
    } else {
      console.log(`[SUPABASE] Saved ${visuals.length} visuals to database for documentId=${documentId}`);
    }
  } catch (err: any) {
    console.error(`[SUPABASE] Exception in saveVisualsToDb: ${err.message}`);
  }
}

/**
 * Fetches all visuals for a document from Supabase PostgreSQL.
 */
export async function getVisualsFromDb(documentId: string): Promise<StoredVisual[]> {
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from('document_visuals')
      .select('*')
      .eq('document_id', documentId)
      .order('visual_index', { ascending: true });

    if (error) {
      console.error(`[SUPABASE] Error getting visuals for ${documentId}: ${error.message}`);
      return [];
    }

    const visuals = await Promise.all((data || []).map(async (row) => {
      let embedding: number[] = [];
      if (row.embedding) {
        embedding = typeof row.embedding === 'string'
          ? JSON.parse(row.embedding)
          : Array.isArray(row.embedding) ? row.embedding : [];
      }

      let imageData = row.metadata?.imageData || '';
      if (!imageData && row.image_path) {
        const imgBuffer = await downloadVisualImageFromSupabaseStorage(row.image_path);
        if (imgBuffer) {
          imageData = `data:image/jpeg;base64,${imgBuffer.toString('base64')}`;
        }
      }

      return {
        id: row.id,
        documentId: row.document_id,
        pageNumber: row.page_number,
        type: (row.metadata?.type || 'other') as VisualType,
        title: row.metadata?.title || row.caption || '',
        caption: row.caption || '',
        description: row.description || '',
        imageData,
        imagePath: row.image_path,
        embedding,
      };
    }));

    return visuals;
  } catch (err: any) {
    console.error(`[SUPABASE] Exception in getVisualsFromDb(${documentId}): ${err.message}`);
    return [];
  }
}

/**
 * Gets or creates the conversation record for a document in Supabase.
 */
export async function getOrCreateConversation(
  documentId: string,
  userId = 'default_user',
): Promise<string | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  try {
    const { data: existing, error: findError } = await supabase
      .from('conversations')
      .select('id')
      .eq('document_id', documentId)
      .eq('user_id', userId)
      .maybeSingle();

    if (existing) return existing.id;
    if (findError) {
      console.warn(`[SUPABASE] Finding conversation notice: ${findError.message}`);
    }

    const { data: created, error: createError } = await supabase
      .from('conversations')
      .insert({ document_id: documentId, user_id: userId })
      .select('id')
      .single();

    if (createError) {
      console.error(`[SUPABASE] Error creating conversation for doc ${documentId}: ${createError.message}`);
      return null;
    }
    return created.id;
  } catch (err: any) {
    console.error(`[SUPABASE] Exception in getOrCreateConversation: ${err.message}`);
    return null;
  }
}

/**
 * Persists a chat message in Supabase PostgreSQL under the document's conversation.
 */
export async function saveChatMessage(
  documentId: string,
  message: {
    role: 'user' | 'assistant';
    text: string;
    pageNumbers?: number[];
    relevantExcerpt?: string;
    isFoundInDocument?: boolean;
    topic?: string;
    suggestedFollowUps?: string[];
    relatedVisuals?: any[];
  },
  userId = 'default_user',
): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  try {
    const conversationId = await getOrCreateConversation(documentId, userId);
    if (!conversationId) return;

    const { error } = await supabase.from('chat_messages').insert({
      conversation_id: conversationId,
      role: message.role,
      content: message.text,
      citations: {
        pageNumbers: message.pageNumbers || [],
        relevantExcerpt: message.relevantExcerpt || '',
        isFoundInDocument: message.isFoundInDocument !== false,
        topic: message.topic || '',
        suggestedFollowUps: message.suggestedFollowUps || [],
      },
      related_visuals: (message.relatedVisuals || []).map((v) => ({
        id: v.id,
        documentId: v.documentId,
        pageNumber: v.pageNumber,
        type: v.type,
        title: v.title,
        caption: v.caption,
        description: v.description,
        imageData: v.imageData,
      })),
      created_at: new Date().toISOString(),
    });

    if (error) {
      console.error(`[SUPABASE] Error saving chat message: ${error.message}`);
    } else {
      console.log(`[SUPABASE] Saved ${message.role} message for documentId=${documentId}`);
    }
  } catch (err: any) {
    console.error(`[SUPABASE] Exception saving chat message: ${err.message}`);
  }
}

/**
 * Retrieves the full chat history for a document from Supabase PostgreSQL.
 */
export async function getChatMessages(documentId: string, userId = 'default_user'): Promise<any[]> {
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  try {
    const { data: conv, error: convError } = await supabase
      .from('conversations')
      .select('id')
      .eq('document_id', documentId)
      .eq('user_id', userId)
      .maybeSingle();

    if (convError || !conv) return [];

    const { data: messages, error: msgError } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('conversation_id', conv.id)
      .order('created_at', { ascending: true });

    if (msgError) {
      console.error(`[SUPABASE] Error loading messages: ${msgError.message}`);
      return [];
    }

    return (messages || []).map((m) => {
      const citations = m.citations || {};
      return {
        id: m.id,
        role: m.role,
        text: m.content,
        pageNumbers: citations.pageNumbers || [],
        relevantExcerpt: citations.relevantExcerpt || '',
        isFoundInDocument: citations.isFoundInDocument !== false,
        topic: citations.topic || '',
        suggestedFollowUps: citations.suggestedFollowUps || [],
        relatedVisuals: m.related_visuals || [],
        timestamp: new Date(m.created_at).getTime(),
      };
    });
  } catch (err: any) {
    console.error(`[SUPABASE] Exception loading chat messages: ${err.message}`);
    return [];
  }
}

/**
 * Clears the chat history for a document from Supabase PostgreSQL.
 */
export async function clearChatMessages(documentId: string, userId = 'default_user'): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  try {
    const { data: conv } = await supabase
      .from('conversations')
      .select('id')
      .eq('document_id', documentId)
      .eq('user_id', userId)
      .maybeSingle();

    if (!conv) return;

    await supabase
      .from('chat_messages')
      .delete()
      .eq('conversation_id', conv.id);

    console.log(`[SUPABASE] Cleared chat messages for documentId=${documentId}`);
  } catch (err: any) {
    console.error(`[SUPABASE] Exception clearing chat messages: ${err.message}`);
  }
}
