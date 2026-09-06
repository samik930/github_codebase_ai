import React, { useState, useEffect } from 'react';
import {
  Star, GitFork, GitBranch, Users, Code2,
  Activity, ExternalLink, RefreshCw, Eye
} from 'lucide-react';

const LANGUAGE_COLORS = {
  JavaScript: '#f7df1e',
  TypeScript: '#3178c6',
  Python: '#3776ab',
  Java: '#b07219',
  Go: '#00add8',
  Rust: '#dea584',
  C: '#555555',
  'C++': '#f34b7d',
  'C#': '#178600',
  Ruby: '#701516',
  PHP: '#4f5d95',
  Swift: '#fa7343',
  Kotlin: '#7f52ff',
  Shell: '#89e051',
  HTML: '#e34c26',
  CSS: '#563d7c',
  SCSS: '#c6538c',
  Vue: '#41b883',
  Markdown: '#083fa1',
  Dockerfile: '#384d54',
};

function getLanguageColor(lang) {
  return LANGUAGE_COLORS[lang] || '#6b7280';
}

function formatCount(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function StatPill({ icon: Icon, label, value, color }) {
  return (
    <div className="stat-pill">
      <div className="stat-pill-icon" style={{ color: color || 'var(--accent-primary)' }}>
        <Icon size={16} />
      </div>
      <div className="stat-pill-body">
        <span className="stat-pill-value">{value}</span>
        <span className="stat-pill-label">{label}</span>
      </div>
    </div>
  );
}

export function RepoStats({ activeRepo }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!activeRepo?.repository) return;
    fetchStats(activeRepo.repository);
  }, [activeRepo?.repository]);

  const fetchStats = async (repoPath) => {
    setLoading(true);
    setError(null);
    setStats(null);

    try {
      const headers = { Accept: 'application/vnd.github+json' };
      const base = `https://api.github.com/repos/${repoPath}`;

      const [repoRes, langRes, contribRes, branchRes] = await Promise.all([
        fetch(base, { headers }),
        fetch(`${base}/languages`, { headers }),
        fetch(`${base}/contributors?per_page=6&anon=true`, { headers }),
        fetch(`${base}/branches?per_page=100`, { headers }),
      ]);

      const repoData = repoRes.ok ? await repoRes.json() : null;
      const langData = langRes.ok ? await langRes.json() : {};
      const contribData = contribRes.ok ? await contribRes.json() : [];
      const branchData = branchRes.ok ? await branchRes.json() : [];

      // Calculate language percentages
      const totalBytes = Object.values(langData).reduce((a, b) => a + b, 0);
      const languages = Object.entries(langData)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 8)
        .map(([name, bytes]) => ({
          name,
          percent: totalBytes > 0 ? ((bytes / totalBytes) * 100).toFixed(1) : 0,
          color: getLanguageColor(name),
        }));

      setStats({
        stars: repoData?.stargazers_count ?? 0,
        forks: repoData?.forks_count ?? 0,
        watchers: repoData?.watchers_count ?? 0,
        openIssues: repoData?.open_issues_count ?? 0,
        branchCount: branchData.length || 1,
        description: repoData?.description || null,
        homepage: repoData?.homepage || null,
        htmlUrl: repoData?.html_url || `https://github.com/${repoPath}`,
        contributors: Array.isArray(contribData) ? contribData.slice(0, 6) : [],
        contributorCount: Array.isArray(contribData) ? contribData.length : 0,
        languages,
        updatedAt: repoData?.updated_at,
      });
    } catch {
      setError('Could not fetch repository stats from GitHub API.');
    } finally {
      setLoading(false);
    }
  };

  if (!activeRepo) return null;

  return (
    <div className="glass-card repo-stats-card">
      <div className="hud-corner hud-corner-tl" />
      <div className="hud-corner hud-corner-tr" />
      <div className="hud-corner hud-corner-bl" />
      <div className="hud-corner hud-corner-br" />

      {/* Header */}
      <div className="section-title-bar" style={{ marginBottom: '20px' }}>
        <div className="section-title">
          <Activity size={20} style={{ color: 'var(--accent-primary)' }} />
          <span>REPOSITORY OVERVIEW</span>
          <a
            href={`https://github.com/${activeRepo.repository}`}
            target="_blank"
            rel="noopener noreferrer"
            className="title-badge"
            style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '4px' }}
          >
            {activeRepo.repository}
            <ExternalLink size={11} />
          </a>
        </div>
        <button
          onClick={() => fetchStats(activeRepo.repository)}
          className="hud-pill"
          style={{ cursor: 'pointer', background: 'transparent' }}
          disabled={loading}
          title="Refresh stats"
        >
          <RefreshCw size={13} className={loading ? 'spinner' : ''} />
          <span>REFRESH</span>
        </button>
      </div>

      {loading && (
        <div style={{ textAlign: 'center', padding: '32px', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.85rem' }}>
          Loading repository stats from GitHub...
        </div>
      )}

      {error && (
        <div style={{ textAlign: 'center', padding: '20px', color: '#dc2626', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.82rem' }}>
          {error}
        </div>
      )}

      {stats && !loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>

          {/* Description */}
          {stats.description && (
            <p style={{ fontSize: '0.92rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              {stats.description}
            </p>
          )}

          {/* Stat Pills Row */}
          <div className="repo-stat-pills">
            <StatPill icon={Star} label="Stars" value={formatCount(stats.stars)} color="#d97706" />
            <StatPill icon={GitFork} label="Forks" value={formatCount(stats.forks)} color="var(--accent-secondary)" />
            <StatPill icon={Eye} label="Watchers" value={formatCount(stats.watchers)} color="var(--accent-tertiary)" />
            <StatPill icon={GitBranch} label="Branches" value={stats.branchCount} color="var(--accent-primary)" />
            <StatPill icon={Users} label="Contributors" value={stats.contributorCount} color="var(--accent-green)" />
            <StatPill icon={Activity} label="Open Issues" value={stats.openIssues} color="#e11d48" />
          </div>

          {/* Language Bar */}
          {stats.languages.length > 0 && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                <Code2 size={16} style={{ color: 'var(--accent-primary)' }} />
                <span style={{ fontFamily: 'Space Grotesk, sans-serif', fontWeight: '700', fontSize: '0.88rem', color: 'var(--text-primary)' }}>
                  LANGUAGES USED
                </span>
              </div>

              {/* Stacked bar */}
              <div className="lang-bar">
                {stats.languages.map((lang) => (
                  <div
                    key={lang.name}
                    className="lang-bar-segment"
                    style={{ width: `${lang.percent}%`, background: lang.color }}
                    title={`${lang.name}: ${lang.percent}%`}
                  />
                ))}
              </div>

              {/* Legend */}
              <div className="lang-legend">
                {stats.languages.map((lang) => (
                  <div key={lang.name} className="lang-legend-item">
                    <span className="lang-legend-dot" style={{ background: lang.color }} />
                    <span className="lang-legend-name">{lang.name}</span>
                    <span className="lang-legend-pct">{lang.percent}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Contributors Avatars */}
          {stats.contributors.length > 0 && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                <Users size={16} style={{ color: 'var(--accent-primary)' }} />
                <span style={{ fontFamily: 'Space Grotesk, sans-serif', fontWeight: '700', fontSize: '0.88rem', color: 'var(--text-primary)' }}>
                  TOP CONTRIBUTORS
                </span>
              </div>
              <div className="contributors-row">
                {stats.contributors.map((c) => (
                  <a
                    key={c.id || c.login}
                    href={c.html_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="contributor-chip"
                    title={`${c.login} — ${formatCount(c.contributions)} commits`}
                  >
                    <img
                      src={c.avatar_url}
                      alt={c.login}
                      className="contributor-avatar"
                    />
                    <div className="contributor-info">
                      <span className="contributor-name">{c.login}</span>
                      <span className="contributor-commits">{formatCount(c.contributions)} commits</span>
                    </div>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Updated at */}
          {stats.updatedAt && (
            <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
              LAST UPDATED: {new Date(stats.updatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
