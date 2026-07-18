/**
 * Traductions françaises. Les clés manquantes reviennent automatiquement
 * à l'anglais (en.ts).
 */

import type { Messages } from "./en";

export const fr: Partial<Messages> = {
  // ---- Commandes / Ruban ----
  ribbonSyncTooltip: "Google Drive Mirror : Synchroniser maintenant",
  commandSyncNow: "Synchroniser maintenant",
  commandLogin: "Se connecter avec Google",

  // ---- Barre d'état ----
  statusBarReady: "Drive : prêt",
  statusBarRunning: "Drive:{progress} {message}",
  statusBarRunningProgress: " {current}/{total}",
  statusBarDone: "Drive : {message}",
  statusBarError: "Drive : {message}",
  statusBarTooltip: "Google Drive Mirror — cliquez pour synchroniser",

  // ---- Notifications ----
  noticeSyncAlreadyRunning:
    "Google Drive Mirror : Une synchronisation est déjà en cours…",
  noticeSignInFirst:
    "Google Drive Mirror : Veuillez d'abord vous connecter dans les paramètres.",
  noticeLoginSuccess: "Google Drive Mirror : Connecté, jeton enregistré.",

  // ---- Paramètres : titres & Google Cloud ----
  settingsTitle: "Google Drive Mirror",
  headingCloudAccess: "1. Accès à Google Cloud",
  cloudHelp:
    "Dans la Google Cloud Console, créez un ID client OAuth de type « Application de bureau », activez l'API Google Drive et saisissez ici l'ID client et le secret. Détails dans le README.",
  clientIdName: "ID client",
  clientIdDesc: "ID client OAuth 2.0 de votre application Google Cloud.",
  clientSecretName: "Secret client",
  clientSecretDesc:
    "Secret client OAuth 2.0 de votre application Google Cloud.",
  loginName: "Connexion",
  loginDescSignedIn:
    "✅ Connecté. Reconnectez-vous si l'accès a été révoqué.",
  loginDescSignedOut: "Non connecté.",
  loginButtonReauth: "Se reconnecter",
  loginButtonSignIn: "Se connecter avec Google",
  loginFailed: "Échec de la connexion : {error}",
  logoutTooltip: "Se déconnecter (supprimer le jeton)",

  // ---- Paramètres : dossiers ----
  headingFolders: "2. Dossiers",
  syncWholeVaultName: "Synchroniser tout le coffre",
  syncWholeVaultDesc:
    "Activé : tous les fichiers du coffre sont synchronisés (sauf le dossier de configuration .obsidian). Désactivé : uniquement un sous-dossier sélectionné.",
  localFolderName: "Dossier local du coffre",
  localFolderDescSet: "Sous-dossier relatif au coffre qui est synchronisé.",
  localFolderDescEmpty:
    "⚠️ Veuillez choisir un dossier — sans sélection, rien n'est synchronisé.",
  localFolderPlaceholder: "ex. Notes/Sync",
  driveFolderName: "Dossier Google Drive",
  driveFolderDescSet: "Actuel : « {name} »",
  driveFolderDescEmpty: "Aucun dossier choisi pour l'instant.",
  driveFolderPlaceholderReady: "Tapez pour rechercher des dossiers Drive…",
  driveFolderPlaceholderNotReady:
    "Connectez-vous d'abord, puis recherchez des dossiers",
  driveFolderCheckButton: "Vérifier",
  sharedDriveSuffix: " (Drive partagé)",
  driveFolderFound: "Dossier trouvé : « {name} »{location}",
  driveFolderInvalid: "Dossier invalide : {error}",
  driveFolderCreateTooltip: "Créer un nouveau dossier Drive « Obsidian »",
  driveFolderCreated: "Dossier « {name} » créé.",
  driveFolderCreateFailed: "Impossible de créer le dossier : {error}",

  // ---- Paramètres : filtre de fichiers & comportement de suppression ----
  allowedExtensionsName: "Extensions de fichiers autorisées",
  allowedExtensionsDesc:
    "Séparées par des virgules, sans le point (ex. « md, png, jpg, pdf »). Vide = tous les types de fichiers. Les Google Docs/Sheets/Slides sont toujours ignorés car ils ne peuvent pas être téléchargés comme fichiers binaires.",
  allowedExtensionsPlaceholder: "md, png, jpg, pdf",
  neverDeleteRemoteName: "Ne pas supprimer dans Google Drive",
  neverDeleteRemoteDesc:
    "Si activé, un fichier supprimé localement n'est PAS retiré de Google Drive. Le fichier reste dans Drive et ne revient pas localement. Via « Uniquement dans Drive » ci-dessous, vous pouvez retélécharger des fichiers individuels localement. Par défaut : désactivé.",

  // ---- Paramètres : synchronisation automatique ----
  headingAutoSync: "3. Synchronisation automatique",
  autoSyncEnabledName: "Activer la synchronisation automatique",
  autoSyncEnabledDesc:
    "Téléverse les modifications locales peu après l'enregistrement et interroge Drive à intervalles réguliers.",
  pollIntervalName: "Intervalle d'interrogation de Drive (secondes)",
  pollIntervalDesc:
    "Fréquence de vérification des modifications sur Drive (minimum 15).",
  localDebounceName: "Délai après une modification locale (ms)",
  localDebounceDesc:
    "Anti-rebond pour regrouper les enregistrements rapides successifs.",
  logRetentionName: "Conservation du journal (heures)",
  logRetentionDesc:
    "Les entrées de journal plus anciennes sont supprimées automatiquement. 0 = ne jamais supprimer automatiquement.",
  debugLoggingName: "Journalisation de débogage",
  debugLoggingDesc:
    "Écrit des messages d'information détaillés dans la console de développement. À activer uniquement pour le dépannage.",

  // ---- Paramètres : actions & état ----
  headingActionsStatus: "4. Actions & état",
  syncNowName: "Synchroniser maintenant",
  lastSyncDesc: "Dernière synchronisation : {time}",
  neverSyncedDesc: "Aucune synchronisation effectuée pour l'instant.",
  syncStartButton: "Démarrer la synchronisation",
  syncRunningButton: "Synchronisation en cours…",
  syncLogName: "Journal de synchronisation",
  syncLogDesc:
    "Journal complet et mis à jour en direct des actions de synchronisation.",
  showLogButton: "Afficher le journal",
  clearLogTooltip: "Vider le journal",
  resetSyncStateName: "Réinitialiser l'état de synchronisation",
  resetSyncStateDesc:
    "Supprime l'historique de synchronisation interne (pas vos fichiers). Utile en cas d'incohérences. Lors de la prochaine synchronisation, tous les fichiers sont réconciliés depuis le début.",
  resetButton: "Réinitialiser",
  resetSyncStateNotice: "État de synchronisation réinitialisé.",

  // ---- Paramètres : arbre de synchronisation ----
  syncTreeName: "Arbre de synchronisation",
  syncTreeDesc:
    "Tous les dossiers et fichiers synchronisés. Les entrées conservées uniquement dans Google Drive (supprimées localement mais conservées) ont une case cochée — décochez pour les restaurer localement lors de la prochaine synchronisation. Actuellement uniquement dans Drive : {count}.",
  syncTreeCheckboxTitle: "Décochez pour restaurer localement",
  syncTreeCheckboxLocalTitle: "Présent en local et sur Google Drive",
  syncTreeCheckboxRestoreTitle:
    "Uniquement sur Google Drive — cochez pour restaurer en local",
  syncTreeRefresh: "Actualiser l’arborescence",
  syncTreeEmpty: "Rien de synchronisé pour l’instant.",
  syncTreeRestored:
    "« {path} » sera restauré lors de la prochaine synchronisation.",

  // ---- Ligne d'état en direct ----
  statusLineReady: "Prêt.",
  statusLineRunning: "{message}{progress} · {secs}s",
  statusLineRunningProgress: " ({current}/{total})",
  statusLineDone: "{message}",
  statusLineError: "{message}",

  // ---- Fenêtre du journal ----
  logModalTitle: "Google Drive Mirror — Journal",
  logModalClearButton: "Vider le journal",
  logModalCount: "{count} entrées",
  logModalEmpty: "Aucune entrée pour l'instant.",

  // ---- Valeurs par défaut de l'état ----
  statusReady: "Prêt",
  statusSyncStarted: "Synchronisation démarrée…",

  // ---- Moteur de synchronisation : phases & messages ----
  engineNoDriveFolder:
    "Google Drive Mirror : Aucun dossier Drive configuré.",
  engineReadingLocal: "Lecture des fichiers locaux…",
  engineFetchingDrive: "Récupération depuis Google Drive…",
  engineDuplicateSameContent:
    "Plusieurs fichiers Drive au contenu identique « {path} » — un seul choisi.",
  engineDuplicateDifferent:
    "Plusieurs fichiers Drive différents avec le même chemin « {path} » — ignorés. Veuillez supprimer/renommer le doublon dans Drive.",
  engineDuplicateFolder:
    "Plusieurs dossiers Drive avec le même chemin « {path} » — ignorés. Veuillez supprimer/renommer le doublon dans Drive.",
  engineCountSummary:
    "{localFiles} locaux · {remoteFiles} fichiers Drive, {localFolders}/{remoteFolders} dossiers",
  engineNoChanges: "Aucune modification à transférer.",
  engineActionError: "{type} « {path} » : {error}",
  engineActionProgress: "{action} ({done}/{total})",
  engineActionDone: "{action} ✓",
  engineRemoteFolderNotDeleted:
    "Dossier Drive « {path} » non supprimé : contient encore des fichiers (protection contre la perte du sous-arbre).",
  engineSyncFailed: "Échec de la synchronisation : {error}",
  engineNoticePrefix: "Google Drive Mirror : {message}",
  engineRemoteFolderCreated: "Dossier Drive « {path} » créé ✓",
  engineLocalFolderCreated: "Dossier local « {path} » créé ✓",
  engineRemoteFolderDeleted: "Dossier Drive « {path} » supprimé ✓",
  engineLocalFolderDeleted: "Dossier local « {path} » supprimé ✓",
  engineFolderKeptRemote:
    "Dossier supprimé localement, conservé dans Drive « {path} »",

  // ---- Moteur de synchronisation : descriptions des actions ----
  uploadAction: "Téléverser « {path} »",
  downloadAction: "Télécharger « {path} »",
  deleteLocalAction: "Supprimer localement « {path} »",
  deleteRemoteAction: "Supprimer dans Drive « {path} »",
  keepRemoteDropLocalAction:
    "Supprimé localement, conservé dans Drive « {path} »",
  conflictAction: "Conflit « {path} » ({winner} l'emporte)",
  conflictWinnerLocal: "local",
  conflictWinnerRemote: "Drive",

  // ---- Moteur de synchronisation : ligne de résumé ----
  summaryUploaded: "{count} envoyés",
  summaryDownloaded: "{count} reçus",
  summaryDeletedRemote: "{count} supprimés dans Drive",
  summaryDeletedLocal: "{count} supprimés localement",
  summaryConflicts: "{count} conflits",
  summaryNoChanges: "aucune modification",
  summaryDoneWithErrors: "Terminé avec {count} erreur(s) : {head}",
  summaryDone: "Terminé : {head}",

  // ---- Moteur de synchronisation : notification finale ----
  noticeDeletedRemote: "Drive {count}",
  noticeDeletedLocal: "local {count}",
  noticeErrorMore: "\n…et {count} de plus",
  noticeErrorTail:
    "\n⚠ {count} erreur(s) (détails dans la console) :\n{shown}{more}",
  noticeSummary: "Google Drive Mirror : {head}{errTail}",

  // ---- Erreurs OAuth ----
  oauthCredentialsMissing:
    "L'ID client et le secret client doivent d'abord être définis dans les paramètres.",
  oauthNoRefreshToken:
    "Google n'a pas renvoyé de jeton d'actualisation. Veuillez révoquer l'accès de l'application sur https://myaccount.google.com/permissions et vous reconnecter (prompt=consent force un nouveau jeton d'actualisation).",
  oauthNotSignedIn:
    "Google Drive Mirror n'est pas connecté (aucun jeton d'actualisation).",
  oauthTokenRefreshFailed:
    "Échec du renouvellement du jeton ({status}) : {text}. Le jeton d'actualisation a peut-être expiré — veuillez vous reconnecter.",
  oauthPageSuccess: "Connexion réussie",
  oauthPageFailure: "Échec de la connexion",
  oauthPageClose: "Vous pouvez fermer cette fenêtre et revenir à Obsidian.",
  oauthError: "Erreur OAuth : {error}",
  oauthNoCode: "Aucun code d'authentification reçu.",
  oauthStateMismatch: "L'état ne correspond pas (protection CSRF).",
  oauthTimeout: "Délai d'attente dépassé lors de la connexion (5 minutes).",
  oauthCodeExchangeFailed:
    "Échec de l'échange du code ({status}) : {text}",

  // ---- Suggestions ----
  suggestWholeVault: "/ (tout le coffre)",
  suggestSharedDriveBadge: "  · Drive partagé",

  // ---- Client Drive ----
  driveNotAFolder: "L'ID indiqué n'est pas un dossier.",
  driveApiFailed: "API Drive \"{action}\" a échoué ({status}) : {text}",
  driveActionListFiles: "lister les fichiers",
  driveActionDownloadFile: "télécharger le fichier",
  driveActionCreateFile: "créer le fichier",
  driveActionSearchSubfolder: "rechercher le sous-dossier",
  driveActionCreateSubfolder: "créer le sous-dossier",
  driveActionUpdateFile: "mettre à jour le fichier",
  driveActionTrashFile: "déplacer le fichier vers la corbeille",
  driveActionCheckFolder: "vérifier le dossier",
  driveActionSearchFolder: "rechercher le dossier",
  driveActionCreateFolder: "créer le dossier",
};
