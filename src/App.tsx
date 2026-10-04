import React, { useState, useEffect } from 'react';
import { Navbar } from './components/Navbar.tsx';
import { ChatArea } from './components/ChatArea.tsx';
import { PdfViewer } from './components/PdfViewer.tsx';
import { UploadModal } from './components/UploadModal.tsx';
import { DocumentInfo, ChatMessage, SampleDocumentItem, RelatedVisual } from './types.ts';
import { base64ToBlobUrl } from './utils/formatters.ts';

export default function App() {
  const [documents, setDocuments] = useState<DocumentInfo[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('neuroquery-documents') || '[]');
    } catch {
      return [];
    }
  });
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(() => localStorage.getItem('neuroquery-selected-document'));
  const [conversations, setConversations] = useState<Record<string, ChatMessage[]>>(() => {
    try {
      return JSON.parse(localStorage.getItem('neuroquery-conversations') || '{}');
    } catch {
      return {};
    }
  });
  const document = documents.find((item) => item.id === selectedDocumentId) || null;
  const messages = document ? conversations[document.id] || [] : [];
  const [samples, setSamples] = useState<SampleDocumentItem[]>([]);
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isAnalyzingDoc, setIsAnalyzingDoc] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [activeView, setActiveView] = useState<'chat' | 'pdf'>('chat');
  const [targetPage, setTargetPage] = useState<number | null>(null);
  const [highlightExcerpt, setHighlightExcerpt] = useState<string | null>(null);
  const [isPdfPanelOpen, setIsPdfPanelOpen] = useState(true);

  const selectDocument = async (documentId: string, openModalOnFail = true) => {
    try {
      setIsAnalyzingDoc(true);
      setLoadingMessage('Loading PDF document...');
      const existing = documents.find((item) => item.id === documentId);
      let selected = existing;
      if (!selected?.blobUrl) {
        const res = await fetch(`/api/documents/${documentId}`);
        if (!res.ok) throw new Error('Could not load PDF document');
        const data = await res.json();
        selected = {
          ...existing,
          id: data.id,
          name: data.name,
          size: data.size,
          pageCount: data.pageCount,
          summary: data.summary,
          suggestedQuestions: data.suggestedQuestions,
          uploadedAt: data.uploadedAt,
          indexingStatus: data.indexingStatus,
          textIndexReady: data.textIndexReady,
          visualIndexReady: data.visualIndexReady,
          visualIndexStatus: data.visualIndexStatus,
          indexingError: data.indexingError,
          visualIndexError: data.visualIndexError,
          blobUrl: base64ToBlobUrl(data.base64),
        };
        setDocuments((previous) => previous.map((item) => item.id === documentId ? selected! : item));
      }

      setSelectedDocumentId(documentId);
      setTargetPage(1);
      setHighlightExcerpt(null);
      setIsPdfPanelOpen(true);
      setIsUploadModalOpen(false);

      // Load persistent chat history from Supabase / backend API
      try {
        const chatRes = await fetch(`/api/documents/${documentId}/chat`);
        if (chatRes.ok) {
          const chatData = await chatRes.json();
          if (Array.isArray(chatData.messages) && chatData.messages.length > 0) {
            setConversations((previous) => ({
              ...previous,
              [documentId]: chatData.messages,
            }));
          }
        }
      } catch (chatErr) {
        console.warn('Could not load chat history from server:', chatErr);
      }
    } catch (err) {
      console.error('Error selecting document:', err);
      if (openModalOnFail) setIsUploadModalOpen(true);
    } finally {
      setIsAnalyzingDoc(false);
      setLoadingMessage('');
    }
  };

  const selectSample = (sampleId: string) => selectDocument(sampleId);

  useEffect(() => {
    let cancelled = false;
    async function loadLibrary() {
      try {
        const [documentsResponse, samplesResponse] = await Promise.all([
          fetch('/api/documents'),
          fetch('/api/samples'),
        ]);
        const availableDocuments = documentsResponse.ok
          ? (await documentsResponse.json()).documents as DocumentInfo[]
          : [];
        if (samplesResponse.ok) {
          const data = await samplesResponse.json();
          if (!cancelled) setSamples(data.samples || []);
        }
        if (cancelled) return;

        let storedDocuments: DocumentInfo[] = [];
        try {
          storedDocuments = JSON.parse(localStorage.getItem('neuroquery-documents') || '[]');
        } catch {
          storedDocuments = [];
        }
        const storedById = new Map(storedDocuments.map((item) => [item.id, item]));
        const library = availableDocuments.map((item) => ({ ...storedById.get(item.id), ...item }));
        setDocuments(library);

        const storedSelection = localStorage.getItem('neuroquery-selected-document');
        const nextDocumentId = library.some((item) => item.id === storedSelection)
          ? storedSelection
          : library[0]?.id || null;
        if (nextDocumentId) await selectDocument(nextDocumentId, false);
      } catch (err) {
        console.error('Failed to load document library:', err);
      }
    }
    loadLibrary();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    localStorage.setItem('neuroquery-documents', JSON.stringify(documents.map(({ blobUrl: _blobUrl, base64: _base64, ...item }) => item)));
  }, [documents]);

  useEffect(() => {
    localStorage.setItem('neuroquery-selected-document', selectedDocumentId || '');
  }, [selectedDocumentId]);

  useEffect(() => {
    localStorage.setItem('neuroquery-conversations', JSON.stringify(conversations));
  }, [conversations]);

  useEffect(() => {
    const needsStatusPolling = (item: DocumentInfo) => {
      if (!item.textIndexReady) return item.indexingStatus !== 'error';
      return !item.visualIndexReady && item.visualIndexStatus !== 'error';
    };
    if (!documents.some(needsStatusPolling)) return;
    let requestInProgress = false;
    const refreshIndexingStatus = async () => {
      if (requestInProgress) return;
      requestInProgress = true;
      try {
        const pendingDocuments = documents.filter(needsStatusPolling);
        const statuses = await Promise.all(pendingDocuments.map(async (item) => {
          const response = await fetch(`/api/documents/${item.id}/status`);
          if (!response.ok) return null;
          return await response.json();
        }));
        const statusById = new Map(statuses.filter(Boolean).map((status) => [status.documentId, status]));
        setDocuments((previous) => {
          let changed = false;
          const refreshed = previous.map((item) => {
            const status = statusById.get(item.id);
            if (!status) return item;
            if (item.indexingStatus === status.status
              && item.textIndexReady === status.textIndexReady
              && item.visualIndexReady === status.visualIndexReady
              && item.visualIndexStatus === status.visualIndexStatus
              && item.indexingError === status.error
              && item.visualIndexError === status.visualIndexError) return item;
            changed = true;
            return {
              ...item,
              indexingStatus: status.status,
              textIndexReady: status.textIndexReady,
              visualIndexReady: status.visualIndexReady,
              visualIndexStatus: status.visualIndexStatus,
              indexingError: status.error,
              visualIndexError: status.visualIndexError,
            };
          });
          return changed ? refreshed : previous;
        });
      } catch (err) {
        console.error('Failed to refresh document indexing status:', err);
      } finally {
        requestInProgress = false;
      }
    };
    const timer = window.setInterval(() => { void refreshIndexingStatus(); }, 1500);
    return () => window.clearInterval(timer);
  }, [documents]);

  // Upload custom user PDF and append it to the existing library.
  const handleUploadCustomFile = async (file: File) => {
    setIsAnalyzingDoc(true);
    setLoadingMessage(`Uploading ${file.name} and extracting text locally...`);

    try {
      const res = await fetch('/api/documents/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/pdf',
          'X-File-Name': encodeURIComponent(file.name),
        },
        body: file,
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to analyze PDF file.');
      }

      const analyzed = await res.json();
      const blobUrl = URL.createObjectURL(file);

      const newDocument: DocumentInfo = {
        id: analyzed.id,
        name: file.name,
        size: analyzed.size || file.size,
        pageCount: analyzed.pageCount ?? 0,
        summary: analyzed.summary || '',
        suggestedQuestions: analyzed.suggestedQuestions || [],
        blobUrl,
        uploadedAt: analyzed.uploadedAt || Date.now(),
        indexingStatus: analyzed.indexingStatus || 'processing',
        textIndexReady: analyzed.textIndexReady || false,
        visualIndexReady: analyzed.visualIndexReady || false,
        visualIndexStatus: analyzed.visualIndexStatus || 'queued',
        indexingError: analyzed.indexingError,
        visualIndexError: analyzed.visualIndexError,
      };

      setDocuments((previous) => [...previous.filter((item) => item.id !== newDocument.id), newDocument]);
      setSelectedDocumentId(newDocument.id);
      setTargetPage(1);
      setHighlightExcerpt(null);
      setIsPdfPanelOpen(true);
      setIsUploadModalOpen(false);
      setActiveView('chat');
    } catch (err: any) {
      console.error('Error uploading custom file:', err);
      throw err;
    } finally {
      setIsAnalyzingDoc(false);
      setLoadingMessage('');
    }
  };

  const handleRetryIndexing = async (documentId: string) => {
    const response = await fetch(`/api/documents/${documentId}/reindex`, { method: 'POST' });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'Could not retry document indexing.');
    }
    setDocuments((previous) => previous.map((item) => item.id === documentId
      ? { ...item, indexingStatus: 'queued', textIndexReady: false, visualIndexReady: false, visualIndexStatus: 'queued', indexedChunks: 0 }
      : item));
  };

  // 4. Send question to Gemini PDF QA endpoint
  const handleSendMessage = async (questionText: string) => {
    if (!questionText.trim() || !document || !document.textIndexReady || isLoading) return;
    const documentId = document.id;
    const currentMessages = conversations[documentId] || [];

    const userMessage: ChatMessage = {
      id: `msg_${Date.now()}_u`,
      role: 'user',
      text: questionText.trim(),
      timestamp: Date.now(),
    };

    setConversations((previous) => ({
      ...previous,
      [documentId]: [...(previous[documentId] || []), userMessage],
    }));
    setIsLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId,
          question: questionText.trim(),
          history: currentMessages.slice(-6).map(({ role, text }) => ({ role, text })),
        }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || 'Server error while generating answer.');
      }

      const data = await res.json();

      const assistantMessage: ChatMessage = {
        id: `msg_${Date.now()}_a`,
        role: 'assistant',
        text: data.answer,
        pageNumbers: data.pageNumbers,
        relevantExcerpt: data.relevantExcerpt,
        isFoundInDocument: data.isFoundInDocument,
        topic: data.topic,
        suggestedFollowUps: data.suggestedFollowUps,
        relatedVisuals: data.relatedVisuals as RelatedVisual[] | undefined,
        timestamp: Date.now(),
      };

      setConversations((previous) => ({
        ...previous,
        [documentId]: [...(previous[documentId] || []), assistantMessage],
      }));

      // If the answer cited pages, highlight the first cited page
      if (data.pageNumbers && data.pageNumbers.length > 0) {
        setTargetPage(data.pageNumbers[0]);
        if (data.relevantExcerpt) {
          setHighlightExcerpt(data.relevantExcerpt);
        }
      }
    } catch (err: any) {
      console.error('Chat error:', err);
      const errorMessage: ChatMessage = {
        id: `msg_${Date.now()}_err`,
        role: 'assistant',
        text: `Sorry, an error occurred: ${err.message || 'Could not reach the AI service.'}. Please try asking again.`,
        isError: true,
        timestamp: Date.now(),
      };
      setConversations((previous) => ({
        ...previous,
        [documentId]: [...(previous[documentId] || []), errorMessage],
      }));
    } finally {
      setIsLoading(false);
    }
  };

  // 5. Jump to page from citation pill
  const handlePageClick = (pageNumber: number, excerpt?: string) => {
    setTargetPage(pageNumber);
    if (excerpt) {
      setHighlightExcerpt(excerpt);
    }
    // Auto open PDF panel if closed so user sees the page
    setIsPdfPanelOpen(true);
    // On small screens, switch to PDF view so the user sees the page
    if (window.innerWidth < 1024) {
      setActiveView('pdf');
    }
  };

  const handleClearChat = async () => {
    if (!document) return;
    setConversations((previous) => ({ ...previous, [document.id]: [] }));
    setHighlightExcerpt(null);
    try {
      await fetch(`/api/documents/${document.id}/chat`, { method: 'DELETE' });
    } catch (clearErr) {
      console.warn('Could not clear chat history on server:', clearErr);
    }
  };

  const handleTogglePdfPanel = () => {
    setIsPdfPanelOpen((prev) => !prev);
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-hidden font-sans">
      {/* Top Navbar */}
      <Navbar
        document={document}
        onOpenUpload={() => setIsUploadModalOpen(true)}
        onClearChat={handleClearChat}
        messagesCount={messages.length}
        activeView={activeView}
        onViewChange={setActiveView}
        isPdfPanelOpen={isPdfPanelOpen}
        onTogglePdfPanel={handleTogglePdfPanel}
      />

      {/* Main Content Area */}
      <main className="flex-1 flex overflow-hidden relative">
        {/* Chat Pane */}
        <div
          className={`h-full flex flex-col transition-all duration-300 ease-in-out ${
            activeView === 'chat' ? 'flex' : 'hidden lg:flex'
          } ${document && isPdfPanelOpen ? 'w-full lg:w-1/2 xl:w-7/12' : 'w-full'}`}
        >
          <ChatArea
            document={document}
            messages={messages}
            isLoading={isLoading}
            onSendMessage={handleSendMessage}
            onPageClick={handlePageClick}
            onOpenUpload={() => setIsUploadModalOpen(true)}
            isPdfPanelOpen={isPdfPanelOpen}
            onTogglePdfPanel={handleTogglePdfPanel}
          />
        </div>

        {/* PDF Viewer Pane */}
        {document && (
          <div
            className={`h-full flex-col transition-all duration-300 ease-in-out ${
              activeView === 'pdf' ? 'flex w-full' : 'hidden'
            } ${isPdfPanelOpen ? 'lg:flex lg:w-1/2 xl:w-5/12' : 'lg:hidden'}`}
          >
            <PdfViewer
              document={document}
              targetPage={targetPage}
              highlightExcerpt={highlightExcerpt}
              onClearHighlight={() => setHighlightExcerpt(null)}
              onClosePanel={() => setIsPdfPanelOpen(false)}
            />
          </div>
        )}
      </main>

      {/* Upload & Sample Selector Modal */}
      <UploadModal
        isOpen={isUploadModalOpen}
        onClose={() => setIsUploadModalOpen(false)}
        samples={samples}
        documents={documents}
        selectedDocumentId={selectedDocumentId}
        onSelectDocument={selectDocument}
        onRetryIndexing={handleRetryIndexing}
        onSelectSample={selectSample}
        onUploadCustomFile={handleUploadCustomFile}
        isLoading={isAnalyzingDoc}
        loadingMessage={loadingMessage}
        hasActiveDoc={!!document}
      />
    </div>
  );
}
