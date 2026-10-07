import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installChunkReload } from './lib/chunkReload';
import './index.css';

// A tab left open across a release reloads itself onto the new build
// instead of failing to load a tab's code.
installChunkReload();

const root = document.getElementById('app');
if (!root) {
  throw new Error(
    "vantage-dashboard: missing #app mount node in index.html — cannot bootstrap React. Check the host page template.",
  );
}
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
