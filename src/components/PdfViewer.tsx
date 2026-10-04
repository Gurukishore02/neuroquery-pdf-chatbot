import React, { useState, useEffect } from 'react';
import {
  FileText,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Quote,
  Maximize2,
  Minimize2,
  PanelRightClose,
} from 'lucide-react';
import { DocumentInfo } from '../types.ts';

interface PdfViewerProps {
  document: DocumentInfo | null;
  targetPage?: number | null;
  highlightExcerpt?: string | null;
  onClearHighlight?: () => void;
  onClosePanel?: () => void;
}

export const PdfViewer: React.FC<PdfViewerProps> = ({
  document,
  targetPage,
  highlightExcerpt,
  onClearHighlight,
  onClosePanel,
}) => {
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (targetPage && targetPage > 0) {
      setCurrentPage(targetPage);
    }
  }, [targetPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [document?.id]);

  if (!document || !document.blobUrl) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6 text-center text-slate-400 bg-slate-50/50 dark:bg-slate-900/30 border-l border-slate-200 dark:border-slate-800">
        <div className="w-12 h-12 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 mb-3">
          <FileText className="w-6 h-6" />
        </div>
        <p className="font-semibold text-slate-700 dark:text-slate-300">No Document Loaded</p>
        <p className="text-xs text-slate-400 mt-1 max-w-xs">
          Upload or select a PDF to inspect pages and read evidence directly.
        </p>
      </div>
    );
  }

  const totalPages = Math.max(1, document.pageCount);

  const handlePrevPage = () => {
    setCurrentPage((prev) => Math.max(1, prev - 1));
  };

  const handleNextPage = () => {
    setCurrentPage((prev) => Math.min(totalPages, prev + 1));
  };

  const handlePageSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setCurrentPage(parseInt(e.target.value, 10));
  };

  const pdfUrlWithPage = `${document.blobUrl}#page=${currentPage}&toolbar=0&navpanes=0`;

  return (
    <div
      className={`h-full flex flex-col bg-slate-100 dark:bg-slate-900/60 border-l border-slate-200 dark:border-slate-800 transition-all ${
        isFullscreen ? 'fixed inset-0 z-50 bg-white dark:bg-slate-900' : 'relative'
      }`}
    >
      {/* Top Controls Bar */}
      <div className="flex items-center justify-between px-3 sm:px-4 py-2.5 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 gap-2 flex-shrink-0">
        {/* Document Info */}
        <div className="flex items-center gap-2 min-w-0">
          <div className="p-1 rounded bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 flex-shrink-0">
            <FileText className="w-4 h-4" />
          </div>
          <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate max-w-[140px] sm:max-w-[200px]" title={document.name}>
            {document.name}
          </span>
        </div>

        {/* Page Nav */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            onClick={handlePrevPage}
            disabled={currentPage <= 1}
            aria-label="Previous Page"
            className="p-1 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:pointer-events-none transition"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          <div className="flex items-center text-xs text-slate-600 dark:text-slate-300 gap-1 font-medium">
            <span>Page</span>
            <select
              value={currentPage}
              onChange={handlePageSelect}
              className="bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded px-1.5 py-0.5 text-xs font-semibold focus:outline-hidden focus:ring-1 focus:ring-indigo-500 cursor-pointer"
            >
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((pg) => (
                <option key={pg} value={pg}>
                  {pg}
                </option>
              ))}
            </select>
            <span>of {totalPages}</span>
          </div>

          <button
            onClick={handleNextPage}
            disabled={currentPage >= totalPages}
            aria-label="Next Page"
            className="p-1 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:pointer-events-none transition"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Action icons */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <a
            href={document.blobUrl}
            download={document.name}
            title="Download PDF"
            className="p-1.5 rounded-md text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
          >
            <Download className="w-3.5 h-3.5" />
          </a>
          <a
            href={document.blobUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in new window"
            className="p-1.5 rounded-md text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
            className="p-1.5 rounded-md text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
          >
            {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
          {onClosePanel && (
            <button
              onClick={onClosePanel}
              title="Close document"
              aria-label="Close document"
              className="p-1.5 rounded-md text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition ml-0.5"
            >
              <ChevronRight className="w-4 h-4 text-slate-600 dark:text-slate-300" />
            </button>
          )}
        </div>
      </div>

      {/* Cited Excerpt Notice banner if an answer citation is active */}
      {highlightExcerpt && (
        <div className="bg-indigo-50 dark:bg-indigo-950/70 border-b border-indigo-100 dark:border-indigo-900/60 p-2.5 px-4 flex items-start justify-between gap-3 text-xs animate-in slide-in-from-top-2 duration-150 flex-shrink-0">
          <div className="flex items-start gap-2 min-w-0">
            <Quote className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400 mt-0.5 flex-shrink-0" />
            <div className="min-w-0">
              <span className="font-semibold text-indigo-900 dark:text-indigo-200">
                Cited on Page {currentPage}:{' '}
              </span>
              <span className="italic text-indigo-800/90 dark:text-indigo-300">
                "{highlightExcerpt}"
              </span>
            </div>
          </div>
          {onClearHighlight && (
            <button
              onClick={onClearHighlight}
              className="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline flex-shrink-0 font-medium"
            >
              Dismiss
            </button>
          )}
        </div>
      )}

      {/* Embedded PDF iframe */}
      <div className="flex-1 w-full h-full relative overflow-hidden bg-slate-200/50 dark:bg-slate-950/50">
        <iframe
          key={`${document.id}-${currentPage}`}
          src={pdfUrlWithPage}
          title={document.name}
          className="w-full h-full border-0"
        />
      </div>
    </div>
  );
};
