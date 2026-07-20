import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/index.css';

const CollaborationWorkspace = lazy(() => import('./components/CollaborationWorkspace'));

const rootView = window.location.pathname.startsWith('/collab')
  ? <Suspense fallback={<div className="grid h-screen place-items-center">正在加载协作画布…</div>}><CollaborationWorkspace /></Suspense>
  : <App />;

const app = import.meta.env.DEV && import.meta.env.VITE_T8_STRICT_MODE !== '1'
  ? rootView
  : (
    <StrictMode>
      {rootView}
    </StrictMode>
  );

createRoot(document.getElementById('root')!).render(app);
