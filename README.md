# Discord Role & Squad Roster Bot

A multi-server Discord bot that keeps two bot-owned roster publications current:

- a **role roster**, grouped by the Discord roles a server manager chooses;
- a **squad roster**, grouped by bot-managed squads with an Unassigned section.

The bot edits its existing messages instead of creating a new post for every change. Large rosters are split safely across multiple embed pages, configuration survives restarts in SQLite, and roster mentions are rendered with notifications disabled.

## What it does

- Updates after member joins, leaves, role changes, nickname changes, and tracked-role changes.
- Reconciles all members on startup and every 15 minutes by default.
- Supports any number of tracked roles; members can appear beneath multiple roles.
- Gives each member at most one squad assignment at a time.
- Adds persistent Discord menus to the squad roster for joining, moving, and leaving squads.
- Publishes live squad summons with roster embeds, readiness reactions, and manager-controlled membership locks.
- Updates open summons as members join or leave, preserving responses without repeating notifications.
- Supports operation sign-ups and manager-started ready checks.
- Grants squad members View Channel and Connect access to their temporary voice channel.
- Assigns preference-based loadouts and tracks voice activity for automatic ranks.
- Lets server managers select an existing Discord role as the **squad leader role**.
- Lets any assigned squad member use the voice lobby while enforcing one temporary voice channel per squad.
- Lets everyone with that exact role create, rename, delete, and manage squad assignments.
- Lets server managers move or delete an entire published roster using any of its page message IDs.
- Keeps server configuration, squads, assignments, and publication message IDs isolated by server.
- Recreates a publication page if somebody deletes the bot's message.
- Does not require Message Content, Presence, or Administrator permissions. Manage Roles is needed only for automatic squad voice permission updates.

## Requirements

- Node.js 24 or newer
- A Discord application and bot token
- Permission to manage the Discord server during setup

## 1. Create and install the Discord app

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. On **Bot**, create the bot user and copy/reset its token.
3. Upload `assets/assignment-officer-avatar.png` as the bot's profile picture.
4. On **Bot → Privileged Gateway Intents**, enable **Server Members Intent**. Leave Message Content and Presence disabled. Message reaction events are enabled by the bot for role-roster page navigation and ready checks.
5. On **Installation**, enable a server installation with the `applications.commands` and `bot` scopes.
6. Give the bot these basic server/channel permissions:
   - View Channels
   - Send Messages
   - Embed Links
   - Read Message History
   - Add Reactions
   - Manage Messages (checked during roster setup; also allows the bot to clear navigation/readiness reactions)

   If you use temporary squad voice channels, it also needs Connect, Manage Channels, Move Members, and Manage Roles (Manage Permissions on the voice category).
7. Use the installation link to add the bot to the server.

The bot does not grant or revoke the squad leader role. Manage Roles is needed for editing squad voice-channel permission overwrites. Server staff assign that normal Discord role to people using Discord's regular role controls.

## 2. Configure the project

Install dependencies and create the local environment file.

macOS/Linux:

```bash
npm ci
cp .env.example .env
```

Windows PowerShell:

```powershell
npm ci
Copy-Item .env.example .env
```

Fill in `.env`:

```dotenv
DISCORD_TOKEN=your-bot-token
DISCORD_APPLICATION_ID=your-application-id
DISCORD_GUILD_ID=your-test-server-id

DATABASE_PATH=./data/roster.sqlite
ROSTER_DEBOUNCE_MS=2000
RECONCILE_INTERVAL_MINUTES=15
```

`DISCORD_GUILD_ID` is recommended during development because guild command changes appear immediately. Enable Discord Developer Mode and use **Copy Server ID** to get it. For a public/multi-server deployment, remove `DISCORD_GUILD_ID` and deploy the commands again; Discord will register them globally.

Never commit `.env` or share the bot token. The included `.gitignore` excludes it.

## 3. Register commands and run

```powershell
npm run deploy:commands
npm run dev
```

For a compiled production run:

```powershell
npm run build
npm start
```

## 4. Set up the rosters in Discord

Create two text channels, then run:

```text
/roster setup

# Or configure individual settings:
/roster set-channel channel:#role-roster
/roster add-role role:@Command
/roster add-role role:@Medic
/roster add-role role:@Recon

/squad set-channel channel:#squad-roster
/squad set-call-channel channel:#squad-calls
/squad set-rank-channel channel:#rank-updates
/squad set-leader-role role:@Squad Leader
/squad set-voice-lobby channel:#Join-to-Create
/squad create name:Alpha
/squad create name:Bravo
/squad assign member:@Member squad:Alpha
```

The setup wizard builds a draft before changing the live roster. Choose the publication channel, create any number of named pages, assign up to 12 unique roles to each page, and optionally mark assigned roles as high priority. The roster publishes as one message; when multiple pages exist, use its ⬅️ and ➡️ reactions to cycle through every named view. High-priority roles are marked with a star.

Add tracked roles in the order they should appear. Server managers always retain squad-management access, even when no squad leader role is configured.

When any assigned squad member joins the configured voice lobby, the bot creates a voice channel beside it named for that squad and moves them in. If the squad already has a temporary channel, the member is moved into that existing channel instead. Members who are Unassigned cannot create a channel, and concurrent lobby joins are serialized so squad members cannot create separate channels for the same squad. The bot deletes the tracked squad channel when it becomes empty.

Assigned members earn persistent voice-activity time only while they are in a temporary channel belonging to their own squad. Regular members automatically progress from Pvt. through Sgt. Maj.; Command Sgt. Maj. and Sgt. Maj. of the Army are manual appointments. Members with the configured squad-manager role use the officer track from 2nd Lt. through Col. The server owner and members with Manage Server can continue through Brig. Gen., Maj. Gen., Lt. Gen., and Gen. Moving from the enlisted track to the officer track starts the member at 2nd Lt. `/squad set-rank` can set a compatible automatic rank or manually appoint an enlisted member to one of the two senior enlisted ranks.

Pvt. is the starting enlisted rank. Enlisted promotion milestones are 1 hour for Pvt. 2nd Class, 2 for Pfc., 4 for Cpl., 6 for Sgt., 10 for Staff Sgt., 16 for Sgt. 1st Class, 24 for Master Sgt., 36 for 1st Sgt., and 50 for Sgt. Maj.

Officer milestones are 3 hours for 1st Lt., 9 for Capt., 21 for Maj., 36 for Lt. Col., and 50 for Col. General-officer progression then continues at 64 hours for Brig. Gen., 86 for Maj. Gen., 100 for Lt. Gen., and 150 for Gen.

The squad roster publishes its own self-service controls. Any server member can select an unlocked squad to join; selecting another squad atomically replaces the previous assignment even when the current squad is locked. The **Leave current squad** button moves that member to Unassigned even if their squad is locked. An assigned squad manager can use **Call my squad** to notify every assigned member in the separately configured squad-call channel, with a one-minute per-squad cooldown. Any member can use `/squad rank-progress` to check live rank progress or provide its optional `member` argument to inspect somebody else. These controls continue working after a bot restart and do not require Message Content intent.

To move or remove a published roster, first enable Discord **Developer Mode**, right-click any page of that roster, and choose **Copy Message ID**. One page ID identifies the whole multi-page publication:

```text
/roster move message-id:123456789012345678 channel:#new-roster-channel
/roster delete message-id:123456789012345678 confirm:true
```

`/roster delete` disables the publication and removes all of its Discord message pages. It preserves tracked roles, squad definitions, and squad assignments so the roster can be re-enabled later with its regular `set-channel` command. If Discord temporarily refuses a page deletion, its controls become inactive immediately and the bot retries cleanup during later reconciliation runs, including after restart.

## Commands and controls

See [COMMANDS.md](COMMANDS.md) for every slash command, its arguments and access requirements, button behavior, and workflow examples.

## Loadouts and rank progress

Loadout configuration uses Discord's native role picker—leaders never type role names, and plain base Discord roles are not required. Each squad stores its own percentage-based template, allowing different squad types. Selecting `1st Medic` creates the underlying `Medic` loadout and asks what percentage of the squad should be Medics. Selecting `2nd Medic` afterward attaches only the fallback preference and does not add or change that percentage. A plain `Medic` role can still be selected if the server has one. First choices are matched first; second choices are fallbacks used only when an available slot cannot be filled by a first-choice member. Specialist roles are never forced onto members without a matching preference; any specialist requirement that has no first- or second-choice volunteer falls back to Rifleman. Percentages cannot total more than 100%. Primary loadout roles receive at least one slot when space allows. Secondary loadout roles wait for a full percentage slot after primary allocations; 10% Recon needs at least 10 members in the assignment pool. Other unallocated or rounding-leftover members are assigned Rifleman. Existing entries can be selected to edit percentages, fill priority, or instructions, or remove the role. There is no fixed squad-size or configured-role limit; configuration pages automatically paginate after 25 roles.

To make Recon optional for small squads, select Recon in **Configure loadout**, set its percentage to 10%, then choose **2nd — Secondary fill** in the fill-priority menu. **1st — Primary fill** reserves minimum slots when space allows. Fill priority controls slot counts and is separate from a member's personal `1st Recon` / `2nd Recon` Discord preferences. Existing roles and older templates default to primary; newly saved templates preserve each role's fill priority. Volunteers are shuffled anew each assignment run, so limited spots are chosen randomly within preference tiers. Random selection allows repeat winners; it is not a rotation guarantee.

To configure a squad type:

1. Create Discord preference roles such as `1st Medic`, `2nd Medic`, `1st Pilot`, and `2nd Pilot`, then give members whichever preferences apply. A member may have multiple second-choice roles.
2. Assign the squad leader to the squad and press **Configure loadout** in the live squad roster.
3. Select `1st Medic`, enter the desired Medic percentage, and optionally provide loadout instructions. This defines the underlying `Medic` assignment; a plain Medic Discord role is unnecessary.
4. Select `2nd Medic` to attach it as a fallback. It does not receive a separate percentage.
5. Repeat for other specialist roles, then press **Done**. Any percentage not allocated to specialists becomes Rifleman.
6. Have eligible members join that squad's temporary voice channel, then press **Assign loadouts**. The bot refreshes their current Discord roles, fills first choices, fills second choices, and converts specialist vacancies without volunteers to Rifleman. Assignments are shown in the roster and manager response; assignment DMs are currently paused while that workflow is being refined.

Assigned loadout roles remain visible in the squad roster until a manager clears them or reruns assignment. A member's assignment is also removed automatically when they leave, move squads, are removed from the server, or their squad is deleted.

Loadout assignments use a fresh random volunteer order each run. First choices are matched before second choices, but neither time in a role nor total squad voice time gives priority. Per-loadout timers no longer run; historical totals remain stored but are unused. Normal squad voice time still counts toward ranks. Before every assignment run, the bot refreshes each voice member directly from Discord so recently changed preference roles are used immediately. Preference matching accepts either the Discord role selected during configuration or an exact `1st [role]` / `2nd [role]` role name.

In **Configure loadout**, select a role and press **Min / Max slots**. Minimums reserve jobs before percentage targets; maximums cap the role even in a large squad. Use minimum 1, maximum 2 for Medic, or minimum 0, maximum 1 for optional Recon. Values are whole numbers from 0–1000; minimum cannot exceed maximum. Leave minimum blank to use the fill-priority default (primary 1, secondary 0), and maximum blank for no cap. Set maximum 0 with minimum 0 to disable that role's slots without deleting its configuration.

The bot first reserves minimums, then fills toward percentage targets within the caps, then assigns remaining members Rifleman. If minimums exceed squad size, primary roles precede secondary roles; within a priority, higher percentages come first, then configuration order. Minimum slots are matched before optional slots: a second-choice Medic can fill a minimum before their first-choice Recon is considered. First-choice volunteers still precede second-choice volunteers within each pass, and selection is randomized. Specialists require a matching preference; unmet minimums appear in the manager's assignment summary. If Rifleman itself has a maximum, excess fallback members display **Unassigned loadout** while keeping their squad membership.

In **Configure loadout**, use **Save template** to save the current percentages, minimums, maximums, fill priorities, role preferences, and instructions under a name such as `Infantry`. Templates are available to assigned squad managers throughout the same server and survive restarts. Names must be unique within the server (ignoring case), between 1 and 30 characters; saving does not overwrite an existing template. Older templates use automatic minimums and no maximum.

Use **Load template** to open the template menu, select a saved template, and press **Load template** in that menu to replace the squad's loadout configuration and clear its current assignments. Loading `Infantry` onto `Alpha` renames it to `Alpha (Infantry)`. Loading another template replaces the previous template suffix, rather than stacking suffixes. The complete squad name must fit the 50-character squad-name limit and remain unique; if not, nothing is applied. The main roster, open summons, and existing temporary voice channel update to the new name. Template changes apply to the configuration; press **Assign loadouts** when ready to assign members. The template picker paginates after 25 templates.

After selecting a template, **Rename template** opens a name-entry modal and **Delete template** asks for confirmation. Renaming follows the same name-length and uniqueness rules as saving. These actions affect the saved template only: squads that previously loaded it retain their names and settings. Reload a renamed template to apply its new suffix. Deleting cannot be undone; cancel the confirmation to keep it.

The squad roster includes a dedicated **Squad Leaders** section when a squad leader role is configured. It shows each leader's current rank and assigned squad, including leaders who are currently Unassigned. `/squad rank-progress` includes time from an active voice session, not only completed sessions. While a member remains in tracked squad voice, the roster refreshes at the exact next rank threshold and automatic promotions are announced immediately in the configured rank-update channel; leaving and rejoining is unnecessary.

## Operation sign-ups and squad summons

Squad managers can schedule an operation in a chosen text channel:

```text
/operation create name:Saturday Operation starts:2026-09-12T19:00:00-07:00 channel:#operations description:Meet in squad voice before start.
```

Enter a future date and include a timezone offset (or `Z` for UTC). Discord displays the start time in each reader's local timezone. Members use **Going**, **Maybe**, or **Unavailable** and can change their response while sign-ups are open. A squad manager presses **Start ready check** to freeze sign-ups and let Going/Maybe participants respond with ✅ or ❌. Ready checks are started manually, not automatically at the scheduled time. **Close operation** freezes all responses and removes its buttons.

**Call my squad** opens a persistent squad summons in the same orange embed format as the squad roster, with member ranks, assigned loadouts, readiness beside each name, a ready count, and pagination. Members start as ❌ Not ready. The summons includes **🔓 / 🔒** and **Close squad summons** buttons. A separate notification pings squad members once. Open summons follow current squad membership: new members appear as ❌ Not ready, existing members keep their responses, and departed members are removed. These edits do not send another ping or require reopening the summons. Closed summons retain their final membership. Only one summons can be open per squad, and the existing one-minute call cooldown still applies.

Members react ✅ to mark ready or ❌ to mark not ready. The latest added reaction determines the status beside their name; removing a reaction does not change the saved status. Give the bot **Manage Messages** in these channels to clear each response reaction automatically, allowing repeated clicks. Without it, members must remove and re-add a previously selected reaction to send that response again. Only squad managers (the configured leader role or Manage Server) can close a summons. Closing preserves its final roster and freezes readiness.

Sign-ups, readiness, message IDs, and closed status persist in SQLite. Large lists span multiple messages, each with controls for the same operation or summons. Updates never re-ping members. Open publications are refreshed on startup and during periodic reconciliation, including recovery of deleted pages. Redeploy slash commands with `npm run deploy:commands` after installing this update.

Squad managers assigned to the summoned squad can click **🔓** to block self-service joins and moves into the squad. Current members can still leave or move to an unlocked squad. Members with Manage Server can lock or unlock any summoned squad. Explicit manager `/squad assign` and `/squad unassign` commands remain available. Locking does not block readiness reactions or alter voice-channel permissions. Locks survive restarts and are released by clicking **🔒** or automatically when the summons closes. Existing summons without a saved lock start unlocked.

The summons lock button and status use only 🔒/🔓. Each squad heading in the main roster also shows its current lock emoji, and locking, unlocking, or closing a summons schedules an immediate roster update.

## Squad voice access

Temporary squad voice channels explicitly allow **View Channel** and **Connect** for all assigned squad members. Access is synchronized before lobby members are moved, on squad roster updates, on startup, and during periodic reconciliation. New squad members gain access to an existing channel; on departure, the bot restores their prior View Channel/Connect overwrite values while preserving unrelated permissions. Other category and role permissions remain in place. Grant the bot **Manage Roles / Manage Permissions**, View Channel, and Connect in the voice category so it can apply these overrides.

If Discord rejects a squad voice permission update, the bot logs the missing permission and still attempts to move the member using the channel’s existing permissions. It keeps a usable channel tracked and retries access updates on later roster refreshes. A permission-edit failure alone does not delete the new channel.

## Persistence and operations

The default database is `data/roster.sqlite`. You do not need to create it manually: the bot creates the directory, SQLite file, tables, and indexes on its first successful startup. Back up that file to preserve all settings and squad assignments. Its write-ahead-log files may be present while the bot is running, so stop the bot before taking a simple file-copy backup.

Run one bot process against a database file. Live Discord events use the complete cached member list after startup; event bursts are debounced and serialized per server. Full member reconciliation is rate-limited inside the bot so repeated refresh requests do not violate Discord's full-member request limit.

Use this before deployment or after changes:

```powershell
npm run check
```

That command type-checks, runs the automated tests, and makes a production build.

After pulling a new release, stop the running bot and use:

```bash
npm ci
npm run deploy:commands
npm run check
npm start
```

Running `deploy:commands` is important after command changes. Keep `.env` private; the tracked `.env.example` is intentionally empty, and the required variable names and defaults are documented in section 2 above.

### Run continuously with systemd

Ubuntu/Linux service files are included in `deploy/systemd`. The main service starts at boot, gracefully handles `SIGTERM`, and automatically restarts five seconds after a crash. A separate timer performs one controlled restart daily at approximately 4:00 AM server-local time; a randomized delay of up to five minutes prevents every service on the host restarting simultaneously. `Persistent=true` runs a missed daily restart after the machine next boots.

The included units target this deployment path and account:

- repository: `/home/ubuntu/discord-roster-bot`
- service account: `ubuntu`
- Node/npm installation: `/usr/local/bin/npm`

If your installation differs, edit `User`, `Group`, `WorkingDirectory`, `EnvironmentFile`, `ExecStart`, and `ReadWritePaths` in `discord-roster-bot.service` before installing it.

Build the bot, install the units, and enable both the bot and daily timer:

```bash
cd /home/ubuntu/discord-roster-bot
npm ci
npm run build
sudo cp deploy/systemd/discord-roster-bot.service /etc/systemd/system/
sudo cp deploy/systemd/discord-roster-bot-daily-restart.service /etc/systemd/system/
sudo cp deploy/systemd/discord-roster-bot-daily-restart.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now discord-roster-bot.service
sudo systemctl enable --now discord-roster-bot-daily-restart.timer
```

Useful operational commands:

```bash
systemctl status discord-roster-bot.service
systemctl status discord-roster-bot-daily-restart.timer
systemctl list-timers discord-roster-bot-daily-restart.timer
journalctl -u discord-roster-bot.service -f
sudo systemctl restart discord-roster-bot.service
```

After deploying code updates, run `npm ci`, `npm run check`, redeploy changed commands with `npm run deploy:commands`, and `sudo systemctl restart discord-roster-bot.service`. The service writes only to the repository's `data` directory under its systemd filesystem restrictions. Do not run `npm start` manually at the same time; two bot processes must not share one SQLite database.

## Troubleshooting

- **The bot disconnects with code 4014:** enable Server Members Intent in the Developer Portal.
- **The setup command reports missing permissions:** add the named permission specifically in the selected roster channel; channel overrides can remove a server-level grant.
- **Commands do not appear:** rerun `npm run deploy:commands`. Guild commands appear immediately; global commands can take longer to propagate.
- **Startup reports that `tsx/dist/loader.mjs` is missing:** from the project directory, confirm `node --version` is 24 or newer, run `npm ci` to restore the locked dependencies, then run `npm run dev` again.
- **An accidentally deleted roster page does not return immediately:** run the relevant refresh command. It will also be recovered by the next member event or periodic reconciliation. A roster removed with `/roster delete` stays disabled until `set-channel` is used again.
- **A squad menu says it is no longer active:** use the controls on the currently published squad roster; controls on old messages are intentionally rejected after a move or deletion.
- **A squad leader cannot manage squads:** confirm that `/squad set-leader-role` points to the exact role currently assigned to that member.
- **Voice permission updates report Missing Permissions:** grant the bot Manage Roles / Manage Permissions, View Channel, and Connect in the voice category. The bot still attempts to move members using existing channel access and retries permission updates later.
- **Joining the voice lobby does nothing:** the member must first join a squad using the roster menu or be assigned by a squad manager. If their squad channel already exists, the bot moves them there instead of creating another one.
- **A preferred loadout keeps becoming Rifleman:** confirm the member is in the correct squad voice channel, the squad has a positive percentage for that specialist, and the Discord role is named `1st Role Name` or `2nd Role Name`. Rerunning assignment replaces the prior result.
- **Rank time is not increasing:** only time in a tracked temporary voice channel belonging to the member's assigned squad counts. Ordinary voice channels and another squad's channel do not count.
- **Promotion messages do not appear:** run `/squad set-rank-channel` and verify the bot has View Channel and Send Messages there. The bot schedules each announcement for the live promotion threshold while the member remains in tracked squad voice.

Discord references: [Gateway intents](https://docs.discord.com/developers/events/gateway), [application command permissions](https://docs.discord.com/developers/interactions/application-commands), and [message/allowed-mention behavior](https://docs.discord.com/developers/resources/message).
