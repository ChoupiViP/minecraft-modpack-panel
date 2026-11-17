# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/) and the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Discord bot link** (Settings → Discord bot) for [minecraft-modpack-panel-bot](https://github.com/ChoupiViP/minecraft-modpack-panel-bot): limited-access bot key (`Bearer`, only servers, start/stop/restart, console and bot settings; regenerating it disconnects the bot), bot settings stored in `data/bot.json`, signal sent to the bot every 5 minutes with the panel's address.
- **Cloudflare tunnel** (optional): `cloudflared` is downloaded automatically and makes the panel reachable over HTTPS without opening a port. Requires `PANEL_PASSWORD`.

## [0.4.0] - 2026-11-13

### Added
- **Files tab**: browse the server folder, edit text files (configs, scripts…) with Ctrl+S, upload, download, create folders and delete. Paths are sandboxed to the server folder.
- **Crash analysis**: when a server crashes, the panel shows the description, exception, suspected mods and missing dependencies (Forge, NeoForge, Fabric formats) and links to the full crash report.
- **Discord notifications** through a webhook: server online/stopped, crash (with suspected mods), player join/leave, failed backup. Includes a test button.
- **Start with Windows**: creates a hidden startup script with the current network settings. Servers can be set to start automatically with the panel.
- Fallback when the CurseForge API key cannot use search or list files: featured modpacks, search by project ID, versions from the modpack's latest files.
- Forge 1.16.5 builds older than 36.2.26, which crash on recent Java (8u321+, 11.0.14+), are upgraded automatically to the recommended Forge 1.16.5 build during installation.

### Fixed
- TPS responses are no longer shown in the console when a busy server answers slowly (the capture now waits for the end of the response).
- Minecraft formatting codes (`§e`, `§r`…) are removed from console lines.

### Tested
- Real CurseForge installs: *Dragon Mine Z* (Forge 1.20.1, 133 mods, built from the client pack) and *Create: Above and Beyond* (Forge 1.16.5, official server pack, Java 8 downloaded automatically).

## [0.3.0] - 2026-11-13

### Added
- **Mods tab**: lists installed mods with the name, version and description read from the jar (Fabric, Quilt, Forge, NeoForge, legacy `mcmod.info`), enables/disables a mod (`.jar.disabled`), deletes mods, and adds `.jar` files by upload or drag and drop. Fabric mods marked as client-only are flagged.
- **Schedule tab**: per-server scheduled tasks (restart, start, stop, backup, console command) at a given time on selected days. Restarts and stops can warn players in game 5 min and 1 min before.
- Automated tests with Node's built-in test runner (`npm test`), covering TPS parsing, scheduling, mod metadata, launch detection, `server.properties` editing and FR/EN translation parity.
- GitHub Actions CI on Linux and Windows with Node 20 and 22.
- `PANEL_DATA_DIR` environment variable to store data outside the project folder.

### Changed
- Small file sizes are now shown in KB instead of "0.0 MB".

## [0.2.0] - 2026-11-12

### Added
- First public release: CurseForge modpack installation (server pack or client pack rebuild), Forge/NeoForge/Fabric loaders, automatic Java download, live console, player management, CPU/RAM/TPS monitoring, multiple servers, backups, bilingual (EN/FR) mobile-friendly interface.

[0.4.0]: https://github.com/ChoupiViP/minecraft-modpack-panel/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ChoupiViP/minecraft-modpack-panel/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ChoupiViP/minecraft-modpack-panel/releases/tag/v0.2.0
