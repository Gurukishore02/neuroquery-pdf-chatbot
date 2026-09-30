import React, { useState, useEffect } from 'react';
import { Navbar } from './components/Navbar.tsx';
import { ChatArea } from './components/ChatArea.tsx';
import { PdfViewer } from './components/PdfViewer.tsx';
import { UploadModal } from './components/UploadModal.tsx';
import { DocumentInfo, ChatMessage, SampleDocumentItem } from './types.ts';
import { base64ToBlobUrl } from './utils/formatters.ts';

export default function App() {
  const [document, setDocument] = useState<DocumentInfo | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [samples, setSamples] = useState<SampleDocumentItem[]>([]);
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isAnalyzingDoc, setIsAnalyzingDoc] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [activeView, setActiveView] = useState<'chat' | 'pdf'>('chat');
  const [targetPage, setTargetPage] = useState<number | null>(null);
  const [highlightExcerpt, setHighlightExcerpt] = useState<string | null>(null);
  const [isPdfPanelOpen, setIsPdfPanelOpen] = useState(true);

  // 1. Fetch available sample documents on mount
  useEffect(() => {
    async function loadSamples() {
      try {
        const res = await fetch('/api/samples');
        if (res.ok) {
          const data = await res.json();
          if (data.samples && data.samples.length > 0) {
            setSamples(data.samples);
            // Pre-load the first sample so the app is immediately testable
            await selectSample(data.samples[0].id, false);
          }
        }
      } catch (err) {
        console.error('Failed to load sample documents:', err);
      }
    }
    loadSamples();
  }, []);

  // 2. Select a sample document
  const selectSample = async (sampleId: string, openModalOnFail = true) => {
    try {
      setIsAnalyzingDoc(true);
      setLoadingMessage('Loading sample PDF document...');
      const res = await fetch(`/api/documents/${sampleId}`);
      if (!res.ok) throw new Error('Could not load sample document');

      const data = await res.json();
      const blobUrl = base64ToBlobUrl(data.base64);

      setDocument({
        id: data.id,
        name: data.name,
        size: data.size,
        pageCount: data.pageCount,
        summary: data.summary,
        suggestedQuestions: data.suggestedQuestions,
        base64: data.base64,
        blobUrl,
      });

      setMessages([]);
      setTargetPage(1);
      setHighlightExcerpt(null);
      setIsPdfPanelOpen(true);
      setIsUploadModalOpen(false);
    } catch (err) {
      console.error('Error selecting sample:', err);
      if (openModalOnFail) setIsUploadModalOpen(true);
    } finally {
      setIsAnalyzingDoc(false);
      setLoadingMessage('');
    }
  };

  // 3. Upload custom user PDF
  const handleUploadCustomFile = async (file: File) => {
    setIsAnalyzingDoc(true);
    setLoadingMessage(`Analyzing ${file.name} with Gemini AI...`);

    try {
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = (err) => reject(err);
      });
      reader.readAsDataURL(file);
      const dataUrl = await base64Promise;

      const res = await fetch('/api/documents/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: file.name,
          base64: dataUrl,
          size: file.size,
        }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to analyze PDF file.');
      }

      const analyzed = await res.json();
      const blobUrl = URL.createObjectURL(file);

      setDocument({
        id: analyzed.id,
        name: analyzed.name || file.name,
        size: analyzed.size || file.size,
        pageCount: analyzed.pageCount || 1,
        summary: analyzed.summary || '',
        suggestedQuestions: analyzed.suggestedQuestions || [],
        base64: dataUrl,
        blobUrl,
      });

      setMessages([]);
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

  // 4. Send question to Gemini PDF QA endpoint
  const handleSendMessage = async (questionText: string) => {
    if (!questionText.trim() || !document || isLoading) return;

    const userMessage: ChatMessage = {
      id: `msg_${Date.now()}_u`,
      role: 'user',
      text: questionText.trim(),
      timestamp: Date.now(),
    };

    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setIsLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId: document.id,
          documentBase64: document.base64,
          documentName: document.name,
          question: questionText.trim(),
          history: messages.slice(-6), // Send last 6 turns for context
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
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, assistantMessage]);

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
      setMessages((prev) => [...prev, errorMessage]);
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

  const handleClearChat = () => {
    setMessages([]);
    setHighlightExcerpt(null);
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
        onSelectSample={selectSample}
        onUploadCustomFile={handleUploadCustomFile}
        isLoading={isAnalyzingDoc}
        loadingMessage={loadingMessage}
        hasActiveDoc={!!document}
      />
    </div>
  );
}
