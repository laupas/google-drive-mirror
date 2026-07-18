/**
 * Unit-Tests für SyncStatus — beobachtbarer Sync-Status + Log.
 * Reine In-Memory-Logik, keine Obsidian-/UI-Abhängigkeiten.
 * Format: AAA.
 */

import { describe, it, expect, vi } from "vitest";
import { SyncStatus } from "../../src/sync-status";

describe("SyncStatus — Anfangszustand", () => {
  it("startet im Zustand 'idle' mit leerem Log", () => {
    // Arrange
    const status = new SyncStatus();

    // Act
    const progress = status.getProgress();

    // Assert
    expect(progress.phase).toBe("idle");
    expect(progress.current).toBe(0);
    expect(status.getLog()).toEqual([]);
  });
});

describe("SyncStatus.start", () => {
  it("setzt die Phase auf 'running', übernimmt startedMs und loggt die Meldung", () => {
    // Arrange
    const status = new SyncStatus();

    // Act
    status.start("Los geht's", 12_345);

    // Assert
    const p = status.getProgress();
    expect(p.phase).toBe("running");
    expect(p.startedMs).toBe(12_345);
    expect(status.getLog().at(-1)).toMatchObject({ level: "info", message: "Los geht's" });
  });
});

describe("SyncStatus.update / setTotal", () => {
  it("aktualisiert current/total/message", () => {
    // Arrange
    const status = new SyncStatus();
    status.start("s", 0);
    status.setTotal(10);

    // Act
    status.update("Lade hoch 3/10", 3);

    // Assert
    const p = status.getProgress();
    expect(p.total).toBe(10);
    expect(p.current).toBe(3);
    expect(p.message).toBe("Lade hoch 3/10");
  });
});

describe("SyncStatus.finish", () => {
  it("setzt die Phase auf 'done' und loggt eine success-Zeile", () => {
    // Arrange
    const status = new SyncStatus();
    status.start("s", 0);

    // Act
    status.finish("done", "Fertig");

    // Assert
    expect(status.getProgress().phase).toBe("done");
    expect(status.getLog().at(-1)).toMatchObject({ level: "success", message: "Fertig" });
  });

  it("setzt die Phase auf 'error' und loggt eine error-Zeile", () => {
    // Arrange
    const status = new SyncStatus();
    status.start("s", 0);

    // Act
    status.finish("error", "Kaputt");

    // Assert
    expect(status.getProgress().phase).toBe("error");
    expect(status.getLog().at(-1)).toMatchObject({ level: "error", message: "Kaputt" });
  });
});

describe("SyncStatus.append — Log-Obergrenze", () => {
  it("begrenzt das Log auf maximal 500 Einträge (älteste fallen raus)", () => {
    // Arrange
    const status = new SyncStatus();

    // Act: 550 Einträge schreiben.
    for (let i = 0; i < 550; i++) status.append("info", `zeile-${i}`);

    // Assert: gekappt auf 500, jüngster Eintrag erhalten, ältester verworfen.
    const log = status.getLog();
    expect(log).toHaveLength(500);
    expect(log.at(-1)?.message).toBe("zeile-549");
    expect(log.at(0)?.message).toBe("zeile-50");
  });
});

describe("SyncStatus.subscribe", () => {
  it("benachrichtigt Listener bei Mutationen", () => {
    // Arrange
    const status = new SyncStatus();
    const listener = vi.fn();
    status.subscribe(listener);

    // Act
    status.setTotal(5);

    // Assert
    expect(listener).toHaveBeenCalled();
  });

  it("stoppt Benachrichtigungen nach unsubscribe", () => {
    // Arrange
    const status = new SyncStatus();
    const listener = vi.fn();
    const unsubscribe = status.subscribe(listener);
    unsubscribe();

    // Act
    status.setTotal(5);

    // Assert
    expect(listener).not.toHaveBeenCalled();
  });

  it("schluckt Fehler aus einem Listener, damit der Sync nicht bricht", () => {
    // Arrange
    const status = new SyncStatus();
    status.subscribe(() => {
      throw new Error("Listener kaputt");
    });

    // Act & Assert: kein Fehler nach außen.
    expect(() => status.setTotal(1)).not.toThrow();
  });
});

describe("SyncStatus.clearLog / touch", () => {
  it("leert das Log", () => {
    // Arrange
    const status = new SyncStatus();
    status.append("info", "x");

    // Act
    status.clearLog();

    // Assert
    expect(status.getLog()).toEqual([]);
  });

  it("touch benachrichtigt nur im Zustand 'running'", () => {
    // Arrange
    const status = new SyncStatus();
    const listener = vi.fn();
    status.subscribe(listener);

    // Act: idle -> kein emit
    status.touch();

    // Assert
    expect(listener).not.toHaveBeenCalled();
  });
});
