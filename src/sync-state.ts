import { SyncStateEntry } from "./types";
import { PluginStorage } from "./storage";
import { log } from "./logger";

/** Default state file name (legacy single-target layout / tests). */
const STATE_FILE = "sync-state.json";

/** Prefix for per-target state files: `sync-state-<targetId>.json`. */
const STATE_FILE_PREFIX = "sync-state-";

/** Builds the per-target state file name for a target id. */
export function stateFileName(targetId: string): string {
  return `${STATE_FILE_PREFIX}${targetId}.json`;
}

/** Is `fileName` a per-target state file? (used to find orphans). */
export function isStateFile(fileName: string): boolean {
  return fileName.startsWith(STATE_FILE_PREFIX) && fileName.endsWith(".json");
}

/** Serialization format of the state file. */
interface StateFile {
  version: 1;
  /**
   * Identity of the vault + Drive folder this base applies to. If it doesn't
   * match on load (e.g. file copied from another vault), the base is
   * discarded — otherwise the reconciler would treat all files as "deleted
   * locally" and empty the Drive.
   */
  scopeId?: string;
  lastSyncMs: number;
  entries: Record<string, SyncStateEntry>;
}

/**
 * Encapsulates the persistent sync state (the "base" of the 3-way comparison).
 *
 * The state remembers, for each file that last synced successfully, its
 * hash/size/mtime on both sides. This allows distinguishing on the next run:
 * changed locally / changed remotely / deleted.
 *
 * Kept in its OWN file (`sync-state.json`) in the plugin folder, not in
 * data.json — so data.json (settings) stays small and isn't rewritten on
 * every sync.
 */
export class SyncStateStore {
  private entries: Record<string, SyncStateEntry> = {};
  private lastSyncMs = 0;

  /**
   * @param storage  Persistence helper.
   * @param scopeId  Returns the current scope identity (vault + Drive folder +
   *                 local scope). A function, because it can change at runtime
   *                 (folder change).
   * @param fileName Name of the state file. Defaults to the legacy
   *                 `sync-state.json`; per-target stores pass
   *                 `sync-state-<id>.json` (see `stateFileName`).
   */
  constructor(
    private storage: PluginStorage,
    private scopeId: () => string,
    private fileName: string = STATE_FILE
  ) {}

  /**
   * Loads the state from the file. Optional: migration of an old state.
   * Discards the loaded base if its `scopeId` doesn't match the current one
   * (e.g. copied from another vault) — protection against mass deletion.
   */
  async load(migrateFrom?: {
    entries: Record<string, SyncStateEntry>;
    lastSyncMs: number;
  }): Promise<void> {
    const data = await this.storage.readJson<StateFile | null>(
      this.fileName,
      null
    );
    if (data && data.entries) {
      const current = this.scopeId();
      // scopeId missing (old file) -> tolerate; doesn't match -> discard.
      if (data.scopeId && data.scopeId !== current) {
        log.warn(
          "Sync-State stammt aus anderem Vault/Ordner " +
            `(${data.scopeId} ≠ ${current}) -> verworfen. ` +
            "Beim nächsten Sync wird alles neu abgeglichen (kein Löschen)."
        );
        this.entries = {};
        this.lastSyncMs = 0;
        await this.save(); // overwrite with the correct scopeId
        return;
      }
      this.entries = data.entries;
      this.lastSyncMs = data.lastSyncMs ?? 0;
      return;
    }
    // No state file present -> migrate from old data.json if applicable.
    if (migrateFrom && Object.keys(migrateFrom.entries).length > 0) {
      this.entries = migrateFrom.entries;
      this.lastSyncMs = migrateFrom.lastSyncMs;
      await this.save();
      log.info("Sync-State aus data.json migriert.");
    }
  }

  /** Persists the current state to the file. */
  async save(): Promise<void> {
    const file: StateFile = {
      version: 1,
      scopeId: this.scopeId(),
      lastSyncMs: this.lastSyncMs,
      entries: this.entries,
    };
    await this.storage.writeJson(this.fileName, file);
  }

  /** Deletes the underlying state file (e.g. when a target is removed). */
  async destroy(): Promise<void> {
    await this.storage.remove(this.fileName);
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

  /** Clears the entire state (e.g. on folder change/manual reset). */
  clear(): void {
    this.entries = {};
    this.lastSyncMs = 0;
  }

  /** All known paths from the last sync base. */
  knownPaths(): string[] {
    return Object.keys(this.entries);
  }

  all(): SyncStateEntry[] {
    return Object.values(this.entries);
  }

  /** Finds the base entry for a Drive ID (for rename/move cases). */
  byDriveId(driveId: string): SyncStateEntry | undefined {
    return this.all().find((e) => e.driveId === driveId);
  }
}
