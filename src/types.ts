export interface DocumentInfo {
  id: string;
  name: string;
  size: number;
  pageCount: number;
  summary: string;
  suggestedQuestions: string[];
  uploadedAt?: number;
  indexingStatus?: 'queued' | 'processing' | 'ready' | 'error';
  textIndexReady?: boolean;
  visualIndexReady?: boolean;
  visualIndexStatus?: 'queued' | 'processing' | 'ready' | 'error';
  indexingError?: string;
  visualIndexError?: string;
  base64?: string;
  blobUrl?: string;
}

export type RelatedVisualType = 'image' | 'figure' | 'diagram' | 'chart' | 'graph' | 'table' | 'flowchart' | 'illustration' | 'map' | 'screenshot' | 'other';

export interface RelatedVisual {
  id: string;
  documentId: string;
  pageNumber: number;
  type: RelatedVisualType;
  title: string;
  caption: string;
  description: string;
  imageData: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  pageNumbers?: number[];
  relevantExcerpt?: string;
  isFoundInDocument?: boolean;
  topic?: string;
  suggestedFollowUps?: string[];
  relatedVisuals?: RelatedVisual[];
  timestamp: number;
  isError?: boolean;
}

export interface SampleDocumentItem {
  id: string;
  name: string;
  description: string;
  category: string;
  pageCount: number;
  suggestedQuestions: string[];
}
