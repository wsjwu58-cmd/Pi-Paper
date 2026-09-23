# VibePaper Desktop

This Electron host is the first local desktop slice. It creates and opens blank local projects, saves canvas nodes and edges to the selected project, and reuses the React/Vite renderer in `vibepaper-web`.

## Development

Install the Electron runtime in this folder, then start the Vite renderer and desktop host together:

```powershell
npm install
npm run dev
```

To open the renderer after building it, run `npm run build` in `vibepaper-web`, then run `npm start` here.

Each project contains `.vibepaper/project.json` and `.vibepaper/project.sqlite`. Project metadata declares `schemaVersion`; SQLite uses `user_version`, WAL, foreign keys, and optimistic canvas versions. Projects created by the first JSON bootstrap are imported from `canvas.json` on open, leaving that file as the migration source. Project IDs do not depend on the folder path, so a moved project can be reopened with **Open existing project**. A `.vibepaper/project.lock` single-writer lock prevents two app instances from opening the same project at once; a lock left by a dead process is recovered after checking its PID and token. PNG, JPEG, GIF, and WebP images can be imported into project-local content-addressed storage and placed on the canvas. **Back up project** creates a reopenable copy containing metadata, a consistent SQLite snapshot, registered image assets, and verified outputs of succeeded tasks. **Restore backup** verifies the manifest and creates a separate project copy with a new project ID. SQLite schema v3 stores task input hashes, idempotency keys, task state transitions, and event history; a restarted `running` task becomes `interrupted` and is not automatically resubmitted. Local text and Agnes text/image/video tasks write results under `.vibepaper/generated/<task-id>/`; the core verifies each result before marking success and the task panel can preview or add it to the canvas.

The renderer receives only narrow project, canvas, image-import, task-history, and model configuration methods in the preload bridge. It has no Node integration or direct filesystem access. Canvas, asset, and task persistence run in an Electron utility process. A separate generation utility process supports local text plus Agnes text, image, and video tasks. Agnes uses the existing project model IDs at `https://apihub.agnes-ai.com/v1`; its API Key is encrypted through Electron `safeStorage` in a separate user-data credential file, never in ordinary settings or project data. Each cloud task requires a confirmation that names the prompt data, Agnes, and possible vendor fees. Audio generation, Agent worker and Tool Gateway, Agent cloud conversation, Agent control-store backup, and installers remain later migration stages.
