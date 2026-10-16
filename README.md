# Task Tracker

A local project board that uses AI to turn meeting notes and ideas into tracked project cards.

Drop meeting transcripts or notes into a folder, or paste text into **Describe an idea**. Task Tracker reads it with an AI model (OpenAI or Anthropic) and drafts project cards for you. Everything runs on your own machine: the app, the API and the database.

## Features

- **Project board** with four statuses: Ideation, In Progress, Completed and Dead. View it as a list, tiles or phases.
- **Describe an idea:** paste an idea, notes or a transcript. If it covers several projects, one card is created for each.
- **Notes folder sync:** point the app at a folder of `.txt` files. It scans them for projects, and re-processes a file only when it changes. Sync on demand or on a daily schedule.
- **Cards** have a name, description, type, priority, assignee and status, plus notes.
- **Custom project types and team members**, managed from the header.
- **Local storage:** data lives in a single SQLite file, and API keys stay on the server and are never sent to the browser.

## Requirements

- **Node.js 22 or newer.** The database uses the built-in `node:sqlite` module.
- **Chrome or Edge** for the notes folder feature, which relies on the browser's folder access API. The rest of the app works in any modern browser.
- **An API key** for OpenAI or Anthropic, to use the AI features.

## Run it

```bash
git clone <your-repo-url>
cd task-tracker
npm install
npm run dev
```

`npm run dev` starts two things:

- the API on `http://127.0.0.1:3001`
- the web app, served by Vite (usually `http://localhost:5173`, the exact address is printed in the terminal)

Open the web address in your browser.

### Other commands

| Command | What it does |
|---|---|
| `npm run server` | Starts only the API |
| `npm run web` | Starts only the Vite dev server |
| `npm run build` | Builds the web app into `dist/` |
| `npm run preview` | Serves the built app. The API must be running too (`npm run server`) |

To use a different API port, set the `PORT` environment variable and update the proxy target in `vite.config.js` to match.

## Set up the AI

1. Click **Settings**.
2. Choose a provider, **OpenAI** or **Anthropic**, and enter its API key.
3. Optionally change the model. The defaults are `gpt-4o-mini` for OpenAI and `claude-sonnet-5-5` for Anthropic.

Instead of entering a key in Settings, you can set the `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` environment variable before starting the server.

A key entered in Settings is stored in plain text in `data/task-tracker.db` on your machine. Don't share that file.

## Use it

### Add a project by hand
Click **Add project**, fill in the details and save. New projects start in Ideation.

### Describe an idea
1. Click **Describe an idea**.
2. Type or paste your idea, or a whole meeting transcript. You can also use your device's dictation to speak it.
3. Click **Generate project**.
   - One project found: a pre-filled form opens so you can adjust it before saving.
   - Several projects found: a card is added to Ideation for each, with the relevant part of your text saved as a note.

### Sync a notes folder
1. Open **Settings** and choose your notes folder. The repo includes `sample-notes/` to try it out.
2. Click **Sync notes now**, or enable the daily sync and set a time.
3. New projects appear in Ideation, each with its source text as a note.

Each `.txt` file is processed once. If you edit a file, its projects are updated. Their status and assignee stay as your team set them. A file can produce several projects.

### Organize your board
- **Manage members** adds the people you can assign projects to.
- **Manage project types** adds your own types. Task and Issue are built in.
- Use the status counts above the list to filter, and the **List**, **Tiles** and **Phases** buttons to change the view.

## Project layout

```
src/            React front end (board, forms, AI prompts, notes sync)
server/         Express API and SQLite storage
sample-notes/   Example notes to try the folder sync
data/           Created on first run. Holds your database (not committed)
```

## Privacy

- The API server listens on `127.0.0.1` only and rejects requests from other websites.
- Text you paste or sync is sent to your chosen AI provider to extract projects, so avoid using it on confidential notes unless your provider's terms allow it.
- `data/` is listed in `.gitignore` so your database and API key are not committed.
