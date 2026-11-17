# MobileCDN

Chunk CDN for Fortnite iOS and Android builds, meant for private servers.

Run: `node server.js` (env overrides: `CDN_PORT`, `CDN_BUILDS_DIR`, `CDN_CONFIG`). Health check: `/health`.

Add a build: drop its folder (manifest + `files/`) under `buildsDir` and restart the CDN, the index is built once at startup.

Expected `buildsDir` structure (one build per platform shown):
```
buildsDir/
├── AndroidManifests/
│   └── 7.30-CL-4834550/
│       ├── LL-HSmqwOs3xcw3IhkKxLUjeW2YcCg.manifest
│       └── files/
│           └── FortniteGame/Content/Paks/pakchunk0-Android_ASTCClient.pak
│               ...                         # every file named in the manifest
└── iOSManifests/
    └── 7.20-CL-4727874/
        ├── 76LbhghKxejuBRV-rEGyCFpZKtwTLw.manifest
        └── files/
            └── fortnitegame/content/paks/pakchunk0-iosclient.pak   # iOS paths are lowercase
                ...
```

# AI Disclosure
AI was wholly used for the creation of this server.

Models used:

Claude Opus 5.5 (Claude Code)
Hy4 Flash (OpenCode)
