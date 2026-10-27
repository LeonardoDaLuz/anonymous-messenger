import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';
import { watchForUpdates } from './updater.js';
import './styles.css';

createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  });
}

watchForUpdates();
