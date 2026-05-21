import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

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
