import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { IngestCard } from './components/IngestCard';
import { RepoStats } from './components/RepoStats';
import { ChatInterface } from './components/ChatInterface';
import { LandingPage } from './components/LandingPage';

export default function App() {
  const [isConnected, setIsConnected] = useState(false);

  // Authenticated user state (Google or Demo account)
  const [user, setUser] = useState(() => {
    try {
      const stored = localStorage.getItem('codebase_copilot_user');
      return stored ? JSON.parse(stored) : null;
    } catch { return null; }
  });

  const userKey = user ? (user.isDemo ? 'demo_user' : (user.email || user.id || 'demo_user')) : 'guest';

  // Multi-repo state: isolated per user
  const [ingestedRepos, setIngestedRepos] = useState(() => {
    if (!user || user.isDemo) return [];
    try {
      const stored = localStorage.getItem(`codebase_copilot_repos_${userKey}`);
      return stored ? JSON.parse(stored) : [];
    } catch { return []; }
  });

  const [selectedRepoId, setSelectedRepoId] = useState(() => {
    if (!user || user.isDemo) return '';
    return localStorage.getItem(`codebase_copilot_selected_repo_${userKey}`) || '';
  });

  const [currentTheme, setCurrentTheme] = useState(() => {
    return localStorage.getItem('codebase_copilot_theme') || 'sapphire';
  });

  // Derive the activeRepo object from the selected repo ID
  const activeRepo = ingestedRepos.find(r => r.repository === selectedRepoId) || null;

  // Persist user to localStorage
  useEffect(() => {
    if (user) {
      localStorage.setItem('codebase_copilot_user', JSON.stringify(user));
    } else {
      localStorage.removeItem('codebase_copilot_user');
    }
  }, [user]);

  const handleSignOut = () => {
    setUser(null);
    setIngestedRepos([]);
    setSelectedRepoId('');
    localStorage.removeItem('codebase_copilot_user');
  };

  // Persist repos to localStorage ONLY for real accounts (demo is strictly in-memory)
  useEffect(() => {
    if (user && !user.isDemo) {
      localStorage.setItem(`codebase_copilot_repos_${userKey}`, JSON.stringify(ingestedRepos));
      localStorage.setItem(`codebase_copilot_selected_repo_${userKey}`, selectedRepoId);
    }
  }, [ingestedRepos, selectedRepoId, user, userKey]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', currentTheme);
    localStorage.setItem('codebase_copilot_theme', currentTheme);
  }, [currentTheme]);

  // Sync repositories when user changes
  useEffect(() => {
    if (!user) {
      setIngestedRepos([]);
      setSelectedRepoId('');
      return;
    }

    if (user.isDemo) {
      // Demo accounts always start fresh with empty repositories (strict separation from cloud accounts)
      setIngestedRepos([]);
      setSelectedRepoId('');
      return;
    }

    // Google user: load user's local cache first
    try {
      const stored = localStorage.getItem(`codebase_copilot_repos_${userKey}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        setIngestedRepos(parsed);
        const sel = localStorage.getItem(`codebase_copilot_selected_repo_${userKey}`) || (parsed[0]?.repository || '');
        setSelectedRepoId(sel);
      }
    } catch (e) {}

    // Fetch user-specific indexed repositories from backend MongoDB
    const syncRepos = async () => {
      try {
        const res = await fetch(`/api/repositories?userId=${encodeURIComponent(userKey)}&isDemo=false`);
        if (res.ok) {
          const data = await res.json();
          const backendRepos = data.repositories || [];
          const backendRepoIds = new Set(backendRepos.map(r => r.repo_id));
          
          if (backendRepos.length === 0) {
            setIngestedRepos([]);
            setSelectedRepoId('');
            localStorage.removeItem(`codebase_copilot_repos_${userKey}`);
            localStorage.removeItem(`codebase_copilot_selected_repo_${userKey}`);
          } else {
            setIngestedRepos(prev => {
              const prevMap = {};
              prev.forEach(r => { prevMap[r.repository] = r; });
              
              const merged = backendRepos.map(br => ({
                repository: br.repo_id,
                ...(prevMap[br.repo_id] || {}),
                repository: br.repo_id,
              }));
              return merged;
            });

            setSelectedRepoId(prev => {
              if (prev && backendRepoIds.has(prev)) return prev;
              return backendRepos[0].repo_id;
            });
          }
        }
      } catch (err) {
        console.log('Could not sync repositories from backend:', err.message);
      }
    };

    syncRepos();
  }, [user?.email, user?.isDemo, userKey]);

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

  // Handle repository deletion / purge with immediate optimistic UI update
  const handleDeleteRepo = async (repoId) => {
    if (!repoId) return;

    // 1. Optimistic UI update: immediately remove from dropdown and state
    setIngestedRepos(prev => {
      const updated = prev.filter(r => r.repository !== repoId);
      const nextSelected = updated[0]?.repository || '';
      setSelectedRepoId(nextSelected);
      try {
        localStorage.setItem(`codebase_copilot_repos_${userKey}`, JSON.stringify(updated));
        localStorage.setItem(`codebase_copilot_selected_repo_${userKey}`, nextSelected);
      } catch (e) {}
      return updated;
    });

    // 2. Call backend to cancel queue, delete Qdrant vectors, BM25 file, and MongoDB records
    try {
      const res = await fetch(`/api/repositories?repo_id=${encodeURIComponent(repoId)}&userId=${encodeURIComponent(userKey)}`, {
        method: 'DELETE'
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        console.warn('[WARN] Backend deletion notice:', errData.error || res.statusText);
      }
    } catch (err) {
      console.error('Failed to delete repository from backend:', err.message);
    }
  };

  // If user is not authenticated, display the Landing Page
  if (!user) {
    return <LandingPage onAuthenticate={setUser} />;
  }

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
          onDeleteRepo={handleDeleteRepo}
          currentTheme={currentTheme}
          onSelectTheme={setCurrentTheme}
          user={user}
          onSignOut={handleSignOut}
        />

        <main className="main-content-flow" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <IngestCard
            onIngestSuccess={handleIngestSuccess}
            onDeleteRepo={handleDeleteRepo}
            activeRepo={activeRepo}
            user={user}
          />


          {/* GitHub Repository Overview — decorative, no AI involvement */}
          {activeRepo && <RepoStats activeRepo={activeRepo} />}

          {activeRepo ? (
            <ChatInterface activeRepo={activeRepo} repoId={selectedRepoId} user={user} />
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

