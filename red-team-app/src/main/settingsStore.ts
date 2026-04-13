import Store from 'electron-store';
import { AppSettings, DisplayMode, CaptureMode, PromptTemplate } from '../shared/types';

// Admin-controlled AI model — not user-configurable
export const AI_MODEL = 'gpt-5.1';

const DEFAULT_TEMPLATES: PromptTemplate[] = [
  {
    id: 'tpl-general',
    name: 'General',
    isDefault: true,
    buttons: [
      { id: 'btn-explain', icon: '✎', label: 'Explain', prompt: 'Explain the correct answer(s) for the questions shown on screen. Why is each answer correct?' },
      { id: 'btn-hint', icon: '◈', label: 'Hint', prompt: 'Give me a hint for each question on screen without revealing the full answer.' },
      { id: 'btn-simplify', icon: '◇', label: 'Simplify', prompt: 'Explain the answer(s) in the simplest possible terms.' },
      { id: 'btn-example', icon: '↻', label: 'Example', prompt: 'Give a real-world example that illustrates the correct answer(s).' },
    ],
  },
  {
    id: 'tpl-coding',
    name: 'Coding',
    isDefault: true,
    buttons: [
      { id: 'btn-debug', icon: '🐛', label: 'Debug', prompt: 'Find bugs in the code shown on screen and explain how to fix each one.' },
      { id: 'btn-optimize', icon: '⚡', label: 'Optimize', prompt: 'Suggest performance improvements and cleaner approaches for the code on screen.' },
      { id: 'btn-explain-code', icon: '📖', label: 'Explain', prompt: 'Explain what the code on screen does, step by step.' },
      { id: 'btn-tests', icon: '🧪', label: 'Tests', prompt: 'Write unit tests for the code shown on screen.' },
    ],
  },
  {
    id: 'tpl-essay',
    name: 'Writing',
    isDefault: true,
    buttons: [
      { id: 'btn-outline', icon: '📋', label: 'Outline', prompt: 'Create a structured outline for the essay or writing assignment shown on screen.' },
      { id: 'btn-strengthen', icon: '💪', label: 'Strengthen', prompt: 'Suggest ways to strengthen the argument or thesis shown on screen.' },
      { id: 'btn-grammar', icon: '✓', label: 'Grammar', prompt: 'Check the text on screen for grammar, spelling, and style issues. Suggest corrections.' },
      { id: 'btn-cite', icon: '📎', label: 'Citations', prompt: 'Suggest relevant sources and help format citations for the topic shown on screen.' },
    ],
  },
];

const DEFAULT_SETTINGS: AppSettings = {
  apiKey: '',
  displayMode: DisplayMode.SidePanel,
  captureMode: CaptureMode.AlwaysVision,
  ocrConfidenceThreshold: 70,
  autoHideTimeoutMs: 5000,
  aiModel: 'gpt-5.1',
  contentProtection: true,
  theme: 'dark',
  hotkeys: {
    trigger: process.platform === 'darwin' ? 'CommandOrControl+Shift+Space' : 'Ctrl+Shift+Space',
    emergencyHide: process.platform === 'darwin' ? 'CommandOrControl+Shift+H' : 'Ctrl+Shift+H',
    modeCycle: '',
  },
  knowledgeBaseFiles: [],
  promptTemplates: DEFAULT_TEMPLATES,
  activeTemplateId: 'tpl-general',
  notifications: {
    focusComplete: true,
    breakOver: true,
  },
};

const store = new Store<{ settings: AppSettings }>({
  name: 'settings',
  encryptionKey: 'red-team-research-app-v1',
  defaults: {
    settings: DEFAULT_SETTINGS,
  },
});

export function getSettings(): AppSettings {
  const s = store.get('settings');
  // Force side panel mode and always vision (overlay removed)
  s.displayMode = DisplayMode.SidePanel;
  s.captureMode = CaptureMode.AlwaysVision;
  // Migrate: add default templates if missing (existing users upgrading)
  if (!s.promptTemplates || s.promptTemplates.length === 0) {
    s.promptTemplates = DEFAULT_TEMPLATES;
    s.activeTemplateId = 'tpl-general';
  }
  // Migrate: add notification preferences if missing
  if (!s.notifications) {
    s.notifications = { focusComplete: true, breakOver: true };
  }
  // Migrate: add theme if missing
  if (!s.theme) {
    s.theme = 'dark';
  }
  store.set('settings', s);
  return s;
}

export function updateSettings(partial: Partial<AppSettings>): AppSettings {
  const current = store.get('settings');
  const updated = { ...current, ...partial };
  // Enforce side panel only
  updated.displayMode = DisplayMode.SidePanel;
  updated.captureMode = CaptureMode.AlwaysVision;
  store.set('settings', updated);
  return updated;
}

export function resetSettings(): AppSettings {
  store.set('settings', DEFAULT_SETTINGS);
  return DEFAULT_SETTINGS;
}
