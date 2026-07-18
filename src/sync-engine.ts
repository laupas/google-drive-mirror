import { Notice, TFile, TFolder, Vault, normalizePath } from "obsidian";
import { GoogleDriveClient } from "./drive-client";
import { LocalFile, reconcile, reconcileFolders } from "./reconciler";
import { SyncStateStore } from "./sync-state";
import { SyncStatus } from "./sync-status";
import { log } from "./logger";
import { t } from "./i18n";
import { isIgnored, parseIgnorePatterns } from "./ignore";
import {
  DriveFile,
  FolderAction,
  PluginSettings,
  SyncAction,
  SyncStateEntry,
  SyncSummary,
} from "./types";

/** md5 aus dem Node-Crypto-Modul (Desktop-only Plugin). */
import { createHash } from "crypto";

/**
 * Nach so vielen ausgeführten (echten) Aktionen wird der Sync-State
 * zwischengespeichert ("Checkpoint"). Schützt große Läufe gegen Abbruch, ohne
 * nach jeder Datei die komplette State-Datei neu zu schreiben (O(n²)-Writes).
 */
const CHECKPOINT_EVERY = 50;

/**
 * Eingefrorene Kopie der scope-relevanten Settings-Felder für die Dauer EINES
 * Sync-Laufs. Verhindert, dass ein Ordner-/Scope-Wechsel mitten im Lauf live
 * durchschlägt (siehe `SyncEngine.active`).
 */
interface ScopeSnapshot {
  driveFolderId: string;
  driveSharedId: string;
  localFolder: string;
  allowedExtensions: string;
  /** Vorgeparste Ignore-Muster (Blacklist) für die Dauer des Laufs. */
  ignorePatterns: string[];
}

/** Leerer Scope-Snapshot (vor dem ersten Lauf). */
function emptyScope(): ScopeSnapshot {
  return {
    driveFolderId: "",
    driveSharedId: "",
    localFolder: "",
    allowedExtensions: "",
    ignorePatterns: [],
  };
}

/**
 * Orchestriert einen vollständigen 2-Wege-Sync-Lauf:
 *   1. Lokalen Stand erheben (Hashes im Sync-Ordner) + Ordner.
 *   2. Drive-Stand abrufen (Dateien + Ordner).
 *   3. Reconciler befragen (Dateien und Ordner).
 *   4. Aktionen ausführen (Ordner anlegen → Dateien → Ordner löschen).
 *   5. Sync-Base aktualisieren und persistieren.
 *
 * Der Löschschutz steckt im Reconciler (Löschung nur bei bezeugter beidseitiger
 * Existenz via local/remote-Flags) — deshalb keine separate Löschungs-Rückfrage.
 *
 * Läufe sind serialisiert (kein paralleler Sync) über ein Running-Flag.
 */
export class SyncEngine {
  private running = false;

  /**
   * Snapshot der scope-relevanten Settings-Felder für die Dauer EINES Laufs.
   * `settings` ist ein von main.ts/OAuth/SettingsTab geteiltes, veränderliches
   * Objekt — ein Ordnerwechsel mitten im Lauf würde sonst live durchschlagen
   * (z.B. `localFolder`-Präfix ändert sich zwischen collectLocal und
   * applyAction → Pfade passen nicht mehr zueinander). Wird in sync() gesetzt.
   */
  private active: ScopeSnapshot = emptyScope();

  constructor(
    private vault: Vault,
    private drive: GoogleDriveClient,
    private state: SyncStateStore,
    private settings: PluginSettings,
    private status: SyncStatus
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Führt einen kompletten Sync durch. Gibt eine Zusammenfassung zurück.
   * Bei parallelem Aufruf wird der zweite Aufruf übersprungen.
   */
  async sync(showNotice = true): Promise<SyncSummary | null> {
    if (this.running) {
      return null;
    }
    if (!this.settings.driveFolderId) {
      if (showNotice) new Notice(t("engineNoDriveFolder"));
      return null;
    }

    this.running = true;
    // Scope-Felder für die gesamte Laufzeit einfrieren (siehe `active`).
    this.active = {
      driveFolderId: this.settings.driveFolderId,
      driveSharedId: this.settings.driveSharedId,
      localFolder: this.settings.localFolder,
      allowedExtensions: this.settings.allowedExtensions,
      ignorePatterns: parseIgnorePatterns(this.settings.ignorePatterns),
    };
    const summary: SyncSummary = {
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      conflicts: 0,
      errors: [],
    };

    this.status.start(t("statusSyncStarted"), Date.now());

    try {
      // Ordner-Cache pro Lauf leeren (IDs könnten sich extern geändert haben).
      this.drive.clearFolderCache();

      this.status.update(t("engineReadingLocal"), 0);
      const local = await this.collectLocal();
      const localFolders = this.collectLocalFolders(local.keys());

      this.status.update(t("engineFetchingDrive"), 0);
      const listing = await this.drive.listFiles(
        this.active.driveFolderId,
        this.active.driveSharedId || undefined
      );

      // Dateien nach vault-relativem Pfad indizieren.
      //
      // Drive erlaubt MEHRERE nicht-getrashte Dateien mit demselben Namen im
      // selben Ordner (verschiedene IDs). Auf denselben vault-relativen Pfad
      // abgebildet würden sie sich in einer Map gegenseitig überschreiben — der
      // Reconciler sähe nur eine, und ein deleteRemote/Conflict träfe evtl. die
      // falsche ID. Deshalb erst nach Pfad GRUPPIEREN, dann auflösen.
      const remoteByPath = new Map<string, DriveFile[]>();
      for (const f of listing.files) {
        // Google-Editors-Dateien (Docs/Sheets/Slides) haben keinen
        // downloadbaren Binärinhalt -> immer überspringen.
        if (isGoogleAppsFile(f.mimeType)) continue;
        const path = normalizePath(this.drive.pathOf(f));
        // Systemordner (.obsidian/.trash/…) nie herunterladen.
        if (isSystemPath(path)) continue;
        // Optionaler Dateiendungs-Filter (gilt auch für Drive-Seite).
        if (!this.extensionAllowed(path)) continue;
        // Ignore-Muster (Blacklist) — beidseitig, s. collectLocal().
        if (this.isIgnored(path)) continue;
        const list = remoteByPath.get(path);
        if (list) list.push(f);
        else remoteByPath.set(path, [f]);
      }

      // Kollisionen auflösen: Sind ALLE Duplikate INHALTSGLEICH (gleicher,
      // vorhandener md5), ist die Wahl egal — wir nehmen eine stabile (kleinste
      // Drive-ID) und syncen normal. Weichen die Inhalte ab (oder fehlt ein
      // md5, sodass Gleichheit nicht beweisbar ist), ist echte Mehrdeutigkeit:
      // Pfad KOMPLETT überspringen (beide Seiten), statt eine Datei zu raten.
      const remote = new Map<string, DriveFile>();
      for (const [path, dups] of remoteByPath) {
        if (dups.length === 1) {
          remote.set(path, dups[0]);
          continue;
        }
        const first = dups[0].md5Checksum;
        const allSameContent =
          !!first && dups.every((d) => d.md5Checksum === first);
        if (allSameContent) {
          // Inhaltsgleich -> deterministisch die kleinste ID wählen.
          const chosen = dups.reduce((a, b) => (a.id <= b.id ? a : b));
          remote.set(path, chosen);
          this.status.append(
            "info",
            t("engineDuplicateSameContent", { path })
          );
          continue;
        }
        // Echte Mehrdeutigkeit: Pfad auf beiden Seiten aus der Reconciliation
        // nehmen, damit er nicht als „nur lokal → hochladen/löschen" gilt.
        local.delete(path);
        const detail = t("engineDuplicateDifferent", { path });
        summary.errors.push(detail);
        this.status.append("error", detail);
        log.warn("Pfad-Kollision in Drive:", detail);
      }

      // Drive-Ordner nach Pfad indizieren (Systemordner ausgeschlossen).
      // Gleiche Kollisionslogik wie bei Dateien: doppelte Ordnernamen (gleicher
      // Pfad, verschiedene IDs) werden übersprungen, statt eine ID zu wählen —
      // ein deleteRemoteFolder auf die falsche ID würde einen ganzen Teilbaum
      // in den Papierkorb verschieben.
      const remoteFolders = new Map<string, string>();
      const collidingFolderPaths = new Set<string>();
      for (const folder of listing.folders) {
        const path = normalizePath(folder.relativePath);
        if (isSystemPath(path)) continue;
        if (this.isIgnored(path)) continue;
        if (remoteFolders.has(path)) {
          collidingFolderPaths.add(path);
          continue;
        }
        remoteFolders.set(path, folder.id);
      }
      for (const path of collidingFolderPaths) {
        remoteFolders.delete(path);
        localFolders.delete(path);
        const detail = t("engineDuplicateFolder", { path });
        summary.errors.push(detail);
        this.status.append("error", detail);
        log.warn("Ordner-Pfad-Kollision in Drive:", detail);
      }

      this.status.append(
        "info",
        t("engineCountSummary", {
          localFiles: local.size,
          remoteFiles: remote.size,
          localFolders: localFolders.size,
          remoteFolders: remoteFolders.size,
        })
      );

      // Base in Datei- und Ordner-Einträge trennen.
      const base = new Map<string, SyncStateEntry>();
      const folderBase = new Map<string, SyncStateEntry>();
      for (const e of this.state.all()) {
        if (e.isFolder) folderBase.set(e.path, e);
        else base.set(e.path, e);
      }

      const actions = reconcile({
        local,
        remote,
        base,
        neverDeleteRemote: this.settings.neverDeleteRemote,
      });
      const folderActions = reconcileFolders({
        local: localFolders,
        remote: remoteFolders,
        base: folderBase,
        neverDeleteRemote: this.settings.neverDeleteRemote,
      });

      // Nur „echte" Aktionen zählen (noop nicht als Fortschrittsschritt).
      const work = actions.filter((a) => a.type !== "noop");
      this.status.setTotal(work.length);
      if (work.length === 0) {
        this.status.append("info", t("engineNoChanges"));
      }

      // 1) Ordner ANLEGEN (vor Dateien, damit Zielordner existieren).
      //    Nach Pfadtiefe sortiert: Elternordner zuerst.
      const folderCreates = folderActions
        .filter(
          (a) =>
            a.type === "createLocalFolder" || a.type === "createRemoteFolder"
        )
        .sort((a, b) => depth(a.path) - depth(b.path));
      for (const fa of folderCreates) {
        try {
          await this.applyFolderAction(fa, remoteFolders, summary);
        } catch (e) {
          const detail = t("engineActionError", {
            type: fa.type,
            path: fa.path,
            error: errMsg(e),
          });
          summary.errors.push(detail);
          this.status.append("error", detail);
          log.error("Ordner-Aktion fehlgeschlagen:", detail, e);
        }
      }

      // 2) Datei-Aktionen. Alle CHECKPOINT_EVERY Aktionen den State sichern,
      //    damit ein Abbruch (App zu / Absturz) bei großen Läufen nur die
      //    letzten paar Aktionen kostet, nicht den gesamten Fortschritt.
      let done = 0;
      let sinceCheckpoint = 0;
      for (const action of actions) {
        if (action.type !== "noop") {
          done++;
          this.status.update(
            t("engineActionProgress", {
              action: describeAction(action),
              done,
              total: work.length,
            }),
            done,
            work.length
          );
        }
        try {
          await this.applyAction(action, local, remote, summary);
          if (action.type !== "noop") {
            this.status.append(
              "info",
              t("engineActionDone", { action: describeAction(action) })
            );
            sinceCheckpoint++;
            if (sinceCheckpoint >= CHECKPOINT_EVERY) {
              sinceCheckpoint = 0;
              await this.checkpoint();
            }
          }
        } catch (e) {
          const detail = t("engineActionError", {
            type: action.type,
            path: pathOfAction(action),
            error: errMsg(e),
          });
          summary.errors.push(detail);
          this.status.append("error", detail);
          // Vollständigen Fehler in die Developer-Console schreiben.
          log.error("Aktion fehlgeschlagen:", detail, e);
        }
      }

      // 3) Ordner LÖSCHEN / BEHALTEN (nach Dateien; tiefste zuerst).
      //    keepRemoteFolder macht keine Drive-Operation, nur State — schadet in
      //    dieser Phase nicht und hält die Ordner-Behandlung an einer Stelle.
      const folderDeletes = folderActions
        .filter(
          (a) =>
            a.type === "deleteLocalFolder" ||
            a.type === "deleteRemoteFolder" ||
            a.type === "keepRemoteFolder"
        )
        .sort((a, b) => depth(b.path) - depth(a.path));
      for (const fa of folderDeletes) {
        // SICHERHEITSNETZ gegen Teilbaum-Verlust: `trashFolder` schiebt einen
        // Drive-Ordner SAMT INHALT in den Papierkorb. Ein deleteRemoteFolder
        // darf daher nur laufen, wenn im aktuellen Listing keine Drive-Datei
        // mehr unter diesem Ordner liegt. Meldet die lokale Ordner-Erhebung
        // fälschlich „Ordner fehlt lokal" (z.B. transienter Cache-Aussetzer),
        // würde sonst ein befüllter Remote-Teilbaum gelöscht.
        if (
          fa.type === "deleteRemoteFolder" &&
          this.remoteSubtreeHasFiles(fa.path, remote)
        ) {
          const detail = t("engineRemoteFolderNotDeleted", { path: fa.path });
          summary.errors.push(detail);
          this.status.append("error", detail);
          log.warn("deleteRemoteFolder übersprungen:", detail);
          continue;
        }
        try {
          await this.applyFolderAction(fa, remoteFolders, summary);
        } catch (e) {
          const detail = t("engineActionError", {
            type: fa.type,
            path: fa.path,
            error: errMsg(e),
          });
          summary.errors.push(detail);
          this.status.append("error", detail);
          log.error("Ordner-Aktion fehlgeschlagen:", detail, e);
        }
      }

      // 4) noopFolder-Einträge im State auffrischen. Meist "beide Seiten
      //    vorhanden" (local=remote=true). Ein bewusst nur-remote gehaltener
      //    Ordner (keptRemoteOnly, lokal nicht vorhanden) muss aber ERHALTEN
      //    bleiben, sonst würde er als beidseitig markiert und der Ordner käme
      //    beim nächsten Lauf lokal zurück (Zombie).
      for (const fa of folderActions) {
        if (fa.type !== "noopFolder") continue;
        const prev = this.state.get(fa.path);
        if (prev?.keptRemoteOnly && !localFolders.has(fa.path)) {
          // nur-remote-Ordner unverändert lassen
          continue;
        }
        this.state.set(this.folderEntry(fa.path, remoteFolders.get(fa.path)));
      }

      this.state.setLastSyncMs(Date.now());
      // Sync-State in eigene Datei persistieren (nicht data.json).
      await this.state.save();

      // Flag VOR finish() zurücksetzen: finish() feuert das Status-Abo, das den
      // Sync-Button anhand isRunning() aktualisiert — sonst bliebe er deaktiviert.
      this.running = false;

      const finalMsg = summaryText(summary);
      this.status.finish(
        summary.errors.length ? "error" : "done",
        finalMsg
      );

      if (showNotice) {
        // Bei Fehlern die Notice länger anzeigen, damit Details lesbar sind.
        const duration = summary.errors.length ? 15000 : undefined;
        new Notice(formatSummary(summary), duration);
      }
      return summary;
    } catch (e) {
      this.running = false;
      const msg = t("engineSyncFailed", { error: errMsg(e) });
      summary.errors.push(msg);
      this.status.finish("error", msg);
      if (showNotice) new Notice(t("engineNoticePrefix", { message: msg }));
      return summary;
    } finally {
      // Sicherheitsnetz, falls oben ein Pfad das Flag nicht zurückgesetzt hat.
      this.running = false;
    }
  }

  /**
   * Zwischenspeichert den Sync-State während eines laufenden Syncs. Setzt
   * bewusst NICHT `lastSyncMs` — der Lauf gilt erst am Ende als abgeschlossen.
   * Ein Checkpoint enthält nur Einträge abgeschlossener Übertragungen und ist
   * damit jederzeit ein konsistenter Teilzustand. Fehler beim Schreiben brechen
   * den Sync nicht ab (nur Logeintrag).
   */
  private async checkpoint(): Promise<void> {
    try {
      await this.state.save();
    } catch (e) {
      log.error("Checkpoint-Speichern fehlgeschlagen:", e);
    }
  }

  /** Führt eine einzelne Reconcile-Aktion aus und aktualisiert die Base. */
  private async applyAction(
    action: SyncAction,
    local: Map<string, LocalFile>,
    remote: Map<string, DriveFile>,
    summary: SyncSummary
  ): Promise<void> {
    switch (action.type) {
      case "noop": {
        // Base aktualisieren, damit künftige Läufe konsistent sind.
        const l = local.get(action.path);
        const r = remote.get(action.path);
        const prev = this.state.get(action.path);
        if (l && r) {
          this.state.set(this.entryFrom(action.path, r, l));
        } else if (!l && r && prev?.keptRemoteOnly) {
          // "Bewusst nur-remote" (keptRemoteOnly): Eintrag ERHALTEN, damit die
          // Datei nicht beim nächsten Lauf als Neuzugang heruntergeladen wird.
          // remoteMtime/md5 auffrischen, damit ein späterer Drive-Edit als
          // Änderung erkannt wird (-> dann Download).
          this.state.set({
            path: action.path,
            local: false,
            remote: true,
            keptRemoteOnly: true,
            isFolder: false,
            driveId: r.id,
            md5: r.md5Checksum ?? prev.md5,
            size: r.size ?? prev.size,
            localMtime: prev.localMtime,
            remoteMtime: r.modifiedTimeMs,
          });
        } else {
          this.state.delete(action.path);
        }
        return;
      }

      case "upload": {
        const l = local.get(action.path);
        if (!l) return;
        const content = await this.readLocal(action.path);
        const existing = remote.get(action.path);
        const uploaded = existing
          ? await this.drive.updateFile(existing.id, action.path, content)
          : await this.drive.createFile(
              this.active.driveFolderId,
              action.path,
              content,
              this.active.driveSharedId || undefined
            );
        this.state.set(this.entryFrom(action.path, uploaded, l));
        summary.uploaded++;
        return;
      }

      case "download": {
        const content = await this.drive.downloadFile(action.driveId);
        await this.writeLocal(action.path, content);
        const r = remote.get(action.path);
        const l = await this.freshLocal(action.path);
        if (r && l) this.state.set(this.entryFrom(action.path, r, l));
        summary.downloaded++;
        return;
      }

      case "deleteLocal": {
        await this.trashLocal(action.path);
        this.state.delete(action.path);
        summary.deletedLocal++;
        return;
      }

      case "deleteRemote": {
        await this.drive.trashFile(action.driveId);
        this.state.delete(action.path);
        summary.deletedRemote++;
        return;
      }

      case "keepRemoteDropLocal": {
        // Setting "Do not delete in Google Drive": Drive-Datei NICHT anfassen,
        // nur den Base-Eintrag auf nur-remote setzen. Damit gilt die Datei beim
        // nächsten Lauf nicht mehr als "lokal gelöscht" (kein deleteRemote) und
        // auch nicht als "neu in Drive" (kein Download-Zombie). Über den
        // "Nur in Drive"-Baum kann local wieder aktiviert werden (-> Download).
        const prev = this.state.get(action.path);
        this.state.set({
          path: action.path,
          local: false,
          remote: true,
          keptRemoteOnly: true,
          isFolder: false,
          driveId: action.driveId,
          md5: prev?.md5 ?? "",
          size: prev?.size ?? 0,
          localMtime: prev?.localMtime ?? 0,
          remoteMtime: prev?.remoteMtime ?? 0,
        });
        return;
      }

      case "conflict": {
        summary.conflicts++;
        if (action.winner === "local") {
          const l = local.get(action.path);
          if (!l) return;
          const content = await this.readLocal(action.path);
          const uploaded = await this.drive.updateFile(
            action.driveId,
            action.path,
            content
          );
          this.state.set(this.entryFrom(action.path, uploaded, l));
          summary.uploaded++;
        } else {
          const content = await this.drive.downloadFile(action.driveId);
          await this.writeLocal(action.path, content);
          const r = remote.get(action.path);
          const l = await this.freshLocal(action.path);
          if (r && l) this.state.set(this.entryFrom(action.path, r, l));
          summary.downloaded++;
        }
        return;
      }
    }
  }

  // ---------- Lokale Datei-Helfer ----------

  /** Erhebt Hash/Größe/mtime aller Dateien im konfigurierten Sync-Ordner. */
  private async collectLocal(): Promise<Map<string, LocalFile>> {
    const result = new Map<string, LocalFile>();
    const prefix = this.folderPrefix();

    for (const file of this.vault.getFiles()) {
      if (!this.inScope(file.path)) continue;
      if (!this.extensionAllowed(file.path)) continue;
      const rel = this.toRelative(file.path, prefix);
      // Ignore-Muster prüfen den SYNC-RELATIVEN Pfad (wie die Drive-Seite).
      if (this.isIgnored(rel)) continue;
      const content = await this.vault.adapter.readBinary(file.path);
      const md5 = md5Hex(content);
      result.set(rel, {
        path: rel,
        md5,
        size: content.byteLength,
        mtimeMs: file.stat.mtime,
      });
    }
    return result;
  }

  /**
   * Erhebt alle lokalen Ordner im Scope (relative Pfade).
   *
   * Zwei Quellen, vereinigt:
   *  1. Die Elternordner-Kette JEDER gesammelten Datei (`fileRelPaths`). Das ist
   *     die AUTORITATIVE Quelle: ein Ordner, der eine gesyncte Datei enthält,
   *     existiert garantiert. Ohne diese Ableitung könnte ein transienter
   *     Aussetzer von `getAllLoadedFiles()` einen befüllten Ordner als „fehlt
   *     lokal" melden → `deleteRemoteFolder` würde den ganzen Drive-Teilbaum in
   *     den Papierkorb schieben (Datenverlust).
   *  2. `getAllLoadedFiles()` (TFolder) — nur nötig, um zusätzlich LEERE Ordner
   *     zu erfassen (die haben keine Datei, aus der man sie ableiten könnte).
   *
   * Systemordner und die Wurzel selbst sind ausgeschlossen.
   */
  private collectLocalFolders(fileRelPaths: Iterable<string>): Set<string> {
    const prefix = this.folderPrefix();
    const result = new Set<string>();

    // 1) Ordner aus den Elternketten der gesammelten Dateien ableiten.
    //    (fileRelPaths enthält bereits nur nicht-ignorierte Dateien; ein
    //    Elternordner einer erlaubten Datei ist bewusst NICHT ignoriert.)
    for (const rel of fileRelPaths) {
      let idx = rel.lastIndexOf("/");
      while (idx > 0) {
        result.add(rel.slice(0, idx));
        idx = rel.lastIndexOf("/", idx - 1);
      }
    }

    // 2) Zusätzlich leere Ordner aus dem geladenen Vault-Baum aufnehmen.
    for (const f of this.vault.getAllLoadedFiles()) {
      if (!(f instanceof TFolder)) continue;
      if (f.isRoot()) continue;
      if (!this.inScope(f.path)) continue;
      const rel = this.toRelative(f.path, prefix);
      if (rel && !this.isIgnored(rel)) result.add(rel);
    }
    return result;
  }

  /**
   * Liegt im aktuellen Drive-Listing noch (mindestens) eine Datei unterhalb des
   * Ordners `folderPath`? Dient als Schutz gegen das Trashen eines befüllten
   * Remote-Teilbaums (siehe deleteRemoteFolder-Sicherheitsnetz).
   */
  private remoteSubtreeHasFiles(
    folderPath: string,
    remote: Map<string, DriveFile>
  ): boolean {
    const prefix = folderPath + "/";
    for (const path of remote.keys()) {
      if (path.startsWith(prefix)) return true;
    }
    return false;
  }

  /** Führt eine einzelne Ordner-Aktion aus und pflegt den State. */
  private async applyFolderAction(
    action: FolderAction,
    remoteFolders: Map<string, string>,
    summary: SyncSummary
  ): Promise<void> {
    switch (action.type) {
      case "createRemoteFolder": {
        const id = await this.drive.createFolderPath(
          this.active.driveFolderId,
          action.path,
          this.active.driveSharedId || undefined
        );
        remoteFolders.set(action.path, id);
        this.state.set(this.folderEntry(action.path, id));
        this.status.append(
          "info",
          `📁 ${t("engineRemoteFolderCreated", { path: action.path })}`
        );
        return;
      }
      case "createLocalFolder": {
        const abs = this.toAbsolute(action.path);
        if (!(await this.vault.adapter.exists(abs))) {
          await this.vault.adapter.mkdir(abs);
        }
        this.state.set(
          this.folderEntry(action.path, remoteFolders.get(action.path))
        );
        this.status.append(
          "info",
          `📁 ${t("engineLocalFolderCreated", { path: action.path })}`
        );
        return;
      }
      case "deleteRemoteFolder": {
        await this.drive.trashFolder(action.driveId);
        this.state.delete(action.path);
        this.status.append(
          "info",
          `🗑 ${t("engineRemoteFolderDeleted", { path: action.path })}`
        );
        return;
      }
      case "deleteLocalFolder": {
        const abs = this.toAbsolute(action.path);
        const folder = this.vault.getAbstractFileByPath(abs);
        if (folder) {
          // false = Obsidian-.trash im Vault (nicht endgültig).
          await this.vault.trash(folder, false);
        } else if (await this.vault.adapter.exists(abs)) {
          await this.vault.adapter.trashLocal(abs);
        }
        this.state.delete(action.path);
        this.status.append(
          "info",
          `🗑 ${t("engineLocalFolderDeleted", { path: action.path })}`
        );
        return;
      }
      case "keepRemoteFolder": {
        // "Do not delete in Google Drive": Drive-Ordner NICHT anfassen, nur den
        // Base-Eintrag auf nur-remote (keptRemoteOnly) setzen.
        this.state.set({
          path: action.path,
          local: false,
          remote: true,
          keptRemoteOnly: true,
          isFolder: true,
          driveId: action.driveId,
          md5: "",
          size: 0,
          localMtime: 0,
          remoteMtime: 0,
        });
        this.status.append(
          "info",
          `↛ ${t("engineFolderKeptRemote", { path: action.path })}`
        );
        return;
      }
      case "noopFolder":
        return;
    }
  }

  /** Baut einen Ordner-State-Eintrag (local & remote true, isFolder true). */
  private folderEntry(path: string, driveId?: string): SyncStateEntry {
    return {
      path,
      local: true,
      remote: true,
      isFolder: true,
      driveId: driveId ?? "",
      md5: "",
      size: 0,
      localMtime: 0,
      remoteMtime: 0,
    };
  }

  private async freshLocal(relPath: string): Promise<LocalFile | null> {
    const abs = this.toAbsolute(relPath);
    if (!(await this.vault.adapter.exists(abs))) return null;
    const content = await this.vault.adapter.readBinary(abs);
    const stat = await this.vault.adapter.stat(abs);
    return {
      path: relPath,
      md5: md5Hex(content),
      size: content.byteLength,
      mtimeMs: stat?.mtime ?? Date.now(),
    };
  }

  private async readLocal(relPath: string): Promise<ArrayBuffer> {
    return this.vault.adapter.readBinary(this.toAbsolute(relPath));
  }

  private async writeLocal(relPath: string, content: ArrayBuffer): Promise<void> {
    const abs = this.toAbsolute(relPath);
    await this.ensureParentDir(abs);
    await this.vault.adapter.writeBinary(abs, content);
  }

  /**
   * Verschiebt eine lokale Datei in Obsidians `.trash`-Ordner im Vault
   * (nicht in den System-Papierkorb). `vault.trash(file, false)` = Vault-.trash.
   * Fallback `trashLocal` des Adapters landet ebenfalls im Vault-.trash.
   */
  private async trashLocal(relPath: string): Promise<void> {
    const abs = this.toAbsolute(relPath);
    const file = this.vault.getAbstractFileByPath(abs);
    if (file instanceof TFile) {
      // false = Obsidian-.trash im Vault (nicht endgültig gelöscht).
      await this.vault.trash(file, false);
    } else if (await this.vault.adapter.exists(abs)) {
      await this.vault.adapter.trashLocal(abs);
    }
  }

  private async ensureParentDir(absPath: string): Promise<void> {
    const idx = absPath.lastIndexOf("/");
    if (idx <= 0) return;
    const dir = absPath.slice(0, idx);
    if (!(await this.vault.adapter.exists(dir))) {
      await this.vault.adapter.mkdir(dir);
    }
  }

  // ---------- Pfad-/Scope-Helfer ----------

  /**
   * Prüft, ob die Dateiendung laut Filter erlaubt ist. Leerer Filter =
   * alles erlaubt. Vergleich case-insensitive, ohne führenden Punkt.
   */
  private extensionAllowed(path: string): boolean {
    const raw = this.active.allowedExtensions.trim();
    if (!raw) return true;
    const allowed = raw
      .split(",")
      .map((e) => e.trim().replace(/^\./, "").toLowerCase())
      .filter((e) => e.length > 0);
    if (allowed.length === 0) return true;
    const dot = path.lastIndexOf(".");
    const ext = dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
    return allowed.includes(ext);
  }

  /**
   * Ist der (sync-relative) Pfad durch ein Ignore-Muster ausgeschlossen? Wird
   * auf BEIDEN Seiten angewandt (lokal + Drive, Dateien + Ordner), damit eine
   * ignorierte Datei nicht als „einseitig gelöscht" gilt. Muster sind in
   * `active.ignorePatterns` bereits vorgeparst.
   */
  private isIgnored(path: string): boolean {
    return isIgnored(path, this.active.ignorePatterns);
  }

  /** Ordnerpräfix inkl. abschließendem "/" ("" wenn ganzer Vault). */
  private folderPrefix(): string {
    const f = this.active.localFolder.trim();
    if (!f) return "";
    const norm = normalizePath(f);
    return norm.endsWith("/") ? norm : norm + "/";
  }

  /** Liegt der Vault-Pfad im konfigurierten Sync-Ordner (und nicht in einem Systemordner)? */
  private inScope(vaultPath: string): boolean {
    if (isSystemPath(vaultPath)) return false;
    const prefix = this.folderPrefix();
    if (!prefix) return true; // ganzer Vault
    return vaultPath === prefix.slice(0, -1) || vaultPath.startsWith(prefix);
  }

  /** Vault-Pfad -> Sync-relativer Pfad (ohne Ordnerpräfix). */
  private toRelative(vaultPath: string, prefix: string): string {
    return prefix && vaultPath.startsWith(prefix)
      ? vaultPath.slice(prefix.length)
      : vaultPath;
  }

  /** Sync-relativer Pfad -> vollständiger Vault-Pfad. */
  private toAbsolute(relPath: string): string {
    return normalizePath(this.folderPrefix() + relPath);
  }

  /**
   * Baut einen State-Eintrag für eine Datei, die soeben auf BEIDEN Seiten
   * präsent ist (nach Upload oder Download). Daher local=remote=true — das ist
   * die Voraussetzung, damit eine spätere Löschung überhaupt propagiert wird.
   */
  private entryFrom(
    path: string,
    remote: DriveFile,
    local: LocalFile
  ): SyncStateEntry {
    return {
      path,
      local: true,
      remote: true,
      isFolder: false,
      driveId: remote.id,
      md5: remote.md5Checksum ?? local.md5,
      size: remote.size ?? local.size,
      localMtime: local.mtimeMs,
      remoteMtime: remote.modifiedTimeMs,
    };
  }
}

function md5Hex(buf: ArrayBuffer): string {
  return createHash("md5").update(Buffer.from(buf)).digest("hex");
}

/** Pfadtiefe (Anzahl der "/"-Segmente) — für Ordner-Sortierung. */
function depth(path: string): number {
  return path.split("/").length;
}

function pathOfAction(a: SyncAction): string {
  return "path" in a ? a.path : "?";
}

/** Menschenlesbare Beschreibung einer Aktion für Status/Log. */
function describeAction(a: SyncAction): string {
  const p = pathOfAction(a);
  switch (a.type) {
    case "upload":
      return `↑ ${t("uploadAction", { path: p })}`;
    case "download":
      return `↓ ${t("downloadAction", { path: p })}`;
    case "deleteLocal":
      return `🗑 ${t("deleteLocalAction", { path: p })}`;
    case "deleteRemote":
      return `🗑 ${t("deleteRemoteAction", { path: p })}`;
    case "keepRemoteDropLocal":
      return `↛ ${t("keepRemoteDropLocalAction", { path: p })}`;
    case "conflict":
      return `⚔ ${t("conflictAction", {
        path: p,
        winner:
          a.winner === "local"
            ? t("conflictWinnerLocal")
            : t("conflictWinnerRemote"),
      })}`;
    default:
      return p;
  }
}

/** Kompakte Ergebniszeile für den finalen Status (ohne Notice-Formatierung). */
function summaryText(s: SyncSummary): string {
  const parts: string[] = [];
  if (s.uploaded) parts.push(t("summaryUploaded", { count: s.uploaded }));
  if (s.downloaded) parts.push(t("summaryDownloaded", { count: s.downloaded }));
  if (s.deletedRemote)
    parts.push(t("summaryDeletedRemote", { count: s.deletedRemote }));
  if (s.deletedLocal)
    parts.push(t("summaryDeletedLocal", { count: s.deletedLocal }));
  if (s.conflicts) parts.push(t("summaryConflicts", { count: s.conflicts }));
  const head = parts.length ? parts.join(", ") : t("summaryNoChanges");
  return s.errors.length
    ? t("summaryDoneWithErrors", { count: s.errors.length, head })
    : t("summaryDone", { head });
}

/**
 * Google-Editors-Dateien (Docs, Sheets, Slides, Forms …) und Ordner haben
 * einen "application/vnd.google-apps.*"-MIME-Typ und keinen downloadbaren
 * Binärinhalt. Solche Dateien können nicht 1:1 gesynct werden.
 */
function isGoogleAppsFile(mimeType: string): boolean {
  return mimeType.startsWith("application/vnd.google-apps");
}

/**
 * Pfade in Systemordnern, die niemals gesynct werden dürfen — v.a. der
 * Obsidian-Konfigurationsordner (Plugins, Themes, Settings, unser eigener
 * Sync-State). Greift besonders beim Sync des gesamten Vaults.
 */
function isSystemPath(vaultPath: string): boolean {
  const p = vaultPath.startsWith("/") ? vaultPath.slice(1) : vaultPath;
  return (
    p === ".obsidian" ||
    p.startsWith(".obsidian/") ||
    p === ".trash" ||
    p.startsWith(".trash/") ||
    p.split("/").pop() === ".DS_Store"
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function formatSummary(s: SyncSummary): string {
  const parts: string[] = [];
  if (s.uploaded) parts.push(`↑${s.uploaded}`);
  if (s.downloaded) parts.push(`↓${s.downloaded}`);
  if (s.deletedRemote)
    parts.push(`🗑${t("noticeDeletedRemote", { count: s.deletedRemote })}`);
  if (s.deletedLocal)
    parts.push(`🗑${t("noticeDeletedLocal", { count: s.deletedLocal })}`);
  if (s.conflicts) parts.push(`⚔${s.conflicts}`);
  const head = parts.length ? parts.join("  ") : t("summaryNoChanges");
  let errTail = "";
  if (s.errors.length) {
    // Erste bis zu 3 Fehlermeldungen direkt anzeigen; Rest zählen.
    const shown = s.errors.slice(0, 3).map((e) => `• ${e}`).join("\n");
    const more =
      s.errors.length > 3
        ? t("noticeErrorMore", { count: s.errors.length - 3 })
        : "";
    errTail = t("noticeErrorTail", { count: s.errors.length, shown, more });
  }
  return t("noticeSummary", { head, errTail });
}
