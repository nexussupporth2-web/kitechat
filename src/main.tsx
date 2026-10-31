import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { applyTheme, currentTheme } from './theme.ts';

applyTheme(currentTheme());

createRoot(document.getElementById('root')!).render(<App />);
