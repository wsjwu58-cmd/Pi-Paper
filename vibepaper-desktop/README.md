# VibePaper Desktop

This Electron host is the first local desktop slice. It creates and opens blank local projects, saves canvas nodes and edges to the selected project, and reuses the React/Vite renderer in `vibepaper-web`.

## Development

Install the Electron runtime in this folder, then start the Vite renderer and desktop host together:

```powershell
npm install
npm run dev
```

To open the renderer after building it, run `npm run build` in `vibepaper-web`, then run `npm start` here.

Each project contains `.vibepaper/project.json` and `.vibepaper/canvas.json`. Both files declare `schemaVersion`; canvas writes use a version check and same-directory atomic replacement. Project IDs do not depend on the folder path, so a moved project can be reopened with **Open existing project**.

The renderer receives only the narrow project and canvas methods in the preload bridge. It has no Node integration or direct filesystem access. This slice does not yet provide the full Local Core, asset/task stores, model catalog, Agent worker, credential vault, backup/restore, or installers; those remain later migration stages in the desktop plan.
