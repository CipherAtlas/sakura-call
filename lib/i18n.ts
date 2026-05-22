export const supportedLanguages = ["en", "ja"] as const;

export type Language = (typeof supportedLanguages)[number];

export const languageLabel = (language: Language) =>
  language === "en" ? "English" : "日本語";

export function isSupportedLanguage(value: unknown): value is Language {
  return value === "en" || value === "ja";
}

export function oppositeLanguage(language: Language): Language {
  return language === "en" ? "ja" : "en";
}

const storageKey = "jec.language";
const displayNameStorageKey = "jec.displayName";

export function getSavedLanguage(): Language | null {
  if (typeof window === "undefined") {
    return null;
  }

  const value = window.localStorage.getItem(storageKey);
  return isSupportedLanguage(value) ? value : null;
}

export function saveLanguage(language: Language) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(storageKey, language);
  }
}

export function clearSavedLanguage() {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(storageKey);
  }
}

export function normalizeDisplayName(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, 32);
}

export function getSavedDisplayName(): string {
  if (typeof window === "undefined") {
    return "";
  }

  return normalizeDisplayName(
    window.localStorage.getItem(displayNameStorageKey) ?? ""
  );
}

export function saveDisplayName(displayName: string) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(
      displayNameStorageKey,
      normalizeDisplayName(displayName)
    );
  }
}

export function clearSavedDisplayName() {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(displayNameStorageKey);
  }
}

const strings = {
  en: {
    appName: "Sakura Call",
    homeTitle: "Start a private call",
    homeFootnote: "Two people only. English and Japanese only.",
    createRoom: "Create Room",
    creatingRoom: "Creating room...",
    createRoomFailed: "Could not create room",
    hostAccessRequired: "Host access required",
    hostAccess: "Host access",
    hostPasscode: "Host passcode",
    unlockHostMode: "Unlock host mode",
    unlockingHostMode: "Unlocking...",
    hostModeEnabled: "Host mode enabled",
    hostAccessDenied: "Host access denied",
    hostAccessNotConfigured: "Host access is not configured",
    joinWithCode: "Join with 4-digit code",
    roomCodePlaceholder: "0000",
    joinRoom: "Join Room",
    joiningRoom: "Joining...",
    settings: "Settings",
    changeLanguage: "Change language",
    back: "Back",
    setUsernameTitle: "Set your name",
    setUsernameHelp: "This is how you will appear in the call.",
    usernameLabel: "Your name",
    usernamePlaceholder: "Enter your name",
    continue: "Continue",
    english: "English",
    japanese: "Japanese",
    joinCall: "Join Call",
    permissionsTitle: "Microphone",
    permissionsHelp: "Allow your microphone before joining.",
    allowPermissions: "Allow microphone",
    permissionsReady: "Microphone is ready",
    preparingPermissions: "Opening permissions...",
    mediaStartOptions: "Start options",
    startMuted: "Start muted",
    startUnmuted: "Start unmuted",
    startCameraOn: "Start camera on",
    startCameraOff: "Start camera off",
    waitingForOther: "Waiting for other person...",
    connected: "Connected",
    connecting: "Connecting...",
    reconnecting: "Reconnecting...",
    disconnected: "Disconnected",
    mute: "Mute",
    unmute: "Unmute",
    cameraOn: "Camera On",
    cameraOff: "Camera Off",
    leaveCall: "Leave Call",
    copyRoomCode: "Copy Room Code",
    copied: "Copied",
    microphonePermissionDenied: "Microphone permission denied",
    cameraPermissionDenied: "Camera permission denied",
    thirdParticipantBlocked: "Third participant blocked",
    invalidCode: "Invalid code",
    codeBlocked: "Too many attempts. Try again in 60 seconds.",
    roomNotFound: "Room not found",
    invalidLanguage: "Invalid language",
    roomCode: "Room code",
    enterRoomCode: "Enter 4-digit room code",
    codeHelpCreator: "Share this 4-digit code with one person.",
    codeHelpGuest: "Enter the 4-digit code from the room creator.",
    subtitles: "Subtitles",
    translatedSubtitle: "Translated subtitle",
    noSubtitlesYet: "Translated subtitles will appear here.",
    subtitlePreview: "What they see",
    noSubtitlePreviewYet: "Your translated subtitles will appear here.",
    debugOriginalTranscript: "You said",
    captionHistory: "History",
    startSubtitleService: "Start subtitle service",
    stopSubtitleService: "Stop subtitle service",
    subtitleServiceStartedNotice: "Subtitle service started",
    subtitleServiceStoppedNotice: "Subtitle service stopped",
    callHostLeftNotice: "Call host has left",
    subtitleServiceOn: "Subtitle service on",
    subtitleServiceStarting: "Subtitle service starting...",
    subtitleServiceWaiting: "Subtitle service is off",
    partial: "Listening...",
    final: "Final",
    localVideo: "You",
    remoteVideo: "Other person",
    audioOnly: "Audio only",
    callControls: "Call controls",
    roomSetup: "Room setup",
    subtitleServiceUnavailable: "Subtitle service unavailable",
    browserUnsupported: "This browser does not support the required call features.",
    cameraUnavailable: "Camera unavailable",
    microphoneUnavailable: "Microphone unavailable",
    openSettings: "Open settings",
    closeSettings: "Close settings"
  },
  ja: {
    appName: "Sakura Call",
    homeTitle: "プライベート通話を開始",
    homeFootnote: "2人専用。英語と日本語のみ。",
    createRoom: "ルームを作成",
    creatingRoom: "ルームを作成中...",
    createRoomFailed: "ルームを作成できませんでした",
    hostAccessRequired: "ホスト権限が必要です",
    hostAccess: "ホストアクセス",
    hostPasscode: "ホストパスコード",
    unlockHostMode: "ホストモードを解除",
    unlockingHostMode: "解除中...",
    hostModeEnabled: "ホストモードが有効です",
    hostAccessDenied: "ホストアクセスが拒否されました",
    hostAccessNotConfigured: "ホストアクセスが設定されていません",
    joinWithCode: "4桁のコードで参加",
    roomCodePlaceholder: "0000",
    joinRoom: "ルームに参加",
    joiningRoom: "参加中...",
    settings: "設定",
    changeLanguage: "言語を変更",
    back: "戻る",
    setUsernameTitle: "名前を設定",
    setUsernameHelp: "通話で表示される名前です。",
    usernameLabel: "あなたの名前",
    usernamePlaceholder: "名前を入力",
    continue: "続ける",
    english: "英語",
    japanese: "日本語",
    joinCall: "通話に参加",
    permissionsTitle: "マイク",
    permissionsHelp: "参加する前にマイクを許可してください。",
    allowPermissions: "マイクを許可",
    permissionsReady: "マイクの準備ができました",
    preparingPermissions: "権限を確認中...",
    mediaStartOptions: "開始オプション",
    startMuted: "ミュートで開始",
    startUnmuted: "ミュートなしで開始",
    startCameraOn: "カメラオンで開始",
    startCameraOff: "カメラオフで開始",
    waitingForOther: "相手を待っています...",
    connected: "接続済み",
    connecting: "接続中...",
    reconnecting: "再接続中...",
    disconnected: "切断されました",
    mute: "ミュート",
    unmute: "ミュート解除",
    cameraOn: "カメラオン",
    cameraOff: "カメラオフ",
    leaveCall: "退出",
    copyRoomCode: "ルームコードをコピー",
    copied: "コピーしました",
    microphonePermissionDenied: "マイクの許可が拒否されました",
    cameraPermissionDenied: "カメラの許可が拒否されました",
    thirdParticipantBlocked: "3人目の参加はできません",
    invalidCode: "コードが正しくありません",
    codeBlocked: "試行回数が多すぎます。60秒後に再試行してください。",
    roomNotFound: "ルームが見つかりません",
    invalidLanguage: "言語が正しくありません",
    roomCode: "ルームコード",
    enterRoomCode: "4桁のルームコードを入力",
    codeHelpCreator: "この4桁のコードを1人に共有してください。",
    codeHelpGuest: "作成者から受け取った4桁のコードを入力してください。",
    subtitles: "字幕",
    translatedSubtitle: "翻訳字幕",
    noSubtitlesYet: "翻訳字幕がここに表示されます。",
    subtitlePreview: "相手に見える字幕",
    noSubtitlePreviewYet: "自分の翻訳字幕がここに表示されます。",
    debugOriginalTranscript: "自分の発話",
    captionHistory: "履歴",
    startSubtitleService: "字幕サービスを開始",
    stopSubtitleService: "字幕サービスを停止",
    subtitleServiceStartedNotice: "字幕サービスを開始しました",
    subtitleServiceStoppedNotice: "字幕サービスを停止しました",
    callHostLeftNotice: "通話のホストが退出しました",
    subtitleServiceOn: "字幕サービスはオンです",
    subtitleServiceStarting: "字幕サービスを開始中...",
    subtitleServiceWaiting: "字幕サービスはオフです",
    partial: "聞き取り中...",
    final: "確定",
    localVideo: "自分",
    remoteVideo: "相手",
    audioOnly: "音声のみ",
    callControls: "通話操作",
    roomSetup: "ルーム設定",
    subtitleServiceUnavailable: "字幕サービスを利用できません",
    browserUnsupported: "このブラウザは必要な通話機能に対応していません。",
    cameraUnavailable: "カメラを利用できません",
    microphoneUnavailable: "マイクを利用できません",
    openSettings: "設定を開く",
    closeSettings: "設定を閉じる"
  }
} as const;

export type TranslationKey = keyof (typeof strings)["en"];

export function t(language: Language, key: TranslationKey): string {
  return strings[language][key];
}
