import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { mergeWithDefaults } from "../../src/lib/db/repos/settingsRepo.js";

// Runs only with an explicit, isolated restoration snapshot. Never opens live DB.
describe.skipIf(!process.env.CANDIDATE_RESTORE_DB)("fork restored settings", () => {
  it("keeps production compression toggles and leaves REA disabled", () => {
    const db = new DatabaseSync(process.env.CANDIDATE_RESTORE_DB, { readOnly: true });
    try {
      const raw = JSON.parse(db.prepare("SELECT data FROM settings WHERE id = 1").get().data);
      const settings = mergeWithDefaults(raw);
      expect(settings).toMatchObject({
        headroomEnabled: false, headroomMinBodyBytes: 250000,
        toolSchemaCompactEnabled: true, toolSchemaDescMaxChars: 0,
        cavemanEnabled: true, reaAllowEnabled: false,
      });
      console.log("preserved settings", JSON.stringify({
        headroomEnabled: settings.headroomEnabled, toolSchemaDescMaxChars: settings.toolSchemaDescMaxChars,
        reaAllowEnabled: settings.reaAllowEnabled, requireApiKey: settings.requireApiKey,
      }));
      expect(db.prepare("PRAGMA integrity_check").get().integrity_check).toBe("ok");
    } finally { db.close(); }
  }, 120000);
});
