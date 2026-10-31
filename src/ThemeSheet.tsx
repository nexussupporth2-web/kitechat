import { useState } from 'react';
import { Check } from 'lucide-react';
import { THEMES, applyTheme, currentTheme } from './theme.ts';

/** Pop-up with the six pastel colour themes. Purple is the original look. */
export default function ThemeSheet({ onClose }: { onClose: () => void }) {
  const [theme, setTheme] = useState(currentTheme);
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-t-3xl sm:rounded-3xl p-5 pb-8" onClick={e => e.stopPropagation()}>
        <div className="w-10 h-1 rounded-full bg-slate-700 mx-auto mb-4" />
        <h3 className="text-base font-bold text-white">Colour theme</h3>
        <div className="mt-4 grid grid-cols-3 gap-3">
          {THEMES.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                applyTheme(t.id);
                setTheme(t.id);
              }}
              aria-pressed={theme === t.id}
              className={`rounded-2xl border p-2.5 flex flex-col items-center gap-2 ${theme === t.id ? 'border-cyan-500 bg-cyan-500/10' : 'border-slate-800 hover:bg-slate-800'}`}
            >
              <span className="relative w-12 h-12 rounded-full border border-white/20" style={{ background: `linear-gradient(135deg, ${t.bg} 50%, ${t.accent} 50%)` }}>
                {theme === t.id && (
                  <span className="absolute inset-0 flex items-center justify-center">
                    <Check className="w-5 h-5 text-fixed-white drop-shadow" />
                  </span>
                )}
              </span>
              <span className="text-xs text-slate-200">{t.name}</span>
            </button>
          ))}
        </div>
        <p className="mt-4 text-[11px] text-slate-500">Saved on this phone. Light or dark still follows your phone setting.</p>
        <button onClick={onClose} className="mt-4 w-full py-3 rounded-xl bg-slate-800 text-white text-sm font-medium">Done</button>
      </div>
    </div>
  );
}
