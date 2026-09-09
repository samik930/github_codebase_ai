import React from 'react';
import { Cpu, GitBranch } from 'lucide-react';
import { ThemePicker } from './ThemePicker';

export function Header({ isConnected, activeRepo, currentTheme, onSelectTheme }) {
  return (
    <header className="app-header">
      {/* Brand Section */}
      <div className="brand-section">
        <div className="brand-icon-wrapper">
          <Cpu size={24} style={{ color: '#ffffff' }} />
        </div>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <h1 className="brand-title">CODEBASE COPILOT</h1>
          </div>
          <p className="brand-subtitle">AI RAG Codebase Intelligence</p>
        </div>
      </div>

      {/* Telemetry Bar */}
      <div className="hud-telemetry-bar">
        {/* Active Repo Chip */}
        {activeRepo && (
          <div className="hud-pill hud-pill-active">
            <GitBranch size={13} style={{ color: 'var(--accent-secondary)' }} />
            <span className="repo-pill-text">{activeRepo.repository} ({activeRepo.files} FILES)</span>
          </div>
        )}

        {/* Theme Picker Switcher */}
        <ThemePicker currentTheme={currentTheme} onSelectTheme={onSelectTheme} />
      </div>
    </header>
  );
}
