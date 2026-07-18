import { SyncStateEntry } from "./types";
import { PluginStorage } from "./storage";
import { log } from "./logger";

const STATE_FILE = "sync-state.json";

/** Serialisierungsformat der State-Datei. */
interface StateFile {
  version: 1;
  /**
   * Identität des Vaults + Drive-Ordners, für die diese Base gilt. Passt sie
   * beim Laden nicht (z.B. Datei aus anderem Vault kopiert), wird die Base
   * verworfen — sonst würde der Reconciler alle Dateien für "lokal gelöscht"
   * halten und den Drive leeren.
   */
  scopeId?: string;
  lastSyncMs: number;
  entries: Record<string, SyncStateEntry>;
}

/**
 * Kapselt den persistenten Sync-Zustand (die "Base" des 3-Wege-Vergleichs).
 *
 * Der Zustand merkt sich für jede zuletzt erfolgreich gesyncte Datei ihren
 * Hash/Größe/mtime auf beiden Seiten. Damit lässt sich beim nächsten Lauf
 * unterscheiden: lokal geändert / remote geändert / gelöscht.
 *
 * Wird in einer EIGENEN Datei (`sync-state.json`) im Plugin-Ordner gehalten,
 * nicht in data.json — so bleibt data.json (Settings) klein und wird nicht bei
 * jedem Sync neu geschrieben.
 */
export class SyncStateStore {
  private entries: Record<string, SyncStateEntry> = {};
  private lastSyncMs = 0;

  /**
   * @param storage  Persistenz-Helfer.
   * @param scopeId  Liefert die aktuelle Scope-Identität (Vault + Drive-Ordner).
   *                 Als Funktion, weil sie sich zur Laufzeit ändern kann
   *                 (Ordnerwechsel).
   */
  constructor(
    private storage: PluginStorage,
    private scopeId: () => string
  ) {}

  /**
   * Lädt den State aus der Datei. Optional: Migration eines Alt-States.
   * Verwirft die geladene Base, wenn ihre `scopeId` nicht zur aktuellen passt
   * (z.B. aus anderem Vault kopiert) — Schutz gegen Massenlöschung.
   */
  async load(migrateFrom?: {
    entries: Record<string, SyncStateEntry>;
    lastSyncMs: number;
  }): Promise<void> {
    const data = await this.storage.readJson<StateFile | null>(STATE_FILE, null);
    if (data && data.entries) {
      const current = this.scopeId();
      // scopeId fehlt (alte Datei) -> tolerieren; passt sie nicht -> verwerfen.
      if (data.scopeId && data.scopeId !== current) {
        log.warn(
          "Sync-State stammt aus anderem Vault/Ordner " +
            `(${data.scopeId} ≠ ${current}) -> verworfen. ` +
            "Beim nächsten Sync wird alles neu abgeglichen (kein Löschen)."
        );
        this.entries = {};
        this.lastSyncMs = 0;
        await this.save(); // mit korrekter scopeId überschreiben
        return;
      }
      this.entries = data.entries;
      this.lastSyncMs = data.lastSyncMs ?? 0;
      return;
    }
    // Keine State-Datei vorhanden -> ggf. aus altem data.json migrieren.
    if (migrateFrom && Object.keys(migrateFrom.entries).length > 0) {
      this.entries = migrateFrom.entries;
      this.lastSyncMs = migrateFrom.lastSyncMs;
      await this.save();
      log.info("Sync-State aus data.json migriert.");
    }
  }

  /** Persistiert den aktuellen State in die Datei. */
  async save(): Promise<void> {
    const file: StateFile = {
      version: 1,
      scopeId: this.scopeId(),
      lastSyncMs: this.lastSyncMs,
      entries: this.entries,
    };
    await this.storage.writeJson(STATE_FILE, file);
  }

  getLastSyncMs(): number {
    return this.lastSyncMs;
  }

  setLastSyncMs(ms: number): void {
    this.lastSyncMs = ms;
  }

  get(path: string): SyncStateEntry | undefined {
    return this.entries[path];
  }

  set(entry: SyncStateEntry): void {
    this.entries[entry.path] = entry;
  }

  delete(path: string): void {
    delete this.entries[path];
  }

  /** Leert den gesamten State (z.B. bei Ordnerwechsel/manuellem Reset). */
  clear(): void {
    this.entries = {};
    this.lastSyncMs = 0;
  }

  /** Alle bekannten Pfade aus der letzten Sync-Base. */
  knownPaths(): string[] {
    return Object.keys(this.entries);
  }

  all(): SyncStateEntry[] {
    return Object.values(this.entries);
  }

  /** Findet den Base-Eintrag zu einer Drive-ID (für Umbenennungs-/Move-Fälle). */
  byDriveId(driveId: string): SyncStateEntry | undefined {
    return this.all().find((e) => e.driveId === driveId);
  }
}
