import { useRef, useState } from "react";
import { UploadIcon } from "./icons";

interface IngestDropzoneProps {
  /** Fired as soon as a file is chosen or dropped; the drawer starts extraction from here. */
  onFile: (file: File) => void;
  /** false means no ANTHROPIC_API_KEY on the server: exports still map, documents cannot. */
  llmConfigured: boolean;
  inputId: string;
}

const ACCEPT = ".pdf,.txt,.md,.csv,.json,.xlsx";

/** The whole intake surface: one dashed panel that is both a button and a drop target. */
export function IngestDropzone({ onFile, llmConfigured, inputId }: IngestDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Counted, not boolean: dragging over a child fires dragleave on the parent.
  const [dragDepth, setDragDepth] = useState(0);

  function take(file: File | null | undefined) {
    setDragDepth(0);
    if (file) onFile(file);
  }

  return (
    <div className="dropzone-wrap">
      <input
        ref={inputRef}
        id={inputId}
        className="visually-hidden"
        type="file"
        accept={ACCEPT}
        aria-label="Invoice file"
        onChange={(event) => {
          take(event.target.files?.[0]);
          // Clearing lets the same file be picked again after a reset.
          event.target.value = "";
        }}
      />
      <button
        type="button"
        className={`dropzone${dragDepth > 0 ? " dropzone--over" : ""}`}
        onClick={() => inputRef.current?.click()}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragDepth((depth) => depth + 1);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragDepth((depth) => Math.max(0, depth - 1))}
        onDrop={(event) => {
          event.preventDefault();
          take(event.dataTransfer.files?.[0]);
        }}
      >
        <UploadIcon className="dropzone__glyph" size={28} />
        <span className="dropzone__title">Drop an invoice here or click to choose</span>
        <span className="dropzone__hint">PDF, text, CSV, JSON or Excel. Up to 2 MB.</span>
      </button>

      {!llmConfigured && (
        <p className="dropzone__note">
          PDF and text files need an <code>ANTHROPIC_API_KEY</code> on the server. CSV, JSON and
          Excel files still work, with the columns matched heuristically.
        </p>
      )}
    </div>
  );
}
