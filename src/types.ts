export interface DocumentInfo {
  id: string;
  name: string;
  size: number;
  pageCount: number;
  summary: string;
  suggestedQuestions: string[];
  base64?: string;
  blobUrl?: string;
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
