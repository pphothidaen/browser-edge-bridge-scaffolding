# Headless Deployment (Optional)

Run the bridge container on a Linux host with headless Chromium and noVNC.

```text
docker container
├── Xvfb + fluxbox      virtual display
├── x11vnc + noVNC      remote view in a browser  (:6080)
├── chromium            loads ../extension, opens target session tab
└── node ../bridge      the OpenAI-compatible bridge (:8787)
```

## Security

- By default `docker-compose.yml` binds ports to `127.0.0.1`.
- Access the remote interface via SSH tunneling:
  ```bash
  ssh -L 6080:127.0.0.1:6080 user@your-server
  ```
- If exposing noVNC, always set a strong `NOVNC_PASSWORD`.

## Running the Container

```bash
cd packages/core/browser-bridge/deploy
cp .env.example .env
docker compose up -d --build
```

Log in to your target application in the Chromium window via noVNC and verify bridge connectivity.
