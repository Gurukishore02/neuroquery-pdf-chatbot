-- ==============================================================================
-- NeuroQuery PDF Chatbot - Supabase Database Schema
-- Run this in the Supabase SQL Editor to set up tables, vector extension, and storage.
-- ==============================================================================

-- 1. Enable required PostgreSQL extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- 2. Storage Bucket setup for private PDF and visual assets
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'documents',
  'documents',
  false,
  52428800, -- 50MB
  ARRAY['application/pdf', 'image/jpeg', 'image/png']
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = 52428800,
  allowed_mime_types = ARRAY['application/pdf', 'image/jpeg', 'image/png'];

-- 3. Documents Table
-- Tracks metadata, indexing status, and storage references for all documents.
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  user_id TEXT DEFAULT 'default_user',
  name TEXT NOT NULL,
  storage_path TEXT,
  file_path TEXT,
  size BIGINT DEFAULT 0,
  page_count INT DEFAULT 0,
  summary TEXT DEFAULT '',
  suggested_questions JSONB DEFAULT '[]'::jsonb,
  status TEXT DEFAULT 'queued',
  text_index_ready BOOLEAN DEFAULT false,
  visual_index_ready BOOLEAN DEFAULT false,
  visual_index_status TEXT DEFAULT 'queued',
  indexed_chunks INT DEFAULT 0,
  indexing_error TEXT,
  visual_index_error TEXT,
  content_hash TEXT,
  pages_text JSONB DEFAULT '[]'::jsonb,
  visual_candidate_pages JSONB DEFAULT '[]'::jsonb,
  visual_analyzed_pages JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_documents_user_id ON documents(user_id);
CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(content_hash);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);

-- 4. Document Chunks Table (with 3072-dimension pgvector for Gemini gemini-embedding-001)
CREATE TABLE IF NOT EXISTS document_chunks (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  page_number INT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(3072),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_chunks_document_id ON document_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_document_chunks_page ON document_chunks(document_id, page_number);

-- 5. Document Visuals Table (stores visual figure/table metadata, image reference & visual embeddings)
CREATE TABLE IF NOT EXISTS document_visuals (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number INT NOT NULL,
  visual_index INT NOT NULL,
  image_path TEXT NOT NULL,
  caption TEXT DEFAULT '',
  description TEXT DEFAULT '',
  metadata JSONB DEFAULT '{}'::jsonb,
  embedding vector(3072),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_visuals_document_id ON document_visuals(document_id);
CREATE INDEX IF NOT EXISTS idx_document_visuals_page ON document_visuals(document_id, page_number);

-- 6. Conversations Table
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id TEXT DEFAULT 'default_user',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT uq_conversations_doc_user UNIQUE (document_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_document_id ON conversations(document_id);

-- 7. Chat Messages Table
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  citations JSONB DEFAULT '[]'::jsonb,
  related_visuals JSONB DEFAULT '[]'::jsonb,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_id ON chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(conversation_id, created_at);

-- 8. RPC Function: Cosine Similarity Matching for Document Chunks
CREATE OR REPLACE FUNCTION match_document_chunks (
  query_embedding vector(3072),
  filter_document_id text,
  match_count int DEFAULT 5,
  similarity_threshold float DEFAULT 0.45
)
RETURNS TABLE (
  id text,
  document_id text,
  chunk_index int,
  page_number int,
  content text,
  metadata jsonb,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.id,
    dc.document_id,
    dc.chunk_index,
    dc.page_number,
    dc.content,
    dc.metadata,
    1 - (dc.embedding <=> query_embedding) AS similarity
  FROM document_chunks dc
  WHERE dc.document_id = filter_document_id
    AND dc.embedding IS NOT NULL
    AND 1 - (dc.embedding <=> query_embedding) >= similarity_threshold
  ORDER BY dc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- 9. RPC Function: Cosine Similarity Matching for Document Visuals
CREATE OR REPLACE FUNCTION match_document_visuals (
  query_embedding vector(3072),
  filter_document_id text,
  match_count int DEFAULT 10,
  similarity_threshold float DEFAULT 0.70
)
RETURNS TABLE (
  id text,
  document_id text,
  page_number int,
  visual_index int,
  image_path text,
  caption text,
  description text,
  metadata jsonb,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dv.id,
    dv.document_id,
    dv.page_number,
    dv.visual_index,
    dv.image_path,
    dv.caption,
    dv.description,
    dv.metadata,
    1 - (dv.embedding <=> query_embedding) AS similarity
  FROM document_visuals dv
  WHERE dv.document_id = filter_document_id
    AND dv.embedding IS NOT NULL
    AND 1 - (dv.embedding <=> query_embedding) >= similarity_threshold
  ORDER BY dv.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
