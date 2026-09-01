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
- Adds persistent Discord menus to the squad roster: choose a ✅ squad to join or move, or use the red ❌ button to leave.
- Lets server managers select an existing Discord role as the **squad leader role**.
- Lets everyone with that exact role create, rename, delete, and manage squad assignments.
- Lets server managers move or delete an entire published roster using any of its page message IDs.
- Keeps server configuration, squads, assignments, and publication message IDs isolated by server.
- Recreates a publication page if somebody deletes the bot's message.
- Does not require Message Content, Presence, Manage Roles, or Administrator permissions.

## Requirements

- Node.js 24 or newer
- A Discord application and bot token
- Permission to manage the Discord server during setup

## 1. Create and install the Discord app

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. On **Bot**, create the bot user and copy/reset its token.
3. Upload `assets/assignment-officer-avatar.png` as the bot's profile picture.
4. On **Bot → Privileged Gateway Intents**, enable **Server Members Intent**. Leave Message Content and Presence disabled.
5. On **Installation**, enable a server installation with the `applications.commands` and `bot` scopes.
6. Give the bot only these server/channel permissions:
   - View Channels
   - Send Messages
   - Embed Links
   - Read Message History
7. Use the installation link to add the bot to the server.

The bot does not grant or revoke the squad leader role, so it does not need Manage Roles. Server staff assign that normal Discord role to people using Discord's regular role controls.

## 2. Configure the project

Install dependencies and create the local environment file:

```powershell
npm install
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
/squad set-leader-role role:@Squad Leader
/squad set-voice-lobby channel:#Join-to-Create
/squad create name:Alpha
/squad create name:Bravo
/squad assign member:@Member squad:Alpha
```

Add tracked roles in the order they should appear. Server managers always retain squad-management access, even when no squad leader role is configured.

When an eligible member joins the configured voice lobby, the bot creates a voice channel beside it and moves them in. Squad leaders must be assigned to a squad, and their channel uses that squad's name. Server managers use their squad name when assigned or their display name otherwise. The bot deletes tracked temporary channels when they become empty.

Assigned members earn persistent voice-activity time only while they are in a temporary channel belonging to their own squad. Regular members automatically progress from Pvt. through Sgt. Maj.; Command Sgt. Maj. and Sgt. Maj. of the Army are manual appointments. Members with the configured squad-manager role use the officer track from 2nd Lt. through Col. The server owner and members with Manage Server can continue through Brig. Gen., Maj. Gen., Lt. Gen., and Gen. Moving from the enlisted track to the officer track starts the member at 2nd Lt. `/squad set-rank` can set a compatible automatic rank or manually appoint an enlisted member to one of the two senior enlisted ranks.

Pvt. is the starting enlisted rank. Enlisted promotion milestones are 1 hour for Pvt. 2nd Class, 2 for Pfc., 4 for Spc., 6 for Sgt., 10 for Staff Sgt., 16 for Sgt. 1st Class, 24 for Master Sgt., 36 for 1st Sgt., and 50 for Sgt. Maj.

Officer milestones are 3 hours for 1st Lt., 9 for Capt., 21 for Maj., 36 for Lt. Col., and 50 for Col. General-officer progression then continues at 64 hours for Brig. Gen., 86 for Maj. Gen., 100 for Lt. Gen., and 150 for Gen.

The squad roster publishes its own self-service controls. Any server member can select one of the ✅ menu options to join that squad; selecting another squad atomically replaces the previous assignment. The red **❌ Leave current squad** button moves that member to Unassigned. These controls continue working after a bot restart and do not require Message Content or reaction intents.

To move or remove a published roster, first enable Discord **Developer Mode**, right-click any page of that roster, and choose **Copy Message ID**. One page ID identifies the whole multi-page publication:

```text
/roster move message-id:123456789012345678 channel:#new-roster-channel
/roster delete message-id:123456789012345678 confirm:true
```

`/roster delete` disables the publication and removes all of its Discord message pages. It preserves tracked roles, squad definitions, and squad assignments so the roster can be re-enabled later with its regular `set-channel` command. If Discord temporarily refuses a page deletion, its controls become inactive immediately and the bot retries cleanup during later reconciliation runs, including after restart.

## Commands

### Roster publication and role roster — Manage Server required

| Command | Purpose |
| --- | --- |
| `/roster setup` | Guided channel picker and multi-role setup (up to 25 roles). |
| `/roster set-channel` | Select or move the role roster publication. |
| `/roster add-role` | Append a Discord role to the tracked roster. |
| `/roster remove-role` | Stop tracking a role. |
| `/roster list-roles` | Show tracked roles in publication order. |
| `/roster sort` | Sort tracked roles by server role hierarchy. |
| `/roster clear-roles` | Stop tracking every role after confirmation. |
| `/roster refresh` | Re-fetch members when allowed and republish now. |
| `/roster move` | Move an entire role or squad publication using any page message ID. |
| `/roster delete` | Disable and delete every page of a role or squad publication after confirmation. |

### Squad setup — Manage Server required

| Command | Purpose |
| --- | --- |
| `/squad set-channel` | Select or move the squad roster publication. |
| `/squad set-voice-lobby` | Choose a join-to-create lobby for temporary voice channels. |
| `/squad clear-voice-lobby` | Disable new temporary voice channel creation. |
| `/squad set-rank` | Set a compatible enlisted or officer activity rank (Manage Server only). |
| `/squad set-leader-role` | Select the existing role whose members may manage squads. |
| `/squad clear-leader-role` | Return squad management to server managers only. |

### Squad operations — squad leader role or Manage Server

| Command | Purpose |
| --- | --- |
| `/squad create` | Create a uniquely named squad. |
| `/squad rename` | Rename a squad. |
| `/squad delete` | Delete a squad after explicit confirmation; its members become Unassigned. |
| `/squad assign` | Assign a member, replacing any previous squad assignment. |
| `/squad unassign` | Move a member to Unassigned. |
| `/squad refresh` | Reconcile and republish the squad roster. |

`/squad list` is available to everyone and shows squad assignment counts.

### Squad roster menus — available to everyone

| Control | Purpose |
| --- | --- |
| `✅ Join or move to a squad` | Assign yourself to the selected squad, replacing any previous squad. Up to 100 squads are supported. |
| `❌ Leave current squad` | Remove your squad assignment and place you in Unassigned. |

## Persistence and operations

The default database is `data/roster.sqlite`. You do not need to create it manually: the bot creates the directory, SQLite file, tables, and indexes on its first successful startup. Back up that file to preserve all settings and squad assignments. Its write-ahead-log files may be present while the bot is running, so stop the bot before taking a simple file-copy backup.

Run one bot process against a database file. Live Discord events use the complete cached member list after startup; event bursts are debounced and serialized per server. Full member reconciliation is rate-limited inside the bot so repeated refresh requests do not violate Discord's full-member request limit.

Use this before deployment or after changes:

```powershell
npm run check
```

That command type-checks, runs the automated tests, and makes a production build.

## Troubleshooting

- **The bot disconnects with code 4014:** enable Server Members Intent in the Developer Portal.
- **The setup command reports missing permissions:** add the named permission specifically in the selected roster channel; channel overrides can remove a server-level grant.
- **Commands do not appear:** rerun `npm run deploy:commands`. Guild commands appear immediately; global commands can take longer to propagate.
- **Startup reports that `tsx/dist/loader.mjs` is missing:** from the project directory, confirm `node --version` is 24 or newer, run `npm ci` to restore the locked dependencies, then run `npm run dev` again.
- **An accidentally deleted roster page does not return immediately:** run the relevant refresh command. It will also be recovered by the next member event or periodic reconciliation. A roster removed with `/roster delete` stays disabled until `set-channel` is used again.
- **A squad menu says it is no longer active:** use the controls on the currently published squad roster; controls on old messages are intentionally rejected after a move or deletion.
- **A squad leader cannot manage squads:** confirm that `/squad set-leader-role` points to the exact role currently assigned to that member.

Discord references: [Gateway intents](https://docs.discord.com/developers/events/gateway), [application command permissions](https://docs.discord.com/developers/interactions/application-commands), and [message/allowed-mention behavior](https://docs.discord.com/developers/resources/message).
