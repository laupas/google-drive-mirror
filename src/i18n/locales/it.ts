/**
 * Traduzioni italiane. Le chiavi mancanti ricadono automaticamente
 * sull'inglese (en.ts).
 */

import type { Messages } from "./en";

export const it: Partial<Messages> = {
  // ---- Comandi / Ribbon ----
  ribbonSyncTooltip: "Google Drive Mirror: Sincronizza ora",
  commandSyncNow: "Sincronizza ora",
  commandLogin: "Accedi con Google",

  // ---- Barra di stato ----
  statusBarReady: "Drive: pronto",
  statusBarRunning: "Drive:{progress} {message}",
  statusBarRunningProgress: " {current}/{total}",
  statusBarDone: "Drive: {message}",
  statusBarError: "Drive: {message}",
  statusBarTooltip: "Google Drive Mirror — clicca per sincronizzare",

  // ---- Notifiche ----
  noticeSyncAlreadyRunning:
    "Google Drive Mirror: Una sincronizzazione è già in corso…",
  noticeSignInFirst:
    "Google Drive Mirror: Accedi prima nelle impostazioni.",
  noticeLoginSuccess: "Google Drive Mirror: Accesso riuscito, token salvato.",
  noticeNoTargets:
    "Google Drive Mirror: Nessuna destinazione di sincronizzazione configurata. Aggiungine una nelle impostazioni.",

  // ---- Impostazioni: intestazioni & Google Cloud ----
  settingsTitle: "Google Drive Mirror",
  headingCloudAccess: "1. Accesso a Google Cloud",
  cloudHelp:
    "Nella Google Cloud Console, crea un ID client OAuth di tipo “App desktop”, abilita l'API Google Drive e inserisci qui l'ID client e il secret. Dettagli nel README.",
  clientIdName: "ID client",
  clientIdDesc: "ID client OAuth 2.0 della tua app Google Cloud.",
  clientSecretName: "Client secret",
  clientSecretDesc: "Client secret OAuth 2.0 della tua app Google Cloud.",
  loginName: "Accesso",
  loginDescSignedIn:
    "✅ Connesso. Accedi di nuovo se l'accesso è stato revocato.",
  loginDescSignedOut: "Non connesso.",
  loginButtonReauth: "Accedi di nuovo",
  loginButtonSignIn: "Accedi con Google",
  loginFailed: "Accesso non riuscito: {error}",
  logoutTooltip: "Disconnetti (elimina token)",

  // ---- Impostazioni: cartelle ----
  // ---- Impostazioni: destinazioni di sincronizzazione ----
  headingTargets: "2. Destinazioni di sincronizzazione",
  targetsHelp:
    "Ogni destinazione sincronizza una (sotto)cartella locale con una cartella di Google Drive. Una destinazione dell'intero vault esclude automaticamente le cartelle locali delle altre destinazioni, così una sottocartella non finisce mai in due Drive contemporaneamente.",
  targetsEmpty: "Ancora nessuna destinazione. Aggiungine una qui sotto.",
  targetAddButton: "Aggiungi destinazione",
  targetDefaultName: "Destinazione {index}",
  targetNameName: "Nome",
  targetNameDesc: "Un'etichetta per questa destinazione (mostrata solo qui).",
  targetNamePlaceholder: "es. Note di lavoro",
  targetRemoveTooltip:
    "Rimuovi questa destinazione (mantiene i file, azzera la base di sincronizzazione)",
  excludeFoldersName: "Cartelle escluse",
  excludeFoldersDesc:
    "Elenco separato da virgole di cartelle (relative al vault) da escludere da questa destinazione (oltre alle altre destinazioni, escluse automaticamente). Vale per entrambi i lati. Vuoto = nulla in più.",
  excludeFoldersPlaceholder: "Archivio, Privato/Diario",

  headingFolders: "2. Cartelle",
  syncWholeVaultName: "Sincronizza l'intero vault",
  syncWholeVaultLocked:
    "Solo una destinazione può sincronizzare l'intero vault — “{name}” lo fa già. Scegli una sottocartella per questa destinazione.",
  syncWholeVaultDesc:
    "Attivo: tutti i file del vault vengono sincronizzati (tranne la cartella di configurazione .obsidian). Disattivo: solo una sottocartella selezionata.",
  localFolderName: "Cartella locale del vault",
  localFolderDescSet: "Sottocartella relativa al vault che viene sincronizzata.",
  localFolderDescEmpty:
    "⚠️ Scegli una cartella — senza selezione non viene sincronizzato nulla.",
  localFolderPlaceholder: "es. Notes/Sync",
  driveFolderName: "Cartella di Google Drive",
  driveFolderDescSet: "Attuale: “{name}”",
  driveFolderDescEmpty: "Nessuna cartella scelta ancora.",
  driveFolderPlaceholderReady: "Digita per cercare cartelle di Drive…",
  driveFolderPlaceholderNotReady: "Accedi prima, poi cerca le cartelle",
  driveFolderCheckButton: "Verifica",
  sharedDriveSuffix: " (Drive condiviso)",
  driveFolderFound: "Cartella trovata: “{name}”{location}",
  driveFolderInvalid: "Cartella non valida: {error}",
  driveFolderCreateTooltip: "Crea nuova cartella Drive “Obsidian”",
  driveFolderCreated: "Cartella “{name}” creata.",
  driveFolderCreateFailed: "Impossibile creare la cartella: {error}",

  // ---- Impostazioni: filtro file & comportamento eliminazione ----
  allowedExtensionsName: "Estensioni di file consentite",
  allowedExtensionsDesc:
    "Separate da virgola, senza il punto (es. “md, png, jpg, pdf”). Vuoto = tutti i tipi di file. Google Docs/Sheets/Slides vengono sempre saltati perché non scaricabili come file binari.",
  allowedExtensionsPlaceholder: "md, png, jpg, pdf",
  ignorePatternsName: "Motivi da ignorare",
  ignorePatternsDesc:
    "Elenco separato da virgole di file/cartelle da escludere dalla sincronizzazione. Accetta estensioni semplici (“tmp”, “.log”) e motivi glob (“*.tmp”, “drafts/*”, “**/node_modules/**”). I percorsi sono relativi alla cartella di sincronizzazione. Vale per entrambi i lati. Vuoto = non ignorare nulla.",
  ignorePatternsPlaceholder: "*.tmp, .DS_Store, drafts/*",
  neverDeleteRemoteName: "Non eliminare in Google Drive",
  neverDeleteRemoteDesc:
    "Se attivo, un file eliminato localmente NON viene rimosso da Google Drive. Il file resta in Drive e non torna localmente. Tramite “Solo in Drive” qui sotto puoi scaricare di nuovo singoli file localmente. Predefinito: disattivo.",

  // ---- Impostazioni: sincronizzazione automatica ----
  headingAutoSync: "3. Sincronizzazione automatica",
  autoSyncEnabledName: "Abilita sincronizzazione automatica",
  autoSyncEnabledDesc:
    "Carica le modifiche locali poco dopo il salvataggio e interroga Drive a intervalli.",
  pollIntervalName: "Intervallo di polling di Drive (secondi)",
  pollIntervalDesc:
    "Con quale frequenza Drive viene controllato per le modifiche (minimo 15).",
  localDebounceName: "Ritardo dopo la modifica locale (ms)",
  localDebounceDesc:
    "Debounce per raggruppare salvataggi rapidi consecutivi.",
  logRetentionName: "Conservazione del log (ore)",
  logRetentionDesc:
    "Le voci del log più vecchie vengono eliminate automaticamente. 0 = non eliminare mai automaticamente.",
  debugLoggingName: "Log di debug",
  debugLoggingDesc:
    "Scrive messaggi informativi dettagliati nella console per sviluppatori. Abilita solo per la risoluzione dei problemi.",

  // ---- Impostazioni: azioni & stato ----
  headingActionsStatus: "4. Azioni & stato",
  syncNowName: "Sincronizza ora",
  lastSyncDesc: "Ultima sincronizzazione: {time}",
  neverSyncedDesc: "Nessuna sincronizzazione eseguita ancora.",
  syncStartButton: "Avvia sincronizzazione",
  syncRunningButton: "Sincronizzazione in corso…",
  syncLogName: "Log di sincronizzazione",
  syncLogDesc:
    "Registro completo e aggiornato in tempo reale delle azioni di sincronizzazione.",
  showLogButton: "Mostra log",
  clearLogTooltip: "Svuota log",
  resetSyncStateName: "Reimposta stato di sincronizzazione",
  resetSyncStateDesc:
    "Elimina la cronologia di sincronizzazione interna (non i tuoi file). Utile in caso di incoerenze. Alla prossima sincronizzazione tutti i file vengono riconciliati da zero.",
  resetButton: "Reimposta",
  resetSyncStateNotice: "Stato di sincronizzazione reimpostato.",

  // ---- Impostazioni: albero di sincronizzazione ----
  syncTreeName: "Albero di sincronizzazione",
  syncTreeDesc:
    "Tutte le cartelle e i file sincronizzati. Le voci conservate solo in Google Drive (eliminate localmente ma mantenute) hanno una casella selezionata — deseleziona per ripristinarle localmente alla prossima sincronizzazione. Attualmente solo in Drive: {count}.",
  syncTreeCheckboxTitle: "Deseleziona per ripristinare localmente",
  syncTreeCheckboxLocalTitle: "Presente in locale e su Google Drive",
  syncTreeCheckboxRestoreTitle:
    "Solo su Google Drive — seleziona per ripristinare in locale",
  syncTreeRefresh: "Aggiorna albero",
  syncTreeEmpty: "Ancora nulla sincronizzato.",
  syncTreeRestored:
    "“{path}” verrà ripristinato alla prossima sincronizzazione.",

  // ---- Riga di stato in tempo reale ----
  statusLineReady: "Pronto.",
  statusLineRunning: "{message}{progress} · {secs}s",
  statusLineRunningProgress: " ({current}/{total})",
  statusLineDone: "{message}",
  statusLineError: "{message}",

  // ---- Modale del log ----
  logModalTitle: "Google Drive Mirror — Log",
  logModalClearButton: "Svuota log",
  logModalCount: "{count} voci",
  logModalEmpty: "Ancora nessuna voce.",

  // ---- Valori predefiniti dello stato ----
  statusReady: "Pronto",
  statusSyncStarted: "Sincronizzazione avviata…",

  // ---- Motore di sincronizzazione: fasi & messaggi ----
  engineNoDriveFolder:
    "Google Drive Mirror: Nessuna cartella Drive configurata.",
  engineReadingLocal: "Lettura dei file locali…",
  engineFetchingDrive: "Recupero da Google Drive…",
  engineDuplicateSameContent:
    "Più file Drive con lo stesso contenuto “{path}” — ne è stato scelto uno.",
  engineDuplicateDifferent:
    "Più file Drive diversi con lo stesso percorso “{path}” — saltati. Rimuovi/rinomina il duplicato in Drive.",
  engineDuplicateFolder:
    "Più cartelle Drive con lo stesso percorso “{path}” — saltate. Rimuovi/rinomina il duplicato in Drive.",
  engineCountSummary:
    "{localFiles} locali · {remoteFiles} file Drive, {localFolders}/{remoteFolders} cartelle",
  engineNoChanges: "Nessuna modifica da trasferire.",
  engineActionError: "{type} “{path}”: {error}",
  engineActionProgress: "{action} ({done}/{total})",
  engineActionDone: "{action} ✓",
  engineRemoteFolderNotDeleted:
    "Cartella Drive “{path}” non eliminata: contiene ancora file (protezione contro la perdita del sottoalbero).",
  engineSyncFailed: "Sincronizzazione non riuscita: {error}",
  engineNoticePrefix: "Google Drive Mirror: {message}",
  engineRemoteFolderCreated: "Cartella Drive “{path}” creata ✓",
  engineLocalFolderCreated: "Cartella locale “{path}” creata ✓",
  engineRemoteFolderDeleted: "Cartella Drive “{path}” eliminata ✓",
  engineLocalFolderDeleted: "Cartella locale “{path}” eliminata ✓",
  engineFolderKeptRemote:
    "Cartella eliminata localmente, conservata in Drive “{path}”",

  // ---- Motore di sincronizzazione: descrizioni azioni ----
  uploadAction: "Carica “{path}”",
  downloadAction: "Scarica “{path}”",
  deleteLocalAction: "Elimina localmente “{path}”",
  deleteRemoteAction: "Elimina in Drive “{path}”",
  keepRemoteDropLocalAction: "Eliminato localmente, conservato in Drive “{path}”",
  conflictAction: "Conflitto “{path}” (vince {winner})",
  conflictWinnerLocal: "locale",
  conflictWinnerRemote: "Drive",

  // ---- Motore di sincronizzazione: riga di riepilogo ----
  summaryUploaded: "{count} su",
  summaryDownloaded: "{count} giù",
  summaryDeletedRemote: "{count} eliminati in Drive",
  summaryDeletedLocal: "{count} eliminati localmente",
  summaryConflicts: "{count} conflitti",
  summaryNoChanges: "nessuna modifica",
  summaryDoneWithErrors: "Completato con {count} errore/i: {head}",
  summaryDone: "Completato: {head}",

  // ---- Motore di sincronizzazione: notifica finale ----
  noticeDeletedRemote: "Drive {count}",
  noticeDeletedLocal: "locale {count}",
  noticeErrorMore: "\n…e altri {count}",
  noticeErrorTail:
    "\n⚠ {count} errore/i (dettagli nella console):\n{shown}{more}",
  noticeSummary: "Google Drive Mirror: {head}{errTail}",

  // ---- Errori OAuth ----
  oauthCredentialsMissing:
    "L'ID client e il client secret devono essere impostati prima nelle impostazioni.",
  oauthNoRefreshToken:
    "Google non ha restituito un refresh token. Revoca l'accesso dell'app su https://myaccount.google.com/permissions e accedi di nuovo (prompt=consent forza un nuovo refresh token).",
  oauthNotSignedIn:
    "Google Drive Mirror non è connesso (nessun refresh token).",
  oauthTokenRefreshFailed:
    "Rinnovo del token non riuscito ({status}): {text}. Il refresh token potrebbe essere scaduto — accedi di nuovo.",
  oauthPageSuccess: "Accesso riuscito",
  oauthPageFailure: "Accesso non riuscito",
  oauthPageClose: "Puoi chiudere questa finestra e tornare a Obsidian.",
  oauthError: "Errore OAuth: {error}",
  oauthNoCode: "Nessun codice di autenticazione ricevuto.",
  oauthStateMismatch: "Lo state non corrisponde (protezione CSRF).",
  oauthTimeout: "Timeout durante l'accesso (5 minuti).",
  oauthCodeExchangeFailed: "Scambio del codice non riuscito ({status}): {text}",

  // ---- Suggeritori ----
  suggestWholeVault: "/ (intero vault)",
  suggestSharedDriveBadge: "  · Drive condiviso",

  // ---- Client Drive ----
  driveNotAFolder: "L'ID indicato non è una cartella.",
  driveApiFailed: "API Drive \"{action}\" non riuscita ({status}): {text}",
  driveActionListFiles: "elencare i file",
  driveActionDownloadFile: "scaricare il file",
  driveActionCreateFile: "creare il file",
  driveActionSearchSubfolder: "cercare la sottocartella",
  driveActionCreateSubfolder: "creare la sottocartella",
  driveActionUpdateFile: "aggiornare il file",
  driveActionTrashFile: "spostare il file nel cestino",
  driveActionCheckFolder: "verificare la cartella",
  driveActionSearchFolder: "cercare la cartella",
  driveActionCreateFolder: "creare la cartella",
};
