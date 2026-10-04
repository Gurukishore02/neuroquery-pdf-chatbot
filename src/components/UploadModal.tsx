import React, { useState, useRef } from 'react';
import { Upload, FileText, CheckCircle2, AlertCircle, X, Sparkles, BookOpen } from 'lucide-react';
import { DocumentInfo, SampleDocumentItem } from '../types.ts';

interface UploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  samples: SampleDocumentItem[];
  documents: DocumentInfo[];
  selectedDocumentId: string | null;
  onSelectDocument: (documentId: string) => Promise<void>;
  onRetryIndexing: (documentId: string) => Promise<void>;
  onSelectSample: (sampleId: string) => Promise<void>;
  onUploadCustomFile: (file: File) => Promise<void>;
  isLoading: boolean;
  loadingMessage?: string;
  hasActiveDoc: boolean;
}

export const UploadModal: React.FC<UploadModalProps> = ({
  isOpen,
  onClose,
  samples,
  documents,
  selectedDocumentId,
  onSelectDocument,
  onRetryIndexing,
  onSelectSample,
  onUploadCustomFile,
  isLoading,
  loadingMessage,
  hasActiveDoc,
}) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    setError(null);

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
        setError('Please drop a valid PDF document (.pdf).');
        return;
      }
      try {
        await onUploadCustomFile(file);
      } catch (err: any) {
        setError(err.message || 'Failed to process PDF.');
      }
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    const files = e.target.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
        setError('Please select a valid PDF file.');
        return;
      }
      try {
        await onUploadCustomFile(file);
      } catch (err: any) {
        setError(err.message || 'Failed to process PDF.');
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 p-6 md:p-8">
        {/* Close Button if active doc exists */}
        {hasActiveDoc && !isLoading && (
          <button
            onClick={onClose}
            className="absolute top-5 right-5 p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 transition"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        )}

        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 mb-3 shadow-inner">
            <FileText className="w-6 h-6" />
          </div>
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white">
            {hasActiveDoc ? 'Switch or Upload PDF' : 'Select a PDF to Chat'}
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 max-w-md mx-auto">
            Upload any PDF to ask questions and get accurate answers cited with exact page numbers.
          </p>
        </div>

        {error && (
          <div className="mb-5 flex items-center gap-2.5 p-3.5 rounded-xl bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900/50 text-red-700 dark:text-red-300 text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {isLoading ? (
          <div className="py-14 text-center space-y-4">
            <div className="relative inline-flex items-center justify-center">
              <div className="w-14 h-14 border-4 border-indigo-200 dark:border-indigo-900 border-t-indigo-600 rounded-full animate-spin" />
              <Sparkles className="w-6 h-6 text-indigo-600 absolute" />
            </div>
            <div>
              <p className="font-semibold text-slate-800 dark:text-slate-100">
                {loadingMessage || 'Analyzing PDF with Gemini AI...'}
              </p>
              <p className="text-xs text-slate-400 mt-1">Reading page structure and indexing content</p>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {documents.length > 0 && (
              <section>
                <div className="flex items-center justify-between gap-3 mb-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Documents</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">{documents.length} available</p>
                  </div>
                </div>
                <div className="max-h-52 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 border-y border-slate-100 dark:border-slate-800">
                  {documents.map((document) => {
                    const isSelected = document.id === selectedDocumentId;
                    const status = document.indexingStatus || 'ready';
                    const textReady = document.textIndexReady ?? status === 'ready';
                    const visualReady = document.visualIndexReady ?? true;
                    const hasIndexError = status === 'error' || document.visualIndexStatus === 'error';
                    const statusLabel = !textReady
                      ? status === 'error' ? 'Indexing failed' : status === 'queued' ? 'Queued' : 'Preparing document...'
                      : !visualReady
                        ? document.visualIndexStatus === 'error' ? 'Ready for chat · Visual indexing failed' : 'Ready for chat · Visuals still processing'
                        : 'Ready';
                    const statusColor = !textReady || hasIndexError
                      ? hasIndexError ? 'text-red-600 dark:text-red-400' : 'text-amber-700 dark:text-amber-400'
                      : 'text-emerald-700 dark:text-emerald-400';
                    const statusError = textReady ? document.visualIndexError : document.indexingError;
                    return (
                      <div
                        key={document.id}
                        className={`flex w-full items-center gap-3 px-3 py-2.5 transition ${isSelected ? 'bg-indigo-50 dark:bg-indigo-950/50' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60'}`}
                      >
                        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                          {isSelected && <CheckCircle2 className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />}
                        </span>
                        <button
                          type="button"
                          onClick={() => onSelectDocument(document.id)}
                          aria-current={isSelected ? 'true' : undefined}
                          className="min-w-0 flex-1 text-left text-slate-700 dark:text-slate-200"
                        >
                          <span className="block truncate text-sm font-medium">{document.name}</span>
                          <span className="block text-xs text-slate-500 dark:text-slate-400">
                            {document.pageCount > 0 ? `${document.pageCount} ${document.pageCount === 1 ? 'page' : 'pages'}` : 'Reading pages...'}
                            <span className={`ml-2 ${statusColor}`} title={statusError}>
                              {statusLabel}
                            </span>
                          </span>
                        </button>
                        {hasIndexError && (
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await onRetryIndexing(document.id);
                              } catch (err: any) {
                                setError(err.message || 'Could not retry document indexing.');
                              }
                            }}
                            className="flex-shrink-0 px-2 py-1 text-xs font-semibold text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-200"
                          >
                            Retry
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Drop Zone */}
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-2xl p-7 text-center cursor-pointer transition-all ${
                isDragOver
                  ? 'border-indigo-500 bg-indigo-50/60 dark:bg-indigo-950/30 scale-[0.99]'
                  : 'border-slate-300 dark:border-slate-700 hover:border-indigo-400 hover:bg-slate-50/50 dark:hover:bg-slate-800/40'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,application/pdf"
                className="hidden"
                onChange={handleFileChange}
              />
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 mb-3">
                <Upload className="w-5 h-5" />
              </div>
              <p className="font-medium text-slate-800 dark:text-slate-200">
                Drop your PDF here, or <span className="text-indigo-600 dark:text-indigo-400 underline underline-offset-2">browse files</span>
              </p>
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                Supports all standard PDF documents up to 50MB
              </p>
            </div>

            {/* Pre-Loaded Samples */}
            {samples.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <BookOpen className="w-4 h-4 text-slate-400" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Or try an instant sample document
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {samples.map((sample) => (
                    <button
                      key={sample.id}
                      onClick={() => onSelectSample(sample.id)}
                      className="group text-left p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 hover:border-indigo-400 dark:hover:border-indigo-500 hover:bg-indigo-50/40 dark:hover:bg-indigo-950/20 transition-all flex flex-col justify-between"
                    >
                      <div>
                        <div className="flex items-center justify-between gap-1 mb-1.5">
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 group-hover:bg-indigo-100 dark:group-hover:bg-indigo-900/60 group-hover:text-indigo-700 dark:group-hover:text-indigo-300 transition-colors">
                            {sample.category}
                          </span>
                          <span className="text-[10px] text-slate-400 font-medium">
                            {sample.pageCount} pages
                          </span>
                        </div>
                        <h4 className="font-semibold text-xs text-slate-800 dark:text-slate-200 line-clamp-1 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                          {sample.name}
                        </h4>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2 mt-1 leading-snug">
                          {sample.description}
                        </p>
                      </div>

                      <div className="mt-2.5 pt-2 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between text-[11px] text-indigo-600 dark:text-indigo-400 font-medium">
                        <span>Load Document</span>
                        <CheckCircle2 className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
