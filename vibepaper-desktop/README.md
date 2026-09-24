# VibePaper Desktop

This Electron host is the first local desktop slice. It creates and opens blank local projects, saves canvas nodes and edges to the selected project, and reuses the React/Vite renderer in `vibepaper-web`.

## Development

Install the Electron runtime in this folder, then start the Vite renderer and desktop host together:

```powershell
npm install
npm run dev
```

The `predev` and `prestart` hooks build the isolated Agent Worker bundle from the Pi workspace before launching the app. To open the renderer after building it, run `npm run build` in `vibepaper-web`, then run `npm start` here.

Each project contains `.vibepaper/project.json` and `.vibepaper/project.sqlite`. Project metadata declares `schemaVersion`; SQLite uses `user_version`, WAL, foreign keys, and optimistic canvas versions. Projects created by the first JSON bootstrap are imported from `canvas.json` on open, leaving that file as the migration source. Project IDs do not depend on the folder path, so a moved project can be reopened with **Open existing project**. A `.vibepaper/project.lock` single-writer lock prevents two app instances from opening the same project at once; a lock left by a dead process is recovered after checking its PID and token. PNG, JPEG, GIF, and WebP images can be imported into project-local content-addressed storage and placed on the canvas. **Back up project** creates a reopenable copy containing metadata, a consistent SQLite snapshot, registered image assets, verified outputs of succeeded tasks, and supported Agent sessions, control state, memory, and skills. Main closes its Agent Worker before backup; backup reports an error if another process still holds the Agent writer lock. **Restore backup** verifies the manifest and creates a separate project copy with a new project ID; Agent session headers are rebound to that identity, pending confirmations are invalidated, and unfinished Agent runs are aborted. Schema v1 backups remain supported. SQLite schema v3 stores task input hashes, idempotency keys, task state transitions, and event history; a restarted `running` task becomes `interrupted` and is not automatically resubmitted. Local text and Agnes text/image/video tasks write results under `.vibepaper/generated/<task-id>/`; the core verifies each result before marking success and the task panel can preview or add it to the canvas.

The renderer receives only narrow project, canvas, image-import, task-history, model configuration, and Agent session list/create methods in the preload bridge. It has no Node integration or direct filesystem access. Canvas, asset, and task persistence run in an Electron utility process. Separate generation and Agent utility processes handle model tasks and local session storage. The Agent Worker opens the active project's JSONL/SQLite stores and is stopped before project switches, backups, and application exit. Agnes uses the existing project model IDs at `https://apihub.agnes-ai.com/v1`; its API Key is encrypted through Electron `safeStorage` in a separate user-data credential file, never in ordinary settings or project data. Each cloud task requires a confirmation that names the prompt data, Agnes, and possible vendor fees. Agent session UI, Agent model turns, Tool Gateway, Agent cloud conversation, memory/compaction, audio generation, and installers remain later migration stages.
