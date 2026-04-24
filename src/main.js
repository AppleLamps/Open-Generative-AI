import './style.css';
import { Header } from './components/Header.js';
import { ImageStudio } from './components/ImageStudio.js';
import { SettingsModal } from './components/SettingsModal.js';
import { showToast } from './lib/toast.js';

const app = document.querySelector('#app');
let contentArea;
let activeScreen = null;
let navigationToken = 0;

const PAGE_LABELS = {
  image: 'Image Studio',
  video: 'Video Studio',
  cinema: 'Cinema Studio',
  lipsync: 'Lip Sync',
  workflows: 'Workflows',
  agents: 'Agents',
};

function createRouteState({ title, message, actionLabel, onAction }) {
  const state = document.createElement('div');
  state.className = 'w-full h-full flex items-center justify-center bg-app-bg p-6';

  const panel = document.createElement('div');
  panel.className = 'flex flex-col items-center text-center gap-3 max-w-sm';

  const spinner = document.createElement('div');
  spinner.className = actionLabel ? 'hidden' : 'w-8 h-8 rounded-full border-2 border-white/10 border-t-primary animate-spin';

  const heading = document.createElement('h2');
  heading.className = 'text-sm font-black text-white uppercase tracking-wider';
  heading.textContent = title;

  const copy = document.createElement('p');
  copy.className = 'text-xs text-muted leading-relaxed';
  copy.textContent = message;

  panel.appendChild(spinner);
  panel.appendChild(heading);
  panel.appendChild(copy);

  if (actionLabel && onAction) {
    const action = document.createElement('button');
    action.className = 'mt-2 px-4 py-2 rounded-xl bg-primary text-black text-xs font-black hover:shadow-glow transition-all';
    action.textContent = actionLabel;
    action.onclick = onAction;
    panel.appendChild(action);
  }

  state.appendChild(panel);
  return state;
}

function showRouteLoading(page, token) {
  if (!contentArea || token !== navigationToken) return;
  contentArea.innerHTML = '';
  contentArea.appendChild(createRouteState({
    title: `Loading ${PAGE_LABELS[page] || 'Studio'}`,
    message: 'Preparing the tools for this workspace...',
  }));
}

function showRouteError(page, err, token) {
  if (!contentArea || token !== navigationToken) return;
  console.error(`[router] Failed to load ${page}:`, err);
  contentArea.innerHTML = '';
  contentArea.appendChild(createRouteState({
    title: `${PAGE_LABELS[page] || 'Studio'} did not load`,
    message: 'The module failed to load. You can try again without restarting the app.',
    actionLabel: 'Retry',
    onAction: () => navigate(page),
  }));
  showToast(`Could not load ${PAGE_LABELS[page] || page}.`, { type: 'error', duration: 5000 });
}

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
    showRouteLoading(page, token);
    import('./components/VideoStudio.js').then(({ VideoStudio }) => {
      mountScreen(VideoStudio(), token);
    }).catch((err) => showRouteError(page, err, token));
  } else if (page === 'cinema') {
    showRouteLoading(page, token);
    import('./components/CinemaStudio.js').then(({ CinemaStudio }) => {
      mountScreen(CinemaStudio(), token);
    }).catch((err) => showRouteError(page, err, token));
  } else if (page === 'lipsync') {
    showRouteLoading(page, token);
    import('./components/LipSyncStudio.js').then(({ LipSyncStudio }) => {
      mountScreen(LipSyncStudio(), token);
    }).catch((err) => showRouteError(page, err, token));
  } else if (page === 'workflows') {
    showRouteLoading(page, token);
    import('./components/WorkflowStudio.js').then(({ WorkflowStudio }) => {
      mountScreen(WorkflowStudio(), token);
    }).catch((err) => showRouteError(page, err, token));
  } else if (page === 'agents') {
    showRouteLoading(page, token);
    import('./components/AgentStudio.js').then(({ AgentStudio }) => {
      mountScreen(AgentStudio(), token);
    }).catch((err) => showRouteError(page, err, token));
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
