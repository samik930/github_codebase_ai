import React, { useState } from 'react';
import { 
  FolderGit2, Loader2, CheckCircle, AlertCircle, ArrowRight, 
  Clock, AlertTriangle, Layers, FileCode, Database, Cpu
} from 'lucide-react';

function GithubIcon({ size = 18, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={style}>
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}

export function IngestCard({ onIngestSuccess, activeRepo }) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(0);
  const [batchInfo, setBatchInfo] = useState(null);
  const [statusMessage, setStatusMessage] = useState('');

  const handleIngest = async (e) => {
    if (e) e.preventDefault();
    if (!url.trim()) return;

    setLoading(true);
    setError(null);
    setProgress(0);
    setBatchInfo(null);
    setStatusMessage('Connecting to repository ingestion pipeline...');

    try {
      const response = await fetch('/api/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ githubUrl: url.trim() }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Ingestion request failed');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop(); // keep trailing incomplete chunk

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.replace(/^data:\s*/, '');
            try {
              const event = JSON.parse(jsonStr);

              if (event.type === 'error') {
                throw new Error(event.error || 'Ingestion process error');
              }

              if (event.type === 'status') {
                setStatusMessage(event.message);
              }

              if (event.percent !== undefined) {
                setProgress(event.percent);
              }

              if (event.currentBatch !== undefined && event.totalBatches !== undefined) {
                setBatchInfo({
                  currentBatch: event.currentBatch,
                  totalBatches: event.totalBatches,
                  processedChunks: event.processedChunks,
                  totalChunks: event.totalChunks
                });
                setStatusMessage(`Processing batch ${event.currentBatch} of ${event.totalBatches} (${event.processedChunks} / ${event.totalChunks} chunks)`);
              }

              if (event.type === 'complete') {
                setProgress(100);
                setStatusMessage('Ingestion completed successfully!');
                onIngestSuccess(event);
                setUrl('');
                setLoading(false);
                return;
              }
            } catch (err) {
              if (err.message && err.message !== 'Ingestion process error') {
                console.error("SSE parse error:", err);
              } else {
                throw err;
              }
            }
          }
        }
      }
    } catch (err) {
      setError(err.message || 'Failed to ingest repository');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="glass-card ingest-container">
      {/* Corner HUD accents */}
      <div className="hud-corner hud-corner-tl" />
      <div className="hud-corner hud-corner-tr" />
      <div className="hud-corner hud-corner-bl" />
      <div className="hud-corner hud-corner-br" />

      {/* Laser Scanning Beam FX while loading */}
      {loading && <div className="laser-scan-line" />}

      {/* Section Header */}
      <div className="section-title-bar">
        <div className="section-title">
          <GithubIcon size={20} style={{ color: 'var(--accent-primary)' }} />
          <span>INGEST REPOSITORY</span>
        </div>
      </div>

      {/* Input Form */}
      <form onSubmit={handleIngest} className="input-group">
        <input
          type="url"
          className="cyber-input"
          placeholder="Enter GitHub Repository URL... (e.g., https://github.com/owner/repo)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={loading}
          required
        />
        <button type="submit" className="btn-cyber-primary" disabled={loading || !url.trim()}>
          {loading ? (
            <>
              <Loader2 size={18} className="spinner" />
              <span>INDEXING PIPELINE...</span>
            </>
          ) : (
            <>
              <span>EXECUTE INGEST</span>
              <ArrowRight size={18} />
            </>
          )}
        </button>
      </form>

      {/* Real-time Batch Progress Loading Bar */}
      {loading && (
        <div className="ingest-progress-box">
          <div className="ingest-progress-header">
            <div className="ingest-progress-title">
              <Loader2 size={18} className="spinner" />
              <span>Ingestion in Progress... Please wait! (May take several minutes)</span>
            </div>
            <span className="ingest-progress-pct">{progress}%</span>
          </div>

          <div className="ingest-progress-bar-track">
            <div 
              className="ingest-progress-bar-fill" 
              style={{ width: `${progress}%` }} 
            />
          </div>

          <div className="ingest-stage-desc" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Cpu size={14} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
              <span>{statusMessage || 'Processing codebase vectors...'}</span>
            </div>

            {batchInfo && (
              <span style={{ fontWeight: '700', color: 'var(--accent-primary)', background: 'rgba(37, 99, 235, 0.06)', padding: '2px 8px', borderRadius: '4px' }}>
                BATCH {batchInfo.currentBatch}/{batchInfo.totalBatches} ({batchInfo.processedChunks}/{batchInfo.totalChunks} CHUNKS)
              </span>
            )}
          </div>
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="hud-pill" style={{ padding: '12px 18px', background: 'rgba(239, 68, 68, 0.08)', borderColor: '#ef4444', color: '#dc2626', borderRadius: '10px' }}>
          <AlertCircle size={18} style={{ flexShrink: 0 }} />
          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.85rem' }}>{error}</span>
        </div>
      )}

      {/* Active Ingested Repository Telemetry Cards */}
      {activeRepo && !error && !loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div className="hud-pill hud-pill-active" style={{ padding: '10px 16px', borderRadius: '10px' }}>
            <CheckCircle size={18} style={{ color: 'var(--accent-green)' }} />
            <span style={{ fontFamily: 'Space Grotesk, sans-serif', fontWeight: '600', wordBreak: 'break-word' }}>
              REPOSITORY INDEXED SUCCESSFULLY: <strong>{activeRepo.repository}</strong>
            </span>
          </div>

          <div className="repo-telemetry-grid">
            <div className="telemetry-card">
              <span className="telemetry-label">SOURCE FILES</span>
              <div className="telemetry-value">
                <FileCode size={18} style={{ color: 'var(--accent-primary)' }} />
                <span>{activeRepo.files}</span>
              </div>
            </div>

            <div className="telemetry-card">
              <span className="telemetry-label">VECTOR CHUNKS</span>
              <div className="telemetry-value" style={{ color: 'var(--accent-secondary)' }}>
                <Layers size={18} />
                <span>{activeRepo.chunks || 'Indexed'}</span>
              </div>
            </div>

            <div className="telemetry-card">
              <span className="telemetry-label">INDEX STATUS</span>
              <div className="telemetry-value" style={{ color: 'var(--accent-green)' }}>
                <Database size={18} />
                <span>READY</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
