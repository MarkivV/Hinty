import { globalShortcut } from 'electron';
import { getSidePanelWindow } from './windows/sidepanel';
import { IPC_CHANNELS } from '../shared/types';
import { getSettings } from './settingsStore';
import { sendMessage, getIsProcessing } from './session';
import { getAppMode } from './appState';

export function fireTrigger() {
  if (getAppMode() !== 'session') return;

  if (getIsProcessing()) {
    console.log('[hotkeys] Already processing, ignoring');
    return;
  }

  const panel = getSidePanelWindow();
  if (panel && !panel.isDestroyed()) {
    panel.webContents.send(IPC_CHANNELS.SESSION_TRIGGER_MSG, 'Analyze all questions visible on screen and provide the correct answers.');
  }

  console.log('[hotkeys] Trigger fired');
  sendMessage('Analyze all questions visible on screen and provide the correct answers.', true);
}

let isHidden = false;

function toggleVisibility() {
  if (getAppMode() !== 'session') return;

  const panel = getSidePanelWindow();

  if (isHidden) {
    console.log('[hotkeys] Show session windows');
    if (panel && !panel.isDestroyed()) panel.show();
    isHidden = false;
  } else {
    console.log('[hotkeys] Hide session windows');
    if (panel && !panel.isDestroyed()) panel.hide();
    isHidden = true;
  }
}

export function registerHotkeys() {
  const settings = getSettings();
  const { trigger, emergencyHide: hideKey } = settings.hotkeys;

  const registered = {
    trigger: globalShortcut.register(trigger, fireTrigger),
    hide: globalShortcut.register(hideKey, toggleVisibility),
  };

  isHidden = false;

  console.log('[hotkeys] Registered:', {
    trigger: registered.trigger ? trigger : 'FAILED',
    hide: registered.hide ? hideKey : 'FAILED',
  });
}

export function unregisterHotkeys() {
  globalShortcut.unregisterAll();
  isHidden = false;
}
