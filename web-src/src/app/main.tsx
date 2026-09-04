import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/app/App';
import { installKeyboardModalityTracker } from '@/common/lib/keyboardModality';
import '@/styles.css';

installKeyboardModalityTracker();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
