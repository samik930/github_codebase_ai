import React from 'react';
import { Cpu, GitBranch, ChevronDown, LogOut, EyeOff, User as UserIcon, Trash2 } from 'lucide-react';
import { ThemePicker } from './ThemePicker';

export function Header({ 
  isConnected, 
  activeRepo, 
  ingestedRepos = [], 
  selectedRepoId, 
  onSelectRepo, 
  onDeleteRepo,
  currentTheme, 
  onSelectTheme,
  user,
  onSignOut
}) {
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
          <p className="brand-subtitle">AI Multi-User RAG Codebase Intelligence</p>
        </div>
      </div>

      {/* Telemetry Bar */}
      <div className="hud-telemetry-bar">
        {/* Repository Selector Dropdown — shown when repos are available */}
        {ingestedRepos.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
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

            {selectedRepoId && onDeleteRepo && (
              <button
                type="button"
                className="btn-delete-repo"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (window.confirm(`Are you sure you want to delete repository "${selectedRepoId}" and all indexed vector data?`)) {
                    onDeleteRepo(selectedRepoId);
                  }
                }}
                title={`Delete repository ${selectedRepoId}`}
                style={{
                  background: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  color: '#ef4444',
                  borderRadius: '6px',
                  padding: '5px 8px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  fontSize: '0.74rem',
                  fontFamily: 'JetBrains Mono, monospace'
                }}
              >
                <Trash2 size={12} />
                <span>PURGE</span>
              </button>
            )}
          </div>
        )}

        {/* User Account / Demo Indicator */}
        {user && (
          <div 
            className="user-profile-badge" 
            style={user.isDemo ? { borderColor: 'rgba(217, 119, 6, 0.4)', background: 'rgba(217, 119, 6, 0.08)' } : {}}
          >
            {user.isDemo ? (
              <EyeOff size={13} style={{ color: 'var(--accent-yellow)', flexShrink: 0 }} />
            ) : user.avatar ? (
              <img src={user.avatar} alt={user.name} className="user-profile-avatar" />
            ) : (
              <UserIcon size={14} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
            )}
            <span style={{ 
              maxWidth: '120px', 
              overflow: 'hidden', 
              textOverflow: 'ellipsis', 
              whiteSpace: 'nowrap',
              color: user.isDemo ? 'var(--accent-yellow)' : 'var(--text-primary)'
            }}>
              {user.isDemo ? 'Demo Mode' : user.name}
            </span>
            <button 
              type="button" 
              className="btn-signout" 
              onClick={onSignOut}
              title={user.isDemo ? "Exit Demo Mode" : `Sign Out (${user.email})`}
            >
              <LogOut size={13} />
            </button>
          </div>
        )}

        {/* Theme Picker Switcher */}
        <ThemePicker currentTheme={currentTheme} onSelectTheme={onSelectTheme} />
      </div>
    </header>
  );
}
