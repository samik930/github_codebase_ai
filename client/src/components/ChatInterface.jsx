import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Send, Bot, User, MessageSquare, Loader2, Sparkles, Trash2, Cpu, Terminal, Zap } from 'lucide-react';
import { SourceViewer } from './SourceViewer';

const QUICK_SUGGESTIONS = [
  "⚡ What does this codebase do?",
  "🔍 List all API endpoints & route handlers",
  "🏗️ Explain the architecture & project structure",
  "🛡️ How does error handling or auth work?"
];

export function ChatInterface({ activeRepo }) {
  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, loading]);

  useEffect(() => {
    setMessages([]);
  }, [activeRepo?.repository]);

  const handleClearChat = () => {
    setMessages([]);
  };

  const handleSend = async (queryText) => {
    const textToSend = queryText || question;
    if (!textToSend.trim() || loading) return;

    const userMessage = { id: Date.now(), role: 'user', content: textToSend };
    setMessages((prev) => [...prev, userMessage]);
    if (!queryText) setQuestion('');
    setLoading(true);

    const startTime = Date.now();

    try {
      const response = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: textToSend }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || data.error || 'Failed to query server');
      }

      const durationMs = Date.now() - startTime;

      const assistantMessage = {
        id: Date.now() + 1,
        role: 'assistant',
        content: data.answer || "No response received.",
        sources: data.sources || [],
        telemetry: {
          executionTime: `${durationMs}ms`,
          sourcesCount: (data.sources || []).length
        }
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now() + 1,
          role: 'assistant',
          content: `⚠️ **SYSTEM ERROR**: ${err.message || 'Could not fetch response from server.'}`,
          sources: []
        }
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="glass-card chat-container">
      {/* HUD Corner Accents */}
      <div className="hud-corner hud-corner-tl" />
      <div className="hud-corner hud-corner-tr" />
      <div className="hud-corner hud-corner-bl" />
      <div className="hud-corner hud-corner-br" />

      {/* Chat Header Toolbar */}
      <div className="chat-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <MessageSquare size={18} style={{ color: 'var(--accent-primary)' }} />
          <span style={{ fontFamily: 'Space Grotesk, sans-serif', fontWeight: '700', fontSize: '0.95rem', letterSpacing: '0.02em' }}>
            RAG QUERY TERMINAL
          </span>
          {activeRepo && (
            <span className="title-badge" style={{ textTransform: 'uppercase' }}>
              TARGET: {activeRepo.repository}
            </span>
          )}
        </div>

        {messages.length > 0 && (
          <button 
            className="hud-pill"
            onClick={handleClearChat} 
            disabled={loading}
            style={{ cursor: 'pointer', borderColor: 'rgba(239, 68, 68, 0.3)', color: '#dc2626' }}
            title="Clear message history"
          >
            <Trash2 size={13} />
            <span>PURGE LOGS</span>
          </button>
        )}
      </div>

      {/* Messages Scroll Area */}
      <div className="chat-messages">
        {messages.length === 0 ? (
          <div className="chat-empty">
            <div className="empty-cyber-badge">
              <Sparkles size={32} />
            </div>
            <div>
              <h3 style={{ fontFamily: 'Space Grotesk, sans-serif', fontSize: '1.25rem', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '6px' }}>
                ASK ANYTHING ABOUT YOUR CODEBASE
              </h3>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                Ask questions about code structure, logic, API routes, or functions.
              </p>
            </div>

            <div className="suggestion-pills">
              {QUICK_SUGGESTIONS.map((text, idx) => (
                <button
                  key={idx}
                  className="suggestion-pill"
                  onClick={() => handleSend(text.replace(/^[^\s]+\s/, ''))}
                  disabled={loading}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className={`message-row ${msg.role}`}>
              <div className={`avatar ${msg.role}`}>
                {msg.role === 'user' ? <User size={18} /> : <Bot size={18} />}
              </div>
              <div className="message-content">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {typeof msg.content === 'string' ? msg.content : (typeof msg.content === 'object' && msg.content !== null ? JSON.stringify(msg.content, null, 2) : String(msg.content || ''))}
                </ReactMarkdown>

                {/* Assistant Response Telemetry Bar */}
                {msg.role === 'assistant' && msg.telemetry && (
                  <div style={{ display: 'flex', gap: '14px', marginTop: '12px', paddingTop: '8px', borderTop: '1px solid rgba(0, 0, 0, 0.06)' }}>
                    <span className="telemetry-label" style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--text-muted)' }}>
                      <Zap size={11} style={{ color: 'var(--accent-yellow)' }} />
                      LATENCY: {msg.telemetry.executionTime}
                    </span>
                    <span className="telemetry-label" style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--text-muted)' }}>
                      <Cpu size={11} style={{ color: 'var(--accent-primary)' }} />
                      MATCHES: {msg.telemetry.sourcesCount} VECTORS
                    </span>
                  </div>
                )}

                {/* Referenced Sources Accordion */}
                {msg.role === 'assistant' && msg.sources && (
                  <SourceViewer sources={msg.sources} />
                )}
              </div>
            </div>
          ))
        )}

        {/* Loading State with Equalizer Visualizer */}
        {loading && (
          <div className="message-row assistant">
            <div className="avatar assistant">
              <Bot size={18} />
            </div>
            <div className="message-content" style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
              <div className="equalizer-container">
                <div className="equalizer-bar" />
                <div className="equalizer-bar" />
                <div className="equalizer-bar" />
                <div className="equalizer-bar" />
              </div>
              <span style={{ fontFamily: 'Space Grotesk, sans-serif', fontSize: '0.88rem', fontWeight: '600', color: 'var(--accent-primary)' }}>
                Searching vectors & generating response...
              </span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Chat Input Bar */}
      <div className="chat-input-wrapper">
        <textarea
          className="chat-textarea"
          rows={1}
          placeholder="Type your question about the ingested codebase... (Press Enter to transmit)"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
        />
        <button
          className="btn-cyber-primary btn-chat-send"
          onClick={() => handleSend()}
          disabled={loading || !question.trim()}
          style={{ height: '46px', padding: '0 22px' }}
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  );
}
