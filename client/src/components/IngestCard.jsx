import React, { useState, useEffect, useRef } from 'react';
import { 
  FolderGit2, Loader2, CheckCircle, AlertCircle, ArrowRight, 
  Clock, AlertTriangle, Layers, FileCode, Database, Cpu, RotateCw
} from 'lucide-react';

function GithubIcon({ size = 18, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={style}>
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}

export function IngestCard({ onIngestSuccess, activeRepo, user }) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [activeJobId, setActiveJobId] = useState(null);
  const [jobStatus, setJobStatus] = useState(null); // 'queued' | 'processing' | 'completed' | 'failed'
  
  const pollTimerRef = useRef(null);

  // Clean up polling timer on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
      }
    };
  }, []);

  const startPolling = (jobId) => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);

    pollTimerRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/ingest/status/${jobId}`);
        if (!res.ok) {
          if (res.status === 404) return;
          throw new Error('Failed to fetch job status');
        }

        const data = await res.json();
        setJobStatus(data.status);
        setProgress(data.progress || 0);
        setStatusMessage(data.stage || `Status: ${data.status}`);

        if (data.status === 'completed') {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
          setLoading(false);
          setProgress(100);
          setStatusMessage('Ingestion completed successfully!');
          setUrl('');
          onIngestSuccess({
            repository: data.repoId,
            files: data.filesCount,
            visualFiles: data.visualCount,
            status: 'completed'
          });
        } else if (data.status === 'failed') {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
          setLoading(false);
          setError(data.error || 'Ingestion failed during execution');
        }
      } catch (err) {
        console.warn('Polling error:', err.message);
      }
    }, 1500);
  };

  const handleIngest = async (e) => {
    if (e) e.preventDefault();
    if (!url.trim()) return;

    setLoading(true);
    setError(null);
    setProgress(0);
    setJobStatus('queued');
    setStatusMessage('Submitting ingestion job to BullMQ queue...');

    try {
      const response = await fetch('/api/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          githubUrl: url.trim(),
          userId: user?.isDemo ? null : (user?.email || user?.id || null),
          isDemo: Boolean(user?.isDemo)
        }),
      });

      const data = await response.json();

      if (response.status === 409) {
        // Active job already running
        setActiveJobId(data.jobId);
        setJobStatus(data.status);
        setProgress(data.progress || 0);
        setStatusMessage(data.stage || 'Ingestion job is already running...');
        startPolling(data.jobId);
        return;
      }

      if (!response.ok) {
        throw new Error(data.error || data.message || 'Ingestion request failed');
      }

      // Job successfully queued
      setActiveJobId(data.jobId);
      setJobStatus('queued');
      setStatusMessage('Job queued in background. Waiting for worker...');
      startPolling(data.jobId);

    } catch (err) {
      setError(err.message || 'Failed to submit ingestion job');
      setLoading(false);
    }
  };

  const handleRetry = async () => {
    if (!activeJobId) return;

    setLoading(true);
    setError(null);
    setProgress(0);
    setJobStatus('queued');
    setStatusMessage('Re-queuing failed job to BullMQ...');

    try {
      const res = await fetch(`/api/ingest/retry/${activeJobId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user?.isDemo ? null : (user?.email || user?.id || null)
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to retry job');
      }

      startPolling(activeJobId);
    } catch (err) {
      setError(err.message || 'Failed to retry job');
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
          <span>INGEST REPOSITORY (CONCURRENT BULLMQ PIPELINE)</span>
        </div>
        {activeJobId && (
          <span className="title-badge" style={{ fontSize: '0.72rem' }}>
            JOB: {activeJobId}
          </span>
        )}
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
              <span>{jobStatus === 'queued' ? 'QUEUED IN REDIS...' : 'WORKER PROCESSING...'}</span>
            </>
          ) : (
            <>
              <span>QUEUE INGESTION</span>
              <ArrowRight size={18} />
            </>
          )}
        </button>
      </form>

      {/* Real-time Job Progress Loading Bar */}
      {loading && (
        <div className="ingest-progress-box">
          <div className="ingest-progress-header">
            <div className="ingest-progress-title">
              <Loader2 size={18} className="spinner" />
              <span>
                {jobStatus === 'queued' 
                  ? 'Queued in BullMQ (Waiting for free ingestion worker)...'
                  : 'Worker processing repository ingestion in background...'}
              </span>
            </div>
            <span className="ingest-progress-pct">{progress}%</span>
          </div>

          <div className="ingest-progress-bar-track">
            <div 
              className="ingest-progress-bar-fill" 
              style={{ width: `${Math.max(progress, 5)}%` }} 
            />
          </div>

          <div className="ingest-stage-desc" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Cpu size={14} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
              <span>{statusMessage || 'Processing codebase vectors...'}</span>
            </div>
            <span style={{ 
              fontWeight: '700', 
              color: jobStatus === 'queued' ? 'var(--accent-yellow)' : 'var(--accent-primary)', 
              background: 'rgba(37, 99, 235, 0.08)', 
              padding: '2px 8px', 
              borderRadius: '4px',
              textTransform: 'uppercase',
              fontSize: '0.74rem'
            }}>
              {jobStatus || 'QUEUED'}
            </span>
          </div>
        </div>
      )}

      {/* Error Message with Retry Button */}
      {error && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div className="hud-pill" style={{ padding: '12px 18px', background: 'rgba(239, 68, 68, 0.08)', borderColor: '#ef4444', color: '#dc2626', borderRadius: '10px' }}>
            <AlertCircle size={18} style={{ flexShrink: 0 }} />
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.85rem' }}>{error}</span>
          </div>
          {activeJobId && (
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button 
                type="button" 
                onClick={handleRetry} 
                className="btn-cyber-primary"
                style={{ padding: '8px 18px', fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                <RotateCw size={14} />
                <span>RETRY FAILED JOB</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Active Ingested Repository Telemetry Cards */}
      {activeRepo && !error && !loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div className="hud-pill hud-pill-active" style={{ padding: '10px 16px', borderRadius: '10px' }}>
            <CheckCircle size={18} style={{ color: 'var(--accent-green)' }} />
            <span style={{ fontFamily: 'Space Grotesk, sans-serif', fontWeight: '600', wordBreak: 'break-word' }}>
              REPOSITORY READY: <strong>{activeRepo.repository}</strong>
            </span>
          </div>

          <div className="repo-telemetry-grid">
            <div className="telemetry-card">
              <span className="telemetry-label">SOURCE FILES</span>
              <div className="telemetry-value">
                <FileCode size={18} style={{ color: 'var(--accent-primary)' }} />
                <span>{activeRepo.files || 0}</span>
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
              <span className="telemetry-label">QUEUE STATUS</span>
              <div className="telemetry-value" style={{ color: 'var(--accent-green)' }}>
                <Database size={18} />
                <span>COMPLETED</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
