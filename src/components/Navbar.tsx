import React from 'react';
import { FileText, Upload, MessageSquare, BookOpen, Trash2, PanelRightOpen, PanelRightClose } from 'lucide-react';
import { DocumentInfo } from '../types.ts';

interface NavbarProps {
  document: DocumentInfo | null;
  onOpenUpload: () => void;
  onClearChat: () => void;
  messagesCount: number;
  activeView: 'chat' | 'pdf';
  onViewChange: (view: 'chat' | 'pdf') => void;
  isPdfPanelOpen?: boolean;
  onTogglePdfPanel?: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  document,
  onOpenUpload,
  onClearChat,
  messagesCount,
  activeView,
  onViewChange,
  isPdfPanelOpen = true,
  onTogglePdfPanel,
}) => {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md transition-colors">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 h-16 flex items-center justify-between gap-2 sm:gap-4">
        {/* Brand */}
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 text-white flex items-center justify-center shadow-sm flex-shrink-0">
            <FileText className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-bold text-base tracking-tight text-slate-900 dark:text-white">
                NeuroQuery
              </span>
              <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 border border-indigo-200/60 dark:border-indigo-800/60">
                AI
              </span>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate hidden sm:block">
              Grounded answers with page citations
            </p>
          </div>
        </div>

        {/* Center: Active Document Badge & Mobile View Switcher */}
        <div className="flex items-center gap-2 min-w-0">
          {document && (
            <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs text-slate-700 dark:text-slate-300 max-w-xs truncate">
              <FileText className="w-3.5 h-3.5 text-indigo-500 flex-shrink-0" />
              <span className="font-medium truncate">{document.name}</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 font-semibold flex-shrink-0">
                {document.pageCount} {document.pageCount === 1 ? 'page' : 'pages'}
              </span>
            </div>
          )}

          {/* Mobile Tab Switcher */}
          {document && (
            <div className="flex lg:hidden items-center p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
              <button
                onClick={() => onViewChange('chat')}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-all ${
                  activeView === 'chat'
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                <MessageSquare className="w-3.5 h-3.5" />
                <span>Chat</span>
              </button>
              <button
                onClick={() => onViewChange('pdf')}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-all ${
                  activeView === 'pdf'
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                <BookOpen className="w-3.5 h-3.5" />
                <span>PDF</span>
              </button>
            </div>
          )}
        </div>

        {/* Right actions */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {document && onTogglePdfPanel && (
            <button
              onClick={onTogglePdfPanel}
              title={isPdfPanelOpen ? 'Close document' : 'Open document'}
              aria-label={isPdfPanelOpen ? 'Close document' : 'Open document'}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800/80 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-medium shadow-xs transition"
            >
              {isPdfPanelOpen ? (
                <>
                  <PanelRightClose className="w-4 h-4 text-indigo-500" />
                  <span className="hidden sm:inline">Close Document</span>
                </>
              ) : (
                <>
                  <PanelRightOpen className="w-4 h-4 text-indigo-500" />
                  <span className="hidden sm:inline">Open Document</span>
                </>
              )}
            </button>
          )}

          {messagesCount > 0 && (
            <button
              onClick={onClearChat}
              title="Clear conversation"
              className="p-2 text-slate-400 hover:text-red-600 dark:hover:text-red-400 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition"
              aria-label="Clear chat"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}

          <button
            onClick={onOpenUpload}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-xs sm:text-sm shadow-xs transition"
          >
            <Upload className="w-4 h-4" />
            <span className="hidden sm:inline">{document ? 'Switch PDF' : 'Upload PDF'}</span>
            <span className="sm:hidden">{document ? 'PDF' : 'Upload'}</span>
          </button>
        </div>
      </div>
    </header>
  );
};
