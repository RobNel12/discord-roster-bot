# Command reference

See [README.md](README.md) for installation, permissions, deployment, and troubleshooting. All commands run inside a Discord server. Command replies are private; published rosters, summons, and sign-ups appear in their selected channels.

## Access

- **Server managers:** members with Manage Server. They configure publications, the leader role, voice lobby, announcement channels, and manual ranks.
- **Squad managers:** server managers or members with the exact configured squad leader role. They manage squads and create operations.
- **Members:** everyone can list squads, check rank progress, and use self-service membership controls unless a squad is locked.

Select autocomplete results for squad and page arguments; the bot uses their IDs internally. Optional arguments are marked below. Replace example dates with a future date.

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
| `/squad set-rank-channel` | Server manager | `channel`: Rank update channel | Choose where automatic rank promotions are announced |
| `/squad clear-rank-channel` | Server manager | None | Disable automatic rank promotion announcements |
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

## /operation

| Command | Access | Arguments | Purpose |
| --- | --- | --- | --- |
| `/operation create` | Squad manager | `name`: Operation name<br>`starts`: Date with timezone, e.g. 2026-09-12T19:00:00-07:00<br>`channel`: Sign-up channel<br>`description` (optional): Briefing or instructions | Post operation sign-ups (squad managers) |

## Roster menus and buttons

| Control | Access | Behavior |
| --- | --- | --- |
| ⬅️ / ➡️ on the role roster | Everyone | Switch between named role-roster views. |
| Join or move to a squad | Everyone | Replaces your previous assignment. Moves involving a locked squad are blocked. Up to 100 squads appear in the menus. |
| Leave current squad | Everyone | Moves you to Unassigned unless your squad is locked. |
| Call my squad | Squad manager assigned to a squad | Posts the squad summons and pings members once in the configured call channel. One open summons per squad; one-minute cooldown. |
| Configure loadout | Squad manager assigned to a squad | Opens a private configuration panel for percentages, preference roles, and instructions. |
| Assign loadouts | Squad manager in their squad's temporary voice channel | Assigns loadouts to members in voice, sends DMs, and displays assignments on the roster. |
| Clear assignments | Squad manager assigned to a squad | Clears displayed loadouts for that squad. |

See [loadout configuration](README.md#loadouts-and-rank-progress) for preference matching, percentages, and experience priority. Join the configured voice lobby to create or reuse your squad's temporary channel; there is no separate voice-create command.

## Summons controls

The orange summons embed shows the squad's members, ranks, loadouts, readiness, and 🔒/🔓 status. New squad members appear as ❌; existing members keep their responses. Departed members are removed. Updates do not send new pings.

| Control | Access | Behavior |
| --- | --- | --- |
| ✅ reaction | Current squad member | Marks you ready. |
| ❌ reaction | Current squad member | Marks you not ready. |
| 🔓 button | Squad manager assigned to this squad, or server manager | Locks self-service joins, moves, and leaves. The button changes to 🔒. |
| 🔒 button | Squad manager assigned to this squad, or server manager | Unlocks membership changes. The button changes to 🔓. |
| Close squad summons | Squad manager | Freezes the final roster and readiness, removes buttons, and releases the squad lock. |

The main squad roster also shows each squad's current lock emoji. Explicit `/squad assign` and `/squad unassign` commands still work while locked. Locks do not change voice-channel permissions or prevent readiness responses.

The most recently added reaction wins. Removing a reaction alone does not change readiness. With Manage Messages, the bot clears each response reaction so it can be clicked repeatedly; without it, remove and re-add your reaction to repeat that response. Controls and saved state survive restarts. Closed summons cannot be reopened; use **Call my squad** to create a new one.

## Operation controls

```text
/operation create name:Saturday Operation starts:2026-09-12T19:00:00-07:00 channel:#operations description:Meet in squad voice before start.
```

`starts` must be a future ISO-style date and time with an explicit offset or `Z` for UTC, such as `2026-09-12T19:00:00-07:00`. Discord displays it in each reader's local timezone. The operation name is limited to 100 characters and the optional description to 600.

| Control | Access | Behavior |
| --- | --- | --- |
| Going / Maybe / Unavailable | Everyone | Sets or changes your response while sign-ups are open. |
| Start ready check | Squad manager | Freezes sign-ups and enables readiness reactions for Going/Maybe participants. |
| ✅ / ❌ reactions | Going/Maybe participants | Marks you ready or not ready during the ready check. |
| Close operation | Squad manager | Closes sign-ups/readiness and removes buttons, preserving the responses. |

The start time is informational: a manager starts the ready check manually. An operation can also be closed directly from sign-ups. Readiness does not automatically assign a squad or loadout, and operations do not provide squad locks. Large lists paginate, with controls on each page for the same operation.

## Common workflows

### Initial setup

```text
/roster setup
/squad set-channel channel:#squad-roster
/squad set-call-channel channel:#squad-calls
/squad set-leader-role role:@Squad Leader
/squad set-voice-lobby channel:#Join-to-Create
/squad set-rank-channel channel:#rank-updates
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

Deleting a publication preserves its configuration and squad assignments. Use its regular `set-channel` command to publish again. These commands target role/squad publications, not summons or operation messages. Squad deletion and role/page bulk removal require their explicit `confirm:true` arguments too.

### Check and set ranks

```text
/squad rank-progress
/squad rank-progress member:@Member
/squad set-rank member:@Member rank:SGT
```

Select the rank from Discord's offered choices. Only server managers can set it, and it must match the member's enlisted/officer eligibility. Command Sgt. Maj. and Sgt. Maj. of the Army are manual enlisted appointments. See [rank progression](README.md#4-set-up-the-rosters-in-discord) for thresholds. Time counts only in the member's own tracked squad voice channel.

### Refresh and recover

Use `/roster refresh` or `/squad refresh` after fixing permissions or if a roster looks stale. Squad refresh also updates open summons and voice access. A closed summons/operation stays closed; an open deleted page can be recreated during reconciliation.
