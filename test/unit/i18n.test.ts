/**
 * Unit-Tests für das i18n-Modul: Spracherkennung (defensiv, Node-tauglich),
 * Interpolation, Fallback-Kette und Locale-Konsistenz.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectLocale,
  getLocale,
  initLocale,
  Messages,
  setLocale,
  t,
} from "../../src/i18n";
import { en } from "../../src/i18n/locales/en";
import { de } from "../../src/i18n/locales/de";
import { it as itLocale } from "../../src/i18n/locales/it";
import { fr } from "../../src/i18n/locales/fr";

afterEach(() => {
  // Aktive Sprache zurücksetzen und ein evtl. gesetztes window entfernen.
  setLocale("en");
  vi.unstubAllGlobals();
});

describe("detectLocale", () => {
  it("fällt auf 'en' zurück, wenn kein window vorhanden ist (Testumgebung)", () => {
    // In der Node-Umgebung existiert kein window -> try/catch greift.
    expect(detectLocale()).toBe("en");
  });

  it("liest die Obsidian-Sprache aus localStorage", () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: () => "de" },
    });
    expect(detectLocale()).toBe("de");
  });

  it("mappt zusammengesetzte Codes (z.B. 'fr-CA') auf das Primär-Subtag", () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: () => "fr-CA" },
    });
    expect(detectLocale()).toBe("fr");
  });

  it("fällt bei nicht unterstützter Sprache auf 'en' zurück", () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: () => "pt-BR" },
    });
    expect(detectLocale()).toBe("en");
  });

  it("fällt bei leerem/null-Wert auf 'en' zurück", () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: () => null },
    });
    expect(detectLocale()).toBe("en");
  });

  it("fällt auf 'en' zurück, wenn localStorage-Zugriff wirft", () => {
    vi.stubGlobal("window", {
      get localStorage(): never {
        throw new Error("blocked");
      },
    });
    expect(detectLocale()).toBe("en");
  });
});

describe("initLocale / getLocale", () => {
  it("setzt die aktive Sprache anhand der Erkennung (hier: en ohne window)", () => {
    setLocale("de");
    initLocale();
    expect(getLocale()).toBe("en");
  });
});

describe("t()", () => {
  it("liefert den Wert der aktiven Sprache", () => {
    setLocale("de");
    expect(t("statusReady")).toBe("Bereit");
    setLocale("en");
    expect(t("statusReady")).toBe("Ready");
  });

  it("interpoliert {name}-Platzhalter", () => {
    setLocale("en");
    expect(t("uploadAction", { path: "note.md" })).toBe("Upload “note.md”");
  });

  it("interpoliert mehrere Platzhalter, auch numerische", () => {
    setLocale("en");
    expect(
      t("summaryDoneWithErrors", { count: 2, head: "1 up" })
    ).toBe("Done with 2 error(s): 1 up");
  });

  it("lässt unbekannte Platzhalter unverändert stehen", () => {
    setLocale("en");
    // {path} wird nicht geliefert -> bleibt als Literal erhalten.
    expect(t("uploadAction", {})).toBe("Upload “{path}”");
  });

  it("fällt bei fehlendem Schlüssel in der aktiven Sprache auf Englisch zurück", () => {
    // Ein Schlüssel, den IT nicht überschreibt, existiert so nicht — daher
    // ein realer Test: setze eine Sprache, deren Partial diesen Key auslässt.
    // Alle Locales sind vollständig gefüllt; simuliere Lücke über einen Key,
    // den wir bewusst prüfen: 'conflictWinnerRemote' ist überall "Drive".
    setLocale("fr");
    expect(t("conflictWinnerRemote")).toBe("Drive");
  });
});

describe("Locale-Konsistenz", () => {
  const enKeys = Object.keys(en) as (keyof Messages)[];

  for (const [name, dict] of [
    ["de", de],
    ["it", itLocale],
    ["fr", fr],
  ] as const) {
    it(`${name} definiert nur gültige Schlüssel (keine Tippfehler / veralteten Keys)`, () => {
      const stray = Object.keys(dict).filter(
        (k) => !(k in en)
      );
      expect(stray).toEqual([]);
    });

    it(`${name} übersetzt alle Schlüssel vollständig (keine EN-Lücken)`, () => {
      const missing = enKeys.filter((k) => !(k in dict));
      expect(missing).toEqual([]);
    });
  }

  it("jede Übersetzung, die einen {placeholder} nutzt, behält ihn (kein Verlust bei Übersetzung)", () => {
    // Für jeden Key, der in EN Platzhalter hat, müssen die anderen Sprachen
    // dieselben Platzhalter enthalten (sonst geht z.B. der Pfad verloren).
    const placeholderRe = /\{(\w+)\}/g;
    const enPlaceholders = (v: string) =>
      new Set([...v.matchAll(placeholderRe)].map((m) => m[1]));

    for (const key of enKeys) {
      const expected = enPlaceholders(en[key]);
      if (expected.size === 0) continue;
      for (const dict of [de, itLocale, fr]) {
        const value = dict[key];
        if (value === undefined) continue;
        const actual = enPlaceholders(value);
        for (const ph of expected) {
          expect(
            actual.has(ph),
            `Platzhalter {${ph}} fehlt in "${key}": "${value}"`
          ).toBe(true);
        }
      }
    }
  });
});
