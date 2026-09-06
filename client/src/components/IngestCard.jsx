import React, { useState } from 'react';
import { FolderGit2, Loader2, CheckCircle, AlertCircle, ArrowRight, Clock, AlertTriangle } from 'lucide-react';

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

  const handleIngest = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ githubUrl: url.trim() }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Ingestion failed');
      }

      onIngestSuccess(data);
      setUrl('');
    } catch (err) {
      setError(err.message || 'Failed to ingest repository');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="glass-card ingest-container">
      <div className="section-title">
        <GithubIcon size={18} style={{ color: 'var(--accent-blue)' }} />
        <span>Ingest GitHub Repository</span>
      </div>

      <form onSubmit={handleIngest} className="input-group">
        <input
          type="url"
          className="input-field"
          placeholder="https://github.com/owner/repository"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={loading}
          required
        />
        <button type="submit" className="btn-primary" disabled={loading || !url.trim()}>
          {loading ? (
            <>
              <Loader2 size={16} className="spinner" />
              <span>Ingesting Codebase...</span>
            </>
          ) : (
            <>
              <span>Ingest Repository</span>
              <ArrowRight size={16} />
            </>
          )}
        </button>
      </form>

      {loading && (
        <div className="repo-status-chip" style={{ background: 'rgba(37, 99, 235, 0.08)', borderColor: 'rgba(37, 99, 235, 0.4)', color: '#2563eb', display: 'flex', gap: '10px', alignItems: 'center' }}>
          <Clock size={18} className="spinner" style={{ flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: '600', fontSize: '0.88rem' }}>Ingestion in progress...</div>
            <div style={{ fontSize: '0.82rem', opacity: 0.9 }}>
              Please wait! It might take several minutes if the chunk size is &ge; 300.
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="repo-status-chip" style={{ background: 'rgba(239, 68, 68, 0.1)', borderColor: 'rgba(239, 68, 68, 0.3)', color: '#f87171' }}>
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      {activeRepo && !error && !loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div className="repo-status-chip">
            <CheckCircle size={16} />
            <span>
              Ingested <strong>{activeRepo.repository}</strong> ({activeRepo.files} files{activeRepo.chunks ? `, ${activeRepo.chunks} chunks` : ''} indexed into vector database)
            </span>
          </div>

          {((activeRepo.chunks && activeRepo.chunks >= 300) || (activeRepo.files && activeRepo.files >= 300)) && (
            <div className="repo-status-chip" style={{ background: 'rgba(234, 179, 8, 0.1)', borderColor: 'rgba(234, 179, 8, 0.3)', color: '#facc15' }}>
              <AlertTriangle size={16} />
              <span>
                Large codebase processed ({activeRepo.chunks || activeRepo.files} chunks &ge; 300).
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
