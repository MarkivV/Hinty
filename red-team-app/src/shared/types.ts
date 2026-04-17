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
  tier: 'free' | 'pro' | 'max';
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

// ── Meeting ──

export interface MeetingDocument {
  id: string;
  fileName: string;
  fileType: 'pdf' | 'docx' | 'xlsx' | 'txt' | 'md';
  extractedText: string;
  uploadedAt: number;
}

export interface TranscriptEntry {
  id: string;
  meetingId: string;
  timestamp: number;       // seconds from meeting start
  speaker: string;         // 'you' | 'speaker_1' | 'speaker_2' ...
  text: string;
  channel: 0 | 1;          // 0 = system audio (others), 1 = mic (you)
}

export interface MeetingActionItem {
  id: string;
  task: string;
  owner: string;           // 'you' | 'them' | speaker label
  done: boolean;
}

export interface MeetingSuggestion {
  id: string;
  meetingId: string;
  timestamp: number;
  type: 'suggestion' | 'action_item' | 'warning';
  content: string;
}

export interface MeetingSummary {
  overview: string;
  keyDecisions: string[];
  actionItems: MeetingActionItem[];
  followUps: string[];
}

export interface MeetingSession {
  id: string;
  userId: string;
  title: string;
  context: string;
  startedAt: number;
  endedAt: number | null;
  duration: number;
  status: 'prep' | 'recording' | 'ended';
  documents: MeetingDocument[];
  transcript: TranscriptEntry[];
  suggestions: MeetingSuggestion[];
  summary: MeetingSummary | null;
}

// ── App State ──

export type AppMode = 'idle' | 'session' | 'meeting';

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

  // AI control
  AI_STOP: 'ai:stop',
  AI_STATE: 'ai:state',  // 'idle' | 'thinking' | 'streaming'

  // Meeting Copilot
  MEETING_START_PREP: 'meeting:start-prep',
  MEETING_START_RECORDING: 'meeting:start-recording',
  MEETING_STOP: 'meeting:stop',
  MEETING_UPLOAD_DOC: 'meeting:upload-doc',
  MEETING_REMOVE_DOC: 'meeting:remove-doc',
  MEETING_SET_CONTEXT: 'meeting:set-context',
  MEETING_TRANSCRIPT_UPDATE: 'meeting:transcript-update',
  MEETING_SUGGESTION: 'meeting:suggestion',
  MEETING_ACTION_ITEM: 'meeting:action-item',
  MEETING_STATE: 'meeting:state',
  MEETING_SUMMARY: 'meeting:summary',
  MEETING_ERROR: 'meeting:error',

  // Meeting history
  MEETING_HISTORY_LIST_REQ: 'meeting:history-list-req',
  MEETING_HISTORY_LIST_RES: 'meeting:history-list-res',
  MEETING_HISTORY_DETAIL_REQ: 'meeting:history-detail-req',
  MEETING_HISTORY_DETAIL_RES: 'meeting:history-detail-res',
  MEETING_HISTORY_DELETE: 'meeting:history-delete',
  MEETING_HISTORY_RENAME: 'meeting:history-rename',
} as const;
