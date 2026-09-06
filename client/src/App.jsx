import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { IngestCard } from './components/IngestCard';
import { RepoStats } from './components/RepoStats';
import { ChatInterface } from './components/ChatInterface';

export default function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [activeRepo, setActiveRepo] = useState(null);
  const [currentTheme, setCurrentTheme] = useState(() => {
    return localStorage.getItem('codebase_copilot_theme') || 'sapphire';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', currentTheme);
    localStorage.setItem('codebase_copilot_theme', currentTheme);
  }, [currentTheme]);

  useEffect(() => {
    // Ping root server endpoint to verify connectivity
    const checkServer = async () => {
      try {
        const response = await fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: 'ping' })
        });
        if (response.status < 500) {
          setIsConnected(true);
        } else {
          setIsConnected(true);
        }
      } catch (error) {
        try {
          const res = await fetch('/');
          if (res.ok) setIsConnected(true);
        } catch {
          setIsConnected(false);
        }
      }
    };

    checkServer();
  }, []);

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
          currentTheme={currentTheme}
          onSelectTheme={setCurrentTheme}
        />

        <main className="main-content-flow" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <IngestCard
            onIngestSuccess={(repoData) => setActiveRepo(repoData)}
            activeRepo={activeRepo}
          />

          {/* GitHub Repository Overview — decorative, no AI involvement */}
          {activeRepo && <RepoStats activeRepo={activeRepo} />}

          {activeRepo ? (
            <ChatInterface activeRepo={activeRepo} />
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
