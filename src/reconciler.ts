import {
  DriveFile,
  FolderAction,
  SyncAction,
  SyncStateEntry,
} from "./types";

/** Momentaufnahme einer lokalen Datei (vom SyncEngine erhoben). */
export interface LocalFile {
  path: string;
  md5: string;
  size: number;
  mtimeMs: number;
}

/** Eingaben für einen Reconcile-Lauf. */
export interface ReconcileInput {
  /** Aktueller lokaler Stand: Pfad -> Datei. */
  local: Map<string, LocalFile>;
  /** Aktueller Drive-Stand (nicht-getrasht): Pfad -> Drive-Datei. */
  remote: Map<string, DriveFile>;
  /** Base vom letzten Sync: Pfad -> Eintrag. */
  base: Map<string, SyncStateEntry>;
  /**
   * "Do not delete in Google Drive": Wenn true, wird eine lokale Löschung NICHT
   * als `deleteRemote` propagiert, sondern als `keepRemoteDropLocal` (Drive-Datei
   * bleibt, Base wird auf nur-remote gesetzt). Standard: false.
   */
  neverDeleteRemote?: boolean;
}

/**
 * Vergleicht lokalen Stand, Remote-Stand und die Base (letzter Sync) und
 * leitet für jeden Pfad die auszuführende Aktion ab.
 *
 * Grundprinzip:
 *   - "geändert" = md5 weicht von der Base ab (oder keine Base = neu).
 *   - "gelöscht" = fehlt jetzt, war laut Base aber auf DIESER Seite vorhanden
 *     (b.local bzw. b.remote). Genau diese Bedingung verhindert, dass eine
 *     nie hier existente Datei (leere/kopierte/fremde Base) fälschlich als
 *     Löschung interpretiert und die Gegenseite geleert wird.
 *
 * Konfliktstrategie: "neuere gewinnt" — bei beidseitiger Änderung entscheidet
 * der jüngere mtime-Zeitstempel.
 *
 * Löschungen werden in den Papierkorb propagiert — außer die Gegenseite hat
 * dieselbe Datei ebenfalls geändert; dann gewinnt die Änderung (kein
 * Datenverlust).
 */
export function reconcile(input: ReconcileInput): SyncAction[] {
  const { local, remote, base, neverDeleteRemote = false } = input;
  const actions: SyncAction[] = [];

  // Vereinigung aller Pfade, die irgendwo auftauchen.
  const paths = new Set<string>([
    ...local.keys(),
    ...remote.keys(),
    ...base.keys(),
  ]);

  for (const path of paths) {
    const l = local.get(path);
    const r = remote.get(path);
    const b = base.get(path);

    const localChanged = l ? !b || l.md5 !== b.md5 : false;
    // Drive liefert für manche Dateien KEINEN md5Checksum. Dann darf "kein Hash"
    // nicht als "geändert" gelten — sonst würde die Datei bei jedem Lauf neu
    // heruntergeladen (Endlos-Loop) und eine Löschung fälschlich als Änderung
    // gewertet. Fallback in dem Fall: mtime/Größe gegen die Base vergleichen.
    const remoteChanged = r
      ? !b ||
        (r.md5Checksum !== undefined
          ? r.md5Checksum !== b.md5
          : r.modifiedTimeMs > b.remoteMtime ||
            (r.size !== undefined && r.size !== b.size))
      : false;
    const contentEqual =
      !!l && !!r && !!r.md5Checksum && l.md5 === r.md5Checksum;

    // KERN DES LÖSCHSCHUTZES: Eine Datei gilt nur dann als "gelöscht", wenn die
    // Base bezeugt, dass sie auf DIESER Seite zuletzt tatsächlich existierte.
    //   - fehlt lokal, aber Base sagt b.local=true -> echte lokale Löschung
    //   - fehlt lokal, und b.local=false/keine Base -> war nie hier -> Neuzugang
    // So kann eine (z.B. aus anderem Vault kopierte) Base, die eine nie lokal
    // existente Datei nicht als local=true führt, keine Löschung auslösen.
    const localDeleted = !l && !!b && b.local;
    const remoteDeleted = !r && !!b && b.remote;

    // --- Fall 1: nirgends (mehr) vorhanden ---
    if (!l && !r) {
      // Nichts zu tun. (Ein evtl. Base-Eintrag wird von der Engine bereinigt.)
      continue;
    }

    // --- Fall 2: nur lokal vorhanden, war nie/nicht in Drive -> hochladen ---
    if (l && !r && !remoteDeleted) {
      actions.push({ type: "upload", path });
      continue;
    }

    // --- Fall 3: nur remote vorhanden ---
    if (!l && r && !localDeleted) {
      // Sonderfall "bewusst nur-remote" (keptRemoteOnly): lokal gelöscht, aber
      // via "Do not delete in Google Drive" in Drive behalten und absichtlich
      // NICHT lokal wiederhergestellt. Solange die Drive-Datei unverändert ist,
      // NICHT herunterladen (kein Zombie). Erst wenn sich die Drive-Datei ändert
      // (neue Version), gewinnt sie -> Download.
      // WICHTIG: nur bei gesetztem keptRemoteOnly — eine bloße local=false-Base
      // (z.B. kopiert/fremd) wird weiterhin heruntergeladen (Datenverlustschutz).
      if (b?.keptRemoteOnly && !remoteChanged) {
        actions.push({ type: "noop", path });
      } else {
        actions.push({ type: "download", path, driveId: r.id });
      }
      continue;
    }

    // --- Fall 4: beidseitig vorhanden, aber keine (gültige) Base -> Kollision ---
    if (l && r && !b) {
      if (contentEqual) {
        actions.push({ type: "noop", path });
      } else {
        actions.push({
          type: "conflict",
          path,
          driveId: r.id,
          winner: l.mtimeMs >= r.modifiedTimeMs ? "local" : "remote",
        });
      }
      continue;
    }

    // --- Fall 6: lokal gelöscht (fehlt lokal, war laut Base lokal da) ---
    if (localDeleted && r) {
      if (remoteChanged) {
        // Remote wurde nach dem letzten Sync geändert -> Änderung schlägt
        // Löschung: zurück nach lokal holen (kein Datenverlust).
        actions.push({ type: "download", path, driveId: r.id });
      } else if (neverDeleteRemote) {
        // Setting "Do not delete in Google Drive": Drive-Datei behalten, nur
        // den Base-Eintrag auf nur-remote setzen (kein Zombie lokal).
        actions.push({ type: "keepRemoteDropLocal", path, driveId: r.id });
      } else {
        // Remote unverändert -> Löschung propagieren (Papierkorb).
        actions.push({ type: "deleteRemote", path, driveId: r.id });
      }
      continue;
    }

    // --- Fall 7: remote gelöscht (fehlt remote, war laut Base remote da) ---
    if (remoteDeleted && l) {
      if (localChanged) {
        // Lokal wurde geändert -> Änderung schlägt Löschung: hochladen.
        actions.push({ type: "upload", path });
      } else {
        // Lokal unverändert -> lokale Löschung propagieren.
        actions.push({ type: "deleteLocal", path });
      }
      continue;
    }

    // Ab hier: beide vorhanden mit Base. (l und r gesetzt.)
    if (!l || !r) continue; // Typ-Guard (theoretisch unerreichbar)

    // --- Fall 8: keine Seite geändert ---
    if (!localChanged && !remoteChanged) {
      actions.push({ type: "noop", path });
      continue;
    }

    // --- Fall 9: nur lokal geändert ---
    if (localChanged && !remoteChanged) {
      actions.push({ type: "upload", path });
      continue;
    }

    // --- Fall 10: nur remote geändert ---
    if (!localChanged && remoteChanged) {
      actions.push({ type: "download", path, driveId: r.id });
      continue;
    }

    // --- Fall 11: beide geändert ---
    if (contentEqual) {
      // Zufällig identisch -> nur Base aktualisieren.
      actions.push({ type: "noop", path });
    } else {
      actions.push({
        type: "conflict",
        path,
        driveId: r.id,
        winner: l.mtimeMs >= r.modifiedTimeMs ? "local" : "remote",
      });
    }
  }

  return actions;
}

/** Eingaben für den Ordner-Reconcile (Existenz auf beiden Seiten + Base). */
export interface ReconcileFoldersInput {
  /** Aktuell lokal vorhandene Ordner (relative Pfade). */
  local: Set<string>;
  /** Aktuell in Drive vorhandene Ordner: Pfad -> Drive-ID. */
  remote: Map<string, string>;
  /** Ordner-Base vom letzten Sync: Pfad -> Eintrag (isFolder=true). */
  base: Map<string, SyncStateEntry>;
  /**
   * "Do not delete in Google Drive": Wenn true, wird ein lokal gelöschter
   * Ordner NICHT aus Drive entfernt (analog zu Dateien). Standard: false.
   */
  neverDeleteRemote?: boolean;
}

/**
 * Reconcile für Ordner — analog zu Dateien, aber ohne Inhalt/Hash. Es zählt
 * nur die Existenz plus die local/remote-Flags der Base.
 *
 * Löschregel wie bei Dateien: Ein Ordner wird nur dann auf einer Seite gelöscht,
 * wenn die Base bezeugt, dass er dort zuletzt existierte (b.local bzw. b.remote).
 * Sonst gilt er als Neuzugang und wird auf der anderen Seite angelegt.
 */
export function reconcileFolders(
  input: ReconcileFoldersInput
): FolderAction[] {
  const { local, remote, base, neverDeleteRemote = false } = input;
  const actions: FolderAction[] = [];

  const paths = new Set<string>([
    ...local,
    ...remote.keys(),
    ...base.keys(),
  ]);

  for (const path of paths) {
    const l = local.has(path);
    const r = remote.has(path);
    const b = base.get(path);

    const localDeleted = !l && !!b && b.local;
    const remoteDeleted = !r && !!b && b.remote;

    // Beide vorhanden -> nichts zu tun.
    if (l && r) {
      actions.push({ type: "noopFolder", path });
      continue;
    }

    // Nur lokal, und nicht als remote-gelöscht bekannt -> in Drive anlegen.
    if (l && !r && !remoteDeleted) {
      actions.push({ type: "createRemoteFolder", path });
      continue;
    }

    // Nur remote vorhanden.
    if (!l && r && !localDeleted) {
      // "Bewusst nur-remote" (keptRemoteOnly): Ordner in Drive behalten, lokal
      // NICHT wiederherstellen (kein Zombie). Sonst: lokal anlegen.
      if (b?.keptRemoteOnly) {
        actions.push({ type: "noopFolder", path });
      } else {
        actions.push({ type: "createLocalFolder", path });
      }
      continue;
    }

    // Lokal gelöscht (war laut Base lokal da).
    if (localDeleted && r) {
      const driveId = remote.get(path)!;
      if (neverDeleteRemote) {
        // "Do not delete in Google Drive": Ordner in Drive behalten.
        actions.push({ type: "keepRemoteFolder", path, driveId });
      } else {
        actions.push({ type: "deleteRemoteFolder", path, driveId });
      }
      continue;
    }

    // Remote gelöscht (war laut Base remote da) -> lokal löschen.
    if (remoteDeleted && l) {
      actions.push({ type: "deleteLocalFolder", path });
      continue;
    }

    // Sonst (z.B. beidseitig weg) -> nichts; Base-Eintrag wird bereinigt.
  }

  return actions;
}
