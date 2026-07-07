import React from 'react';
import ReactDOM from 'react-dom/client';
import { TenantApp } from './App';
import { Admin } from './Admin';
import './styles.css';

function Root() {
  const seg = window.location.pathname.split('/').filter(Boolean);
  if (seg.length === 0) return <Admin />;
  return <TenantApp slug={seg[0]} />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
