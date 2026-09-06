import React from 'react';
import { Cpu, Server, CheckCircle2, GitBranch } from 'lucide-react';

export function Header({ isConnected, activeRepo }) {
  return (
    <header className="app-header">
      <div className="brand-section">
        <div className="brand-icon">
          <Cpu size={24} />
        </div>
        <div>
          <h1 className="brand-title">Codebase Copilot</h1>
          <p className="brand-subtitle">AI-Powered RAG Code Intelligence</p>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        {activeRepo && (
          <div className="repo-status-chip" style={{ padding: '6px 12px' }}>
            <GitBranch size={14} />
            <span>{activeRepo.repository} ({activeRepo.files} files)</span>
          </div>
        )}

        <div className="status-badge">
          <div className={`status-dot ${isConnected ? 'online' : 'idle'}`} />
          <Server size={14} style={{ color: 'var(--text-muted)' }} />
          <span>{isConnected ? 'Backend Ready' : 'Connecting...'}</span>
        </div>
      </div>
    </header>
  );
}
