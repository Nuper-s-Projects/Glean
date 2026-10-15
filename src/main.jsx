import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App';
import { startPwa } from './app/pwa';
import { limitAnimationFramesWhileIdle, pageActivity, subscribePageActivity } from './app/pageActivity';
import { applyHardwareAcceleration } from './app/hardwareAcceleration';
import './styles/global.css';
import './styles/mainThemes.css';
import './styles/hardwareAcceleration.css';

applyHardwareAcceleration();
startPwa();

const updateActivity = () => { document.documentElement.dataset.gleanActivity = pageActivity(); };
updateActivity();
const stopActivity = subscribePageActivity(updateActivity);
const stopIdleFrameLimiter = limitAnimationFramesWhileIdle();
if (import.meta.hot) import.meta.hot.dispose(() => { stopActivity(); stopIdleFrameLimiter(); });

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
