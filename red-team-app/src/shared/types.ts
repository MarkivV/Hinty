// ── Enums ──

export enum QuestionType {
  MultipleChoice = 'multiple_choice',
  TrueFalse = 'true_false',
  Open = 'open',
  Unknown = 'unknown',
}

export enum DisplayMode {
  SidePanel = 'side_panel',
}

// ── OCR ──

export interface OcrWord {
  text: string;
  bbox: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  };
  confidence: number;
}

export interface OcrResult {
  fullText: string;
  words: OcrWord[];
  averageConfidence: number;
}

// ── Capture ──

export interface CaptureResult {
  sessionId: string;
  pageHash: string;
  timestamp: number;
  screenshot: Buffer;
  ocr: OcrResult;
  audioTranscript: string;
  clipboardContent: string;
}

// ── AI ──

export interface AiAnswer {
  questionIndex: number;
  questionType: QuestionType;
  questionText: string;
  answerText: string;
  anchorText?: string;
  anchorBbox?: OcrWord['bbox'];
}

export interface AiResponse {
  sessionId: string;
  answers: AiAnswer[];
  rawResponse: string;
}

// ── Session ──

export interface SessionMeta {
  sessionId: string;
  pageHash: string;
  timestamp: number;
  displayMode: DisplayMode;
}

// ── Auth ──

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface UserProfile {
  id: number;
  email: string;
  tier: 'free' | 'pro';
}

export interface AuthState {
  authenticated: boolean;
  user: UserProfile | null;
}

// ── Prompt Templates ──

export interface PromptButton {
  id: string;
  icon: string;   // emoji or symbol character
  label: string;   // button label, e.g. "Debug"
  prompt: string;  // full prompt text sent to AI
}

export interface PromptTemplate {
  id: string;
  name: string;
  buttons: PromptButton[];
  isDefault?: boolean;
}

// ── Settings ──

export enum CaptureMode {
  AlwaysVision = 'always_vision',
}

export type ThemeMode = 'system' | 'light' | 'dark';

export interface AppSettings {
  apiKey: string;
  displayMode: DisplayMode;
  captureMode: CaptureMode;
  ocrConfidenceThreshold: number;
  autoHideTimeoutMs: number;
  aiModel: string;
  contentProtection: boolean;
  theme: ThemeMode;
  hotkeys: {
    trigger: string;
    emergencyHide: string;
    modeCycle: string;
  };
  knowledgeBaseFiles: string[];
  promptTemplates: PromptTemplate[];
  activeTemplateId: string;
  notifications: {
    focusComplete: boolean;
    breakOver: boolean;
  };
}

// ── App State ──

export type AppMode = 'idle' | 'session';

// ── IPC Channels ──

export const IPC_CHANNELS = {
  // Capture
  TRIGGER_CAPTURE: 'trigger:capture',
  CAPTURE_RESULT: 'capture:result',

  // AI
  AI_STREAM_TOKEN: 'ai:stream-token',
  AI_RESPONSE_COMPLETE: 'ai:response-complete',
  AI_ERROR: 'ai:error',

  // Side panel
  SIDEPANEL_SHOW: 'sidepanel:show',
  SIDEPANEL_HIDE: 'sidepanel:hide',
  SIDEPANEL_STREAM_TOKEN: 'sidepanel:stream-token',
  SIDEPANEL_CHAT_SEND: 'sidepanel:chat-send',
  SIDEPANEL_CHAT_RESPONSE: 'sidepanel:chat-response',
  SIDEPANEL_REPLACE_AI: 'sidepanel:replace-ai-content',

  // Session lifecycle
  SESSION_START: 'session:start',
  SESSION_END: 'session:end',
  SESSION_ENDED: 'session:ended',
  SESSION_NEW: 'session:new',
  SESSION_CLEARED: 'session:cleared',
  SESSION_SCREENSHOT: 'session:screenshot',
  SESSION_TRIGGER_MSG: 'session:trigger-message',
  SESSION_TRIGGER_ASSIST: 'session:trigger-assist',
  SESSION_CONTINUE: 'session:continue',
  SESSION_RESTORE_MESSAGES: 'session:restore-messages',

  // Auth
  AUTH_LOGIN: 'auth:login',
  AUTH_REGISTER: 'auth:register',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_STATUS: 'auth:status',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',
  SETTINGS_UPLOAD_FILE: 'settings:upload-file',
  SETTINGS_REMOVE_FILE: 'settings:remove-file',
  SETTINGS_FILES_UPDATED: 'settings:files-updated',

  // Notifications
  NOTIFY_PAGE_CHANGED: 'notify:page-changed',
} as const;
