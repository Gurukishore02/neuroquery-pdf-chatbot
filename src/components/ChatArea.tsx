import React, { useState, useRef, useEffect } from 'react';
import {
  Send,
  Sparkles,
  User,
  FileText,
  Quote,
  Copy,
  Check,
  HelpCircle,
  AlertTriangle,
  ArrowRight,
  BookOpen,
  PanelRightOpen,
  ChevronLeft,
} from 'lucide-react';
import { ChatMessage, DocumentInfo } from '../types.ts';
import { MarkdownView } from './MarkdownView.tsx';

interface ChatAreaProps {
  document: DocumentInfo | null;
  messages: ChatMessage[];
  isLoading: boolean;
  onSendMessage: (question: string) => Promise<void>;
  onPageClick: (pageNumber: number, excerpt?: string) => void;
  onOpenUpload: () => void;
  isPdfPanelOpen?: boolean;
  onTogglePdfPanel?: () => void;
}

export const ChatArea: React.FC<ChatAreaProps> = ({
  document,
  messages,
  isLoading,
  onSendMessage,
  onPageClick,
  onOpenUpload,
  isPdfPanelOpen = true,
  onTogglePdfPanel,
}) => {
  const [input, setInput] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [input]);

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!input.trim() || isLoading) return;

    const question = input.trim();
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    await onSendMessage(question);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-white dark:bg-slate-900 overflow-hidden relative">
      {/* Floating Open Document Button when PDF panel is collapsed on desktop */}
      {document && !isPdfPanelOpen && onTogglePdfPanel && (
        <div className="absolute top-3 right-4 z-20 hidden lg:block">
          <button
            onClick={onTogglePdfPanel}
            title="Open document"
            aria-label="Open document"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-xs text-slate-700 dark:text-slate-200 hover:text-indigo-600 dark:hover:text-indigo-400 hover:border-indigo-300 dark:hover:border-indigo-600 text-xs font-semibold transition-all group"
          >
            <ChevronLeft className="w-4 h-4 text-indigo-500 group-hover:-translate-x-0.5 transition-transform" />
            <span>Open Document</span>
          </button>
        </div>
      )}

      {/* Messages Stream */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Welcome Empty State */}
        {messages.length === 0 && (
          <div className="max-w-2xl mx-auto my-auto py-8 text-center animate-in fade-in-50 duration-300">
            {document ? (
              <div className="space-y-6">
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-100 dark:border-indigo-900/60 text-indigo-700 dark:text-indigo-300 text-xs font-medium">
                  <BookOpen className="w-3.5 h-3.5" />
                  <span>{document.name}</span>
                  <span>•</span>
                  <span>{document.pageCount} {document.pageCount === 1 ? 'page' : 'pages'}</span>
                </div>

                <div className="space-y-2">
                  <h3 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">
                    What would you like to know?
                  </h3>
                  <p className="text-sm text-slate-500 dark:text-slate-400 max-w-lg mx-auto">
                    {document.summary || 'Ask any specific question about this document. Answers will be sourced strictly from relevant sections and cited with exact page numbers.'}
                  </p>
                </div>

                {/* Suggested Questions */}
                {document.suggestedQuestions && document.suggestedQuestions.length > 0 && (
                  <div className="pt-2 text-left max-w-xl mx-auto">
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2.5">
                      Suggested questions:
                    </p>
                    <div className="grid grid-cols-1 gap-2">
                      {document.suggestedQuestions.map((q, idx) => (
                        <button
                          key={idx}
                          onClick={() => onSendMessage(q)}
                          className="flex items-center justify-between text-left p-3 rounded-xl border border-slate-200 dark:border-slate-800 hover:border-indigo-400 dark:hover:border-indigo-600 bg-slate-50/50 dark:bg-slate-800/40 hover:bg-indigo-50/40 dark:hover:bg-indigo-950/30 text-xs sm:text-sm text-slate-700 dark:text-slate-300 group transition-all"
                        >
                          <span className="line-clamp-2">{q}</span>
                          <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 flex-shrink-0 ml-2 transition-transform group-hover:translate-x-0.5" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <div className="w-14 h-14 rounded-2xl bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 mx-auto flex items-center justify-center">
                  <FileText className="w-7 h-7" />
                </div>
                <h3 className="text-xl font-bold text-slate-900 dark:text-white">
                  Welcome to NeuroQuery AI
                </h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                  Upload any PDF or select a built-in sample document to ask questions and get page-cited answers.
                </p>
                <div>
                  <button
                    onClick={onOpenUpload}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-sm shadow-xs transition"
                  >
                    <FileText className="w-4 h-4" />
                    <span>Select a PDF Document</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Message Items */}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex gap-3 max-w-3xl ${
              msg.role === 'user' ? 'ml-auto justify-end' : 'mr-auto justify-start'
            }`}
          >
            {/* Assistant Avatar */}
            {msg.role === 'assistant' && (
              <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-indigo-600 to-violet-600 text-white flex items-center justify-center flex-shrink-0 mt-0.5 shadow-xs">
                <Sparkles className="w-4 h-4" />
              </div>
            )}

            {/* Bubble Container */}
            <div
              className={`rounded-2xl px-4 py-3.5 space-y-3 ${
                msg.role === 'user'
                  ? 'bg-indigo-600 text-white max-w-[85%] sm:max-w-[75%]'
                  : msg.isError
                  ? 'bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 text-red-800 dark:text-red-200 max-w-full sm:max-w-[90%]'
                  : 'bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/70 text-slate-800 dark:text-slate-100 max-w-full sm:max-w-[92%] shadow-xs'
              }`}
            >
              {/* User text */}
              {msg.role === 'user' ? (
                <p className="text-sm sm:text-base leading-relaxed whitespace-pre-wrap">{msg.text}</p>
              ) : (
                <>
                  {/* Topic badge if available */}
                  {msg.topic && (
                    <div className="inline-block text-[11px] font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
                      {msg.topic}
                    </div>
                  )}

                  {/* Main Answer text */}
                  <MarkdownView content={msg.text} />

                  {/* Page Citation Pills */}
                  {msg.pageNumbers && msg.pageNumbers.length > 0 && (
                    <div className="pt-2 border-t border-slate-200/80 dark:border-slate-700/80 flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-1">
                        <FileText className="w-3.5 h-3.5" />
                        Source:
                      </span>
                      {msg.pageNumbers.map((pg) => (
                        <button
                          key={pg}
                          onClick={() => onPageClick(pg, msg.relevantExcerpt)}
                          title={`Jump to Page ${pg} in PDF`}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-indigo-50 dark:bg-indigo-950/70 hover:bg-indigo-100 dark:hover:bg-indigo-900 border border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300 font-bold text-xs shadow-xs transition group cursor-pointer"
                        >
                          <span>Page {pg}</span>
                          <span className="text-[10px] text-indigo-400 group-hover:text-indigo-600 dark:group-hover:text-indigo-200 transition">
                            ↗
                          </span>
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Verbatim Excerpt Card */}
                  {msg.relevantExcerpt && (
                    <div
                      onClick={() =>
                        msg.pageNumbers && msg.pageNumbers[0]
                          ? onPageClick(msg.pageNumbers[0], msg.relevantExcerpt)
                          : null
                      }
                      className="p-3 rounded-xl bg-amber-50/60 dark:bg-amber-950/30 border border-amber-200/70 dark:border-amber-900/50 text-xs text-amber-900 dark:text-amber-200 space-y-1.5 cursor-pointer hover:border-amber-400 transition"
                    >
                      <div className="flex items-center gap-1.5 font-semibold text-amber-800 dark:text-amber-300">
                        <Quote className="w-3.5 h-3.5" />
                        <span>Direct Excerpt from Document:</span>
                      </div>
                      <p className="italic leading-relaxed pl-2 border-l-2 border-amber-400 dark:border-amber-600">
                        "{msg.relevantExcerpt}"
                      </p>
                    </div>
                  )}

                  {/* Not Found in Document notification */}
                  {msg.isFoundInDocument === false && (
                    <div className="flex items-center gap-2 p-2.5 rounded-lg bg-slate-100 dark:bg-slate-700/50 text-xs text-slate-600 dark:text-slate-300">
                      <HelpCircle className="w-4 h-4 text-slate-400 flex-shrink-0" />
                      <span>This question could not be answered using the provided PDF document.</span>
                    </div>
                  )}

                  {/* Suggested Follow-up Questions */}
                  {msg.suggestedFollowUps && msg.suggestedFollowUps.length > 0 && (
                    <div className="pt-2 border-t border-slate-200/60 dark:border-slate-700/60 space-y-1.5">
                      <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                        Related follow-up questions:
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {msg.suggestedFollowUps.map((fu, idx) => (
                          <button
                            key={idx}
                            onClick={() => onSendMessage(fu)}
                            className="text-left text-xs px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-700/60 hover:bg-indigo-50 dark:hover:bg-indigo-950/50 hover:text-indigo-600 dark:hover:text-indigo-400 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-600 transition"
                          >
                            {fu}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Action Bar (Copy) */}
                  <div className="pt-1 flex items-center justify-between text-xs text-slate-400">
                    <span className="text-[11px]">
                      {new Date(msg.timestamp).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    <button
                      onClick={() => handleCopy(msg.id, msg.text)}
                      className="inline-flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-200 transition"
                    >
                      {copiedId === msg.id ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-500" />
                          <span className="text-emerald-500 text-[11px]">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span className="text-[11px]">Copy</span>
                        </>
                      )}
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* User Avatar */}
            {msg.role === 'user' && (
              <div className="w-8 h-8 rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 flex items-center justify-center flex-shrink-0 mt-0.5">
                <User className="w-4 h-4" />
              </div>
            )}
          </div>
        ))}

        {/* Loading Indicator */}
        {isLoading && (
          <div className="flex gap-3 max-w-3xl mr-auto justify-start animate-in fade-in-50 duration-200">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-indigo-600 to-violet-600 text-white flex items-center justify-center flex-shrink-0 mt-0.5 shadow-xs">
              <Sparkles className="w-4 h-4" />
            </div>
            <div className="rounded-2xl px-4 py-3 bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/70 text-slate-600 dark:text-slate-300 flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-indigo-600 animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-2 h-2 rounded-full bg-indigo-600 animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-2 h-2 rounded-full bg-indigo-600 animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
              <span className="text-xs font-medium">Scanning PDF pages for relevant content...</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Bar */}
      <div className="p-3 sm:p-4 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 flex-shrink-0">
        <form onSubmit={handleSubmit} className="max-w-4xl mx-auto relative flex items-end gap-2">
          <div className="relative flex-1 rounded-2xl bg-slate-100 dark:bg-slate-800/90 border border-slate-200 dark:border-slate-700 focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/20 transition-all">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={!document || isLoading}
              placeholder={
                document
                  ? 'Ask a question about the document (e.g., What are the safety protocols?)...'
                  : 'Upload or select a PDF first to ask questions'
              }
              rows={1}
              className="w-full resize-none bg-transparent px-4 py-3 pr-12 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-hidden max-h-32 disabled:opacity-50"
            />
          </div>

          <button
            type="submit"
            disabled={!input.trim() || !document || isLoading}
            aria-label="Send question"
            className="p-3 rounded-2xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:pointer-events-none text-white font-medium shadow-xs transition flex-shrink-0"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>

        <p className="text-[11px] text-slate-400 text-center mt-2 truncate">
          Grounded directly in PDF content • Page numbers and citations included with every answer
        </p>
      </div>
    </div>
  );
};
