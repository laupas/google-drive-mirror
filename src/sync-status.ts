import { PluginStorage } from "./storage";
import { t } from "./i18n";

/**
 * Zentraler Sync-Status + Log. Beobachtbar über einfache Listener, damit
 * Statusleiste und Settings-UI live aktualisiert werden können.
 *
 * Das Log wird in einer eigenen Datei (`sync-log.json`) im Plugin-Ordner
 * persistiert (nicht data.json) und beim Speichern automatisch um Einträge
 * bereinigt, die älter als die konfigurierte Aufbewahrungsdauer sind.
 */

const LOG_FILE = "sync-log.json";

export type SyncPhase = "idle" | "running" | "done" | "error";

export interface SyncProgress {
  /** Aktuelle Phase. */
  phase: SyncPhase;
  /** Kurzer, menschenlesbarer Statustext (z.B. "Lade hoch 3/12"). */
  message: string;
  /** Erledigte Schritte im aktuellen Lauf. */
  current: number;
  /** Gesamtschritte im aktuellen Lauf (0 = unbekannt/keiner). */
  total: number;
  /** Startzeit des laufenden Syncs (ms) oder 0. */
  startedMs: number;
}

export interface LogEntry {
  /** Zeitstempel (ms). */
  ts: number;
  level: "info" | "success" | "warn" | "error";
  message: string;
}

export class SyncStatus {
  private progress: SyncProgress = {
    phase: "idle",
    message: t("statusReady"),
    current: 0,
    total: 0,
    startedMs: 0,
  };

  private log: LogEntry[] = [];
  private readonly maxLog = 500;
  private listeners = new Set<() => void>();
  private saveHandle: number | null = null;

  /**
   * @param storage         Persistenz-Helfer (optional; ohne wird nicht gespeichert).
   * @param retentionHours  Liefert die aktuelle Aufbewahrungsdauer in Stunden
   *                        (0 = nie löschen). Als Funktion, damit Settings-Änderungen
   *                        sofort greifen.
   */
  constructor(
    private storage?: PluginStorage,
    private retentionHours: () => number = () => 24
  ) {}

  /** Lädt das Log aus der Datei und wendet die Retention an. */
  async load(): Promise<void> {
    if (!this.storage) return;
    const data = await this.storage.readJson<{ entries?: LogEntry[] }>(
      LOG_FILE,
      {}
    );
    this.log = data.entries ?? [];
    this.pruneOld();
    this.emit();
  }

  /** Persistiert das Log (debounced), nach Retention-Bereinigung. */
  private scheduleSave(): void {
    if (!this.storage) return;
    if (this.saveHandle !== null) return; // bereits geplant
    this.saveHandle = setTimeout(() => {
      this.saveHandle = null;
      void this.save();
    }, 1000) as unknown as number;
  }

  async save(): Promise<void> {
    if (!this.storage) return;
    this.pruneOld();
    await this.storage.writeJson(LOG_FILE, { version: 1, entries: this.log });
  }

  /** Entfernt Einträge, die älter als die Aufbewahrungsdauer sind. */
  private pruneOld(): void {
    const hours = this.retentionHours();
    if (hours > 0) {
      const cutoff = nowMs() - hours * 3600_000;
      this.log = this.log.filter((e) => e.ts >= cutoff);
    }
    if (this.log.length > this.maxLog) {
      this.log.splice(0, this.log.length - this.maxLog);
    }
  }

  /** Abonniert Änderungen; gibt eine Unsubscribe-Funktion zurück. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getProgress(): Readonly<SyncProgress> {
    return this.progress;
  }

  getLog(): ReadonlyArray<LogEntry> {
    return this.log;
  }

  clearLog(): void {
    this.log = [];
    this.emit();
    void this.save();
  }

  /** Löst ein Re-Render aus, ohne Daten zu ändern (z.B. für tickende Dauer). */
  touch(): void {
    if (this.progress.phase === "running") this.emit();
  }

  // ---- Mutationen (von der Engine aufgerufen) ----

  start(message = t("statusSyncStarted"), startedMs: number): void {
    this.progress = {
      phase: "running",
      message,
      current: 0,
      total: 0,
      startedMs,
    };
    this.append("info", message);
  }

  setTotal(total: number): void {
    this.progress = { ...this.progress, total };
    this.emit();
  }

  /** Aktualisiert den laufenden Fortschritt. */
  update(message: string, current: number, total?: number): void {
    this.progress = {
      ...this.progress,
      message,
      current,
      total: total ?? this.progress.total,
    };
    this.emit();
  }

  /** Schreibt eine Logzeile ohne Fortschrittsänderung. */
  append(level: LogEntry["level"], message: string): void {
    this.log.push({ ts: nowMs(), level, message });
    if (this.log.length > this.maxLog) {
      this.log.splice(0, this.log.length - this.maxLog);
    }
    this.emit();
    this.scheduleSave();
  }

  finish(phase: "done" | "error", message: string): void {
    this.progress = {
      ...this.progress,
      phase,
      message,
    };
    this.append(phase === "done" ? "success" : "error", message);
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* Listener-Fehler dürfen den Sync nicht beeinflussen. */
      }
    }
  }
}

/**
 * Zeit-Helfer. `Date.now()` ist im normalen Plugin-Runtime verfügbar; die
 * Kapselung erleichtert Tests.
 */
function nowMs(): number {
  return Date.now();
}
