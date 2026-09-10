# Role & Squad Roster Bot
## Administrator Guide

The bot gives server administrators six main systems to manage:

1. A live **role roster** built from selected Discord roles.
2. A live **squad roster** with self-service membership controls.
3. Squad-manager access through one designated Discord role.
4. Temporary squad voice channels and activity-based ranks.
5. Squad loadouts, reusable templates, summons, readiness, and locks.
6. A persistent public rank leaderboard with separate officer and enlisted pages.

This bot's moderation tools cover squad assignments, squad entry, ranks, publications, and access to temporary squad voice channels. It does not warn, mute, timeout, kick, ban, filter messages, or replace Discord's normal moderation tools.

## Quick start

1. Give the bot **View Channel**, **Send Messages**, **Embed Links**, **Read Message History**, **Add Reactions**, and **Manage Messages** in its roster and summons channels.
2. Run `/roster setup` and finish the private setup menus.
3. Run `/roster set-access-roles member-role:@Member conscript-role:@Conscript` if the server uses membership tiers.
4. Run `/squad set-channel channel:#squad-roster`.
5. Run `/squad set-call-channel channel:#squad-calls`.
6. Run `/squad set-leader-role role:@Squad Leader`.
7. Run `/squad set-voice-lobby channel:#Create-a-Squad-Channel` if temporary voice is wanted.
8. Run `/squad set-leaderboard-channel channel:#rank-leaderboard` if a public leaderboard is wanted.
9. Create squads with `/squad create name:Alpha`, then assign their leaders.
10. Use `/roster refresh` or `/squad refresh` if a publication does not update after a few seconds.

Run `npm run deploy:commands` whenever the bot's slash commands are added, removed, or changed. Restarting the bot alone does not update Discord's command list.

## 1. Understanding access levels

### Server managers

A member with Discord's **Manage Server** permission can:

- Configure, move, refresh, or remove roster publications.
- Configure the squad-call channel, leader role, voice lobby, and public leaderboard.
- Create and manage any squad.
- Assign compatible ranks and wipe rank progress.
- Lock or unlock any open squad summons.

Because these commands can change server-wide data, give Manage Server only to trusted staff.

### Squad managers

A member with the exact role selected by `/squad set-leader-role` can create, rename, delete, assign, unassign, list, and refresh squads. When assigned to a squad, that manager can also call, lock, configure, and assign loadouts for their own squad.

The bot does not grant or remove the squad leader role. Administrators manage that role through Discord. Changing or clearing the configured role changes who the bot recognizes as a squad manager; it does not alter anyone's Discord roles.

### Members

Members can join, move between, or leave squads through the current squad roster. They can view private rank progress and leaderboard results. They cannot enter a locked squad through self-service controls, but members already inside may leave or move out.

### Conscripts

When access roles are configured, members holding only the Conscript role appear in a dedicated **Conscripts** section and may join squads, use temporary squad voice, receive loadouts, and respond to summons. They display **Conscript** instead of an activity rank and do not accrue rank time or appear on rank leaderboards.

The configured Member role grants full access and takes precedence when someone holds both roles. Users with neither configured role stay off the rosters and cannot be assigned or self-join a squad. Changing access roles preserves existing assignments and rank records. Use `/roster clear-access-roles` to return to full access for all otherwise eligible server members.

## 2. Required bot permissions

For role rosters, squad rosters, summons, and the public leaderboard, grant:

- View Channel
- Send Messages
- Embed Links
- Read Message History
- Add Reactions
- Manage Messages

Manage Messages lets the bot clear roster-navigation and readiness reactions after use. Without it, most publications still work, but members may need to remove a readiness reaction before selecting it again.

For temporary squad voice channels, also grant these permissions in the voice lobby's category:

- Connect
- Manage Channels
- Move Members
- Manage Roles / Manage Permissions

Manage Roles is used to edit voice-channel permission overwrites. Keep the bot's role high enough in the role list for the permissions it must manage. Channel-specific denies can override server-level permissions, so check the exact destination channel when setup reports a missing permission.

The Discord Developer Portal must have **Server Members Intent** enabled. Message Content and Presence intents are not required.

## 3. Setting up and moderating the role roster

Run `/roster setup` for the guided setup. It lets you choose a channel, create named pages, select tracked Discord roles, and mark roles as high priority before publishing.

You can also maintain it with individual commands:

- `/roster set-access-roles member-role:@Member conscript-role:@Conscript` configures full and limited participation.
- `/roster clear-access-roles` removes both tier requirements.
- `/roster add-page name:Leadership` adds a named view.
- `/roster remove-page page:Leadership confirm:true` removes a view and moves its tracked roles to another page.
- `/roster add-role role:@Medic` starts tracking a role.
- `/roster remove-role role:@Medic` stops tracking it.
- `/roster move-role role:@Medic page:Specialists` changes its page.
- `/roster set-priority role:@Medic high-priority:true` adds the priority marker.
- `/roster sort` follows the server's Discord role hierarchy.
- `/roster clear-roles confirm:true` removes every tracked role.

High priority is a visual roster marker. It does not change Discord permissions, member assignments, loadout selection, or rank progression.

The role roster reads current Discord roles; the bot does not grant or revoke them. Use Discord's normal role controls when moderating role membership.

## 4. Setting up and moderating squads

Create and maintain squads with:

- `/squad create name:Alpha`
- `/squad rename squad:Alpha name:Bravo`
- `/squad delete squad:Bravo confirm:true`
- `/squad assign member:@Member squad:Alpha`
- `/squad unassign member:@Member`
- `/squad list`

A member can belong to only one squad. Assigning them to another squad replaces the previous assignment. Moving, leaving, unassigning, or deleting their squad ends qualifying voice activity for the old squad and clears their displayed loadout assignment.

Use explicit `/squad assign` and `/squad unassign` commands when staff need to override self-service membership. These manager actions remain available when a squad is locked.

Deleting a squad requires `confirm:true`, unassigns its members, and removes its squad-specific configuration. Check `/squad list` before deleting when names are similar.

### Locking squad entry

An open summons has a 🔓/🔒 manager button:

- Pressing 🔓 locks entry and changes the control to 🔒.
- Pressing 🔒 unlocks entry and changes the control to 🔓.

A lock blocks new self-service joins and moves into that squad. It does not trap current members, block staff assignments, stop readiness responses, or change voice permissions. The main squad roster shows the same lock icon. Closing the summons releases the lock.

## 5. Managing roster publications

Use `/roster set-channel` for the role roster and `/squad set-channel` for the squad roster. The bot edits its existing messages rather than posting a new roster for each update.

To move or remove a role or squad publication:

1. Enable Discord **Developer Mode**.
2. Right-click any page of the publication and choose **Copy Message ID**.
3. Use one of these commands:

```text
/roster move message-id:123456789012345678 channel:#new-roster
/roster delete message-id:123456789012345678 confirm:true
```

One page ID identifies the complete multi-page publication. Deleting a publication disables and removes its messages but preserves tracked roles, squads, and assignments. Republish it later with its regular `set-channel` command.

The public rank leaderboard has dedicated controls:

```text
/squad set-leaderboard-channel channel:#rank-leaderboard
/squad clear-leaderboard-channel
```

It uses separate officer and enlisted embed pages and creates continuation pages for large tracks. It updates after relevant member changes, rank thresholds, startup, manual refreshes, and periodic reconciliation. Use `/squad set-leaderboard-channel` again to move it.

If somebody manually deletes a live page, the bot recreates it during a later refresh. `/roster delete` is the correct way to intentionally disable a role or squad publication.

## 6. Managing temporary squad voice

Set the join-to-create lobby with:

```text
/squad set-voice-lobby channel:#Create-a-Squad-Channel
```

When an assigned member joins the lobby, the bot creates or reuses one temporary voice channel for that member's squad and moves them into it. The channel is deleted when empty.

The bot gives assigned squad members explicit **View Channel** and **Connect** access. Membership updates synchronize access to an existing channel. When a member leaves the squad, the bot restores their previous View Channel and Connect overwrite values while preserving unrelated permissions.

Use `/squad clear-voice-lobby` to disable new temporary-channel creation. Existing tracked channels remain until empty and are then removed normally.

If the bot cannot create or update a voice channel, check its permissions on both the lobby and its category. The bot may still move someone when existing channel permissions already allow it, and it retries permission synchronization during later refreshes.

## 7. Managing ranks and leaderboards

Rank time counts only when a member is assigned to a squad and is inside that same squad's bot-created temporary voice channel. Promotions are silent: the bot does not send automatic rank messages or DMs.

The configured squad leader role places its members on the officer track. The server owner and members with Manage Server can reach general-officer ranks. Other members use the enlisted track. Changing tracks resets that member's accumulated rank time.

Administrators can set a compatible rank with:

```text
/squad set-rank member:@Member rank:SGT
```

For automatic ranks, this sets the member's activity time to that rank's threshold. Command Sgt. Maj. and Sgt. Maj. of the Army are manual enlisted appointments. Officer ranks can only be assigned to members currently eligible for the officer track, and general ranks require the server owner or Manage Server.

Everyone can use `/squad rank-progress` and the private `/squad leaderboard`. The persistent public leaderboard is configured separately and shows officer and enlisted ranks on separate pages.

### Rank wipe moderation

Only members with Manage Server can run rank wipes:

```text
/squad wipe-rank member:@Member confirm:true
/squad wipe-ranks confirm:true
```

The first command clears one member's rank time and manual appointment. The second clears every stored member record for that server, including departed members. Active qualifying voice sessions restart at the wipe time, so time earned before the wipe is not restored when someone disconnects.

Rank wipes preserve squad membership, loadout configuration, templates, and data belonging to other servers. They have no undo command. Back up the SQLite database before a planned server-wide wipe.

## 8. Configuring and assigning loadouts

Create Discord preference roles using names such as `1st Medic`, `2nd Medic`, `1st Recon`, and `2nd Recon`. Members may choose multiple optional `2nd [role]` preferences.

An assigned squad manager opens **Configure loadout** on the squad roster, selects a preference role, and enters its percentage, optional instructions, minimum slots, and maximum slots.

The assignment order is:

1. First-group minimums and percentage targets.
2. Second-group minimums and percentage targets.
3. Rifleman for remaining members, subject to a configured Rifleman maximum.

First-group roles prefer members with the matching `1st [role]`, then matching `2nd [role]` volunteers. Second-group roles and eligible volunteers are shuffled, and first/second preferences compete equally there. Time previously served in a loadout gives no advantage.

Minimums reserve jobs and maximums cap them. A blank minimum defaults to 1 in the first group and 0 in the second. A blank maximum is unlimited. Minimum cannot exceed maximum. If no eligible volunteer exists, the manager's private assignment summary reports the unmet minimum.

**Assign loadouts** uses members currently in that squad's temporary voice channel. It refreshes their Discord roles before drawing assignments. Results appear on the squad roster; assignment DMs are currently disabled. **Clear assignments** removes the displayed assignments for that squad.

## 9. Managing loadout templates

Inside **Configure loadout**:

- **Save template** stores the current percentages, fill groups, role mappings, instructions, minimums, and maximums under a unique name.
- **Load template** replaces the current squad configuration and clears old assignments.
- **Rename template** changes a saved template's name.
- **Delete template** requires a separate confirmation.

Loading `Infantry` onto `Alpha` renames the squad to `Alpha (Infantry)`. Loading another template replaces the existing template suffix. The final squad name must remain unique and no longer than 50 characters.

Renaming or deleting a saved template does not retroactively alter squads that previously loaded it. Reload the template to apply its new name or settings.

## 10. Managing squad summons and readiness

An assigned squad manager presses **Call my squad** on the current squad roster. The bot posts an orange summons in the configured call channel and sends one notification that mentions the current squad members.

The summons displays:

- Current squad membership.
- Rank and assigned loadout beside each member.
- ✅ Ready or ❌ Not ready beside each member.
- A ready count.
- The squad's 🔓/🔒 state.

Open summons update when members join or leave the squad without sending another ping. Existing readiness is preserved for members who remain. Only one open summons is allowed per squad, and calls have a one-minute per-squad cooldown.

Current squad members react ✅ or ❌ to update readiness. Squad managers use the lock button and **Close squad summons**. Closing deletes the summons pages and their one-time notification messages, freezes readiness, and releases the squad lock.

## 11. Routine administration

Use these checks after configuration changes or when data looks stale:

- `/roster list-roles` confirms tracked roles.
- `/squad list` confirms squads and assignment counts.
- `/roster refresh` reconciles and republishes the role roster.
- `/squad refresh` reconciles the squad roster, leaderboard, open summons, and voice access.
- `/squad rank-progress member:@Member` checks a member's current recorded time.

The bot also reconciles automatically on startup and every 15 minutes by default. Member, role, nickname, squad, and voice events schedule faster updates.

Back up `data/roster.sqlite` to preserve settings, squads, assignments, templates, rank data, and publication state. Stop the bot before making a simple file-copy backup so its SQLite write-ahead-log files are settled. Run only one bot process against a database file.

## 12. Common moderation situations

### A member joined the wrong squad

> Use `/squad assign member:@Member squad:Correct Squad` to move them, or `/squad unassign member:@Member` to make them Unassigned. The old loadout assignment is cleared automatically.

### A squad should stop accepting members

> The assigned squad manager should call the squad and press 🔓 on the summons. It changes to 🔒 and blocks new self-service entry. Existing members can still leave.

### A squad must be removed

> Check `/squad list`, then run `/squad delete squad:Squad Name confirm:true`. Its members become Unassigned.

### A rank was set incorrectly

> Use `/squad set-rank` to place the member at the correct compatible rank. Use `/squad wipe-rank ... confirm:true` only when their progress and manual appointment should be erased.

### Every rank must be reset for a new season

> Back up the database first, then run `/squad wipe-ranks confirm:true`. The reset is server-wide and has no undo command.

### A roster page was deleted manually

> Run `/roster refresh` or `/squad refresh`. An enabled publication recreates missing pages. If the publication was disabled with `/roster delete`, set its channel again.

### An old squad menu says it is inactive

> Direct members to the current squad roster. Controls on old, moved, or deleted publications are intentionally rejected.

### A squad manager cannot use manager controls

> Confirm `/squad set-leader-role` points to the exact Discord role they hold. For squad-specific buttons, also confirm the manager is assigned to that squad.

### A member cannot see their squad voice channel

> Confirm their squad assignment, then run `/squad refresh`. Check the bot's Manage Roles / Manage Permissions, View Channel, and Connect permissions in the voice category.

### Rank time is not increasing

> Confirm the member is assigned to the squad that owns the temporary voice channel. Ordinary voice channels, the lobby itself, and another squad's temporary channel do not count.

### The bot is not announcing promotions

> This is intentional. Promotions are silent. Use the squad roster, `/squad rank-progress`, or a leaderboard to inspect ranks.

## Full command reference

See [COMMANDS.md](COMMANDS.md) for every command argument and access requirement. See [README.md](README.md) for installation, deployment, systemd service management, and technical troubleshooting.
