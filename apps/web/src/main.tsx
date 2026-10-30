import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, createRoutesFromElements, RouterProvider } from 'react-router';
import { AppRoutes } from './app/app';
import { AppErrorBoundary } from './app/error-boundary';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('Application root is missing.');
const router = createBrowserRouter(createRoutesFromElements(AppRoutes()));
createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <RouterProvider router={router} />
    </AppErrorBoundary>
  </StrictMode>,
);
