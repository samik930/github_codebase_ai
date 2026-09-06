import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Send, Bot, User, MessageSquare, Loader2, Sparkles, Trash2 } from 'lucide-react';
import { SourceViewer } from './SourceViewer';

const QUICK_SUGGESTIONS = [
  "What does this codebase do?",
  "List all API endpoints and resolvers",
  "Explain the project structure and tech stack",
  "How does authentication or error handling work?"
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

      const assistantMessage = {
        id: Date.now() + 1,
        role: 'assistant',
        content: data.answer || "No response received.",
        sources: data.sources || []
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now() + 1,
          role: 'assistant',
          content: `⚠️ **Error**: ${err.message || 'Could not fetch response from server.'}`,
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
    <div className="glass-card chat-container" style={{ padding: 0 }}>
      {/* Chat Header Toolbar */}
      <div className="chat-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: '600', fontSize: '0.92rem' }}>
          <MessageSquare size={16} style={{ color: 'var(--accent-blue)' }} />
          <span>Code Assistant Conversation</span>
        </div>

        {messages.length > 0 && (
          <button 
            className="btn-clear" 
            onClick={handleClearChat} 
            disabled={loading}
            title="Clear message history"
          >
            <Trash2 size={14} />
            <span>Clear Chat</span>
          </button>
        )}
      </div>

      <div className="chat-messages">
        {messages.length === 0 ? (
          <div className="chat-empty">
            <div className="empty-icon">
              <Sparkles size={28} />
            </div>
            <div>
              <h3 style={{ fontSize: '1.1rem', fontWeight: '600', marginBottom: '6px' }}>
                Ask Anything About Your Codebase
              </h3>
              <p style={{ fontSize: '0.85rem' }}>
                Ingest a repository above or start asking questions about the code, architecture, or functions.
              </p>
            </div>

            <div className="suggestion-pills">
              {QUICK_SUGGESTIONS.map((text, idx) => (
                <button
                  key={idx}
                  className="suggestion-pill"
                  onClick={() => handleSend(text)}
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
                {msg.role === 'user' ? <User size={16} /> : <Bot size={16} />}
              </div>
              <div className="message-content">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {typeof msg.content === 'string' ? msg.content : (typeof msg.content === 'object' && msg.content !== null ? JSON.stringify(msg.content, null, 2) : String(msg.content || ''))}
                </ReactMarkdown>
                {msg.role === 'assistant' && msg.sources && (
                  <SourceViewer sources={msg.sources} />
                )}
              </div>
            </div>
          ))
        )}

        {loading && (
          <div className="message-row assistant">
            <div className="avatar assistant">
              <Bot size={16} />
            </div>
            <div className="message-content" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Loader2 size={16} className="spinner" style={{ color: 'var(--accent-blue)' }} />
              <span style={{ fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
                Searching vectors & generating answer...
              </span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-wrapper">
        <textarea
          className="chat-textarea"
          rows={1}
          placeholder="Ask a question about the ingested codebase... (Press Enter to send)"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
        />
        <button
          className="btn-primary"
          onClick={() => handleSend()}
          disabled={loading || !question.trim()}
          style={{ height: '44px', padding: '0 18px' }}
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}
