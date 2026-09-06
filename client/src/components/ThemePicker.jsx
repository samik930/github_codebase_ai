import React from 'react';
import { Sun, Flower, Leaf, Flame } from 'lucide-react';

const THEMES = [
  { id: 'sapphire', label: 'SAPPHIRE', icon: Sun, color: '#2563eb' },
  { id: 'pastel', label: 'PASTEL', icon: Flower, color: '#d946ef' },
  { id: 'emerald', label: 'EMERALD', icon: Leaf, color: '#059669' },
  { id: 'sunset', label: 'SUNSET', icon: Flame, color: '#ea580c' },
];

export function ThemePicker({ currentTheme, onSelectTheme }) {
  return (
    <div className="theme-picker-container" title="Select Color Spectrum">
      {THEMES.map((theme) => {
        const IconComponent = theme.icon;
        const isActive = currentTheme === theme.id;
        return (
          <button
            key={theme.id}
            className={`theme-btn ${isActive ? 'active' : ''}`}
            onClick={() => onSelectTheme(theme.id)}
            type="button"
          >
            <IconComponent size={13} style={{ color: isActive ? 'var(--accent-primary)' : theme.color }} />
            <span>{theme.label}</span>
          </button>
        );
      })}
    </div>
  );
}
