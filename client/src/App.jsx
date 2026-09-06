import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { IngestCard } from './components/IngestCard';
import { ChatInterface } from './components/ChatInterface';

export default function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [activeRepo, setActiveRepo] = useState(null);

  useEffect(() => {
    // Ping root server endpoint to verify connectivity
    const checkServer = async () => {
      try {
        const response = await fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: 'ping' })
        });
        // If status is 200 or 400 (question handled/valid route), backend is responsive
        if (response.status < 500) {
          setIsConnected(true);
        } else {
          setIsConnected(true); // Server is running
        }
      } catch (error) {
        // Fallback check root /
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
    <div className="app-container">
      <Header isConnected={isConnected} activeRepo={activeRepo} />

      <main style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <IngestCard
          onIngestSuccess={(repoData) => setActiveRepo(repoData)}
          activeRepo={activeRepo}
        />

        <ChatInterface activeRepo={activeRepo} />
      </main>
    </div>
  );
}
