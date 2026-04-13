import { Notification, app } from 'electron';
import { getGeneralWindow, showGeneralWindow } from './windows/general';
import { getSidePanelWindow } from './windows/sidepanel';
import { getSettings } from './settingsStore';

export interface TimerState {
  status: 'idle' | 'focus' | 'break' | 'paused';
  remainingSeconds: number;
  totalSeconds: number;
  completedSessions: number;
  todayFocusMinutes: number;
  pausedFrom: 'focus' | 'break' | null;
}

// ── Config ──
const FOCUS_DURATION = 25 * 60;     // 25 minutes
const SHORT_BREAK = 5 * 60;         // 5 minutes
const LONG_BREAK = 15 * 60;         // 15 minutes
const SESSIONS_BEFORE_LONG = 4;

// ── State ──
let status: TimerState['status'] = 'idle';
let remainingSeconds = 0;
let totalSeconds = 0;
let completedSessions = 0;
let todayFocusMinutes = 0;
let pausedFrom: 'focus' | 'break' | null = null;
let tickInterval: ReturnType<typeof setInterval> | null = null;
let todayDate = new Date().toDateString();

// Reset daily counter at midnight
function checkDayRollover(): void {
  const today = new Date().toDateString();
  if (today !== todayDate) {
    todayDate = today;
    todayFocusMinutes = 0;
    completedSessions = 0;
  }
}

function broadcast(): void {
  const state = getTimerState();
  const general = getGeneralWindow();
  if (general && !general.isDestroyed()) {
    general.webContents.send('timer:tick', state);
  }
  const panel = getSidePanelWindow();
  if (panel && !panel.isDestroyed()) {
    panel.webContents.send('timer:tick', state);
  }
}

function stopTick(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

function startTick(): void {
  stopTick();
  tickInterval = setInterval(() => {
    checkDayRollover();

    if (status === 'focus' || status === 'break') {
      remainingSeconds--;

      // Track focus minutes
      if (status === 'focus' && remainingSeconds % 60 === 0 && remainingSeconds < totalSeconds) {
        todayFocusMinutes++;
      }

      if (remainingSeconds <= 0) {
        if (status === 'focus') {
          // Focus period complete
          completedSessions++;
          const isLongBreak = completedSessions % SESSIONS_BEFORE_LONG === 0;
          const breakDuration = isLongBreak ? LONG_BREAK : SHORT_BREAK;

          status = 'break';
          totalSeconds = breakDuration;
          remainingSeconds = breakDuration;

          broadcast();
          notifyTimerEvent('break-start', isLongBreak);
          return;
        } else {
          // Break complete
          status = 'idle';
          remainingSeconds = 0;
          totalSeconds = 0;
          stopTick();

          broadcast();
          notifyTimerEvent('break-end', false);
          return;
        }
      }

      broadcast();
    }
  }, 1000);
}

function notifyTimerEvent(event: 'break-start' | 'break-end', isLong: boolean): void {
  const state = getTimerState();

  const general = getGeneralWindow();
  if (general && !general.isDestroyed()) {
    general.webContents.send('timer:event', { event, isLong, state });
  }
  const panel = getSidePanelWindow();
  if (panel && !panel.isDestroyed()) {
    panel.webContents.send('timer:event', { event, isLong, state });
  }

  // macOS native notification (respects user preferences)
  const { notifications } = getSettings();

  const shouldNotify =
    (event === 'break-start' && notifications.focusComplete) ||
    (event === 'break-end' && notifications.breakOver);

  if (shouldNotify) {
    try {
      let title = '';
      let body = '';
      let subtitle = '';

      if (event === 'break-start') {
        title = 'Hinty — Focus complete! 🎉';
        subtitle = isLong ? 'Great work! 4 sessions done.' : 'Nice focus session!';
        body = isLong
          ? `Take a ${LONG_BREAK / 60}-minute break. You earned it.`
          : `Time for a ${SHORT_BREAK / 60}-minute break.`;
      } else if (event === 'break-end') {
        title = 'Hinty — Break is over ⏰';
        subtitle = 'Ready for another round?';
        body = 'Click to open Hinty and start a new focus session.';
      }

      const n = new Notification({
        title,
        subtitle,
        body,
        silent: false,
      });

      n.on('click', () => {
        showGeneralWindow();
        if (process.platform === 'darwin' && app.dock) {
          app.dock.show();
        }
      });

      n.show();
      console.log(`[timer] Notification shown: ${title}`);
    } catch (err) {
      console.error('[timer] Notification failed:', err);
    }
  }
}

// ── Public API ──

export function startFocusTimer(durationMinutes?: number): void {
  checkDayRollover();
  const duration = (durationMinutes || 25) * 60;
  status = 'focus';
  totalSeconds = duration;
  remainingSeconds = duration;
  pausedFrom = null;
  startTick();
  broadcast();
  console.log(`[timer] Focus started — ${durationMinutes || 25} min`);
}

export function pauseTimer(): void {
  if (status !== 'focus' && status !== 'break') return;
  pausedFrom = status;
  status = 'paused';
  stopTick();
  broadcast();
  console.log('[timer] Paused');
}

export function resumeTimer(): void {
  if (status !== 'paused' || !pausedFrom) return;
  status = pausedFrom;
  pausedFrom = null;
  startTick();
  broadcast();
  console.log('[timer] Resumed');
}

export function endTimer(): void {
  // Count remaining focus time
  if (status === 'focus' || (status === 'paused' && pausedFrom === 'focus')) {
    const elapsed = totalSeconds - remainingSeconds;
    const elapsedMinutes = Math.floor(elapsed / 60);
    // Only add if we haven't been counting via tick
    if (remainingSeconds % 60 !== 0) {
      todayFocusMinutes += Math.ceil((elapsed % 60) / 60);
    }
  }

  status = 'idle';
  remainingSeconds = 0;
  totalSeconds = 0;
  pausedFrom = null;
  stopTick();
  broadcast();
  console.log('[timer] Ended');
}

export function skipBreak(): void {
  if (status !== 'break') return;
  status = 'idle';
  remainingSeconds = 0;
  totalSeconds = 0;
  stopTick();
  broadcast();
  console.log('[timer] Break skipped');
}

export function getTimerState(): TimerState {
  checkDayRollover();
  return {
    status,
    remainingSeconds,
    totalSeconds,
    completedSessions,
    todayFocusMinutes,
    pausedFrom,
  };
}
