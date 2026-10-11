import React, { Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles.css';

// vokko-chat stub: `?playground` mounts the chat fixture instead of the legacy app. Dropped at milestone A merge.
const Playground = React.lazy(() => import('./chat/Playground'));
const playground = new URLSearchParams(window.location.search).has('playground');

const root = document.getElementById('root');
if (root) ReactDOM.createRoot(root).render(<React.StrictMode>{playground ? <Suspense fallback={null}><Playground /></Suspense> : <App />}</React.StrictMode>);
