import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { IngestCard } from './components/IngestCard';
import { RepoStats } from './components/RepoStats';
import { ChatInterface } from './components/ChatInterface';

export default function App() {
  const [isConnected, setIsConnected] = useState(false);

  // Multi-repo state: list of ingested repos + which one is selected
  const [ingestedRepos, setIngestedRepos] = useState(() => {
    try {
      const stored = localStorage.getItem('codebase_copilot_repos');
      return stored ? JSON.parse(stored) : [];
    } catch { return []; }
  });
  const [selectedRepoId, setSelectedRepoId] = useState(() => {
    return localStorage.getItem('codebase_copilot_selected_repo') || '';
  });

  const [currentTheme, setCurrentTheme] = useState(() => {
    return localStorage.getItem('codebase_copilot_theme') || 'sapphire';
  });

  // Derive the activeRepo object from the selected repo ID
  const activeRepo = ingestedRepos.find(r => r.repository === selectedRepoId) || null;

  // Persist repos to localStorage
  useEffect(() => {
    localStorage.setItem('codebase_copilot_repos', JSON.stringify(ingestedRepos));
  }, [ingestedRepos]);

  // Persist selected repo to localStorage
  useEffect(() => {
    localStorage.setItem('codebase_copilot_selected_repo', selectedRepoId);
  }, [selectedRepoId]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', currentTheme);
    localStorage.setItem('codebase_copilot_theme', currentTheme);
  }, [currentTheme]);

  // Fetch indexed repositories from backend on mount to sync with actual Qdrant state
  useEffect(() => {
    const syncRepos = async () => {
      try {
        const res = await fetch('/api/repositories');
        if (res.ok) {
          const data = await res.json();
          const backendRepos = data.repositories || [];
          
          if (backendRepos.length > 0) {
            // Merge backend repos with locally stored repos (keep local metadata like ownerAvatar, files, chunks)
            setIngestedRepos(prev => {
              const prevMap = {};
              prev.forEach(r => { prevMap[r.repository] = r; });
              
              const merged = backendRepos.map(br => ({
                repository: br.repo_id,
                // Preserve any existing local metadata
                ...(prevMap[br.repo_id] || {}),
                repository: br.repo_id,
              }));
              return merged;
            });

            // If no repo is selected but we have indexed repos, select the first
            if (!selectedRepoId && backendRepos.length > 0) {
              setSelectedRepoId(backendRepos[0].repo_id);
            }
            // If selected repo is no longer indexed, clear it
            if (selectedRepoId && !backendRepos.some(r => r.repo_id === selectedRepoId)) {
              setSelectedRepoId(backendRepos[0]?.repo_id || '');
            }
          }
        }
      } catch (err) {
        console.log('Could not sync repositories from backend:', err.message);
      }
    };

    syncRepos();
  }, []);

  // Check server connectivity
  useEffect(() => {
    const checkServer = async () => {
      try {
        const res = await fetch('/');
        if (res.ok) setIsConnected(true);
      } catch {
        setIsConnected(false);
      }
    };
    checkServer();
  }, []);

  // Handle successful ingestion: add/update repo in the list and select it
  const handleIngestSuccess = (repoData) => {
    const repoId = repoData.repository;
    
    setIngestedRepos(prev => {
      // Update if already exists, otherwise add
      const exists = prev.some(r => r.repository === repoId);
      if (exists) {
        return prev.map(r => r.repository === repoId ? { ...r, ...repoData } : r);
      }
      return [...prev, repoData];
    });

    // Auto-select the newly ingested repo
    setSelectedRepoId(repoId);
  };

  // Handle repo selection change
  const handleSelectRepo = (repoId) => {
    setSelectedRepoId(repoId);
  };

  return (
    <>
      {/* Ambient Light Glow Layers */}
      <div className="ambient-glow-1" />
      <div className="ambient-glow-2" />

      {/* Main App Canvas */}
      <div className="app-container">
        <Header 
          isConnected={isConnected} 
          activeRepo={activeRepo}
          ingestedRepos={ingestedRepos}
          selectedRepoId={selectedRepoId}
          onSelectRepo={handleSelectRepo}
          currentTheme={currentTheme}
          onSelectTheme={setCurrentTheme}
        />

        <main className="main-content-flow" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <IngestCard
            onIngestSuccess={handleIngestSuccess}
            activeRepo={activeRepo}
          />

          {/* GitHub Repository Overview — decorative, no AI involvement */}
          {activeRepo && <RepoStats activeRepo={activeRepo} />}

          {activeRepo ? (
            <ChatInterface activeRepo={activeRepo} repoId={selectedRepoId} />
          ) : (
            <div className="glass-card" style={{ textAlign: 'center', padding: '36px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
              <div className="hud-corner hud-corner-tl" />
              <div className="hud-corner hud-corner-tr" />
              <div className="hud-corner hud-corner-bl" />
              <div className="hud-corner hud-corner-br" />
              <span className="title-badge" style={{ fontSize: '0.78rem', padding: '4px 12px' }}>
                TERMINAL LOCKED
              </span>
              <h3 style={{ fontFamily: 'Space Grotesk, sans-serif', fontSize: '1.2rem', fontWeight: '700', color: 'var(--text-primary)' }}>
                INGEST A REPOSITORY TO UNLOCK CHAT TERMINAL
              </h3>
              <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.82rem', color: 'var(--text-secondary)', maxWidth: '540px' }}>
                Enter a GitHub repository URL above and execute ingestion. Once the codebase vector embeddings are 100% indexed, the RAG chat terminal will automatically unlock.
              </p>
            </div>
          )}
        </main>
      </div>
    </>
  );
}
