# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/) and the project follows [Semantic Versioning](https://semver.org/).

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

[0.3.0]: https://github.com/ChoupiViP/minecraft-modpack-panel/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ChoupiViP/minecraft-modpack-panel/releases/tag/v0.2.0
