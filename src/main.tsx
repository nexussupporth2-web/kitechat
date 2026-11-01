import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { applyTheme, currentTheme } from './theme.ts';
import { initPrefs } from './prefs.ts';

applyTheme(currentTheme());
void initPrefs();

createRoot(document.getElementById('root')!).render(<App />);
