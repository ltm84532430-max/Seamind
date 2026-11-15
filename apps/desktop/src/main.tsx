import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './ebook/ebook-shelf-layout.css';
import './knowledge/knowledge-surface.css';
import './themes-extended.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
