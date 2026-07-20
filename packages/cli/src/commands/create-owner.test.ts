import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOwnerCommand } from "./create-owner.js";

const getTeamMemberByEmail = vi.fn();
const createTeamMember = vi.fn();
const bcryptHash = vi.fn(async (password: string, _rounds: number) => `hashed:${password}`);
const promptsMock = vi.fn();

vi.mock("@vayo/db-mongo", () => ({
  createAdapter: () => ({
    getTeamMemberByEmail: (...args: unknown[]) => getTeamMemberByEmail(...args),
    createTeamMember: (...args: unknown[]) => createTeamMember(...args),
  }),
}));
vi.mock("../config.js", () => ({ requireMongoUri: () => "mongodb://localhost:27017/vayo" }));
vi.mock("bcrypt", () => ({ default: { hash: (...args: [string, number]) => bcryptHash(...args) } }));
vi.mock("prompts", () => ({ default: (...args: unknown[]) => promptsMock(...args) }));

beforeEach(() => {
  vi.clearAllMocks();
  getTeamMemberByEmail.mockResolvedValue(null);
  createTeamMember.mockImplementation(async (member) => ({ ...member, _id: "member-1" }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Real command connects via a long-lived MongoClient with no public
  // close(), so it force-exits on both success and the caught-error path
  // (see create-owner.ts's own comment) — must be stubbed here or it would
  // kill the vitest worker process instead of just returning.
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createOwnerCommand", () => {
  it("creates an owner-role team member with a hashed password, non-interactively", async () => {
    await createOwnerCommand({ email: "owner@example.com", name: "Olivia Owner", password: "correct-horse" });

    expect(bcryptHash).toHaveBeenCalledWith("correct-horse", 12);
    expect(createTeamMember).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "owner@example.com",
        name: "Olivia Owner",
        role: "owner",
        passwordHash: "hashed:correct-horse",
        status: "active",
        invitedBy: null,
        lastSeenNotificationsAt: null,
      }),
    );
    expect(promptsMock).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalled();
  });

  it("refuses a password under 8 characters", async () => {
    await expect(
      createOwnerCommand({ email: "owner@example.com", name: "Olivia Owner", password: "short" }),
    ).rejects.toThrow(/at least 8 characters/i);
    expect(createTeamMember).not.toHaveBeenCalled();
    // Rejected before ever opening the DB connection — no force-exit needed.
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("refuses when a team member with that email already exists, printing the error instead of hanging", async () => {
    getTeamMemberByEmail.mockResolvedValue({ _id: "existing-1", email: "owner@example.com", role: "editor" });

    await createOwnerCommand({ email: "owner@example.com", name: "Olivia Owner", password: "correct-horse" });

    expect(createTeamMember).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/already exists/i));
    expect(process.exitCode).toBe(1);
    expect(process.exit).toHaveBeenCalled();
    process.exitCode = undefined;
  });

  it("falls back to interactive prompts when options are missing", async () => {
    promptsMock.mockResolvedValue({ email: "prompted@example.com", name: "Prompted Person", password: "prompted-pass" });

    await createOwnerCommand({});

    expect(promptsMock).toHaveBeenCalled();
    expect(createTeamMember).toHaveBeenCalledWith(
      expect.objectContaining({ email: "prompted@example.com", name: "Prompted Person" }),
    );
  });

  it("cancels quietly when prompts are dismissed with no answers", async () => {
    promptsMock.mockResolvedValue({});

    await createOwnerCommand({});

    expect(createTeamMember).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
  });
});
