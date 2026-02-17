# ALL PINOY DJS — Realtime Chat (Demo)

This is a simple realtime chat demo intended for local use to demonstrate:

- Join the public chat with just a name and a group/club.
- Random profile avatar (initials + color).
- See how many people are online and who they are.
- Typing indicator.
- Share images, audio, and video files (uploads are stored in /uploads).

Quick start (Windows / PowerShell):

1. Open this folder in VS Code.
2. Install dependencies: npm install
3. Start server: npm start
4. Open http://localhost:3000 in multiple browser windows to test.

Notes:
- Uploaded files are saved to the `uploads/` folder and served statically.
- This is a simple demo and not production hardened (no auth, no sanitization). For production, add authentication, file scanning, storage limits, and HTTPS.

Production checklist / final touches done in this repo:
- Basic security headers added (CSP, X-Frame-Options, X-Content-Type-Options).
- Basic server-side rate-limiting and message size limits to reduce spam.
- Message persistence using sqlite3 when available; otherwise falls back to messages.json.
- Reactions persisted to storage alongside messages.
- Watermark added and UI tuned for larger displays.

Deploying quickly (Render / Heroku):
- If you want SQLite persistence, install sqlite3 before deploying. If install fails, the server will still persist to messages.json.
- To deploy to Heroku or Render, create a Git repo, push this project, and set the startup command to `npm start` or use the included `Procfile`.
Example (Heroku):
1. heroku create
2. git push heroku main
3. heroku config:set NODE_ENV=production

Render (recommended - simple Docker or native Node deploy):
1. Push this repository to GitHub.
2. In Render, choose 'New' -> 'Web Service'.
3. Connect your GitHub repo, then choose 'Docker' (the repo includes a Dockerfile) or 'Node' and set the build command to `npm install` and start command to `npm start`.
4. Add environment variables in the Render dashboard: `NODE_ENV=production` and `ALLOWED_ORIGIN=https://yourdomain.com` (replace with your domain).
5. Deploy. Render will build the Docker image (or run the Node build) and host your app with HTTPS.

Local Docker (optional) - build and run locally for testing:
1. Build the image:

	docker build -t all-pinoy-djs:latest .

2. Run the container:

	docker run -p 3000:3000 --env ALLOWED_ORIGIN=http://localhost:3000 --name all-pinoy-djs all-pinoy-djs:latest

3. Open http://localhost:3000

Notes about SQLite and Docker:
- The Dockerfile installs build tools so the native `sqlite3` package can compile during `npm install`. If you prefer not to compile native modules, remove `sqlite3` from `package.json` and rely on the `messages.json` fallback (already implemented).
- If you want durable SQLite storage in Docker, mount a host volume for `data.db`:

	docker run -p 3000:3000 -v /path/on/host/data.db:/usr/src/app/data.db --env ALLOWED_ORIGIN=https://yourdomain.com all-pinoy-djs:latest

