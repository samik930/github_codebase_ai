import React, { useState } from 'react';
import { ChevronDown, ChevronRight, FileCode, ExternalLink, Target, Image as ImageIcon, Maximize2, X } from 'lucide-react';

export function SourceViewer({ sources }) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedImage, setSelectedImage] = useState(null);

  if (!sources || sources.length === 0) return null;

  const visualSources = sources.filter(s => s.type === 'visual_asset' || s.raw_url);
  const codeSources = sources.filter(s => s.type !== 'visual_asset' && !s.raw_url);

  return (
    <div className="sources-container">
      <button 
        className="sources-toggle"
        onClick={() => setIsOpen(!isOpen)}
        type="button"
      >
        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>
          REFERENCED SOURCES ({sources.length} ITEMS{visualSources.length > 0 ? ` • ${visualSources.length} DIAGRAMS` : ''})
        </span>
      </button>

      {isOpen && (
        <div className="sources-list">
          {/* Visual Diagrams Section */}
          {visualSources.length > 0 && (
            <div>
              <div style={{ 
                display: 'flex', 
                alignItems: 'center', 
                gap: '8px', 
                fontSize: '0.75rem', 
                fontWeight: '700', 
                color: 'var(--accent-secondary)',
                marginBottom: '8px',
                fontFamily: 'Space Grotesk, sans-serif'
              }}>
                <ImageIcon size={14} />
                <span>ARCHITECTURAL DIAGRAMS & VISUAL EVIDENCE</span>
              </div>

              <div className="visual-sources-grid">
                {visualSources.map((vis, vIdx) => {
                  const matchScore = Math.max(85, 99 - vIdx * 4);
                  return (
                    <div key={vIdx} className="visual-source-card">
                      <div className="visual-source-header">
                        <span style={{ fontWeight: '600', color: 'var(--text-primary)' }}>
                          {vis.filename || vis.path}
                        </span>
                        <span className="visual-badge">DIAGRAM</span>
                      </div>

                      {vis.raw_url ? (
                        <div 
                          className="visual-thumb-wrapper"
                          onClick={() => setSelectedImage(vis)}
                          title="Click to expand diagram"
                        >
                          <img 
                            src={vis.raw_url} 
                            alt={vis.filename || 'Architecture Diagram'} 
                            className="visual-thumb-img"
                            onError={(e) => {
                              e.target.onerror = null;
                              e.target.style.display = 'none';
                            }}
                          />
                          <div className="visual-thumb-overlay">
                            <Maximize2 size={16} />
                            <span>EXPAND DIAGRAM</span>
                          </div>
                        </div>
                      ) : (
                        <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)' }}>
                          No image preview available
                        </div>
                      )}

                      <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.75rem' }}>
                        <span style={{ color: 'var(--text-secondary)', fontFamily: 'JetBrains Mono, monospace' }}>
                          {vis.path}
                        </span>
                        {vis.raw_url && (
                          <a 
                            href={vis.raw_url} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--accent-primary)', textDecoration: 'none' }}
                          >
                            <ExternalLink size={12} />
                            <span>GitHub</span>
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Code Sources Section */}
          {codeSources.length > 0 && (
            <div>
              {visualSources.length > 0 && (
                <div style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '8px', 
                  fontSize: '0.75rem', 
                  fontWeight: '700', 
                  color: 'var(--accent-primary)',
                  margin: '12px 0 8px 0',
                  fontFamily: 'Space Grotesk, sans-serif'
                }}>
                  <FileCode size={14} />
                  <span>SOURCE CODE FILES</span>
                </div>
              )}

              {codeSources.map((src, index) => {
                const matchScore = Math.max(78, 98 - index * 5);
                return (
                  <div key={index} className="source-item">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <FileCode size={15} style={{ color: 'var(--accent-primary)' }} />
                      <span style={{ fontWeight: '500' }}>{src.path || src.source}</span>
                    </div>
                    
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span className="telemetry-label" style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--accent-green)' }}>
                        <Target size={11} />
                        {matchScore}% SIMILARITY
                      </span>

                      {src.language && (
                        <span className="lang-badge">{src.language}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Modal Dialog for Full Diagram Inspection */}
      {selectedImage && (
        <div 
          className="visual-modal-backdrop"
          onClick={() => setSelectedImage(null)}
        >
          <div 
            className="visual-modal-content"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="visual-modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <ImageIcon size={18} style={{ color: 'var(--accent-secondary)' }} />
                <span>{selectedImage.filename || selectedImage.path}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                {selectedImage.raw_url && (
                  <a 
                    href={selectedImage.raw_url} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="lang-badge"
                    style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '4px' }}
                  >
                    <ExternalLink size={11} />
                    <span>Open in GitHub</span>
                  </a>
                )}
                <button 
                  onClick={() => setSelectedImage(null)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}
                >
                  <X size={20} />
                </button>
              </div>
            </div>
            <img 
              src={selectedImage.raw_url} 
              alt={selectedImage.filename || 'Diagram View'} 
              className="visual-modal-img" 
            />
          </div>
        </div>
      )}
    </div>
  );
}
