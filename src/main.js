import './style.css';
import { Header } from './components/Header.js';
import { ImageStudio } from './components/ImageStudio.js';
import { SettingsModal } from './components/SettingsModal.js';

const app = document.querySelector('#app');
let contentArea;
let activeScreen = null;
let navigationToken = 0;

function mountScreen(screen, token) {
  if (!contentArea || token !== navigationToken) {
    screen?.destroy?.();
    return;
  }

  const element = screen?.element || screen;
  if (!element) return;

  contentArea.appendChild(element);
  activeScreen = screen;
}

// Router
function navigate(page) {
  if (!contentArea) return;
  navigationToken += 1;
  const token = navigationToken;

  activeScreen?.destroy?.();
  activeScreen = null;
  contentArea.innerHTML = '';

  if (page === 'image') {
    mountScreen(ImageStudio(), token);
  } else if (page === 'video') {
    import('./components/VideoStudio.js').then(({ VideoStudio }) => {
      mountScreen(VideoStudio(), token);
    });
  } else if (page === 'cinema') {
    import('./components/CinemaStudio.js').then(({ CinemaStudio }) => {
      mountScreen(CinemaStudio(), token);
    });
  } else if (page === 'lipsync') {
    import('./components/LipSyncStudio.js').then(({ LipSyncStudio }) => {
      mountScreen(LipSyncStudio(), token);
    });
  } else if (page === 'workflows') {
    import('./components/WorkflowStudio.js').then(({ WorkflowStudio }) => {
      mountScreen(WorkflowStudio(), token);
    });
  } else if (page === 'agents') {
    import('./components/AgentStudio.js').then(({ AgentStudio }) => {
      mountScreen(AgentStudio(), token);
    });
  }
}

app.innerHTML = '';
// Pass navigate to Header so links work
app.appendChild(Header(navigate));

contentArea = document.createElement('main');
contentArea.id = 'content-area';
contentArea.className = 'flex-1 relative w-full overflow-hidden flex flex-col bg-app-bg';
app.appendChild(contentArea);

// Initial Route
navigate('image');

// Event Listener for Navigation
window.addEventListener('navigate', (e) => {
  if (e.detail.page === 'settings') {
    document.body.appendChild(SettingsModal());
  } else {
    navigate(e.detail.page);
  }
});
