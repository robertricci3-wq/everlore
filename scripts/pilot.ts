import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { Store } from "../src/server/store.js";
import { operatorId } from "../src/server/access.js";
import {
  createPilotCampaign,
  authorizePilotCampaign,
  setPilotCampaignState,
  issuePilotInvitation,
  redeemPilotInvitation,
  pilotAccess,
  pilotCampaignSummary,
} from "../src/server/pilot/service.js";
import { migratePilot } from "../src/server/pilot/schema.js";

const usage = `Use with an explicit DATA_DIR:
  pilot.ts status [CAMPAIGN_ID]
  pilot.ts draft INPUT_JSON_FILE
  pilot.ts authorize CAMPAIGN_ID --reference AUTHORIZATION_REFERENCE --acknowledge-estimated-costs
  pilot.ts pause CAMPAIGN_ID
  pilot.ts resume CAMPAIGN_ID
  pilot.ts invite CAMPAIGN_ID --key REQUEST_KEY --label LABEL [--expires-days DAYS]
  pilot.ts enroll-existing CAMPAIGN_ID --account ACCOUNT --key REQUEST_KEY --label LABEL

Draft files contain key, totalCents, maxHouseholds, and the complete immutable policy.
Draft does not authorize or enable generation. No command starts a worker or calls a provider.
Authorization records an operator decision; it does not establish a guaranteed provider billing cap.`;
function options(args: string[], allowed: string[]) {
  const parsed: Record<string, string | true> = {};
  for (let n = 0; n < args.length; n++) {
    const name = args[n];
    if (!allowed.includes(name) || name in parsed)
      throw new Error("Invalid or repeated option.");
    if (name === "--acknowledge-estimated-costs") parsed[name] = true;
    else {
      const value = args[++n];
      if (!value || value.startsWith("--"))
        throw new Error("A required option value is missing.");
      parsed[name] = value;
    }
  }
  return parsed;
}
function summary(s: Store, actor: string, campaignId: string) {
  const report = pilotCampaignSummary(s, actor, campaignId);
  return {
    id: report.campaign.id,
    state: report.campaign.state,
    totalCents: report.campaign.totalCents,
    maxHouseholds: report.campaign.maxHouseholds,
    policyHash: report.campaign.policyHash,
    households: report.households,
    booksRequested: report.booksRequested,
    accountedCents: report.accountedCents,
    remainingCents: report.remainingCents,
    overrunCents: report.overrunCents,
    usageEstimatedCents: report.usageEstimatedCents,
    attemptsWithoutUsage: report.attemptsWithoutUsage,
    ambiguousAttempts: report.ambiguousAttempts,
    verifiedBilledCents: null,
    costConfidence: "estimate",
    note: report.note,
  };
}

/** Exported for isolated fixture checks; never loads provider configuration. */
export function runPilotCommand(s: Store, args: string[]) {
  const actor = operatorId(s);
  if (!actor) throw new Error("Configure the application operator first.");
  migratePilot(s.db);
  const [command, target, ...rest] = args;
  if (command === "status" && rest.length === 0) {
    if (target) return summary(s, actor, target);
    return {
      campaigns: s
        .all<{ id: string }>(
          "SELECT id FROM pilot_campaigns ORDER BY createdAt",
        )
        .map((row) => summary(s, actor, row.id)),
    };
  }
  if (command === "draft" && target && rest.length === 0) {
    const campaign = createPilotCampaign(
      s,
      actor,
      JSON.parse(readFileSync(resolve(target), "utf8")),
    );
    return summary(s, actor, campaign.id);
  }
  if (command === "authorize" && target) {
    const body = options(rest, [
      "--reference",
      "--acknowledge-estimated-costs",
    ]);
    authorizePilotCampaign(s, actor, target, {
      authorizationReference: body["--reference"],
      acknowledgeEstimatedCosts: body["--acknowledge-estimated-costs"],
    });
    return summary(s, actor, target);
  }
  if (["pause", "resume"].includes(command) && target && rest.length === 0) {
    setPilotCampaignState(
      s,
      actor,
      target,
      command === "resume" ? "active" : "paused",
    );
    return summary(s, actor, target);
  }
  if (["invite", "enroll-existing"].includes(command) && target) {
    const body = options(
      rest,
      command === "invite"
        ? ["--key", "--label", "--expires-days"]
        : ["--key", "--label", "--account"],
    );
    const invitation = {
      key: body["--key"],
      label: body["--label"],
      ...(body["--expires-days"]
        ? { expiresDays: Number(body["--expires-days"]) }
        : {}),
    };
    if (command === "invite") {
      const result = issuePilotInvitation(s, actor, target, invitation);
      return {
        campaignId: target,
        ...result,
        note: result.code
          ? "Private, single-use invitation. Share only with the intended tester; no card or provider key is needed."
          : "This invitation was already issued. Its secret code is shown only once; revoke it in Studio before replacing a lost link.",
      };
    }
    const account = z.string().trim().min(1).max(100).parse(body["--account"]);
    const user = s.one<{ id: string }>(
      "SELECT id FROM users WHERE name=? AND kind='private'",
      account.toLowerCase(),
    );
    if (!user)
      throw new Error("The explicitly named private account was not found.");
    const member = pilotAccess(s, user.id);
    if (member) {
      if (member.campaign.id !== target)
        throw new Error("This account is already enrolled in another pilot.");
      return { campaignId: target, enrolled: true, replayed: true };
    }
    return s.transaction(() => {
      const issued = issuePilotInvitation(s, actor, target, invitation);
      if (!issued.code)
        throw new Error(
          "That invitation key was already used. No account was enrolled.",
        );
      if (!redeemPilotInvitation(s, issued.code, user.id))
        throw new Error("The private enrollment could not be verified.");
      return { campaignId: target, enrolled: true, replayed: false };
    });
  }
  throw new Error(usage);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  let s: Store | undefined;
  try {
    if (!process.env.DATA_DIR)
      throw new Error(
        "Set DATA_DIR explicitly before using this private operator command.",
      );
    s = new Store(process.env.DATA_DIR);
    console.log(
      JSON.stringify(runPilotCommand(s, process.argv.slice(2)), null, 2),
    );
  } catch {
    // Never echo file paths, arguments, invitation values, family records, or
    // raw validation errors. The command has no provider/network capability.
    console.error(
      "Pilot command was not completed. Check operator access, arguments, frozen settings, and authorization. Existing provider requests were not repeated.\n" +
        usage,
    );
    process.exitCode = 1;
  } finally {
    s?.close();
  }
}
