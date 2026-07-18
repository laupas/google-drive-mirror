/**
 * Englische Übersetzungen — die AUTORITATIVE Quelle für alle i18n-Schlüssel.
 * Der `Messages`-Typ (unten abgeleitet) definiert das Schlüssel-Set; alle
 * anderen Sprachen sind `Partial<Messages>` und fallen auf diese Werte zurück.
 *
 * Konvention: Emoji-/Symbol-Präfixe (↑ ↓ 🗑 ⚔ 📁 …) stehen im CODE, nicht in
 * den Strings — so bleiben sie über alle Sprachen konsistent. `{name}` markiert
 * einen Interpolations-Platzhalter (siehe `t()` in ../index.ts).
 */

export const en = {
  // ---- Commands / Ribbon (main.ts) ----
  ribbonSyncTooltip: "Google Drive Mirror: Sync now",
  commandSyncNow: "Sync now",
  commandLogin: "Sign in with Google",

  // ---- Status bar (main.ts) ----
  statusBarReady: "Drive: ready",
  statusBarRunning: "Drive:{progress} {message}",
  statusBarRunningProgress: " {current}/{total}",
  statusBarDone: "Drive: {message}",
  statusBarError: "Drive: {message}",
  statusBarTooltip: "Google Drive Mirror — click to sync",

  // ---- Notices (main.ts) ----
  noticeSyncAlreadyRunning: "Google Drive Mirror: A sync is already running…",
  noticeSignInFirst: "Google Drive Mirror: Please sign in in the settings first.",
  noticeLoginSuccess: "Google Drive Mirror: Signed in, token saved.",

  // ---- Settings: headings & Google Cloud (settings-tab.ts) ----
  settingsTitle: "Google Drive Mirror",
  headingCloudAccess: "1. Google Cloud access",
  cloudHelp:
    "In the Google Cloud Console, create an OAuth client ID of type “Desktop app”, enable the Google Drive API, and enter the client ID and secret here. Details in the README.",
  clientIdName: "Client ID",
  clientIdDesc: "OAuth 2.0 client ID of your Google Cloud app.",
  clientSecretName: "Client secret",
  clientSecretDesc: "OAuth 2.0 client secret of your Google Cloud app.",
  loginName: "Sign-in",
  loginDescSignedIn: "✅ Signed in. Sign in again if access was revoked.",
  loginDescSignedOut: "Not signed in.",
  loginButtonReauth: "Sign in again",
  loginButtonSignIn: "Sign in with Google",
  loginFailed: "Sign-in failed: {error}",
  logoutTooltip: "Sign out (delete token)",

  // ---- Settings: folders (settings-tab.ts) ----
  headingFolders: "2. Folders",
  syncWholeVaultName: "Sync entire vault",
  syncWholeVaultDesc:
    "On: all files of the vault are synced (except the .obsidian config folder). Off: only a selected subfolder.",
  localFolderName: "Local vault folder",
  localFolderDescSet: "Vault-relative subfolder that is synced.",
  localFolderDescEmpty:
    "⚠️ Please choose a folder — without a selection nothing is synced.",
  localFolderPlaceholder: "e.g. Notes/Sync",
  driveFolderName: "Google Drive folder",
  driveFolderDescSet: "Current: “{name}”",
  driveFolderDescEmpty: "No folder chosen yet.",
  driveFolderPlaceholderReady: "Type to search Drive folders…",
  driveFolderPlaceholderNotReady: "Sign in first, then search folders",
  driveFolderCheckButton: "Check",
  sharedDriveSuffix: " (Shared Drive)",
  driveFolderFound: "Folder found: “{name}”{location}",
  driveFolderInvalid: "Invalid folder: {error}",
  driveFolderCreateTooltip: "Create new Drive folder “Obsidian”",
  driveFolderCreated: "Folder “{name}” created.",
  driveFolderCreateFailed: "Could not create folder: {error}",

  // ---- Settings: file filter & delete behavior (settings-tab.ts) ----
  allowedExtensionsName: "Allowed file extensions",
  allowedExtensionsDesc:
    "Comma-separated, without the dot (e.g. “md, png, jpg, pdf”). Empty = all file types. Google Docs/Sheets/Slides are always skipped because they cannot be downloaded as binary files.",
  allowedExtensionsPlaceholder: "md, png, jpg, pdf",
  ignorePatternsName: "Ignore patterns",
  ignorePatternsDesc:
    "Comma-separated list of files/folders to exclude from sync. Accepts plain extensions (“tmp”, “.log”) and glob patterns (“*.tmp”, “drafts/*”, “**/node_modules/**”). Paths are relative to the sync folder. Applies to both sides. Empty = ignore nothing.",
  ignorePatternsPlaceholder: "*.tmp, .DS_Store, drafts/*",
  neverDeleteRemoteName: "Do not delete in Google Drive",
  neverDeleteRemoteDesc:
    "When enabled, a locally deleted file is NOT removed from Google Drive. The file stays in Drive and does not come back locally. Via “Only in Drive” below you can download individual files locally again. Default: off.",

  // ---- Settings: auto-sync (settings-tab.ts) ----
  headingAutoSync: "3. Automatic sync",
  autoSyncEnabledName: "Enable auto-sync",
  autoSyncEnabledDesc:
    "Uploads local changes shortly after saving and polls Drive at an interval.",
  pollIntervalName: "Drive poll interval (seconds)",
  pollIntervalDesc: "How often Drive is checked for changes (minimum 15).",
  localDebounceName: "Delay after local change (ms)",
  localDebounceDesc: "Debounce to batch quick successive saves.",
  logRetentionName: "Log retention (hours)",
  logRetentionDesc:
    "Log entries older than this are deleted automatically. 0 = never delete automatically.",
  debugLoggingName: "Debug logging",
  debugLoggingDesc:
    "Writes verbose info messages to the developer console. Enable only for troubleshooting.",

  // ---- Settings: actions & status (settings-tab.ts) ----
  headingActionsStatus: "4. Actions & status",
  syncNowName: "Sync now",
  lastSyncDesc: "Last sync: {time}",
  neverSyncedDesc: "No sync performed yet.",
  syncStartButton: "Start sync",
  syncRunningButton: "Sync running…",
  syncLogName: "Sync log",
  syncLogDesc: "Full, live-updating log of the sync actions.",
  showLogButton: "Show log",
  clearLogTooltip: "Clear log",
  resetSyncStateName: "Reset sync state",
  resetSyncStateDesc:
    "Deletes the internal sync history (not your files). Useful when things are inconsistent. On the next sync all files are reconciled from scratch.",
  resetButton: "Reset",
  resetSyncStateNotice: "Sync state reset.",

  // ---- Settings: sync tree (settings-tab.ts) ----
  syncTreeName: "Sync tree",
  syncTreeDesc:
    "All synced folders and files. The checkbox shows whether an entry exists locally. Entries kept only in Google Drive (deleted locally but retained) are unchecked — check one to restore it locally on the next sync. Currently only in Drive: {count}.",
  syncTreeCheckboxTitle: "Uncheck to restore locally",
  syncTreeCheckboxLocalTitle: "Stored locally and in Google Drive",
  syncTreeCheckboxRestoreTitle: "Only in Google Drive — check to restore locally",
  syncTreeRestored: "“{path}” will be restored on the next sync.",
  syncTreeRefresh: "Refresh tree",
  syncTreeEmpty: "Nothing synced yet.",

  // ---- Live status line (settings-tab.ts) ----
  statusLineReady: "Ready.",
  statusLineRunning: "{message}{progress} · {secs}s",
  statusLineRunningProgress: " ({current}/{total})",
  statusLineDone: "{message}",
  statusLineError: "{message}",

  // ---- Log modal (settings-tab.ts) ----
  logModalTitle: "Google Drive Mirror — Log",
  logModalClearButton: "Clear log",
  logModalCount: "{count} entries",
  logModalEmpty: "No entries yet.",

  // ---- Sync status defaults (sync-status.ts) ----
  statusReady: "Ready",
  statusSyncStarted: "Sync started…",

  // ---- Sync engine: phases & messages (sync-engine.ts) ----
  engineNoDriveFolder: "Google Drive Mirror: No Drive folder configured.",
  engineReadingLocal: "Reading local files…",
  engineFetchingDrive: "Fetching Google Drive…",
  engineDuplicateSameContent:
    "Multiple identical Drive files “{path}” — one chosen.",
  engineDuplicateDifferent:
    "Multiple different Drive files with the same path “{path}” — skipped. Please remove/rename the duplicate in Drive.",
  engineDuplicateFolder:
    "Multiple Drive folders with the same path “{path}” — skipped. Please remove/rename the duplicate in Drive.",
  engineCountSummary:
    "{localFiles} local · {remoteFiles} Drive files, {localFolders}/{remoteFolders} folders",
  engineNoChanges: "No changes to transfer.",
  engineActionError: "{type} “{path}”: {error}",
  engineActionProgress: "{action} ({done}/{total})",
  engineActionDone: "{action} ✓",
  engineRemoteFolderNotDeleted:
    "Drive folder “{path}” not deleted: still contains files (protection against subtree loss).",
  engineSyncFailed: "Sync failed: {error}",
  engineNoticePrefix: "Google Drive Mirror: {message}",
  engineRemoteFolderCreated: "Drive folder “{path}” created ✓",
  engineLocalFolderCreated: "Local folder “{path}” created ✓",
  engineRemoteFolderDeleted: "Drive folder “{path}” deleted ✓",
  engineLocalFolderDeleted: "Local folder “{path}” deleted ✓",
  engineFolderKeptRemote:
    "Folder deleted locally, kept in Drive “{path}”",

  // ---- Sync engine: action descriptions (describeAction) ----
  uploadAction: "Upload “{path}”",
  downloadAction: "Download “{path}”",
  deleteLocalAction: "Delete locally “{path}”",
  deleteRemoteAction: "Delete in Drive “{path}”",
  keepRemoteDropLocalAction: "Deleted locally, kept in Drive “{path}”",
  conflictAction: "Conflict “{path}” ({winner} wins)",
  conflictWinnerLocal: "local",
  conflictWinnerRemote: "Drive",

  // ---- Sync engine: summary line (summaryText) ----
  summaryUploaded: "{count} up",
  summaryDownloaded: "{count} down",
  summaryDeletedRemote: "{count} deleted in Drive",
  summaryDeletedLocal: "{count} deleted locally",
  summaryConflicts: "{count} conflicts",
  summaryNoChanges: "no changes",
  summaryDoneWithErrors: "Done with {count} error(s): {head}",
  summaryDone: "Done: {head}",

  // ---- Sync engine: final notice (formatSummary) ----
  noticeDeletedRemote: "Drive {count}",
  noticeDeletedLocal: "local {count}",
  noticeErrorMore: "\n…and {count} more",
  noticeErrorTail:
    "\n⚠ {count} error(s) (details in the console):\n{shown}{more}",
  noticeSummary: "Google Drive Mirror: {head}{errTail}",

  // ---- OAuth errors (oauth.ts) ----
  oauthCredentialsMissing:
    "Client ID and client secret must be set in the settings first.",
  oauthNoRefreshToken:
    "Google did not return a refresh token. Please revoke the app's access at https://myaccount.google.com/permissions and sign in again (prompt=consent forces a new refresh token).",
  oauthNotSignedIn: "Google Drive Mirror is not signed in (no refresh token).",
  oauthTokenRefreshFailed:
    "Token refresh failed ({status}): {text}. The refresh token may have expired — please sign in again.",
  oauthPageSuccess: "Sign-in successful",
  oauthPageFailure: "Sign-in failed",
  oauthPageClose: "You can close this window and return to Obsidian.",
  oauthError: "OAuth error: {error}",
  oauthNoCode: "No auth code received.",
  oauthStateMismatch: "State does not match (CSRF protection).",
  oauthTimeout: "Sign-in timed out (5 minutes).",
  oauthCodeExchangeFailed: "Code exchange failed ({status}): {text}",

  // ---- Suggesters (suggesters.ts) ----
  suggestWholeVault: "/ (entire vault)",
  suggestSharedDriveBadge: "  · Shared Drive",

  // ---- Drive client (drive-client.ts) ----
  driveNotAFolder: "The given ID is not a folder.",
  driveApiFailed: "Drive API \"{action}\" failed ({status}): {text}",
  driveActionListFiles: "list files",
  driveActionDownloadFile: "download file",
  driveActionCreateFile: "create file",
  driveActionSearchSubfolder: "search subfolder",
  driveActionCreateSubfolder: "create subfolder",
  driveActionUpdateFile: "update file",
  driveActionTrashFile: "move file to trash",
  driveActionCheckFolder: "check folder",
  driveActionSearchFolder: "search folder",
  driveActionCreateFolder: "create folder",
} as const;

/** Schlüssel-Set + Wert-Typen aller Übersetzungen (Autoritätsquelle). */
export type Messages = Record<keyof typeof en, string>;
