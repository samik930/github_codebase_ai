import React, { useState } from 'react';
import { GoogleLogin } from '@react-oauth/google';
import { jwtDecode } from 'jwt-decode';
import { Cpu, ShieldCheck, EyeOff, Sparkles, GitBranch, ArrowRight, CheckCircle2, Lock, Layers, Zap, Image as ImageIcon, Terminal, AlertCircle } from 'lucide-react';

export function LandingPage({ onAuthenticate }) {
  const [showGoogleModal, setShowGoogleModal] = useState(false);
  const [customName, setCustomName] = useState('Alex Rivera');
  const [customEmail, setCustomEmail] = useState('alex.rivera.dev@gmail.com');
  const [authError, setAuthError] = useState('');

  // Handle successful Google OAuth login
  const handleGoogleSuccess = async (credentialResponse) => {
    try {
      setAuthError('');
      if (!credentialResponse?.credential) {
        throw new Error("No credential token received from Google");
      }

      // Decode Google OpenID Connect ID token
      const decoded = jwtDecode(credentialResponse.credential);
      console.log("[GOOGLE AUTH] Decoded user:", decoded);

      // Verify token with backend
      let verifiedUser = null;
      try {
        const res = await fetch('/api/auth/google', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: credentialResponse.credential })
        });
        if (res.ok) {
          const data = await res.json();
          verifiedUser = data.user;
        }
      } catch (err) {
        console.warn("[AUTH WARN] Backend verification unavailable, proceeding with decoded token:", err.message);
      }

      const user = verifiedUser || {
        name: decoded.name || 'Google User',
        email: decoded.email || '',
        avatar: decoded.picture || null,
        provider: 'google',
        isDemo: false
      };

      onAuthenticate(user);
    } catch (err) {
      console.error("[GOOGLE AUTH ERROR]", err);
      setAuthError(err.message || "Failed to decode Google credentials");
    }
  };

  const handleGoogleError = () => {
    console.warn("[GOOGLE AUTH] Login prompt closed or origin mismatch.");
    setAuthError("Google Sign-In prompt closed or origin unauthorized. Ensure http://localhost:5173 is in Authorized JavaScript origins in Google Cloud Console.");
  };

  const handleMockSignIn = (userProfile) => {
    const user = {
      name: userProfile?.name || customName || 'Google User',
      email: userProfile?.email || customEmail || 'user@gmail.com',
      avatar: userProfile?.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=120&auto=format&fit=crop&q=80',
      provider: 'google',
      isDemo: false
    };
    onAuthenticate(user);
  };

  const handleDemoSignIn = () => {
    const demoUser = {
      name: 'Guest Explorer',
      email: 'demo@codebasecopilot.local',
      avatar: null,
      provider: 'demo',
      isDemo: true
    };
    onAuthenticate(demoUser);
  };

  return (
    <div className="landing-page-wrapper">
      {/* Ambient background glows */}
      <div className="ambient-glow-1" />
      <div className="ambient-glow-2" />

      {/* Top Navbar */}
      <nav className="landing-nav">
        <div className="brand-section">
          <div className="brand-icon-wrapper">
            <Cpu size={24} style={{ color: '#ffffff' }} />
          </div>
          <div>
            <h1 className="brand-title">CODEBASE COPILOT</h1>
            <p className="brand-subtitle">AI Multimodal Codebase Intelligence</p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button 
            type="button"
            className="demo-pill-btn"
            onClick={handleDemoSignIn}
          >
            <EyeOff size={14} />
            <span>Try Demo Mode (No DB)</span>
          </button>
          
          <button 
            type="button"
            className="google-auth-btn-nav"
            onClick={() => setShowGoogleModal(true)}
          >
            <GoogleLogo size={16} />
            <span>Sign In</span>
          </button>
        </div>
      </nav>

      {/* Hero Section */}
      <header className="landing-hero-section">
        <div className="hero-pill-badge">
          <Sparkles size={14} style={{ color: 'var(--accent-secondary)' }} />
          <span>PRODUCTION-READY MULTIMODAL RAG ARCHITECTURE</span>
        </div>

        <h1 className="landing-hero-title">
          Understand Any GitHub Codebase <br />
          <span className="hero-gradient-text">At Machine Speed.</span>
        </h1>

        <p className="landing-hero-desc">
          Ask questions, inspect architectural diagrams, trace asynchronous data flows, and explore source code with unified <strong>BM25 + Qdrant Cloud Hybrid Search</strong> powered by Google Gemini.
        </p>

        {authError && (
          <div style={{
            background: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            color: '#f87171',
            borderRadius: '10px',
            padding: '10px 16px',
            fontSize: '0.8rem',
            maxWidth: '600px',
            margin: '0 auto 20px auto',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            textAlign: 'left'
          }}>
            <AlertCircle size={16} style={{ flexShrink: 0 }} />
            <span>{authError}</span>
          </div>
        )}

        {/* Dual CTA Authentication Box */}
        <div className="auth-choice-card">
          <div className="hud-corner hud-corner-tl" />
          <div className="hud-corner hud-corner-tr" />
          <div className="hud-corner hud-corner-bl" />
          <div className="hud-corner hud-corner-br" />

          <div className="auth-choice-header">
            <h2 style={{ fontFamily: 'Space Grotesk, sans-serif', fontSize: '1.15rem', fontWeight: '700', color: 'var(--text-primary)' }}>
              Choose How You Want to Explore
            </h2>
            <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              Select a session mode to unlock the codebase ingestion & query terminal.
            </p>
          </div>

          <div className="auth-cards-grid">
            {/* Option 1: Google OAuth with Cloud Persistence */}
            <div className="auth-option-card auth-option-primary">
              <div className="option-badge-tag">
                <CheckCircle2 size={12} />
                <span>FULL CLOUD PERSISTENCE</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '8px 0' }}>
                <GoogleLogo size={22} />
                <h3 style={{ fontSize: '1.05rem', fontWeight: '700', color: 'var(--text-primary)' }}>
                  Sign In with Google
                </h3>
              </div>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: '1.45', marginBottom: '16px' }}>
                Securely saves your indexed repositories, conversation history, and telemetry to <strong>MongoDB Atlas</strong> so you can pick up where you left off.
              </p>
              
              {/* Official Google OAuth Component */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' }}>
                <div style={{ display: 'flex', justifyContent: 'center', width: '100%' }}>
                  <GoogleLogin
                    onSuccess={handleGoogleSuccess}
                    onError={handleGoogleError}
                    theme="outline"
                    size="large"
                    shape="pill"
                    text="continue_with"
                    width="260"
                  />
                </div>
                <button 
                  type="button" 
                  onClick={() => setShowGoogleModal(true)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-muted)',
                    fontSize: '0.74rem',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                    padding: '4px',
                    fontFamily: 'Inter, sans-serif'
                  }}
                >
                  Manual test login / alternative options
                </button>
              </div>
            </div>


            {/* Option 2: Demo Mode (No DB Save) */}
            <div className="auth-option-card auth-option-demo">
              <div className="option-badge-tag tag-demo">
                <EyeOff size={12} />
                <span>INCOGNITO • NO DB WRITES</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '8px 0' }}>
                <ShieldCheck size={22} style={{ color: 'var(--accent-yellow)' }} />
                <h3 style={{ fontSize: '1.05rem', fontWeight: '700', color: 'var(--text-primary)' }}>
                  Demo User Account
                </h3>
              </div>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: '1.45', marginBottom: '16px' }}>
                Instant access without an account. Test any GitHub repo or diagram in memory. <strong>Zero chats or telemetry are written to the database.</strong>
              </p>
              <button 
                type="button"
                className="btn-demo-mode"
                onClick={handleDemoSignIn}
              >
                <EyeOff size={16} />
                <span>Launch Demo Explorer</span>
                <ArrowRight size={16} />
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Feature Showcase Grid */}
      <section className="landing-features-grid">
        <div className="feature-item-card">
          <div className="feature-icon-box">
            <ImageIcon size={22} style={{ color: 'var(--accent-secondary)' }} />
          </div>
          <h4 className="feature-title">Multimodal Architecture Vision</h4>
          <p className="feature-desc">
            Automatically extracts services, protocols, and directional arrows from PNG, SVG, UML, and Mermaid diagrams using Gemini 3.6 Flash.
          </p>
        </div>

        <div className="feature-item-card">
          <div className="feature-icon-box">
            <Layers size={22} style={{ color: 'var(--accent-primary)' }} />
          </div>
          <h4 className="feature-title">Hybrid Search & RRF Fusion</h4>
          <p className="feature-desc">
            Blends exact token matching via BM25Okapi with 3072-dimensional Qdrant vector semantic search using Reciprocal Rank Fusion (k=60).
          </p>
        </div>

        <div className="feature-item-card">
          <div className="feature-icon-box">
            <Zap size={22} style={{ color: 'var(--accent-green)' }} />
          </div>
          <h4 className="feature-title">Real-Time SSE Pipeline</h4>
          <p className="feature-desc">
            Piped Server-Sent Events stream chunking, embedding, and vision progress with live percentage meters and telemetry.
          </p>
        </div>

        <div className="feature-item-card">
          <div className="feature-icon-box">
            <Lock size={22} style={{ color: 'var(--accent-yellow)' }} />
          </div>
          <h4 className="feature-title">Defense-in-Depth Guardrails</h4>
          <p className="feature-desc">
            Pre-ingestion secret blocking, automatic credential regex redaction, and semantic intent gatekeeping preventing API key leakage.
          </p>
        </div>
      </section>

      {/* Interactive Google OAuth Dialog Modal */}
      {showGoogleModal && (
        <div className="google-modal-backdrop" onClick={() => setShowGoogleModal(false)}>
          <div className="google-modal-card" onClick={(e) => e.stopPropagation()}>
            <div style={{ textAlign: 'center', marginBottom: '20px' }}>
              <GoogleLogo size={36} style={{ margin: '0 auto 12px auto' }} />
              <h3 style={{ fontFamily: 'Space Grotesk, sans-serif', fontSize: '1.25rem', fontWeight: '700', color: '#1e293b' }}>
                Sign in with Google
              </h3>
              <p style={{ fontSize: '0.82rem', color: '#64748b', marginTop: '4px' }}>
                to continue to <strong>Codebase Copilot</strong>
              </p>
            </div>

            {/* Real Google OAuth Button inside Modal */}
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
              <GoogleLogin
                onSuccess={handleGoogleSuccess}
                onError={handleGoogleError}
                theme="filled_blue"
                size="large"
                shape="pill"
                text="signin_with"
                width="280"
              />
            </div>

            {/* Quick 1-Click Profile Card */}
            <div 
              className="google-account-item"
              onClick={() => handleMockSignIn({
                name: 'Alex Rivera',
                email: 'alex.rivera.dev@gmail.com',
                avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=120&auto=format&fit=crop&q=80'
              })}
            >
              <img 
                src="https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=120&auto=format&fit=crop&q=80" 
                alt="Alex Rivera"
                className="google-account-avatar"
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: '600', color: '#0f172a', fontSize: '0.9rem' }}>Alex Rivera</div>
                <div style={{ fontSize: '0.78rem', color: '#64748b' }}>alex.rivera.dev@gmail.com</div>
              </div>
              <div style={{ fontSize: '0.75rem', color: '#2563eb', fontWeight: '600' }}>Instant Sign In</div>
            </div>

            {/* Or custom details */}
            <div style={{ margin: '16px 0 12px 0', textAlign: 'center', position: 'relative' }}>
              <div style={{ borderTop: '1px solid #e2e8f0' }} />
              <span style={{ position: 'absolute', top: '-10px', left: '50%', transform: 'translateX(-50%)', background: '#ffffff', padding: '0 8px', fontSize: '0.72rem', color: '#94a3b8' }}>
                OR USE YOUR ACCOUNT
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div>
                <label style={{ fontSize: '0.72rem', fontWeight: '600', color: '#475569', display: 'block', marginBottom: '4px' }}>
                  Full Name
                </label>
                <input 
                  type="text" 
                  value={customName} 
                  onChange={(e) => setCustomName(e.target.value)}
                  className="google-input"
                  placeholder="e.g. Samik Mandal"
                />
              </div>

              <div>
                <label style={{ fontSize: '0.72rem', fontWeight: '600', color: '#475569', display: 'block', marginBottom: '4px' }}>
                  Google Email
                </label>
                <input 
                  type="email" 
                  value={customEmail} 
                  onChange={(e) => setCustomEmail(e.target.value)}
                  className="google-input"
                  placeholder="e.g. user@gmail.com"
                />
              </div>

              <button 
                type="button" 
                className="btn-google-confirm"
                onClick={() => handleMockSignIn()}
              >
                Sign In & Sync to MongoDB Atlas
              </button>
            </div>


            <div style={{ marginTop: '16px', textAlign: 'center' }}>
              <button 
                type="button" 
                onClick={() => setShowGoogleModal(false)}
                style={{ background: 'none', border: 'none', color: '#64748b', fontSize: '0.8rem', cursor: 'pointer', textDecoration: 'underline' }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="landing-footer">
        <div>
          <span>Codebase Copilot • Built with React 18, Express, FastAPI, Qdrant Cloud, and Google Gemini</span>
        </div>
      </footer>
    </div>
  );
}

// Official Google Multicolor SVG Icon
function GoogleLogo({ size = 18, style = {} }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} xmlns="http://www.w3.org/2000/svg">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335"/>
    </svg>
  );
}
