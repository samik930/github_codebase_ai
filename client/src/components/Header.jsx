import React from 'react';
import { Cpu, GitBranch, ChevronDown } from 'lucide-react';
import { ThemePicker } from './ThemePicker';

export function Header({ isConnected, activeRepo, ingestedRepos = [], selectedRepoId, onSelectRepo, currentTheme, onSelectTheme }) {
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
        {/* Repository Selector Dropdown — shown when repos are available */}
        {ingestedRepos.length > 0 && (
          <div className="repo-selector-wrapper">
            {activeRepo?.ownerAvatar ? (
              <img
                src={activeRepo.ownerAvatar}
                alt={activeRepo.repository?.split('/')[0]}
                style={{
                  width: '18px',
                  height: '18px',
                  borderRadius: '50%',
                  objectFit: 'cover',
                  flexShrink: 0,
                  border: '1px solid var(--accent-secondary)'
                }}
              />
            ) : (
              <GitBranch size={13} style={{ color: 'var(--accent-secondary)', flexShrink: 0 }} />
            )}
            <select
              className="repo-selector"
              value={selectedRepoId}
              onChange={(e) => onSelectRepo(e.target.value)}
            >
              {ingestedRepos.map((repo) => (
                <option key={repo.repository} value={repo.repository}>
                  {repo.repository}{repo.files ? ` (${repo.files} files)` : ''}
                </option>
              ))}
            </select>
            <ChevronDown size={13} className="repo-selector-chevron" />
          </div>
        )}

        {/* Theme Picker Switcher */}
        <ThemePicker currentTheme={currentTheme} onSelectTheme={onSelectTheme} />
      </div>
    </header>
  );
}
