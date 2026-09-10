# Command reference

See [ADMIN_GUIDE.md](ADMIN_GUIDE.md) for task-oriented setup, moderation, and recovery procedures. See [README.md](README.md) for installation, permissions, deployment, and troubleshooting. All commands run inside a Discord server. Command replies are private; published rosters and summons appear in their selected channels.

## Access

- **Server managers:** members with Manage Server. They configure publications, the leader role, voice lobby, announcement channels, and manual ranks.
- **Squad managers:** server managers or members with the exact configured squad leader role. They manage squads and summons.
- **Members:** everyone can list squads, check rank progress, and use self-service membership controls. Locked squads reject new joins but allow current members to leave.

Select autocomplete results for squad and page arguments; the bot uses their IDs internally. Optional arguments are marked below.

## /roster

| Command | Access | Arguments | Purpose |
| --- | --- | --- | --- |
| `/roster setup` | Server manager | None | Set up the role roster with guided menus |
| `/roster add-page` | Server manager | `name`: Page name | Add a named page to the role roster |
| `/roster remove-page` | Server manager | `page`: Page to remove<br>`confirm`: Confirm page removal | Remove a page and move its roles to another page |
| `/roster move-role` | Server manager | `role`: Tracked role<br>`page`: Destination page | Move a tracked role to another roster page |
| `/roster set-priority` | Server manager | `role`: Tracked role<br>`high-priority`: Highlight this role | Change whether a tracked role is highlighted |
| `/roster set-channel` | Server manager | `channel`: Role roster channel | Choose the channel that will contain the role roster |
| `/roster add-role` | Server manager | `role`: Role to track | Add a Discord role to the live roster |
| `/roster remove-role` | Server manager | `role`: Role to stop tracking | Stop tracking a Discord role |
| `/roster list-roles` | Server manager | None | Show all currently tracked roles |
| `/roster sort` | Server manager | None | Sort tracked roles by server role hierarchy |
| `/roster clear-roles` | Server manager | `confirm`: Confirm removal of every tracked role | Stop tracking every role at once |
| `/roster refresh` | Server manager | None | Reconcile and republish the role roster |
| `/roster delete` | Server manager | `message-id`: ID of any message page in the roster<br>`confirm`: Confirm deletion of every page in this roster | Delete and disable a published role or squad roster |
| `/roster move` | Server manager | `message-id`: ID of any message page in the roster<br>`channel`: Destination roster channel | Move a published role or squad roster to another channel |

## /squad

| Command | Access | Arguments | Purpose |
| --- | --- | --- | --- |
| `/squad set-call-channel` | Server manager | `channel`: Squad call channel | Choose where squad call notifications are sent |
| `/squad clear-call-channel` | Server manager | None | Disable squad call notifications |
| `/squad leaderboard` | Everyone | `page` (optional): Page number, 10 members per page; `track` (optional): all, enlisted, officer | Privately show current server members ranked by rank, then current-track voice time, including active sessions |
| `/squad set-leaderboard-channel` | Server manager | `channel`: Text/announcement channel | Publish or move the automatically updated rank leaderboard |
| `/squad clear-leaderboard-channel` | Server manager | None | Disable the live leaderboard and remove its messages |
| `/squad wipe-rank` | Server manager | `member`: Member to reset; `confirm`: Must be true | Permanently clear one member's rank time and manual rank |
| `/squad wipe-ranks` | Server manager | `confirm`: Must be true | Permanently clear all rank time and manual ranks in this server |
| `/squad rank-progress` | Everyone | `member` (optional): Member to check; defaults to you | Check logged squad voice time and progress toward the next rank |
| `/squad set-voice-lobby` | Server manager | `channel`: Join-to-create voice channel | Choose the voice channel that creates temporary squad channels |
| `/squad clear-voice-lobby` | Server manager | None | Disable temporary voice channel creation |
| `/squad set-rank` | Server manager | `member`: Server member<br>`rank`: Enlisted rank abbreviation | Set a member's activity rank |
| `/squad set-channel` | Server manager | `channel`: Squad roster channel | Choose the channel that will contain the squad roster |
| `/squad set-leader-role` | Server manager | `role`: Existing squad leader role | Let everyone with this role manage squads |
| `/squad clear-leader-role` | Server manager | None | Return squad management to members with Manage Server only |
| `/squad create` | Squad manager | `name`: Squad name | Create a squad |
| `/squad rename` | Squad manager | `squad`: Squad to rename<br>`name`: New squad name | Rename a squad |
| `/squad delete` | Squad manager | `squad`: Squad to delete<br>`confirm`: Confirm deletion and unassignment | Delete a squad and unassign its members |
| `/squad assign` | Squad manager | `member`: Server member<br>`squad`: Destination squad | Assign or move a member to a squad |
| `/squad unassign` | Squad manager | `member`: Server member | Remove a member from their squad |
| `/squad list` | Everyone | None | List squads and assignment counts |
| `/squad refresh` | Squad manager | None | Reconcile and republish the squad roster |

## Roster menus and buttons

| Control | Access | Behavior |
| --- | --- | --- |
| ⬅️ / ➡️ on the role roster | Everyone | Switch between named role-roster views. |
| Join or move to a squad | Everyone | Replaces your previous assignment. Moving into a locked squad is blocked; moving out to an unlocked squad is allowed. Up to 100 squads appear in the menus. |
| Leave current squad | Everyone | Moves you to Unassigned, including when your squad is locked. |
| Call my squad | Squad manager assigned to a squad | Posts the squad summons and pings members once in the configured call channel. One open summons per squad; one-minute cooldown. |
| Configure loadout | Squad manager assigned to a squad | Opens a private panel for percentages, preference roles, instructions, and named Save/Load templates. |
| Assign loadouts | Squad manager in their squad's temporary voice channel | Assigns loadouts to members in voice and displays assignments on the roster. Assignment DMs are currently paused. |
| Clear assignments | Squad manager assigned to a squad | Clears displayed loadouts for that squad. |

See [loadout configuration](README.md#loadouts-and-rank-progress) for preference matching, percentages, and templates. Volunteers are shuffled each assignment run, and activity time gives no priority. Join the configured voice lobby to create or reuse your squad's temporary channel; there is no separate voice-create command.

In **Configure loadout**, selecting `1st [role]` places that loadout in the first fill group; selecting `2nd [role]` places it in the second. Either can create a loadout directly. Selecting the other variety later changes the group without resetting percentages, limits, or instructions. Exact member preference names are still interpreted automatically; members can hold any number of optional `2nd [role]` preferences. First-group jobs are filled first, using first-choice volunteers then fallback volunteers. Second-group roles and volunteers have no fixed order: roles are shuffled, and matching first/second-choice volunteers compete equally. The standalone fill-priority menu is removed. Templates preserve the configured groups; existing templates keep their saved groups until reconfigured.

Inside **Configure loadout**, **Save template** asks for a unique name (1–30 characters) and saves the squad's current percentages, preference-role mappings, and instructions. **Load template** opens a paginated menu of this server's saved templates. Select one, then press **Load template** to replace the squad's configuration, clear old assignments, and append its name: `Alpha` becomes `Alpha (Infantry)`. Loading another template replaces the suffix. Saving a template does not rename the source squad. A duplicate or oversized resulting squad name is rejected without changing the configuration. Templates persist across restarts. After loading, use **Assign loadouts** to assign members; assignment DMs remain paused.

The same menu offers **Rename template** and **Delete template** for the selected template. Rename asks for a new unique name; delete requires a separate confirmation and offers Cancel. Neither changes previously applied squad settings or names. Reload after renaming to update a squad's suffix. Template management requires being an assigned squad manager, checked again on every action.

Select a loadout role and press **Min / Max slots** to edit its limits. Minimum and maximum accept whole numbers from 0–1000; blank minimum uses the primary/secondary default, and blank maximum means unlimited. Minimum must not exceed maximum. A minimum of 1 and maximum of 2 reserves a Medic job but caps Medics at two. Minimum 0 removes the guaranteed slot; maximum 0 disables the role's slots. Templates include these limits.

The bot processes first-group minimums and targets before second-group minimums and targets. A second-group minimum cannot displace a first-group target. First-group slot contention uses higher percentages then configuration order; second-group contention is randomized. A blank minimum means 1 in the first group or 0 in the second, so a second-group 10% role normally waits until 10 members. Specialist eligibility still requires a matching preference. The summary reports unmet minimums. Remaining members become Rifleman; if you cap Rifleman too, excess members display **Unassigned loadout** without leaving their squad.

## Summons controls

The orange summons embed shows the squad's members, ranks, loadouts, readiness, and 🔒/🔓 status. New squad members appear as ❌; existing members keep their responses. Departed members are removed. Updates do not send new pings.

| Control | Access | Behavior |
| --- | --- | --- |
| ✅ reaction | Current squad member | Marks you ready. |
| ❌ reaction | Current squad member | Marks you not ready. |
| 🔓 button | Squad manager assigned to this squad, or server manager | Blocks self-service joins and moves into the squad. Current members can leave or move out. The button changes to 🔒. |
| 🔒 button | Squad manager assigned to this squad, or server manager | Allows self-service joins again. The button changes to 🔓. |
| Close squad summons | Squad manager | Freezes the final roster and readiness, removes buttons, and releases the squad lock. |

The main squad roster also shows each squad's current lock emoji. Explicit `/squad assign` and `/squad unassign` commands still work while locked. Locks do not change voice-channel permissions or prevent readiness responses.

The most recently added reaction wins. Removing a reaction alone does not change readiness. With Manage Messages, the bot clears each response reaction so it can be clicked repeatedly; without it, remove and re-add your reaction to repeat that response. Controls and saved state survive restarts. Closed summons cannot be reopened; use **Call my squad** to create a new one.

## Common workflows

### Initial setup

```text
/roster setup
/squad set-channel channel:#squad-roster
/squad set-call-channel channel:#squad-calls
/squad set-leader-role role:@Squad Leader
/squad set-voice-lobby channel:#Join-to-Create
/squad create name:Alpha
/squad assign member:@Leader squad:Alpha
```

Server staff assign the normal Discord leader role themselves. Members then select a squad on the roster, join the voice lobby, and respond to the leader's summons. Leaders can configure loadouts, assign them in voice, and lock membership for the session.

### Move or remove a publication

Enable Discord Developer Mode, then copy a roster message ID. Any page identifies the whole role or squad publication.

```text
/roster move message-id:123456789012345678 channel:#new-roster
/roster delete message-id:123456789012345678 confirm:true
```

Deleting a publication preserves its configuration and squad assignments. Use its regular `set-channel` command to publish again. These commands target role/squad publications, not summons messages. Squad deletion and role/page bulk removal require their explicit `confirm:true` arguments too.

### Check and set ranks

```text
/squad rank-progress
/squad rank-progress member:@Member
/squad leaderboard
/squad leaderboard track:enlisted page:2
/squad set-leaderboard-channel channel:#rank-leaderboard
/squad set-rank member:@Member rank:SGT
```

Select the rank from Discord's offered choices. Only server managers can set it, and it must match the member's enlisted/officer eligibility. Command Sgt. Maj. and Sgt. Maj. of the Army are manual enlisted appointments. See [rank progression](README.md#4-set-up-the-rosters-in-discord) for thresholds. Time counts only in the member's own tracked squad voice channel.

Rank progression sends no automated channel messages or DMs. Rank progress and leaderboard commands reply ephemerally to the person using them. The old `set-rank-channel` and `clear-rank-channel` commands are retired; redeploy commands after updating. The combined leaderboard orders officers above enlisted ranks, breaks rank ties by current-track voice time and then member ID, and excludes bots/departed members. Use the track filter to compare members on the same progression track. Page numbers beyond the end display the last page.

The configured live leaderboard publishes officers and enlisted members on separate persistent embed pages, with numbering restarted for each track. Large tracks continue onto additional pages. It edits those messages automatically on member/squad updates, rank changes, startup, and periodic reconciliation. Use `set-leaderboard-channel` again to move it or `clear-leaderboard-channel` to remove it; `/squad refresh` refreshes it manually. Ordinary `/squad leaderboard` remains a private snapshot.

`/squad wipe-rank member:@Member confirm:true` and `/squad wipe-ranks confirm:true` require Manage Server, not just the squad leader role. Wiping clears accumulated rank time and manual appointments, including departed members' stored records for the server-wide command. Active voice counters restart at the wipe time. Members return to their current track's starting rank; squad assignments, loadouts, and templates remain. The leaderboard and squad roster refresh after reset. There is no undo command; progress can only be recovered from a prior database backup.

### Refresh and recover

Use `/roster refresh` or `/squad refresh` after fixing permissions or if a roster looks stale. Squad refresh also updates open summons and voice access. A closed summons stays closed; an open deleted page can be recreated during reconciliation.
