# VibePaper Desktop

This Electron host is the first local desktop slice. It creates and opens blank local projects, saves canvas nodes and edges to the selected project, and reuses the React/Vite renderer in `vibepaper-web`.

## Development

Install the Electron runtime in this folder, then start the Vite renderer and desktop host together:

```powershell
npm install
npm run dev
```

To open the renderer after building it, run `npm run build` in `vibepaper-web`, then run `npm start` here.

Each project contains `.vibepaper/project.json` and `.vibepaper/project.sqlite`. Project metadata declares `schemaVersion`; SQLite uses `user_version`, WAL, foreign keys, and optimistic canvas versions. Projects created by the first JSON bootstrap are imported from `canvas.json` on open, leaving that file as the migration source. Project IDs do not depend on the folder path, so a moved project can be reopened with **Open existing project**. PNG, JPEG, GIF, and WebP images can be imported into project-local content-addressed storage and placed on the canvas. **Back up project** creates a reopenable copy containing metadata, a consistent SQLite snapshot, and all registered image assets. Task and Agent files are not implemented yet and are not included.

The renderer receives only narrow project, canvas, and image-import methods in the preload bridge. It has no Node integration or direct filesystem access. Canvas and asset persistence plus backup run in an Electron utility process, separate from the UI and Main lifecycle process. Task storage, model catalog, Agent worker, credential vault, full backup/restore, project locks, and installers remain later migration stages in the desktop plan.
