# To-Do List Tool

## Setup

1. Clone the repository: `git clone https://github.com/your-username/todo-list-tool.git`
2. Install dependencies: `npm install`
3. Start the server: `npm start`

## Environment Variables

| Variable | Description |
| --- | --- |
| PORT | Server port |

## API Documentation

### GET /

Serve the frontend.

### GET /api/health

Health check.

## Deploy

1. Create a new project on Vercel.
2. Set the `PORT` environment variable to `3000`.
3. Deploy the project.

## Features

* Zero-friction: usable immediately on load, sample data pre-filled
* Real-time output as user types (debounce 150ms)
* Copy-to-clipboard on all outputs ('Copied!' flash)
* History panel: last 10 operations with restore
* Keyboard shortcuts (Enter=run, Escape=clear, Ctrl+Z=undo)
* Download output as file (Blob API)
* URL hash state sharing
* Error states with inline validation and hints
* Empty states with illustrated guide text