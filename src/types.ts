/**
 * Zentrale Typdefinitionen für das Google-Drive-Sync-Plugin.
 */

/** Persistente Plugin-Einstellungen (in data.json gespeichert). */
export interface PluginSettings {
  /** OAuth Client-ID der eigenen Google-Cloud-App. */
  clientId: string;
  /** OAuth Client-Secret der eigenen Google-Cloud-App. */
  clientSecret: string;
  /** Langlebiger Refresh-Token, aus dem Access-Tokens abgeleitet werden. */
  refreshToken: string;

  /** Google-Drive-Ordner-ID, die als Sync-Wurzel dient. */
  driveFolderId: string;
  /** Anzeigename des Drive-Ordners (nur für UI). */
  driveFolderName: string;
  /**
   * ID des Shared Drive, falls der Wurzelordner in einem solchen liegt.
   * Leer = normales "My Drive". Steuert die Shared-Drive-Parameter der List-API.
   */
  driveSharedId: string;

  /** Vault-relativer Unterordner, der gesynct wird ("" = ganzer Vault). */
  localFolder: string;

  /**
   * Kommagetrennte Liste erlaubter Dateiendungen (ohne Punkt), z.B.
   * "md, png, jpg, pdf". Leer = alle Endungen erlaubt.
   * Google-Editors-Dateien (Docs/Sheets/…) werden unabhängig davon immer
   * ignoriert, da sie keinen downloadbaren Binärinhalt haben.
   */
  allowedExtensions: string;

  /** Automatischer Sync aktiv? */
  autoSyncEnabled: boolean;
  /** Poll-Intervall für Drive-Änderungen in Sekunden. */
  pollIntervalSeconds: number;
  /** Verzögerung nach lokaler Änderung vor Upload (Debounce) in ms. */
  localDebounceMs: number;

  /**
   * Aufbewahrungsdauer für Log-Einträge in Stunden. Ältere Einträge werden
   * automatisch entfernt. 0 = nie automatisch löschen.
   */
  logRetentionHours: number;

  /**
   * Ausführliches Debug-Logging in der Developer-Console. Standardmäßig aus,
   * damit die Konsole nur Fehler zeigt (Obsidian-Richtlinie).
   */
  debugLogging: boolean;

  /**
   * "Do not delete in Google Drive". Wenn true, wird eine LOKALE Löschung nicht
   * nach Drive propagiert — die Drive-Datei bleibt erhalten und der Base-Eintrag
   * wird auf `local=false, remote=true` gesetzt (die Datei kommt lokal nicht als
   * Zombie zurück). Über den "Nur in Drive"-Baum in den Settings kann das
   * `local=false`-Flag entfernt werden, damit die Datei wieder heruntergeladen
   * wird. Standard: false.
   */
  neverDeleteRemote: boolean;
}

/**
 * Zustand einer Datei (oder eines Ordners) beim letzten erfolgreichen Sync —
 * das "Gedächtnis" zwischen zwei Läufen.
 *
 * Kern des Löschschutzes: `local`/`remote` merken sich, auf welcher Seite die
 * Datei beim letzten Verarbeiten TATSÄCHLICH existierte. Eine Löschung wird nur
 * dann propagiert, wenn die Datei zuvor auf BEIDEN Seiten war (local && remote)
 * und jetzt auf einer fehlt — dann ist es eine echte Löschung, kein Neuzugang.
 */
export interface SyncStateEntry {
  /** Vault-relativer Pfad (Key, Klartext — dient zugleich als ID). */
  path: string;
  /** Existierte die Datei beim letzten Verarbeiten lokal? */
  local: boolean;
  /** Existierte die Datei beim letzten Verarbeiten in Drive? */
  remote: boolean;
  /** true, wenn dieser Eintrag einen Ordner beschreibt (kein Hash/mtime). */
  isFolder: boolean;
  /** Google-Drive-Datei-ID (leer bei reinem Ordner-Platzhalter ohne Drive-Pendant). */
  driveId: string;
  /** MD5-Hash des Inhalts beim letzten Sync (leer bei Ordnern). */
  md5: string;
  /** Größe in Bytes beim letzten Sync. */
  size: number;
  /** Lokale mtime beim letzten Sync (ms). */
  localMtime: number;
  /** Drive modifiedTime beim letzten Sync (ms). */
  remoteMtime: number;
  /**
   * true, wenn die Datei BEWUSST nur in Drive gehalten wird: lokal gelöscht,
   * aber wegen "Do not delete in Google Drive" nicht aus Drive entfernt und
   * absichtlich NICHT lokal wiederhergestellt. Unterscheidet diesen Fall von
   * einer fremden/kopierten Base (local=false), die sehr wohl heruntergeladen
   * werden soll. Wird über den "Nur in Drive"-Baum in den Settings zurückgesetzt.
   */
  keptRemoteOnly?: boolean;
}

/** Ein Google-Drive-Ordner mit vault-relativem Pfad (vom rekursiven listFiles). */
export interface DriveFolder {
  id: string;
  relativePath: string;
}

/** Ein Google-Drive-Datei-Eintrag (Teilmenge der API-Felder). */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /** ms seit Epoch. */
  modifiedTimeMs: number;
  md5Checksum?: string;
  size?: number;
  trashed: boolean;
  parents?: string[];
  /**
   * Pfad relativ zum Sync-Wurzelordner, aus der Ordnerkette abgeleitet
   * (z.B. "sub/notiz.md"). Vom rekursiven listFiles() gesetzt.
   */
  relativePath?: string;
}

/** Ergebnis-Kategorien des Reconcilers für eine einzelne Datei. */
export type SyncAction =
  | { type: "upload"; path: string } // lokal -> Drive (neu oder geändert)
  | { type: "download"; path: string; driveId: string } // Drive -> lokal
  | { type: "deleteLocal"; path: string } // Drive gelöscht -> lokal löschen
  | { type: "deleteRemote"; path: string; driveId: string } // lokal gelöscht -> Drive löschen
  // Lokale Löschung NICHT nach Drive propagieren (Setting "Do not delete in
  // Google Drive"). Keine Drive-Operation; die Engine setzt den Base-Eintrag auf
  // local=false, remote=true, damit die Datei in Drive bleibt und lokal nicht
  // als Zombie zurückkehrt.
  | { type: "keepRemoteDropLocal"; path: string; driveId: string }
  | { type: "conflict"; path: string; driveId: string; winner: "local" | "remote" } // beide geändert
  | { type: "noop"; path: string };

/** Aktionen für Ordner (leere Ordner synchronisieren/löschen). */
export type FolderAction =
  | { type: "createLocalFolder"; path: string } // Ordner lokal anlegen
  | { type: "createRemoteFolder"; path: string } // Ordner in Drive anlegen
  | { type: "deleteLocalFolder"; path: string } // Ordner lokal löschen
  | { type: "deleteRemoteFolder"; path: string; driveId: string } // Ordner in Drive löschen
  // Lokal gelöschter Ordner, aber "Do not delete in Google Drive" aktiv:
  // Ordner in Drive behalten, Base auf nur-remote (keptRemoteOnly) setzen.
  | { type: "keepRemoteFolder"; path: string; driveId: string }
  | { type: "noopFolder"; path: string };

/** Zusammengefasstes Ergebnis eines Sync-Laufs (für Notices/Logs). */
export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  errors: string[];
}

export const DEFAULT_SETTINGS: PluginSettings = {
  clientId: "",
  clientSecret: "",
  refreshToken: "",
  driveFolderId: "",
  driveFolderName: "",
  driveSharedId: "",
  localFolder: "",
  allowedExtensions: "",
  autoSyncEnabled: false,
  pollIntervalSeconds: 60,
  localDebounceMs: 2500,
  logRetentionHours: 24,
  debugLogging: false,
  neverDeleteRemote: false,
};

/** OAuth-Scope: voller Drive-Zugriff, damit auch manuell in Drive angelegte Dateien sichtbar sind. */
export const OAUTH_SCOPE = "https://www.googleapis.com/auth/drive";
