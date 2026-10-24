# Seamind desktop

This is a Tauri 2 desktop app with a Markdown editor, a live interactive Markmap canvas, and AI generation through OpenAI-compatible Chat Completions APIs.

## Run on Windows

From the repository root:

```powershell
corepack pnpm@9.15.9 install
corepack pnpm@9.15.9 --filter @markmap/desktop tauri dev
```

The development window starts at 1440 × 900. The frontend uses the Markmap workspace source directly, so a prior Markmap package build is not required to run the app.

Type checks read each package's built declarations, so run `corepack pnpm@9.15.9 -r build:types` from the repository root before `tsc`.

Feature notes live in the repository's `docs/` folder, for example `document-workbench.md`, `math-visualization.md`, `plantuml-gui.md`, `pele-diagrams.md`, and `youtube-player-page.md`.

## Included

- Generate a Markdown mind map from a prompt through an OpenAI-compatible API.
- Store the API key in Windows Credential Manager; the frontend only receives the saved/not-saved state.
- Configure the API base URL and model in the app. HTTPS is required except for loopback endpoints such as local Ollama.
- Edit Markdown and see the map update automatically.
- Save maps as ordinary Markdown files in a configurable local library. The default is `Documents/Markmap Library`.
- Create nested category folders, edit a map's title/type/tags, search the library, and move a map by changing its category.
- Automatically save edits, keep a SQLite search index in app data, and rebuild that index from the Markdown files.
- Watch the selected library for changes made outside the app and refresh the index automatically.
- Switch between light and dark themes; the selected theme is remembered locally.
- Pan and zoom the canvas, fit the map to the window, and collapse branches from their node controls.
- Double-click a canvas node to edit it; press Enter to add a sibling or Tab to add a child. Canvas edits update the Markdown source and save through the same local library flow.
- Parse Markdown without raw HTML and without loading plugin assets from the network.

## Mind map library

The left panel shows Markdown files under the selected library folder. Files are organized by folder, while type and comma-separated tags are stored as hidden Markdown metadata. Existing `.md` files placed in the library are discovered and indexed when the app starts or when **重建索引** is used. Editing a title renames the file; editing its category moves it into the corresponding folder.

The Markdown files are the source of truth and can be backed up, moved, or opened in another editor. SQLite contains the searchable index at the app's local data location and can be rebuilt from the library. Search covers titles, categories, types, tags, and Markdown text.

The app stores the selected library location in its application config directory. Use **更改** in the file library panel to select another folder. If the configured folder is moved or removed, the app asks you to select its new location instead of silently switching to an empty library.

## Configure AI

Open **模型设置**, set the Chat Completions API base URL and model name, then save an API key. For example, the default OpenAI values are `https://api.openai.com/v1` and `gpt-4o-mini`. The app sends the prompt from its Rust backend and returns only the generated Markdown to the editor.

The API key is stored in the current Windows user's Credential Manager under the service name `com.markmap.desktop`. Model and endpoint settings are stored in the local WebView profile. The app does not write the key to Markdown, logs, or frontend storage.
