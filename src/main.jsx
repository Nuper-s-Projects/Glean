import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App';
import { startPwa } from './app/pwa';
import './styles/global.css';
import './styles/mainThemes.css';

startPwa();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
