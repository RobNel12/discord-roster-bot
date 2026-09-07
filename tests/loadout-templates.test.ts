import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Interaction } from "discord.js";
import { RosterRepository } from "../src/database.js";
import { handleLoadoutConfigInteraction } from "../src/loadout-config-interactions.js";
import { SQUAD_CONFIG_LOADOUT_CUSTOM_ID } from "../src/squad-components.js";

const repositories: RosterRepository[] = [];
afterEach(() => { for (const repo of repositories.splice(0)) repo.close(); });
function setup() {
  const repo = new RosterRepository(":memory:"); repositories.push(repo);
  const squad = repo.createSquad("g", "Alpha", "manager");
  repo.assignMember("g", "manager", squad.id, "manager");
  repo.setSquadLoadoutRole("g", squad.id, "Medic", 25, "Bring supplies", "medic");
  repo.setSquadLoadoutPreferenceRole("g", squad.id, "medic", "first", "first");
  repo.setSquadLoadoutPreferenceRole("g", squad.id, "medic", "second", "second");
  return { repo, squad };
}

it("saves settings as a snapshot and loads them with a single replaceable suffix", () => {
  const { repo, squad } = setup();
  repo.saveLoadoutTemplate("g", squad.id, "Infantry");
  repo.setSquadLoadoutRole("g", squad.id, "Pilot", 50, null);
  repo.saveLoadoutTemplate("g", squad.id, "Aviation");
  const infantry = repo.listLoadoutTemplates("g").find(t => t.name === "Infantry")!;
  const aviation = repo.listLoadoutTemplates("g").find(t => t.name === "Aviation")!;
  repo.replaceSquadLoadoutAssignments("g", squad.id, [{ userId: "manager", roleName: "Pilot" }]);
  expect(repo.loadLoadoutTemplate("g", squad.id, infantry.id).name).toBe("Alpha (Infantry)");
  expect(repo.listSquadLoadoutAssignments("g", squad.id)).toEqual([]);
  expect(repo.listSquadLoadoutRoles("g", squad.id)).toEqual([expect.objectContaining({ name: "Medic", percentage: 25, instructions: "Bring supplies", discordRoleId: "medic", firstPreferenceRoleId: "first", secondPreferenceRoleId: "second" })]);
  expect(repo.loadLoadoutTemplate("g", squad.id, aviation.id).name).toBe("Alpha (Aviation)");
  expect(repo.loadLoadoutTemplate("g", squad.id, aviation.id).name).toBe("Alpha (Aviation)");
  repo.renameSquad("g", squad.id, "Bravo");
  expect(repo.loadLoadoutTemplate("g", squad.id, infantry.id).name).toBe("Bravo (Infantry)");
});

it("isolates templates by server and rolls back conflicting or oversized names", () => {
  const { repo, squad } = setup();
  repo.saveLoadoutTemplate("g", squad.id, "Infantry");
  const template = repo.listLoadoutTemplates("g")[0]!;
  expect(repo.listLoadoutTemplates("other")).toEqual([]);
  const other = repo.createSquad("other", "Alpha", "manager");
  expect(() => repo.loadLoadoutTemplate("other", other.id, template.id)).toThrow();
  expect(() => repo.saveLoadoutTemplate("g", squad.id, "infantry")).toThrow("already exists");
  repo.createSquad("g", "Alpha (Infantry)", "manager");
  const before = repo.listSquadLoadoutRoles("g", squad.id);
  expect(() => repo.loadLoadoutTemplate("g", squad.id, template.id)).toThrow();
  expect(repo.getSquad("g", squad.id)?.name).toBe("Alpha");
  expect(repo.listSquadLoadoutRoles("g", squad.id)).toEqual(before);
  repo.renameSquad("g", squad.id, "A".repeat(50));
  expect(() => repo.loadLoadoutTemplate("g", squad.id, template.id)).toThrow("50 characters");
  expect(repo.listSquadLoadoutRoles("g", squad.id)).toEqual(before);
});

it("persists saved templates and suffix tracking across restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "loadout-template-"));
  const path = join(dir, "test.sqlite");
  const first = new RosterRepository(path);
  const squad = first.createSquad("g", "Alpha", "manager");
  first.setSquadLoadoutRole("g", squad.id, "Medic", 25, null);
  first.saveLoadoutTemplate("g", squad.id, "Infantry");
  const template = first.listLoadoutTemplates("g")[0]!;
  first.loadLoadoutTemplate("g", squad.id, template.id);
  first.close();
  const second = new RosterRepository(path);
  try {
    expect(second.loadLoadoutTemplate("g", squad.id, template.id).name).toBe("Alpha (Infantry)");
  } finally { second.close(); rmSync(dir, { recursive: true }); }
});

it("offers save/load controls, applies a selection, and rechecks manager access", async () => {
  const { repo, squad } = setup();
  let manager = true;
  const guild = { id: "g", members: { fetch: vi.fn(async () => ({ id: "manager", permissions: { has: () => manager }, roles: { cache: { has: () => false } } })) } };
  const make = (customId: string, kind = "button") => ({
    customId, guild, user: { id: "manager" }, values: [] as string[],
    inGuild: () => true, isRepliable: () => true, isButton: () => kind === "button", isModalSubmit: () => kind === "modal", isRoleSelectMenu: () => false, isStringSelectMenu: () => kind === "select",
    fields: { getTextInputValue: () => "Infantry" }, reply: vi.fn(), update: vi.fn(), showModal: vi.fn(), deferUpdate: vi.fn(), editReply: vi.fn(), followUp: vi.fn(),
  });
  const open = make(SQUAD_CONFIG_LOADOUT_CUSTOM_ID);
  await handleLoadoutConfigInteraction(open as unknown as Interaction, repo);
  const payload = open.reply.mock.calls[0]![0];
  const buttons = payload.components.flatMap((row: { toJSON(): { components: Array<{ custom_id: string }> } }) => row.toJSON().components);
  const saveId = buttons.find((button: { custom_id: string }) => button.custom_id.includes("template-save"))!.custom_id;
  const id = saveId.split(":")[2];
  const save = make(saveId);
  await handleLoadoutConfigInteraction(save as unknown as Interaction, repo);
  expect(save.showModal).toHaveBeenCalledOnce();
  await handleLoadoutConfigInteraction(make(`loadoutcfg:template-save-submit:${id}`, "modal") as unknown as Interaction, repo);
  const load = make(`loadoutcfg:template-load:${id}`);
  await handleLoadoutConfigInteraction(load as unknown as Interaction, repo);
  expect(load.update).toHaveBeenCalledOnce();
  const apply = make(`loadoutcfg:template-apply:${id}`, "select");
  apply.values = [String(repo.listLoadoutTemplates("g")[0]!.id)];
  const scheduler = { schedule: vi.fn() };
  await handleLoadoutConfigInteraction(apply as unknown as Interaction, repo, scheduler);
  expect(repo.getSquad("g", squad.id)?.name).toBe("Alpha (Infantry)");
  expect(scheduler.schedule).toHaveBeenCalledWith("g", "squad");
  manager = false;
  const denied = make(saveId);
  await handleLoadoutConfigInteraction(denied as unknown as Interaction, repo);
  expect(denied.showModal).not.toHaveBeenCalled();
  expect(denied.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("assigned manager") }));
});
