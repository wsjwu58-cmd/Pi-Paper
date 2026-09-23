# VibePaper Desktop

This Electron host is the first local desktop slice. It creates and opens blank local projects, saves canvas nodes and edges to the selected project, and reuses the React/Vite renderer in `vibepaper-web`.

## Development

Install the Electron runtime in this folder, then start the Vite renderer and desktop host together:

```powershell
npm install
npm run dev
```

To open the renderer after building it, run `npm run build` in `vibepaper-web`, then run `npm start` here.

Each project contains `.vibepaper/project.json` and `.vibepaper/project.sqlite`. Project metadata declares `schemaVersion`; SQLite uses `user_version`, WAL, foreign keys, and optimistic canvas versions. Projects created by the first JSON bootstrap are imported from `canvas.json` on open, leaving that file as the migration source. Project IDs do not depend on the folder path, so a moved project can be reopened with **Open existing project**. A `.vibepaper/project.lock` single-writer lock prevents two app instances from opening the same project at once; a lock left by a dead process is recovered after checking its PID and token. PNG, JPEG, GIF, and WebP images can be imported into project-local content-addressed storage and placed on the canvas. **Back up project** creates a reopenable copy containing metadata, a consistent SQLite snapshot, registered image assets, and verified outputs of succeeded local tasks. **Restore backup** verifies the manifest and creates a separate project copy with a new project ID. SQLite schema v3 stores task input hashes, idempotency keys, task state transitions, and event history; a restarted `running` task becomes `interrupted` and is not automatically resubmitted. Task output paths are confined to `.vibepaper/generated/<task-id>/`, and a task is marked successful only after its result file is readable and hashed.

The renderer receives only narrow project, canvas, and image-import methods in the preload bridge. It has no Node integration or direct filesystem access. Canvas, asset, task persistence, and backup operations run in an Electron utility process, separate from the UI and Main lifecycle process. Internal task-store operations are ready for a worker client but are not exposed as a generation UI. Model catalog, task execution/provider adapters, Agent worker and Tool Gateway, credential vault, Agent control-store backup, and installers remain later migration stages in the desktop plan. Cloud task creation remains disabled until data disclosure and user authorization are wired.
