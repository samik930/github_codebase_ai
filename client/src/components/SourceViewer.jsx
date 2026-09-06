import React, { useState } from 'react';
import { ChevronDown, ChevronRight, FileCode, ExternalLink } from 'lucide-react';

export function SourceViewer({ sources }) {
  const [isOpen, setIsOpen] = useState(false);

  if (!sources || sources.length === 0) return null;

  return (
    <div className="sources-container">
      <button 
        className="sources-toggle"
        onClick={() => setIsOpen(!isOpen)}
        type="button"
      >
        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>Referenced Sources ({sources.length} files)</span>
      </button>

      {isOpen && (
        <div className="sources-list">
          {sources.map((src, index) => (
            <div key={index} className="source-item">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <FileCode size={14} style={{ color: 'var(--accent-cyan)' }} />
                <span>{src.path || src.source}</span>
              </div>
              {src.language && (
                <span className="lang-badge">{src.language}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
